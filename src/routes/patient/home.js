'use strict';

// Главная «Сегодня» (REQ-PAT-001/013/020), онбординг (005), «Поделиться с врачом» (017),
// привязка к врачу по коду (020, CLN-021), экстренный экран (002/003).

const express = require('express');

const db = require('../../db');
const text = require('../../patient_text');
const helplines = require('../../../config/helplines');
const { flash } = require('../../middleware');
const { getPrefs, setPrefs, clearCareChange } = require('../../patient_prefs');
const appeals = require('../../appeals');
const crisisGate = require('../../ai/crisisGate');
const { patientPage, clinicianLink, catalog, todayStr } = require('./common');
const { readDraft } = require('./tests');
const { startOfToday } = require('./reminders');

const router = express.Router();

// Метка «последний визит» для сценария возвращения; обновляем не чаще раза в 10 минут.
router.use((req, res, next) => {
  const u = req.session.user;
  if (u && u.role === 'patient' && req.method === 'GET') {
    const p = res.locals.prefs || getPrefs(u.id);
    const last = p.last_seen_at ? Date.parse(p.last_seen_at) : 0;
    if (Date.now() - last > 10 * 60 * 1000) setPrefs(u.id, { last_seen_at: new Date().toISOString() });
  }
  next();
});

function lastActivity(patientId) {
  const q = (sql) => (db.prepare(sql).get(patientId) || {}).t || null;
  const dates = [
    q('SELECT MAX(created_at) AS t FROM mood_entries WHERE patient_id = ?'),
    q('SELECT MAX(created_at) AS t FROM online_results WHERE patient_id = ?'),
    q('SELECT MAX(m.created_at) AS t FROM chatbot_messages m JOIN chatbot_sessions s ON s.id = m.session_id WHERE s.patient_id = ? AND m.sender = \'user\''),
  ].filter(Boolean);
  return dates.length ? dates.map((d) => Date.parse(String(d).replace(' ', 'T') + (/[Z+]/.test(d) ? '' : 'Z'))).sort((a, b) => b - a)[0] : 0;
}

router.get('/dashboard', patientPage, (req, res) => {
  const user = req.session.user;
  const prefs = res.locals.prefs || getPrefs(user.id);
  if (prefs.onboarding_pending) return res.redirect('/onboarding');

  const id = user.id;
  const now = new Date();
  const clinicians = clinicianLink(id);
  if (clinicians.length && !prefs.had_clinician) setPrefs(id, { had_clinician: 1 });

  // возвращение после паузы >= 7 дней (REQ-PAT-013)
  const seen = prefs.last_seen_at ? Date.parse(prefs.last_seen_at) : 0;
  const lastSeen = Math.max(seen, lastActivity(id));
  // признак держится до конца этой сессии (иначе пропал бы при втором открытии главной)
  const returning = (lastSeen > 0 && now.getTime() - lastSeen >= 7 * 86400000) || req.session.returning === true;
  if (returning) req.session.returning = true;

  const pending = db
    .prepare("SELECT * FROM instrument_assignments WHERE patient_id = ? AND status = 'pending' ORDER BY assigned_at DESC, id DESC")
    .all(id)
    .map((p) => ({ ...p, ins: catalog.getTakeable(p.instrument) }))
    .filter((p) => p.ins);
  const pendingCard = pending[0]
    ? { ...pending[0], hasDraft: Object.keys(readDraft(pending[0].id)).length > 0, more: pending.length - 1 }
    : null;

  const sod = startOfToday(now);
  const reminders = db.prepare('SELECT * FROM reminders WHERE patient_id = ? AND active = 1 ORDER BY remind_at ASC').all(id);
  const dueToday = reminders.filter((r) => new Date(r.remind_at) <= now && new Date(r.remind_at) >= sod);
  const upcomingToday = reminders.filter((r) => new Date(r.remind_at) > now && todayStr(new Date(r.remind_at)) === todayStr(now));
  const missed = reminders.filter((r) => new Date(r.remind_at) < sod);
  const reminderCard = dueToday[0] || upcomingToday[0] || null;

  const todayEntry = db
    .prepare("SELECT 1 FROM mood_entries WHERE patient_id = ? AND COALESCE(entry_date, substr(created_at,1,10)) = ?")
    .get(id, todayStr(now));

  let cards = [];
  if (pendingCard) cards.push({ kind: 'test', data: pendingCard });
  if (reminderCard) cards.push({ kind: 'reminder', data: reminderCard, due: dueToday.includes(reminderCard) });
  for (const c of require('../../care').todayCards(id, now)) cards.push(c); // W2.F: приём, сообщение, анкета, материал
  if (!todayEntry) cards.push({ kind: 'diary' });
  if (returning) {
    // один предложенный шаг: дневник, а если запись уже есть — тест
    cards = cards.filter((c) => c.kind === 'diary').slice(0, 1);
    if (!cards.length && pendingCard) cards = [{ kind: 'test', data: pendingCard }];
  }
  cards = cards.slice(0, 3);

  res.render('patient/home', {
    title: 'Сегодня',
    cards,
    returning,
    missedCount: missed.length,
    pendingCount: pending.length, // D21: при «возвращении» один предложенный шаг, но назначенное врачом остаётся видимым
    linked: clinicians.length > 0,
    wasLinked: !!prefs.had_clinician,
    careNotice: prefs.care_change_kind || null,
    text,
    firstName: String(user.full_name || '').replace(/^Демо Пациент\s+/, '').split(/\s+/).slice(-1)[0],
    fullName: user.full_name,
  });
});

