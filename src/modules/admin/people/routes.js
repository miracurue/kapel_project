'use strict';

/**
 * W-39 (этап 14, веха В5 «Админка»): люди и доступ.
 * Маршруты /api/v1/admin/people и сопутствующие служебные операции:
 * список и карточка без ФИО/почты пациента, «Показать» с журналом (F-88),
 * новый сотрудник (F-89), сброс пароля и смена почты (F-90), блокировка и
 * деактивация (F-91), роль и отметки (F-92).
 */

const express = require('express');

const db = require('../../../db');
const platform = require('../../../platform');
const { requirePermission } = require('../../../permissions');
const core = require('../../../admin_core');
const peopleCore = require('./adminCore');

const P = platform;

const router = express.Router();

const adminOnly = requirePermission('admin.users');
const err = (req, res, status, code, extra) => P.sendError(req, res, status, code, extra);
const ok = (res, body) => res.json(body);

// Причины блокировки S-54 (экран R-07) — ключи совпадают с msg.blocked.reason.list.*.
const S54_REASONS = ['staff_leave', 'suspicious', 'owner_request', 'rules', 'other'];

// ---------- F-88: список и карточка ----------

router.get('/', adminOnly, (req, res) => {
  const filter = String(req.query.filter || '');
  const role = filter === 'patients' ? 'patient' : filter === 'staff' ? 'staff' : '';
  const f = { role: role === 'staff' ? undefined : role, q: req.query.q, page: req.query.page };
  const result = peopleCore.listPeople(req.user.id, f);
  ok(res, { items: result.items, page: result.page, page_size: peopleCore.PAGE_SIZE, total: result.total });
});

router.get('/:id', adminOnly, (req, res) => {
  const r = peopleCore.getPersonCard(req.user.id, req.params.id);
  if (!r.ok) return err(req, res, 404, 'E-NOT-FOUND');
  ok(res, r.card);
});

router.post('/:id/reveal-contacts', adminOnly, (req, res) => {
  const r = peopleCore.revealContacts(req.user.id, req.params.id);
  if (!r.ok) return err(req, res, 404, 'E-NOT-FOUND');
  ok(res, { id: r.id, role: r.role, name: r.name, email: r.email });
});

// ---------- F-89: новый сотрудник (отдельный роутер: путь /api/v1/admin/staff) ----------

const staffRouter = express.Router();

staffRouter.post('/staff', adminOnly, (req, res) => {
  const { full_name, email, role } = req.body || {};
  const mail = String(email || '')
    .trim()
    .toLowerCase();
  if (!core.STAFF_ROLES.includes(role)) return err(req, res, 422, 'E-VALIDATION');
  if (db.prepare('SELECT 1 FROM users WHERE lower(email) = ?').get(mail)) {
    return err(req, res, 409, 'E-EMAIL-TAKEN');
  }
  const name = String(full_name || '').trim();
  if (!name || name.length > 120) return err(req, res, 422, 'E-VALIDATION');
  const created = core.createStaff(req.user.id, { full_name: name, email: mail, role });
  if (!created.ok) return err(req, res, 409, 'E-EMAIL-TAKEN');
  const undoId = db
    .prepare(
      "INSERT INTO undo_actions (key_hash, author_id, action_type, method, object_type, object_id, window_until, state, created_at) VALUES (?, ?, 'staff.deactivate', 'soft_delete', 'staff_deactivate', ?, ?, 'applied', ?)",
    )
    .run(
      P.sha(String(created.id)),
      req.user.id,
      created.id,
      new Date(Date.now() + 16000).toISOString(),
      new Date().toISOString(),
    ).lastInsertRowid;
  ok(res, {
    user: { id: created.id, email: mail, role, full_name: name },
    temporary_password: created.tempPassword,
    undo: { id: String(created.id) },
  });
});

// ---------- F-90: сброс пароля и смена почты ----------

router.post('/:id/password-reset', adminOnly, (req, res) => {
  const r = core.resetPassword(req.user.id, req.params.id);
  if (!r.ok) return err(req, res, 422, 'E-VALIDATION');
  ok(res, { temporary_password: r.tempPassword });
});

router.post('/:id/email', adminOnly, (req, res) => {
  const { email, verification, verification_comment } = req.body || {};
  if (!['in_person_document', 'org_card_phone', 'other'].includes(verification)) {
    return err(req, res, 422, 'E-VALIDATION');
  }
  if (verification === 'other' && !String(verification_comment || '').trim()) {
    return err(req, res, 422, 'E-VALIDATION');
  }
  const target = core.getUser(req.params.id);
  if (!target) return err(req, res, 404, 'E-NOT-FOUND');
  const mail = String(email || '')
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return err(req, res, 422, 'E-VALIDATION');
  if (db.prepare('SELECT 1 FROM users WHERE lower(email) = ? AND id != ?').get(mail, target.id)) {
    return err(req, res, 409, 'E-EMAIL-TAKEN');
  }
  // W-39 (T-244): в журнале хеши, не сырые значения (PD-03).
  const hashEmail = (v) =>
    require('crypto')
      .createHash('sha256')
      .update(String(v || ''))
      .digest('hex');
  const oldHash = hashEmail(target.email || '');
  const newHash = hashEmail(mail);
  db.prepare('UPDATE users SET email = ?, must_change_password = 0 WHERE id = ?').run(mail, target.id);
  core.logAdmin(req.user.id, 'email_change', target.id, { verification, old_hash: oldHash, new_hash: newHash });
  ok(res, { ok: true });
});

