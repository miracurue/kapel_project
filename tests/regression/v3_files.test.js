'use strict';
// covers: W-23, W-24, W-25, W-26, W-27, W-28; T-057, T-090, T-427
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const ctx = useApp();

async function uploadWithKey(patient, key, purpose = 'message') {
  const form = new FormData();
  form.append(
    'file',
    new Blob([Buffer.from('%PDF-1.4\nsynthetic regression')], { type: 'application/pdf' }),
    'PRIVATE-FILENAME.pdf',
  );
  form.append('purpose', purpose);
  return patient.raw('POST', '/api/v1/uploads', undefined, { form, idem: key });
}

test('V3 files: concurrent upload replay creates one row, purpose mismatch fails, expired replay fails, no PII cache', async () => {
  const patient = await ctx.as('patA');
  const beforeCount = ctx.app.query('SELECT count(*) n FROM stored_files')[0].n;
  const [a, b] = await Promise.all([
    uploadWithKey(patient, 'files-concurrent'),
    uploadWithKey(patient, 'files-concurrent'),
  ]);
  const first = expectOk(a),
    second = expectOk(b);
  assert.equal(first.id, second.id);
  assert.equal(ctx.app.query('SELECT count(*) n FROM stored_files')[0].n, beforeCount + 1);
  assert.equal(ctx.app.query('SELECT count(*) n FROM stored_files WHERE id=?', first.id)[0].n, 1);
  expectError(await uploadWithKey(patient, 'files-concurrent', 'chat'), 409, 'E-IDEMPOTENCY-MISMATCH');
  assert.doesNotMatch(
    JSON.stringify(ctx.app.query("SELECT * FROM idempotency_keys WHERE key='files-concurrent'")),
    /PRIVATE-FILENAME/,
  );
  ctx.app.exec(`UPDATE stored_files SET expires_at='2000-01-01' WHERE id=${first.id}`);
  expectError(await uploadWithKey(patient, 'files-concurrent'), 404, 'E-NOT-FOUND');
});

test('V3 files: decode/reencode removes PNG EXIF and malformed JPEG is refused', async () => {
  const patient = await ctx.as('patA');
  const source = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } })
    .withExif({ IFD0: { Artist: 'PRIVATE-PNG-EXIF' } })
    .png()
    .toBuffer();
  const file = expectOk(await F.upload(patient, { name: 'metadata.png', buffer: source, type: 'image/png' }));
  const downloaded = await patient.get(`/api/v1/files/${file.id}`, { binary: true });
  assert.equal(downloaded.status, 200);
  assert.equal((await sharp(downloaded.body).metadata()).exif, undefined);
  assert.ok(!downloaded.body.includes(Buffer.from('PRIVATE-PNG-EXIF')));
  expectError(
    await F.upload(patient, {
      name: 'broken.jpg',
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff]),
      type: 'image/jpeg',
    }),
    422,
    'E-VALIDATION',
  );
});

