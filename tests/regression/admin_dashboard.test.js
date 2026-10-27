'use strict';
// covers: обзор администратора (F-71, F-74): права, форма ответа, отсутствие идентификаторов, подавление малых групп.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');

const ctx = useApp();

test('обзор: администратор получает главы и плитки, остальные роли закрыты, период проверяется', async () => {
  const a = await ctx.as('admin1');
  const r = expectOk(await a.get('/api/v1/admin/dashboard'));
  assert.equal(r.scope, 'program');
  assert.equal(r.period.days, 90);
  assert.ok(r.min_group >= 10);
  assert.deepEqual(
    r.chapters.map((c) => c.key),
    ['people', 'program', 'usage', 'wellbeing', 'tests', 'treatment', 'adverse', 'care', 'ai', 'content', 'access'],
  );
  for (const c of r.chapters) {
    assert.ok(!c.error, `глава ${c.key} собралась`);
    assert.ok(c.headline.length > 10);
  }
  expectOk(await a.get('/api/v1/admin/dashboard?days=30'));
  expectError(await a.get('/api/v1/admin/dashboard?days=7'), 422, 'E-VALIDATION');
  expectError(await a.get('/api/v1/admin/dashboard?days=abc'), 422, 'E-VALIDATION');
  expectError(await a.get('/api/v1/admin/dashboard?dx=Z99'), 422, 'E-VALIDATION');
  expectOk(await a.get('/api/v1/admin/dashboard?dx=unknown'));
  expectError(await (await ctx.as('psy1')).get('/api/v1/admin/dashboard'), 403, 'E-ACCESS');
  expectError(await (await ctx.as('patA')).get('/api/v1/admin/dashboard'), 403, 'E-ACCESS');
});

test('обзор: ни имён, ни почты, ни кодов участников; цифры малых групп скрыты', async () => {
  const a = await ctx.as('admin1');
  const r = expectOk(await a.get('/api/v1/admin/dashboard?days=365'));
  assert.doesNotMatch(JSON.stringify(r), /patient_id|subject_code|Марина|Тестова|Синтетикова|@cc\.example/);
  // В тестовом мире участников программы меньше порога: всё, что считается по пациентам, обязано быть скрыто.
  assert.equal(r.program_members, null);
  const wellbeing = r.chapters.find((c) => c.key === 'wellbeing');
  const mood = wellbeing.blocks.find((b) => b.type === 'series');
  assert.ok(mood.points.every((p) => p.value === null));
  const sleep = wellbeing.blocks.find((b) => b.title === 'Сон');
  assert.ok(sleep.segments.every((s) => s.value === null));
  const kpi = Object.fromEntries(r.kpis.map((k) => [k.key, k]));
  for (const key of ['active_week', 'diary', 'tests', 'meds']) assert.equal(kpi[key].value, null, key);
});
