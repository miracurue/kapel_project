'use strict';

// W1.D: кабинет администратора. Служебные функции: пользователи, привязки, очередь «Без врача»,
// запросы на удаление, приглашения, журналы, согласия, система. Клинического содержимого здесь нет
// (REQ-ADM-007): роут /patients/:id и другие клинические маршруты админу недоступны (permissions.js).
// Журналы только читаются: маршрутов DELETE/UPDATE над ними нет (REQ-ADM-008).

const express = require('express');

const db = require('../db');
const { flash } = require('../middleware');
const { requirePermission } = require('../permissions');
const core = require('../admin_core');
const queue = require('../admin_queue');
const deletion = require('../admin_deletion');
const audit = require('../admin_audit');
const overview = require('../admin_overview');
const invites = require('../invites');
const crisisQueue = require('../crisis_queue');
const { isBusinessHours } = require('../crisisProtocol');

const router = express.Router();

// W-39: люди и доступ — API-маршруты вынесены в модуль (F-88…F-94).
router.use('/api/v1/admin/people', require('../modules/admin/people/routes'));
router.use('/api/v1/admin/care-assignments', require('../modules/admin/people/routes'));

// W-39: люди и доступ — маршруты вынесены в src/modules/admin/people/
// (peopleController.js, peopleService.js, staffService.js).
const people = require('../modules/admin/people/peopleController');
people.adminPeople(router);
const users = requirePermission('admin.users');
const deletionPerm = requirePermission('admin.deletion_requests');
const auditPerm = requirePermission('admin.audit_view');

const PAGE_SIZE = 50;
const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е');
const adminId = (req) => req.session.user.id;

function notFound(res) {
  return res
    .status(404)
    .render('error', { message: 'Запись не найдена. Возможно, она уже удалена или ссылка устарела.' });
}

// ---------- Сводка «Требует решения» ----------

function home(req, res) {
  res.render('admin/home', {
    pageTitle: 'Требует решения',
    d: overview.needsDecision(),
    notifyText: crisisQueue.NOTIFY_TEXT,
  });
}
router.get('/admin', users, home);

// ---------- Пользователи ----------

function userFilters(q) {
  return {
    role: ['patient', 'psychiatrist', 'psychologist', 'admin'].includes(q.role) ? q.role : '',
    status: ['active', 'deactivated', 'password', 'deletion_requested', 'deleted'].includes(q.status) ? q.status : '',
    q: String(q.q || '').slice(0, 100),
  };
}

function userStatus(u) {
  if (u.account_status === 'deleted') return { key: 'deleted', label: 'данные удалены' };
  if (u.deactivated_at) return { key: 'deactivated', label: 'деактивирован' };
  if (u.account_status === 'deletion_requested') return { key: 'deletion_requested', label: 'запрошено удаление' };
  if (u.must_change_password) return { key: 'password', label: 'ждёт смены пароля' };
  return { key: 'active', label: 'активен' };
}

router.get('/admin/users', users, (req, res) => {
  const f = userFilters(req.query);
  let rows = db
    .prepare(
      'SELECT id, email, full_name, role, account_status, deactivated_at, must_change_password, created_at FROM users ORDER BY role, full_name',
    )
    .all();
  rows = rows.map((u) => ({ ...u, status: userStatus(u) }));
  if (f.role) rows = rows.filter((u) => u.role === f.role);
  if (f.status) rows = rows.filter((u) => u.status.key === f.status);
  if (f.q) rows = rows.filter((u) => norm(u.full_name).includes(norm(f.q)) || norm(u.email).includes(norm(f.q)));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  res.render('admin/users', {
    pageTitle: 'Пользователи',
    f,
    total: rows.length,
    rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    page,
    pages,
    roleLabels: core.ROLE_LABELS,
  });
});

router.get('/admin/users/new', users, (req, res) => {
  res.render('admin/user_new', { pageTitle: 'Новый сотрудник', values: {}, error: null });
});

router.post('/admin/users', users, (req, res) => {
  const out = core.createStaff(adminId(req), req.body || {});
  if (!out.ok) {
    return res
      .status(422)
      .render('admin/user_new', { pageTitle: 'Новый сотрудник', values: req.body || {}, error: out.error });
  }
  req.session.issued = { kind: 'create', userId: out.id, password: out.tempPassword };
  res.redirect('/admin/credentials');
});

