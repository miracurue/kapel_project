'use strict';
const { test } = require('node:test');
const { restoreBaseConsent } = require('../lib/consent_restore');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const ctx = useApp();

async function crisis() {
  ctx.app.exec("UPDATE crisis_escalations SET status='handled' WHERE status IN ('new','in_work')");
  expectOk(await (await ctx.as('patA')).post('/api/v1/me/messages', { text: F.CRISIS_PHRASE }));
  return await F.crisisSignalFor(await ctx.as('psy1'), ctx.id('patA'));
}

test('V3 regression: repeat disclosure retains deadline and release note stays out of incident log', async () => {
  const signal = await crisis();
  const before = ctx.app.query('SELECT due_at FROM crisis_escalations WHERE id=?', signal.id)[0].due_at;
  await ctx.app.advanceClock(60000);
  expectOk(await (await ctx.as('patA')).post('/api/v1/me/messages', { text: F.CRISIS_PHRASE }));
  assert.equal(ctx.app.query('SELECT due_at FROM crisis_escalations WHERE id=?', signal.id)[0].due_at, before);
  const doc = await ctx.as('psy1');
  expectOk(await doc.post(`/api/v1/signals/${signal.id}/take`, {}));
  expectOk(await doc.post(`/api/v1/signals/${signal.id}/release`, { note: 'PRIVATE-RELEASE-CANARY' }));
  assert.doesNotMatch(JSON.stringify(ctx.app.query('SELECT * FROM crisis_incident_log')), /PRIVATE-RELEASE-CANARY/);
  assert.equal(
    ctx.app.query('SELECT outcome_note_enc FROM crisis_escalations WHERE id=?', signal.id)[0].outcome_note_enc,
    'PRIVATE-RELEASE-CANARY',
  );
});

test('V3 regression: bad attachment leaves no message and no partial links', async () => {
  const patient = await ctx.as('patA');
  const before = ctx.app.query('SELECT count(*) n FROM care_messages')[0].n;
  expectError(
    await patient.post('/api/v1/me/messages', { text: 'attachment rollback canary', upload_ids: [987654321] }),
    422,
    'E-VALIDATION',
  );
  assert.equal(ctx.app.query('SELECT count(*) n FROM care_messages')[0].n, before);
});

test('V3 regression: idempotency stores no text and checks route/body and current assignment on replay', async () => {
  const patient = await ctx.as('patA');
  const body = { text: 'PRIVATE-IDEM-CANARY' };
  const first = expectOk(await patient.post('/api/v1/me/messages', body, { idem: 'v3-message-replay' }));
  const second = expectOk(await patient.post('/api/v1/me/messages', body, { idem: 'v3-message-replay' }));
  assert.equal(first.message.id, second.message.id);
  assert.doesNotMatch(
    JSON.stringify(ctx.app.query("SELECT * FROM idempotency_keys WHERE key='v3-message-replay'")),
    /PRIVATE-IDEM-CANARY/,
  );
  expectError(
    await patient.post('/api/v1/me/messages', { text: 'different' }, { idem: 'v3-message-replay' }),
    409,
    'E-IDEMPOTENCY-MISMATCH',
  );
  const signal = await crisis();
  const doc = await ctx.as('psy1');
  expectOk(await doc.post(`/api/v1/signals/${signal.id}/take`, {}, { idem: 'v3-signal-replay' }));
  ctx.app.exec(
    `UPDATE care_assignments SET ended_at='2026-01-01' WHERE patient_id=${ctx.id('patA')} AND clinician_id=${ctx.id('psy1')} AND ended_at IS NULL`,
  );
  expectError(
    await doc.post(`/api/v1/signals/${signal.id}/take`, {}, { idem: 'v3-signal-replay' }),
    404,
    'E-NOT-FOUND',
  );
  ctx.app.exec(
    `UPDATE care_assignments SET ended_at=NULL WHERE patient_id=${ctx.id('patA')} AND clinician_id=${ctx.id('psy1')}`,
  );
});