test('V3 files: temp/previsibility/cancelled and thread boundaries, audit failure and detachment fail closed', async () => {
  const patient = await ctx.as('patA'),
    doc = await ctx.as('psy1'),
    psych = await ctx.as('plg1');
  const file = expectOk(await F.upload(patient, 'synthetic_report.pdf'));
  expectOk(await patient.get(`/api/v1/files/${file.id}`, { binary: true }));
  expectError(await doc.get(`/api/v1/files/${file.id}`), 404, 'E-NOT-FOUND');
  const sent = expectOk(
    await patient.post('/api/v1/me/messages', {
      text: 'THREAD-PRIVATE',
      to_clinician_id: ctx.id('psy1'),
      upload_ids: [file.id],
    }),
  );
  expectError(await doc.get(`/api/v1/files/${file.id}`), 404, 'E-NOT-FOUND');
  await F.passUndoWindow(ctx.app);
  expectOk(await doc.get(`/api/v1/files/${file.id}`, { binary: true }));
  expectError(await psych.get(`/api/v1/files/${file.id}`), 404, 'E-NOT-FOUND');
  assert.ok(
    !expectOk(await psych.get(`/api/v1/patients/${ctx.id('patA')}/messages`)).items.some(
      (item) => item.id === sent.message.id,
    ),
  );
  expectError(await psych.post('/api/v1/messages/read', { ids: [sent.message.id] }), 404, 'E-NOT-FOUND');
  const reply = expectOk(
    await psych.post(`/api/v1/patients/${ctx.id('patA')}/messages`, { text: 'PSYCHOLOGIST-ONLY' }),
  );
  await F.passUndoWindow(ctx.app);
  assert.ok(
    !expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}/messages`)).items.some(
      (item) => item.id === reply.message.id,
    ),
  );
  ctx.app.exec(
    "DELETE FROM phi_access_log; CREATE TRIGGER files_fail_audit BEFORE INSERT ON phi_access_log BEGIN SELECT RAISE(ABORT,'unavailable'); END;",
  );
  try {
    expectError(await doc.get(`/api/v1/files/${file.id}`), 500, 'E-INTERNAL');
  } finally {
    ctx.app.exec('DROP TRIGGER files_fail_audit');
  }
  ctx.app.exec(
    `UPDATE care_assignments SET ended_at='2000-01-01' WHERE patient_id=${ctx.id('patA')} AND clinician_id=${ctx.id('psy1')}`,
  );
  try {
    expectError(await doc.get(`/api/v1/files/${file.id}`), 404, 'E-NOT-FOUND');
  } finally {
    ctx.app.exec(
      `UPDATE care_assignments SET ended_at=NULL WHERE patient_id=${ctx.id('patA')} AND clinician_id=${ctx.id('psy1')}`,
    );
  }
  const cancelled = expectOk(await F.upload(patient, 'synthetic_report.pdf'));
  const message = expectOk(await patient.post('/api/v1/me/messages', { text: 'cancel', upload_ids: [cancelled.id] }));
  expectOk(await patient.post(`/api/v1/undo/${message.undo.id}`, {}));
  expectError(await doc.get(`/api/v1/files/${cancelled.id}`), 404, 'E-NOT-FOUND');
  expectError(await patient.get(`/api/v1/files/${cancelled.id}`), 404, 'E-NOT-FOUND');
});

test('V3 AI attachments: six/foreign/expired fail, replay remains linked once, clinician never reads AI file', async () => {
  const patient = await ctx.as('patA'),
    other = await ctx.as('patB'),
    doc = await ctx.as('psy1');
  const own = expectOk(await F.upload(patient, 'synthetic_report.pdf'));
  const foreign = expectOk(await F.upload(other, 'synthetic_report.pdf'));
  expectError(await F.patientAsk(patient, 'Synthetic', { upload_ids: [1, 2, 3, 4, 5, 6] }), 422, 'E-VALIDATION');
  expectError(await F.patientAsk(patient, 'Synthetic', { upload_ids: [foreign.id] }), 422, 'E-VALIDATION');
  const expired = expectOk(await F.upload(patient, 'synthetic_report.pdf'));
  ctx.app.exec(`UPDATE stored_files SET expires_at='2000-01-01' WHERE id=${expired.id}`);
  expectError(await F.patientAsk(patient, 'Synthetic', { upload_ids: [expired.id] }), 422, 'E-VALIDATION');
  const body = { text: 'Synthetic file question', upload_ids: [own.id] };
  expectOk(await patient.post('/api/v1/ai/patient/messages', body, { idem: 'ai-file-replay' }));
  const before = ctx.app.query('SELECT linked_id FROM stored_files WHERE id=?', own.id)[0].linked_id;
  expectOk(await patient.post('/api/v1/ai/patient/messages', body, { idem: 'ai-file-replay' }));
  assert.equal(ctx.app.query('SELECT linked_id FROM stored_files WHERE id=?', own.id)[0].linked_id, before);
  expectOk(await patient.get(`/api/v1/files/${own.id}`, { binary: true }));
  expectError(await doc.get(`/api/v1/files/${own.id}`), 404, 'E-NOT-FOUND');
});

test('V3 undo: contacted/outcome/release/AE decision restore structure, reject stale undo, keep notes out of infrastructure', async () => {
  const patient = await ctx.as('patA'),
    doc = await ctx.as('psy1');
  ctx.app.exec("UPDATE crisis_escalations SET status='handled' WHERE status<>'handled'");
  expectOk(await patient.post('/api/v1/me/messages', { text: F.CRISIS_PHRASE }));
  const signal = await F.crisisSignalFor(doc, ctx.id('patA'));
  const take = expectOk(await doc.post(`/api/v1/signals/${signal.id}/take`, {}));
  const contacted = expectOk(await doc.post(`/api/v1/signals/${signal.id}/contacted`, {}));
  expectError(await doc.post(`/api/v1/undo/${take.undo.id}`, {}), 409, 'E-CONFLICT');
  expectOk(await doc.post(`/api/v1/undo/${contacted.undo.id}`, {}));
  assert.equal(ctx.app.query('SELECT status FROM crisis_escalations WHERE id=?', signal.id)[0].status, 'in_work');
  expectError(await doc.post(`/api/v1/signals/${signal.id}/outcome`, { outcome: 'PRIVATE-CODE' }), 422, 'E-VALIDATION');
  const outcome = expectOk(
    await doc.post(`/api/v1/signals/${signal.id}/outcome`, { outcome: 'contacted_safe', note: 'PRIVATE-OUTCOME-NOTE' }),
  );
  expectOk(await doc.post(`/api/v1/undo/${outcome.undo.id}`, {}));
  const release = expectOk(await doc.post(`/api/v1/signals/${signal.id}/release`, { note: 'PRIVATE-RELEASE-NOTE' }));
  expectOk(await doc.post(`/api/v1/undo/${release.undo.id}`, {}));
  assert.equal(ctx.app.query('SELECT status FROM crisis_escalations WHERE id=?', signal.id)[0].status, 'in_work');
  const ae = expectOk(await patient.post('/api/v1/me/adverse-events', { text: 'Synthetic AE' }));
  await F.passUndoWindow(ctx.app);
  expectError(
    await doc.post(`/api/v1/adverse-events/${ae.ae.id}/decision`, { decision: 'PRIVATE-DECISION' }),
    422,
    'E-VALIDATION',
  );
  const decision = expectOk(await doc.post(`/api/v1/adverse-events/${ae.ae.id}/decision`, { decision: 'probable' }));
  expectOk(await doc.post(`/api/v1/undo/${decision.undo.id}`, {}));
  assert.equal(ctx.app.query('SELECT status FROM adverse_events WHERE id=?', ae.ae.id)[0].status, 'submitted');
  for (const table of ['undo_actions', 'idempotency_keys', 'crisis_incident_log'])
    assert.doesNotMatch(
      JSON.stringify(ctx.app.query(`SELECT * FROM ${table}`)),
      /PRIVATE-(?:OUTCOME|RELEASE|DECISION|CODE)/,
    );
});

test('V3 files: sender clinician loses attachment access after detachment', async () => {
  const doc = await ctx.as('psy1');
  const file = expectOk(await F.upload(doc, 'synthetic_report.pdf'));
  expectOk(
    await doc.post(`/api/v1/patients/${ctx.id('patA')}/messages`, {
      text: 'Clinician attachment',
      upload_ids: [file.id],
    }),
  );
  await F.passUndoWindow(ctx.app);
  expectOk(await doc.get(`/api/v1/files/${file.id}`, { binary: true }));
  ctx.app.exec(
    `UPDATE care_assignments SET ended_at='2000-01-01' WHERE patient_id=${ctx.id('patA')} AND clinician_id=${ctx.id('psy1')}`,
  );
  try {
    expectError(await doc.get(`/api/v1/files/${file.id}`), 404, 'E-NOT-FOUND');
  } finally {
    ctx.app.exec(
      `UPDATE care_assignments SET ended_at=NULL WHERE patient_id=${ctx.id('patA')} AND clinician_id=${ctx.id('psy1')}`,
    );
  }
});
test('V3 files: OCR crisis survives safe upload replay without OCR text in cache', async () => {
  const patient = await ctx.as('patA');
  const previous = ctx.app.ml.preset.ocr;
  ctx.app.ml.preset.ocr = F.CRISIS_PHRASE;
  const makeForm = () => {
    const form = new FormData();
    form.append(
      'file',
      new Blob([require('fs').readFileSync(`${F.FILES}/printed_form.png`)], { type: 'image/png' }),
      'crisis.png',
    );
    return form;
  };
  try {
    for (let i = 0; i < 2; i++) {
      const result = expectOk(
        await patient.raw('POST', '/api/v1/uploads', undefined, { form: makeForm(), idem: 'ocr-crisis-replay' }),
      );
      assert.equal(result.crisis.contacts[0].phone, '112');
    }
    assert.doesNotMatch(
      JSON.stringify(ctx.app.query("SELECT * FROM idempotency_keys WHERE key='ocr-crisis-replay'")),
      new RegExp(F.CRISIS_PHRASE),
    );
  } finally {
    ctx.app.ml.preset.ocr = previous;
  }
});
test('V3 previsit required questions block submit but permit incomplete draft', async () => {
  const admin = await ctx.as('admin1'),
    doc = await ctx.as('psy1'),
    patient = await ctx.as('patA');
  const previous = expectOk(await admin.get('/api/v1/admin/settings/previsit.questions')).current.value;
  expectOk(
    await F.setSetting(admin, 'previsit.questions', [
      { id: 'required_note', type: 'text_long', text: 'Synthetic required', required: true },
    ]),
  );
  try {
    const created = expectOk(
      await doc.post(`/api/v1/patients/${ctx.id('patA')}/visits`, {
        starts_at: new Date(Date.now() + 86400000).toISOString(),
        previsit_enabled: true,
      }),
    );
    await F.passUndoWindow(ctx.app);
    const path = `/api/v1/me/visits/${created.visit.id}/previsit`;
    expectOk(await patient.put(path, { answers: {}, submit: false }));
    expectError(await patient.put(path, { answers: {}, submit: true }), 422, 'E-VALIDATION');
    expectOk(await patient.put(path, { answers: { required_note: 'Synthetic answer' }, submit: true }));
  } finally {
    if (previous) expectOk(await F.setSetting(admin, 'previsit.questions', previous));
  }
});

test('V3 crisis: invalid AE fields still return the already evaluated crisis card', async () => {
  const patient = await ctx.as('patA');
  const result = await patient.post('/api/v1/me/adverse-events', { text: F.CRISIS_PHRASE, severity: 'invalid' });
  expectError(result, 422, 'E-VALIDATION');
  assert.equal(result.body.crisis.contacts[0].phone, '112');
});

test('V3 AE attachments and decision: original data/files only psychiatrist, bad files atomic, new decision key conflicts', async () => {
  const patient = await ctx.as('patA'),
    other = await ctx.as('patB'),
    doc = await ctx.as('psy1'),
    psych = await ctx.as('plg1');
  const foreign = expectOk(await F.upload(other, 'synthetic_report.pdf'));
  const before = ctx.app.query('SELECT count(*) n FROM adverse_events')[0].n;
  expectError(
    await patient.post('/api/v1/me/adverse-events', { text: 'Invalid AE file', upload_ids: [foreign.id] }),
    422,
    'E-VALIDATION',
  );
  assert.equal(ctx.app.query('SELECT count(*) n FROM adverse_events')[0].n, before);
  const own = expectOk(await F.upload(patient, 'synthetic_report.pdf'));
  const report = expectOk(
    await patient.post('/api/v1/me/adverse-events', {
      text: 'AE-ORIGINAL-TEXT',
      severity: 'severe',
      related: 'no',
      started_on: '2026-10-01',
      upload_ids: [own.id],
    }),
  );
  expectError(await doc.get(`/api/v1/files/${own.id}`), 404, 'E-NOT-FOUND');
  await F.passUndoWindow(ctx.app);
  const item = expectOk(await doc.get('/api/v1/signals?kind=ae')).items.find((row) => row.id === report.ae.id);
  assert.equal(item.text, 'AE-ORIGINAL-TEXT');
  assert.equal(item.severity, 'severe');
  assert.equal(item.related, 'no');
  assert.deepEqual(item.upload_ids, [own.id]);
  expectOk(await doc.get(`/api/v1/files/${own.id}`, { binary: true }));
  expectError(await psych.get(`/api/v1/files/${own.id}`), 404, 'E-NOT-FOUND');
  const body = { decision: 'probable', comment: 'PRIVATE-DECISION-COMMENT' };
  const decision = expectOk(
    await doc.post(`/api/v1/adverse-events/${report.ae.id}/decision`, body, { idem: 'ae-final-decision' }),
  );
  expectOk(await doc.post(`/api/v1/adverse-events/${report.ae.id}/decision`, body, { idem: 'ae-final-decision' }));
  expectError(
    await doc.post(`/api/v1/adverse-events/${report.ae.id}/decision`, { decision: 'unrelated' }),
    409,
    'E-CONFLICT',
  );
  assert.equal(
    ctx.app.query('SELECT decision_comment_enc FROM adverse_events WHERE id=?', report.ae.id)[0].decision_comment_enc,
    'PRIVATE-DECISION-COMMENT',
  );
  assert.doesNotMatch(
    JSON.stringify(ctx.app.query("SELECT * FROM idempotency_keys WHERE key='ae-final-decision'")),
    /PRIVATE-DECISION-COMMENT/,
  );
  expectOk(await doc.post(`/api/v1/undo/${decision.undo.id}`, {}));
  expectOk(await doc.post(`/api/v1/adverse-events/${report.ae.id}/decision`, { decision: 'unrelated' }));
});

test('V3 previsit: own draft roundtrips, one submit only, no submitted downgrade, same key replay once', async () => {
  const patient = await ctx.as('patA'),
    doc = await ctx.as('psy1');
  const visit = expectOk(
    await doc.post(`/api/v1/patients/${ctx.id('patA')}/visits`, {
      starts_at: new Date(Date.now() + 86400000).toISOString(),
      format: 'remote',
      place: 'Synthetic link',
      prepare: 'Synthetic preparation',
      previsit_enabled: true,
    }),
  );
  await F.passUndoWindow(ctx.app);
  const path = `/api/v1/me/visits/${visit.visit.id}/previsit`;
  const form = expectOk(await patient.get(path));
  const question = form.questions.find((q) => q.type.startsWith('text'));
  const answers = { [question.id]: 'PREVISIT-DRAFT-ROUNDTRIP' };
  expectOk(await patient.put(path, { answers, submit: false }));
  assert.deepEqual(expectOk(await patient.get(path)).answers, answers);
  expectOk(await patient.put(path, { answers, submit: true }, { idem: 'previsit-single' }));
  expectOk(await patient.put(path, { answers, submit: true }, { idem: 'previsit-single' }));
  expectError(await patient.put(path, { answers, submit: true }), 409, 'E-CONFLICT');
  expectError(await patient.put(path, { answers: {}, submit: false }), 409, 'E-CONFLICT');
  assert.equal(expectOk(await patient.get(path)).status, 'submitted');
  const notices = ctx.app.query(
    "SELECT count(*) n FROM notifications WHERE type='previsit_submitted' AND object_id=?",
    visit.visit.id,
  )[0].n;
  assert.equal(notices, 1);
});