// Временный пароль показывается ровно один раз: он лежит в сессии до первого просмотра.
router.get('/admin/credentials', users, (req, res) => {
  const issued = req.session.issued || null;
  req.session.issued = null;
  const target = issued ? core.getUser(issued.userId) : null;
  res.render('admin/credentials', { pageTitle: 'Временный пароль', issued, target, roleLabels: core.ROLE_LABELS });
});

function userDetail(id) {
  const u = core.getUser(id);
  if (!u) return null;
  const ctx = { u, status: userStatus(u), roleLabels: core.ROLE_LABELS, patients: [], clinicians: [], invites: [] };
  if (['psychiatrist', 'psychologist'].includes(u.role)) {
    ctx.patients = db
      .prepare(
        `SELECT p.id, p.full_name, (SELECT COUNT(*) FROM crisis_escalations e WHERE e.patient_id = p.id AND e.status = 'open') AS open_esc
         FROM care_assignments ca JOIN users p ON p.id = ca.patient_id WHERE ca.clinician_id = ? ORDER BY p.full_name`,
      )
      .all(u.id);
  }
  if (u.role === 'patient') {
    ctx.clinicians = db
      .prepare(
        'SELECT c.id, c.full_name, c.role, c.deactivated_at FROM care_assignments ca JOIN users c ON c.id = ca.clinician_id WHERE ca.patient_id = ? ORDER BY c.full_name',
      )
      .all(u.id);
  }
  return ctx;
}

router.get('/admin/users/:id', users, (req, res) => {
  const ctx = userDetail(req.params.id);
  if (!ctx) return notFound(res);
  res.render('admin/user_detail', { pageTitle: ctx.u.full_name, ...ctx });
});

router.get('/admin/users/:id/reset', users, (req, res) => {
  const ctx = userDetail(req.params.id);
  if (!ctx) return notFound(res);
  res.render('admin/user_reset', { pageTitle: 'Сброс пароля', ...ctx });
});

router.post('/admin/users/:id/reset', users, (req, res) => {
  const out = core.resetPassword(adminId(req), req.params.id);
  if (!out.ok) {
    flash(req, out.error, 'error');
    return res.redirect(`/admin/users/${Number(req.params.id) || 0}`);
  }
  req.session.issued = { kind: 'reset', userId: out.user.id, password: out.tempPassword };
  res.redirect('/admin/credentials');
});

router.get('/admin/users/:id/deactivate', users, (req, res) => {
  const ctx = userDetail(req.params.id);
  if (!ctx) return notFound(res);
  const openEsc = ctx.patients.reduce((a, p) => a + p.open_esc, 0);
  res.render('admin/user_deactivate', { pageTitle: 'Деактивация', ...ctx, openEsc, isSelf: ctx.u.id === adminId(req) });
});

router.post('/admin/users/:id/deactivate', users, (req, res) => {
  const out = core.deactivate(adminId(req), req.params.id);
  flash(
    req,
    out.ok ? 'Пользователь деактивирован: вход закрыт, его сессии завершены.' : out.error,
    out.ok ? 'success' : 'error',
  );
  res.redirect(`/admin/users/${Number(req.params.id) || 0}`);
});

router.post('/admin/users/:id/activate', users, (req, res) => {
  const out = core.activate(adminId(req), req.params.id);
  flash(req, out.ok ? 'Пользователь снова активен.' : out.error, out.ok ? 'success' : 'error');
  res.redirect(`/admin/users/${Number(req.params.id) || 0}`);
});

// ---------- Привязки пациент <-> специалист ----------

