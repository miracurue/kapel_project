'use strict';

/** @type {Array<[string, string, string[], string, string]>} */
const declarations = [
  ['GET', '/api/v1/me/diary-workspace', ['R-02'], 'diary.write', 'self'],
  ['PUT', '/api/v1/me/diary-workspace', ['R-02'], 'diary.write', 'self'],
  ['GET', '/api/v1/patients/{patient_id}/diary-workspace', ['R-03', 'R-04'], 'patient.view', 'diary'],
];
const operations = declarations.map(([method, path, roles, permission, patientAccess]) => ({
  method,
  path,
  roles: roles.map((role) => ({ role, scope: role === 'R-02' ? 'С' : 'З' })),
  permission,
  patientAccess,
  functions: ['F-39', 'F-56'],
  tag: 'diary',
  public: false,
  idempotency: method === 'PUT' ? 'required' : 'not_used',
}));

module.exports = { operations };
