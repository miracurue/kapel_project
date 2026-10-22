'use strict';
// Оцифровка ГТР-7 (GAD-7), приложение Г2: тексты пунктов, варианты 0–3, ключ 0–4/5–9/10–14/15–21.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const def = require('../../src/modules/clinical/instruments/gad7');
const ctx = useApp();

const run = async (docKey, patKey, picks) => {
  const doc = await ctx.as(docKey);
  const patient = await ctx.as(patKey);
  const a = await F.assignTest(ctx.app, doc, ctx.id(patKey), 'gad7');
  let i = 0;
  return { a, patient, result: expectOk(await F.completeTest(patient, a.id, (q) => q.options[picks[i++]].value)) };
};

test('ГТР-7: пациент видит 7 пунктов с текстом и четыре варианта; в системе нет безымянных вопросов', async () => {
  const doc = await ctx.as('psy1');
  const patient = await ctx.as('patA');
  const a = await F.assignTest(ctx.app, doc, ctx.id('patA'), 'gad7');
  const qs = await F.instrumentQuestions(patient, a.id);
  assert.deepEqual(
    qs.map((q) => q.text),
    def.items,
  );
  assert.equal(qs.length, 7);
  for (const q of qs)
    assert.deepEqual(
      q.options.map((o) => [o.label, o.score]),
      [
        ['Никогда', 0],
        ['Несколько дней', 1],
        ['Более половины дней', 2],
        ['Почти каждый день', 3],
      ],
    );
  const list = expectOk(await doc.get('/api/v1/instruments')).items;
  const gad = list.find((i) => i.code === 'gad7');
  assert.equal(gad.status, 'published');
  assert.doesNotMatch(gad.title, /STAND-IN|заглушк/i);
  expectOk(await F.completeTest(patient, a.id));
});

for (const [name, pick, score, band] of [
  ['все «Никогда»', 0, 0, 'Минимальный'],
  ['граница 4', null, 4, 'Минимальный'],
  ['граница 5', null, 5, 'Умеренный'],
  ['граница 9', null, 9, 'Умеренный'],
  ['граница 10', null, 10, 'Средний'],
  ['граница 14', null, 14, 'Средний'],
  ['граница 15', null, 15, 'Высокий'],
  ['все «Почти каждый день»', 3, 21, 'Высокий'],
]) {
  test(`ГТР-7: ${name} → ${score} баллов, «${band}»`, async () => {
    // раскладка суммы по семи пунктам: сначала тройки, остаток в следующий пункт
    const picks =
      pick !== null
        ? Array(7).fill(pick)
        : Array.from({ length: 7 }, (_x, n) => Math.max(0, Math.min(3, score - 3 * n)));
    const { result } = await run('psy1', 'patA', picks);
    assert.equal(result.score, undefined);
    assert.equal(result.band, undefined);
    const stored = ctx.app.query('SELECT total_score,band FROM online_results WHERE id=?', result.id)[0];
    assert.equal(stored.total_score, score);
    assert.equal(stored.band, band);
    assert.equal(result.band_note_key, 'msg.test.not_diagnosis');
  });
}

test('ГТР-7: значение вне вариантов отклоняется и не попадает в сумму', async () => {
  const doc = await ctx.as('psy2');
  const patient = await ctx.as('patB');
  const a = await F.assignTest(ctx.app, doc, ctx.id('patB'), 'gad7');
  const qs = await F.instrumentQuestions(patient, a.id);
  expectError(
    await patient.put(`/api/v1/me/assignments/${a.id}/answers/${qs[0].id}`, { value: '99' }),
    422,
    'E-VALIDATION',
  );
  const row = ctx.app.query('SELECT instrument_version FROM instrument_assignments WHERE id=?', a.id)[0];
  assert.equal(
    row.instrument_version,
    ctx.app.query("SELECT current_version v FROM instruments WHERE code='gad7'")[0].v,
  );
});

test('каталог методик: у каждой карточки есть предпросмотр — назначение/инструкция, вопросы с текстом, варианты', async () => {
  const doc = await ctx.as('psy1');
  const items = expectOk(await doc.get('/api/v1/instruments')).items;
  const gad = items.find((i) => i.code === 'gad7').preview;
  assert.equal(gad.question_count, 7);
  assert.deepEqual(
    gad.questions.map((q) => q.text),
    def.items,
  );
  assert.equal(gad.options.length, 4);
  assert.deepEqual(
    gad.bands.map((b) => b.label),
    ['Минимальный', 'Умеренный', 'Средний', 'Высокий'],
  );
  const scl = items.find((i) => i.code === 'scl90r').preview;
  assert.equal(scl.question_count, 90);
  assert.equal(scl.scales.length, 10);
  assert.ok(scl.scales.find((s) => s.code === 'SOM').interpretation);
  for (const code of ['itt_l', 'itt_s']) {
    const p = items.find((i) => i.code === code).preview;
    assert.equal(p.question_count, 15);
    assert.equal(p.scales.length, 5);
    assert.ok(p.scales.every((s) => s.interpretation && s.title !== s.code));
  }
});
