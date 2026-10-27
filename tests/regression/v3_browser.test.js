'use strict';
// covers: W-23..W-28, F-15, F-47, F-63, F-65, F-66; real browser and API state
const { test } = require('node:test');
const { restoreBaseConsent } = require('../lib/consent_restore');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const F = require('../lib/flows');
const { expectOk } = require('../lib/client');
const ctx = useBrowserApp();

test('V3 browser: selected file is uploaded and sent to chosen recipient; remove actually excludes it', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'patA');
  ctx.track(session.ctx);
  const page = session.page;
  await B.open(page, ctx.app, '/app?tab=doctor');
  await page.waitForSelector('[data-recipient]');
  await page.selectOption('[data-recipient]', String(ctx.app.ids.plg1));
  await page.click(B.tid('msg.composer.attach'));
  await page.locator('#v3-photo').setInputFiles(`${F.FILES}/synthetic_report.pdf`);
  await B.expectVisible(page, 'msg.composer.file.remove');
  await page.fill(B.tid('msg.doctor.placeholder'), 'BROWSER-FILE-MESSAGE');
  await page.click(B.tid('msg.composer.send'));
  await page.waitForFunction(() =>
    document.querySelector('#v3-doctor .thread')?.innerText.includes('BROWSER-FILE-MESSAGE'),
  );
  const message = ctx.app.query("SELECT * FROM care_messages WHERE body='BROWSER-FILE-MESSAGE'")[0];
  assert.equal(message.clinician_id, ctx.app.ids.plg1);
  const file = ctx.app.query(
    "SELECT * FROM stored_files WHERE linked_type='care_message' AND linked_id=?",
    message.id,
  )[0];
  assert.ok(file);
  await F.passUndoWindow(ctx.app);
  await page.selectOption('[data-recipient]', String(ctx.app.ids.psy1));
  await page.selectOption('[data-recipient]', String(ctx.app.ids.plg1));
  await page.waitForSelector(`a[href='/api/v1/files/${file.id}']`);
  await page.click(B.tid('msg.composer.attach'));
  await page.locator('#v3-photo').setInputFiles(`${F.FILES}/synthetic_report.pdf`);
  await B.expectVisible(page, 'msg.composer.file.remove');
  await page.click(B.tid('msg.composer.file.remove'));
  await page.fill(B.tid('msg.doctor.placeholder'), 'BROWSER-NO-FILE');
  await page.click(B.tid('msg.composer.send'));
  await page.waitForFunction(() => document.querySelector('[data-testid="msg.doctor.placeholder"]').value === '');
  const second = ctx.app.query("SELECT id FROM care_messages WHERE body='BROWSER-NO-FILE'")[0];
  assert.ok(second);
  assert.equal(
    ctx.app.query("SELECT count(*) n FROM stored_files WHERE linked_type='care_message' AND linked_id=?", second.id)[0]
      .n,
    0,
  );
});

test('V3 browser: AE actual edited text/severity/relation, crisis fallback and successful response are distinct', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'patA');
  ctx.track(session.ctx);
  const page = session.page;
  await B.open(page, ctx.app, '/app?tab=meds&flow=ae');
  await page.waitForSelector('[data-ae-text]');
  await page.fill('[data-ae-text]', 'BROWSER-DIFFERENT-SYMPTOM');
  await page.check('[name="ae-severity"][value="severe"]');
  await page.check('[name="ae-related"][value="no"]');
  await page.click(B.tid('msg.ae.card.send'));
  await B.expectVisible(page, 'msg.undo.ae_sent');
  const row = ctx.app.query("SELECT * FROM adverse_events WHERE description_enc='BROWSER-DIFFERENT-SYMPTOM'")[0];
  assert.equal(row.severity, 'severe');
  assert.equal(row.relation_patient, 'no');
  const patient = await ctx.api('patA');
  expectOk(await patient.post('/api/v1/consents/base', { action: 'revoke', confirm: true }));
  try {
    await page.fill('[data-ae-text]', F.CRISIS_PHRASE);
    await page.click(B.tid('msg.ae.card.send'));
    await B.expectVisible(page, 'msg.crisis.card.title');
    assert.equal(
      ctx.app.query('SELECT count(*) n FROM adverse_events WHERE description_enc=?', F.CRISIS_PHRASE)[0].n,
      0,
    );
  } finally {
    restoreBaseConsent(ctx.app, ctx.app.ids.patA);
  }
});

