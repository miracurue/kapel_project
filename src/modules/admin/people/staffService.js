'use strict';

/**
 * W-39: сервис операций с сотрудниками и доступом (F-89…F-92).
 * Опирается на каркас src/admin_core.js (createStaff, resetPassword, блокировка).
 * Журналирование — src/admin_audit.js, доступ — src/access.
 */

const crypto = require('crypto');

const db = require('../../../db');
const platform = require('../../../platform');
const core = require('../../../admin_core');
const audit = require('../../../admin_audit');

const P = platform;

const S54_REASONS = ['staff_leave', 'suspicion_abuse', 'security_incident', 'other'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const VERIFICATION_MODES = ['in_person_document', 'org_card_phone', 'other'];

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

// ---------- F-89: новый сотрудник ----------

function createStaff(adminId, body) {
  const { full_name, email, role } = body || {};
  const mail = String(email || '').trim().toLowerCase();
  if (!core.STAFF_ROLES.includes(role)) return { ok: false, status: 422, code: 'E-VALIDATION' };
  if (!String(full_name || '').trim() || !EMAIL_RE.test(mail)) return { ok: false, status: 422, code: 'E-VALIDATION' };
  if (db.prepare('SELECT 1 FROM users WHERE lower(email) = ?').get(mail)) {
    return { ok: false, status: 409, code: 'E-EMAIL-TAKEN' };
  }
  const created = core.createStaff(adminId, { full_name: String(full_name).trim(), email: mail, role });
  if (!created.ok) return { ok: false, status: 409, code: 'E-EMAIL-TAKEN' };
  const undoId = db
    .prepare('INSERT INTO undo_records (kind, actor_id, payload_json) VALUES (?, ?, ?)')
    .run('staff_deactivate', adminId, JSON.stringify({ user_id: created.id })).lastInsertRowid;
  return {
    ok: true,
    user: { id: created.id, email: mail, role, full_name: String(full_name).trim() },
    temporary_password: created.tempPassword,
    undo: { id: undoId },
  };
}

// ---------- F-90: сброс пароля ----------

function resetPassword(adminId, id) {
  const target = core.getUser(id);
  if (!target) return { ok: false, status: 404, code: 'E-NOT-FOUND' };
  const r = core.resetPassword(adminId, id);
  if (!r.ok) return { ok: false, status: 422, code: 'E-VALIDATION' };
  return { ok: true, temporary_password: r.tempPassword };
}

// ---------- F-90: смена почты ----------

function changeEmail(adminId, id, body) {
  const { email, verification, verification_comment } = body || {};
  const target = core.getUser(id);
  if (!target) return { ok: false, status: 404, code: 'E-NOT-FOUND' };
  if (!VERIFICATION_MODES.includes(verification)) return { ok: false, status: 422, code: 'E-VALIDATION' };
  if (verification === 'other' && !String(verification_comment || '').trim()) {
    return { ok: false, status: 422, code: 'E-VALIDATION' };
  }
  const mail = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(mail)) return { ok: false, status: 422, code: 'E-VALIDATION' };
  if (db.prepare('SELECT 1 FROM users WHERE lower(email) = ? AND id != ?').get(mail, target.id)) {
    return { ok: false, status: 409, code: 'E-EMAIL-TAKEN' };
  }
  const oldHash = sha256(target.email);
  const newHash = sha256(mail);
  db.prepare('UPDATE users SET email = ?, email_hmac = ? WHERE id = ?').run(mail, platform.hmac(mail), id);
  core.logAdmin(adminId, 'user_email', id, { verification, old_safe_json: JSON.stringify({ email: oldHash }), new_safe_json: JSON.stringify({ email: newHash }) });
  return { ok: true };
}

module.exports = {
  S54_REASONS, EMAIL_RE, VERIFICATION_MODES, sha256,
  createStaff, resetPassword, changeEmail,
};