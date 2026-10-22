'use strict';
// Модель прав: роль -> набор permission-строк. Единственный источник правды
// для проверок доступа (DECISIONS 2026-10-10: psychiatrist ⊇ psychologist;
// admin — служебная роль без клинических данных; patient — только своё).

const ROLES = ['patient', 'psychiatrist', 'psychologist', 'admin'];

const PATIENT = [
  'test.take',
  'diary.write',
  'reminders.manage',
  'chat.patient',
  'messages.send',
  'account.export_consent_revoke',
  'account.deletion_request',
  'tools.anonymous_calculator',
];

// Клиническое ядро, общее для психолога и психиатра.
const PSYCHOLOGIST = [
  'test.assign',
  'test.assign.any_catalog',
  'offline_result.enter',
  'patient.view_card',
  'patient.notes.write',
  'comparison.note',
  'psychoed.assign',
  'crisis.view_queue',
  'crisis.acknowledge',
  'conclusion.view',
  'ai_workspace.use',
  'export.research',
  'messages.send',
  'tools.anonymous_calculator',
];

// Только психолог (W2.E, REQ-PSY-004): психиатр заключения читает, но не пишет и не подписывает
// (исключение из «психиатр ⊇ психолог», DECISIONS 2026-10-10).
const PSYCHOLOGIST_ONLY = ['conclusion.write', 'conclusion.sign_psychologist', 'conclusion.release'];

// Только психиатр сверх психолога.
const PSYCHIATRIST_ONLY = ['medication.prescribe_plan', 'diagnosis.record'];

const ADMIN = [
  'admin.users',
  'admin.deletion_requests',
  'admin.audit_view',
  'tools.anonymous_calculator',
];

const NON_CLINICAL = new Set(['messages.send', 'tools.anonymous_calculator']);

const CLINICAL_PERMISSIONS = Object.freeze(
  [...PSYCHOLOGIST, ...PSYCHOLOGIST_ONLY, ...PSYCHIATRIST_ONLY].filter((p) => !NON_CLINICAL.has(p))
);

const ROLE_PERMISSIONS = Object.freeze({
  patient: new Set(PATIENT),
  psychologist: new Set([...PSYCHOLOGIST, ...PSYCHOLOGIST_ONLY]),
  psychiatrist: new Set([...PSYCHOLOGIST, ...PSYCHIATRIST_ONLY]),
  admin: new Set(ADMIN),
});

const ALL_PERMISSIONS = Object.freeze(
  [...new Set(Object.values(ROLE_PERMISSIONS).flatMap((s) => [...s]))].sort()
);

function isClinician(role) {
  return role === 'psychiatrist' || role === 'psychologist';
}

function can(role, perm) {
  const set = Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role) ? ROLE_PERMISSIONS[role] : null;
  return !!set && set.has(perm);
}

// Совместимо с requireRole из app.js: без сессии/права — 403 + view 'error'.
// Несколько прав = достаточно любого.
function requirePermission(...perms) {
  return (req, res, next) => {
    const user = req.session && req.session.user;
    if (!user || !perms.some((p) => can(user.role, p))) {
      return res.status(403).render('error', { message: 'Недостаточно прав для этого раздела.' });
    }
    next();
  };
}

// Scope: клиницист — только закреплённые (care_assignments), пациент — только
// себя, admin и неизвестные роли — никогда (клинические данные недоступны).
function canAccessPatient(user, patientId, db) {
  if (!user) return false;
  const pid = Number(patientId);
  if (!Number.isInteger(pid)) return false;
  if (user.role === 'patient') return Number(user.id) === pid;
  if (isClinician(user.role)) {
    return !!db
      .prepare('SELECT 1 FROM care_assignments WHERE patient_id = ? AND clinician_id = ?')
      .get(pid, user.id);
  }
  return false;
}

module.exports = {
  ROLES,
  ROLE_PERMISSIONS,
  ALL_PERMISSIONS,
  CLINICAL_PERMISSIONS,
  can,
  requirePermission,
  isClinician,
  canAccessPatient,
};
