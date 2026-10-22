'use strict';

// Напоминания (REQ-PAT-024): создание, правка, удаление, «готово», сортировка.
// Уведомлений вне приложения нет: напоминания видны при входе (честно сказано на экране).

const express = require('express');

const db = require('../../db');
const { flash } = require('../../middleware');
const { requirePermission } = require('../../permissions');
const { patientPage, notFound, safeLocal } = require('./common');
const crisisGate = require('../../ai/crisisGate');

// W3.K (L-3): текст напоминания проходит кризисный шлюз
function screenReminder(req, text) {
  if (text && crisisGate.handleText({ patientId: req.session.user.id, text, source: 'message', label: 'Кризисная фраза в напоминании' }).crisis) req.session.showSupport = true;
}

const router = express.Router();
const manage = requirePermission('reminders.manage');

function own(req) {
  return db.prepare('SELECT * FROM reminders WHERE id = ? AND patient_id = ?').get(req.params.id, req.session.user.id);
}

function startOfToday(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function advance(reminder, now = new Date()) {
  const step = reminder.recurrence === 'daily' ? 1 : 7;
  const next = new Date(reminder.remind_at);
  do {
    next.setDate(next.getDate() + step);
  } while (next <= now);
  return next.toISOString();
}

router.get('/reminders', patientPage, (req, res) => {
  const sort = req.query.sort === 'text' ? 'text' : 'time';
  const rows = db.prepare('SELECT * FROM reminders WHERE patient_id = ? AND active = 1').all(req.session.user.id);
  rows.sort((a, b) => (sort === 'text' ? a.message.localeCompare(b.message, 'ru') : new Date(a.remind_at) - new Date(b.remind_at)));
  const now = new Date();
  const sod = startOfToday(now);
  const reminders = rows.map((r) => ({ ...r, due: new Date(r.remind_at) <= now, mine: r.created_by === req.session.user.id }));
  const missedCount = reminders.filter((r) => r.due && new Date(r.remind_at) < sod).length;
  res.render('patient/reminders', { title: 'Напоминания', reminders, sort, missedCount });
});

function parseForm(body) {
  const message = String(body.message || '').trim().slice(0, 300);
  if (!message || !body.remind_at || Number.isNaN(Date.parse(body.remind_at))) return { error: 'Укажите текст и дату напоминания.' };
  return { message, remind_at: body.remind_at, recurrence: ['none', 'daily', 'weekly'].includes(body.recurrence) ? body.recurrence : 'none' };
}

router.post('/reminders', manage, (req, res) => {
  const f = parseForm(req.body);
  if (f.error) {
    flash(req, f.error, 'error');
    return res.redirect('/reminders');
  }
  screenReminder(req, f.message);
  db.prepare('INSERT INTO reminders (patient_id, created_by, message, remind_at, recurrence) VALUES (?, ?, ?, ?, ?)').run(
    req.session.user.id,
    req.session.user.id,
    f.message,
    f.remind_at,
    f.recurrence
  );
  flash(req, 'Напоминание создано.', 'success');
  res.redirect('/reminders');
});

router.post('/reminders/clear-missed', manage, (req, res) => {
  const now = new Date();
  const sod = startOfToday(now);
  const rows = db.prepare('SELECT * FROM reminders WHERE patient_id = ? AND active = 1').all(req.session.user.id);
  for (const r of rows) {
    if (new Date(r.remind_at) >= sod || new Date(r.remind_at) > now) continue;
    if (r.recurrence === 'none') db.prepare('UPDATE reminders SET active = 0 WHERE id = ?').run(r.id);
    else db.prepare('UPDATE reminders SET remind_at = ? WHERE id = ?').run(advance(r, now), r.id);
  }
  flash(req, 'Готово: прошлые напоминания убраны.', 'success');
  res.redirect(safeLocal(req.body.back, '/reminders'));
});

router.get('/reminders/:id/edit', patientPage, (req, res) => {
  const r = own(req);
  if (!r || r.created_by !== req.session.user.id) return notFound(res, 'Напоминание не найдено.');
  res.render('patient/reminder_edit', { title: 'Изменить напоминание', r });
});

router.post('/reminders/:id/edit', manage, (req, res) => {
  const r = own(req);
  if (!r || r.created_by !== req.session.user.id) return notFound(res, 'Напоминание не найдено.');
  const f = parseForm(req.body);
  if (f.error) {
    flash(req, f.error, 'error');
    return res.redirect(`/reminders/${r.id}/edit`);
  }
  screenReminder(req, f.message);
  db.prepare('UPDATE reminders SET message = ?, remind_at = ?, recurrence = ? WHERE id = ?').run(f.message, f.remind_at, f.recurrence, r.id);
  flash(req, 'Напоминание обновлено.', 'success');
  res.redirect('/reminders');
});

router.get('/reminders/:id/delete', patientPage, (req, res) => {
  const r = own(req);
  if (!r || r.created_by !== req.session.user.id) return notFound(res, 'Напоминание не найдено.');
  res.render('patient/reminder_delete', { title: 'Удалить напоминание', r });
});

router.post('/reminders/:id/delete', manage, (req, res) => {
  const r = own(req);
  if (!r || r.created_by !== req.session.user.id) return notFound(res, 'Напоминание не найдено.');
  db.prepare('DELETE FROM reminders WHERE id = ?').run(r.id);
  flash(req, 'Напоминание удалено.', 'success');
  res.redirect('/reminders');
});

router.post('/reminders/:id/done', manage, (req, res) => {
  const reminder = own(req);
  if (!reminder) return notFound(res, 'Напоминание не найдено.');
  if (reminder.recurrence === 'none') {
    db.prepare('UPDATE reminders SET active = 0 WHERE id = ?').run(reminder.id);
  } else {
    db.prepare('UPDATE reminders SET remind_at = ? WHERE id = ?').run(advance(reminder), reminder.id);
  }
  flash(req, 'Отмечено как сделанное.', 'success');
  res.redirect(safeLocal(req.body.back, '/reminders'));
});

module.exports = router;
module.exports.startOfToday = startOfToday;
