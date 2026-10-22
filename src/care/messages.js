'use strict';

// Асинхронные сообщения врач <-> пациент (REQ-MSG-001..004). Тред = (пациент, клиницист).
// Это НЕ кризисный канал: кнопка «Мне плохо» остаётся отдельной; текст пациента проходит crisisGate (в маршруте).
// Текст видят только участники: админского чтения нет.

const db = require('../db');
const cfg = require('./config');
const assignments = require('../assignments');

const nowIso = () => new Date().toISOString();

function settings(clinicianId) {
  return db.prepare('SELECT * FROM care_clinician_settings WHERE clinician_id = ?').get(clinicianId) || { clinician_id: clinicianId, reply_note: null, away_until: null };
}

function awayNow(clinicianId, now = new Date()) {
  const s = settings(clinicianId);
  return s.away_until && s.away_until >= now.toISOString().slice(0, 10) ? s.away_until : null;
}

function saveSettings(clinicianId, { reply_note, away_until }) {
  const note = String(reply_note || '').trim().slice(0, cfg.REPLY_NOTE_MAX) || null;
  const away = /^\d{4}-\d{2}-\d{2}$/.test(away_until || '') ? away_until : null;
  db.prepare(
    `INSERT INTO care_clinician_settings (clinician_id, reply_note, away_until) VALUES (?, ?, ?)
     ON CONFLICT(clinician_id) DO UPDATE SET reply_note = excluded.reply_note, away_until = excluded.away_until`
  ).run(clinicianId, note, away);
}

/** Врачи пациента с признаками доступности (для выбора адресата). */
function recipients(patientId, now = new Date()) {
  return db
    .prepare(
      `SELECT ca.clinician_id AS id, u.full_name, u.role FROM care_assignments ca JOIN users u ON u.id = ca.clinician_id
       WHERE ca.patient_id = ? AND u.deactivated_at IS NULL AND ca.archived_at IS NULL ORDER BY ca.id`
    )
    .all(patientId)
    .map((r) => ({ ...r, away: awayNow(r.id, now), replyNote: settings(r.id).reply_note }));
}

/** MSG-004: можно ли отправить; иначе причина и путь. */
function canSend(patientId, clinicianId, now = new Date()) {
  const list = recipients(patientId, now);
  if (!list.length) return { ok: false, code: 'no_clinician' };
  const r = list.find((x) => x.id === Number(clinicianId));
  if (!r) return { ok: false, code: 'not_linked' };
  if (!assignments.consentState(patientId).ok) return { ok: false, code: 'no_consent' };
  if (r.away) return { ok: false, code: 'away', until: r.away };
  return { ok: true, recipient: r };
}

const REASONS = {
  no_clinician: 'Вы пока не привязаны к врачу, поэтому написать некому. Введите код от врача на главной или воспользуйтесь ИИ-помощником. Если вам плохо сейчас — «Мне плохо» или 112.',
  not_linked: 'Этот врач не закреплён за вами.',
  no_consent: 'Сообщения врачу доступны при действующем согласии на передачу данных врачу. Его можно оформить в разделе «Приватность».',
};
function reasonText(c) {
  if (c.code === 'away') return `Врач недоступен до ${c.until.split('-').reverse().join('.')}: сообщение сейчас не будет прочитано. Можно написать другому врачу (если он у вас есть), открыть ИИ-помощника или, если плохо прямо сейчас, нажать «Мне плохо» либо позвонить 112.`;
  return REASONS[c.code] || 'Сообщение не отправлено.';
}

function patientSend(patientId, clinicianId, body) {
  const text = String(body || '').trim().slice(0, cfg.MESSAGE_MAX);
  if (!text) return { error: 'Сообщение пустое.' };
  const c = canSend(patientId, clinicianId);
  if (!c.ok) return { error: reasonText(c), code: c.code };
  const info = db.prepare("INSERT INTO care_messages (patient_id, clinician_id, sender_role, body, created_at) VALUES (?, ?, 'patient', ?, ?)").run(patientId, Number(clinicianId), text, nowIso());
  return { id: info.lastInsertRowid, text };
}

