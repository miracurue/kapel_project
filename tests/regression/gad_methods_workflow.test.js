'use strict';
// covers: ГТР demo catalogue, server assignment gates, role-aware completion and version preservation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const { APPENDICES } = require('../../src/modules/clinical/instruments/gad_registry');
const ctx = useApp();

test('all Г1–Г16 cards are present with persistent modes, reference questions and future placeholders', async () => {
  const doctor = await ctx.as('psy1');
  const list = expectOk(await doctor.get('/api/v1/instruments')).items;
  for (const link of APPENDICES)
    for (const code of link.codes) {
      const card = list.find((i) => i.code === code);
      assert.ok(card, code);
      assert.equal(card.mode, link.mode);
      assert.equal(card.assignable, link.assignable);
      assert.equal(card.href, `/work?tab=tools&tool=${code}`);
      assert.equal(card.preview.review_required, true);
      const saved = ctx.app.query(
        'SELECT schema_json FROM instrument_versions WHERE instrument_code=? ORDER BY version DESC LIMIT 1',
        code,
      )[0];
      assert.equal(JSON.parse(saved.schema_json).meta.mode, link.mode);
      if (link.mode === 'awaiting_text') {
        assert.equal(card.preview.question_count, 0);
        assert.match(card.preview.note, /Скоро появится/);
      }
    }
  assert.equal(list.find((i) => i.code === 'hars').preview.question_count, 14);
  assert.equal(list.find((i) => i.code === 'stai').preview.scales.length, 2);
});

test('reference and future tests cannot be assigned directly, through packages, or by self-service', async () => {
  const doc = await ctx.as('psy1');
  const patient = await ctx.as('patA');
  const before = ctx.app.query('SELECT count(*) n FROM instrument_assignments')[0].n;
  for (const code of [
    'hars',
    'mmpi',
    'ista',
    'usk',
    'personal_beliefs',
    'lsi',
    'coping',
    'melbourne',
    'kon2006',
    'kop25',
  ]) {
    const blocked = await doc.post(`/api/v1/patients/${ctx.id('patA')}/assignments`, { instrument_code: code });
    expectError(blocked, 403, 'E-INSTRUMENT-LICENSE');
    assert.equal(blocked.body.error.fields[0].key, 'msg.tests.not_assignable');
    expectError(await patient.post('/api/v1/me/self-tests', { instrument_code: code }), 403, 'E-INSTRUMENT-LICENSE');
    expectError(
      await doc.post('/api/v1/packages', { title: 'Blocked', items: ['gad7', code] }),
      403,
      'E-INSTRUMENT-LICENSE',
    );
  }
  assert.equal(ctx.app.query('SELECT count(*) n FROM instrument_assignments')[0].n, before);
  const pack = expectOk(await doc.post('/api/v1/packages', { title: 'Editable', items: ['gad7', 'bai'] }));
  expectError(await doc.put(`/api/v1/packages/${pack.id}`, { items: ['gad7', 'hars'] }), 403, 'E-INSTRUMENT-LICENSE');
  assert.deepEqual(
    JSON.parse(ctx.app.query('SELECT items_json FROM package_templates WHERE id=?', pack.id)[0].items_json),
    ['gad7', 'bai'],
  );
  const db = ctx.app.db();
  try {
    db.prepare('UPDATE package_templates SET items_json=? WHERE id=?').run(JSON.stringify(['gad7', 'hars']), pack.id);
  } finally {
    db.close();
  }
  expectError(
    await doc.post(`/api/v1/patients/${ctx.id('patA')}/assignments`, { package_id: pack.id }),
    403,
    'E-INSTRUMENT-LICENSE',
  );
  assert.equal(ctx.app.query('SELECT count(*) n FROM instrument_assignments')[0].n, before);
});

