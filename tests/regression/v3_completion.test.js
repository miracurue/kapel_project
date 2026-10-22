'use strict';
// covers: W-23, W-24, W-25, W-26; F-15 (DOCX/TXT + crisis extracted text), F-45 (draft lifecycle,
// privacy, discard, final send once + safe replay, consent rules)
const { test } = require('node:test');
const { restoreBaseConsent } = require('../lib/consent_restore');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const ctx = useApp();

async function createDraft(patient, extra = {}) {
  return expectOk(
    await patient.post('/api/v1/me/adverse-events', {
      submit: false,
      symptoms: ['nausea'],
      text: 'Синтетика: черновик',
      severity: 'mild',
      related: 'unknown',
      ...extra,
    }),
  );
}

// F-15: TXT accepted, binary TXT rejected, extension mismatch denied
test('F-15: TXT accepted, binary TXT rejected, extension mismatch denied', async () => {
  const patient = await ctx.as('patA');
  const txt = expectOk(
    await F.upload(patient, { name: 'notes.txt', buffer: Buffer.from('Synthetic note'), type: 'text/plain' }),
  );
  assert.equal(txt.ocr_status, 'done');
  expectError(
    await F.upload(patient, { name: 'binary.txt', buffer: Buffer.from([0, 159, 146, 150]), type: 'text/plain' }),
    415,
    'E-FILE-TYPE',
  );
  expectError(
    await F.upload(patient, { name: 'fake.docx', buffer: Buffer.from('not a zip'), type: 'text/plain' }),
    415,
    'E-FILE-TYPE',
  );
});

// F-15: настоящий DOCX принимается (имя/расширение совпадают с сигнатурой), битый ZIP отклонён
test('F-15: real DOCX accepted with extracted text, malformed ZIP denied', async () => {
  const patient = await ctx.as('patA');
  const xml =
    '<?xml version="1.0"?><w:document xmlns:w="urn:synthetic"><w:body><w:p><w:r><w:t>Синтетика: DOCX переносимость</w:t></w:r></w:p></w:body></w:document>';
  const docx = Buffer.from(
    require('../../src/ai/workspace/zip').build([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: xml },
    ]),
  );
  const doc = expectOk(
    await F.upload(patient, {
      name: 'synthetic_report.docx',
      buffer: docx,
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
  );
  assert.equal(doc.ocr_status, 'done');
  assert.match(doc.ocr_text, /DOCX переносимость/);
  // PK-сигнатура есть, но оглавление повреждено — отказ, а не принятие произвольного ZIP.
  const broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('broken-archive'.repeat(8))]);
  expectError(
    await F.upload(patient, { name: 'broken.docx', buffer: broken, type: 'application/zip' }),
    415,
    'E-FILE-TYPE',
  );
});

// F-15: извлечённый из документа кризисный текст показывает 112; safe replay без текста
test('F-15: crisis in extracted document text shows 112, safe replay keeps no text', async () => {
  const patient = await ctx.as('patA');
  const makeForm = () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(F.CRISIS_PHRASE)], { type: 'text/plain' }), 'crisis_note.txt');
    form.append('purpose', 'chat');
    return form;
  };
  for (let i = 0; i < 2; i++) {
    const result = expectOk(
      await patient.raw('POST', '/api/v1/uploads', undefined, { form: makeForm(), idem: 'doc-crisis-replay' }),
    );
    assert.equal(result.crisis.contacts[0].phone, '112');
  }
  const replay = expectOk(
    await patient.raw('POST', '/api/v1/uploads', undefined, { form: makeForm(), idem: 'doc-crisis-replay' }),
  );
  assert.equal(replay.ocr_text, null, 'safe replay не содержит извлечённый текст');
  assert.doesNotMatch(
    JSON.stringify(ctx.app.query("SELECT * FROM idempotency_keys WHERE key='doc-crisis-replay'")),
    new RegExp(F.CRISIS_PHRASE),
  );
});

