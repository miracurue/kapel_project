'use strict';

/** @type {Array<[string, string[], string, string|null]>} */
const declarations = [
  ['/api/v1/me/analytics', ['R-02'], 'diary.write', 'self'],
  ['/api/v1/analytics/patients/{patient_id}', ['R-03', 'R-04'], 'patient.view', 'diary'],
  ['/api/v1/analytics/reports', ['R-03', 'R-04', 'R-05'], 'analytics.own', null],
  ['/api/v1/admin/analytics/users', ['R-05'], 'admin.metrics', null],
];
const operations = declarations.map(([path, roles, permission, patientAccess]) => ({
  method: 'GET',
  path,
  permission,
  patientAccess,
  roles: roles.map((role) => ({ role, scope: role === 'R-02' ? 'С' : role === 'R-05' ? 'О' : 'З' })),
  functions: ['F-71', 'F-74'],
  tag: 'analytics',
  public: false,
  idempotency: 'not_used',
}));

// Аналитика «диагноз → … → цена» и данные для неё (миграция 0027): modules/insights.
/** @type {Array<[string, string, string[], string, string|null]>} */
const insightDeclarations = [
  ['GET', '/api/v1/admin/insights', ['R-05'], 'admin.metrics', null],
  ['GET', '/api/v1/admin/insights/export', ['R-05'], 'admin.metrics', null],
  ['GET', '/api/v1/analytics/my-insights', ['R-03', 'R-04'], 'analytics.own', null],
  ['GET', '/api/v1/me/clinician-profile', ['R-03', 'R-04'], 'analytics.own', null],
  ['PUT', '/api/v1/me/clinician-profile', ['R-03', 'R-04'], 'analytics.own', null],
  ['GET', '/api/v1/patients/{patient_id}/diagnosis', ['R-03', 'R-04'], 'patient.view', 'diagnosis'],
  ['PUT', '/api/v1/patients/{patient_id}/diagnosis', ['R-03'], 'diagnosis.record', 'diagnosis'],
];
for (const [method, path, roles, permission, patientAccess] of insightDeclarations)
  operations.push({
    method,
    path,
    permission,
    patientAccess,
    roles: roles.map((role) => ({ role, scope: role === 'R-05' ? 'О' : 'З' })),
    functions: ['F-71', 'F-74'],
    tag: 'analytics',
    public: false,
    idempotency: method === 'PUT' ? 'required' : 'not_used',
  });

module.exports = { operations };