test('V3 regression: PHI audit failure blocks signal list and idempotent replay', async () => {
  const signal = await crisis();
  const doc = await ctx.as('psy1');
  expectOk(await doc.post(`/api/v1/signals/${signal.id}/take`, {}, { idem: 'v3-audit-replay' }));
  ctx.app.exec(
    `DELETE FROM phi_access_log; CREATE TRIGGER fail_v3_audit BEFORE INSERT ON phi_access_log BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;`,
  );
  try {
    expectError(await doc.get('/api/v1/signals'), 500, 'E-INTERNAL');
    expectError(
      await doc.post(`/api/v1/signals/${signal.id}/take`, {}, { idem: 'v3-audit-replay' }),
      500,
      'E-INTERNAL',
    );
  } finally {
    ctx.app.exec('DROP TRIGGER fail_v3_audit');
  }
});

test('V3 regression: draft/cancelled AE cannot be reviewed, exported or replayed', async () => {
  const patient = await ctx.as('patA');
  const doc = await ctx.as('psy1');
  const report = expectOk(await patient.post('/api/v1/me/adverse-events', { text: 'synthetic AE' }));
  expectError(
    await doc.post(`/api/v1/adverse-events/${report.ae.id}/decision`, { decision: 'probable' }),
    404,
    'E-NOT-FOUND',
  );
  expectOk(await patient.post(`/api/v1/undo/${report.undo.id}`, {}));
  expectError(await doc.get(`/api/v1/adverse-events/${report.ae.id}/notice`), 404, 'E-NOT-FOUND');
});

test('V3 regression: consent withdrawal blocks records but preserves crisis card', async () => {
  const patient = await ctx.as('patA');
  expectOk(await patient.post('/api/v1/consents/base', { action: 'revoke', confirm: true }));
  try {
    const before = ctx.app.query('SELECT count(*) n FROM adverse_events')[0].n;
    // отзыв базового согласия заводит запрос на стирание (W-50, PD-12): обычная запись закрыта ограничением;
    // причина для пациента — «нужно согласие» (решение владельца 2026-10-25)
    expectError(await patient.post('/api/v1/me/adverse-events', { text: 'ordinary' }), 403, 'E-CONSENT-REQUIRED');
    const result = expectOk(await patient.post('/api/v1/me/adverse-events', { text: F.CRISIS_PHRASE }));
    assert.equal(result.saved, false);
    assert.equal(result.crisis.contacts[0].phone, '112');
    assert.equal(ctx.app.query('SELECT count(*) n FROM adverse_events')[0].n, before);
  } finally {
    restoreBaseConsent(ctx.app, ctx.id('patA'));
  }
});

test('V3 regression: reserve sees only escalated signal, never patient records', async () => {
  const signal = await crisis();
  const admin = await ctx.as('admin1');
  expectOk(await F.setSetting(admin, 'crisis.backup', [ctx.id('psy3')]));
  ctx.app.exec(`UPDATE crisis_escalations SET escalated_to_backup_at='2026-01-01' WHERE id=${signal.id}`);
  const backup = await ctx.as('psy3');
  const list = expectOk(await backup.get('/api/v1/signals')).items;
  assert.ok(list.some((item) => item.id === signal.id && item.kind === 'crisis'));
  expectOk(await backup.post(`/api/v1/signals/${signal.id}/take`, {}));
  for (const suffix of ['', '/messages', '/visits', '/plan'])
    expectError(await backup.get(`/api/v1/patients/${ctx.id('patA')}${suffix}`), 404, 'E-NOT-FOUND');
  assert.equal(
    ctx.app.query(
      'SELECT count(*) n FROM care_assignments WHERE patient_id=? AND clinician_id=? AND ended_at IS NULL',
      ctx.id('patA'),
      ctx.id('psy3'),
    )[0].n,
    0,
  );
  expectOk(await F.setSetting(admin, 'crisis.backup', []));
  expectError(
    await backup.post(`/api/v1/signals/${signal.id}/outcome`, { outcome: 'contacted_safe' }),
    404,
    'E-NOT-FOUND',
  );
});