// F-45: draft lifecycle, privacy, final send, conflict
test('F-45: draft lifecycle, privacy, final send, conflict', async () => {
  const patient = await ctx.as('patA');
  const other = await ctx.as('patB');

  // 1. Create draft
  const draft = await createDraft(patient);
  assert.equal(draft.ae.status, 'draft');
  const draftId = draft.ae.id;

  // 2. GET returns own draft
  const list = expectOk(await patient.get('/api/v1/me/adverse-events'));
  assert.ok(list.draft);
  assert.equal(list.draft.id, draftId);

  // 3. Update draft
  const updated = await createDraft(patient, { draft_id: draftId, text: 'Синтетика: обновлённый черновик' });
  assert.equal(updated.ae.id, draftId);

  // 4. Foreign draft deny
  expectError(
    await other.post('/api/v1/me/adverse-events', { draft_id: draftId, submit: false, text: 'Синтетика: чужой' }),
    404,
    'E-NOT-FOUND',
  );

  // 5. Final send: one atomic action, notified once, idem replay returns the same once
  const final = expectOk(
    await patient.post(
      '/api/v1/me/adverse-events',
      { draft_id: draftId, text: 'Синтетика: финал' },
      { idem: 'ae-final-once' },
    ),
  );
  assert.equal(final.ae.status, 'awaiting_visibility');
  assert.ok(final.undo);
  const notifyOnce = expectOk(
    await patient.post(
      '/api/v1/me/adverse-events',
      { draft_id: draftId, text: 'Синтетика: финал' },
      { idem: 'ae-final-once' },
    ),
  );
  assert.equal(notifyOnce.ae.status, 'awaiting_visibility');
  assert.equal(
    ctx.app.query("SELECT count(*) n FROM notifications WHERE type='ae' AND object_id=?", draftId)[0].n,
    1,
    'уведомление врачу отправлено один раз',
  );
  assert.deepEqual(JSON.stringify(notifyOnce.ae), JSON.stringify(final.ae), 'replay вернул сохранённый ответ');

  // 6. Re-submission of submitted rejected
  expectError(
    await patient.post('/api/v1/me/adverse-events', { draft_id: draftId, text: 'Синтетика: повтор' }),
    409,
    'E-CONFLICT',
  );
});

// F-45: discard lifecycle and cross-role draft privacy
test('F-45: discard own draft, repeat discard denied, foreign discard denied', async () => {
  const patient = await ctx.as('patA');
  const other = await ctx.as('patB');

  // 1. Create draft
  const draft = await createDraft(patient, { text: 'Синтетика: черновик на отмену' });
  const draftId = draft.ae.id;
  assert.equal(draft.ae.status, 'draft');

  // 2. Discard own draft -> ok, status cancelled
  const discarded = expectOk(await patient.post('/api/v1/me/adverse-events', { discard: true, draft_id: draftId }));
  assert.equal(discarded.ae.status, 'cancelled');

  // 3. GET no longer returns the draft
  const list = expectOk(await patient.get('/api/v1/me/adverse-events'));
  assert.ok(!list.draft);
  assert.ok(!list.items.some((item) => item.id === draftId));

  // 4. Repeat discard of the same draft_id -> error
  expectError(
    await patient.post('/api/v1/me/adverse-events', { discard: true, draft_id: draftId }),
    404,
    'E-NOT-FOUND',
  );

  // 5. Discard foreign draft_id -> denied
  const foreign = await createDraft(other, { text: 'Синтетика: чужой черновик на отмену' });
  expectError(
    await patient.post('/api/v1/me/adverse-events', { discard: true, draft_id: foreign.ae.id }),
    404,
    'E-NOT-FOUND',
  );
  assert.equal(expectOk(await other.get('/api/v1/me/adverse-events')).draft.id, foreign.ae.id);
});

// F-45: discard:true без draft_id — ошибка валидации, а не обычная отправка
test('F-45: discard without draft_id is a validation error, not a silent submit', async () => {
  const patient = await ctx.as('patA');
  expectError(
    await patient.post('/api/v1/me/adverse-events', { discard: true, text: 'Синтетика: без id' }),
    422,
    'E-VALIDATION',
  );
  assert.equal(
    ctx.app.query("SELECT count(*) n FROM adverse_events WHERE description_enc='Синтетика: без id'")[0].n,
    0,
  );
});

