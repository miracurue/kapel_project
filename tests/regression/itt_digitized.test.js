'use strict';
// Оцифровка ИТТ (приложение Г4): две методики СТ-Л и СТ-С по 15 пунктов, ключ с диагностическими коэффициентами,
// таблицы станайнов, группы норм, скрытие результата от пациента, блок для врача. Данные только синтетические.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const { itt_l, itt_s, KEY, SCALES } = require('../../src/modules/clinical/instruments/itt');
const N = require('../../src/modules/clinical/instruments/itt_norms');
const { scoreItt, pickGroup } = require('../../src/modules/clinical/instruments/itt_score');
const ctx = useApp();

const L_ITEMS = [
  'Я находился в напряжении',
  'Я расстраивался',
  'Я тревожился о будущем',
  'Я нервничал',
  'Я бывал озабочен',
  'Я бывал возбужден',
  'Я ощущал непонятную угрозу',
  'Я быстро уставал',
  'Я бывал не уверен в себе',
  'Я избегал любых конфликтов',
  'Я легко приходил в замешательство',
  'Я ощущал свою бесполезность',
  'Я плохо спал',
  'Я ощущал себя утомленным',
  'Я бывал эмоционально чувствителен',
];
const S_ITEMS = [
  'Я нахожусь в напряжении',
  'Я расстроен',
  'Я тревожусь о будущем',
  'Я нервничаю',
  'Я озабочен',
  'Я возбужден',
  'Я ощущаю непонятную угрозу',
  'Я устаю быстрее обычного',
  'Я не уверен в себе',
  'Я избегаю любых конфликтов',
  'Я чувствую замешательство',
  'Я ощущаю свою бесполезность',
  'Я спал беспокойно',
  'Я ощущаю себя утомленным',
  'Я эмоционально чувствителен',
];
const OPT_L = [
  ['0', 'Почти никогда', 0],
  ['1', 'Редко', 1],
  ['2', 'Часто', 2],
  ['3', 'Почти все время', 3],
];
const OPT_S = [
  ['0', 'Совсем нет', 0],
  ['1', 'Слабо выражено', 1],
  ['2', 'Выражено', 2],
  ['3', 'Очень выражено', 3],
];

const submitWith = async (docKey, patKey, code, valueOf) => {
  const doc = await ctx.as(docKey);
  const patient = await ctx.as(patKey);
  const a = await F.assignTest(ctx.app, doc, ctx.id(patKey), code);
  const res = await F.completeTest(patient, a.id, (q) => String(valueOf(Number(q.id.slice(1)))));
  return { doc, patient, a, res };
};
const resultsOf = async (doc, patKey) =>
  expectOk(await doc.get(`/api/v1/patients/${ctx.id(patKey)}?tab=tests`)).results.filter((r) => r.itt);
const rowOf = (a) => ctx.app.query('SELECT * FROM online_results WHERE assignment_id=?', a.id)[0];

test('ИТТ: тексты пунктов и варианты СТ-Л и СТ-С точные; selfService выключен', () => {
  assert.deepEqual(itt_l.items, L_ITEMS);
  assert.deepEqual(itt_s.items, S_ITEMS);
  assert.deepEqual(
    itt_l.options.map((o) => [o.value, o.label, o.score]),
    OPT_L,
  );
  assert.deepEqual(
    itt_s.options.map((o) => [o.value, o.label, o.score]),
    OPT_S,
  );
  for (const d of [itt_l, itt_s]) {
    assert.equal(d.selfService, false);
    assert.equal(d.items.length, 15);
    assert.equal(d.meta.norm_group_assumption.flag, 'demo_assumption');
    assert.equal(d.meta.high_threshold_assumption.flag, 'demo_assumption');
  }
  assert.equal(itt_l.title, 'ИТТ: шкала личностной тревожности (СТ-Л)');
  assert.equal(itt_s.title, 'ИТТ: шкала ситуативной тревожности (СТ-С)');
  assert.equal(itt_l.patientTitle, 'Опросник состояния: как обычно');
  assert.equal(itt_s.patientTitle, 'Опросник состояния: сейчас');
});

