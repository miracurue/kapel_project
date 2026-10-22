'use strict';
// covers: Г5, .agents/tasks/2026-10-21-gad-methods-digitization.md
const { test } = require('node:test');
const assert = require('node:assert/strict');
const def = require('../../src/modules/clinical/instruments/stai');
const { scoreStai } = require('../../src/modules/clinical/instruments/stai_score');
const { useApp } = require('../lib/suite');
const { expectOk } = require('../lib/client');
const F = require('../lib/flows');
const ctx = useApp();
const uniform = (value) => Object.fromEntries(Array.from({ length: 40 }, (_, n) => [`q${n + 1}`, String(value)]));

// Independent source fixtures: PDF p.103, literal key (not conventional corrected STAI key).
const direct = [3, 4, 6, 7, 9, 12, 14, 15, 17, 18, 22, 23, 24, 25, 28, 29, 31, 32, 34, 35, 37, 38, 40];
const reactiveDirect = direct.filter((n) => n <= 20);
const personalDirect = direct.filter((n) => n > 20);

test('STAI: 40 source items, 1–4 options, separate now/usual instructions and source ambiguity disclosed', () => {
  assert.equal(def.items.length, 40);
  assert.deepEqual(
    def.options.map((o) => [o.value, o.score]),
    [
      ['1', 1],
      ['2', 2],
      ['3', 3],
      ['4', 4],
    ],
  );
  assert.equal(def.items[12], 'Я не нахожу себе места');
  assert.equal(def.items[14], 'Я не чувствую скованности, напряжения');
  assert.equal(def.items[32], 'Я чувствую себя беззащитным');
  assert.deepEqual(def.scoring.subscales[0].direct, reactiveDirect);
  assert.deepEqual(def.scoring.subscales[1].direct, personalDirect);
  assert.deepEqual(def.scoring.subscales[0].reverse, [1, 2, 5, 8, 10, 11, 13, 16, 19, 20]);
  assert.deepEqual(def.scoring.subscales[1].reverse, [21, 26, 27, 30, 33, 36, 39]);
  assert.equal(def.scoring.subscales[0].offset, 50);
  assert.equal(def.scoring.subscales[1].offset, 35);
  assert.match(def.meta.instruction, /1–20.*данный момент.*21–40.*обычно/);
  assert.ok(def.meta.source_ambiguities.length);
  assert.deepEqual(def.crisisItems, []);
});

test('STAI: literal source formulas yield independent minimum 20, maximum 80 and uniform 50/41', () => {
  const low = uniform(4);
  const high = uniform(1);
  for (const n of direct) {
    low[`q${n}`] = '1';
    high[`q${n}`] = '4';
  }
  assert.deepEqual(scoreStai(low, def.scoring).sub, {
    reactive: { raw: 20, band: 'Низкая тревога (тревожность)' },
    personal: { raw: 20, band: 'Низкая тревога (тревожность)' },
  });
  const max = scoreStai(high, def.scoring);
  assert.equal(max.total, 80);
  assert.equal(max.sub.personal.raw, 80);
  const same = scoreStai(uniform(1), def.scoring);
  assert.equal(same.total, 50);
  assert.equal(same.sub.personal.raw, 41);
  for (const value of [undefined, '', null, '0', '5', '1.5', 'NaN'])
    assert.throws(() => scoreStai({ ...uniform(1), q1: value }, def.scoring));
});

test('STAI: source bands cover 30/31 and 44/45 without merging scales', () => {
  for (const target of [20, 30, 31, 44, 45, 80]) {
    const answers = uniform(4);
    for (const n of direct) answers[`q${n}`] = '1';
    for (const s of def.scoring.subscales) {
      let remainder = target - 20;
      for (const n of [...s.direct, ...s.reverse]) {
        const step = Math.min(3, remainder);
        answers[`q${n}`] = String(s.direct.includes(n) ? 1 + step : 4 - step);
        remainder -= step;
      }
    }
    const result = scoreStai(answers, def.scoring);
    assert.equal(result.sub.reactive.raw, target);
    assert.equal(result.sub.personal.raw, target);
    assert.equal(
      result.sub.personal.band,
      target <= 30
        ? 'Низкая тревога (тревожность)'
        : target <= 44
          ? 'Умеренная тревога (тревожность)'
          : 'Высокая тревога (тревожность)',
    );
  }
});

test('STAI: assignment completes with separate stored scales; patient receives no scores', async () => {
  const doc = await ctx.as('psy1');
  const patient = await ctx.as('patA');
  const a = await F.assignTest(ctx.app, doc, ctx.id('patA'), 'stai');
  const result = expectOk(await F.completeTest(patient, a.id, () => '1'));
  assert.equal(result.score, undefined);
  assert.equal(result.band, undefined);
  const saved = ctx.app.query('SELECT total_score,subscales_json FROM online_results WHERE assignment_id=?', a.id)[0];
  assert.equal(saved.total_score, 50);
  assert.equal(JSON.parse(saved.subscales_json).personal.raw, 41);
});
