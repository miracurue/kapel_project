'use strict';
// covers: F-39, F-56, patient ownership, concurrency, privacy and crisis gate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const svc = require('../../src/modules/diary/service');
const ctx = useApp();

test('workspace persists with concurrency and keeps personal notes and habits private', async () => {
  const p = await ctx.as('patA');
  const initial = expectOk(await p.get('/api/v1/me/diary-workspace'));
  const state = structuredClone(initial.state);
  state.habits.push({ id: 'custom-water', name: 'Вода', shared: false, type: 'measure', unit: 'мл' });
  state.entries['custom-water'] = { [initial.today]: [200, 300] };
  state.wellbeings[initial.today] = { mood: 4, anxiety: 0, sleepQuality: 3, sleepHours: 7.5 };
  state.dayNotes.push({ id: 'private-test', day: initial.today, text: 'DIARY_PRIVATE_CANARY', shared: false });
  state.dayNotes.push({ id: 'shared-test', day: initial.today, text: 'Общая запись', shared: true });
  const saved = expectOk(await p.put('/api/v1/me/diary-workspace', { revision: initial.revision, state }));
  assert.equal(saved.revision, initial.revision + 1);
  const loaded = expectOk(await p.get('/api/v1/me/diary-workspace'));
  assert.deepEqual(loaded.state.entries['custom-water'][initial.today], [200, 300]);
  expectError(await p.put('/api/v1/me/diary-workspace', { revision: initial.revision, state }), 409, 'E-CONFLICT');
  const other = await ctx.as('patB');
  assert.ok(!JSON.stringify(expectOk(await other.get('/api/v1/me/diary-workspace'))).includes('DIARY_PRIVATE_CANARY'));
  const doc = await ctx.as('psy1');
  const shared = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}/diary-workspace`));
  assert.ok(!JSON.stringify(shared).includes('DIARY_PRIVATE_CANARY'));
  assert.ok(!JSON.stringify(shared).includes('custom-water'));
  assert.ok(shared.state.dayNotes.some((n) => n.text === 'Общая запись'));
  const foreignDoc = await ctx.as('psy2');
  expectError(await foreignDoc.get(`/api/v1/patients/${ctx.id('patA')}/diary-workspace`), 404, 'E-NOT-FOUND');
  const admin = await ctx.as('admin1');
  expectError(await admin.get(`/api/v1/patients/${ctx.id('patA')}/diary-workspace`), 403, 'E-ACCESS');
  expectError(await doc.put('/api/v1/me/diary-workspace', { revision: 0, state }), 403, 'E-ACCESS');
  const facts = ctx.app.query(
    'SELECT metric,value FROM analytics_facts WHERE patient_id=? AND day=?',
    ctx.id('patA'),
    initial.today,
  );
  assert.equal(facts.find((f) => f.metric === 'anxiety_score').value, 0);
  assert.equal(facts.find((f) => f.metric === 'mood').value, 4);
});

test('past measurements are retained and nested free text reaches crisis detection', async () => {
  const p = await ctx.as('patB');
  const before = expectOk(await p.get('/api/v1/me/diary-workspace'));
  const state = structuredClone(before.state);
  state.wellbeings['2020-01-01'] = { mood: 5 };
  expectError(await p.put('/api/v1/me/diary-workspace', { revision: before.revision, state }), 409, 'E-CONFLICT');
  delete state.wellbeings['2020-01-01'];
  state.dayNotes.push({ id: 'crisis-test', day: before.today, text: 'Хочу покончить с собой', shared: false });
  const result = expectOk(await p.put('/api/v1/me/diary-workspace', { revision: before.revision, state }));
  assert.equal(result.crisis.contacts[0].phone, '112');
});

test('workspace rejects malformed dates and values and collects nested text', () => {
  const state = svc.empty();
  state.wellbeings['2026-02-31'] = { mood: 3 };
  assert.throws(() => svc.normalize(state));
  assert.deepEqual(svc.strings({ state: { notes: [{ text: 'nested' }] } }), ['nested']);
});

test('clearing today and sleep duration only persist without resurrecting old values or losing old notes', async () => {
  const p = await ctx.as('patA');
  let workspace = expectOk(await p.get('/api/v1/me/diary-workspace'));
  const pid = ctx.id('patA');
  ctx.app.exec(
    `INSERT INTO mood_entries(patient_id,entry_date,mood,note,created_at) VALUES (${pid},'${workspace.today}',3,'Legacy note retained','${new Date().toISOString()}')`,
  );
  workspace = expectOk(await p.get('/api/v1/me/diary-workspace'));
  workspace.state.wellbeings[workspace.today] = { sleepHours: 6.5 };
  let saved = expectOk(
    await p.put('/api/v1/me/diary-workspace', { revision: workspace.revision, state: workspace.state }),
  );
  let read = expectOk(await p.get('/api/v1/me/diary-workspace'));
  assert.equal(read.state.wellbeings[workspace.today].sleepHours, 6.5);
  assert.equal(read.state.wellbeings[workspace.today].mood, null);
  assert.ok(read.state.dayNotes.some((n) => n.text === 'Legacy note retained'));
  delete read.state.wellbeings[workspace.today];
  saved = expectOk(await p.put('/api/v1/me/diary-workspace', { revision: saved.revision, state: read.state }));
  read = expectOk(await p.get('/api/v1/me/diary-workspace'));
  assert.equal(read.state.wellbeings[workspace.today].mood, null);
  assert.equal(read.state.wellbeings[workspace.today].sleepHours, null);
  assert.ok(read.state.dayNotes.some((n) => n.text === 'Legacy note retained'));
});

test('workspace enforces CSRF, consent and current assignment on every request', async () => {
  const p = await ctx.as('patH');
  const workspace = expectOk(await p.get('/api/v1/me/diary-workspace'));
  const body = { revision: workspace.revision, state: workspace.state };
  expectError(await p.put('/api/v1/me/diary-workspace', body, { csrf: false }), 403, 'E-CSRF');
  expectError(await p.put('/api/v1/me/diary-workspace', body, { idem: false }), 422, 'E-VALIDATION');
  const pid = ctx.id('patH');
  ctx.app.exec(
    `INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method) SELECT user_id,consent_kind,'revoked',content_version_id,text_sha256,sign_method FROM consent_current WHERE user_id=${pid} AND consent_kind='base'`,
  );
  expectError(await p.put('/api/v1/me/diary-workspace', body), 403, 'E-CONSENT-REQUIRED');
  const doc = await ctx.as('psy1');
  expectError(await doc.get(`/api/v1/patients/${pid}/diary-workspace`), 403, 'E-CONSENT-REQUIRED');
  ctx.app.exec(`UPDATE care_assignments SET ended_at='2026-01-01T00:00:00Z' WHERE patient_id=${pid}`);
  expectError(await doc.get(`/api/v1/patients/${pid}/diary-workspace`), 404, 'E-NOT-FOUND');
});

test('new adverse-effect text suggests reporting without automatic events; crisis takes priority', async () => {
  const p = await ctx.as('patG');
  let workspace = expectOk(await p.get('/api/v1/me/diary-workspace'));
  const pid = ctx.id('patG');
  const adverseCount = () => ctx.app.query('SELECT COUNT(*) AS n FROM adverse_events WHERE patient_id=?', pid)[0].n;
  const before = adverseCount();
  workspace.state.dayNotes.push({
    id: 'ae-suggestion-test',
    day: workspace.today,
    text: 'Сегодня тошнит после таблетки',
    shared: false,
  });
  let saved = expectOk(
    await p.put('/api/v1/me/diary-workspace', { revision: workspace.revision, state: workspace.state }),
  );
  assert.equal(saved.ae_suggestion, true);
  assert.equal(saved.crisis, undefined);
  assert.equal(adverseCount(), before);
  saved = expectOk(await p.put('/api/v1/me/diary-workspace', { revision: saved.revision, state: saved.state }));
  assert.equal(saved.ae_suggestion, undefined, 'old note does not suggest again on unrelated save');
  saved.state.dayNotes.push({
    id: 'ae-crisis-priority',
    day: workspace.today,
    text: 'Тошнит, хочу покончить с собой',
    shared: false,
  });
  saved = expectOk(await p.put('/api/v1/me/diary-workspace', { revision: saved.revision, state: saved.state }));
  assert.equal(saved.crisis.contacts[0].phone, '112');
  assert.equal(saved.ae_suggestion, undefined);
  assert.equal(adverseCount(), before);
});
