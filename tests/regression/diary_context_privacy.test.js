'use strict';
// covers: F-13, F-33, F-39; diary preferences are enforced at every context read.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const { chipContent } = require('../../src/ai/workspace/clinicianContext');
const ctx = useApp();
const CANARY = 'PRIVATEDIARYCANARY';

function preferences(scores, notes) {
  const db = ctx.app.db();
  try {
    db.prepare('UPDATE user_prefs SET share_diary_scores=?, share_diary_notes=? WHERE user_id=?').run(scores, notes, ctx.id('patA'));
  } finally {
    db.close();
  }
}

function diaryId() {
  return ctx.app.query('SELECT id FROM mood_entries WHERE patient_id=? ORDER BY id DESC LIMIT 1', ctx.id('patA'))[0].id;
}

test('diary context: specialists search, document drafts and model chips respect each independent preference', async () => {
  const db = ctx.app.db();
  try {
    db.prepare('INSERT INTO mood_entries(patient_id,entry_date,mood,sleep,anxiety,note,created_at) VALUES (?,?,?,?,?,?,?)').run(
      ctx.id('patA'), '2026-10-21', 4, 'good', 'strong', CANARY, new Date().toISOString(),
    );
  } finally {
    db.close();
  }
  const chip = { type: 'diary_entry', id: diaryId() };
  for (const role of ['psy1', 'plg1']) {
    const doctor = await ctx.as(role);
    for (const [scores, notes] of [[1, 1], [0, 1], [1, 0], [0, 0]]) {
      preferences(scores, notes);
      const search = expectOk(await doctor.get(`/api/v1/context/search?patient_id=${ctx.id('patA')}&q=${CANARY}`));
      assert.equal(search.items.some((r) => r.chip.id === chip.id), Boolean(notes), `${role}: private notes cannot affect search`);
      assert.ok(!JSON.stringify(search).includes(CANARY), 'search only returns metadata');
      const doc = expectOk(await doctor.post(`/api/v1/patients/${ctx.id('patA')}/documents`, { type: 'mis_summary', use_ai: false }), 201);
      const diary = doc.sections.find((s) => s.key === 'diary').text;
      assert.equal(diary.includes(CANARY), Boolean(notes));
      assert.equal(diary.includes('настроение 4'), Boolean(scores));
      assert.equal(diary.includes('сон good'), Boolean(scores));
      assert.equal(diary.includes('тревога strong'), Boolean(scores));
      ctx.app.ai.reset();
      expectOk(await doctor.post('/api/v1/ai/clinician/messages', { patient_id: ctx.id('patA'), text: 'Посмотри запись', chips: [chip] }));
      const seen = ctx.app.ai.seenText();
      assert.ok(ctx.app.ai.calls().length > 0);
      assert.equal(seen.includes(CANARY), Boolean(notes), 'previously attached chip rechecks note preference');
      assert.equal(seen.includes('настроение 4'), Boolean(scores), 'previously attached chip rechecks score preference');
      assert.equal(seen.includes('сон good'), Boolean(scores));
      assert.equal(seen.includes('тревога strong'), Boolean(scores));
    }
  }
});

test('diary context: patient retains own notes and scores, missing actor fails closed', async () => {
  preferences(0, 0);
  const patient = await ctx.as('patA');
  const search = expectOk(await patient.get(`/api/v1/context/search?q=${CANARY}&patient_id=${ctx.id('patB')}`));
  assert.ok(search.items.some((r) => r.chip.id === diaryId()), 'patient scope comes from session');
  const db = ctx.app.db();
  try {
    const chip = { type: 'diary_entry', id: diaryId() };
    const own = chipContent(db, chip, { id: ctx.id('patA'), role: 'patient' });
    assert.ok(own.includes(CANARY));
    assert.match(own, /настроение 4/);
    assert.doesNotMatch(chipContent(db, chip), /PRIVATEDIARYCANARY|настроение|сон good|тревога/);
  } finally {
    db.close();
  }
});

