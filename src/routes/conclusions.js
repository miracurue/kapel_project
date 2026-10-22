'use strict';

// W2.E: рабочее место заключений клинического психолога (REQ-PSY-001..009).
// Правила: писать и подписывать может только психолог-автор (conclusion.write / conclusion.sign_psychologist);
// психиатр и другие закреплённые клиницисты читают всё (черновики с пометкой), только чтение; пациент видит только выданное (/my-conclusions).

const express = require('express');
const bcrypt = require('bcryptjs');

const db = require('../db');
const C = require('../conclusions');
const exam = require('../conclusions/exam');
const card = require('../patient_card');
const triage = require('../triage_data');
const assignments = require('../assignments');
const exporter = require('../ai/workspace/export');
const { flash } = require('../middleware');
const limits = require('../security/rate_limit');
const secAudit = require('../security/audit');
const { requirePermission, canAccessPatient, can } = require('../permissions');

const router = express.Router();
const view = requirePermission('conclusion.view');
const write = requirePermission('conclusion.write');
const enter = requirePermission('offline_result.enter');

const wantsJson = (req) => req.xhr || req.get('X-Requested-With') === 'fetch' || /json/.test(req.get('Accept') || '');
const audit = (user, pid, action) => db.prepare('INSERT INTO phi_access_log (actor_id, patient_id, action) VALUES (?, ?, ?)').run(user.id, pid, action);
const denied = (res, msg = 'Этот пациент не закреплён за вами.') => res.status(403).render('error', { message: msg });
const missing = (res) => res.status(404).render('error', { message: 'Заключение не найдено.' });

function headVars(user, pid) {
  const patient = card.patientBase(pid);
  if (!patient) return null;
  const consent = assignments.consentState(pid);
  const row = triage.verdictFor(user.id, pid);
  return {
    pid, patient, consentOk: consent.ok, consentReason: consent.reason, archived: !!(row && row.archived),
    verdict: row ? row.verdict : null, tags: row ? row.tags : [], alsoWith: card.coClinicians(pid, user.id),
    tab: 'conclusions', tabs: card.TABS, base: `/patients/${pid}`,
  };
}

function patientPage(req, res, pid, tpl, extra = {}) {
  const user = req.session.user;
  if (!canAccessPatient(user, pid, db)) { denied(res); return false; }
  const h = headVars(user, pid);
  if (!h) { denied(res); return false; }
  res.render(tpl, {
    ...h, tabLabel: 'Заключения', disclaimer: card.CLINICAL_DISCLAIMER, signNotice: C.SIGN_NOTICE, reviewNote: C.REVIEW_NOTE,
    canWrite: can(user.role, 'conclusion.write'), today: new Date().toISOString().slice(0, 10), ...extra,
  });
  return true;
}

/** Заключение + проверка доступа. null — ответ уже отправлен. */
function load(req, res) {
  const user = req.session.user;
  const c = C.getConclusion(req.params.id);
  if (!c) { missing(res); return null; }
  if (!canAccessPatient(user, c.patient_id, db)) { denied(res); return null; }
  const mine = c.author_id === user.id;
  // черновики читают автор и психиатр; прочие клиницисты (коллега-психолог) — только подписанное
  const seesDraft = mine || user.role === 'psychiatrist';
  if (!seesDraft && !C.lastSigned(c.id)) { denied(res, 'Черновик заключения виден автору и психиатру.'); return null; }
  return { c, mine, seesDraft };
}

// ---------- список и поиск ----------

