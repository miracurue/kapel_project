'use strict';

// Дневник настроения (REQ-PAT-014/015/016/017): запись за 3 тапа, правка/удаление,
// график 7/30/90 дней, метки «что видит врач», разовая отправка записи врачу.

const express = require('express');

const db = require('../../db');
const charts = require('../../../public/charts');
const { flash } = require('../../middleware');
const { requirePermission } = require('../../permissions');
const { getPrefs } = require('../../patient_prefs');
const crisisGate = require('../../ai/crisisGate');

// REQ-PAT-016: заметка и «что повлияло» проходят общий кризисный шлюз (W1.C1)
function screenFreeText(patientId, text, source) {
  if (!text) return false;
  return crisisGate.handleText({ patientId, text, source, label: 'Кризисная фраза в заметке дневника' }).crisis;
}
const { RESULT_DISCLAIMER } = require('../../disclaimers');
const { patientPage, notFound, todayStr } = require('./common');

const router = express.Router();
const write = requirePermission('diary.write');

function ownEntry(req) {
  return db.prepare('SELECT * FROM mood_entries WHERE id = ? AND patient_id = ?').get(req.params.id, req.session.user.id);
}

// Разбор и проверка формы. Возвращает { error } или { value }.
function parseEntry(body) {
  const score = Number(body.mood_score);
  if (!Number.isInteger(score) || score < 1 || score > 10) return { error: 'Выберите оценку настроения от 1 до 10.' };
  const out = { mood_score: score, note: null, triggers: null, sleep_hours: null, anxiety: null, entry_date: todayStr() };
  if (body.entry_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.entry_date) || Number.isNaN(Date.parse(body.entry_date))) return { error: 'Дата записи указана неверно.' };
    if (body.entry_date > todayStr()) return { error: 'Запись можно сделать только за сегодня или за прошлые дни.' };
    out.entry_date = body.entry_date;
  }
  if (body.sleep_hours !== undefined && String(body.sleep_hours).trim() !== '') {
    const h = Number(String(body.sleep_hours).replace(',', '.'));
    if (!Number.isFinite(h) || h < 0 || h > 24) return { error: 'Сон: число часов от 0 до 24 (или оставьте пустым).' };
    out.sleep_hours = h;
  }
  if (body.anxiety !== undefined && String(body.anxiety).trim() !== '') {
    const a = Number(body.anxiety);
    if (!Number.isInteger(a) || a < 1 || a > 10) return { error: 'Тревога: число от 1 до 10 (или оставьте пустым).' };
    out.anxiety = a;
  }
  if (body.triggers && String(body.triggers).trim()) out.triggers = String(body.triggers).trim().slice(0, 500);
  if (body.note && String(body.note).trim()) out.note = String(body.note).trim().slice(0, 4000);
  return { value: out };
}

function formDefaults(entry) {
  return {
    mood_score: entry ? entry.mood_score : '',
    entry_date: entry ? entry.entry_date || String(entry.created_at).slice(0, 10) : todayStr(),
    sleep_hours: entry && entry.sleep_hours !== null ? entry.sleep_hours : '',
    anxiety: entry && entry.anxiety !== null ? entry.anxiety : '',
    triggers: entry ? entry.triggers || '' : '',
    note: entry ? entry.note || '' : '',
  };
}

function entryDate(e) {
  return e.entry_date || String(e.created_at).slice(0, 10);
}

function renderDiary(req, res, extra = {}) {
  const id = req.session.user.id;
  const range = [7, 30, 90].includes(Number(req.query.range)) ? Number(req.query.range) : 30;
  const from = new Date(Date.now() - range * 86400000);
  const fromStr = todayStr(from);
  const all = db
    .prepare('SELECT * FROM mood_entries WHERE patient_id = ? ORDER BY COALESCE(entry_date, substr(created_at,1,10)) DESC, id DESC')
    .all(id);
  const inRange = all.filter((e) => entryDate(e) >= fromStr).reverse();
  const points = inRange.map((e) => ({ t: entryDate(e), v: e.mood_score, label: `${entryDate(e)}: ${e.mood_score}` }));
  res.status(extra.status || 200).render('patient/diary', {
    title: 'Дневник',
    prefs: getPrefs(id),
    entries: req.query.all === '1' ? all : all.slice(0, 10),
    totalEntries: all.length,
    showAll: req.query.all === '1',
    range,
    pointsCount: points.length,
    svg: points.length >= 2 ? charts.lineChart(points, { min: 1, max: 10, title: `Настроение за ${range} дней` }) : '',
    form: extra.form || formDefaults(null),
    formError: extra.error || null,
    entryDate,
    todayValue: todayStr(),
    RESULT_DISCLAIMER,
  });
}

