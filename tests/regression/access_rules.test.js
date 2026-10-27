'use strict';
// covers: единый источник правил доступа src/access (роль, область с отметкой, психолог без лечения).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const access = require('../../src/access');

const find = (method, path) => access.contract().find((op) => op.method === method && op.path === path);

test('каждая операция объявлена один раз', () => {
  const keys = access.contract().map((op) => `${op.method} ${op.path}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('область ПС требует отметку «проверяющий справочника»', () => {
  const op = find('GET', '/api/v1/admin/drug-review');
  assert.ok(op);
  assert.equal(access.isAllowed(op, { role: 'admin' }), false);
  assert.equal(access.isAllowed(op, { role: 'admin', flag_reference_reviewer: 1 }), true);
  assert.equal(access.isAllowed(op, { role: 'patient', flag_reference_reviewer: 1 }), false);
});

test('психологу закрыты лечение и побочные эффекты, психиатру открыты', () => {
  const ops = access.contract().filter((op) => ['plan', 'ae'].includes(op.patientAccess));
  assert.ok(ops.length > 0);
  for (const op of ops) {
    assert.equal(access.isAllowed(op, { role: 'psychologist' }), false, `${op.method} ${op.path}`);
    if (op.roles.some((r) => r.role === 'R-03' && !['КО', 'ИП', 'ПС'].includes(r.scope)))
      assert.equal(access.isAllowed(op, { role: 'psychiatrist' }), true, `${op.method} ${op.path}`);
  }
});

test('неизвестная роль — гость', () => {
  assert.equal(access.roleNumber({ role: 'something' }), 'R-01');
  assert.equal(access.roleNumber(null), 'R-01');
  assert.equal(access.roleNumber({ role: 'host' }), 'R-08');
});