router.get('/admin/assignments', users, (req, res) => {
  const clinician = String(req.query.clinician || '');
  const q = String(req.query.q || '').slice(0, 100);
  let rows = db
    .prepare(
      `SELECT p.id, p.full_name, p.account_status,
              (SELECT COUNT(*) FROM crisis_escalations e WHERE e.patient_id = p.id AND e.status = 'open') AS open_esc
       FROM users p WHERE p.role = 'patient' AND p.account_status != 'deleted' ORDER BY p.full_name`,
    )
    .all();
  const links = db
    .prepare(
      'SELECT ca.patient_id, c.id, c.full_name, c.role, c.deactivated_at FROM care_assignments ca JOIN users c ON c.id = ca.clinician_id ORDER BY c.full_name',
    )
    .all();
  rows = rows.map((p) => ({
    ...p,
    clinicians: links.filter((l) => l.patient_id === p.id),
    noActive: !core.patientHasActiveClinician(p.id),
  }));
  if (clinician === 'none') rows = rows.filter((p) => p.noActive);
  else if (/^\d+$/.test(clinician)) rows = rows.filter((p) => p.clinicians.some((c) => c.id === Number(clinician)));
  if (q) rows = rows.filter((p) => norm(p.full_name).includes(norm(q)));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  const allClinicians = db
    .prepare(
      "SELECT id, full_name, role, deactivated_at FROM users WHERE role IN ('psychiatrist','psychologist') AND account_status = 'active' ORDER BY full_name",
    )
    .all();
  res.render('admin/assignments', {
    pageTitle: 'Привязки',
    rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    total: rows.length,
    page,
    pages,
    clinician,
    q,
    allClinicians,
  });
});

function patientAssignCtx(id) {
  const p = core.getUser(id);
  if (!p || p.role !== 'patient' || p.account_status === 'deleted') return null;
  const current = db
    .prepare(
      'SELECT c.id, c.full_name, c.role, c.deactivated_at FROM care_assignments ca JOIN users c ON c.id = ca.clinician_id WHERE ca.patient_id = ? ORDER BY ca.id',
    )
    .all(p.id);
  const have = new Set(current.map((c) => c.id));
  return {
    p,
    current,
    candidates: core.activeClinicians().filter((c) => !have.has(c.id)),
    openEsc: core.openEscalationCount(p.id),
  };
}

router.get('/admin/assignments/patient/:id', users, (req, res) => {
  const ctx = patientAssignCtx(req.params.id);
  if (!ctx) return notFound(res);
  res.render('admin/assign_patient', { pageTitle: 'Привязка пациента', ...ctx });
});

router.post('/admin/assignments/assign', users, (req, res) => {
  const out = core.assign(adminId(req), req.body.patient_id, req.body.clinician_id);
  flash(req, out.ok ? `Специалист ${out.clinician.full_name} назначен.` : out.error, out.ok ? 'success' : 'error');
  res.redirect(`/admin/assignments/patient/${Number(req.body.patient_id) || 0}`);
});

router.get('/admin/assignments/unassign', users, (req, res) => {
  const ctx = patientAssignCtx(req.query.patient_id);
  const clin = core.getUser(req.query.clinician_id);
  if (!ctx || !clin || !ctx.current.some((c) => c.id === clin.id)) return notFound(res);
  const remaining = ctx.current.filter((c) => c.id !== clin.id && !c.deactivated_at).length;
  res.render('admin/unassign', { pageTitle: 'Снять специалиста', ...ctx, clin, remaining });
});

router.post('/admin/assignments/unassign', users, (req, res) => {
  const out = core.unassign(adminId(req), req.body.patient_id, req.body.clinician_id);
  flash(req, out.ok ? 'Специалист снят с пациента.' : out.error, out.ok ? 'success' : 'error');
  res.redirect(`/admin/assignments/patient/${Number(req.body.patient_id) || 0}`);
});

router.get('/admin/assignments/reassign', users, (req, res) => {
  const from = core.getUser(req.query.from);
  if (!from || !['psychiatrist', 'psychologist'].includes(from.role)) return notFound(res);
  const patients = db
    .prepare(
      `SELECT p.id, p.full_name, (SELECT COUNT(*) FROM crisis_escalations e WHERE e.patient_id = p.id AND e.status = 'open') AS open_esc
       FROM care_assignments ca JOIN users p ON p.id = ca.patient_id WHERE ca.clinician_id = ? AND p.account_status != 'deleted' ORDER BY p.full_name`,
    )
    .all(from.id);
  res.render('admin/reassign', {
    pageTitle: 'Переназначить пациентов',
    from,
    patients,
    targets: core.activeClinicians().filter((c) => c.id !== from.id),
  });
});

