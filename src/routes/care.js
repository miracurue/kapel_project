'use strict';

// W2.F: психообразование, лечение и приём, сообщения врач<->пациент, опросник перед приёмом.
// Всё необязательно для врача. Свободный текст пациента проходит crisisGate (REQ-PAT-016).
// Кнопка «Мне плохо» (/help) остаётся отдельным кризисным путём и сюда не переносится.

const express = require('express');

const db = require('../db');
const care = require('../care');
const content = require('../content/psychoed');
const previsitContent = require('../content/previsit');
const crisisGate = require('../ai/crisisGate');
const assignments = require('../assignments');
const card = require('../patient_card');
const triage = require('../triage_data');
const { flash } = require('../middleware');
const { requirePermission, canAccessPatient, isClinician } = require('../permissions');
const { patientPage, safeLocal, notFound } = require('./patient/common');

const router = express.Router();
const { meds, messages, psychoed, previsit } = care;
const cfg = care.config;
const viewCard = requirePermission('patient.view_card');
const prescribe = requirePermission('medication.prescribe_plan');
const assignModule = requirePermission('psychoed.assign');

// ======================= пациент =======================

// ---- психообразование ----
router.get('/learn', patientPage, (req, res) => {
  const list = psychoed.listForPatient(req.session.user.id);
  res.render('care/learn', { title: 'Обучение', modules: list, done: list.filter((m) => m.readAt).length, stub: content.STUB_NOTE });
});

router.get('/learn/:key', patientPage, (req, res) => {
  const m = psychoed.listForPatient(req.session.user.id).find((x) => x.key === req.params.key);
  if (!m) return notFound(res, 'Такого материала нет.');
  const mod = content.byKey(m.key);
  res.render('care/learn_module', { title: m.title, m, mod, stub: content.STUB_NOTE });
});

router.post('/learn/:key/read', patientPage, (req, res) => {
  if (!psychoed.setRead(req.session.user.id, req.params.key, req.body.done !== '0')) return notFound(res, 'Такого материала нет.');
  flash(req, req.body.done === '0' ? 'Отметка снята. Можно вернуться к материалу позже.' : 'Отмечено как прочитанное.', 'success');
  res.redirect(`/learn/${req.params.key}`);
});

// ---- лечение и приём ----
router.get('/meds', patientPage, (req, res) => {
  const id = req.session.user.id;
  const state = meds.dayState(id);
  const items = meds.itemsForPatient(id).map((it) => ({ ...it, slots: meds.slotsOf(it).map((slot) => ({ slot, status: (state.find((s) => s.item.id === it.id && s.slot === slot) || {}).status || null })) }));
  const edit = req.query.edit ? items.find((i) => i.id === Number(req.query.edit) && i.source === 'patient') : null;
  res.render('care/meds', {
    title: 'Лечение', plan: items.filter((i) => i.source === 'clinician'), own: items.filter((i) => i.source === 'patient'), cfg, edit: edit || null,
    sharesOwn: !!(res.locals.prefs && res.locals.prefs.share_med_own),
  });
});

router.post('/meds', patientPage, (req, res) => {
  // W3.K (L-3): свободный текст «своих лекарств» (название, «как принимать») проходит кризисный шлюз
  const freeText = [req.body.name, req.body.how_text].filter(Boolean).join('\n').trim();
  if (freeText && crisisGate.handleText({ patientId: req.session.user.id, text: freeText, source: 'message', label: 'Кризисная фраза в списке своих лекарств' }).crisis) req.session.showSupport = true;
  const r = meds.addOwn(req.session.user.id, req.body);
  flash(req, r.error || 'Добавлено в ваш личный список.', r.error ? 'error' : 'success');
  res.redirect('/meds');
});

router.post('/meds/:id/end', patientPage, (req, res) => {
  flash(req, meds.endOwn(req.session.user.id, Number(req.params.id)) ? 'Убрано из списка.' : 'Не найдено.', 'info');
  res.redirect('/meds');
});

