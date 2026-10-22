'use strict';

/**
 * Служебное ядро кабинета администратора (W1.D): журнал действий админа, пароли,
 * пользователи (создание, сброс пароля, деактивация), клиницисты и привязки.
 * Клинического содержимого здесь нет и быть не должно (REQ-ADM-007).
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

const STAFF_ROLES = ['psychiatrist', 'psychologist', 'admin'];
const ROLE_LABELS = { patient: 'пациент', psychiatrist: 'психиатр', psychologist: 'психолог', admin: 'администратор' };
const PASSWORD_MIN = 8; // REQ-SEC-012

// ---------- журнал действий администратора (только INSERT) ----------

/** Убирает из detail всё похожее на пароль/хэш — в журнал они не попадают никогда. */
function scrub(detail) {
  if (!detail || typeof detail !== 'object') return detail ?? null;
  const out = Array.isArray(detail) ? [] : {};
  for (const [k, v] of Object.entries(detail)) {
    if (/pass|pwd|hash|secret|token/i.test(k)) continue;
    out[k] = v && typeof v === 'object' ? scrub(v) : v;
  }
  return out;
}

function logAdmin(adminId, action, targetUserId = null, detail = null) {
  db.prepare('INSERT INTO admin_action_log (admin_id, action, target_user_id, detail_json) VALUES (?, ?, ?, ?)').run(
    adminId ?? null,
    action,
    targetUserId ?? null,
    detail ? JSON.stringify(scrub(detail)) : null
  );
}

// ---------- пароли ----------

function validatePassword(password, email) {
  const p = String(password || '');
  if (p.length < PASSWORD_MIN) return `Пароль должен быть не короче ${PASSWORD_MIN} символов.`;
  if (email && p.toLowerCase() === String(email).trim().toLowerCase()) return 'Пароль не должен совпадать с e-mail.';
  return null;
}

const TEMP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function generateTempPassword(len = 12) {
  let out = '';
  for (let i = 0; i < len; i++) out += TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)];
  return out;
}

const nowIso = () => new Date().toISOString();

// ---------- пользователи ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Создание сотрудника админом. Возвращает { ok, id, tempPassword } | { ok:false, error }. Пароль наружу — один раз. */
function createStaff(adminId, { full_name, email, role }) {
  const name = String(full_name || '').trim();
  const mail = String(email || '').trim().toLowerCase();
  if (!name || !mail) return { ok: false, error: 'Заполните ФИО и e-mail.' };
  if (!EMAIL_RE.test(mail)) return { ok: false, error: 'Проверьте e-mail: адрес выглядит неверно.' };
  if (!STAFF_ROLES.includes(role)) return { ok: false, error: 'Выберите роль: психиатр, психолог или администратор.' };
  if (db.prepare('SELECT 1 FROM users WHERE lower(email) = ?').get(mail)) return { ok: false, error: 'Пользователь с таким e-mail уже есть.' };
  // W-39 (T-243): users.service_no NOT NULL — служебный номер генерируется для каждого нового пользователя.
  let serviceNo = null;
  for (let i = 0; i < 50; i += 1) {
    const candidate = `С-${String(crypto.randomInt(100000, 999999))}`;
    if (!db.prepare('SELECT 1 FROM users WHERE service_no = ?').get(candidate)) {
      serviceNo = candidate;
      break;
    }
  }
  if (!serviceNo) return { ok: false, error: 'Не удалось присвоить служебный номер, попробуйте ещё раз.' };
  const temp = generateTempPassword();
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, role, full_name, service_no, must_change_password, created_by, sessions_valid_from)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(mail, bcrypt.hashSync(temp, 10), role, name, serviceNo, adminId, nowIso());
  const id = Number(info.lastInsertRowid);
  logAdmin(adminId, 'user_create', id, { role });
  return { ok: true, id, tempPassword: temp };
}

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)) || null;
}

