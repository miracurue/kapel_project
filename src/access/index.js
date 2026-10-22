'use strict';

const operations = require('../../tests/api/contract/operations.json').operations;

function toExpress(value) {
  return value.replace(/\{([^}]+)\}/g, ':$1');
}

function routes() {
  return [
    ...operations,
    ...require('./diary').operations,
    ...require('./analytics').operations,
    ...require('./flower').operations,
  ].map((op) => ({
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

module.exports = { routes, roleNumber, toExpress };
