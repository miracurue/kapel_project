'use strict';

// W1.B2: страница «Назначения» (REQ-CLN-019), пакеты, дубли, отмена, расписание повторов, коды-приглашения.

const express = require('express');

const db = require('../db');
const catalog = require('../instruments_catalog');
const assignments = require('../assignments');
const invites = require('../invites');
const { flash } = require('../middleware');
const limits = require('../security/rate_limit');
const { requirePermission, can } = require('../permissions');
const triage = require('../triage_data');

const router = express.Router();
const assign = requirePermission('test.assign');

function myPatients(user) {
  const { patients } = triage.listPatients(user.id, { archived: 'all' });
  return patients.map((p) => ({
    id: p.id, full_name: p.full_name, archived: p.archived,
    consentOk: assignments.consentState(p.id).ok,
    consentReason: assignments.consentState(p.id).reason,
  }));
}

function pageData(req, extra = {}) {
  const user = req.session.user;
  const patients = myPatients(user);
  const ids = patients.map((p) => p.id);
  return {
    patients,
    preselected: assignments.ensureArray(req.query.patient).map(Number),
    groups: catalog.groupedCatalog((e) => !!assignments.statusFor(e.code)),
    packages: assignments.PACKAGES.map((p) => ({ ...p, entries: p.items.map((c) => catalog.getEntry(c)).filter(Boolean) })),
    active: assignments.listActive(ids),
    schedules: assignments.listSchedules(ids),
    commentMax: assignments.COMMENT_MAX,
    ...extra,
  };
}

router.get('/assignments', assign, (req, res) => {
  assignments.runSchedules();
  res.render('clinician/assignments', pageData(req));
});

function fromBody(req) {
  const b = req.body || {};
  const patientIds = [...assignments.ensureArray(b.patient_id), ...assignments.ensureArray(b.patient_ids)].map(Number);
  const pkg = b.package ? assignments.getPackage(String(b.package)) : null;
  const codes = pkg ? pkg.items : assignments.ensureArray(b.instrument);
  const unit = b.repeat_unit === 'weeks' ? 7 : 1;
  const repeatN = parseInt(b.repeat_every, 10);
  const repeatDays = Number.isInteger(repeatN) && repeatN >= 1 ? repeatN * unit : null;
  return { patientIds: [...new Set(patientIds)], pkg, codes: [...new Set(codes)], due: b.due_date, comment: b.comment, repeatDays, b };
}