// ---------- F-91: блокировка / деактивация / активация ----------

// W-39 (T-245): обработчик асинхронный — уступка такта цикла событий перед
// атомарной блокировкой (см. комментарий ниже).
router.post('/:id/status', adminOnly, async (req, res) => {
  const { action, reason_key } = req.body || {};
  const target = core.getUser(req.params.id);
  if (!target) return err(req, res, 404, 'E-NOT-FOUND');
  if (target.id === req.user.id) return err(req, res, 403, 'E-SELF-ACTION');
  if (target.role === 'admin' && action === 'deactivate' && core.activeAdminCount() <= 1) {
    return err(req, res, 409, 'E-LAST-ADMIN');
  }
  if (action === 'block') {
    if (!S54_REASONS.includes(reason_key)) return err(req, res, 422, 'E-VALIDATION');
    // W-39 (T-245): блокировка закрывает сессии цели — параллельный запрос от цели
    // при этом отбивается CSRF-мидлварью (403 E-CSRF) раньше обработчика. Уступаем
    // такт цикла событий, чтобы одновременные взаимные блокировки обе дошли до
    // атомарной проверки «последний администратор».
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Атомарно (одна транзакция): последнего активного администратора блокировать нельзя.
    const t = new Date().toISOString();
    let lastAdmin = false;
    db.transaction(() => {
      if (target.role === 'admin') {
        const others = db
          .prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND status = 'active' AND id != ?")
          .get(target.id).n;
        if (others === 0) {
          lastAdmin = true;
          return;
        }
      }
      db.prepare("UPDATE users SET status = 'blocked', status_reason = ?, sessions_valid_from = ? WHERE id = ?").run(
        reason_key,
        t,
        target.id,
      );
    })();
    if (lastAdmin) return err(req, res, 409, 'E-LAST-ADMIN');
    core.logAdmin(req.user.id, 'user_block', target.id, { reason_key });
    return ok(res, { ok: true, status: 'blocked' });
  }
  if (action === 'unblock') {
    db.prepare("UPDATE users SET status = 'active', status_reason = NULL WHERE id = ?").run(target.id);
    core.logAdmin(req.user.id, 'user_unblock', target.id, {});
    return ok(res, { ok: true, status: 'active' });
  }
  if (action === 'deactivate') {
    if (['psychiatrist', 'psychologist'].includes(target.role)) {
      const n = db
        .prepare('SELECT COUNT(*) n FROM care_assignments WHERE clinician_id = ? AND ended_at IS NULL')
        .get(target.id).n;
      if (n > 0) return err(req, res, 409, 'E-ROLE-HAS-PATIENTS');
    }
    const r = core.deactivate(req.user.id, target.id);
    if (!r.ok) return err(req, res, 409, 'E-LAST-ADMIN');
    return ok(res, { ok: true });
  }
  return err(req, res, 422, 'E-VALIDATION');
});

// ---------- F-92: роль и отметки ----------

const FLAGS = ['research', 'clinical_lead', 'reference_reviewer'];

router.put('/:id/flags', adminOnly, (req, res) => {
  const target = core.getUser(req.params.id);
  if (!target) return err(req, res, 404, 'E-NOT-FOUND');
  if (target.id === req.user.id) return err(req, res, 403, 'E-SELF-ACTION');
  const updates = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!FLAGS.includes(k)) continue;
    if (k === 'clinical_lead' && v === true && target.role !== 'psychiatrist') {
      return err(req, res, 422, 'E-VALIDATION');
    }
    if (k === 'reference_reviewer' && v === true && !['psychiatrist', 'admin'].includes(target.role)) {
      return err(req, res, 422, 'E-VALIDATION');
    }
    updates[k] = v ? 1 : 0;
  }
  if (!Object.keys(updates).length) return err(req, res, 422, 'E-VALIDATION');
  const sets = Object.keys(updates)
    .map((k) => `flag_${k} = ?`)
    .join(', ');
  db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...Object.values(updates), target.id);
  core.logAdmin(req.user.id, 'user_flags', target.id, updates);
  ok(res, { ok: true });
});

