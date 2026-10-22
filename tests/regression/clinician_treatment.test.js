'use strict';
// «Лечение» и «Тесты» специалиста: внесённое пациентом (дозы, подтверждение, комментарий), разбор фразы со сроком, пакет «Старт».
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const ctx = useApp();

test('вкладка «Лечение»: внесённое пациентом отдаёт дозу, время, статус просмотра и комментарий врача', async () => {
  const p = await ctx.as('patA');
  const doc = await ctx.as('psy1');
  const atarax = await F.productOf(p, await F.innId(p, 'гидроксизин'), 'Атаракс');
  const r = expectOk(
    await p.post('/api/v1/me/patient-meds', { product_id: atarax.id, dose: 25, unit: 'мг', times: ['на ночь'] }),
  );
  await F.passUndoWindow(ctx.app);
  const before = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}?tab=treatment`)).patient_meds.find(
    (m) => m.id === r.med.id,
  );
  assert.equal(before.dose, 25);
  assert.deepEqual(before.times, ['на ночь']);
  assert.ok(before.reviewed_version < before.current_version, 'ещё не просмотрено');
  expectOk(await doc.post(`/api/v1/patient-meds/${r.med.id}/confirm`, { version: before.current_version }));
  expectOk(await doc.post(`/api/v1/patient-meds/${r.med.id}/comments`, { text: 'Синтетика: обсудим на приёме' }));
  const after = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}?tab=treatment`)).patient_meds.find(
    (m) => m.id === r.med.id,
  );
  assert.ok(after.reviewed_version >= after.current_version);
  assert.equal(after.comment, 'Синтетика: обсудим на приёме');
});

test('разбор фразы: время суток и срок «4 недели» превращаются в дату окончания', async () => {
  const doc = await ctx.as('psy1');
  const parsed = expectOk(
    await doc.post(`/api/v1/patients/${ctx.id('patA')}/parse`, {
      target: 'plan_item',
      phrase: 'сертралин 75 мг утром и вечером, 4 недели',
    }),
  );
  assert.deepEqual(parsed.draft.times, ['утро', 'вечер']);
  assert.equal(parsed.draft.dose, 75, 'доза не принята за срок');
  const days = (new Date(parsed.draft.until) - Date.now()) / 86400000;
  assert.ok(days > 26 && days < 29, 'срок около четырёх недель');
  assert.deepEqual(parsed.missing, []);
});

test('пакет «Старт»: общий, из действующих методик; назначение создаёт все и отменяется целиком', async () => {
  const doc = await ctx.as('psy2');
  const pid = ctx.id('patB');
  const start = expectOk(await doc.get('/api/v1/packages')).items.find((x) => x.title === 'Старт');
  assert.ok(start && start.shared, 'общий пакет есть');
  assert.deepEqual(start.items, ['gad7', 'scl90r', 'itt_s']);
  const sent = expectOk(await doc.post(`/api/v1/patients/${pid}/assignments`, { package_id: start.id }));
  assert.equal(sent.items.length, 3);
  const open = () =>
    ctx.app.query("SELECT count(*) n FROM instrument_assignments WHERE patient_id=? AND status<>'cancelled'", pid)[0].n;
  assert.equal(open(), 3);
  expectError(await doc.post(`/api/v1/patients/${pid}/assignments`, { package_id: start.id }), 409, 'E-ASSIGN-DUPLICATE');
  expectOk(await doc.post(`/api/v1/undo/${sent.undo.id}`, {}));
  assert.equal(open(), 0, 'отмена убрала весь пакет');
});
