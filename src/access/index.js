'use strict';

// Единственный источник правил доступа (BUILD_RULES §3): контракт API, собранный из docs/openapi.yaml
// (tests/tools/build_contract.py → tests/api/contract/operations.json, его же читают тесты).
// Новый маршрут сначала описывается в docs/openapi.yaml, затем контракт пересобирается.
// Сервер берёт отсюда список операций и решение «можно ли этой роли».

const operations = require('../../tests/api/contract/operations.json').operations;

/** Все объявленные операции контракта. */
function contract() {
  return operations;
}

function toExpress(value) {
  return value.replace(/\{([^}]+)\}/g, ':$1');
}

function routes() {
  return contract().map((op) => ({
    method: op.method,
    path: toExpress(op.path),
    fn: op.functions,
    perm: op.permission,
    roles: op.roles,
    patient: op.patientAccess ? { purpose: op.patientAccess } : undefined,
    public: op.public,
    tag: op.tag,
  }));
}

const ROLE_NUMBER = {
  patient: 'R-02',
  psychiatrist: 'R-03',
  psychologist: 'R-04',
  admin: 'R-05',
  bootstrap_admin: 'R-06',
  host: 'R-08',
};

function roleNumber(user) {
  if (!user) return 'R-01';
  return ROLE_NUMBER[user.role] || 'R-01';
}

// Области из контракта, для которых нужна отметка у пользователя сверх роли.
const SCOPE_FLAG = { КО: 'flag_clinical_lead', ИП: 'flag_research', ПС: 'flag_reference_reviewer' };

// Психолог работает с тем же пациентом, что и психиатр, но без раздела лечения (DECISIONS 2026-10-10,
// REQ-PSY-004): в контракте у таких операций роль R-04 есть ради общего пути, поэтому запрет — здесь.
const PSYCHIATRIST_ONLY_PERMISSIONS = new Set(['visit.manage', 'hints.use', 'medication.prescribe_plan', 'ae.review']);
const PSYCHIATRIST_ONLY_PATIENT_ACCESS = new Set(['plan', 'ae']);

/** Разрешена ли операция контракта этому пользователю (роль, область, отметки). */
function isAllowed(op, user) {
  const rule = op.roles.find((r) => r.role === roleNumber(user));
  if (!rule) return false;
  const flag = SCOPE_FLAG[rule.scope];
  if (flag && !user?.[flag]) return false;
  if (
    user?.role === 'psychologist' &&
    (PSYCHIATRIST_ONLY_PERMISSIONS.has(op.permission) || PSYCHIATRIST_ONLY_PATIENT_ACCESS.has(op.patientAccess))
  )
    return false;
  return true;
}

module.exports = { contract, routes, roleNumber, toExpress, isAllowed };
