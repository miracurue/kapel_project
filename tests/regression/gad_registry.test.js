'use strict';
// covers: GAD demo appendix catalogue, source-reference modes and stable method links.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  APPENDICES,
  REFERENCE_DEFS,
  resolveAppendix,
  policyForCode,
  catalogMode,
} = require('../../src/modules/clinical/instruments/gad_registry');

test('Г1–Г16 resolve to stable catalogue links; both Г4 forms share one appendix', () => {
  assert.equal(APPENDICES.length, 16);
  for (let n = 1; n <= 16; n++) {
    const row = resolveAppendix(`app:Г${n}`);
    assert.ok(row);
    assert.equal(row.appendix, `Г${n}`);
    assert.equal(row.href, `/work?tab=tools&tool=${row.code}`);
    assert.ok(row.codes.includes(row.code));
  }
  assert.deepEqual(resolveAppendix('Г4').codes, ['itt_l', 'itt_s']);
  assert.equal(policyForCode('itt_s').appendix, 'Г4');
  assert.equal(policyForCode('itt_s').href, '/work?tab=tools&tool=itt_s');
  assert.equal(resolveAppendix('app:Г21'), null);
  assert.equal(resolveAppendix(null), null);
  assert.equal(catalogMode('unknown'), null);
});

test('readiness and intended ability to assign remain distinct', () => {
  assert.equal(catalogMode('hars'), 'reference_only');
  assert.equal(policyForCode('hars').intended_assignable, false);
  for (const row of APPENDICES.slice(1, 7)) {
    assert.equal(row.mode, 'assignable');
    assert.equal(row.assignable, true);
  }
  for (const row of APPENDICES.slice(7)) {
    assert.equal(row.mode, 'awaiting_text');
    assert.equal(row.assignable, false);
    assert.equal(row.intended_assignable, true);
    const def = REFERENCE_DEFS.find((entry) => entry.code === row.code);
    assert.deepEqual(def.items, []);
    assert.deepEqual(def.options, []);
    assert.deepEqual(def.bands, []);
    assert.equal(def.selfService, false);
    assert.equal(def.meta.note, 'Скоро появится');
    assert.ok(def.meta.purpose);
    assert.ok(def.meta.sources.length);
    assert.equal(def.meta.review_required, true);
  }
});

test('HARS preserves its 14 source symptoms and clinician-only reference key', () => {
  const hars = REFERENCE_DEFS.find((entry) => entry.code === 'hars');
  assert.equal(hars.items.length, 14);
  assert.match(hars.items[0], /^Тревожное настроение \(/);
  assert.match(hars.items[13], /^Поведение при осмотре \(/);
  for (const item of hars.items) {
    assert.ok(item.includes('('));
    assert.doesNotMatch(item, /В слабой степени|В умеренной степени/);
  }
  assert.match(hars.meta.instruction, /Не следует предъявлять шкалу пациенту/);
  assert.equal(hars.selfService, false);
  assert.equal(hars.scoring.type, 'reference');
  assert.deepEqual(
    hars.options.map((entry) => entry.score),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(
    hars.bands.map(({ min, max }) => [min, max]),
    [
      [0, 7],
      [8, 17],
      [18, 24],
      [25, 56],
    ],
  );
  assert.deepEqual(
    hars.scoring.scales.map(({ items }) => items),
    [
      [1, 2, 3, 4, 5, 6],
      [7, 8, 9, 10, 11, 12, 13, 14],
    ],
  );
});
