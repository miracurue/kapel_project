'use strict';
// Очный бланк: врач на приёме заполняет ту же шкалу, что пациент проходит онлайн, — пустую;
// баллы считает сервер тем же ключом, результат сразу сохраняется в карточку пациента.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const ctx = useApp();

const gad7 = async (doc) => {
  const item = expectOk(await doc.get('/api/v1/instruments')).items.find((i) => i.code === 'gad7');
  assert.ok(item.preview.questions.length === 7, 'в предпросмотре — все 7 пунктов');
  return item.preview.questions;
};
const fill = (questions, pick) => Object.fromEntries(questions.map((q, n) => [q.id, q.options[pick(n)].value]));

test('предпросмотр шкалы отдаёт пункты с вариантами — из них строится пустой бланк', async () => {
  const doc = await ctx.as('psy1');
  const qs = await gad7(doc);
  for (const q of qs) {
    assert.ok(q.id && q.text, 'у пункта есть id и текст');
    assert.equal(q.type, 'single');
    assert.deepEqual(
      q.options.map((o) => o.score),
      [0, 1, 2, 3],
    );
  }
});

test('ответы с приёма: тот же балл, что онлайн, результат в карточке пациента «очно»', async () => {
  const doc = await ctx.as('psy1');
  const patient = await ctx.as('patA');
  const qs = await gad7(doc);
  const picks = [3, 3, 2, 1, 0, 0, 0];
  const saved = expectOk(
    await doc.post(`/api/v1/patients/${ctx.id('patA')}/offline-results`, {
      instrument_code: 'gad7',
      method: 'manual',
      answers: fill(qs, (n) => picks[n]),
      held_on: '2026-10-20',
    }),
    201,
  );
  assert.equal(saved.total_score, 9);
  // тот же ключ, что у онлайн-прохождения
  const a = await F.assignTest(ctx.app, doc, ctx.id('patA'), 'gad7');
  let i = 0;
  const online = expectOk(await F.completeTest(patient, a.id, (q) => q.options[picks[i++]].value));
  const row = ctx.app.db().prepare('SELECT * FROM online_results WHERE id=?').get(online.id);
  assert.equal(row.total_score, saved.total_score);
  assert.equal(row.band, saved.band);
  const card = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}?tab=tests`));
  const offline = card.offline_results.find((r) => r.id === saved.id);
  assert.ok(offline, 'очный результат виден в карточке');
  assert.equal(offline.status, 'saved');
  assert.equal(offline.test_date, '2026-10-20');
  assert.equal(offline.total_score, 9);
  const stored = ctx.app.db().prepare('SELECT answers_json, entered_by FROM offline_results WHERE id=?').get(saved.id);
  assert.equal(Object.keys(JSON.parse(stored.answers_json)).length, 7, 'ответы по пунктам сохранены');
  assert.equal(stored.entered_by, ctx.id('psy1'));
});

test('не все пункты отмечены или чужой вариант — 422, ничего не сохраняется', async () => {
  const doc = await ctx.as('psy1');
  const qs = await gad7(doc);
  const before = ctx.app.db().prepare('SELECT count(*) n FROM offline_results').get().n;
  const partial = fill(qs, () => 0);
  delete partial[qs[6].id];
  expectError(
    await doc.post(`/api/v1/patients/${ctx.id('patA')}/offline-results`, {
      instrument_code: 'gad7',
      method: 'manual',
      answers: partial,
    }),
    422,
    'E-VALIDATION',
  );
  expectError(
    await doc.post(`/api/v1/patients/${ctx.id('patA')}/offline-results`, {
      instrument_code: 'gad7',
      method: 'manual',
      answers: { ...fill(qs, () => 0), [qs[0].id]: 99 },
    }),
    422,
    'E-VALIDATION',
  );
  assert.equal(ctx.app.db().prepare('SELECT count(*) n FROM offline_results').get().n, before);
});

test('чужому пациенту очный бланк не внести', async () => {
  const doc = await ctx.as('psy1');
  const qs = await gad7(doc);
  const res = await doc.post(`/api/v1/patients/${ctx.id('patB')}/offline-results`, {
    instrument_code: 'gad7',
    method: 'manual',
    answers: fill(qs, () => 0),
  });
  assert.ok([403, 404].includes(res.status), `чужой пациент: ${res.status}`);
});

test('фото бланка: снимок сохраняется в карточке пациента, баллов нет; видят его только специалисты пациента', async () => {
  const doc = await ctx.as('psy1');
  const up = expectOk(await F.upload(doc, 'printed_form.png', 'offline_result'));
  const saved = expectOk(
    await doc.post(`/api/v1/patients/${ctx.id('patA')}/offline-results`, {
      instrument_code: 'gad7',
      method: 'photo',
      upload_id: up.id,
      held_on: '2026-10-21',
    }),
    201,
  );
  assert.equal(saved.source_ref.id, up.id);
  const file = ctx.app
    .db()
    .prepare('SELECT status, linked_type, linked_id, purpose, expires_at FROM stored_files WHERE id=?')
    .get(up.id);
  assert.deepEqual(
    { ...file },
    {
      status: 'linked',
      linked_type: 'offline_result',
      linked_id: saved.id,
      purpose: 'offline_source',
      expires_at: null,
    },
  );
  const card = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}?tab=tests`));
  const row = card.offline_results.find((r) => r.id === saved.id);
  assert.equal(row.entry_method, 'photo');
  assert.equal(row.total_score, null);
  assert.equal(row.source_file_id, up.id);
  assert.equal((await doc.get(`/api/v1/files/${up.id}`)).status, 200, 'врач пациента открывает фото');
  assert.equal((await (await ctx.as('psy2')).get(`/api/v1/files/${up.id}`)).status, 404, 'чужой врач — нет');
  assert.equal(
    (await (await ctx.as('patA')).get(`/api/v1/files/${up.id}`)).status,
    404,
    'пациенту фото бланка не отдаётся',
  );
});

test('фото бланка по методике без онлайн-прохождения (рисунок, письмо от руки) тоже сохраняется; чужой файл и не-снимок — 422', async () => {
  const doc = await ctx.as('psy1');
  const code = ctx.app
    .db()
    .prepare("SELECT code FROM instruments WHERE online_allowed=0 AND status NOT IN ('blocked','withdrawn') LIMIT 1")
    .get()?.code;
  assert.ok(code, 'в каталоге есть методика, которая онлайн не проходится');
  const up = expectOk(await F.upload(doc, 'printed_form.png', 'offline_result'));
  expectOk(
    await doc.post(`/api/v1/patients/${ctx.id('patA')}/offline-results`, {
      instrument_code: code,
      method: 'photo',
      upload_id: up.id,
    }),
    201,
  );
  const other = expectOk(await F.upload(await ctx.as('psy2'), 'printed_form.png', 'offline_result'));
  expectError(
    await doc.post(`/api/v1/patients/${ctx.id('patA')}/offline-results`, {
      instrument_code: 'gad7',
      method: 'photo',
      upload_id: other.id,
    }),
    422,
    'E-VALIDATION',
  );
  expectError(
    await doc.post(`/api/v1/patients/${ctx.id('patA')}/offline-results`, { instrument_code: 'gad7', method: 'photo' }),
    422,
    'E-VALIDATION',
  );
});
