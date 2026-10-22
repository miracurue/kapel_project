'use strict';

/**
 * Read-only контур научного экспорта (сравнение офлайн/онлайн тестирования).
 * Реализует требования RES-3 документ "anonymization-requirements":
 *  - псевдонимизация patient_id (отдельная таблица сопоставления, своим TTL);
 *  - только структурированные баллы/метаданные, никакого свободного текста;
 *  - строится по comparison_pairs (REQ-TLS-004), заглушки каталога исключены;
 *  - только пациенты с действующим (не отозванным) согласием на экспорт;
 *  - дата округлена до недели, а не точный timestamp;
 *  - каждый запуск журналируется (кто, когда, фильтр, число строк).
 *
 * Этот модуль НИКОГДА не должен обращаться к mood_entries, chatbot_messages,
 * reminders или полям notes/reasons_json/clinician_note — см. SPECIAL_CATEGORY_TABLES в db.js.
 */

const crypto = require('crypto');
const db = require('./db');
const catalog = require('./instruments_catalog');

const DEFAULT_SALT = 'tdr-mvp-research-salt-change-in-prod';
const PSEUDONYM_SALT = process.env.RESEARCH_PSEUDONYM_SALT || DEFAULT_SALT;
// REQ-SEC-003 (W3.K): в production со встроенной солью экспорт не запускается
if (process.env.NODE_ENV === 'production' && PSEUDONYM_SALT === DEFAULT_SALT) {
  throw new Error('RESEARCH_PSEUDONYM_SALT обязателен при NODE_ENV=production (соль по умолчанию запрещена).');
}
const PSEUDONYM_TTL_DAYS = Number(process.env.RESEARCH_PSEUDONYM_TTL_DAYS || 180);