test('ИТТ: каждый пункт ровно в одной субшкале; состав ЭД/АСТ/ФОБ/ОП/СЗ; порядок коэффициентов 3/2/1 верный', () => {
  const seen = new Map();
  for (const s of SCALES) for (const n of s.items) seen.set(n, (seen.get(n) || 0) + 1);
  for (let n = 1; n <= 15; n++) assert.equal(seen.get(n), 1, `пункт ${n}`);
  assert.deepEqual(Object.fromEntries(SCALES.map((s) => [s.code, s.items])), {
    ЭД: [1, 2, 4, 6],
    АСТ: [8, 13, 14],
    ФОБ: [7, 9, 12],
    ОП: [3, 5, 15],
    СЗ: [10, 11],
  });
  SCALES.forEach((s) => s.items.forEach((n) => assert.equal(KEY[n - 1].scale, s.code)));
  // порядок «3/2/1»: ответ 3 даёт наибольшее число, и числа ≈ 3k / 2k / k (k — коэффициент ответа 1)
  KEY.forEach((k, i) => {
    assert.ok(k.coef[3] > k.coef[2] && k.coef[2] > k.coef[1], `пункт ${i + 1}: убывание`);
    assert.ok(Math.abs(k.coef[3] - 3 * k.coef[1]) <= 3, `пункт ${i + 1}: 3×`);
    assert.ok(Math.abs(k.coef[2] - 2 * k.coef[1]) <= 2, `пункт ${i + 1}: 2×`);
  });
  const max = Object.fromEntries(SCALES.map((s) => [s.code, s.items.reduce((a, n) => a + KEY[n - 1].coef[3], 0)]));
  assert.deepEqual(max, { ЭД: 300, АСТ: 300, ФОБ: 283, ОП: 300, СЗ: 300 });
  assert.deepEqual(max, N.SUBSCALE_MAX);
});

test('ИТТ: таблицы станайнов без пропусков и перекрытий на всех целых значениях', () => {
  const check = (rows, top, what) => {
    assert.equal(rows.length, 9, what);
    assert.equal(rows[0].min, 0, what);
    assert.equal(rows[8].max, null, what);
    for (let i = 1; i < 9; i++) assert.equal(rows[i].min, rows[i - 1].max + 1, `${what}: стык ${i}`);
    for (let v = 0; v <= top; v++) {
      const hits = rows.map((r, i) => (v >= r.min && (r.max === null || v <= r.max) ? i + 1 : 0)).filter(Boolean);
      assert.equal(hits.length, 1, `${what}: значение ${v}`);
      assert.equal(N.stanineOf(rows, v), hits[0]);
    }
  };
  for (const g of ['adult', 'girls']) {
    check(N.TOTAL[g], 45, `общий ${g}`);
    for (const s of SCALES) check(N.SUBSCALES[g][s.code], N.SUBSCALE_MAX[s.code], `${s.code} ${g}`);
  }
  assert.equal(N.stanineOf(N.TOTAL.adult, 9), 3);
  assert.equal(N.stanineOf(N.TOTAL.girls, 9), 3);
  assert.equal(N.stanineOf(N.TOTAL.girls, 31), 9);
});

const answersOf = (valueOf) =>
  Object.fromEntries(Array.from({ length: 15 }, (_x, i) => [`q${i + 1}`, String(valueOf(i + 1))]));

