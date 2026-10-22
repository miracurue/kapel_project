'use strict';
// Оцифровка SCL-90-R (приложение Г3): 90 пунктов, ключ шкал, подсчёт на сервере, кризисные пункты,
// скрытие результата от пациента, блок результата для врача. Данные только синтетические.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const def = require('../../src/modules/clinical/instruments/scl90r');
const { scoreScl90r } = require('../../src/modules/clinical/instruments/scl90r_score');
const ctx = useApp();

const submitWith = async (docKey, patKey, valueOf) => {
  const doc = await ctx.as(docKey);
  const patient = await ctx.as(patKey);
  const a = await F.assignTest(ctx.app, doc, ctx.id(patKey), 'scl90r');
  const answers = {};
  const res = await F.completeTest(patient, a.id, (q) => {
    const n = Number(q.id.slice(1));
    answers[q.id] = String(valueOf(n));
    return answers[q.id];
  });
  return { doc, patient, a, res, answers };
};
const resultsOf = async (doc, patKey) =>
  expectOk(await doc.get(`/api/v1/patients/${ctx.id(patKey)}?tab=tests`)).results.filter(
    (r) => r.instrument === 'scl90r',
  );
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('SCL-90-R: ключ — каждый пункт 1–90 ровно в одной шкале, размеры шкал 12/10/9/13/10/6/7/6/10/7', () => {
  const seen = new Map();
  for (const s of def.scales) for (const n of s.items) seen.set(n, (seen.get(n) || 0) + 1);
  assert.equal(seen.size, 90);
  for (let n = 1; n <= 90; n++) assert.equal(seen.get(n), 1, `пункт ${n}`);
  assert.deepEqual(
    def.scales.map((s) => s.items.length),
    [12, 10, 9, 13, 10, 6, 7, 6, 10, 7],
  );
  const dep = def.scales.find((s) => s.code === 'DEP').items;
  assert.ok(dep.includes(5) && !dep.includes(56));
  assert.equal(def.meta.key_deviation.status, 'accepted_for_demo');
});

test('SCL-90-R: пациент видит 90 пунктов с текстом, одинаковые 5 вариантов, инструкцию; методика назначается врачом', async () => {
  const doc = await ctx.as('psy1');
  const patient = await ctx.as('patA');
  const list = expectOk(await doc.get('/api/v1/instruments')).items;
  const row = list.find((i) => i.code === 'scl90r');
  assert.ok(row && row.title.startsWith('SCL-90-R: опросник выраженности психопатологической симптоматики'));
  assert.equal(row.self_service, 0);
  const a = await F.assignTest(ctx.app, doc, ctx.id('patA'), 'scl90r');
  const r = expectOk(await patient.get(`/api/v1/me/assignments/${a.id}`));
  assert.equal(r.questions.length, 90);
  assert.deepEqual(
    r.questions.map((q) => q.text),
    def.items,
  );
  assert.equal(r.question_title, 'Насколько сильно Вас тревожили:');
  assert.match(r.instruction, /Выберите только один ответ в каждом пункте/);
  for (const q of r.questions)
    assert.deepEqual(
      q.options.map((o) => [o.value, o.label, o.score]),
      [
        ['0', 'Совсем нет', 0],
        ['1', 'Немного', 1],
        ['2', 'Умеренно', 2],
        ['3', 'Сильно', 3],
        ['4', 'Очень сильно', 4],
      ],
    );
  // не самостоятельная методика
  expectError(await patient.post('/api/v1/me/self-tests', { instrument_code: 'scl90r' }), 403, 'E-INSTRUMENT-LICENSE');
  expectError(await patient.put(`/api/v1/me/assignments/${a.id}/answers/q1`, { value: '5' }), 422, 'E-VALIDATION');
  expectOk(await F.completeTest(patient, a.id));
});

const manual = (valueOf) => {
  const v = Array.from({ length: 91 }, (_x, n) => (n ? valueOf(n) : 0));
  const scales = {};
  for (const s of def.scales) {
    const sum = s.items.reduce((a, n) => a + v[n], 0);
    scales[s.code] = sum / s.items.length;
  }
  const total = v.reduce((a, b) => a + b, 0);
  const psi = v.slice(1).filter((x) => x >= 1).length;
  return { scales, total, gsi: total / 90, psi, pdsi: psi ? ((total / 90) * 90) / psi : null };
};

for (const [name, valueOf, expected] of [
  ['все 0', () => 0, { gsi: 0, psi: 0, pdsi: null, total: 0 }],
  ['все 4', () => 4, { gsi: 4, psi: 90, pdsi: 4, total: 360 }],
  ['смешанный набор', (n) => (n * 7) % 5, null],
]) {
  test(`SCL-90-R: подсчёт «${name}» совпадает с ручным эталоном; пациент не получает балл`, async () => {
    const { doc, a, res } = await submitWith('psy1', 'patA', valueOf);
    const out = expectOk(res);
    for (const k of ['score', 'band', 'subscales', 'scales', 'gsi', 'psi', 'pdsi']) assert.equal(out[k], undefined, k);
    assert.equal(out.band_note_key, 'msg.test.not_diagnosis');
    const e = manual(valueOf);
    if (expected) assert.deepEqual({ gsi: e.gsi, psi: e.psi, pdsi: e.pdsi, total: e.total }, expected);
    const row = ctx.app.query('SELECT * FROM online_results WHERE assignment_id=?', a.id)[0];
    assert.equal(row.total_score, e.total);
    const sub = JSON.parse(row.subscales_json);
    near(sub.gsi, e.gsi);
    assert.equal(sub.psi, e.psi);
    if (e.pdsi === null) assert.equal(sub.pdsi, null);
    else near(sub.pdsi, e.pdsi);
    for (const s of def.scales) near(sub.scales[s.code].mean, e.scales[s.code]);
    assert.doesNotMatch(row.band, /диагноз|патолог|риск/i);
    // врач видит блок
    const block = (await resultsOf(doc, 'patA')).find((r) => r.id === row.id).scl90r;
    assert.equal(block.rows.length, 13);
    near(block.rows.find((r) => r.code === 'GSI').value, e.gsi);
  });
}