router.get('/diary', patientPage, (req, res) => renderDiary(req, res));

function create(req, res) {
  const parsed = parseEntry(req.body);
  if (parsed.error) return renderDiary(req, res, { status: 400, error: parsed.error, form: { ...formDefaults(null), ...req.body } });
  const v = parsed.value;
  db.prepare(
    'INSERT INTO mood_entries (patient_id, mood_score, note, entry_date, sleep_hours, anxiety, triggers) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.session.user.id, v.mood_score, v.note, v.entry_date, v.sleep_hours, v.anxiety, v.triggers);
  // REQ-PAT-016: свободный текст проходит тот же классификатор, что и чат
  const hit = screenFreeText(req.session.user.id, [v.note, v.triggers].filter(Boolean).join('\n'), 'diary');
  if (hit) req.session.showSupport = true;
  flash(req, 'Запись сохранена. Спасибо, что отметили своё состояние.', 'success');
  res.redirect('/diary');
}

router.post('/diary', write, create);
// прежний адрес формы сохранён для совместимости
router.post('/mood', write, create);

router.get('/diary/:id/edit', patientPage, (req, res) => {
  const entry = ownEntry(req);
  if (!entry) return notFound(res, 'Запись не найдена.');
  res.render('patient/diary_edit', { title: 'Изменить запись', entry, form: formDefaults(entry), formError: null, todayValue: todayStr(), prefs: getPrefs(req.session.user.id) });
});

router.post('/diary/:id/edit', write, (req, res) => {
  const entry = ownEntry(req);
  if (!entry) return notFound(res, 'Запись не найдена.');
  const parsed = parseEntry(req.body);
  if (parsed.error) {
    return res.status(400).render('patient/diary_edit', {
      title: 'Изменить запись',
      entry,
      form: { ...formDefaults(entry), ...req.body },
      formError: parsed.error,
      todayValue: todayStr(),
      prefs: getPrefs(req.session.user.id),
    });
  }
  const v = parsed.value;
  db.prepare(
    "UPDATE mood_entries SET mood_score = ?, note = ?, entry_date = ?, sleep_hours = ?, anxiety = ?, triggers = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(v.mood_score, v.note, v.entry_date, v.sleep_hours, v.anxiety, v.triggers, entry.id);
  if (screenFreeText(req.session.user.id, [v.note, v.triggers].filter(Boolean).join('\n'), 'diary')) req.session.showSupport = true;
  flash(req, 'Запись обновлена.', 'success');
  res.redirect('/diary');
});

router.get('/diary/:id/delete', patientPage, (req, res) => {
  const entry = ownEntry(req);
  if (!entry) return notFound(res, 'Запись не найдена.');
  res.render('patient/diary_delete', { title: 'Удалить запись', entry, entryDate });
});

router.post('/diary/:id/delete', write, (req, res) => {
  const entry = ownEntry(req);
  if (!entry) return notFound(res, 'Запись не найдена.');
  db.prepare('DELETE FROM mood_entries WHERE id = ?').run(entry.id);
  flash(req, 'Запись удалена.', 'success');
  res.redirect('/diary');
});

// Разовая кнопка «Показать врачу эту запись» (REQ-PAT-017): работает как переключатель.
router.post('/diary/:id/share', write, (req, res) => {
  const entry = ownEntry(req);
  if (!entry) return notFound(res, 'Запись не найдена.');
  const next = entry.shared_once ? 0 : 1;
  db.prepare('UPDATE mood_entries SET shared_once = ? WHERE id = ?').run(next, entry.id);
  flash(req, next ? 'Врач сможет увидеть эту запись целиком, в том числе заметку.' : 'Запись снова видна врачу только по вашим общим настройкам.', 'success');
  res.redirect('/diary');
});

module.exports = router;
