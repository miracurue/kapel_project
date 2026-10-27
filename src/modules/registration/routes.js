'use strict';

// Регистрация пациента и специалиста, привязка к врачу по коду, принятие соглашения сотрудниками, тексты документов,
// очередь «Заявки специалистов». Контракт: docs/openapi.yaml. Операции, которых нет в замороженном
// tests/api/contract/operations.json, проверяют роль и CSRF здесь же (через src/access).

const crypto = require('crypto');
const { EMAIL_RE, PATIENT_KINDS, STAFF_KINDS, isRequired } = require('./service');
const { SPECIALTIES } = require('./pages');

const OPS = {
  patient: { roles: [{ role: 'R-02', scope: 'С' }] },
  terms: {
    roles: [
      { role: 'R-03', scope: 'С' },
      { role: 'R-04', scope: 'С' },
      { role: 'R-05', scope: 'В' },
      { role: 'R-06', scope: 'В' },
    ],
  },
  admin: {
    roles: [
      { role: 'R-05', scope: 'В' },
      { role: 'R-06', scope: 'В' },
    ],
  },
};
const DOC_KIND = /^(doc|consent)\.[a-z_]{1,40}$/;
const STAFF_ROLES = ['psychiatrist', 'psychologist'];
const DEFAULT_SPECIALTY = { psychiatrist: 'psychiatrist', psychologist: 'clinical_psychologist' };