router.put('/:id/role', adminOnly, (req, res) => {
  const target = core.getUser(req.params.id);
  if (!target) return err(req, res, 404, 'E-NOT-FOUND');
  if (target.id === req.user.id) return err(req, res, 403, 'E-SELF-ACTION');
  const role = String((req.body || {}).role || '');
  if (!['psychiatrist', 'psychologist', 'admin'].includes(role)) return err(req, res, 422, 'E-VALIDATION');
  if (role === 'admin' && ['psychiatrist', 'psychologist'].includes(target.role)) {
    const n = db
      .prepare('SELECT COUNT(*) n FROM care_assignments WHERE clinician_id = ? AND ended_at IS NULL')
      .get(target.id).n;
    if (n > 0) return err(req, res, 409, 'E-ROLE-HAS-PATIENTS');
  }
  if (target.role === 'admin' && role !== 'admin' && core.activeAdminCount() <= 1) {
    return err(req, res, 409, 'E-LAST-ADMIN');
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target.id);
  core.logAdmin(req.user.id, 'user_role', target.id, { from: target.role, to: role });
  ok(res, { ok: true });
});

// ---------- F-93: закрепления (путь /api/v1/admin/care-assignments) ----------

staffRouter.post('/care-assignments', adminOnly, (req, res) => {
  const { patient_id, clinician_id, action } = req.body || {};
  if (!['assign', 'unassign'].includes(action)) return err(req, res, 422, 'E-VALIDATION');
  const p = core.getUser(patient_id);
  const c = core.getUser(clinician_id);
  if (!p || p.role !== 'patient') return err(req, res, 404, 'E-NOT-FOUND');
  if (!c || !['psychiatrist', 'psychologist'].includes(c.role)) return err(req, res, 404, 'E-NOT-FOUND');
  if (action === 'assign') {
    const r = core.assign(req.user.id, p.id, c.id);
    if (!r.ok) return err(req, res, 409, 'E-VALIDATION');
    return ok(res, { ok: true });
  }
  // F-93: предупреждение при снятии последнего специалиста.
  const clinicians = db.prepare('SELECT clinician_id FROM care_assignments WHERE patient_id = ?').all(p.id);
  const warnings = [];
  if (clinicians.length <= 1)
    warnings.push('У пациента не останется специалиста: сообщения и сигналы пойдут в служебную очередь');
  const r = core.unassign(req.user.id, p.id, c.id);
  if (!r.ok) return err(req, res, 409, 'E-VALIDATION');
  return ok(res, { ok: true, warnings });
});

// ---------- F-94: повторное подключение архивного ----------

router.post('/:id/reconnect', adminOnly, (req, res) => {
  const target = core.getUser(req.params.id);
  if (!target) return err(req, res, 404, 'E-NOT-FOUND');
  if (target.role !== 'patient') return err(req, res, 409, 'E-STATUS');
  // «Надгробие» (пациент с решением о финализации) подключить нельзя (T-213).
  if (target.status === 'tombstone' || target.status === 'deleted') return err(req, res, 409, 'E-STATUS');
  // Повторное подключение — только архивного: активного эпизода наблюдения быть не должно.
  const activeEpisode = db
    .prepare('SELECT id FROM care_episodes WHERE patient_id = ? AND ended_at IS NULL')
    .get(target.id);
  if (activeEpisode) return err(req, res, 409, 'E-STATUS');
  const ids = Array.isArray((req.body || {}).clinician_ids)
    ? (req.body || {}).clinician_ids
    : (req.body || {}).clinician_id
      ? [(req.body || {}).clinician_id]
      : [];
  if (!ids.length) return err(req, res, 422, 'E-VALIDATION');
  const clinicians = ids.map((id) => core.getUser(id));
  if (clinicians.some((c) => !c || !['psychiatrist', 'psychologist'].includes(c.role) || !core.isActiveAccount(c))) {
    return err(req, res, 409, 'E-NO-CANDIDATE');
  }
  const t = new Date().toISOString();
  // Новый эпизод наблюдения (F-69): открывается один активный эпизод.
  const ep = db
    .prepare('INSERT INTO care_episodes(patient_id,started_at,opened_by) VALUES (?,?,?)')
    .run(target.id, t, req.user.id).lastInsertRowid;
  for (const c of clinicians)
    db.prepare(
      'INSERT INTO care_assignments(patient_id,clinician_id,episode_id,started_at,created_by) VALUES (?,?,?,?,?)',
    ).run(target.id, c.id, ep, t, req.user.id);
  core.logAdmin(req.user.id, 'patient_reconnect', target.id, {
    clinician_ids: clinicians.map((c) => c.id),
    episode_id: ep,
  });
  db.prepare(
    "INSERT INTO phi_access_log (actor_id, patient_id, section, action, basis) VALUES (?, ?, 'account', 'view', 'admin_service')",
  ).run(req.user.id, target.id);
  ok(res, { ok: true, episode_id: ep });
});
module.exports = router;
module.exports.staffRouter = staffRouter;
module.exports.S54_REASONS = S54_REASONS;