test('V3 regression: previsit respects disabled/window, drafts stay private, detached clinician cannot patch', async () => {
  const doc = await ctx.as('psy1');
  const patient = await ctx.as('patA');
  const starts_at = new Date(Date.now() + 86400000).toISOString();
  const disabled = expectOk(
    await doc.post(`/api/v1/patients/${ctx.id('patA')}/visits`, { starts_at, previsit_enabled: false }),
  );
  await F.passUndoWindow(ctx.app);
  expectError(await patient.get(`/api/v1/me/visits/${disabled.visit.id}/previsit`), 409, 'E-ASSIGNMENT-CLOSED');
  const enabled = expectOk(
    await doc.post(`/api/v1/patients/${ctx.id('patA')}/visits`, { starts_at, previsit_enabled: true }),
  );
  await F.passUndoWindow(ctx.app);
  const form = expectOk(await patient.get(`/api/v1/me/visits/${enabled.visit.id}/previsit`));
  const q = form.questions.find((question) => question.type.startsWith('text'));
  expectOk(
    await patient.put(`/api/v1/me/visits/${enabled.visit.id}/previsit`, {
      answers: { [q.id]: 'PRIVATE-DRAFT-CANARY' },
      submit: false,
    }),
  );
  assert.doesNotMatch(
    JSON.stringify(expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}/visits`))),
    /PRIVATE-DRAFT-CANARY/,
  );
  ctx.app.exec(
    `UPDATE care_assignments SET ended_at='2026-01-01' WHERE patient_id=${ctx.id('patA')} AND clinician_id=${ctx.id('psy1')} AND ended_at IS NULL`,
  );
  try {
    expectError(
      await doc.patch(`/api/v1/visits/${enabled.visit.id}`, { version: 1, status: 'cancelled' }),
      404,
      'E-NOT-FOUND',
    );
  } finally {
    ctx.app.exec(
      `UPDATE care_assignments SET ended_at=NULL WHERE patient_id=${ctx.id('patA')} AND clinician_id=${ctx.id('psy1')}`,
    );
  }
});

// PD-12 + REQ-CRI: при ограничении обработки (запрос на стирание) обычная запись закрыта, а кризисная фраза
// в свободном тексте всё равно даёт карточку 112 и сигнал врачу, но ничего не сохраняет.
test('V3 regression: erasure restriction blocks writes but crisis text still gets the 112 card and a signal', async () => {
  const patient = await ctx.as('patA');
  ctx.app.exec("UPDATE crisis_escalations SET status='handled' WHERE status<>'handled'");
  expectOk(await patient.post('/api/v1/consents/base', { action: 'revoke', confirm: true }));
  try {
    const before = ctx.app.query('SELECT count(*) n FROM care_messages')[0].n;
    // ограничение вызвано отзывом согласия — пациенту «нужно согласие» (решение владельца 2026-10-25)
    expectError(await patient.post('/api/v1/me/messages', { text: 'ordinary' }), 403, 'E-CONSENT-REQUIRED');
    const result = expectOk(await patient.post('/api/v1/me/messages', { text: F.CRISIS_PHRASE }));
    assert.equal(result.saved, false);
    assert.equal(result.crisis.contacts[0].phone, '112');
    assert.equal(ctx.app.query('SELECT count(*) n FROM care_messages')[0].n, before);
    assert.equal(
      ctx.app.query(
        "SELECT count(*) n FROM crisis_escalations WHERE patient_id=? AND status<>'handled'",
        ctx.id('patA'),
      )[0].n,
      1,
    );
  } finally {
    restoreBaseConsent(ctx.app, ctx.id('patA'));
  }
});
