'use strict';
// Аудит H3: закрепление «только сигналы» (signal_only) не открывает врачу ИИ-чат, прикрепление, шаблоны и
// документы по пациенту, но сам кризисный сигнал он видит; без базового согласия шаблоны и документы — 403.
// covers: PD-11, F-12, F-32
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const { restoreBaseConsent } = require('../lib/consent_restore');
const F = require('../lib/flows');
const { isFullyAssigned } = require('../../src/access/assignment');
const ctx = useApp();

const KEY = 'b-roszdravnadzor';

test('врач «только сигнал»: 404 на чате, прикреплении, шаблонах и документах, сигнал виден', async () => {
  const patient = await ctx.as('patA');
  const doc = await ctx.as('psy1');
  const pid = ctx.id('patA');
  ctx.app.exec("UPDATE crisis_escalations SET status='handled' WHERE status<>'handled'");
  expectOk(await patient.post('/api/v1/me/messages', { text: F.CRISIS_PHRASE }));
  // До перевода закрепление полное.
  expectOk(await doc.get(`/api/v1/context/search?patient_id=${pid}`));
  expectOk(await doc.get(`/work/api/templates/patient/${pid}`));
  expectOk(await doc.get(`/work/api/documents?patient_id=${pid}`));

  ctx.app.exec(
    `UPDATE care_assignments SET end_reason='signal_only' WHERE patient_id=${pid} AND clinician_id=${ctx.id('psy1')} AND ended_at IS NULL`,
  );
  try {
    const db = ctx.app.db();
    try {
      assert.equal(isFullyAssigned(db, pid, ctx.id('psy1')), false);
      assert.equal(isFullyAssigned(db, pid, ctx.id('psy1'), { signal: true }), true);
    } finally {
      db.close();
    }
    expectError(
      await doc.post('/api/v1/ai/clinician/messages', {
        patient_id: pid,
        text: 'Сводка',
        chips: [{ type: 'patient', id: pid }],
      }),
      404,
      'E-NOT-FOUND',
    );
    expectError(await doc.get(`/api/v1/context/search?patient_id=${pid}`), 404, 'E-NOT-FOUND');
    expectError(await doc.get(`/work/api/templates/patient/${pid}`), 404, 'E-NOT-FOUND');
    expectError(
      await doc.post('/work/api/documents', { template_key: KEY, patient_id: pid }),
      404,
      'E-NOT-FOUND',
    );
    const list = expectOk(await doc.get('/work/api/documents'));
    assert.ok(!JSON.stringify(list).includes(`"id":${pid},`), 'пациент не в списке документов');
    const signal = await F.crisisSignalFor(doc, pid);
    assert.ok(signal, 'сам сигнал врач видит');
  } finally {
    ctx.app.exec(
      `UPDATE care_assignments SET end_reason=NULL WHERE patient_id=${pid} AND clinician_id=${ctx.id('psy1')} AND end_reason='signal_only'`,
    );
  }
});

test('отозвано базовое согласие: шаблоны по пациенту и документы — 403 E-CONSENT-REQUIRED', async () => {
  const doc = await ctx.as('psy1');
  const pid = ctx.id('patA');
  ctx.app.exec(
    `INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method) VALUES (${pid},'base','revoked',1,'x','demo')`,
  );
  try {
    expectError(await doc.get(`/work/api/templates/patient/${pid}`), 403, 'E-CONSENT-REQUIRED');
    expectError(
      await doc.post('/work/api/documents', { template_key: KEY, patient_id: pid }),
      403,
      'E-CONSENT-REQUIRED',
    );
  } finally {
    restoreBaseConsent(ctx.app, pid);
  }
  expectOk(await doc.get(`/work/api/templates/patient/${pid}`));
});