router.post('/meds/:id/ack', patientPage, (req, res) => {
  if (!meds.ack(req.session.user.id, Number(req.params.id))) return notFound(res);
  flash(req, 'Отмечено: вы ознакомились. Вопросы по лечению можно задать врачу.', 'success');
  res.redirect('/meds');
});

router.post('/meds/log', patientPage, (req, res) => {
  const r = meds.logIntake({ patientId: req.session.user.id, itemId: Number(req.body.item_id), slot: req.body.slot, status: req.body.status });
  if (r.error === 'not_found') return notFound(res);
  if (r.error) flash(req, 'Не удалось сохранить отметку.', 'error');
  else flash(req, { taken: 'Отмечено: принято.', skipped: 'Отмечено: пропущено. Это не страшно — можно рассказать врачу.', later: 'Хорошо, отметим позже.' }[req.body.status], 'success');
  res.redirect(safeLocal(req.body.back, '/meds'));
});

// ---- сообщения ----
router.get('/messages', patientPage, (req, res) => {
  const id = req.session.user.id;
  const rec = messages.recipients(id);
  const sel = rec.find((r) => r.id === Number(req.query.with)) || rec.find((r) => !r.away) || rec[0] || null;
  let thread = [];
  if (sel) {
    thread = messages.thread(id, sel.id);
    // статус «прочитано врачом» берём до отметки собственных прочтений
    messages.markRead('patient', id, sel.id);
  }
  const can = sel ? messages.canSend(id, sel.id) : { ok: false, code: 'no_clinician' };
  res.render('care/messages', {
    title: 'Сообщения врачу', rec, sel, thread, can, reason: can.ok ? '' : messages.reasonText(can), cfg, max: cfg.MESSAGE_MAX,
    draft: String(req.query.draft || ''),
  });
});

router.post('/messages', patientPage, (req, res) => {
  const id = req.session.user.id;
  const cid = Number(req.body.clinician_id);
  // REQ-PAT-016 + W3.K (L-2): шлюз выполняется ВСЕГДА и ДО любых отказов (нет врача / врач недоступен / нет согласия):
  // кризисная фраза создаёт эскалацию (очередь врача, при отсутствии врача — администратора) даже если сообщение не отправлено
  const rawText = String(req.body.body || '').trim().slice(0, cfg.MESSAGE_MAX);
  const g = rawText ? crisisGate.handleText({ patientId: id, text: rawText, source: 'message', label: 'Кризисная фраза в сообщении врачу' }) : { crisis: false };
  if (g.crisis) req.session.showSupport = true;
  const r = messages.patientSend(id, cid, req.body.body);
  if (r.error) {
    flash(req, g.crisis ? `${r.error} Ваша фраза передана в кризисную очередь сервиса.` : r.error, 'error');
    return res.redirect(`/messages?with=${cid || ''}`);
  }
  flash(req, 'Сообщение отправлено. Врач может ответить не сразу.', 'success');
  res.redirect(`/messages?with=${cid}`);
});

// ---- опросник перед приёмом ----
router.get('/previsit', patientPage, (req, res) => {
  const f = previsit.openFor(req.session.user.id);
  res.render('care/previsit', { title: 'Анкета перед приёмом', open: f, questions: previsitContent.QUESTIONS, sent: req.query.sent === '1', form: {} });
});

router.post('/previsit', patientPage, (req, res) => {
  const id = req.session.user.id;
  if (!previsit.openFor(id)) {
    flash(req, 'Сейчас врач не просил заполнить анкету.', 'info');
    return res.redirect('/previsit');
  }
  if (req.body.action === 'skip') {
    previsit.skip(id);
    flash(req, 'Хорошо, анкету можно не заполнять.', 'info');
    return res.redirect('/previsit');
  }
  const { answers, texts } = previsit.parseAnswers(req.body);
  previsit.submit(id, answers);
  if (texts.length) {
    const g = crisisGate.handleText({ patientId: id, text: texts.join('\n'), source: 'previsit', label: 'Кризисная фраза в анкете перед приёмом' });
    if (g.crisis) req.session.showSupport = true;
  }
  res.redirect('/previsit?sent=1');
});

// ======================= клиницист =======================

