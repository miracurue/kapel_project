'use strict';
// Аудит Т-5: смена роли не превращает пациента в специалиста и специалиста в пациента.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const ctx = useApp();

test('PUT /admin/people/{id}/role: цель-пациент и роль patient — E-VALIDATION, роль не меняется', async () => {
  const admin = await ctx.as('admin1');
  const role = (key) => ctx.app.query('SELECT role FROM users WHERE id=?', ctx.id(key))[0].role;
  for (const to of ['psychiatrist', 'psychologist', 'admin', 'patient'])
    expectError(await admin.put(`/api/v1/admin/people/${ctx.id('patA')}/role`, { role: to }), 422, 'E-VALIDATION');
  assert.equal(role('patA'), 'patient');
  expectError(await admin.put(`/api/v1/admin/people/${ctx.id('psy1')}/role`, { role: 'patient' }), 422, 'E-VALIDATION');
  assert.equal(role('psy1'), 'psychiatrist');
  expectOk(await admin.put(`/api/v1/admin/people/${ctx.id('plg1')}/role`, { role: 'psychiatrist' }));
  expectOk(await admin.put(`/api/v1/admin/people/${ctx.id('plg1')}/role`, { role: 'psychologist' }));
});