router.post('/admin/assignments/reassign', users, (req, res) => {
  let ids = req.body.patient_ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  const from = Number(req.body.from);
  if (!ids.length) {
    flash(req, 'Отметьте хотя бы одного пациента.', 'error');
    return res.redirect(`/admin/assignments/reassign?from=${from}`);
  }
  const out = core.reassign(adminId(req), from, req.body.to, ids);
  if (!out.ok) {
    flash(req, out.error, 'error');
    return res.redirect(`/admin/assignments/reassign?from=${from}`);
  }
  flash(req, `Переназначено пациентов: ${out.moved}. Открытые эскалации теперь видит ${out.to.full_name}.`, 'success');
  res.redirect(`/admin/users/${from}`);
});

// ---------- Очередь «Без врача» ----------

router.get('/admin/nobody', users, (req, res) => {
  queue.listOpen(); // (чтение) — актуальное состояние
  res.render('admin/nobody', {
    pageTitle: 'Без врача',
    items: queue.listOpen(),
    handled: queue.listHandled(),
    clinicians: core.activeClinicians(),
    notifyText: crisisQueue.NOTIFY_TEXT,
    businessHours: isBusinessHours(new Date()),
    triggerLabel: (t) => (queue.TRIGGER_LABELS[t] ? `${t} — ${queue.TRIGGER_LABELS[t]}` : t),
  });
});

router.post('/admin/nobody/:ref/acknowledge', users, (req, res) => {
  const out = queue.acknowledge(adminId(req), String(req.params.ref));
  flash(req, out.ok ? 'Отмечено как обработанное.' : out.error, out.ok ? 'success' : 'error');
  res.redirect('/admin/nobody');
});

router.post('/admin/nobody/:ref/handover', users, (req, res) => {
  const out = queue.handOver(adminId(req), String(req.params.ref), req.body.clinician_id);
  flash(
    req,
    out.ok ? `Передано: ${out.clinician.full_name}. Запись видна ему в кризисной очереди.` : out.error,
    out.ok ? 'success' : 'error',
  );
  res.redirect('/admin/nobody');
});

// ---------- Запросы на удаление ----------

router.get('/admin/deletion', deletionPerm, (req, res) => {
  const all = deletion.listRequests();
  res.render('admin/deletion', {
    pageTitle: 'Запросы на удаление',
    pending: all.filter((r) => r.status === 'pending'),
    done: all.filter((r) => r.status !== 'pending'),
    dueDays: deletion.DELETION_DUE_DAYS,
  });
});

function deletionCtx(id) {
  const r = deletion.getRequest(id);
  if (!r) return null;
  const pending = r.status === 'pending' && r.patient_status === 'deletion_requested';
  return {
    r,
    pending,
    inventory: r.status === 'pending' ? deletion.inventory(r.patient_id) : [],
    retained: r.status === 'pending' ? deletion.retained(r.patient_id) : [],
    openEsc: r.status === 'pending' ? core.openEscalationCount(r.patient_id) : 0,
  };
}

router.get('/admin/deletion/:id', deletionPerm, (req, res) => {
  const ctx = deletionCtx(req.params.id);
  if (!ctx) return notFound(res);
  res.render('admin/deletion_detail', { pageTitle: 'Запрос на удаление', ...ctx, dueDays: deletion.DELETION_DUE_DAYS });
});

router.get('/admin/deletion/:id/confirm', deletionPerm, (req, res) => {
  const ctx = deletionCtx(req.params.id);
  if (!ctx) return notFound(res);
  if (!ctx.pending) {
    flash(req, 'Этот запрос уже исполнен или не может быть исполнен.', 'info');
    return res.redirect(`/admin/deletion/${ctx.r.id}`);
  }
  res.render('admin/deletion_confirm', { pageTitle: 'Подтверждение удаления', ...ctx, error: null });
});

router.post('/admin/deletion/:id/execute', deletionPerm, (req, res) => {
  const ctx = deletionCtx(req.params.id);
  if (!ctx) return notFound(res);
  // W-38: forceOpenEscalations удалён — стирание при открытом кризисе не исполняется (F-85).
  const out = deletion.execute(adminId(req), ctx.r.id, {
    confirmServiceNo: req.body.confirm_service_no,
    confirmEmail: req.body.confirm_email,
  });
  if (!out.ok) {
    return res
      .status(422)
      .render('admin/deletion_confirm', { pageTitle: 'Подтверждение удаления', ...ctx, error: out.error });
  }
  flash(req, 'Данные пациента удалены. Отчёт ниже сохранён в запросе.', 'success');
  res.redirect(`/admin/deletion/${ctx.r.id}`);
});