function openPatient(req, res) {
  const pid = Number(req.params.id);
  const user = req.session.user;
  if (!canAccessPatient(user, pid, db)) {
    res.status(403).render('error', { message: 'Этот пациент не закреплён за вами.' });
    return null;
  }
  const patient = card.patientBase(pid);
  if (!patient) { res.status(403).render('error', { message: 'Этот пациент не закреплён за вами.' }); return null; }
  const consent = assignments.consentState(pid);
  const row = triage.verdictFor(user.id, pid);
  return {
    pid, patient, consentOk: consent.ok, consentReason: consent.reason, archived: !!(row && row.archived),
    verdict: row ? row.verdict : null, tags: row ? row.tags : [], alsoWith: card.coClinicians(pid, user.id),
    tabs: card.TABS, tab: 'care', base: `/patients/${pid}`, disclaimer: card.CLINICAL_DISCLAIMER,
  };
}

// счётчик непрочитанных от этого пациента — для ссылки в шапке карточки
router.use('/patients/:id', (req, res, next) => {
  const u = req.session && req.session.user;
  res.locals.carePatientUnread = 0;
  if (u && isClinician(u.role) && Number.isInteger(Number(req.params.id)) && canAccessPatient(u, Number(req.params.id), db)) {
    res.locals.carePatientUnread = db
      .prepare("SELECT COUNT(*) AS n FROM care_messages WHERE patient_id = ? AND clinician_id = ? AND sender_role = 'patient' AND read_at IS NULL")
      .get(Number(req.params.id), u.id).n;
  }
  next();
});

// ---- входящие ----
router.get('/inbox', viewCard, (req, res) => {
  const uid = req.session.user.id;
  const inboxRows = messages.inbox(uid);
  card.logViewMany(uid, inboxRows.map((r) => r.patient_id), 'view_list_inbox'); // M-5
  res.render('care/c_inbox', { title: 'Сообщения', rows: inboxRows, settings: messages.settings(uid), cfg });
});

router.post('/inbox/settings', viewCard, (req, res) => {
  messages.saveSettings(req.session.user.id, { reply_note: req.body.reply_note, away_until: req.body.away_until });
  flash(req, 'Сохранено. Пациенты увидят это в разделе сообщений.', 'success');
  res.redirect('/inbox');
});

// ---- диалог с пациентом ----
router.get('/patients/:id/messages', viewCard, (req, res) => {
  const b = openPatient(req, res);
  if (!b) return;
  const uid = req.session.user.id;
  card.logView(uid, b.pid, 'view_patient_messages');
  const thread = b.consentOk ? messages.thread(b.pid, uid) : [];
  if (b.consentOk) messages.markRead('clinician', b.pid, uid);
  const tpl = cfg.QUICK_REPLIES.find((q) => q.key === req.query.tpl);
  res.render('care/c_messages', { ...b, title: 'Сообщения', thread, cfg, draft: tpl ? tpl.text : '', openCount: thread.filter((m) => m.sender_role === 'patient' && !m.handled_at).length });
});

router.post('/patients/:id/messages', viewCard, (req, res) => {
  const pid = Number(req.params.id);
  if (!canAccessPatient(req.session.user, pid, db)) return res.status(403).render('error', { message: 'Этот пациент не закреплён за вами.' });
  const r = messages.clinicianSend(req.session.user.id, pid, req.body.body);
  flash(req, r.error || 'Ответ отправлен.', r.error ? 'error' : 'success');
  res.redirect(`/patients/${pid}/messages`);
});

router.post('/patients/:id/messages/handled', viewCard, (req, res) => {
  const pid = Number(req.params.id);
  if (!canAccessPatient(req.session.user, pid, db)) return res.status(403).render('error', { message: 'Этот пациент не закреплён за вами.' });
  messages.markHandled(req.session.user.id, pid);
  flash(req, 'Отмечено как обработанное.', 'success');
  res.redirect(safeLocal(req.body.back, `/patients/${pid}/messages`));
});

// ---- модули и опросник ----
router.get('/patients/:id/learn', viewCard, (req, res) => {
  const b = openPatient(req, res);
  if (!b) return;
  card.logView(req.session.user.id, b.pid, 'view_patient_care');
  res.render('care/c_care', { ...b, title: 'Модули и опросник', modules: psychoed.listForPatient(b.pid), pv: previsit.forClinician(b.pid), stub: content.STUB_NOTE });
});