function isActiveAccount(u) {
  // W-39: авторитетная колонка статуса — users.status (account_status в users нет).
  return !!u && !u.deactivated_at && u.status === 'active';
}

function activeAdminCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get().n;
}

/** Сброс пароля: новый временный пароль, обязательная смена, старые сессии недействительны. */
function resetPassword(adminId, userId) {
  const u = getUser(userId);
  if (!u) return { ok: false, error: 'Пользователь не найден.' };
  if (u.id === adminId) return { ok: false, error: 'Свой пароль меняйте в разделе «Смена пароля».' };
  if (u.status === 'tombstone') return { ok: false, error: 'Учётная запись удалена: сбросить пароль нельзя.' };
  const temp = generateTempPassword();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, password_changed_at = NULL, sessions_valid_from = ? WHERE id = ?').run(
    bcrypt.hashSync(temp, 10),
    nowIso(),
    u.id
  );
  logAdmin(adminId, 'password_reset', u.id, { role: u.role });
  return { ok: true, tempPassword: temp, user: u };
}

function deactivate(adminId, userId) {
  const u = getUser(userId);
  if (!u) return { ok: false, error: 'Пользователь не найден.' };
  if (u.id === adminId) return { ok: false, error: 'Нельзя деактивировать самого себя.' };
  if (u.status === 'tombstone') return { ok: false, error: 'Учётная запись уже удалена.' };
  if (u.deactivated_at) return { ok: false, error: 'Пользователь уже деактивирован.' };
  if (u.role === 'admin' && activeAdminCount() <= 1) return { ok: false, error: 'Нельзя деактивировать последнего администратора.' };
  const t = nowIso();
  db.prepare('UPDATE users SET deactivated_at = ?, sessions_valid_from = ? WHERE id = ?').run(t, t, u.id);
  logAdmin(adminId, 'user_deactivate', u.id, { role: u.role });
  return { ok: true, user: u };
}

function activate(adminId, userId) {
  const u = getUser(userId);
  if (!u) return { ok: false, error: 'Пользователь не найден.' };
  if (u.status === 'tombstone') return { ok: false, error: 'Удалённую учётную запись вернуть нельзя.' };
  if (!u.deactivated_at) return { ok: false, error: 'Пользователь и так активен.' };
  db.prepare('UPDATE users SET deactivated_at = NULL WHERE id = ?').run(u.id);
  logAdmin(adminId, 'user_activate', u.id, { role: u.role });
  return { ok: true, user: u };
}

// ---------- клиницисты и привязки (служебные данные) ----------

const ACTIVE_CLINICIAN_SQL =
  "role IN ('psychiatrist','psychologist') AND status = 'active'";

function activeClinicians() {
  return db.prepare(`SELECT id, full_name, role FROM users WHERE ${ACTIVE_CLINICIAN_SQL} ORDER BY full_name`).all();
}

function openEscalationCount(patientId) {
  return db.prepare("SELECT COUNT(*) AS n FROM crisis_escalations WHERE patient_id = ? AND status = 'open'").get(patientId).n;
}

function patientHasActiveClinician(patientId) {
  // W-39 (T-247): в users нет колонки account_status — статус активного специалиста определяем по status.
  return !!db
    .prepare(
      `SELECT 1 FROM care_assignments ca JOIN users c ON c.id = ca.clinician_id
       WHERE ca.patient_id = ? AND c.status = 'active'`
    )
    .get(patientId);
}

/** W3.K (M-4): привязка/снятие админом видна пациенту в «Приватности» (запись в журнале доступа к его данным) и баннером «врач изменился». */
function phiAssignmentLog(adminId, patientId, action) {
  // W-39 (T-247): раздел 'account.assignments' обязателен (NOT NULL в phi_access_log).
  db.prepare("INSERT INTO phi_access_log (actor_id, actor_role, patient_id, section, action, decision, basis) VALUES (?, 'admin', ?, 'account.assignments', ?, 'allow', 'admin_service')").run(
    adminId, Number(patientId), action,
  );
}