test('V3 browser: signal quote/name escaped, release/outcome/undo work, notice editor survives polling and saves PDF/DOCX version', async () => {
  const patient = await ctx.api('patA'),
    doc = await ctx.api('psy1');
  ctx.app.exec("UPDATE crisis_escalations SET status='handled' WHERE status<>'handled'");
  expectOk(await patient.post('/api/v1/me/messages', { text: `${F.CRISIS_PHRASE} <img src=x onerror=alert(1)>` }));
  const signal = await F.crisisSignalFor(doc, ctx.app.ids.patA);
  ctx.app.exec(`UPDATE crisis_escalations SET quote_enc='<img src=x onerror=alert(1)>' WHERE id=${signal.id}`);
  const ae = expectOk(await patient.post('/api/v1/me/adverse-events', { text: 'BROWSER-NOTICE-AE' }));
  await F.passUndoWindow(ctx.app);
  const session = await B.contextAs(ctx.browser, ctx.app, 'psy1');
  ctx.track(session.ctx);
  const page = session.page;
  await B.open(page, ctx.app, '/work?tab=signals');
  await B.expectVisible(page, 'msg.signals.quote');
  const card = page.locator(`[data-signal="crisis-${signal.id}"]`);
  assert.equal(await card.locator('img').count(), 0);
  assert.match(await card.locator(B.tid('msg.signals.quote')).textContent(), /<img/);
  await card.locator(B.tid('msg.signals.take')).click();
  await card.locator('[data-note]').fill('BROWSER-RELEASE-NOTE');
  await card.locator(B.tid('msg.v3.signals.release')).click();
  await card.locator(B.tid('msg.signals.take')).waitFor();
  assert.equal(ctx.app.query('SELECT status FROM crisis_escalations WHERE id=?', signal.id)[0].status, 'new');
  await card.locator(B.tid('msg.undo.action')).click();
  await card.locator('[data-outcome]').waitFor();
  await card.locator('[data-outcome]').selectOption('referred');
  await card.locator(B.tid('msg.v3.signals.outcome')).click();
  await card.locator(B.tid('msg.signals.status.handled')).waitFor();
  assert.equal(
    ctx.app.query('SELECT outcome_code FROM crisis_escalations WHERE id=?', signal.id)[0].outcome_code,
    'referred',
  );
  await page.click(B.tid('msg.signals.filter.ae'));
  const aeCard = page.locator(`[data-signal="ae-${ae.ae.id}"]`);
  await aeCard.locator(B.tid('msg.signals.ae.likely')).click();
  // test-change: редактор извещения убран из «Сигналов»; кнопка ведёт в «Шаблоны и документы» (2026-10-26).
  assert.equal(await aeCard.locator('[data-notice-field]').count(), 0);
  await aeCard.locator(B.tid('msg.signals.notice.open')).click();
  await page.waitForURL(/tab=docs&doc=\d+/);
  await page.locator('[data-field="region"]').fill('BROWSER-NOTICE-EDIT');
  await page.waitForSelector('[data-save="saved"]');
  const docId = Number(new URL(page.url()).searchParams.get('doc'));
  const saved = expectOk(await (await ctx.api('psy1')).get(`/work/api/documents/${docId}`)).document;
  assert.equal(saved.fields.region, 'BROWSER-NOTICE-EDIT');
  assert.equal(saved.ae_id, ae.ae.id);
});