router.post('/assignments', assign, (req, res) => {
  const user = req.session.user;
  const f = fromBody(req);
  if (!f.patientIds.length || !f.codes.length) {
    flash(req, 'Выберите пациента и методику (или пакет).', 'error');
    return res.redirect('/assignments');
  }
  // заглушки каталога — только при праве назначать любые методики каталога
  if (f.codes.some((c) => catalog.isStub(c)) && !can(user.role, 'test.assign.any_catalog')) {
    flash(req, 'Недостаточно прав для назначения методик каталога.', 'error');
    return res.redirect('/assignments');
  }
  const items = assignments.plan(user, f.patientIds, f.codes);
  if (items.some((i) => i.forbidden) && items.every((i) => i.forbidden)) {
    flash(req, 'Этот пациент не закреплён за вами.', 'error');
    return res.redirect('/assignments');
  }
  const single = f.patientIds.length === 1 && f.codes.length === 1 && !f.pkg;
  const confirmed = req.body.confirm === '1';
  const force = req.body.force === '1' || req.body.dup === 'force';

  // предпросмотр: пакет или несколько пациентов (REQ-CAT-010, CLN-019); обычное одиночное — сразу
  if (!confirmed && !single) {
    return res.render('clinician/assignments_preview', {
      items, pkg: f.pkg, codes: f.codes, patientIds: f.patientIds, due: assignments.cleanDue(f.due) || '', comment: assignments.cleanComment(f.comment) || '',
      repeatDays: f.repeatDays, repeat: { every: req.body.repeat_every || '', unit: req.body.repeat_unit || '' }, mode: 'preview',
      dupCount: items.filter((i) => i.action === 'duplicate').length,
    });
  }
  // одиночное назначение уже ожидающего теста: предупреждение «уже назначен» (REQ-CAT-011)
  if (single && !force && items[0] && items[0].action === 'duplicate') {
    return res.render('clinician/assignments_preview', {
      items, pkg: null, codes: f.codes, patientIds: f.patientIds, due: assignments.cleanDue(f.due) || '', comment: assignments.cleanComment(f.comment) || '',
      repeatDays: f.repeatDays, repeat: { every: req.body.repeat_every || '', unit: req.body.repeat_unit || '' }, mode: 'duplicate', dupCount: 1,
    });
  }
  const r = assignments.create(user, f.patientIds, f.codes, { due: f.due, comment: f.comment, force, repeatDays: f.repeatDays, batchCode: f.pkg ? f.pkg.code : null });
  const waiting = r.items.filter((i) => i.action !== 'refused' && i.status === 'waiting_entry' && r.created.length).length;
  const parts = [`Назначено: ${r.created.length}`];
  if (waiting) parts.push('очные методики ждут вашего ввода протокола (пациент их не видит)');
  const dups = r.skipped.filter((i) => i.action === 'duplicate').length;
  if (dups) parts.push(`пропущено дублей: ${dups}`);
  const refused = r.skipped.filter((i) => i.action === 'refused');
  if (refused.length) parts.push(`не назначено: ${refused.map((i) => `${i.patientName} — ${i.reason}`).join('; ')}`);
  flash(req, parts.join('. ') + '.', r.created.length ? 'success' : 'error');
  res.redirect(single ? `/patients/${f.patientIds[0]}` : '/assignments');
});

router.post('/assignments/:id/cancel', assign, (req, res) => {
  const r = assignments.cancel(req.session.user, req.params.id, req.body.reason);
  if (r.forbidden) return res.status(403).render('error', { message: r.message });
  flash(req, r.message, r.ok ? 'success' : 'error');
  const b = String(req.body.back || '');
  res.redirect(/^\/(assignments|patients\/\d+)(\/|$|\?)/.test(b) && !b.startsWith('//') ? b : '/assignments');
});

router.post('/schedules/:id/stop', assign, (req, res) => {
  if (!assignments.stopSchedule(req.session.user, req.params.id)) return res.status(403).render('error', { message: 'Расписание не найдено или пациент не закреплён за вами.' });
  flash(req, 'Повторы отключены. Уже созданные назначения остались.', 'success');
  const b = String(req.body.back || '');
  res.redirect(/^\/(assignments|patients\/\d+)(\/|$|\?)/.test(b) && !b.startsWith('//') ? b : '/assignments');
});

// ---------- коды-приглашения (REQ-CLN-021) ----------

const invitePerm = requirePermission('patient.view_card');

router.get('/invites', invitePerm, (req, res) => {
  res.render('clinician/invites', { list: invites.listForClinician(req.session.user.id), ttl: invites.TTL_DAYS, fresh: req.session.freshInvite || null, base: `${req.protocol}://${req.get('host')}` });
  req.session.freshInvite = null;
});

router.post('/invites', invitePerm, (req, res) => {
  const hit = limits.inviteCreate.hit(`u${req.session.user.id}`);
  if (!hit.allowed) {
    flash(req, `Создано слишком много кодов за короткое время. Повторите через ${limits.waitText(hit.retryAfterMs)}.`, 'error');
    return res.redirect('/invites');
  }
  const row = invites.create(req.session.user.id);
  req.session.freshInvite = row.code;
  flash(req, 'Код создан. Передайте его пациенту: он одноразовый и действует ограниченное время.', 'success');
  res.redirect('/invites');
});

router.post('/invites/:id/revoke', invitePerm, (req, res) => {
  const ok = invites.revoke(req.session.user.id, req.params.id);
  flash(req, ok ? 'Код отозван.' : 'Код не найден или уже не действует.', ok ? 'success' : 'error');
  res.redirect('/invites');
});

module.exports = router;
