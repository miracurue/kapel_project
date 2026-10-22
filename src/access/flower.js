'use strict';

/** @type {Array<[string, string, string[], string, string]>} */
const declarations = [
  ['GET', '/api/v1/me/flower', ['R-02'], 'flower.view', 'self'],
  ['POST', '/api/v1/me/flower/water', ['R-02'], 'flower.water', 'self'],
];
const operations = declarations.map(([method, path, roles, permission, patientAccess]) => ({
  method,
  path,
  roles: roles.map((role) => ({ role, scope: 'С' })),
  permission,
  patientAccess,
  functions: ['F-39'],
  tag: 'flower',
  public: false,
  idempotency: method === 'POST' ? 'required' : 'not_used',
}));

module.exports = { operations };
