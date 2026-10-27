'use strict';
// covers: единый реестр методик клинреков — резолвер, карточки «Скоро появится», серверный запрет назначения.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const R = require('../../src/modules/clinical/instruments/clinrec_methods');
const ctx = useApp();

const SOURCE = path.join(__dirname, '../../knowledge/clinrecs/methods_registry.json');
const NEW_CODES =
  `cssrs_full hcl32 hcl33 flybocs vegetative_q pdss phq_panic ecr_r ace tsq caps scid_ptsd ies_r ms_ptsd ces_combat psychophys_stress pdeq des bhs top8 panss psp nddi_e phq2 phq4 gad2`.split(
    ' ',
  );
const SOON_OLD = ['ymrs', 'hdrs17', 'madrs'];

test('все 47 кодов реестра резолвятся в карточку со ссылкой; код один на методику', () => {
  assert.equal(R.METHODS.length, 47);
  assert.equal(new Set(R.METHODS.map((m) => m.code)).size, 47);
  if (fs.existsSync(SOURCE)) {
    const src = JSON.parse(fs.readFileSync(SOURCE, 'utf8')).methods;
    assert.deepEqual(
      R.METHODS.map((m) => m.code),
      src.map((m) => m.code),
    );
  }
  for (const m of R.METHODS) {
    const v = R.resolveCode(m.code);
    assert.ok(v, m.code);
    assert.equal(v.href, `/work?tab=tools&tool=${m.code}`);
    assert.ok(v.title);
    for (const s of m.sources.filter((x) => x.app_label))
      assert.ok(R.resolveApp(s.doc, s.app_label), `${m.code} ${s.doc}`);
  }
  assert.equal(R.resolveCode('itt_s').href, '/work?tab=tools&tool=itt_s');
  assert.equal(R.resolveCode('nope'), null);
  assert.equal(R.resolveApp('02_gad', 'app:Г2').code, 'gad7');
  assert.equal(R.resolveApp('01_bipolar', 'app:Г1').code, 'cssrs_full');
});

test('26 новых кодов — «Скоро появится», без назначения; реализованные не изменились', () => {
  assert.equal(NEW_CODES.length, 26);
  for (const code of [...NEW_CODES, ...SOON_OLD]) {
    const v = R.resolveCode(code);
    assert.equal(v.status, 'soon', code);
    assert.equal(v.assignable, false, code);
  }
  assert.equal(R.METHODS.filter((m) => !m.in_system).length, 26);
  assert.equal(R.resolveCode('gad7').assignable, true);
  assert.equal(R.resolveCode('hars').status, 'reference');
  assert.equal(R.resolveCode('mmpi').status, 'soon');
  assert.notEqual(R.resolveCode('cssrs_full'), R.resolveCode('cssrs'));
  const defs = R.soonDefs();
  assert.equal(defs.length, 29);
  for (const d of defs) {
    assert.deepEqual(d.items, []);
    assert.deepEqual(d.bands, []);
    assert.equal(d.selfService, false);
    assert.equal(d.meta.note, 'Скоро появится');
    assert.ok(d.meta.sources.length);
  }
});

test('резолвер находит методики во фрагменте markdown (ссылки и метки)', () => {
  const md = [
    'Шкала [Приложение Г2](app:Г2 "instrument:gad7") и [см. Г4](app:Г4 "instrument:itt_l,itt_s").',
    'Опросник [Приложение Г2](app:Г2 "instrument:hcl32"), повтор [Г2](app:Г2 "instrument:hcl32").',
    '<!-- id: app:Г1; kind: method; instrument: cssrs_full -->',
    '[без метода](app:В) и [неизвестный](app:Д "instrument:zzz")',
  ].join('\n');
  const got = R.findMethods(md);
  assert.deepEqual(
    got.map((m) => m.code),
    ['gad7', 'itt_l', 'hcl32', 'cssrs_full'],
  );
  const itt = got.find((m) => m.code === 'itt_l');
  assert.deepEqual(itt.codes, ['itt_l', 'itt_s']);
  assert.equal(got.find((m) => m.code === 'hcl32').href, '/work?tab=tools&tool=hcl32');
  assert.equal(got.find((m) => m.code === 'hcl32').status, 'soon');
  assert.deepEqual(R.findMethods('', {}), []);
  assert.deepEqual(R.findMethods(null), []);
});

test('каталог специалиста показывает все карточки «Скоро появится»; назначение запрещено сервером', async () => {
  const doc = await ctx.as('psy1');
  const patient = await ctx.as('patA');
  const list = expectOk(await doc.get('/api/v1/instruments')).items;
  for (const code of [...NEW_CODES, ...SOON_OLD]) {
    const card = list.find((i) => i.code === code);
    assert.ok(card, code);
    assert.equal(card.mode, 'awaiting_text');
    assert.equal(card.assignable, false);
    assert.equal(card.preview.question_count, 0);
    assert.match(card.preview.note, /Скоро появится/);
  }
  assert.equal(list.find((i) => i.code === 'cssrs_full').title.includes('Колумбийская'), true);
  assert.equal(
    list.find((i) => i.code === 'cssrs'),
    undefined,
  );
  assert.equal(list.find((i) => i.code === 'gad7').assignable, true);
  const before = ctx.app.query('SELECT count(*) n FROM instrument_assignments')[0].n;
  for (const code of [...NEW_CODES, ...SOON_OLD]) {
    expectError(
      await doc.post(`/api/v1/patients/${ctx.id('patA')}/assignments`, { instrument_code: code }),
      403,
      'E-INSTRUMENT-LICENSE',
    );
    expectError(await patient.post('/api/v1/me/self-tests', { instrument_code: code }), 403, 'E-INSTRUMENT-LICENSE');
  }
  assert.equal(ctx.app.query('SELECT count(*) n FROM instrument_assignments')[0].n, before);
});