router.get('/conclusions', view, (req, res) => {
  const user = req.session.user;
  const q = { q: String(req.query.q || '').slice(0, 100), status: ['draft', 'signed'].includes(req.query.status) ? req.query.status : '',
    from: /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? req.query.from : '', to: /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? req.query.to : '' };
  const rows = C.listFor(user, q);
  const found = can(user.role, 'conclusion.write') ? C.searchProtocols(user, q) : [];
  res.render('clinician/conclusions_list', {
    rows, found, f: q, canWrite: can(user.role, 'conclusion.write'), signNotice: C.SIGN_NOTICE,
    myPatients: db.prepare('SELECT u.id, u.full_name FROM care_assignments ca JOIN users u ON u.id = ca.patient_id WHERE ca.clinician_id = ? ORDER BY u.full_name').all(user.id),
  });
});

// ---------- вкладка карточки пациента ----------

router.get('/patients/:id/conclusions', view, (req, res) => {
  const pid = Number(req.params.id);
  const user = req.session.user;
  if (!canAccessPatient(user, pid, db)) return denied(res);
  card.logView(user.id, pid, card.actionFor('conclusions'));
  patientPage(req, res, pid, 'clinician/conclusion_tab', {
    rows: C.listFor(user, { patientId: pid }),
    sessions: can(user.role, 'offline_result.enter') ? exam.listSessions(pid, user.id) : [],
    protocols: C.protocolsOf(pid),
  });
});

router.post('/patients/:id/conclusions', write, (req, res) => {
  const pid = Number(req.params.id);
  const user = req.session.user;
  if (!canAccessPatient(user, pid, db)) return denied(res);
  const id = C.create(pid, user, { title: req.body.title });
  audit(user, pid, 'conclusion_create');
  flash(req, 'Черновик заключения создан. Всё необязательно: можно сохранять с пустыми разделами.', 'success');
  res.redirect(`/conclusions/${id}`);
});

// ---------- сеансы обследования и протоколы (REQ-PSY-002) ----------

function loadSession(req, res) {
  const pid = Number(req.params.id);
  const user = req.session.user;
  if (!canAccessPatient(user, pid, db)) { denied(res); return null; }
  const s = exam.getSession(req.params.sid);
  if (!s || s.patient_id !== pid || s.author_id !== user.id) { res.status(404).render('error', { message: 'Сеанс обследования не найден.' }); return null; }
  return s;
}

router.post('/patients/:id/exam', enter, (req, res) => {
  const pid = Number(req.params.id);
  const user = req.session.user;
  if (!canAccessPatient(user, pid, db)) return denied(res);
  { const wb = assignments.writeBlocked(pid); if (wb.blocked) { flash(req, wb.reason, 'error'); return res.redirect(`/patients/${pid}`); } }
  const sid = exam.createSession(pid, user, { date: req.body.session_date, title: req.body.title });
  flash(req, 'Сеанс обследования создан. Вносите методики по частям — всё сохраняется, ничего не обязательно.', 'success');
  res.redirect(`/patients/${pid}/exam/${sid}`);
});

router.get('/patients/:id/exam/:sid', enter, (req, res) => {
  const s = loadSession(req, res);
  if (!s) return;
  card.logView(req.session.user.id, s.patient_id, 'view_exam_session');
  patientPage(req, res, s.patient_id, 'clinician/exam_session', {
    s, sv: exam.sessionView(s), groups: exam.pickable(), textMax: exam.TEXT_MAX, obsMax: exam.OBS_MAX,
  });
});

router.post('/patients/:id/exam/:sid/plan', enter, (req, res) => {
  const s = loadSession(req, res);
  if (!s) return;
  { const wb = assignments.writeBlocked(s.patient_id); if (wb.blocked) { if (wantsJson(req)) return res.status(409).json({ ok: false, message: wb.reason }); flash(req, wb.reason, 'error'); return res.redirect(`/patients/${s.patient_id}/exam/${s.id}`); } }
  if (req.body.remove) exam.removeFromPlan(s, String(req.body.remove));
  else if (!exam.addToPlan(s, String(req.body.instrument || ''))) flash(req, 'Выберите методику из списка.', 'error');
  res.redirect(`/patients/${s.patient_id}/exam/${s.id}`);
});

