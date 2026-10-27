'use strict';

/**
 * W-49 (этап 14, веха В6): API документов по пациенту (F-67) и заключений
 * психолога (F-68). Маршруты и коды ошибок — по замороженному контракту:
 *   POST /api/v1/patients/{patient_id}/documents   — создать черновик (номер <тип>-<год>-<номер>)
 *   GET  /api/v1/documents/{id}                    — карточка (роль С/З, чужой — 404)
 *   PUT  /api/v1/documents/{id}                    — правка черновика; готовое/подписанное — 409 E-SIGNED-IMMUTABLE
 *   POST /api/v1/documents/{id}/ready|new-version  — «Готово» (неизменяемая версия) / новая версия с причиной
 *   POST /api/v1/documents/{id}/sign               — подпись автором-психологом с паролем и подтверждением;
 *                                                    5 неверных паролей — пауза 15 минут (E-AUTH-LOCKED)
 *   POST /api/v1/documents/{id}/release            — выдача пациенту с отложенной видимостью и окном «Отменить»
 *   GET  /api/v1/documents/{id}/export?format=     — PDF/DOCX/TXT, журнал export_log, имя файла без ФИО
 *   GET  /api/v1/me/documents                      — видимое пациенту выданное
 *
 * Заключения (type='conclusion') хранятся в conclusions/conclusion_versions —
 * только психолог; остальные типы — patient_documents/patient_document_versions,
 * разделы шифротекстом (PD-05). Роли до handler'а проверяет контрактный контроль
 * доступа в src/server.js.
 */

const bcrypt = require('bcryptjs');
const field = require('../../crypto/field');
const svc = require('./service');
const { isFullyAssigned } = require('../../access/assignment');

const DOC_KINDS = Object.keys(svc.DOC_TYPES);
const LOCK_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