// F-45: файлы черновика — владелец читает, врач и резерв нет; после финальной отправки врач — только после окна
test('F-45: draft files stay private from clinician, patient keeps own access', async () => {
  const patient = await ctx.as('patA');
  const doc = await ctx.as('psy1');
  const file = expectOk(
    await F.upload(patient, {
      name: 'draft_file.txt',
      buffer: Buffer.from('Synthetic draft file'),
      type: 'text/plain',
    }),
  );
  const draft = await createDraft(patient, { upload_ids: [file.id] });
  const draftId = draft.ae.id;
  expectOk(await patient.get(`/api/v1/files/${file.id}`, { binary: true }));
  expectError(await doc.get(`/api/v1/files/${file.id}`), 404, 'E-NOT-FOUND');
  const final = expectOk(
    await patient.post('/api/v1/me/adverse-events', { draft_id: draftId, text: 'Синтетика: финал с файлом' }),
  );
  assert.ok(final.undo);
  // после финальной отправки файлы доступны только после окна видимости
  expectError(await patient.get(`/api/v1/files/${file.id}`), 404, 'E-NOT-FOUND');
  expectError(await doc.get(`/api/v1/files/${file.id}`), 404, 'E-NOT-FOUND');
  await F.passUndoWindow(ctx.app);
  expectOk(await patient.get(`/api/v1/files/${file.id}`, { binary: true }));
  expectOk(await doc.get(`/api/v1/files/${file.id}`, { binary: true }));
});

// F-45: удаление собственного черновика не требует согласия; сохранение черновика — требует
test('F-45: discard own draft works without consent, draft save still requires it', async () => {
  const patient = await ctx.as('patA');
  const draft = await createDraft(patient, { text: 'Синтетика: черновик без согласия' });
  const draftId = draft.ae.id;
  expectOk(await patient.post('/api/v1/consents/base', { action: 'revoke', confirm: true }));
  try {
    expectError(
      await patient.post('/api/v1/me/adverse-events', { submit: false, text: 'Синтетика: нельзя' }),
      403,
      'E-ACCESS', // отзыв базового согласия = запрос на стирание (W-50): сохранение закрыто ограничением обработки
    );
    assert.equal(
      ctx.app.query("SELECT count(*) n FROM adverse_events WHERE description_enc='Синтетика: нельзя'")[0].n,
      0,
    );
    const discarded = expectOk(await patient.post('/api/v1/me/adverse-events', { discard: true, draft_id: draftId }));
    assert.equal(discarded.ae.status, 'cancelled');
  } finally {
    restoreBaseConsent(ctx.app, ctx.id('patA'));
  }
});

test('F-45: server draft stays private from psychiatrist and reserve', async () => {
  const patient = await ctx.as('patA');
  const doc = await ctx.as('psy1');

  // 1. Patient creates a draft with a canary text
  await createDraft(patient, { text: 'PRIVATE-DRAFT-CANARY' });

  // 2. Patient's own list keeps it only in the draft field
  const own = expectOk(await patient.get('/api/v1/me/adverse-events'));
  assert.ok(own.draft);
  assert.ok(!own.items.some((item) => item.id === own.draft.id));

  // 3. Doctor's signal/ae list does not include the draft
  const doctorList = expectOk(await doc.get('/api/v1/signals'));
  assert.ok(!doctorList.items.some((item) => item.kind === 'ae' && item.id === own.draft.id));

  // 4. Reserve (backup psychiatrist) also has no draft in the list
  const admin = await ctx.as('admin1');
  expectOk(await F.setSetting(admin, 'crisis.backup', [ctx.id('psy3')]));
  try {
    const reserveList = expectOk(await (await ctx.as('psy3')).get('/api/v1/signals'));
    assert.ok(!reserveList.items.some((item) => item.kind === 'ae' && item.id === own.draft.id));
  } finally {
    expectOk(await F.setSetting(admin, 'crisis.backup', []));
  }
});