test('ИТТ: ручной эталон — все 0; все 3 (суммы 300/300/283/300/300, общий 45); смешанный набор', () => {
  const z = scoreItt(
    answersOf(() => 0),
    itt_l.scoring,
    null,
  );
  assert.equal(z.total, 0);
  assert.deepEqual(
    Object.values(z.sub.subscales).map((x) => x.raw),
    [0, 0, 0, 0, 0],
  );
  assert.equal(z.sub.total.stanine.adult, 1);
  const m = scoreItt(
    answersOf(() => 3),
    itt_l.scoring,
    null,
  );
  assert.equal(m.total, 45);
  assert.deepEqual(
    SCALES.map((s) => m.sub.subscales[s.code].raw),
    [300, 300, 283, 300, 300],
  );
  assert.deepEqual([m.sub.total.stanine.adult, m.sub.total.stanine.girls], [9, 9]);
  // смешанный набор ответов 1/2/3 по кругу (в т.ч. ответы 1 и 2 с разными коэффициентами)
  const v = [1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3];
  const r = scoreItt(
    answersOf((n) => v[n - 1]),
    itt_s.scoring,
    { sex: 'm', age_band: '35-44' },
  );
  assert.equal(r.total, 30);
  const hand = {
    ЭД: 25 + 49 + 27 + 73, // п.1=1, п.2=2, п.4=1, п.6=3
    АСТ: 61 + 41 + 58, // п.8=2, п.13=1, п.14=2
    ФОБ: 37 + 85 + 87, // п.7=1, п.9=3, п.12=3
    ОП: 110 + 65 + 92, // п.3=3, п.5=2, п.15=3
    СЗ: 57 + 86, // п.10=1, п.11=2
  };
  for (const s of SCALES) assert.equal(r.sub.subscales[s.code].raw, hand[s.code], s.code);
  // станайны по таблицам: общий 30 → взрослые 9 (27+), девушки 8 (26–30)
  assert.deepEqual(r.sub.total.stanine, { adult: 9, girls: 8 });
  // ручной разбор по таблицам: ЭД 174 → 8 / 7; АСТ 160 → 7 / 7; ФОБ 209 → 9 / 9; ОП 267 → 9 / 9; СЗ 143 → 6 / 5
  const st = Object.fromEntries(SCALES.map((x) => [x.code, r.sub.subscales[x.code].stanine]));
  assert.deepEqual(st, {
    ЭД: { adult: 8, girls: 7 },
    АСТ: { adult: 7, girls: 7 },
    ФОБ: { adult: 9, girls: 9 },
    ОП: { adult: 9, girls: 9 },
    СЗ: { adult: 6, girls: 5 },
  });
});

test('ИТТ: группа норм — «Девушки» только при женском поле и возрастной группе 18–24', () => {
  assert.deepEqual(pickGroup({ sex: 'f', age_band: '18-24' }), { group: 'girls', reason: 'female_young' });
  assert.equal(pickGroup({ sex: 'f', age_band: '25-34' }).group, 'adult');
  assert.equal(pickGroup({ sex: 'm', age_band: '18-24' }).group, 'adult');
  assert.deepEqual(pickGroup({ sex: null, age_band: null }), { group: 'adult', reason: 'no_data' });
  assert.deepEqual(pickGroup(null), { group: 'adult', reason: 'no_data' });
});

test('ИТТ: пациент видит 15 пунктов и инструкцию; методики назначаются врачом по одной и пакетом', async () => {
  const doc = await ctx.as('psy1');
  const patient = await ctx.as('patA');
  const list = expectOk(await doc.get('/api/v1/instruments')).items;
  for (const [code, title] of [
    ['itt_l', itt_l.title],
    ['itt_s', itt_s.title],
  ]) {
    const row = list.find((i) => i.code === code);
    assert.ok(row && row.title === title, code);
    assert.equal(row.self_service, 0);
  }
  const a = await F.assignTest(ctx.app, doc, ctx.id('patA'), 'itt_l');
  const r = expectOk(await patient.get(`/api/v1/me/assignments/${a.id}`));
  assert.equal(r.title, 'Опросник состояния: как обычно');
  assert.deepEqual(
    r.questions.map((q) => q.text),
    L_ITEMS,
  );
  assert.match(r.instruction, /КАК ЧАСТО на протяжении последнего времени/);
  for (const q of r.questions) {
    assert.equal(q.type, 'single');
    assert.equal(q.required, true);
    assert.equal(q.crisis_item, false);
    assert.deepEqual(
      q.options.map((o) => [o.value, o.label, o.score]),
      OPT_L,
    );
  }
  expectError(await patient.post('/api/v1/me/self-tests', { instrument_code: 'itt_l' }), 403, 'E-INSTRUMENT-LICENSE');
  expectOk(await patient.put(`/api/v1/me/assignments/${a.id}/answers/q1`, { value: '0' }));
  expectError(await patient.put(`/api/v1/me/assignments/${a.id}/answers/q1`, { value: '4' }), 422, 'E-VALIDATION');
  expectOk(await doc.post(`/api/v1/assignments/${a.id}/cancel`, {}));
  // пакет «ИТТ»: обе шкалы вместе
  const doc2 = await ctx.as('psy2');
  const pkg = expectOk(await doc2.post('/api/v1/packages', { title: 'ИТТ', items: ['itt_l', 'itt_s'] }));
  const made = expectOk(await doc2.post(`/api/v1/patients/${ctx.id('patB')}/assignments`, { package_id: pkg.id }));
  assert.deepEqual(made.items.map((i) => i.instrument_code).sort(), ['itt_l', 'itt_s']);
  const patB = await ctx.as('patB');
  await F.passUndoWindow(ctx.app);
  const mine = expectOk(await patB.get('/api/v1/me/assignments')).items.filter((i) => i.package_id === pkg.id);
  assert.equal(mine.length, 2);
  assert.deepEqual(mine[0].progress, { total: 2, done: 0 });
});