function install(app, { db, P, config, now, makeUndo, idemCached, saveIdem, auditPatient }) {
  const currentIso = () => P.iso(now(config));
  const encKey = () => process.env.PII_ENC_KEY;

  function assigned(clinicianId, patientId) {
    return isFullyAssigned(db, patientId, clinicianId);
  }

  function yearOf(iso) {
    return String(iso || currentIso()).slice(0, 4);
  }

  // Единое пространство id для /api/v1/documents/{id}: таблицы
  // patient_documents и conclusions имеют отдельные AUTOINCREMENT, поэтому
  // обе вставляются с явным id = max(обе таблицы) + 1.
  function nextDocId() {
    return nextDocIdFor(db);
  }

  // Документ существует в одной из двух таблиц: patient_documents (F-67) или conclusions (F-68).
  function loadDoc(id) {
    const row = db.prepare('SELECT * FROM patient_documents WHERE id=? AND hidden_at IS NULL').get(id);
    if (row) {
      const version = db
        .prepare('SELECT * FROM patient_document_versions WHERE document_id=? AND version=?')
        .get(row.id, row.current_version);
      return { kind: 'pdoc', doc: row, version };
    }
    const c = db.prepare('SELECT * FROM conclusions WHERE id=?').get(id);
    if (!c) return null;
    const latest = db
      .prepare('SELECT * FROM conclusion_versions WHERE conclusion_id=? ORDER BY version DESC LIMIT 1')
      .get(c.id);
    return { kind: 'conclusion', doc: c, version: latest };
  }

  // Номер детерминирован: <тип>-<год создания>-<id строки> (S-54, без счётчика в схеме).
  function pdocNumber(row) {
    return svc.makeNumber(svc.DOC_TYPES[row.doc_type].prefix, yearOf(row.created_at), row.id);
  }

  function conclusionNumber(row) {
    return svc.makeNumber(svc.DOC_TYPES.conclusion.prefix, yearOf(row.created_at), row.id);
  }

  function pdocSections(version) {
    // Формат В4 (F-33): sections_enc — открытый JSON {sections:[{key,title,text,ai}]}.
    // Наш формат (шаблоны W-49): AES-256-GCM шифротекст JSON-массива (PD-05).
    try {
      const plain = JSON.parse(version.sections_enc);
      if (Array.isArray(plain && plain.sections)) return plain.sections;
      if (Array.isArray(plain)) return plain;
    } catch (_) {
      /* не JSON — пробуем расшифровать */
    }
    const d = field.decrypt(encKey(), version.sections_enc);
    if (!d.ok) return null; // чужой/сменённый ключ — вызывающий отвечает E-PSEUDO-DECRYPT
    try {
      const parsed = JSON.parse(d.value);
      return Array.isArray(parsed && parsed.sections) ? parsed.sections : parsed;
    } catch (_) {
      return null;
    }
  }

  // Ответ в форме контракта Document.
  function docResponse(loaded) {
    const { kind, doc, version } = loaded;
    if (kind === 'pdoc') {
      let sections = pdocSections(version);
      const pseudo = !sections;
      sections = (sections || []).map((s) => ({
        key: String(s.key),
        text: String(s.text ?? ''),
        ...(s.title !== undefined ? { title: s.title } : {}),
        ...(s.ai !== undefined ? { ai: Boolean(s.ai) } : {}),
      }));
      return {
        id: doc.id,
        patient_id: doc.patient_id,
        type: doc.doc_type,
        number: pdocNumber(doc),
        version: doc.current_version,
        status: version.status,
        sections,
        ai_generated: JSON.parse(version.ai_sections_json || '[]').length > 0,
        unknown_keys: pseudo ? sections.length : 0,
        period: { from: doc.period_from, to: doc.period_to },
        author_id: doc.author_id,
        ...(pseudo ? { warning: 'E-PSEUDO-DECRYPT' } : {}),
      };
    }
    let sections = {};
    try {
      sections = JSON.parse(version.sections_json || '{}');
    } catch (_) {
      sections = {};
    }
    return {
      id: doc.id,
      patient_id: doc.patient_id,
      type: 'conclusion',
      number: conclusionNumber(doc),
      version: version.version,
      status: version.status,
      sections: Object.entries(sections).map(([key, text]) => ({ key, text: String(text ?? '') })),
      ai_generated: false,
      unknown_keys: 0,
      title: doc.title || null,
      author_id: doc.author_id,
      released: Boolean(doc.released_to_patient),
      released_visible_from: doc.released_visible_from || null,
    };
  }

  function exportDoc(loaded) {
    const { kind, doc, version } = loaded;
    if (kind === 'pdoc') {
      return {
        typeTitle: svc.DOC_TYPES[doc.doc_type].title,
        number: pdocNumber(doc),
        version: doc.current_version,
        sections: pdocSections(version) || [],
      };
    }
    let sections = {};
    try {
      sections = JSON.parse(version.sections_json || '{}');
    } catch (_) {
      sections = {};
    }
    return {
      typeTitle: svc.DOC_TYPES.conclusion.title,
      number: conclusionNumber(doc),
      version: version.version,
      sections: Object.entries(sections).map(([key, text]) => ({ key, text: String(text ?? '') })),
    };
  }

  // Доступ на чтение: пациент — своё выданное; клиницист — закреплённый пациент.
  function canRead(user, loaded, current) {
    if (user.role === 'patient') {
      if (loaded.doc.patient_id !== user.id) return false;
      if (loaded.kind === 'pdoc') return false; // выдача документов пациенту — см. открытый вопрос в 14-build.md
      return Boolean(loaded.doc.released_to_patient) && loaded.doc.released_visible_from <= current;
    }
    if (!['psychiatrist', 'psychologist'].includes(user.role)) return false;
    return assigned(user.id, loaded.doc.patient_id);
  }

  // 5 неверных паролей за 15 минут — пауза (F-68, T-222). Журнал — action_log (append-only).
  function signFailures(actorId, current) {
    return db
      .prepare(
        "SELECT count(*) n FROM action_log WHERE actor_id=? AND action='conclusion.sign.failed' AND unixepoch(created_at) > unixepoch(?) - ?",
      )
      .get(actorId, current, LOCK_MINUTES * 60).n;
  }

  // --- Маршруты -------------------------------------------------------------

  // Список документов клинициста (documents.work): свои и закреплённых пациентов.
  app.get('/api/v1/documents', (req, res) => {
    const patients = db
      .prepare('SELECT patient_id FROM care_assignments WHERE clinician_id=? AND ended_at IS NULL')
      .all(req.user.id)
      .map((r) => r.patient_id);
    const docs = [];
    for (const row of db.prepare('SELECT * FROM patient_documents WHERE hidden_at IS NULL ORDER BY id DESC LIMIT 500').all()) {
      if (row.author_id === req.user.id || patients.includes(row.patient_id)) docs.push(docResponse(loadDoc(row.id)));
    }
    for (const row of db.prepare('SELECT * FROM conclusions ORDER BY id DESC LIMIT 500').all()) {
      if (row.author_id === req.user.id || patients.includes(row.patient_id)) docs.push(docResponse(loadDoc(row.id)));
    }
    return res.json({ items: docs, page: 1, page_size: 50, total: docs.length });
  });

  // Создание заключения психолога (F-68, T-222). Маршрут POST /patients/:id/documents
  // принадлежит В4 (clinicianApi: черновики из данных, F-33) и делегирует
  // заключения сюда по типу 'conclusion'.
  function createConclusion(req, res) {
    const patientId = Number(req.params.patient_id);
    if (!assigned(req.user.id, patientId)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const state = idemCached(req, req.user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) return res.status(201).json(state.cached);
    // Заключение психолога создаёт только психолог (F-68, T-222).
    if (req.user.role !== 'psychologist') return P.sendError(req, res, 403, 'E-ACCESS');
    const current = currentIso();
    const sections = svc.sectionsFor(req.user.role, 'conclusion');
    const docId = nextDocId();
    db.transaction(() => {
      db.prepare('INSERT INTO conclusions(id,patient_id,author_id,title,created_at) VALUES (?,?,?,?,?)').run(
        docId,
        patientId,
        req.user.id,
        svc.DOC_TYPES.conclusion.title,
        current,
      );
      db.prepare(
        "INSERT INTO conclusion_versions(conclusion_id,patient_id,version,status,title,sections_json,created_by,created_at) VALUES (?,1,?,'draft',?,?,?,?)",
      ).run(
        docId,
        patientId,
        svc.DOC_TYPES.conclusion.title,
        JSON.stringify(Object.fromEntries(sections.map((s) => [s.key, s.text]))),
        req.user.id,
        current,
      );
    })();
    if (auditPatient) {
      try {
        auditPatient(req, patientId, 'allow', 'documents');
      } catch (_) {
        return P.sendError(req, res, 500, 'E-INTERNAL');
      }
    }
    return res.status(201).json(docResponse(loadDoc(docId)));
  }

  app.get('/api/v1/documents/:document_id', (req, res) => {
    const loaded = loadDoc(Number(req.params.document_id));
    if (!loaded) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const current = currentIso();
    if (!canRead(req.user, loaded, current)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (req.user.role !== 'patient') {
      try {
        auditPatient(req, loaded.doc.patient_id, 'allow', 'documents');
      } catch (_) {
        return P.sendError(req, res, 500, 'E-INTERNAL');
      }
    }
    const response = docResponse(loaded);
    if (response.warning === 'E-PSEUDO-DECRYPT') return P.sendError(req, res, 503, 'E-PSEUDO-DECRYPT');
    return res.json(response);
  });

  // Правка: только автор, только черновик. Психиатр — только чтение (T-222).
  function guardAuthorDraft(req, res, allowedStatuses) {
    const loaded = loadDoc(Number(req.params.document_id));
    if (!loaded) {
      P.sendError(req, res, 404, 'E-NOT-FOUND');
      return null;
    }
    if (loaded.doc.author_id !== req.user.id) {
      P.sendError(req, res, 403, 'E-ACCESS');
      return null;
    }
    if (!allowedStatuses.includes(loaded.version.status)) {
      // Подписанное/готовое неизменяемо; триггер базы дублирует защиту (T-220/T-222).
      P.sendError(req, res, 409, 'E-SIGNED-IMMUTABLE');
      return null;
    }
    return loaded;
  }

  function normalizeSections(user, raw) {
    if (!Array.isArray(raw)) return null;
    const out = [];
    for (const s of raw) {
      if (!s || typeof s.key !== 'string') return null;
      const key = s.key.slice(0, 100);
      // Психолог не вводит лекарственные разделы и диагноз (F-58, T-221).
      if (user.role === 'psychologist' && svc.MEDS_KEY_RE.test(key)) return null;
      out.push({ key, text: String(s.text ?? '').slice(0, 20000) });
    }
    return out;
  }

  app.put('/api/v1/documents/:document_id', (req, res) => {
    const state = idemCached(req, req.user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    const loaded = guardAuthorDraft(req, res, ['draft']);
    if (!loaded) return;
    const body = req.body || {};
    if (body.version !== undefined && Number(body.version) !== loaded.doc.current_version)
      return P.sendError(req, res, 409, 'E-CONFLICT');
    const sections = normalizeSections(req.user, body.sections);
    if (!sections) return P.sendError(req, res, 422, 'E-VALIDATION');
    const current = currentIso();
    db.transaction(() => {
      if (loaded.kind === 'pdoc') {
        db.prepare('UPDATE patient_document_versions SET sections_enc=? WHERE id=?').run(
          field.encrypt(encKey(), JSON.stringify(sections)),
          loaded.version.id,
        );
      } else {
        db.prepare('UPDATE conclusion_versions SET sections_json=?, updated_at=? WHERE id=?').run(
          JSON.stringify(Object.fromEntries(sections.map((s) => [s.key, s.text]))),
          current,
          loaded.version.id,
        );
      }
    })();
    const response = docResponse(loadDoc(loaded.doc.id));
    saveIdem(req.user.id, state, response);
    return res.json(response);
  });

  app.post('/api/v1/documents/:document_id/ready', (req, res) => {
    const state = idemCached(req, req.user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) return res.json(state.cached);
    const loaded = loadDoc(Number(req.params.document_id));
    if (!loaded) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (loaded.doc.author_id !== req.user.id) return P.sendError(req, res, 403, 'E-ACCESS');
    if (loaded.kind !== 'pdoc' || loaded.version.status !== 'draft') return P.sendError(req, res, 409, 'E-STATUS');
    if (Number((req.body || {}).version) !== loaded.doc.current_version)
      return P.sendError(req, res, 409, 'E-CONFLICT');
    db.prepare("UPDATE patient_document_versions SET status='ready' WHERE id=?").run(loaded.version.id);
    const response = docResponse(loadDoc(loaded.doc.id));
    saveIdem(req.user.id, state, response);
    return res.json(response);
  });

  app.post('/api/v1/documents/:document_id/new-version', (req, res) => {
    const state = idemCached(req, req.user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) return res.json(state.cached);
    const loaded = loadDoc(Number(req.params.document_id));
    if (!loaded) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (loaded.doc.author_id !== req.user.id) return P.sendError(req, res, 403, 'E-ACCESS');
    const reason = String((req.body || {}).reason || '').trim();
    if (!reason) return P.sendError(req, res, 422, 'E-VALIDATION');
    // Новая версия — с готовой/подписанной текущей; черновик правится на месте.
    const fromReady = loaded.kind === 'pdoc' && loaded.version.status === 'ready';
    const fromSigned = loaded.kind === 'conclusion' && loaded.version.status === 'signed';
    if (!fromReady && !fromSigned) return P.sendError(req, res, 409, 'E-STATUS');
    const current = currentIso();
    const nextVersion = loaded.version.version + 1;
    db.transaction(() => {
      if (loaded.kind === 'pdoc') {
        db.prepare(
          "INSERT INTO patient_document_versions(document_id,patient_id,version,status,sections_enc,sources_json,ai_sections_json,reason,author_id,created_at) VALUES (?,?,?,'draft',?,?,?,?,?,?)",
        ).run(
          loaded.doc.id,
          loaded.doc.patient_id,
          nextVersion,
          loaded.version.sections_enc,
          loaded.version.sources_json,
          loaded.version.ai_sections_json,
          reason,
          req.user.id,
          current,
        );
        db.prepare('UPDATE patient_documents SET current_version=? WHERE id=?').run(nextVersion, loaded.doc.id);
      } else {
        db.prepare(
          "INSERT INTO conclusion_versions(conclusion_id,patient_id,version,status,title,sections_json,reason,created_by,created_at) VALUES (?,?,?,'draft',?,?,?,?,?)",
        ).run(
          loaded.doc.id,
          loaded.doc.patient_id,
          nextVersion,
          loaded.version.title,
          loaded.version.sections_json,
          reason,
          req.user.id,
          current,
        );
        db.prepare('UPDATE conclusions SET updated_at=? WHERE id=?').run(current, loaded.doc.id);
      }
    })();
    const response = docResponse(loadDoc(loaded.doc.id));
    saveIdem(req.user.id, state, response);
    return res.json(response);
  });

  app.post('/api/v1/documents/:document_id/sign', (req, res) => {
    const state = idemCached(req, req.user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) return res.json(state.cached);
    const loaded = loadDoc(Number(req.params.document_id));
    if (!loaded) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    // Подписывает только автор-психолог (F-68); психиатр — только чтение (T-222).
    if (loaded.kind !== 'conclusion' || loaded.doc.author_id !== req.user.id)
      return P.sendError(req, res, 403, 'E-ACCESS');
    const body = req.body || {};
    if (typeof body.password !== 'string' || !body.password || body.confirm !== true)
      return P.sendError(req, res, 422, 'E-VALIDATION');
    if (Number(body.version) !== loaded.version.version) return P.sendError(req, res, 409, 'E-CONFLICT');
    if (loaded.version.status === 'signed') return P.sendError(req, res, 409, 'E-SIGNED-IMMUTABLE');
    const current = currentIso();
    // 5 неверных паролей за 15 минут — пауза (E-AUTH-LOCKED, T-222).
    if (signFailures(req.user.id, current) >= LOCK_ATTEMPTS) return P.sendError(req, res, 423, 'E-AUTH-LOCKED');
    const author = db.prepare('SELECT * FROM users WHERE id=?').get(loaded.doc.author_id);
    if (!author || !author.password_hash || !bcrypt.compareSync(body.password, author.password_hash)) {
      db.prepare(
        "INSERT INTO action_log(actor_id,actor_role,action,target_type,target_id,created_at) VALUES (?,?,'conclusion.sign.failed','document',?,?)",
      ).run(req.user.id, req.user.role, loaded.doc.id, current);
      if (signFailures(req.user.id, current) >= LOCK_ATTEMPTS) return P.sendError(req, res, 423, 'E-AUTH-LOCKED');
      return P.sendError(req, res, 401, 'E-AUTH-INVALID');
    }
    const checksum = svc.checksum(exportDoc(loaded));
    db.prepare(
      "UPDATE conclusion_versions SET status='signed', signed_by=?, signed_name=?, signed_at=?, sign_method='password', checksum=?, updated_at=? WHERE id=?",
    ).run(author.id, author.full_name, current, checksum, current, loaded.version.id);
    try {
      auditPatient(req, loaded.doc.patient_id, 'allow', 'documents');
    } catch (_) {
      return P.sendError(req, res, 500, 'E-INTERNAL');
    }
    db.prepare(
      "INSERT INTO action_log(actor_id,actor_role,action,target_type,target_id,created_at) VALUES (?,?,'conclusion.sign','document',?,?)",
    ).run(req.user.id, req.user.role, loaded.doc.id, current);
    const response = docResponse(loadDoc(loaded.doc.id));
    saveIdem(req.user.id, state, response);
    return res.json(response);
  });

  app.post('/api/v1/documents/:document_id/release', (req, res) => {
    const state = idemCached(req, req.user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) return res.json(state.cached);
    const loaded = loadDoc(Number(req.params.document_id));
    if (!loaded) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (loaded.doc.author_id !== req.user.id) return P.sendError(req, res, 403, 'E-ACCESS');
    // Выдать можно только подписанное заключение (для памятки/сводки см. открытый
    // вопрос о колонках выдачи patient_documents; T-221/T-222).
    if (loaded.kind !== 'conclusion' || loaded.version.status !== 'signed')
      return P.sendError(req, res, 409, 'E-STATUS');
    const undo = makeUndo(req.user.id, 'document.release', 'document_release', loaded.doc.id);
    const current = currentIso();
    db.prepare(
      'UPDATE conclusions SET released_to_patient=1, released_version=?, released_visible_from=?, released_at=?, updated_at=? WHERE id=?',
    ).run(loaded.version.version, undo.expires_at, current, current, loaded.doc.id);
    try {
      auditPatient(req, loaded.doc.patient_id, 'allow', 'documents');
    } catch (_) {
      return P.sendError(req, res, 500, 'E-INTERNAL');
    }
    const response = { ok: true, undo, released_visible_from: undo.expires_at };
    saveIdem(req.user.id, state, response);
    return res.json(response);
  });

  app.get('/api/v1/documents/:document_id/export', (req, res) => {
    // Маршрут экспорта объявляет В4 (clinicianApi, F-33): pdoc — с обратной
    // подстановкой F-80; заключения делегируются в exportConclusion ниже.
    const loaded = loadDoc(Number(req.params.document_id));
    if (!loaded) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (loaded.kind !== 'conclusion') return P.sendError(req, res, 404, 'E-NOT-FOUND');
    return exportConclusion(req, res);
  });

  // Экспорт подписанного заключения (F-80): PDF/DOCX/TXT, имя файла без ФИО,
  // каждая выгрузка — в export_log. Вызывается из делегирования В4 и напрямую.
  function exportConclusion(req, res) {
    const loaded = loadDoc(Number(req.params.document_id));
    if (!loaded || loaded.kind !== 'conclusion') return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const current = currentIso();
    if (!canRead(req.user, loaded, current)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const data = exportDoc(loaded);
    const rendered = svc.renderExport(data, String(req.query.format || ''));
    if (!rendered) return P.sendError(req, res, 500, 'E-EXPORT-FAILED');
    const sha = require('crypto').createHash('sha256').update(rendered.body).digest('hex');
    db.prepare(
      "INSERT INTO export_log(actor_id,kind,patient_id,row_count,file_sha256,recipient_class,created_at) VALUES (?,'clinical_doc',?,1,?,?,?)",
    ).run(req.user.id, loaded.doc.patient_id, sha, req.user.role === 'patient' ? 'patient' : 'clinician', current);
    try {
      auditPatient(req, loaded.doc.patient_id, 'allow', 'documents');
    } catch (_) {
      return P.sendError(req, res, 500, 'E-INTERNAL');
    }
    res.setHeader('Content-Type', rendered.mime);
    // Имя файла без ФИО (PD-03): только номер и версия.
    res.setHeader('Content-Disposition', `attachment; filename="${data.number}-v${data.version}.${rendered.ext}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(rendered.body);
  }

  app.get('/api/v1/me/documents', (req, res) => {
    if (req.user.role !== 'patient') return P.sendError(req, res, 403, 'E-ACCESS');
    const current = currentIso();
    const rows = db
      .prepare(
        'SELECT c.*, v.version AS v_version, v.title AS v_title FROM conclusions c ' +
          'JOIN conclusion_versions v ON v.conclusion_id=c.id AND v.version=c.released_version ' +
          'WHERE c.patient_id=? AND c.released_to_patient=1 AND c.released_visible_from<=? ' +
          'ORDER BY c.released_at DESC, c.id DESC',
      )
      .all(req.user.id, current);
    const items = rows.map((r) => ({
      id: r.id,
      type: 'conclusion',
      number: conclusionNumber(r),
      version: r.v_version,
      status: 'released',
      title: r.v_title || r.title,
      released_at: r.released_at,
      released_visible_from: r.released_visible_from,
    }));
    return res.json({ items, page: 1, page_size: 50, total: items.length });
  });

  HANDLERS = { createConclusion, exportConclusion };
  return { currentIso, loadDoc, docResponse, exportDoc, canRead, signFailures, assigned };
}

// Единая последовательность id для patient_documents и conclusions.
function nextDocIdFor(db) {
  const a = db.prepare('SELECT max(id) m FROM patient_documents').get().m || 0;
  const b = db.prepare('SELECT max(id) m FROM conclusions').get().m || 0;
  return Math.max(a, b) + 1;
}

// Поздняя связка: В4 (clinicianApi) монтируется раньше этого модуля и делегирует
// заключения (createConclusion/exportConclusion) по требованию в момент запроса.
let HANDLERS = null;

module.exports = { install, DOC_KINDS, handlers: () => HANDLERS, nextDocIdFor };