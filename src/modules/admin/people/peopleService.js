'use strict';

/**
 * W-39: сервис «Люди и доступ» (F-88, F-89, F-90, F-91, F-92, F-93, F-94, F-95).
 * Все операции с ПДн журналируются; пациенты в списке — служебным номером.
 */

const crypto = require('crypto');

const db = require('../../../db');
const audit = require('../../../admin_audit');

const PAGE_SIZE = 50;
const S54_REASONS = ['staff_leave', 'suspicion_abuse', 'security_incident', 'other'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

// ---------- F-88: список ----------

function listPeople({ filter, q, page }) {
  const role = filter === 'patients' ? 'patient' : filter === 'staff' ? 'staff' : '';
  const search = String(q || '').slice(0, 200).trim();
  const pageNum = Math.max(1, parseInt(page, 10) || 1);

  let where = [];
  let args = [];
  if (role === 'patient') where.push("role = 'patient'");
  if (role === 'staff') where.push("role IN ('psychiatrist','psychologist','admin')");

  if (search) {
    const isEmail = search.includes('@');
    if (isEmail) {
      // Пациент ищется только по точной почте; сотрудник — по точной тоже
      // (по части почты пациент не ищется: PD-20).
      where.push('lower(email) = ?');
      args.push(search.toLowerCase());
    } else if (/^#?\d+$/.test(search) && role === 'patient') {
      where.push('id = ?');
      args.push(Number(search.replace('#', '')));
    } else {
      where.push('(lower(full_name) LIKE ? OR lower(email) LIKE ?)');
      const like = `%${search.toLowerCase()}%`;
      args.push(like, like);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT id, role, status, must_change_password, service_no FROM users ${whereSql} ORDER BY id LIMIT ? OFFSET ?`)
    .all(...args, PAGE_SIZE, (pageNum - 1) * PAGE_SIZE);
  const totalRow = db.prepare(`SELECT COUNT(*) n FROM users ${whereSql}`).get(...args);

  const items = rows.map((u) => ({
    id: u.id,
    role: u.role,
    status: u.status,
    must_change_password: !!u.must_change_password,
    // Пациент — служебным номером, БЕЗ ФИО и почты (F-88, PD-20).
    label: u.role === 'patient' ? (u.service_no || `№${u.id}`) : null,
    name: null,
    email: null,
  }));

  return { items, page: pageNum, page_size: PAGE_SIZE, total: totalRow.n };
}

// ---------- F-88: карточка ----------

function getPerson(id) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return null;
  return {
    id: u.id,
    role: u.role,
    status: u.status,
    status_reason: u.status_reason,
    must_change_password: !!u.must_change_password,
    service_no: u.service_no,
    created_at: u.created_at,
    // ФИО и почта скрыты до «Показать» (F-88).
    name: u.role === 'patient' ? null : u.full_name,
    email: u.role === 'patient' ? null : u.email,
    label: u.role === 'patient' ? (u.service_no || `№${u.id}`) : u.full_name,
  };
}

// ---------- F-88: «Показать» ФИО/почты ----------

function revealContacts(adminId, id) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return null;
  db.prepare(
    "INSERT INTO phi_access_log (actor_id, actor_role, patient_id, section, action, decision, basis) VALUES (?, 'admin', ?, 'account', 'view', 'allow', 'admin_service')",
  ).run(adminId, u.id);
  audit.log(adminId, 'account_reveal', u.id, { section: 'account' });
  return { id: u.id, name: u.full_name, email: u.email };
}

module.exports = {
  PAGE_SIZE, S54_REASONS, EMAIL_RE, sha256,
  listPeople, getPerson, revealContacts,
};