// ---------- Приглашения ----------

router.get('/admin/invites', users, (req, res) => {
  const rows = db
    .prepare(
      `SELECT i.*, c.full_name AS clinician_name, p.full_name AS patient_name
       FROM invite_codes i LEFT JOIN users c ON c.id = i.clinician_id LEFT JOIN users p ON p.id = i.used_by ORDER BY i.id DESC LIMIT 200`,
    )
    .all()
    .map((i) => ({ ...i, status: invites.status(i), shown: i.code }));
  res.render('admin/invites', {
    pageTitle: 'Приглашения',
    rows,
    clinicians: core.activeClinicians(),
    defaultDays: invites.TTL_DAYS,
  });
});

router.post('/admin/invites', users, (req, res) => {
  const hit = require('../security/rate_limit').inviteCreate.hit(`a${adminId(req)}`);
  if (!hit.allowed) {
    flash(req, 'Создано слишком много кодов за короткое время. Повторите позже.', 'error');
    return res.redirect('/admin/invites');
  }
  const clin = core.getUser(req.body.clinician_id);
  if (!clin || !core.isActiveAccount(clin) || !['psychiatrist', 'psychologist'].includes(clin.role)) {
    flash(req, 'Выберите активного психиатра или психолога.', 'error');
    return res.redirect('/admin/invites');
  }
  const inv = invites.create(clin.id);
  const days = Math.min(90, Math.max(1, parseInt(req.body.days, 10) || invites.TTL_DAYS));
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  db.prepare('UPDATE invite_codes SET created_by = ?, expires_at = ? WHERE id = ?').run(adminId(req), expires, inv.id);
  core.logAdmin(adminId(req), 'invite_create', clin.id, { invite_id: inv.id });
  flash(
    req,
    `Код для ${clin.full_name}: ${inv.code} (действует до ${expires.slice(0, 10)}, одноразовый). Передайте пациенту вне сервиса.`,
    'success',
  );
  res.redirect('/admin/invites');
});

router.post('/admin/invites/:id/revoke', users, (req, res) => {
  const row = db.prepare('SELECT * FROM invite_codes WHERE id = ?').get(Number(req.params.id));
  const ok = !!row && invites.revoke(row.clinician_id, row.id);
  if (ok) core.logAdmin(adminId(req), 'invite_revoke', null, { invite_id: row.id });
  flash(
    req,
    ok ? 'Код отозван.' : 'Этот код нельзя отозвать: он уже использован, истёк или отозван.',
    ok ? 'success' : 'error',
  );
  res.redirect('/admin/invites');
});

// ---------- Журналы ----------

router.get('/admin/audit', auditPerm, (req, res) => {
  const log = audit.LOGS[req.query.log] ? req.query.log : 'phi';
  const filters = {
    who: req.query.who,
    subject: req.query.subject,
    action: req.query.action,
    from: req.query.from,
    to: req.query.to,
    page: req.query.page,
  };
  const result = audit.query(log, filters);
  if (req.query.format === 'csv') {
    core.logAdmin(adminId(req), 'audit_export', null, { log, rows: result.total });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit_${log}.csv"`);
    return res.send(audit.toCsv(log, result.rows));
  }
  res.render('admin/audit', {
    pageTitle: 'Журналы',
    log,
    def: audit.LOGS[log],
    logs: audit.LOGS,
    f: filters,
    ...result,
    exportStatus: log === 'export' ? audit.exportStatus() : null,
    query: Object.fromEntries(
      Object.entries({
        log,
        who: filters.who,
        subject: filters.subject,
        action: filters.action,
        from: filters.from,
        to: filters.to,
      }).filter(([, v]) => v),
    ),
  });
});

// ---------- Согласия, система ----------

router.get('/admin/consents', users, (req, res) => {
  res.render('admin/consents', { pageTitle: 'Согласия', rows: overview.consents() });
});

router.get('/admin/system', users, (req, res) => {
  res.render('admin/system', { pageTitle: 'Система', s: overview.systemInfo() });
});

module.exports = router;
module.exports.home = home;
