'use strict';

// План приёма и журнал приёма (REQ-PAT-023, REQ-CLN-014). Названия и «как принимать» — свободный текст:
// базы препаратов, проверок доз и взаимодействий нет и не должно быть. Психолог план не ведёт (permissions).

const db = require('../db');
const cfg = require('./config');

const pad = (n) => String(n).padStart(2, '0');
const dayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nowIso = () => new Date().toISOString();

function slotsOf(item) {
  if (item.slot === 'morning') return ['morning'];
  if (item.slot === 'evening') return ['evening'];
  if (item.slot === 'both') return ['morning', 'evening'];
  return ['any'];
}

function clean(s, max) {
  return String(s || '').replace(/[\r\t]+/g, ' ').trim().slice(0, max);
}

function parseItem(body) {
  const name = clean(body.name, cfg.NAME_MAX);
  if (!name) return { error: 'Укажите название. Можно своими словами.' };
  const slot = ['morning', 'evening', 'both', 'none'].includes(body.slot) ? body.slot : 'none';
  return { name, how_text: clean(body.how_text, cfg.HOW_MAX) || null, slot };
}

// ---------- пациент ----------

/** Видимые пациенту пункты: опубликованный план врача + свой список; без завершённых. */
function itemsForPatient(patientId) {
  return db
    .prepare(
      `SELECT m.*, u.full_name AS author FROM med_items m LEFT JOIN users u ON u.id = m.author_id
       WHERE m.patient_id = ? AND m.ended_at IS NULL AND (m.source = 'patient' OR m.published_at IS NOT NULL)
       ORDER BY m.source DESC, m.id`
    )
    .all(patientId);
}

function addOwn(patientId, body) {
  const f = parseItem(body);
  if (f.error) return f;
  const info = db
    .prepare("INSERT INTO med_items (patient_id, source, author_id, name, how_text, slot, published_at) VALUES (?, 'patient', ?, ?, ?, ?, ?)")
    .run(patientId, patientId, f.name, f.how_text, f.slot, nowIso());
  return { id: info.lastInsertRowid };
}

function endOwn(patientId, itemId) {
  return db.prepare("UPDATE med_items SET ended_at = ? WHERE id = ? AND patient_id = ? AND source = 'patient' AND ended_at IS NULL").run(nowIso(), itemId, patientId).changes === 1;
}

function ack(patientId, itemId) {
  return db.prepare("UPDATE med_items SET ack_at = ? WHERE id = ? AND patient_id = ? AND source = 'clinician' AND published_at IS NOT NULL AND ended_at IS NULL").run(nowIso(), itemId, patientId).changes === 1;
}

/** Отметка приёма. Только по видимому пациенту пункту; слот должен соответствовать пункту. */
function logIntake({ patientId, itemId, slot, status, day }) {
  if (!['taken', 'skipped', 'later'].includes(status)) return { error: 'bad_status' };
  const item = itemsForPatient(patientId).find((m) => m.id === Number(itemId));
  if (!item) return { error: 'not_found' };
  const slots = slotsOf(item);
  const sl = slots.includes(slot) ? slot : slots.length === 1 ? slots[0] : null;
  if (!sl) return { error: 'bad_slot' };
  const d = /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? day : dayStr();
  db.prepare(
    `INSERT INTO med_log (patient_id, item_id, day, slot, status, logged_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id, day, slot) DO UPDATE SET status = excluded.status, logged_at = excluded.logged_at`
  ).run(patientId, item.id, d, sl, status, nowIso());
  return { ok: true };
}

/** Состояние на день: [{item, slot, status|null}]. */
function dayState(patientId, day = dayStr()) {
  const logs = db.prepare('SELECT item_id, slot, status FROM med_log WHERE patient_id = ? AND day = ?').all(patientId, day);
  const out = [];
  for (const item of itemsForPatient(patientId)) {
    for (const slot of slotsOf(item)) {
      const l = logs.find((x) => x.item_id === item.id && x.slot === slot);
      out.push({ item, slot, status: l ? l.status : null });
    }
  }
  return out;
}

/** Утро/вечер на главной: слот, время которого наступило и на который нет отметки «принял/пропустил». */
function dueSlots(patientId, now = new Date()) {
  const h = now.getHours();
  return dayState(patientId, dayStr(now)).filter((s) => {
    if (s.slot === 'any') return false;
    if (s.status === 'taken' || s.status === 'skipped') return false;
    return h >= cfg.SLOT_FROM_HOUR[s.slot];
  });
}

// ---------- врач (психиатр) ----------

function planForClinician(patientId) {
  return db
    .prepare("SELECT m.*, u.full_name AS author FROM med_items m JOIN users u ON u.id = m.author_id WHERE m.patient_id = ? AND m.source = 'clinician' ORDER BY (m.ended_at IS NOT NULL), m.id DESC")
    .all(patientId);
}

