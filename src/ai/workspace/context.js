'use strict';

/**
 * Контекст пациента для ИИ-пространства врача (REQ-AID-003, REQ-PAT-017).
 *  - ТОЛЬКО для закреплённого (care_assignments, не в архиве) пациента с активной учётной записью;
 *  - результаты шкал — только при клиническом согласии пациента (users.clinical_consent_given);
 *  - дневник — по настройкам «что видит мой врач» (user_prefs через src/patient_prefs.js — единственное место настроек REQ-PAT-017; по умолчанию оценки да, заметки нет);
 *  - диалоги пациента с ИИ сюда НЕ попадают никогда (REQ-AIP-013);
 *  - в контекст не входят ФИО, e-mail и другие идентификаторы: пациент обозначается «пациент».
 * Каждое чтение пишется вызывающим в phi_access_log (service.js).
 */

const db = require('../../db');
const { canAccessPatient } = require('../../permissions');
const { instrumentLabel } = require('../../format');
const store = require('./store');

/** Список закреплённых активных пациентов врача для выбора при создании диалога. */
function listMyPatients(clinicianId) {
  return db
    .prepare(
      `SELECT u.id, u.full_name FROM care_assignments c JOIN users u ON u.id = c.patient_id
       WHERE c.clinician_id = ? AND c.archived_at IS NULL AND u.role = 'patient' AND u.account_status = 'active'
       ORDER BY u.full_name COLLATE NOCASE`
    )
    .all(clinicianId);
}

/** @returns {{ok:boolean, patient?:object, reason?:string}} */
function access(user, patientId) {
  const pid = Number(patientId);
  if (!Number.isInteger(pid) || !canAccessPatient(user, pid, db)) return { ok: false, reason: 'not_assigned' };
  const assign = db.prepare('SELECT archived_at FROM care_assignments WHERE patient_id = ? AND clinician_id = ?').get(pid, user.id);
  if (!assign || assign.archived_at) return { ok: false, reason: 'archived' };
  const patient = db.prepare("SELECT id, full_name, account_status, clinical_consent_given FROM users WHERE id = ? AND role = 'patient'").get(pid);
  if (!patient) return { ok: false, reason: 'not_found' };
  if (patient.account_status !== 'active') return { ok: false, reason: 'inactive' };
  return { ok: true, patient };
}

/**
 * W3.K (M-6): диалог/материал, привязанный к пациенту, закрыт для врача, если у него больше нет доступа к пациенту
 * (закрепление снято/в архиве, учётная запись пациента не активна). Остаётся только удаление.
 */
function threadLocked(user, patientId) {
  return !!patientId && !access(user, patientId).ok;
}

function sharing(patientId) {
  const prefs = require('../../patient_prefs').getPrefs(patientId);
  return {
    diaryScores: !!prefs.share_diary_scores,
    diaryNotes: !!prefs.share_diary_notes,
    aiDialogs: false, // в этом модуле диалоги пациента не читаются в любом случае
  };
}

function day(s) {
  return String(s || '').slice(0, 10);
}

/**
 * @param {object} user клиницист
 * @param {number} patientId
 * @param {{periodDays?:number|null, now?:Date}} opts
 */
function build(user, patientId, opts = {}) {
  const acc = access(user, patientId);
  if (!acc.ok) return { ok: false, reason: acc.reason };
  const share = sharing(acc.patient.id);
  const now = opts.now || new Date();
  const since = opts.periodDays ? store.sqlTime(store.addDays(now, -opts.periodDays)).slice(0, 10) : null;
  const facts = { consent: !!acc.patient.clinical_consent_given, share, periodDays: opts.periodDays || null, instruments: [], diary: null, notes: [], crisis: { open: 0, last: null }, pending: [] };

  if (facts.consent) {
    const online = db.prepare('SELECT instrument, total_score, band, risk_flag, created_at AS d FROM online_results WHERE patient_id = ?').all(acc.patient.id);
    const offline = db.prepare('SELECT instrument, total_score, band, risk_flag, test_date AS d FROM offline_results WHERE patient_id = ?').all(acc.patient.id);
    const by = new Map();
    for (const r of [...online, ...offline]) {
      const arr = by.get(r.instrument) || [];
      arr.push({ date: day(r.d), score: r.total_score, band: r.band || null, risk: !!r.risk_flag });
      by.set(r.instrument, arr);
    }
    for (const [code, arr] of by) {
      arr.sort((a, b) => a.date.localeCompare(b.date));
      const inPeriod = since ? arr.filter((x) => x.date >= since) : arr;
      facts.instruments.push({ code, label: instrumentLabel(code), all: arr, points: inPeriod, last: arr[arr.length - 1] });
    }
    facts.instruments.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    facts.pending = db
      .prepare("SELECT instrument FROM instrument_assignments WHERE patient_id = ? AND status = 'pending'")
      .all(acc.patient.id)
      .map((r) => instrumentLabel(r.instrument));
  }

  if (share.diaryScores) {
    const moods = db
      .prepare('SELECT mood_score, note, created_at FROM mood_entries WHERE patient_id = ? ORDER BY created_at ASC')
      .all(acc.patient.id)
      .filter((m) => !since || day(m.created_at) >= since);
    if (moods.length) {
      const scores = moods.map((m) => m.mood_score);
      const half = Math.floor(scores.length / 2);
      const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
      facts.diary = {
        count: scores.length,
        avg: avg(scores),
        min: Math.min(...scores),
        max: Math.max(...scores),
        first: scores[0],
        last: scores[scores.length - 1],
        from: day(moods[0].created_at),
        to: day(moods[moods.length - 1].created_at),
        avgFirstHalf: half >= 2 ? avg(scores.slice(0, half)) : null,
        avgSecondHalf: half >= 2 ? avg(scores.slice(half)) : null,
      };
      if (share.diaryNotes) {
        facts.notes = moods.filter((m) => m.note && m.note.trim()).slice(-3).map((m) => ({ date: day(m.created_at), text: m.note.trim().slice(0, 160) }));
      }
    }
  }

  const esc = db.prepare("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM crisis_escalations WHERE patient_id = ? AND status = 'open'").get(acc.patient.id);
  facts.crisis = { open: esc.n, last: esc.last ? day(esc.last) : null };
  return { ok: true, facts, patient: acc.patient };
}

/** Есть ли у пациента открытая эскалация (для баннера, REQ-AID-014). */
function openCrisis(patientId) {
  return db.prepare("SELECT id, tier, created_at FROM crisis_escalations WHERE patient_id = ? AND status = 'open' ORDER BY created_at DESC").all(patientId);
}

module.exports = { threadLocked, listMyPatients, access, sharing, build, openCrisis };