router.post('/patients/:id/exam/:sid/note', enter, (req, res) => {
  const s = loadSession(req, res);
  if (!s) return;
  { const wb = assignments.writeBlocked(s.patient_id); if (wb.blocked) { if (wantsJson(req)) return res.status(409).json({ ok: false, message: wb.reason }); flash(req, wb.reason, 'error'); return res.redirect(`/patients/${s.patient_id}/exam/${s.id}`); } }
  exam.updateNote(s, req.body.note);
  flash(req, 'Заметка к сеансу сохранена.', 'success');
  res.redirect(`/patients/${s.patient_id}/exam/${s.id}`);
});

router.post('/patients/:id/exam/:sid/protocol/:code', enter, (req, res) => {
  const s = loadSession(req, res);
  if (!s) return;
  { const wb = assignments.writeBlocked(s.patient_id); if (wb.blocked) { if (wantsJson(req)) return res.status(409).json({ ok: false, message: wb.reason }); flash(req, wb.reason, 'error'); return res.redirect(`/patients/${s.patient_id}/exam/${s.id}`); } }
  const r = exam.saveProtocol(s, req.session.user, req.params.code, req.body, { ready: req.body.ready === '1' });
  if (wantsJson(req)) return res.status(r.ok ? 200 : (r.code || 400)).json({ ok: !!r.ok, saved: !!r.saved, message: r.message || null, progress: exam.progress(exam.getSession(s.id)), at: new Date().toISOString() });
  if (!r.ok) flash(req, r.message || 'Не удалось сохранить: проверьте числовые поля (неотрицательные числа). Остальное можно сохранить и позже.', 'error');
  else flash(req, req.body.ready === '1' ? 'Протокол отмечен как готовый.' : 'Протокол сохранён (черновик).', 'success');
  res.redirect(`/patients/${s.patient_id}/exam/${s.id}#m-${encodeURIComponent(req.params.code)}`);
});

// ---------- заключение: просмотр, правка, подпись ----------

function renderConclusion(req, res, o, v, extra = {}) {
  const user = req.session.user;
  const latest = C.latestVersion(o.c.id);
  const isLatest = v.version === latest.version;
  const editable = o.mine && can(user.role, 'conclusion.write') && isLatest && v.status === 'draft';
  patientPage(req, res, o.c.patient_id, 'clinician/conclusion_edit', {
    c: o.c, v, latest, isLatest, editable, mine: o.mine, history: C.versions(o.c.id), seesDraft: o.seesDraft, sections: C.SECTIONS,
    integrity: v.status === 'signed' ? C.integrityOk(v) : null, reminders: C.remindersSafe(),
    canSign: o.mine && can(user.role, 'conclusion.sign_psychologist') && isLatest && v.status === 'draft',
    canRevise: o.mine && can(user.role, 'conclusion.write') && isLatest && v.status === 'signed',
    canRelease: o.mine && can(user.role, 'conclusion.release') && !!C.lastSigned(o.c.id),
    authorName: (db.prepare('SELECT full_name FROM users WHERE id = ?').get(o.c.author_id) || {}).full_name || '—',
    protocolsNow: C.protocolsOf(o.c.patient_id).length, ...extra,
  });
}

router.get('/conclusions/:id', view, (req, res) => {
  const o = load(req, res);
  if (!o) return;
  // психиатр («полный доступ», DECISIONS) читает и черновики: только чтение
  const v = o.seesDraft ? C.latestVersion(o.c.id) : C.lastSigned(o.c.id);
  card.logView(req.session.user.id, o.c.patient_id, 'view_conclusion');
  renderConclusion(req, res, o, v);
});

router.get('/conclusions/:id/versions/:n', view, (req, res) => {
  const o = load(req, res);
  if (!o) return;
  const v = C.getVersion(o.c.id, req.params.n);
  if (!v || (!o.seesDraft && v.status !== 'signed')) return missing(res);
  card.logView(req.session.user.id, o.c.patient_id, 'view_conclusion');
  renderConclusion(req, res, o, v);
});