test('diary context: a legacy note sharing override applies to search, draft and existing chip', async () => {
  const doctor = await ctx.as('psy1');
  const db = ctx.app.db();
  const id = diaryId();
  try {
    const stamp = new Date().toISOString();
    db.prepare('INSERT INTO diary_day_notes(patient_id,note_id,day,text,shared,created_at,updated_at) VALUES (?,?,?,?,0,?,?)').run(
      ctx.id('patA'), `legacy-${id}`, '2026-10-21', CANARY, stamp, stamp,
    );
  } finally {
    db.close();
  }
  preferences(1, 1);
  const hidden = expectOk(await doctor.get(`/api/v1/context/search?patient_id=${ctx.id('patA')}&q=${CANARY}`));
  assert.ok(!hidden.items.some((r) => r.chip.id === id));
  const draft = expectOk(await doctor.post(`/api/v1/patients/${ctx.id('patA')}/documents`, { type: 'mis_summary', use_ai: false }), 201);
  assert.ok(!draft.sections.find((s) => s.key === 'diary').text.includes(CANARY));
  ctx.app.ai.reset();
  expectOk(await doctor.post('/api/v1/ai/clinician/messages', { patient_id: ctx.id('patA'), text: 'Посмотри запись', chips: [{ type: 'diary_entry', id }] }));
  assert.ok(!ctx.app.ai.seenText().includes(CANARY));
  assert.ok(ctx.app.ai.seenText().includes('настроение 4'));
  const sharedDb = ctx.app.db();
  try {
    sharedDb.prepare('UPDATE diary_day_notes SET shared=1 WHERE patient_id=? AND note_id=?').run(ctx.id('patA'), `legacy-${id}`);
    preferences(1, 0);
    assert.ok(chipContent(sharedDb, { type: 'diary_entry', id }, { id: ctx.id('psy1'), role: 'psychiatrist' }).includes(CANARY));
    for (const actor of [undefined, { id: ctx.id('admin1'), role: 'admin' }, { id: ctx.id('patB'), role: 'patient' }]) {
      assert.ok(!chipContent(sharedDb, { type: 'diary_entry', id }, actor).includes(CANARY));
    }
  } finally {
    sharedDb.close();
  }
});

test('diary context: foreign, detached and admin roles cannot access patient context or document drafts', async () => {
  const pid = ctx.id('patA');
  for (const [role, status, code] of [['psy2', 404, 'E-NOT-FOUND'], ['admin1', 403, 'E-ACCESS']]) {
    const actor = await ctx.as(role);
    expectError(await actor.get(`/api/v1/context/search?patient_id=${pid}&q=${CANARY}`), status, code);
    expectError(await actor.post(`/api/v1/patients/${pid}/documents`, { type: 'mis_summary', use_ai: false }), status, code);
  }
  const doc = await ctx.as('psy1');
  ctx.app.exec(`UPDATE care_assignments SET ended_at='2026-10-21T00:00:00Z' WHERE patient_id=${pid} AND clinician_id=${ctx.id('psy1')}`);
  expectError(await doc.get(`/api/v1/context/search?patient_id=${pid}&q=${CANARY}`), 404, 'E-NOT-FOUND');
  expectError(await doc.post(`/api/v1/patients/${pid}/documents`, { type: 'mis_summary', use_ai: false }), 404, 'E-NOT-FOUND');
});

test('diary context: revoked patient consent blocks drafts and model context', async () => {
  const pid = ctx.id('patH');
  const doctor = await ctx.as('psy1');
  ctx.app.exec(`INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method) SELECT user_id,consent_kind,'revoked',content_version_id,text_sha256,sign_method FROM consent_current WHERE user_id=${pid} AND consent_kind='base'`);
  ctx.app.ai.reset();
  expectError(await doctor.post(`/api/v1/patients/${pid}/documents`, { type: 'mis_summary', use_ai: false }), 403, 'E-CONSENT-REQUIRED');
  expectError(await doctor.post('/api/v1/ai/clinician/messages', { patient_id: pid, text: 'Посмотри запись', chips: [{ type: 'patient', id: pid }] }), 403, 'E-CONSENT-REQUIRED');
  assert.equal(ctx.app.ai.calls().length, 0);
});

test('diary context: missing preferences never share a note by default', () => {
  const db = ctx.app.db();
  try {
    const id = diaryId();
    db.prepare('DELETE FROM diary_day_notes WHERE patient_id=?').run(ctx.id('patA'));
    db.prepare('DELETE FROM user_prefs WHERE user_id=?').run(ctx.id('patA'));
    const shown = chipContent(db, { type: 'diary_entry', id }, { id: ctx.id('psy1'), role: 'psychiatrist' });
    assert.ok(!shown.includes(CANARY));
  } finally {
    db.close();
  }
});
