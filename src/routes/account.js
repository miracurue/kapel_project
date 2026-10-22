'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');

const db = require('../db');
const { flash } = require('../middleware');
const { requirePermission } = require('../permissions');
const { getPrefs, setPrefs } = require('../patient_prefs');
const { patientPage } = require('./patient/common');
const { CONSENT_VERSION } = require('./auth');
const limits = require('../security/rate_limit');
const secAudit = require('../security/audit');

const router = express.Router();

// ---------- Account / privacy rights (152-ФЗ ст.14, 21) ----------
//
// Права субъекта данных: отзыв согласия на научный экспорт (не трогает
// лечебные данные) и отзыв согласия + запрос удаления всех данных
// (переводит аккаунт в 'deletion_requested' — дальнейшее физическое
// удаление/анонимизация выполняется администратором в сроки 152-ФЗ).
// Оба действия журналируются в data_subject_requests.

const { actionLabel } = require('../labels');
const ROLE_LABELS = { psychiatrist: 'психиатр', psychologist: 'психолог', admin: 'администратор' };

router.get('/privacy', patientPage, (req, res) => {
  const id = req.session.user.id;
  const consent = db
    .prepare(
      `SELECT consent_given, consent_at, consent_version, clinical_consent_given, clinical_consent_at,
              anonymized_export_opt_in, export_consent_revoked_at, account_status FROM users WHERE id = ?`
    )
    .get(id);
  const viewsRaw = db
    .prepare(
      `SELECT l.action, l.created_at, u.role AS actor_role FROM phi_access_log l LEFT JOIN users u ON u.id = l.actor_id
       WHERE l.patient_id = ? ORDER BY l.created_at DESC, l.id DESC LIMIT 500`
    )
    .all(id);
  // D18: одинаковые записи за один день сворачиваются в одну строку со счётчиком; показываем последние 30 строк
  const groups = new Map();
  for (const v of viewsRaw) {
    const role = ROLE_LABELS[v.actor_role] || 'сотрудник сервиса';
    const action = actionLabel(v.action);
    const day = String(v.created_at).slice(0, 10);
    const key = `${day}|${role}|${action}`;
    if (!groups.has(key)) groups.set(key, { when: day, role, action, count: 0 });
    groups.get(key).count += 1;
  }
  const views = [...groups.values()].slice(0, 30);
  res.render('patient/privacy', { title: 'Приватность', consent, views, CONSENT_VERSION });
});

router.post('/account/export-consent/revoke', requirePermission('account.export_consent_revoke'), (req, res) => {
  const userId = req.session.user.id;
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET anonymized_export_opt_in = 0, export_consent_revoked_at = ? WHERE id = ?').run(now, userId);
  db.prepare(
    `INSERT INTO data_subject_requests (patient_id, request_type, actions_taken_json)
     VALUES (?, 'export_consent_revocation', ?)`
  ).run(userId, JSON.stringify({ export_consent_revoked_at: now }));
  flash(req, 'Согласие на использование ваших данных в псевдонимизированном научном анализе отозвано.', 'success');
  res.redirect('/privacy');
});

// Шаг 1 из 2: объяснение последствий. Шаг 2 — POST ниже.
router.get('/privacy/delete', patientPage, (req, res) => {
  res.render('patient/delete_request', { title: 'Удаление данных' });
});

