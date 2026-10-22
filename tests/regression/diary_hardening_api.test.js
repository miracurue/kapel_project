'use strict';
// covers: F-39 F-52 F-53 normalized diary lifecycle.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk } = require('../lib/client');
const { PASSWORD } = require('../fixtures/world');
const ctx = useApp();
test('bounded API saves with 5100 old notes; archived history exports and erases completely', async () => {
  const p = await ctx.as('patB');
  const pid = ctx.id('patB');
  ctx.app.exec(
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5100) INSERT INTO diary_day_notes(patient_id,note_id,day,text,shared) SELECT ${pid},'old-'||x,'2020-01-01','OLD_PRIVATE_CANARY',0 FROM n`,
  );
  let w = expectOk(await p.get('/api/v1/me/diary-workspace?window=90'));
  assert.equal(w.state.dayNotes.length, 0);
  w.state.habits.push({ id: 'h', name: 'h', type: 'count', shared: false, unit: 'times' });
  w.state.entries.h = { [w.today]: [1, 2] };
  w.state.dayNotes.push({ id: 'new-note', day: w.today, text: 'REVISION_FIRST_CANARY', shared: false });
  w = expectOk(await p.put('/api/v1/me/diary-workspace', { revision: w.revision, state: w.state, window: w.window }));
  assert.equal(ctx.app.query('SELECT count(*) n FROM diary_day_notes WHERE patient_id=?', pid)[0].n, 5101);
  const historical = expectOk(await p.get('/api/v1/me/diary-workspace?from=2020-01-01&to=2020-01-31'));
  assert.equal(historical.state.dayNotes.length, 5100);
  w.state.habits[0].name = 'Renamed';
  w.state.entries.h[w.today][0] = 3;
  w.state.dayNotes.find((n) => n.id === 'new-note').text = 'REVISION_SECOND_CANARY';
  w = expectOk(await p.put('/api/v1/me/diary-workspace', { revision: w.revision, state: w.state, window: w.window }));
  assert.equal(ctx.app.query('SELECT count(*) n FROM diary_note_revisions WHERE patient_id=?', pid)[0].n, 1);
  w.state.habits = [];
  w.state.entries = {};
  expectOk(await p.put('/api/v1/me/diary-workspace', { revision: w.revision, state: w.state, window: w.window }));
  assert.equal(ctx.app.query('SELECT count(*) n FROM diary_habit_values WHERE patient_id=?', pid)[0].n, 3);
  const e = expectOk(await p.post('/api/v1/me/exports', { password: PASSWORD, format: 'zip_json_pdf' }));
  const zip = await p.get(new URL(e.link, ctx.app.base).pathname, { binary: true });
  assert.equal(zip.status, 200);
  assert.ok(zip.body.includes(Buffer.from('REVISION_FIRST_CANARY')));
  assert.ok(zip.body.includes(Buffer.from('OLD_PRIVATE_CANARY')));
  assert.ok(zip.body.includes(Buffer.from('measurements')));
  assert.ok(zip.body.includes(Buffer.from('hidden_at')));
  expectOk(await p.post('/api/v1/me/deletion-request', { password: PASSWORD, confirm: true }));
  const admin = await ctx.as('admin1');
  const q = expectOk(await admin.get('/api/v1/admin/requests?filter=open')).items.find((i) => i.kind === 'erasure');
  expectOk(
    await admin.post(`/api/v1/admin/requests/${q.id}/execute-erasure`, {
      confirm_service_no: q.patient_no,
      confirm: true,
    }),
  );
  for (const table of [
    'diary_habits',
    'diary_habit_versions',
    'diary_habit_values',
    'diary_day_notes',
    'diary_note_revisions',
    'diary_workspaces',
  ])
    assert.equal(ctx.app.query(`SELECT count(*) n FROM ${table} WHERE patient_id=?`, pid)[0].n, 0, table);
  assert.equal(ctx.app.query('SELECT count(*) n FROM analytics_product_activity WHERE user_id=?', pid)[0].n, 0);
  assert.equal(ctx.app.query('SELECT count(*) n FROM analytics_subjects WHERE patient_id=?', pid)[0].n, 0);
  assert.deepEqual(ctx.app.query('PRAGMA foreign_key_check'), []);
});
