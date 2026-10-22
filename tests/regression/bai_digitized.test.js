'use strict';
// covers: Г6, .agents/tasks/2026-10-21-gad-methods-digitization.md
const { test } = require('node:test');
const assert = require('node:assert/strict');
const def = require('../../src/modules/clinical/instruments/bai');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const ctx = useApp();

test('BAI: source item count, response range and all PDF thresholds', () => {
  assert.equal(def.items.length, 21);
  assert.equal(def.options.length, 4);
  assert.deepEqual(
    def.options.map((o) => o.score),
    Array.from({ length: 4 }, (_, n) => n),
  );
  assert.deepEqual(
    def.bands.map((b) => [b.min, b.max]),
    [
      [0, 9],
      [10, 21],
      [22, 35],
      [36, 63],
    ],
  );
  assert.deepEqual(def.crisisItems, []);
  assert.equal(def.scoring.patient_hides_result, true);
  assert.equal(def.scoring.review_required, true);
  assert.match(def.meta.instruction, /недели|НЕДЕЛИ/);
});

test('BAI: assigned questions preserve source text, invalid answer rejected, maximum stored and hidden', async () => {
  const doc = await ctx.as('psy1');
  const patient = await ctx.as('patA');
  const a = await F.assignTest(ctx.app, doc, ctx.id('patA'), 'bai');
  const qs = await F.instrumentQuestions(patient, a.id);
  assert.deepEqual(
    qs.map((q) => q.text),
    def.items,
  );
  expectError(
    await patient.put(`/api/v1/me/assignments/${a.id}/answers/${qs[0].id}`, { value: '99' }),
    422,
    'E-VALIDATION',
  );
  const result = expectOk(await F.completeTest(patient, a.id, () => '3'));
  assert.equal(result.score, undefined);
  assert.equal(result.band, undefined);
  const saved = ctx.app.query('SELECT total_score,band FROM online_results WHERE assignment_id=?', a.id)[0];
  assert.equal(saved.total_score, 63);
  assert.equal(saved.band, def.bands.at(-1).label);
  const crises = ctx.app.query('SELECT count(*) n FROM crisis_escalations WHERE patient_id=?', ctx.id('patA'))[0];
  assert.equal(crises.n, 0);
});