test('SCL-90-R: ручной эталон смешанного набора (конкретные числа)', () => {
  // q1..q90 = 0,1,2,3,4 по кругу (n % 5): проверка формул без опоры на ключ из определения
  const answers = {};
  for (let n = 1; n <= 90; n++) answers[`q${n}`] = String(n % 5);
  const r = scoreScl90r(answers, def.scales);
  assert.equal(r.total, 18 * (0 + 1 + 2 + 3 + 4));
  assert.equal(r.gsi, 180 / 90);
  assert.equal(r.psi, 72);
  assert.equal(r.pdsi, (2 * 90) / 72);
  // DEP: пункты 5,14,15,20,22,26,29,30,31,32,54,71,79 → 0,4,0,0,2,1,4,0,1,2,4,1,4 = 23
  assert.equal(r.scales.DEP.sum, 23);
  near(r.scales.DEP.mean, 23 / 13);
  assert.throws(() => scoreScl90r({ ...answers, q3: '7' }, def.scales));
});

test('SCL-90-R: кризис — пункт 15 > 0 даёт crisis, 15 = 0 нет; пункт 59 тоже; q19/q29/q63 не дают', async () => {
  const doc = await ctx.as('psy1');
  const patient = await ctx.as('patA');
  const a = await F.assignTest(ctx.app, doc, ctx.id('patA'), 'scl90r');
  const put = (q, value) => patient.put(`/api/v1/me/assignments/${a.id}/answers/${q}`, { value });
  for (const q of ['q15', 'q59']) {
    assert.equal(expectOk(await put(q, '0')).crisis, undefined, `${q}=0`);
  }
  for (const q of ['q19', 'q29', 'q39', 'q49', 'q69', 'q79', 'q89', 'q63', 'q16', 'q7', 'q62'])
    assert.equal(expectOk(await put(q, '4')).crisis, undefined, `${q}=4`);
  for (const q of ['q15', 'q59']) {
    const body = expectOk(await put(q, '1'));
    assert.ok(body.crisis, `${q}=1`);
  }
  const rows = ctx.app.query(
    "SELECT source FROM crisis_escalations WHERE patient_id=? AND source='test'",
    ctx.id('patA'),
  );
  assert.ok(rows.length >= 1);
  expectOk(await doc.post(`/api/v1/assignments/${a.id}/cancel`, {}));
});

test('SCL-90-R: список результатов пациента без балла и полосы', async () => {
  const { patient } = await submitWith('psy1', 'patA', () => 1);
  const series = expectOk(await patient.get('/api/v1/me/results')).series.filter((r) => r.instrument === 'scl90r');
  assert.ok(series.length >= 1);
  for (const r of series) {
    assert.equal(r.total_score, null);
    assert.equal(r.band, null);
    assert.ok(r.created_at);
  }
});

test('SCL-90-R: врач получает блок с нормами, интерпретациями, критическими пунктами и динамикой', async () => {
  const { doc } = await submitWith('psy1', 'patA', (n) => (n === 15 ? 2 : n === 1 ? 3 : 1));
  const results = await resultsOf(doc, 'patA');
  assert.ok(results.length >= 2);
  const b = results[0].scl90r;
  assert.deepEqual(
    b.crisis_items.map((c) => [c.item, c.value]),
    [
      [15, 2],
      [59, 1],
    ],
  );
  const som = b.rows.find((r) => r.code === 'SOM');
  assert.equal(som.norms.ru.text, '0,44±0,03');
  assert.equal(som.norms.us.text, '0,36');
  assert.equal(som.compare_ru, 'above');
  assert.ok(som.interpretation.startsWith('Пункты отражают дистресс'));
  assert.equal(b.rows.find((r) => r.code === 'ADD').interpretation, null);
  assert.equal(b.rows.find((r) => r.code === 'PHOB').norms.neurosis_before.text, '1,13±0,10');
  assert.deepEqual(
    b.high_items.map((x) => x.item),
    [1],
  );
  assert.ok(b.history.length >= 1);
  assert.equal(b.note_key, 'msg.scl90r.disclaimer');
  const text = JSON.stringify(b);
  assert.doesNotMatch(text, /патолог|диагноз:/i);
});

test('SCL-90-R: чужой врач — 404, психолог без закрепления — 404, пациент — 403', async () => {
  const other = await ctx.as('psy2');
  const patient = await ctx.as('patA');
  const r = await other.get(`/api/v1/patients/${ctx.id('patA')}?tab=tests`);
  assert.equal(r.status, 404);
  assert.ok([403, 404].includes((await patient.get(`/api/v1/patients/${ctx.id('patA')}?tab=tests`)).status));
  const patB = await ctx.as('patB');
  const a = await F.assignTest(ctx.app, other, ctx.id('patB'), 'scl90r');
  assert.equal((await patient.get(`/api/v1/me/assignments/${a.id}`)).status, 404);
  assert.equal((await patB.get(`/api/v1/me/assignments/${a.id}`)).status, 200);
});
