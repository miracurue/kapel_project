'use strict';
// Назначение лекарств врачом: срок и комментарий в плане, отмена пункта, проверки данных, «проверьте» только у изменённых.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const ctx = useApp();

const draft = async (doc, pid, items) => {
  const cur = expectOk(await doc.get(`/api/v1/patients/${pid}/plan`));
  return doc.put(`/api/v1/patients/${pid}/plan/draft`, { version: (cur.draft && cur.draft.version) || 1, items });
};

test('план: срок и комментарий сохраняются и видны врачу и пациенту; дата начала не сбрасывается правкой соседнего', async () => {
  const doc = await ctx.as('psy2');
  const p = await ctx.as('patB');
  const pid = ctx.id('patB');
  const ser = await F.innId(doc, 'сертралин');
  const que = await F.innId(doc, 'кветиапин');
  await F.publishPlan(ctx.app, doc, pid, [
    { inn_id: ser, dose: 50, unit: 'мг', times: ['утро'], until: '2099-01-31', comment: 'после еды' },
  ]);
  const first = expectOk(await doc.get(`/api/v1/patients/${pid}/plan`)).published.items[0];
  assert.equal(first.until, '2099-01-31');
  assert.equal(first.comment, 'после еды');
  assert.ok(first.start_date, 'дата начала проставлена');
  ctx.app.exec(`UPDATE plan_items SET start_date='2026-01-05' WHERE id=${Number(first.id)}`);
  await F.publishPlan(ctx.app, doc, pid, [
    { inn_id: ser, dose: 50, unit: 'мг', times: ['утро'], until: '2099-01-31', comment: 'после еды' },
    { inn_id: que, dose: 25, unit: 'мг', times: ['на ночь'] },
  ]);
  const meds = expectOk(await p.get('/api/v1/me/meds')).plan_items;
  const mine = meds.find((i) => i.inn_id === ser);
  assert.equal(mine.until, '2099-01-31');
  assert.equal(mine.comment, 'после еды');
  assert.equal(mine.start_date, '2026-01-05', 'начало сквозное между версиями');
  assert.equal(meds.length, 2);
});

test('план: «проверьте» ставится только у пунктов с изменённой дозой; отменённый пункт уходит из действующих и попадает в «прежние»', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patA');
  const pid = ctx.id('patA');
  const { inn: ser, item } = await F.sertralinePrescribedAndAccepted(ctx.app, doc, p, pid);
  const mel = await F.innId(doc, 'мелатонин');
  await F.publishPlan(ctx.app, doc, pid, [
    { inn_id: ser, dose: 50, unit: 'мг', times: ['утро'], comment: 'во время завтрака' },
    { inn_id: mel, dose: 3, unit: 'мг', times: ['на ночь'] },
  ]);
  const flag = () =>
    ctx.app.query(
      'SELECT review_needed FROM plan_item_acceptance WHERE patient_id=? AND item_key=?',
      pid,
      item.item_key,
    )[0].review_needed;
  assert.equal(flag(), 0, 'добавили соседний препарат — принятие не сбрасывается');
  await F.publishPlan(ctx.app, doc, pid, [
    { inn_id: ser, dose: 100, unit: 'мг', times: ['утро'] },
    { inn_id: mel, dose: 3, unit: 'мг', times: ['на ночь'] },
  ]);
  assert.equal(flag(), 1, 'доза изменилась — «проверьте»');
  await F.publishPlan(ctx.app, doc, pid, [
    { inn_id: ser, dose: 100, unit: 'мг', times: ['утро'] },
    { inn_id: mel, ended: true },
  ]);
  const now = expectOk(await p.get('/api/v1/me/meds')).plan_items;
  assert.ok(!now.some((i) => i.inn_id === mel), 'отменённого нет среди действующих');
  const past = expectOk(await p.get('/app/api/meds/history')).items;
  assert.ok(
    past.some((i) => /мелатонин/i.test(i.inn_name)),
    'отменённый виден в прежних назначениях',
  );
});

test('план: проверки данных — неизвестный препарат, дубль, доза, единица, срок', async () => {
  const doc = await ctx.as('psy1');
  const pid = ctx.id('patA');
  const ser = await F.innId(doc, 'сертралин');
  const ok = { inn_id: ser, dose: 50, unit: 'мг', times: ['утро'] };
  expectError(await draft(doc, pid, [{ ...ok, inn_id: 999999 }]), 422, 'E-VALIDATION');
  expectError(await draft(doc, pid, [ok, ok]), 422, 'E-VALIDATION');
  expectError(await draft(doc, pid, [{ ...ok, dose: -5 }]), 422, 'E-VALIDATION');
  expectError(await draft(doc, pid, [{ ...ok, unit: 'ведро' }]), 422, 'E-VALIDATION');
  expectError(await draft(doc, pid, [{ ...ok, until: '31.01.2099' }]), 422, 'E-VALIDATION');
  expectError(await draft(doc, pid, [{ ...ok, times: 'утро' }]), 422, 'E-VALIDATION');
  expectOk(await draft(doc, pid, [ok]));
});

test('препарат вне каталога: врач вносит его, второй врач находит его в подсказках, назначение работает', async () => {
  const a = await ctx.as('psy1');
  const b = await ctx.as('psy2');
  const created = await a.post('/work/api/drugs/custom', { name: 'Глицин' }, { idem: false });
  assert.equal(created.status, 201);
  assert.equal(created.body.created, true);
  const again = await b.post('/work/api/drugs/custom', { name: ' глицин ' }, { idem: false });
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(again.body.id, created.body.id);
  const found = expectOk(await b.get('/api/v1/catalog/search?q=глиц&scope=inn')).items[0];
  assert.equal(found.id, created.body.id);
  assert.equal(found.added_by_doctor, 1);
  await F.publishPlan(ctx.app, a, ctx.id('patA'), [
    { inn_id: created.body.id, dose: 100, unit: 'мг', times: ['вечер'] },
  ]);
  const bad = await a.post('/work/api/drugs/custom', { name: '<b>' }, { idem: false });
  assert.equal(bad.status, 422);
  const pat = await ctx.as('patA');
  assert.equal((await pat.post('/work/api/drugs/custom', { name: 'Тест' }, { idem: false })).status, 403);
});