// ---------- Онбординг ----------

router.get('/onboarding', patientPage, (req, res) => {
  const step = Math.min(3, Math.max(1, Number.parseInt(req.query.step, 10) || 1));
  res.render('patient/onboarding', { title: 'Добро пожаловать', step, pending: !!getPrefs(req.session.user.id).onboarding_pending });
});

router.post('/onboarding', patientPage, (req, res) => {
  setPrefs(req.session.user.id, { onboarding_pending: 0 });
  res.redirect(req.body.to === 'privacy' ? '/privacy' : '/dashboard');
});

// ---------- Привязка по коду (REQ-PAT-020, REQ-CLN-021) ----------

const attempts = new Map(); // защита от перебора кода: 5 неудач за 10 минут на пациента
function tooMany(userId) {
  const now = Date.now();
  const arr = (attempts.get(userId) || []).filter((t) => now - t < 600000);
  attempts.set(userId, arr);
  return arr.length >= 5;
}

function redeemInvite(patientId, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!code) return { error: 'Введите код от врача.' };
  if (tooMany(patientId)) return { error: 'Слишком много попыток. Подождите несколько минут и попробуйте снова.' };
  const inv = db.prepare('SELECT * FROM invite_codes WHERE UPPER(code) = ?').get(code);
  const bad = () => {
    const arr = attempts.get(patientId) || [];
    arr.push(Date.now());
    attempts.set(patientId, arr);
  };
  if (!inv) { bad(); return { error: 'Такого кода нет. Проверьте, пожалуйста, и введите ещё раз.' }; }
  if (inv.revoked_at) { bad(); return { error: 'Этот код отозван. Попросите у врача новый.' }; }
  if (inv.used_at) { bad(); return { error: 'Этот код уже использован. Попросите у врача новый.' }; }
  if (Date.parse(String(inv.expires_at).replace(' ', 'T') + (/[Z+]/.test(inv.expires_at) ? '' : 'Z')) < Date.now()) {
    bad();
    return { error: 'Срок действия кода истёк. Попросите у врача новый.' };
  }
  const tx = db.transaction(() => {
    const upd = db.prepare("UPDATE invite_codes SET used_by = ?, used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL").run(patientId, new Date().toISOString(), inv.id);
    if (upd.changes !== 1) return false;
    db.prepare('INSERT OR IGNORE INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(patientId, inv.clinician_id);
    return true;
  });
  if (!tx()) return { error: 'Этот код уже использован. Попросите у врача новый.' };
  return { ok: true };
}

router.post('/link-code', patientPage, (req, res) => {
  const r = redeemInvite(req.session.user.id, req.body.code);
  if (r.error) flash(req, r.error, 'error');
  else clearCareChange(req.session.user.id);
  if (!r.error) flash(req, 'Готово: вы привязаны к врачу. Он будет видеть то, чем вы делитесь (см. «Поделиться с врачом»).', 'success');
  res.redirect('/dashboard');
});

// D7: пациент прочитал уведомление «врач изменился / наблюдение завершено»
router.post('/care-notice/dismiss', patientPage, (req, res) => {
  clearCareChange(req.session.user.id);
  res.redirect('/dashboard');
});

// ---------- Что видит мой врач ----------

router.get('/share', patientPage, (req, res) => {
  const id = req.session.user.id;
  res.render('patient/share', { title: 'Поделиться с врачом', prefs: getPrefs(id), linked: clinicianLink(id).length > 0 });
});

router.post('/share', patientPage, (req, res) => {
  const on = (v) => (v === '1' || v === 'on' ? 1 : 0);
  setPrefs(req.session.user.id, {
    share_diary_scores: on(req.body.scores),
    share_diary_notes: on(req.body.notes),
    share_med_log: on(req.body.med_log),
    share_med_own: on(req.body.med_own),
  });
  flash(req, 'Настройки сохранены и действуют сразу.', 'success');
  res.redirect('/share');
});

// ---------- Мне плохо ----------

// D25: «быстрый выход» с экрана помощи: сеанс завершается, открывается нейтральная страница входа (replace, без «Назад» в кабинет)
router.post('/quick-exit', (req, res) => {
  const done = () => { res.set('Cache-Control', 'no-store'); res.redirect('/login'); };
  if (req.session) return req.session.destroy(done);
  done();
});

router.get('/help', patientPage, (req, res) => {
  const id = req.session.user.id;
  res.render('patient/help', {
    title: 'Мне плохо',
    text,
    helplines,
    linked: clinicianLink(id).length > 0,
    sent: req.query.sent === '1',
    routedToAdmin: req.query.sent === '1' && req.query.to === 'admin',
  });
});

router.post('/help/contact', patientPage, (req, res) => {
  const id = req.session.user.id;
  const message = String(req.body.message || '').trim().slice(0, 500) || null;
  // не плодим дубли при повторных нажатиях подряд: одно открытое обращение за 10 минут
  const routed = appeals.hasRecentOpenAppeal(id) ? appeals.routeFor(id) : appeals.createAppeal({ patientId: id, message });
  // REQ-PAT-016/CRI-011: текст обращения проходит общий кризисный шлюз W1.C1
  if (message) crisisGate.handleText({ patientId: id, text: message, source: 'appeal', label: 'Кризисная фраза в обращении пациента' });
  res.redirect(`/help?sent=1&to=${routed.routedTo}`);
});

module.exports = router;
module.exports.redeemInvite = redeemInvite;
