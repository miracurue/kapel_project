'use strict';
// covers: unified diary medication persistence, ownership, dates and schedule versions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const { getMedicationDays } = require('../../src/modules/diary/medications');
const ctx = useApp();

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
}

test('diary medication slots persist independently and clear without deleting the other slot', async () => {
  const p = await ctx.as('patA');
  const doc = await ctx.as('psy1');
  const inn = await F.innId(doc, 'сертралин');
  await F.publishPlan(ctx.app, doc, ctx.id('patA'), [{ inn_id: inn, dose: 50, unit: 'мг', times: ['утро', 'вечер'] }]);
  const item = expectOk(await p.get('/api/v1/me/meds')).plan_items[0];
  const product = await F.productOf(p, inn, 'Золофт');
  expectOk(
    await p.post(`/api/v1/me/plan-items/${encodeURIComponent(item.item_key)}/accept`, { product_id: product.id }),
  );
  const target = { type: 'plan_item', id: item.id };
  expectOk(await p.post('/api/v1/me/med-marks', { target, day: today(), slot: 'утро', status: 'taken' }));
  expectOk(await p.post('/api/v1/me/med-marks', { target, day: today(), slot: 'вечер', status: 'skipped' }));
  const fresh = await ctx.fresh('patA');
  const db = ctx.app.db();
  try {
    const rows = getMedicationDays(db, ctx.id('patA'), today(), 'Europe/Moscow', `${today()}T23:59:59Z`)[today()];
    assert.equal(rows.find((m) => m.slot === 'утро').status, 'taken');
    assert.equal(rows.find((m) => m.slot === 'вечер').status, 'skipped');
  } finally {
    db.close();
  }
  expectOk(await fresh.post('/api/v1/me/med-marks', { target, day: today(), slot: 'утро', status: 'unknown' }));
  const persisted = ctx.app.query('SELECT * FROM med_log WHERE patient_id=? AND hidden_at IS NULL', ctx.id('patA'));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].slot, 'вечер');
  expectError(
    await p.post('/api/v1/me/med-marks', { target, slot: 'unassigned', status: 'taken' }),
    422,
    'E-VALIDATION',
  );
  expectError(await p.post('/api/v1/me/med-marks', { target, day: '2026-02-30' }), 422, 'E-VALIDATION');
  expectError(await p.post('/api/v1/me/med-marks', { target, day: '2999-01-01' }), 422, 'E-VALIDATION');
  expectError(await p.post('/api/v1/me/med-marks', { target, status: 'anything' }), 422, 'E-VALIDATION');
  expectError(await (await ctx.as('patB')).post('/api/v1/me/med-marks', { target }), 404, 'E-NOT-FOUND');
  expectError(await (await ctx.as('admin1')).post('/api/v1/me/med-marks', { target }), 403, 'E-ACCESS');
  expectError(await doc.post('/api/v1/me/med-marks', { target }), 403, 'E-ACCESS');
  ctx.app.exec(`UPDATE plan_item_acceptance SET hidden_at='2026-01-01' WHERE patient_id=${ctx.id('patA')}`);
  expectError(await p.post('/api/v1/me/med-marks', { target }), 404, 'E-NOT-FOUND');
  ctx.app.exec(`UPDATE plan_item_acceptance SET hidden_at=NULL WHERE patient_id=${ctx.id('patA')}`);
  ctx.app.exec(`UPDATE plan_items SET start_date='2999-01-01' WHERE id=${Number(item.id)}`);
  expectError(await p.post('/api/v1/me/med-marks', { target }), 422, 'E-VALIDATION');
  ctx.app.exec(`UPDATE plan_items SET start_date='2020-01-01',end_date='2020-01-02' WHERE id=${Number(item.id)}`);
  expectError(await p.post('/api/v1/me/med-marks', { target }), 422, 'E-VALIDATION');
  ctx.app.exec(`UPDATE plan_items SET end_date=NULL WHERE id=${Number(item.id)}`);
  // The legacy no-slot action continues to store 'any'.
  expectOk(await p.post('/api/v1/me/med-marks', { target }));
  assert.equal(
    ctx.app.query(
      "SELECT count(*) n FROM med_log WHERE patient_id=? AND slot='any' AND hidden_at IS NULL",
      ctx.id('patA'),
    )[0].n,
    1,
  );
});