function createRoutes({ db, P, config, now, bcrypt, access, action, bumpRate, passwordFields, service, careLinks }) {
  const inviteHash = (code) => P.sha(String(code).trim().toUpperCase());

  const guard =
    (op, { mutating = false } = {}) =>
    (req, res, next) => {
      if (mutating && (!req.session || req.headers['x-csrf-token'] !== req.session.data.csrf))
        return P.sendError(req, res, 403, 'E-CSRF');
      if (!req.user?.id) return P.sendError(req, res, 401, 'E-SESSION-EXPIRED');
      if (!access.isAllowed(op, req.user)) return P.sendError(req, res, 403, 'E-ACCESS');
      return next();
    };
  const csrfOk = (req) => Boolean(req.session) && req.headers['x-csrf-token'] === req.session.data.csrf;

  const emailTaken = (email) =>
    Boolean(
      db.prepare('SELECT 1 FROM users WHERE email=? COLLATE NOCASE').get(email) ||
        db
          .prepare("SELECT 1 FROM staff_applications WHERE email=? COLLATE NOCASE AND status IN ('pending','approved')")
          .get(email),
    );

  function activeInvite(code) {
    const invite = db.prepare('SELECT * FROM invite_codes WHERE code_hash=?').get(inviteHash(code));
    if (!invite || invite.status !== 'active' || new Date(invite.expires_at) < now(config) || !invite.clinician_id)
      return null;
    const doctor = db
      .prepare(
        "SELECT id,full_name FROM users WHERE id=? AND status='active' AND role IN ('psychiatrist','psychologist')",
      )
      .get(invite.clinician_id);
    return doctor ? { ...invite, doctor } : null;
  }

  // Закрепление по приглашению (в чужой транзакции): период наблюдения, закрепление, код использован.
  function attach(patientId, invite, current) {
    const used = db
      .prepare("UPDATE invite_codes SET status='used',used_by=?,used_at=? WHERE id=? AND status='active'")
      .run(patientId, current, invite.id);
    if (used.changes !== 1) throw Object.assign(new Error('invite'), { code: 'E-INVITE-INVALID' });
    const open = db.prepare('SELECT id FROM care_episodes WHERE patient_id=? AND ended_at IS NULL').get(patientId);
    const episode =
      open?.id ||
      db
        .prepare('INSERT INTO care_episodes(patient_id,started_at,opened_by) VALUES (?,?,?)')
        .run(patientId, current, invite.clinician_id).lastInsertRowid;
    db.prepare(
      'INSERT INTO care_assignments(patient_id,clinician_id,episode_id,started_at,created_by) VALUES (?,?,?,?,?)',
    ).run(patientId, invite.clinician_id, episode, current, invite.clinician_id);
  }

  const serviceNo = (prefix, hex) => {
    for (let i = 0; i < 50; i += 1) {
      const candidate = hex
        ? `${prefix}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
        : `${prefix}-${crypto.randomInt(100000, 999999)}`;
      if (!db.prepare('SELECT 1 FROM users WHERE service_no=?').get(candidate)) return candidate;
    }
    throw new Error('service_no');
  };

  const missingKeys = (list, kinds) => kinds.filter((k) => !list.has(k));

  function install(app) {
    // ---------- регистрация пациента ----------
    app.post('/api/v1/auth/register', (req, res) => {
      const b = req.body || {};
      const email = String(b.email || '')
        .trim()
        .toLowerCase();
      const password = String(b.password || '');
      const fields = passwordFields(password, email);
      if (!EMAIL_RE.test(email)) fields.push({ field: 'email', key: 'err.e-validation.email' });
      if (fields.length) return P.sendError(req, res, 422, 'E-VALIDATION', { fields });
      const code = String(b.invite_code || '').trim();
      let invite = null;
      if (code) {
        if (bumpRate(`invite:${req.socket.remoteAddress || 'local'}`, 10, 15 * 60 * 1000))
          return P.sendError(req, res, 429, 'E-RATE-LIMIT', { details: { retry_after_s: 60 } });
        invite = activeInvite(code);
        if (!invite || emailTaken(email)) return P.sendError(req, res, 422, 'E-INVITE-INVALID');
      } else if (emailTaken(email)) return P.sendError(req, res, 409, 'E-EMAIL-TAKEN');
      const given = new Set((Array.isArray(b.consents) ? b.consents : []).filter((k) => PATIENT_KINDS.includes(k)));
      const missing = missingKeys(given, PATIENT_KINDS.filter(isRequired));
      if (missing.length) return P.sendError(req, res, 403, 'E-CONSENT-REQUIRED', { details: { missing } });
      const name =
        String(b.display_name || '')
          .trim()
          .slice(0, 80) || 'Новый пациент';
      const hash = bcrypt.hashSync(password, 10);
      const ip = service.ipHmac(req);
      let userId;
      try {
        userId = db
          .transaction(() => {
            const current = service.iso();
            const info = db
              .prepare(
                `INSERT INTO users(service_no,email,email_hmac,password_hash,role,full_name,status,is_demo,created_at)
                 VALUES (?,?,?,?,'patient',?,'active',?,?)`,
              )
              .run(serviceNo('P', true), email, P.hmac(config, email), hash, name, config.demoMode ? 1 : 0, current);
            const id = Number(info.lastInsertRowid);
            db.prepare('INSERT INTO user_prefs(user_id) VALUES (?)').run(id);
            if (invite) attach(id, invite, current);
            else db.prepare('INSERT INTO care_episodes(patient_id,started_at) VALUES (?,?)').run(id, current); // дневник работает и без врача
            for (const kind of PATIENT_KINDS) if (given.has(kind)) service.record(id, kind, 'given', { ipHmac: ip });
            service.record(id, 'agreement', 'given', { ipHmac: ip }); // принятие соглашения — той же галочкой «основное»
            return id;
          })
          .immediate();
      } catch (error) {
        if (error.code === 'E-INVITE-INVALID' || /UNIQUE/.test(String(error.message)))
          return invite ? P.sendError(req, res, 422, 'E-INVITE-INVALID') : P.sendError(req, res, 409, 'E-EMAIL-TAKEN');
        throw error;
      }
      P.closeSession(db, config, req.session, 'rotated');
      const session = P.createSession(db, config, res, { userId, role: 'patient' });
      action({ id: userId, role: 'patient' }, 'auth.register', 'user', userId);
      return res.json({
        user: { id: userId, role: 'patient', display_name: name },
        next: 'app',
        csrf: session.data.csrf,
      });
    });

    // ---------- заявка специалиста ----------
    app.post('/api/v1/auth/register-specialist', (req, res) => {
      if (!csrfOk(req)) return P.sendError(req, res, 403, 'E-CSRF');
      const b = req.body || {};
      const email = String(b.email || '')
        .trim()
        .toLowerCase();
      const password = String(b.password || '');
      const fullName = String(b.full_name || '').trim();
      const workplace = String(b.workplace || '').trim();
      const fields = passwordFields(password, email);
      if (!EMAIL_RE.test(email)) fields.push({ field: 'email', key: 'err.e-validation.email' });
      if (fullName.length < 2 || fullName.length > 120)
        fields.push({ field: 'full_name', key: 'err.e-validation.required' });
      if (workplace.length < 2 || workplace.length > 160)
        fields.push({ field: 'workplace', key: 'err.e-validation.required' });
      if (!STAFF_ROLES.includes(b.role)) fields.push({ field: 'role', key: 'err.e-validation.required' });
      if (fields.length) return P.sendError(req, res, 422, 'E-VALIDATION', { fields });
      const given = new Set(Array.isArray(b.consents) ? b.consents : []);
      const missing = missingKeys(given, STAFF_KINDS);
      if (missing.length) return P.sendError(req, res, 403, 'E-CONSENT-REQUIRED', { details: { missing } });
      if (emailTaken(email)) return P.sendError(req, res, 409, 'E-EMAIL-TAKEN');
      const specialty = SPECIALTIES.includes(b.specialty) ? b.specialty : DEFAULT_SPECIALTY[b.role];
      const agreement = service.current('agreement');
      const pd = service.current('staff_pd');
      let id;
      try {
        id = db
          .transaction(() => {
            const current = service.iso();
            const info = db
              .prepare(
                `INSERT INTO staff_applications(email,email_hmac,password_hash,full_name,role_requested,specialty,workplace,qualification,
                   agreement_version_id,agreement_sha256,pd_version_id,pd_sha256,ip_hmac,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              )
              .run(
                email,
                P.hmac(config, email),
                bcrypt.hashSync(password, 10),
                fullName,
                b.role,
                specialty,
                workplace,
                String(b.qualification || '')
                  .trim()
                  .slice(0, 200) || null,
                agreement.id,
                agreement.body_sha256,
                pd.id,
                pd.body_sha256,
                service.ipHmac(req),
                current,
              );
            const appId = Number(info.lastInsertRowid);
            for (const admin of db.prepare("SELECT id FROM users WHERE role='admin' AND status='active'").all())
              db.prepare(
                "INSERT OR IGNORE INTO notifications(recipient_id,type,event_key,object_type,object_id,title,visible_from,status,created_at) VALUES (?,'service',?,'staff_application',?,'Новая заявка специалиста',?,'active',?)",
              ).run(admin.id, `staff_app:${appId}`, appId, current, current);
            return appId;
          })
          .immediate();
      } catch (error) {
        if (/UNIQUE/.test(String(error.message))) return P.sendError(req, res, 409, 'E-EMAIL-TAKEN');
        throw error;
      }
      action(null, 'staff.application.submitted', 'staff_application', id);
      return res.status(201).json({ application: { id, status: 'pending' } });
    });

    // ---------- привязка к врачу по коду ----------
    app.post('/api/v1/me/care-link', guard(OPS.patient, { mutating: true }), (req, res) => {
      const userId = req.user.id;
      const key = `carelink:${userId}`;
      const bucket = (w) => new Date(Math.floor(now(config).getTime() / w) * w).toISOString();
      const tried =
        db.prepare('SELECT count FROM rate_counters WHERE key=? AND window_start=?').get(key, bucket(15 * 60 * 1000))
          ?.count || 0;
      if (tried >= 10) return P.sendError(req, res, 429, 'E-RATE-LIMIT', { details: { retry_after_s: 60 } });
      if (!service.status(userId, 'base') || service.status(userId, 'base').state !== 'given')
        return P.sendError(req, res, 403, 'E-CONSENT-REQUIRED');
      const invite = activeInvite(String(req.body?.invite_code || ''));
      if (!invite) {
        bumpRate(key, 10, 15 * 60 * 1000);
        return P.sendError(req, res, 422, 'E-INVITE-INVALID');
      }
      // Код от второго специалиста допустим (маршрутизация); тот же специалист повторно — конфликт.
      if (
        db
          .prepare('SELECT 1 FROM care_assignments WHERE patient_id=? AND clinician_id=? AND ended_at IS NULL')
          .get(userId, invite.clinician_id)
      )
        return P.sendError(req, res, 409, 'E-CONFLICT');
      try {
        db.transaction(() => attach(userId, invite, service.iso())).immediate();
      } catch (error) {
        if (error.code === 'E-INVITE-INVALID') return P.sendError(req, res, 422, 'E-INVITE-INVALID');
        throw error;
      }
      action(req.user, 'care.link.invite', 'user', userId);
      const prompt = careLinks ? careLinks.service.onAttach(userId, invite.clinician_id) : null;
      return res.json({ linked: true, clinician: invite.doctor.full_name, choose: Boolean(prompt) });
    });

    // ---------- соглашение сотрудников ----------
    app.get('/api/v1/me/terms', guard(OPS.terms), (req, res) =>
      res.json({ items: service.staffTerms(req.user.id), required: service.staffTermsMissing(req.user.id) }),
    );
    app.post('/api/v1/me/terms/accept', guard(OPS.terms, { mutating: true }), (req, res) => {
      if (req.body?.checkbox !== true) return P.sendError(req, res, 403, 'E-CONSENT-REQUIRED');
      const ip = service.ipHmac(req);
      db.transaction(() => {
        for (const kind of STAFF_KINDS) service.record(req.user.id, kind, 'given', { ipHmac: ip });
      }).immediate();
      action(req.user, 'terms.accepted', 'user', req.user.id);
      return res.json({ ok: true });
    });

    // ---------- тексты документов ----------
    app.get('/api/v1/docs/:kind', (req, res) => {
      const kind = String(req.params.kind);
      const row = DOC_KIND.test(kind)
        ? db
            .prepare("SELECT * FROM content_versions WHERE kind=? AND status='published' ORDER BY version DESC LIMIT 1")
            .get(kind)
        : null;
      if (!row) return P.sendError(req, res, 404, 'E-NOT-FOUND');
      return res.json({
        kind,
        version: row.version,
        markdown: row.body_md,
        sha256: row.body_sha256,
        published_at: row.published_at,
        is_stand_in: Boolean(row.is_stand_in),
      });
    });
    app.get('/api/v1/admin/content/docs', (req, res) => {
      const rows = db
        .prepare(
          `SELECT kind, MAX(version) AS latest, SUM(status='published') AS published FROM content_versions
           WHERE kind LIKE 'doc.%' OR kind LIKE 'consent.%' GROUP BY kind ORDER BY kind`,
        )
        .all();
      return res.json({ items: rows, page: 1, page_size: 50, total: rows.length });
    });
    app.post('/api/v1/admin/content/docs/:kind/versions', (req, res) => {
      const kind = String(req.params.kind);
      const markdown = String(req.body?.markdown || '');
      if (!DOC_KIND.test(kind)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
      if (!markdown.trim() || markdown.length > 100000 || /<\s*script|javascript:|\son\w+\s*=/i.test(markdown))
        return P.sendError(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'markdown', key: 'err.e-validation' }] });
      const body = markdown.trim() + '\n';
      const hash = service.sha(body);
      const stamp = service.iso();
      const publish = req.body?.publish !== false;
      const version = db
        .transaction(() => {
          const last =
            db.prepare('SELECT COALESCE(MAX(version),0) v FROM content_versions WHERE kind=?').get(kind).v + 1;
          if (publish)
            db.prepare("UPDATE content_versions SET status='superseded' WHERE kind=? AND status='published'").run(kind);
          db.prepare(
            `INSERT INTO content_versions(kind,version,body_md,body_sha256,sign_method,status,is_stand_in,author_id,comment,created_at,published_at)
             VALUES (?,?,?,?,'demo_click',?,1,?,?,?,?)`,
          ).run(
            kind,
            last,
            body,
            hash,
            publish ? 'published' : 'draft',
            req.user.id,
            String(req.body?.comment || '').slice(0, 300) || null,
            stamp,
            publish ? stamp : null,
          );
          return last;
        })
        .immediate();
      action(req.user, publish ? 'content.publish' : 'content.draft', 'content', version);
      return res.status(201).json({ kind, version, status: publish ? 'published' : 'draft', sha256: hash });
    });

    // ---------- очередь «Заявки специалистов» ----------
    const publicApp = (a) => ({
      id: a.id,
      full_name: a.full_name,
      email: a.email,
      role_requested: a.role_requested,
      specialty: a.specialty,
      workplace: a.workplace,
      qualification: a.qualification,
      status: a.status,
      approved_role: a.approved_role,
      reject_reason: a.reject_reason,
      created_at: a.created_at,
      decided_at: a.decided_at,
    });
    app.get('/api/v1/admin/staff-applications', guard(OPS.admin), (req, res) => {
      const status = ['pending', 'approved', 'rejected'].includes(req.query.status)
        ? req.query.status
        : req.query.status === 'all'
          ? null
          : 'pending';
      const rows = status
        ? db.prepare('SELECT * FROM staff_applications WHERE status=? ORDER BY id DESC LIMIT 200').all(status)
        : db.prepare('SELECT * FROM staff_applications ORDER BY id DESC LIMIT 200').all();
      return res.json({ items: rows.map(publicApp), page: 1, page_size: 50, total: rows.length });
    });
    app.post('/api/v1/admin/staff-applications/:id/approve', guard(OPS.admin, { mutating: true }), (req, res) => {
      const role = req.body?.role;
      if (!STAFF_ROLES.includes(role))
        return P.sendError(req, res, 422, 'E-VALIDATION', {
          fields: [{ field: 'role', key: 'err.e-validation.required' }],
        });
      const found = db.prepare('SELECT * FROM staff_applications WHERE id=?').get(Number(req.params.id));
      if (!found) return P.sendError(req, res, 404, 'E-NOT-FOUND');
      if (found.status !== 'pending') return P.sendError(req, res, 409, 'E-CONFLICT');
      if (db.prepare('SELECT 1 FROM users WHERE email=? COLLATE NOCASE').get(found.email))
        return P.sendError(req, res, 409, 'E-EMAIL-TAKEN');
      const userId = db
        .transaction(() => {
          const current = service.iso();
          const info = db
            .prepare(
              `INSERT INTO users(service_no,email,email_hmac,password_hash,role,full_name,status,must_change_password,created_by,created_at,sessions_valid_from)
               VALUES (?,?,?,?,?,?,'active',0,?,?,?)`,
            )
            .run(
              serviceNo('С', false),
              found.email,
              found.email_hmac,
              found.password_hash,
              role,
              found.full_name,
              req.user.id,
              current,
              current,
            );
          const id = Number(info.lastInsertRowid);
          db.prepare('INSERT OR IGNORE INTO user_prefs(user_id) VALUES (?)').run(id);
          let org = null;
          if (found.workplace) {
            const norm = found.workplace.toLowerCase().replace(/\s+/g, ' ').trim();
            db.prepare(
              "INSERT OR IGNORE INTO organizations(name,name_norm,kind,region,created_at) VALUES (?,?,'other','не указан',?)",
            ).run(found.workplace, norm, current);
            org =
              db.prepare("SELECT id FROM organizations WHERE name_norm=? AND region='не указан'").get(norm)?.id || null;
          }
          db.prepare(
            'INSERT INTO clinician_profiles(user_id,specialty,organization_id,analytics_consent,updated_at) VALUES (?,?,?,0,?)',
          ).run(id, found.specialty, org, current);
          // согласия, данные при подаче заявки: исходное время, версия и хэш из заявки
          for (const [kind, versionId, hash] of [
            ['agreement', found.agreement_version_id, found.agreement_sha256],
            ['staff_pd', found.pd_version_id, found.pd_sha256],
          ])
            db.prepare(
              'INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method,ip_hmac,created_at) VALUES (?,?,?,?,?,?,?,?)',
            ).run(id, kind, 'given', versionId, hash, 'demo_click', found.ip_hmac, found.created_at);
          db.prepare(
            "UPDATE staff_applications SET status='approved',approved_role=?,decided_by=?,decided_at=?,user_id=? WHERE id=?",
          ).run(role, req.user.id, current, id, found.id);
          return id;
        })
        .immediate();
      action(req.user, 'staff.application.approved', 'staff_application', found.id);
      return res.json({ ok: true, user_id: userId, role });
    });
    app.post('/api/v1/admin/staff-applications/:id/reject', guard(OPS.admin, { mutating: true }), (req, res) => {
      const reason = String(req.body?.reason || '')
        .trim()
        .slice(0, 300);
      if (!reason)
        return P.sendError(req, res, 422, 'E-VALIDATION', {
          fields: [{ field: 'reason', key: 'err.e-validation.required' }],
        });
      const found = db.prepare('SELECT * FROM staff_applications WHERE id=?').get(Number(req.params.id));
      if (!found) return P.sendError(req, res, 404, 'E-NOT-FOUND');
      if (found.status !== 'pending') return P.sendError(req, res, 409, 'E-CONFLICT');
      db.prepare(
        "UPDATE staff_applications SET status='rejected',reject_reason=?,decided_by=?,decided_at=? WHERE id=?",
      ).run(reason, req.user.id, service.iso(), found.id);
      action(req.user, 'staff.application.rejected', 'staff_application', found.id);
      return res.json({ ok: true });
    });
  }

  /** Заявка с совпавшими почтой и паролем (ожидает или отклонена) — для ответа при входе. */
  function applicationForLogin(email, password) {
    const row = db
      .prepare(
        "SELECT * FROM staff_applications WHERE email=? COLLATE NOCASE AND status IN ('pending','rejected') ORDER BY id DESC LIMIT 1",
      )
      .get(
        String(email || '')
          .trim()
          .toLowerCase(),
      );
    return row && bcrypt.compareSync(String(password || ''), row.password_hash) ? row : null;
  }

  return { install, applicationForLogin };
}

module.exports = { createRoutes };