test('ИТТ: кризис — ни один пункт (в т.ч. q9, q19-подобные id и слово «вред») не даёт crisis', async () => {
  const doc = await ctx.as('psy2');
  const patient = await ctx.as('patB');
  const crisesBefore = ctx.app.query(
    "SELECT count(*) n FROM crisis_escalations WHERE patient_id=? AND source='test'",
    ctx.id('patB'),
  )[0].n;
  for (const code of ['itt_l', 'itt_s']) {
    const open = ctx.app.query(
      "SELECT id FROM instrument_assignments WHERE patient_id=? AND instrument=? AND status IN ('pending','in_progress')",
      ctx.id('patB'),
      code,
    );
    const a = open.length ? open[0] : await F.assignTest(ctx.app, doc, ctx.id('patB'), code);
    for (let n = 1; n <= 15; n++)
      for (const value of ['3', '1'])
        assert.equal(
          expectOk(await patient.put(`/api/v1/me/assignments/${a.id}/answers/q${n}`, { value })).crisis,
          undefined,
          `${code} q${n}=${value}`,
        );
  }
  const crisesAfter = ctx.app.query(
    "SELECT count(*) n FROM crisis_escalations WHERE patient_id=? AND source='test'",
    ctx.id('patB'),
  )[0].n;
  assert.equal(crisesAfter, crisesBefore);
});

for (const [name, code, valueOf, total] of [
  ['СТ-Л, все 0', 'itt_l', () => 0, 0],
  ['СТ-Л, все 3', 'itt_l', () => 3, 45],
  ['СТ-С, смешанный набор', 'itt_s', (n) => (n % 3) + 1, null],
]) {
  test(`ИТТ: сервер считает «${name}» по ручному эталону; пациент не получает балл и станайны`, async () => {
    const { doc, a, res } = await submitWith('psy1', 'patA', code, valueOf);
    const out = expectOk(res);
    for (const k of ['score', 'band', 'subscales', 'total', 'stanine']) assert.equal(out[k], undefined, k);
    assert.equal(out.band_note_key, 'msg.test.not_diagnosis');
    const row = rowOf(a);
    const expTotal = Array.from({ length: 15 }, (_x, i) => valueOf(i + 1)).reduce((x, y) => x + y, 0);
    if (total !== null) assert.equal(expTotal, total);
    assert.equal(row.total_score, expTotal);
    assert.equal(row.band, 'Показатели рассчитаны');
    const sub = JSON.parse(row.subscales_json);
    assert.equal(sub.total.raw, expTotal);
    for (const s of SCALES) {
      const hand = s.items.reduce((acc, n) => {
        const x = valueOf(n);
        return acc + (x ? KEY[n - 1].coef[x] : 0);
      }, 0);
      assert.equal(sub.subscales[s.code].raw, hand, s.code);
    }
    assert.equal(sub.norm_group, 'adult');
    const block = (await resultsOf(doc, 'patA')).find((r) => r.id === row.id).itt;
    assert.equal(block.total.raw, expTotal);
    assert.equal(block.rows.length, 5);
  });
}

