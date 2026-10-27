'use strict';
// Аудит Т-3: приглашения в админке — список без открытых кодов, создание для специалиста, отзыв.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const ctx = useApp();

test('админ создаёт код для специалиста, видит список без кода и отзывает', async () => {
  const admin = await ctx.as('admin1');
  const psy = ctx.id('psy1');
  const made = expectOk(await admin.post('/api/v1/admin/invites', { clinician_id: psy }, { idem: true }), 201);
  assert.match(made.code, /^CC-[0-9A-F]{10}$/);
  assert.equal(made.clinician_id, psy);
  const list = expectOk(await admin.get('/api/v1/admin/invites'));
  const row = list.items.find((i) => i.id === made.id);
  assert.equal(row.status, 'active');
  assert.equal(row.clinician_id, psy);
  assert.ok(!JSON.stringify(list).includes(made.code), 'открытого кода в списке нет');
  assert.ok(!('code' in row) && !('code_hash' in row));
  expectOk(await admin.post(`/api/v1/admin/invites/${made.id}/revoke`, {}, { idem: true }));
  expectError(await admin.post(`/api/v1/admin/invites/${made.id}/revoke`, {}, { idem: true }), 409, 'E-STATUS');
  expectError(await admin.post('/api/v1/admin/invites/99999/revoke', {}, { idem: true }), 404, 'E-NOT-FOUND');
  const after = expectOk(await admin.get('/api/v1/admin/invites')).items.find((i) => i.id === made.id);
  assert.equal(after.status, 'revoked');
  const anon = await ctx.guest().post('/api/v1/auth/register', { invite_code: made.code, email: 'x@cc.example.test', password: 'Synthetic-pass-1' });
  expectError(anon, 422, 'E-INVITE-INVALID');
});

test('приглашение: неверная цель и чужие роли', async () => {
  const admin = await ctx.as('admin1');
  expectError(await admin.post('/api/v1/admin/invites', {}, { idem: true }), 422, 'E-VALIDATION');
  expectError(await admin.post('/api/v1/admin/invites', { clinician_id: 999999 }, { idem: true }), 422, 'E-VALIDATION');
  expectError(await admin.post('/api/v1/admin/invites', { clinician_id: ctx.id('patA') }, { idem: true }), 409, 'E-NO-CANDIDATE');
  for (const who of ['psy1', 'patA'])
    expectError(await (await ctx.as(who)).get('/api/v1/admin/invites'), 403, 'E-ACCESS');
});
