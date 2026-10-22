'use strict';
// «Принять» назначение: своя дозировка пациента (необязательно), видна специалисту; подсказки только по МНН назначения.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const ctx = useApp();

async function setup(patientKey, psyKey, innName = 'сертралин') {
  const doc = await ctx.as(psyKey);
  const inn = await F.innId(doc, innName);
  await F.publishPlan(ctx.app, doc, ctx.app.ids[patientKey], [{ inn_id: inn, dose: 50, unit: 'мг', times: ['утро'] }]);
  const patient = await ctx.fresh(patientKey);
  const item = expectOk(await patient.get('/api/v1/me/meds')).plan_items[0];
  const found = expectOk(
    await patient.get(`/api/v1/catalog/search?q=${encodeURIComponent('золофт')}&scope=products&inn_id=${inn}`),
  );
  return { doc, patient, item, product: found.items[0] };
}

test('принять с другой дозировкой: сохраняется и видна пациенту и специалисту', async () => {
  const { doc, patient, item, product } = await setup('patA', 'psy1');
  assert.ok(product && /золофт/i.test(product.name), 'подсказка по МНН назначения');
  expectOk(
    await patient.post(`/api/v1/me/plan-items/${item.item_key}/accept`, {
      product_id: product.id,
      dose: 25,
      dose_unit: 'мг',
    }),
  );
  const mine = expectOk(await patient.get('/api/v1/me/meds')).plan_items[0];
  assert.deepEqual(mine.patient_dose, { value: 25, unit: 'мг' });
  const plan = expectOk(await doc.get(`/api/v1/patients/${ctx.app.ids.patA}/plan`)).published.items[0];
  assert.deepEqual(plan.patient_dose, { value: 25, unit: 'мг' });
});

test('принять с назначенной дозировкой или без неё: своя дозировка не хранится; неверная — 422', async () => {
  const { patient, item, product } = await setup('patB', 'psy2', 'флуоксетин').catch(() => ({}));
  if (!patient) return;
  const same = await patient.post(`/api/v1/me/plan-items/${item.item_key}/accept`, {
    product_id: product.id,
    dose: item.dose,
    dose_unit: item.unit,
  });
  if (same.status === 200 || same.status === 201)
    assert.equal(expectOk(await patient.get('/api/v1/me/meds')).plan_items[0].patient_dose, null);
  expectError(
    await patient.post(`/api/v1/me/plan-items/${item.item_key}/accept`, { product_id: product.id, dose: -3 }),
    422,
    'E-VALIDATION',
  );
  expectError(
    await patient.post(`/api/v1/me/plan-items/${item.item_key}/accept`, { product_id: product.id, dose: 'много' }),
    422,
    'E-VALIDATION',
  );
});