test('own medications require ownership and an active record, and normalize remind_later', async () => {
  const p = await ctx.as('patB');
  const inn = await F.innId(p, 'гидроксизин');
  const product = await F.productOf(p, inn, 'Атаракс');
  const med = expectOk(
    await p.post('/api/v1/me/patient-meds', { product_id: product.id, dose: 25, unit: 'мг', times: ['на ночь'] }),
  ).med;
  const target = { type: 'patient_med', id: med.id };
  expectOk(await p.post('/api/v1/me/med-marks', { target, slot: 'на ночь', status: 'remind_later' }));
  const logs = ctx.app.query('SELECT * FROM med_log WHERE patient_med_id=? AND hidden_at IS NULL', med.id);
  assert.equal(logs[0].status, 'later');
  expectOk(await p.post('/api/v1/me/med-marks', { target, status: 'taken' }));
  const reader = ctx.app.db();
  try {
    const rows = getMedicationDays(reader, ctx.id('patB'), today(), 'Europe/Moscow', `${today()}T23:59:59Z`)[
      today()
    ].filter((row) => row.target.type === 'patient_med' && row.target.id === med.id);
    assert.equal(rows.filter((row) => !row.legacy).length, 1, 'legacy any is not an extra scheduled dose');
    assert.equal(rows.find((row) => row.slot === 'any').legacy, true);
    assert.equal(rows.find((row) => row.slot === 'any').status, 'taken', 'legacy mark remains in history');
    assert.equal(rows.find((row) => row.slot === 'на ночь').legacy, false);
  } finally {
    reader.close();
  }

  expectError(await (await ctx.as('patA')).post('/api/v1/me/med-marks', { target }), 404, 'E-NOT-FOUND');
  ctx.app.exec(`UPDATE patient_meds SET status='ended' WHERE id=${Number(med.id)}`);
  expectError(await p.post('/api/v1/me/med-marks', { target }), 404, 'E-NOT-FOUND');
});

test('historical schedules use the historical dose and never backfill a new plan', async () => {
  const db = ctx.app.db();
  try {
    const patient = ctx.id('patA');
    const inn = db.prepare('SELECT id FROM inn LIMIT 1').get().id;
    const insert = db.prepare(
      "INSERT INTO plan_versions(patient_id,version,status,author_id,created_at,published_at,visible_from) VALUES (?,?,'superseded',?,?,?,?)",
    );
    const old = Number(
      insert.run(patient, 501, ctx.id('psy1'), '2020-01-01', '2020-01-01', '2020-01-01').lastInsertRowid,
    );
    const next = Number(
      insert.run(patient, 502, ctx.id('psy1'), '2020-01-03', '2020-01-03', '2020-01-03').lastInsertRowid,
    );
    const add = db.prepare(
      "INSERT INTO plan_items(plan_version_id,item_key,inn_id,dose_value,dose_unit,times_json,start_date) VALUES (?,'historical-med',?,?,'мг','[\"утро\"]','2020-01-01')",
    );
    add.run(old, inn, 25);
    add.run(next, inn, 50);
    db.prepare(
      "INSERT INTO plan_item_acceptance(patient_id,item_key,accepted_at) VALUES (?,'historical-med','2020-01-01')",
    ).run(patient);
    const days = getMedicationDays(db, patient, '2020-01-04');
    assert.equal(days['2020-01-01'][0].dose, 25);
    assert.equal(days['2020-01-04'][0].dose, 50);
    db.prepare(
      "INSERT INTO med_log(patient_id,item_key,day,slot,status,logged_at) VALUES (?,'historical-med','2020-01-04','утро','taken','2020-01-04T07:00:00Z')",
    ).run(patient);
    insert.run(patient, 503, ctx.id('psy1'), '2020-01-04', '2020-01-04', '2020-01-04');
    const removedDay = getMedicationDays(db, patient, '2020-01-04')['2020-01-04'];
    assert.equal(removedDay[0].dose, 50);
    assert.equal(removedDay[0].status, 'taken', 'recorded morning survives removal from the later plan');
    assert.equal(days['2019-12-31'], undefined);
    assert.deepEqual(getMedicationDays(db, ctx.id('patB'), '2019-12-31'), {});
  } finally {
    db.close();
  }
});