function addPlan(patientId, authorId, body) {
  const f = parseItem(body);
  if (f.error) return f;
  const info = db.prepare("INSERT INTO med_items (patient_id, source, author_id, name, how_text, slot) VALUES (?, 'clinician', ?, ?, ?, ?)").run(patientId, authorId, f.name, f.how_text, f.slot);
  return { id: info.lastInsertRowid };
}

function planItem(patientId, itemId) {
  return db.prepare("SELECT * FROM med_items WHERE id = ? AND patient_id = ? AND source = 'clinician'").get(itemId, patientId);
}

function editPlan(patientId, itemId, body) {
  const f = parseItem(body);
  if (f.error) return f;
  // изменение опубликованного пункта сбрасывает «понял»: пациент должен увидеть новый текст
  const r = db.prepare("UPDATE med_items SET name = ?, how_text = ?, slot = ?, ack_at = NULL, updated_at = ? WHERE id = ? AND patient_id = ? AND source = 'clinician' AND ended_at IS NULL").run(f.name, f.how_text, f.slot, nowIso(), itemId, patientId);
  return r.changes === 1 ? { ok: true } : { error: 'Пункт не найден или уже завершён.' };
}

function setPublished(patientId, itemId, on) {
  return db.prepare("UPDATE med_items SET published_at = ?, ack_at = NULL WHERE id = ? AND patient_id = ? AND source = 'clinician' AND ended_at IS NULL").run(on ? nowIso() : null, itemId, patientId).changes === 1;
}

function endPlan(patientId, itemId) {
  return db.prepare("UPDATE med_items SET ended_at = ? WHERE id = ? AND patient_id = ? AND source = 'clinician' AND ended_at IS NULL").run(nowIso(), itemId, patientId).changes === 1;
}

function deletePlan(patientId, itemId) {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM med_log WHERE item_id IN (SELECT id FROM med_items WHERE id = ? AND patient_id = ? AND source = 'clinician')").run(itemId, patientId);
    return db.prepare("DELETE FROM med_items WHERE id = ? AND patient_id = ? AND source = 'clinician'").run(itemId, patientId).changes === 1;
  });
  return tx();
}

/**
 * Приверженность по плану врача за N дней (без сегодняшнего). Считаются только опубликованные пункты с
 * расписанием «утро/вечер», начиная со дня после публикации. Это отметки пациента, не контроль.
 * opts.own — включить личный список пациента (только если пациент разрешил).
 */
function adherence(patientId, { days = cfg.ADHERENCE_WINDOW_DAYS, now = new Date(), own = false } = {}) {
  const items = db
    .prepare(`SELECT * FROM med_items WHERE patient_id = ? AND ended_at IS NULL AND slot != 'none' AND ${own ? "(source = 'patient' OR published_at IS NOT NULL)" : "(source = 'clinician' AND published_at IS NOT NULL)"}`)
    .all(patientId);
  const logs = db.prepare('SELECT item_id, day, slot, status FROM med_log WHERE patient_id = ?').all(patientId);
  const res = { days, expected: 0, taken: 0, skipped: 0, later: 0, unlogged: 0, ratio: null, items: items.length };
  for (let i = 1; i <= days; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const ds = dayStr(d);
    for (const it of items) {
      const startDay = dayStr(new Date(it.published_at));
      if (ds <= startDay) continue;
      for (const slot of slotsOf(it)) {
        res.expected += 1;
        const l = logs.find((x) => x.item_id === it.id && x.day === ds && x.slot === slot);
        if (!l) res.unlogged += 1;
        else res[l.status] += 1;
      }
    }
  }
  res.ratio = res.expected ? res.taken / res.expected : null;
  return res;
}

function lastLogged(patientId) {
  const r = db.prepare('SELECT MAX(logged_at) AS t FROM med_log WHERE patient_id = ?').get(patientId);
  return r ? r.t : null;
}

/** Что врач вправе видеть о приёме: учитывает клиническое согласие и настройки пациента. */
function clinicianView(patientId, consentOk) {
  const prefs = require('../patient_prefs').getPrefs(patientId);
  const base = { consentOk, sharesLog: !!prefs.share_med_log, sharesOwn: !!prefs.share_med_own, adherence: null, own: [] };
  if (!consentOk) return base;
  if (base.sharesLog) base.adherence = adherence(patientId, { own: base.sharesOwn });
  if (base.sharesOwn) base.own = db.prepare("SELECT * FROM med_items WHERE patient_id = ? AND source = 'patient' AND ended_at IS NULL ORDER BY id").all(patientId);
  return base;
}

module.exports = {
  dayStr, slotsOf, parseItem, itemsForPatient, addOwn, endOwn, ack, logIntake, dayState, dueSlots,
  planForClinician, addPlan, planItem, editPlan, setPublished, endPlan, deletePlan, adherence, lastLogged, clinicianView,
};