function clinicianSend(clinicianId, patientId, body) {
  const text = String(body || '').trim().slice(0, cfg.MESSAGE_MAX);
  if (!text) return { error: 'Сообщение пустое.' };
  if (!assignments.consentState(patientId).ok) return { error: 'Без действующего согласия пациента писать ему нельзя.' };
  const t = nowIso();
  const tx = db.transaction(() => {
    const info = db.prepare("INSERT INTO care_messages (patient_id, clinician_id, sender_role, body, created_at) VALUES (?, ?, 'clinician', ?, ?)").run(patientId, clinicianId, text, t);
    // ответ закрывает входящие как обработанные
    db.prepare("UPDATE care_messages SET handled_at = ? WHERE patient_id = ? AND clinician_id = ? AND sender_role = 'patient' AND handled_at IS NULL").run(t, patientId, clinicianId);
    return info.lastInsertRowid;
  });
  return { id: tx() };
}

function thread(patientId, clinicianId) {
  return db.prepare('SELECT * FROM care_messages WHERE patient_id = ? AND clinician_id = ? ORDER BY id').all(patientId, clinicianId);
}

/** Открыл тред читатель: другая сторона видит «прочитано». viewer: 'patient' | 'clinician'. */
function markRead(viewer, patientId, clinicianId) {
  const from = viewer === 'patient' ? 'clinician' : 'patient';
  db.prepare('UPDATE care_messages SET read_at = ? WHERE patient_id = ? AND clinician_id = ? AND sender_role = ? AND read_at IS NULL').run(nowIso(), patientId, clinicianId, from);
}

function markHandled(clinicianId, patientId) {
  return db.prepare("UPDATE care_messages SET handled_at = ? WHERE patient_id = ? AND clinician_id = ? AND sender_role = 'patient' AND handled_at IS NULL").run(nowIso(), patientId, clinicianId).changes;
}

function unreadForPatient(patientId) {
  return db.prepare("SELECT COUNT(*) AS n FROM care_messages WHERE patient_id = ? AND sender_role = 'clinician' AND read_at IS NULL").get(patientId).n;
}

function unreadForClinician(clinicianId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM care_messages m JOIN users u ON u.id = m.patient_id
       WHERE m.clinician_id = ? AND m.sender_role = 'patient' AND m.read_at IS NULL AND u.clinical_consent_given = 1 AND u.account_status = 'active'`
    )
    .get(clinicianId).n;
}

/** Входящие врача: по пациентам, у кого есть сообщения; требуется закрепление и действующее согласие. */
function inbox(clinicianId) {
  const rows = db
    .prepare(
      `SELECT m.patient_id, u.full_name,
              SUM(CASE WHEN m.sender_role = 'patient' AND m.read_at IS NULL THEN 1 ELSE 0 END) AS unread,
              SUM(CASE WHEN m.sender_role = 'patient' AND m.handled_at IS NULL THEN 1 ELSE 0 END) AS open_n,
              MAX(m.id) AS last_id
       FROM care_messages m
       JOIN users u ON u.id = m.patient_id
       JOIN care_assignments ca ON ca.patient_id = m.patient_id AND ca.clinician_id = m.clinician_id
       WHERE m.clinician_id = ? AND u.clinical_consent_given = 1 AND u.account_status = 'active'
       GROUP BY m.patient_id ORDER BY unread DESC, open_n DESC, last_id DESC`
    )
    .all(clinicianId);
  return rows.map((r) => {
    const last = db.prepare('SELECT sender_role, body, created_at FROM care_messages WHERE id = ?').get(r.last_id);
    return { ...r, last };
  });
}

module.exports = { settings, awayNow, saveSettings, recipients, canSend, reasonText, patientSend, clinicianSend, thread, markRead, markHandled, unreadForPatient, unreadForClinician, inbox };
