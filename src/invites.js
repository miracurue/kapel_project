'use strict';

/**
 * Коды-приглашения для привязки пациента к врачу (REQ-CLN-021, REQ-ALL-014).
 * Одноразовый случайный код (не последовательный, REQ-SEC-016), срок жизни TTL_DAYS (конфиг, по умолчанию 7).
 * Код не раскрывает ФИО врача до использования. Таблица invite_codes общая с W1.A (регистрация/«позже»):
 * W1.A вызывает redeem(code, patientId) после создания пациента.
 */

const crypto = require('crypto');
const db = require('./db');

const TTL_DAYS = Number(process.env.INVITE_TTL_DAYS || 7);
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без O/0/I/1
const DAY = 86400000;

function randomCode() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

const normalize = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.+)$/, '$1-$2');

function create(clinicianId, now = new Date()) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    try {
      db.prepare('INSERT INTO invite_codes (code, clinician_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
        code, clinicianId, now.toISOString(), new Date(now.getTime() + TTL_DAYS * DAY).toISOString()
      );
      return db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code);
    } catch (e) {
      if (!/UNIQUE/.test(String(e.message))) throw e;
    }
  }
  throw new Error('invite code collision');
}

function status(row, now = new Date()) {
  if (!row) return 'unknown';
  if (row.revoked_at) return 'revoked';
  if (row.used_by) return 'used';
  if (new Date(row.expires_at) <= now) return 'expired';
  return 'active';
}

function listForClinician(clinicianId, now = new Date()) {
  return db.prepare('SELECT * FROM invite_codes WHERE clinician_id = ? ORDER BY id DESC LIMIT 50').all(clinicianId).map((r) => ({ ...r, state: status(r, now) }));
}

function revoke(clinicianId, id, now = new Date()) {
  const row = db.prepare('SELECT * FROM invite_codes WHERE id = ? AND clinician_id = ?').get(Number(id), clinicianId);
  if (!row || status(row, now) !== 'active') return false;
  db.prepare('UPDATE invite_codes SET revoked_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  return true;
}

/** Проверка без побочных эффектов и без раскрытия врача: {valid} */
function check(code, now = new Date()) {
  return { valid: status(db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(normalize(code)), now) === 'active' };
}

/** Привязать пациента по коду. Возвращает {ok, reason?, clinicianId?}. Одноразовый. */
function redeem(code, patientId, now = new Date()) {
  const run = db.transaction(() => {
    const row = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(normalize(code));
    const st = status(row, now);
    if (st !== 'active') return { ok: false, reason: st };
    db.prepare('INSERT OR IGNORE INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(patientId, row.clinician_id);
    // повторная привязка после архива: возвращаем в основной список
    db.prepare('UPDATE care_assignments SET archived_at = NULL WHERE patient_id = ? AND clinician_id = ?').run(patientId, row.clinician_id);
    db.prepare('UPDATE invite_codes SET used_by = ?, used_at = ? WHERE id = ?').run(patientId, now.toISOString(), row.id);
    return { ok: true, clinicianId: row.clinician_id };
  });
  return run();
}

module.exports = { TTL_DAYS, create, listForClinician, revoke, check, redeem, status, normalize };