router.post('/account/deletion-request', requirePermission('account.deletion_request'), (req, res) => {
  const userId = req.session.user.id;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE users SET consent_revoked_at = ?, anonymized_export_opt_in = 0, export_consent_revoked_at = ?, account_status = 'deletion_requested'
     WHERE id = ?`
  ).run(now, now, userId);
  db.prepare(
    `INSERT INTO data_subject_requests (patient_id, request_type, actions_taken_json)
     VALUES (?, 'consent_revocation_and_deletion', ?)`
  ).run(userId, JSON.stringify({ consent_revoked_at: now, account_status: 'deletion_requested' }));

  // Немедленно отключаем доступ в рамках текущей сессии, не дожидаясь
  // повторного логина (который теперь всё равно будет заблокирован).
  req.session.user = null;
  flash(req, 'Запрос принят: согласие отозвано, доступ к аккаунту отключён. Удаление данных будет завершено администратором в сроки, установленные 152-ФЗ. Пока удаление не выполнено, запрос можно отменить на странице входа.', 'success');
  res.redirect('/login');
});

// Отмена запроса до исполнения (REQ-PAT-018). Доступна с экрана входа по e-mail и паролю,
// потому что доступ к аккаунту после запроса отключён.
// REVIEW-REQUIRED (юридически): после отмены восстанавливается только доступ;
// согласие на научный экспорт остаётся отозванным.
router.get('/account/cancel-deletion', (req, res) => {
  res.render('patient/cancel_deletion', { title: 'Отмена запроса на удаление' });
});

router.post('/account/cancel-deletion', (req, res) => {
  const { email, password } = req.body;
  const key = `${req.ip}|${String(email || '').trim().toLowerCase().slice(0, 254)}`;
  const lk = limits.cancelDeletion.check(key);
  if (lk.blocked) {
    flash(req, `Слишком много попыток. Подождите ${limits.waitText(lk.retryAfterMs)}.`, 'error');
    return res.redirect('/account/cancel-deletion');
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email || '');
  if (!user || user.role !== 'patient' || !bcrypt.compareSync(password || '', user.password_hash)) {
    const f = limits.cancelDeletion.fail(key);
    if (f.justLocked) secAudit.lockout('cancel_deletion', { targetUserId: user ? user.id : null, key, retryAfterMs: f.retryAfterMs });
    flash(req, 'Неверный email или пароль.', 'error');
    return res.redirect('/account/cancel-deletion');
  }
  limits.cancelDeletion.success(key);
  if (user.account_status !== 'deletion_requested') {
    flash(req, 'По этому аккаунту нет действующего запроса на удаление, который можно отменить.', 'error');
    return res.redirect('/login');
  }
  // W3.K (L-6): восстанавливается только доступ; отзыв согласия на научный экспорт (opt_in = 0, export_consent_revoked_at) НЕ трогаем
  db.prepare("UPDATE users SET account_status = 'active', consent_revoked_at = NULL WHERE id = ?").run(user.id);
  db.prepare('INSERT INTO phi_access_log (actor_id, patient_id, action) VALUES (?, ?, ?)').run(user.id, user.id, 'deletion_request_cancelled');
  flash(req, 'Запрос на удаление отменён. Теперь можно войти. Согласие на научный анализ остаётся отозванным.', 'success');
  res.redirect('/login');
});

// ---------- Скачать мои данные (только свои) ----------

function collectOwnData(id) {
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  return {
    exported_at: new Date().toISOString(),
    profile: db
      .prepare(
        `SELECT id, email, full_name, created_at, consent_given, consent_version, consent_at, clinical_consent_given,
                clinical_consent_at, anonymized_export_opt_in, export_consent_revoked_at FROM users WHERE id = ?`
      )
      .get(id),
    online_results: q(
      'SELECT id, instrument, answers_json, total_score, band, created_at FROM online_results WHERE patient_id = ? ORDER BY created_at',
      id
    ),
    offline_results: q('SELECT id, instrument, total_score, band, test_date, notes FROM offline_results WHERE patient_id = ? ORDER BY test_date', id),
    diary: q(
      'SELECT id, mood_score, entry_date, sleep_hours, anxiety, triggers, note, created_at FROM mood_entries WHERE patient_id = ? ORDER BY created_at',
      id
    ),
    reminders: q('SELECT id, message, remind_at, recurrence, active FROM reminders WHERE patient_id = ? ORDER BY remind_at', id),
    chat_messages: q(
      `SELECT m.sender, m.text, m.created_at FROM chatbot_messages m JOIN chatbot_sessions s ON s.id = m.session_id
       WHERE s.patient_id = ? ORDER BY m.id`,
      id
    ),
    appeals: q('SELECT id, message, status, created_at FROM patient_appeals WHERE patient_id = ? ORDER BY created_at', id),
  };
}

router.get('/account/export.json', patientPage, (req, res) => {
  res.set('Content-Disposition', 'attachment; filename="my-data.json"');
  res.type('application/json').send(JSON.stringify(collectOwnData(req.session.user.id), null, 2));
});

const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // защита от формул в таблицах
  return `"${s.replace(/"/g, '""')}"`;
};