test('ИТТ: группа «Девушки» выбирается сервером по профилю, станайны считаются по обеим группам', async () => {
  ctx.app.exec(`UPDATE users SET sex='f', age_band='18-24' WHERE id=${ctx.id('patA')}`);
  const { doc, a } = await submitWith('psy1', 'patA', 'itt_l', () => 2);
  const row = rowOf(a);
  const sub = JSON.parse(row.subscales_json);
  assert.equal(sub.norm_group, 'girls');
  assert.equal(sub.norm_group_reason, 'female_young');
  // 30 баллов: взрослые 27+ → 9, девушки 26–30 → 8
  assert.deepEqual(sub.total.stanine, { adult: 9, girls: 8 });
  const b = (await resultsOf(doc, 'patA')).find((r) => r.id === row.id).itt;
  assert.equal(b.applied_group, 'girls');
  assert.deepEqual(b.total.stanine, { adult: 9, girls: 8 });
  ctx.app.exec(`UPDATE users SET sex='m', age_band='35-44' WHERE id=${ctx.id('patA')}`);
  const second = await submitWith('psy1', 'patA', 'itt_l', () => 2);
  assert.equal(JSON.parse(rowOf(second.a).subscales_json).norm_group_reason, 'default');
});

test('ИТТ: врач получает блок — группа и причина, общий показатель, 5 субшкал, интерпретации, сравнение, динамика', async () => {
  const { doc } = await submitWith('psy1', 'patA', 'itt_s', (n) => (n % 3) + 1);
  const all = await resultsOf(doc, 'patA');
  const sBlock = all.find((r) => r.instrument === 'itt_s').itt;
  assert.equal(sBlock.scale, 'S');
  assert.deepEqual(
    sBlock.groups.map((g) => g.label),
    ['Взрослые и юноши', 'Девушки'],
  );
  assert.ok(['adult', 'girls'].includes(sBlock.applied_group));
  assert.ok(sBlock.applied_reason);
  assert.equal(sBlock.high_from, 7);
  assert.deepEqual(
    sBlock.rows.map((x) => x.code),
    ['ЭД', 'АСТ', 'ФОБ', 'ОП', 'СЗ'],
  );
  for (const x of sBlock.rows) {
    assert.ok(Number.isInteger(x.raw) && x.stanine.adult >= 1 && x.stanine.girls <= 9);
    assert.ok(x.interpretation.startsWith('Высокие показатели') || x.code === 'СЗ');
  }
  assert.equal(sBlock.rows[0].interpretation, N.INTERPRETATIONS.ЭД);
  assert.ok(sBlock.pair && sBlock.pair.scale === 'L', 'сравнение с СТ-Л');
  assert.ok(sBlock.history.length >= 1, 'динамика');
  assert.equal(sBlock.note_key, 'msg.itt.disclaimer');
  assert.doesNotMatch(JSON.stringify(sBlock), /патолог|диагноз:|норма/i);
  // в общем списке результатов у пациента-врача балл есть, а у ИТТ именно блок
  assert.ok(all.every((r) => r.itt));
});

test('ИТТ: список результатов пациента без балла и полосы', async () => {
  const { patient } = await submitWith('psy1', 'patA', 'itt_l', () => 1);
  const series = expectOk(await patient.get('/api/v1/me/results')).series.filter((r) =>
    r.instrument.startsWith('itt_'),
  );
  assert.ok(series.length >= 1);
  for (const r of series) {
    assert.equal(r.total_score, null);
    assert.equal(r.band, null);
  }
});

test('ИТТ: чужой врач — 404, пациент — не 200; чужое назначение пациенту недоступно', async () => {
  const other = await ctx.as('psy2');
  const patient = await ctx.as('patA');
  assert.equal((await other.get(`/api/v1/patients/${ctx.id('patA')}?tab=tests`)).status, 404);
  assert.ok([403, 404].includes((await patient.get(`/api/v1/patients/${ctx.id('patA')}?tab=tests`)).status));
  const a = await F.assignTest(ctx.app, other, ctx.id('patB'), 'itt_s').catch(() => null);
  if (a) assert.equal((await patient.get(`/api/v1/me/assignments/${a.id}`)).status, 404);
});