test('completion identifies the assigning role, hides scores on retry/history, and preserves clinician access', async () => {
  const patient = await ctx.as('patA');
  for (const [who, code, role, key] of [
    ['psy1', 'bai', 'psychiatrist', 'doctor'],
    ['plg1', 'shars', 'psychologist', 'psychologist'],
  ]) {
    const doc = await ctx.as(who);
    const a = await F.assignTest(ctx.app, doc, ctx.id('patA'), code);
    const result = expectOk(await F.completeTest(patient, a.id));
    assert.equal(result.completion_key, `msg.tests.result.${key}`);
    assert.equal(result.assigned_role, role);
    assert.equal(result.score, undefined);
    assert.equal(result.band, undefined);
    const retry = expectOk(await patient.post(`/api/v1/me/assignments/${a.id}/submit`, {}));
    assert.equal(retry.id, result.id);
    assert.equal(retry.score, undefined);
    const visible = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}?tab=tests`)).results.find(
      (r) => r.id === result.id,
    );
    assert.equal(visible.total_score, 0);
    const history = expectOk(await patient.get('/api/v1/me/results')).series.find((r) => r.id === result.id);
    assert.equal(history.total_score, null);
    assert.equal(history.completion_key, result.completion_key);
  }
});

test('self test shares only on explicit action; role and patient boundaries remain enforced', async () => {
  const doc = await ctx.as('psy2');
  const patient = await ctx.as('patB');
  const a = expectOk(await patient.post('/api/v1/me/self-tests', { instrument_code: 'gad7' }));
  const result = expectOk(await F.completeTest(patient, a.id));
  assert.equal(result.completion_key, 'msg.tests.result.self');
  assert.equal(result.score, undefined);
  const results = () => doc.get(`/api/v1/patients/${ctx.id('patB')}?tab=tests`);
  assert.ok(!expectOk(await results()).results.some((r) => r.id === result.id));
  expectOk(await patient.post(`/api/v1/me/results/${result.id}/share`, {}));
  assert.ok(expectOk(await results()).results.some((r) => r.id === result.id));
  assert.equal(
    expectOk(await patient.get('/api/v1/me/results')).series.find((r) => r.id === result.id).completion_key,
    'msg.tests.result.shared',
  );
  expectError(await (await ctx.as('patA')).get(`/api/v1/me/assignments/${a.id}`), 404, 'E-NOT-FOUND');
  expectError(await (await ctx.as('psy1')).get(`/api/v1/patients/${ctx.id('patB')}?tab=tests`), 404, 'E-NOT-FOUND');
  expectError(await (await ctx.as('admin1')).get('/api/v1/instruments'), 403, 'E-ACCESS');
});

test('started assignment keeps its version and results across catalogue revision and restart', async () => {
  const doc = await ctx.as('psy1');
  const patient = await ctx.as('patA');
  const a = await F.assignTest(ctx.app, doc, ctx.id('patA'), 'gad7');
  const version = ctx.app.query('SELECT instrument_version v FROM instrument_assignments WHERE id=?', a.id)[0].v;
  const current = ctx.app.query(
    'SELECT * FROM instrument_versions WHERE instrument_code=? AND version=?',
    'gad7',
    version,
  )[0];
  const schema = JSON.parse(current.schema_json);
  schema.questions[0].options[0].score = 100;
  const db = ctx.app.db();
  try {
    db.prepare(
      "INSERT INTO instrument_versions(instrument_code,version,schema_json,scoring_json,bands_json,is_stand_in,status) VALUES ('gad7',?,?,?,?,0,'published')",
    ).run(version + 1, JSON.stringify(schema), current.scoring_json, current.bands_json);
    db.prepare("UPDATE instruments SET current_version=? WHERE code='gad7'").run(version + 1);
  } finally {
    db.close();
  }
  const result = expectOk(await F.completeTest(patient, a.id));
  const saved = ctx.app.query('SELECT total_score,instrument_version FROM online_results WHERE id=?', result.id)[0];
  assert.equal(saved.total_score, 0);
  assert.equal(saved.instrument_version, version);
  const count = ctx.app.query('SELECT count(*) n FROM instrument_versions')[0].n;
  await ctx.app.restart();
  assert.equal(ctx.app.query('SELECT count(*) n FROM instrument_versions')[0].n, count);
  assert.equal(ctx.app.query("SELECT current_version v FROM instruments WHERE code='gad7'")[0].v, version + 1);
  assert.deepEqual(
    ctx.app.query('SELECT total_score,instrument_version FROM online_results WHERE id=?', result.id)[0],
    saved,
  );
});