function isoWeekStart(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const day = (d.getUTCDay() + 6) % 7; // понедельник = 0
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function newPseudonym(patientId) {
  // HMAC с солью как ключом: без соли псевдоним не воспроизвести; случайный nonce делает его неподбираемым по patient_id
  return crypto.createHmac('sha256', PSEUDONYM_SALT).update(`${patientId}:${crypto.randomUUID()}`).digest('hex').slice(0, 24);
}

/**
 * W3.K (M-3): TTL псевдонима исполняется. Просроченная запись заменяется НОВЫМ псевдонимом (ротация),
 * поэтому выгрузки, разделённые сроком больше PSEUDONYM_TTL_DAYS, между собой не связываются.
 */
function getOrCreatePseudonym(patientId) {
  const existing = db.prepare('SELECT pseudonym, expires_at FROM research_pseudonyms WHERE patient_id = ?').get(patientId);
  const expiresAt = new Date(Date.now() + PSEUDONYM_TTL_DAYS * 86400000).toISOString();
  if (existing) {
    if (!existing.expires_at || Date.parse(existing.expires_at) > Date.now()) return existing.pseudonym;
    const rotated = newPseudonym(patientId);
    db.prepare('UPDATE research_pseudonyms SET pseudonym = ?, expires_at = ? WHERE patient_id = ?').run(rotated, expiresAt, patientId);
    return rotated;
  }
  const pseudonym = newPseudonym(patientId);
  db.prepare('INSERT INTO research_pseudonyms (patient_id, pseudonym, expires_at) VALUES (?, ?, ?)').run(patientId, pseudonym, expiresAt);
  return pseudonym;
}

/** Удаляет просроченные сопоставления patient_id ↔ псевдоним (вызывается при каждом экспорте). Возвращает число удалённых. */
function purgeExpiredPseudonyms() {
  return db.prepare('DELETE FROM research_pseudonyms WHERE expires_at IS NOT NULL AND expires_at <= ?').run(new Date().toISOString()).changes;
}

/**
 * REQ-TLS-004: построчный датасет читает comparison_pairs (методологически точное сопоставление
 * офлайн/онлайн, в т.ч. cross-instrument PHQ-9 <-> BDI-II), только для пациентов с действующим
 * согласием на научный экспорт; заглушки каталога исключены; свободный текст (clinician_note и пр.)
 * не читается. Каждый запуск журналируется. runBy — id пользователя, запустившего экспорт.
 */
function generateComparisonExport({ runBy, clinicianId } = {}) {
  purgeExpiredPseudonyms();
  const consentFilter = "anonymized_export_opt_in = 1 AND export_consent_revoked_at IS NULL AND account_status = 'active'";

  const eligiblePatients = db.prepare(`SELECT id FROM users WHERE ${consentFilter}`).all();
  let eligibleIds = new Set(eligiblePatients.map((p) => p.id));
  // OQ-14b: клиницист получает только строки своих пациентов (закреплённых за ним); без clinicianId — вся когорта (служебные вызовы/тесты)
  if (clinicianId !== undefined && clinicianId !== null) {
    const own = new Set(db.prepare('SELECT patient_id FROM care_assignments WHERE clinician_id = ?').all(clinicianId).map((r) => r.patient_id));
    eligibleIds = new Set([...eligibleIds].filter((id) => own.has(id)));
  }

  // Только структурированные поля пары и два балла; clinician_note, answers_json, notes не выбираются.
  const pairs = db
    .prepare(
      `SELECT cp.patient_id, cp.online_scale, cp.offline_scale, cp.comparability, cp.time_delta_days,
              cp.discrepancy_raw, cp.discrepancy_item9,
              o.total_score AS online_score, o.created_at AS online_at,
              f.total_score AS offline_score, f.test_date AS offline_at
       FROM comparison_pairs cp
       JOIN online_results o ON o.id = cp.online_result_id
       JOIN offline_results f ON f.id = cp.offline_result_id
       WHERE f.invalid_at IS NULL
       ORDER BY cp.patient_id, cp.id`
    )
    .all();

  const rows = pairs
    .filter((r) => eligibleIds.has(r.patient_id) && !catalog.isStub(r.online_scale) && !catalog.isStub(r.offline_scale))
    .map((r) => ({
      patient_pseudonym: getOrCreatePseudonym(r.patient_id),
      online_scale: r.online_scale,
      offline_scale: r.offline_scale,
      comparability: r.comparability,
      time_delta_days: r.time_delta_days === null || r.time_delta_days === undefined ? null : Math.round(r.time_delta_days * 10) / 10,
      online_score: r.online_score ?? null,
      offline_score: r.offline_score ?? null,
      discrepancy_raw: r.discrepancy_raw ?? null,
      discrepancy_item9: r.discrepancy_item9 ?? null,
      online_week: r.online_at ? isoWeekStart(r.online_at) : null,
      offline_week: r.offline_at ? isoWeekStart(r.offline_at) : null,
    }));

  db.prepare('INSERT INTO export_audit_log (run_by, consent_filter, row_count) VALUES (?, ?, ?)').run(
    runBy ?? null,
    consentFilter + (clinicianId !== undefined && clinicianId !== null ? ` AND только пациенты врача #${clinicianId}` : ''),
    rows.length
  );

  return rows;
}

const CSV_COLUMNS = [
  'patient_pseudonym', 'online_scale', 'offline_scale', 'comparability', 'time_delta_days',
  'online_score', 'offline_score', 'discrepancy_raw', 'discrepancy_item9', 'online_week', 'offline_week',
];

/** Защита от CSV-инъекций: строка, начинающаяся с = + - @ (или управляющего символа), получает префикс '. Числа не трогаем. */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[;"\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Разделитель «;» и BOM — для Excel (русская локаль). */
function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(';')];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(';'));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = { generateComparisonExport, toCsv, csvCell, CSV_COLUMNS, isoWeekStart, getOrCreatePseudonym, purgeExpiredPseudonyms, PSEUDONYM_TTL_DAYS, DEFAULT_SALT };