function saveHandler(req, res) {
  const o = load(req, res);
  if (!o) return;
  const user = req.session.user;
  if (!o.mine || !can(user.role, 'conclusion.write')) return denied(res, 'Редактировать заключение может только его автор-психолог.');
  const sections = {};
  for (const k of C.SECTION_KEYS) if (req.body[k] !== undefined) sections[k] = req.body[k];
  const r = C.saveDraft(o.c.id, { title: req.body.title, sections });
  if (!r.ok) {
    const msg = 'Версия подписана и заблокирована. Чтобы изменить текст, создайте новую версию с указанием причины.';
    if (wantsJson(req)) return res.status(409).json({ ok: false, message: msg });
    return res.status(409).render('error', { message: msg });
  }
  if (wantsJson(req)) return res.json({ ok: true, at: new Date().toISOString() });
  flash(req, 'Черновик сохранён.', 'success');
  res.redirect(`/conclusions/${o.c.id}`);
}
router.post('/conclusions/:id', view, saveHandler);

router.post('/conclusions/:id/refill', write, (req, res) => {
  const o = load(req, res);
  if (!o) return;
  if (!o.mine) return denied(res, 'Редактировать заключение может только его автор-психолог.');
  const r = C.refillProtocols(o.c.id, o.c.patient_id);
  flash(req, r.ok ? `Данные протоколов подставлены заново (${r.count}). Текст раздела заменён — проверьте.` : 'Версия подписана: подстановка невозможна.', r.ok ? 'success' : 'error');
  res.redirect(`/conclusions/${o.c.id}`);
});

router.post('/conclusions/:id/sign', requirePermission('conclusion.sign_psychologist'), (req, res) => {
  const o = load(req, res);
  if (!o) return;
  const user = req.session.user;
  if (!o.mine) return denied(res, 'Подписать заключение может только его автор-психолог.');
  const fail = (m) => { flash(req, m, 'error'); res.redirect(`/conclusions/${o.c.id}#sign`); };
  const me = db.prepare('SELECT full_name, password_hash FROM users WHERE id = ?').get(user.id);
  let method = null;
  if (req.body.confirm_password) {
    const sk = `sign:${user.id}`;
    const lk = limits.sign.check(sk);
    if (lk.blocked) return fail(`Слишком много неверных паролей. Подождите ${limits.waitText(lk.retryAfterMs)}. Заключение не подписано.`);
    if (!bcrypt.compareSync(String(req.body.confirm_password), me.password_hash)) {
      const f = limits.sign.fail(sk);
      if (f.justLocked) secAudit.lockout('sign', { actorId: user.id, targetUserId: user.id, key: sk, retryAfterMs: f.retryAfterMs });
      return fail('Пароль указан неверно. Заключение не подписано.');
    }
    limits.sign.success(sk);
    method = 'password';
  } else {
    const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/ё/g, 'е');
    if (norm(req.body.confirm_name) !== norm(me.full_name) || req.body.confirm_check !== '1') {
      return fail('Для подписи введите пароль либо ваши ФИО точно как в профиле и отметьте «проверил(а) и подтверждаю». Заключение не подписано.');
    }
    method = 'name_check';
  }
  const r = C.sign(o.c.id, { id: user.id, full_name: me.full_name }, method);
  if (!r.ok) return fail('Последняя версия уже подписана.');
  audit(user, o.c.patient_id, 'conclusion_sign');
  flash(req, `Заключение подписано (версия ${r.version}). Текст заблокирован. ${C.SIGN_NOTICE}`, 'success');
  res.redirect(`/conclusions/${o.c.id}`);
});