function assign(adminId, patientId, clinicianId) {
  const p = getUser(patientId);
  const c = getUser(clinicianId);
  if (!p || p.role !== 'patient' || p.status === 'tombstone') return { ok: false, error: 'Пациент не найден.' };
  if (!c || !isActiveAccount(c) || !['psychiatrist', 'psychologist'].includes(c.role)) return { ok: false, error: 'Назначить можно только активного психиатра или психолога.' };
  const info = db.prepare('INSERT OR IGNORE INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(p.id, c.id);
  if (!info.changes) return { ok: false, error: 'Этот специалист уже ведёт пациента.' };
  logAdmin(adminId, 'assignment_add', p.id, { clinician_id: c.id });
  phiAssignmentLog(adminId, p.id, 'assignment_add');
  require('./patient_prefs').noteCareChange(p.id, 'changed');
  return { ok: true, patient: p, clinician: c };
}

function unassign(adminId, patientId, clinicianId) {
  const open = openEscalationCount(Number(patientId));
  const info = db.prepare('DELETE FROM care_assignments WHERE patient_id = ? AND clinician_id = ?').run(Number(patientId), Number(clinicianId));
  if (!info.changes) return { ok: false, error: 'Такой привязки нет.' };
  logAdmin(adminId, 'assignment_remove', Number(patientId), { clinician_id: Number(clinicianId), open_escalations: open });
  phiAssignmentLog(adminId, patientId, 'assignment_remove');
  require('./patient_prefs').noteCareChange(Number(patientId), 'changed');
  // W-39 (T-247): снятие последнего специалиста — запись в служебную очередь (F-93).
  if (!patientHasActiveClinician(Number(patientId))) {
    try {
      db.prepare(
        "INSERT INTO service_queue(kind,patient_id,ref_type,ref_id,status,created_at) VALUES ('patient_without_clinician',?,'patient',?,'new',?)",
      ).run(Number(patientId), Number(patientId), nowIso());
    } catch (_e) {
      /* очередь может быть недоступна — журнал и предупреждение уже записаны */
    }
  }
  return { ok: true, warnings: [] };
}

/** Массовая переадресация: все выбранные пациенты от `from` к `to` одной транзакцией. */
function reassign(adminId, fromId, toId, patientIds) {
  const to = getUser(toId);
  if (!to || !isActiveAccount(to) || !['psychiatrist', 'psychologist'].includes(to.role)) return { ok: false, error: 'Выберите активного психиатра или психолога.' };
  if (Number(fromId) === Number(toId)) return { ok: false, error: 'Выберите другого специалиста.' };
  let moved = 0;
  db.transaction(() => {
    for (const pid of patientIds.map(Number)) {
      const had = db.prepare('SELECT 1 FROM care_assignments WHERE patient_id = ? AND clinician_id = ?').get(pid, Number(fromId));
      if (!had) continue;
      db.prepare('INSERT OR IGNORE INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(pid, to.id);
      db.prepare('DELETE FROM care_assignments WHERE patient_id = ? AND clinician_id = ?').run(pid, Number(fromId));
      require('./patient_prefs').noteCareChange(pid, 'changed');
      logAdmin(adminId, 'assignment_move', pid, { from: Number(fromId), to: to.id, open_escalations: openEscalationCount(pid) });
      phiAssignmentLog(adminId, pid, 'assignment_move');
      moved++;
    }
  })();
  return { ok: true, moved, to };
}

module.exports = {
  STAFF_ROLES, ROLE_LABELS, PASSWORD_MIN, ACTIVE_CLINICIAN_SQL,
  logAdmin, scrub, validatePassword, generateTempPassword,
  createStaff, getUser, isActiveAccount, activeAdminCount, resetPassword, deactivate, activate,
  activeClinicians, openEscalationCount, patientHasActiveClinician, assign, unassign, reassign,
};