function guard(req, res) {
  const pid = Number(req.params.id);
  if (!canAccessPatient(req.session.user, pid, db)) { res.status(403).render('error', { message: 'Этот пациент не закреплён за вами.' }); return null; }
  return pid;
}

router.post('/patients/:id/learn/assign', assignModule, (req, res) => {
  const pid = guard(req, res);
  if (!pid) return;
  if (!assignments.consentState(pid).ok) flash(req, 'Назначить нельзя: нет действующего согласия пациента.', 'error');
  else flash(req, psychoed.assign(pid, String(req.body.module), req.session.user.id) ? 'Модуль назначен. Пациент увидит его на главной.' : 'Такого модуля нет.', 'success');
  res.redirect(`/patients/${pid}/learn`);
});

router.post('/patients/:id/learn/unassign', assignModule, (req, res) => {
  const pid = guard(req, res);
  if (!pid) return;
  psychoed.unassign(pid, String(req.body.module));
  flash(req, 'Назначение снято.', 'info');
  res.redirect(`/patients/${pid}/learn`);
});

router.post('/patients/:id/previsit/request', viewCard, (req, res) => {
  const pid = guard(req, res);
  if (!pid) return;
  if (!assignments.consentState(pid).ok) flash(req, 'Нельзя: нет действующего согласия пациента.', 'error');
  else flash(req, previsit.request(pid, req.session.user.id).existed ? 'Анкета уже отправлена пациенту.' : 'Анкета отправлена пациенту. Заполнять её он не обязан.', 'success');
  res.redirect(`/patients/${pid}/learn`);
});

router.post('/patients/:id/previsit/cancel', viewCard, (req, res) => {
  const pid = guard(req, res);
  if (!pid) return;
  previsit.cancel(pid);
  flash(req, 'Запрос анкеты отменён.', 'info');
  res.redirect(`/patients/${pid}/learn`);
});

// ---- план приёма (только психиатр: medication.prescribe_plan) ----
const toTreatment = (pid) => `/patients/${pid}/treatment`;

router.post('/patients/:id/plan', prescribe, (req, res) => {
  const pid = guard(req, res);
  if (!pid) return;
  const r = meds.addPlan(pid, req.session.user.id, req.body);
  flash(req, r.error || 'Пункт добавлен. Пациент его не видит, пока вы не нажмёте «Показать пациенту».', r.error ? 'error' : 'success');
  res.redirect(toTreatment(pid));
});

router.post('/patients/:id/plan/:iid/edit', prescribe, (req, res) => {
  const pid = guard(req, res);
  if (!pid) return;
  const r = meds.editPlan(pid, Number(req.params.iid), req.body);
  flash(req, r.error || 'Сохранено. Если пункт показан пациенту, ему снова нужно отметить «Понял(а)».', r.error ? 'error' : 'success');
  res.redirect(toTreatment(pid));
});

function planAction(name, fn, ok) {
  router.post(`/patients/:id/plan/:iid/${name}`, prescribe, (req, res) => {
    const pid = guard(req, res);
    if (!pid) return;
    if (!meds.planItem(pid, Number(req.params.iid))) return notFound(res, 'Пункт не найден.');
    if (name === 'publish' && !assignments.consentState(pid).ok) {
      flash(req, 'Показать пациенту нельзя: нет действующего согласия пациента.', 'error');
    } else {
      fn(pid, Number(req.params.iid));
      flash(req, ok, 'success');
    }
    res.redirect(toTreatment(pid));
  });
}
planAction('publish', (p, i) => meds.setPublished(p, i, true), 'Пункт показан пациенту.');
planAction('hide', (p, i) => meds.setPublished(p, i, false), 'Пункт скрыт от пациента.');
planAction('end', (p, i) => meds.endPlan(p, i), 'Пункт отмечен как завершённый.');
planAction('delete', (p, i) => meds.deletePlan(p, i), 'Пункт удалён.');

module.exports = router;