router.post('/conclusions/:id/revise', write, (req, res) => {
  const o = load(req, res);
  if (!o) return;
  if (!o.mine) return denied(res, 'Править заключение может только его автор-психолог.');
  const r = C.revise(o.c.id, req.session.user, req.body.reason);
  if (!r.ok) {
    flash(req, r.message || 'Не удалось создать новую версию.', 'error');
    return res.redirect(`/conclusions/${o.c.id}#revise`);
  }
  audit(req.session.user, o.c.patient_id, 'conclusion_revise');
  flash(req, `Создана версия ${r.version} (черновик). Предыдущие версии сохранены в истории.`, 'success');
  res.redirect(`/conclusions/${o.c.id}`);
});

router.post('/conclusions/:id/release', requirePermission('conclusion.release'), (req, res) => {
  const o = load(req, res);
  if (!o) return;
  if (!o.mine) return denied(res, 'Решение о выдаче принимает автор-психолог.');
  const on = req.body.release === '1';
  const r = C.setRelease(o.c.id, on);
  if (!r.ok) flash(req, 'Выдать можно только подписанное заключение.', 'error');
  else {
    audit(req.session.user, o.c.patient_id, on ? 'conclusion_release' : 'conclusion_unrelease');
    flash(req, on ? 'Заключение выдано пациенту: он увидит последнюю подписанную версию.' : 'Выдача отозвана: пациент больше не видит заключение.', 'success');
  }
  res.redirect(`/conclusions/${o.c.id}`);
});

// ---------- экспорт (REQ-PSY-005): TXT / DOCX / PDF; имя файла без ФИО ----------

router.get('/conclusions/:id/export.:fmt(txt|docx|pdf)', view, (req, res) => {
  const o = load(req, res);
  if (!o) return;
  const fmt = exporter.FORMATS[req.params.fmt];
  const v = req.query.v ? C.getVersion(o.c.id, req.query.v) : (o.seesDraft ? C.latestVersion(o.c.id) : C.lastSigned(o.c.id));
  if (!v || (!o.seesDraft && v.status !== 'signed')) return missing(res);
  const authorName = (db.prepare('SELECT full_name FROM users WHERE id = ?').get(o.c.author_id) || {}).full_name || '';
  const patientName = (db.prepare('SELECT full_name FROM users WHERE id = ?').get(o.c.patient_id) || {}).full_name || '';
  const body = fmt.build(C.exportDoc(o.c, v, patientName, authorName));
  audit(req.session.user, o.c.patient_id, `conclusion_export_${req.params.fmt}`);
  res.setHeader('Content-Type', fmt.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="conclusion-${o.c.id}-v${v.version}${v.status === 'draft' ? '-draft' : ''}.${req.params.fmt}"`);
  res.send(body);
});

// ---------- пациент: только выданные заключения ----------

const patientOnly = (req, res, next) => (req.session.user && req.session.user.role === 'patient' ? next() : res.status(403).render('error', { message: 'Недостаточно прав для этого раздела.' }));

router.get('/my-conclusions', patientOnly, (req, res) => {
  const rows = db.prepare('SELECT c.* FROM conclusions c WHERE c.patient_id = ? AND c.released_to_patient = 1 ORDER BY c.released_at DESC').all(req.session.user.id)
    .map((c) => ({ ...c, signed: C.lastSigned(c.id) })).filter((c) => c.signed);
  res.render('patient/conclusions', { rows, one: null, sections: C.SECTIONS, signNotice: C.SIGN_NOTICE });
});

router.get('/my-conclusions/:id', patientOnly, (req, res) => {
  const c = C.getConclusion(req.params.id);
  if (!c || c.patient_id !== req.session.user.id || !c.released_to_patient) return missing(res);
  const signed = C.lastSigned(c.id);
  if (!signed) return missing(res);
  res.render('patient/conclusions', { rows: [], one: { ...c, signed }, sections: C.SECTIONS, signNotice: C.SIGN_NOTICE });
});

module.exports = router;
