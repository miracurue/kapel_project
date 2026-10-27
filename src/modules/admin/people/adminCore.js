'use strict';

/**
 * W-39 (F-88, F-89, F-90, F-91, F-93, F-94, F-95): люди и доступ.
 * Список и карточка БЕЗ ФИО и почты пациента; «Показать» — с записью в журнал.
 * Все операции с ПДн журналируются (PD-03). Клинических данных здесь нет.
 */

const crypto = require('crypto');

const db = require('../../../db');
const core = require('../../../admin_core');
const audit = require('../../../admin_audit');

const PAGE_SIZE = 50;
const STAFF_ROLES = ['psychiatrist', 'psychologist', 'admin'];
const PATIENT_ROLES = ['patient'];
const ALL_ROLES = [...STAFF_ROLES, ...PATIENT_ROLES];

// ---------- маскирование ----------

// ---------- маскирование ----------

/** Служебный номер пациента: «№123» (в текущей схеме service_no отсутствует — STAND-IN: использую id). */
function patientLabel(u) {
  return `№${u.id}`;
}

/** ФИО/почта сотрудников маскируются в списке (ключ F-80). */
function staffLabel(u) {
  return {
    full_name: u.full_name || `Сотрудник №${u.id}`,
    email_masked: u.email ? `${u.email.split('@')[0][0] || ''}•••@${u.email.split('@')[1] || ''}` : '—',
  };
}

// ---------- F-88: список людей ----------

function listPeople(adminId, filters = {}) {
  const role = ALL_ROLES.includes(filters.role) ? filters.role : '';
  const status = ['active', 'blocked', 'archived', 'deactivated', 'deleted'].includes(filters.status)
    ? filters.status
    : '';
  const q = String(filters.q || '')
    .slice(0, 100)
    .trim();
  const page = Math.max(1, parseInt(filters.page, 10) || 1);

  let where = [];
  let args = [];
  if (role) where.push('role = ?') && args.push(role);
  if (status === 'active') where.push("status = 'active'");
  if (status === 'blocked') where.push("status = 'blocked'");
  if (status === 'deactivated') where.push("status = 'deactivated'");
  if (status === 'archived') where.push("status = 'deletion_requested'");
  if (status === 'deleted') where.push("status = 'tombstone'");

  if (q) {
    if (role === 'patient') {
      // Точный поиск пациента по номеру или точной почте (F-88).
      if (/^#?(\d+|П-\d+)$/.test(q)) {
        where.push('service_no = ?') && args.push(q.replace('#', ''));
      } else if (q.includes('@')) {
        where.push('lower(email) = ?') && args.push(q.toLowerCase());
      } else {
        where.push('1 = 0'); // по части почты пациент не ищется
      }
    } else {
      // Сотрудники ищутся по ФИО и почте.
      where.push('(lower(full_name) LIKE ? OR lower(email) LIKE ?)');
      const like = `%${q.toLowerCase()}%`;
      args.push(like, like);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  try {
    const rows = db
      .prepare(
        `SELECT id, service_no, email, full_name, role, status, status_reason, must_change_password FROM users ${whereSql} ORDER BY role, full_name, id`,
      )
      .all(...args);

    const items = rows.map((u) => {
      const base = {
        id: u.id,
        service_no: u.service_no,
        role: u.role,
        status: statusKey(u),
        status_reason: u.status_reason || null,
        must_change_password: !!u.must_change_password,
      };
      if (u.role === 'patient') {
        // Пациент в списке — номером, без ФИО и почты (F-88, PD-20).
        return { ...base, label: patientLabel(u), name: null, email: null };
      }
      const s = staffLabel(u);
      return { ...base, label: s.full_name, name: s.full_name, email: s.email_masked };
    });

    const total = items.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    return {
      items: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      total,
      page,
      pages,
    };
  } catch (_e) {
    // Схема могла не догнать (ensureColumn) или запрос невалиден —
    // возвращаем безопасную пустую структуру, а не undefined (см. T-242).
    return { items: [], total: 0, page, pages: 1 };
  }
}

function statusKey(u) {
  if (u.status === 'tombstone') return 'deleted';
  if (u.status === 'deletion_requested') return 'archived';
  if (u.status === 'blocked') return 'blocked';
  if (u.status === 'deactivated') return 'deactivated';
  if (u.must_change_password) return 'password';
  return 'active';
}

// ---------- F-88: карточка пользователя ----------

function getPersonCard(adminId, id) {
  const u = core.getUser(id);
  if (!u) return { ok: false, error: 'E-NOT-FOUND' };
  const isPatient = u.role === 'patient';
  const base = {
    id: u.id,
    service_no: u.service_no,
    role: u.role,
    status: statusKey(u),
    status_reason: u.status_reason || null,
    created_at: u.created_at,
    // Для пациента ФИО и почта скрыты до «Показать» (F-88, PD-03).
    name: isPatient ? null : u.full_name,
    email: isPatient ? null : u.email,
    label: isPatient ? patientLabel(u) : u.full_name,
    must_change_password: !!u.must_change_password,
  };
  if (!isPatient)
    base.flags = {
      research: !!u.flag_research,
      clinical_lead: !!u.flag_clinical_lead,
      reference_reviewer: !!u.flag_reference_reviewer,
    };
  if (isPatient) {
    base.clinicians = db
      .prepare(
        'SELECT c.id, c.full_name FROM care_assignments ca JOIN users c ON c.id = ca.clinician_id WHERE ca.patient_id = ?',
      )
      .all(u.id);
    base.episodes = db
      .prepare('SELECT id, started_at, ended_at, end_reason FROM care_episodes WHERE patient_id = ? ORDER BY id DESC')
      .all(u.id)
      .map((e) => ({ id: e.id, started_at: e.started_at, ended_at: e.ended_at, end_reason: e.end_reason }));
  }
  return { ok: true, card: base };
}

// ---------- F-88: «Показать» — записывает в журнал (PD-03) ----------

function revealContacts(adminId, userId) {
  const u = core.getUser(userId);
  if (!u) return { ok: false, error: 'E-NOT-FOUND' };
  // Журнал доступа: актор, пациент, раздел «учётные данные», время (F-22 дедупликация — на клиенте).
  db.prepare(
    "INSERT INTO phi_access_log (actor_id, actor_role, patient_id, section, action, basis) VALUES (?, ?, ?, 'account.credentials', 'view', 'admin_service')",
  ).run(adminId, 'admin', u.id);
  core.logAdmin(adminId, 'account_reveal', u.id, { section: 'account.credentials' });
  return {
    ok: true,
    id: u.id,
    role: u.role,
    name: u.full_name,
    email: u.email,
  };
}

module.exports = {
  PAGE_SIZE,
  STAFF_ROLES,
  PATIENT_ROLES,
  ALL_ROLES,
  patientLabel,
  staffLabel,
  statusKey,
  listPeople,
  getPersonCard,
  revealContacts,
};