test('V3 browser: clinician reads thread and sends actual file reply; edited visit creates real details and submitted previsit appears in chart', async () => {
  const patient = await ctx.api('patA');
  expectOk(
    await patient.post('/api/v1/me/messages', { text: 'CLINICIAN-READ-MESSAGE', to_clinician_id: ctx.app.ids.psy1 }),
  );
  await F.passUndoWindow(ctx.app);
  const doctorSession = await B.contextAs(ctx.browser, ctx.app, 'psy1');
  ctx.track(doctorSession.ctx);
  const page = doctorSession.page;
  await B.open(page, ctx.app, `/work/patients/${ctx.app.ids.patA}?ptab=messages`);
  await page.waitForSelector('text=CLINICIAN-READ-MESSAGE');
  await page.click(B.tid('msg.composer.attach'));
  await page.locator('#v3-photo').setInputFiles(`${F.FILES}/synthetic_report.pdf`);
  await B.expectVisible(page, 'msg.composer.file.remove');
  await page.fill(B.tid('msg.v3.messages.reply'), 'CLINICIAN-FILE-REPLY');
  await page.click(B.tid('msg.composer.send'));
  await page.waitForFunction(() =>
    document.querySelector('[data-message-thread]')?.innerText.includes('CLINICIAN-FILE-REPLY'),
  );
  const reply = ctx.app.query("SELECT * FROM care_messages WHERE body='CLINICIAN-FILE-REPLY'")[0];
  assert.ok(reply);
  assert.equal(
    ctx.app.query("SELECT count(*) n FROM stored_files WHERE linked_type='care_message' AND linked_id=?", reply.id)[0]
      .n,
    1,
  );
  await B.open(page, ctx.app, `/work/patients/${ctx.app.ids.patA}?ptab=treatment`);
  await page.fill(B.tid('msg.card.placeholder.treatment'), 'Визит');
  await page.click(B.tid('msg.composer.send'));
  await page.waitForSelector('[data-visit-date]');
  const date = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 16);
  await page.fill('[data-visit-date]', date);
  await page.selectOption('[data-visit-format]', 'remote');
  await page.fill('[data-visit-place]', 'BROWSER-LOCATION');
  await page.fill('[data-visit-prepare]', 'BROWSER-PREPARATION');
  await page.click(B.tid('msg.card.draft.send'));
  await B.expectVisible(page, 'msg.undo.sent_to_patient');
  const visit = ctx.app.query("SELECT * FROM visits WHERE place='BROWSER-LOCATION'")[0];
  assert.equal(visit.format, 'remote');
  assert.equal(visit.prepare_enc, 'BROWSER-PREPARATION');
  await F.passUndoWindow(ctx.app);
  const patSession = await B.contextAs(ctx.browser, ctx.app, 'patA');
  ctx.track(patSession.ctx);
  const p = patSession.page;
  await B.open(p, ctx.app, '/app?tab=visits');
  const card = p.locator(`[data-visit="${visit.id}"]`);
  await card.locator(B.tid('msg.visits.fill')).click();
  await card.locator('textarea').first().fill('BROWSER-PREVISIT-DRAFT');
  await card.locator(B.tid('msg.v3.previsit.save')).click();
  await card.getByText('Черновик сохранён', { exact: true }).waitFor();
  await p.reload();
  await p.locator(`[data-visit="${visit.id}"]`).locator(B.tid('msg.visits.fill')).click();
  assert.equal(await p.locator(`[data-visit="${visit.id}"] textarea`).first().inputValue(), 'BROWSER-PREVISIT-DRAFT');
  await p.locator(`[data-visit="${visit.id}"]`).locator(B.tid('msg.previsit.send')).click();
  await B.expectVisible(p, 'msg.previsit.sent');
  await B.open(page, ctx.app, `/work/patients/${ctx.app.ids.patA}?ptab=treatment`);
  await page.locator(B.tid('msg.v3.previsit.summary')).getByText('BROWSER-PREVISIT-DRAFT', { exact: true }).waitFor();
  const editor = page.locator(`[data-edit-visit="${visit.id}"]`);
  await editor.locator('summary').click();
  await editor.locator('[data-edit-place]').fill('BROWSER-LOCATION-EDIT');
  await editor.locator(B.tid('msg.v3.visit.save')).click();
  await page.waitForFunction(
    (id) => document.querySelector(`[data-edit-visit="${id}"]`)?.dataset.version === '2',
    String(visit.id),
  );
  assert.equal(ctx.app.query('SELECT place FROM visits WHERE id=?', visit.id)[0].place, 'BROWSER-LOCATION-EDIT');
});