router.get('/account/export.csv', patientPage, (req, res) => {
  const d = collectOwnData(req.session.user.id);
  const rows = [['раздел', 'дата', 'название', 'значение', 'заметка']];
  d.online_results.forEach((r) => rows.push(['тест онлайн', r.created_at, r.instrument, r.total_score, '']));
  d.offline_results.forEach((r) => rows.push(['тест очно', r.test_date, r.instrument, r.total_score, r.notes]));
  d.diary.forEach((r) => rows.push(['дневник', r.entry_date || r.created_at, 'настроение', r.mood_score, [r.triggers, r.note].filter(Boolean).join(' | ')]));
  d.reminders.forEach((r) => rows.push(['напоминание', r.remind_at, r.message, r.recurrence, '']));
  d.chat_messages.forEach((r) => rows.push(['чат', r.created_at, r.sender, r.text, '']));
  res.set('Content-Disposition', 'attachment; filename="my-data.csv"');
  res.type('text/csv; charset=utf-8').send('﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'));
});

// ---------- Профиль ----------

router.get('/profile', patientPage, (req, res) => {
  const row = db.prepare('SELECT contact_phone FROM users WHERE id = ?').get(req.session.user.id);
  res.render('patient/profile', { title: 'Профиль', prefs: getPrefs(req.session.user.id), email: req.session.user.email, phone: (row && row.contact_phone) || '' });
});

// Необязательный телефон для срочной связи: его видит врач в карточке (W1.B1 читает users.contact_phone).
router.post('/profile/phone', patientPage, (req, res) => {
  const phone = String(req.body.phone || '').trim().slice(0, 30);
  if (phone && !/^[+\d][\d\s()\-]{4,29}$/.test(phone)) {
    flash(req, 'Телефон: только цифры, пробелы, скобки и дефис (или оставьте пустым).', 'error');
    return res.redirect('/profile');
  }
  db.prepare('UPDATE users SET contact_phone = ? WHERE id = ?').run(phone || null, req.session.user.id);
  flash(req, phone ? 'Телефон сохранён.' : 'Телефон удалён.', 'success');
  res.redirect('/profile');
});

router.post('/profile/appearance', patientPage, (req, res) => {
  const theme = ['auto', 'light', 'dark'].includes(req.body.theme) ? req.body.theme : 'auto';
  setPrefs(req.session.user.id, { theme, large_font: req.body.large_font === '1' ? 1 : 0 });
  flash(req, 'Оформление сохранено.', 'success');
  res.redirect('/profile');
});

router.post('/profile/password', patientPage, (req, res) => {
  const { current_password, new_password, new_password2 } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  const fail = (m) => {
    flash(req, m, 'error');
    return res.redirect('/profile');
  };
  const pk = `pw:${user.id}`;
  const lk = limits.password.check(pk);
  if (lk.blocked) return fail(`Слишком много неверных паролей. Подождите ${limits.waitText(lk.retryAfterMs)} и повторите.`);
  if (!bcrypt.compareSync(current_password || '', user.password_hash)) {
    const f = limits.password.fail(pk);
    if (f.justLocked) secAudit.lockout('password', { actorId: user.id, targetUserId: user.id, key: pk, retryAfterMs: f.retryAfterMs });
    return fail('Текущий пароль указан неверно.');
  }
  limits.password.success(pk);
  if (!new_password || new_password.length < 8) return fail('Новый пароль должен быть не короче 8 символов.');
  if (new_password.toLowerCase() === String(user.email).toLowerCase()) return fail('Пароль не должен совпадать с e-mail.');
  if (new_password !== new_password2) return fail('Новый пароль и повтор не совпадают.');
  if (new_password === current_password) return fail('Новый пароль должен отличаться от текущего.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), user.id);
  // все остальные сессии (начатые раньше этой метки) станут недействительными
  const mark = Date.now();
  setPrefs(user.id, { sessions_valid_from: mark });
  req.session.user.since = mark;
  flash(req, 'Пароль изменён. На других устройствах потребуется войти заново.', 'success');
  res.redirect('/profile');
});

module.exports = router;