// «Мне хуже» (F-29, F-16): два вопроса безопасности кнопками; тревожный ответ создаёт сигнал на сервере.
async function openWorse(who) {
  ctx.app.exec("UPDATE crisis_escalations SET status='handled' WHERE status<>'handled'");
  const session = await B.contextAs(ctx.browser, ctx.app, who);
  ctx.track(session.ctx);
  const page = session.page;
  await B.open(page, ctx.app, '/app?tab=meds');
  await page.locator(B.tid('msg.ask.star')).first().click();
  await B.expectPage(page, 'P-13');
  ctx.app.ai.reset();
  await page.click(B.tid('msg.ask.worse'));
  await B.expectVisible(page, 'msg.chat.worse.q1');
  return page;
}
const openSignals = (who) =>
  ctx.app.query(
    "SELECT * FROM crisis_escalations WHERE patient_id=? AND source='button' AND status<>'handled'",
    ctx.app.ids[who],
  );

test('V3 browser: «Мне хуже» → «Да» показывает карточку 112 и создаёт сигнал врачу без вызова модели', async () => {
  const page = await openWorse('patA');
  assert.equal(openSignals('patA').length, 0);
  await page.click(B.tid('msg.chat.worse.q1.yes'));
  await B.expectVisible(page, 'msg.crisis.card.title');
  await page.waitForFunction(
    (sel) => !document.querySelector(sel).textContent.includes('Не получилось'),
    B.tid('msg.crisis.card.who_sees'),
  );
  await page.waitForTimeout(300);
  assert.equal(openSignals('patA').length, 1, 'сигнал создан на сервере');
  assert.equal(await page.getAttribute(B.tid('msg.crisis.card.call'), 'href'), 'tel:112');
  assert.equal(ctx.app.ai.calls().length, 0);
});

test('V3 browser: «Мне хуже» → «Нет» → второй вопрос; «Да, безопасно» сигнала не создаёт, «Нет» создаёт', async () => {
  let page = await openWorse('patA');
  await page.click(B.tid('msg.chat.worse.q1.no'));
  await B.expectVisible(page, 'msg.chat.worse.q2');
  await page.click(B.tid('msg.chat.worse.q2.yes'));
  await B.expectVisible(page, 'msg.chat.worse.after');
  await page.waitForTimeout(300);
  assert.equal(openSignals('patA').length, 0);
  assert.equal(await page.locator(B.tid('msg.crisis.card.title')).count(), 0);

  page = await openWorse('patA');
  await page.click(B.tid('msg.chat.worse.q1.no'));
  await page.click(B.tid('msg.chat.worse.q2.no'));
  await B.expectVisible(page, 'msg.crisis.card.title');
  await page.waitForTimeout(300);
  assert.equal(openSignals('patA').length, 1);
});

test('V3 browser: «Мне хуже» → «Не хочу отвечать» ведёт ко второму вопросу, а не к молчанию', async () => {
  const page = await openWorse('patA');
  await page.click(B.tid('msg.chat.worse.q1.skip'));
  await B.expectVisible(page, 'msg.chat.worse.q2');
  await page.click(B.tid('msg.chat.worse.q2.no'));
  await B.expectVisible(page, 'msg.crisis.card.title');
  await page.waitForTimeout(300);
  assert.equal(openSignals('patA').length, 1);
});
