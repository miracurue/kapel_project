'use strict';
// covers: GAD demo catalogue navigation and patient completion on desktop/mobile, including submit retry.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const { expectOk } = require('../lib/client');
const F = require('../lib/flows');
const ctx = useBrowserApp();
const output = '/tmp/cc-gad-methods';

test('catalogue: deep links, read-only reference/placeholder and assignable scales at 1440/390', async () => {
  fs.mkdirSync(output, { recursive: true });
  const { ctx: session, page } = await B.contextAs(ctx.browser, ctx.app, 'psy1');
  ctx.track(session);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [code, text, assignable] of [
      ['hars', 'Инструкция специалисту', false],
      ['mmpi', 'Скоро появится', false],
      ['stai', 'Спилбергера', true],
    ]) {
      await B.open(page, ctx.app, `/work?tab=tools&tool=${code}`);
      const card = page.locator(`[data-tool="${code}"]`);
      await card.waitFor();
      assert.match(await card.textContent(), new RegExp(text));
      assert.equal(await card.locator('[data-assign]').count(), assignable ? 1 : 0);
      assert.equal(await card.locator('input,select,textarea').count(), 0);
      if (code === 'mmpi') assert.match(await card.textContent(), /566/);
      if (code === 'stai') assert.equal(await card.locator('.tool-q li').count(), 40);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: `${output}/${code}-${width}.png`, fullPage: false });
    }
  }
  // Боковой панели и выпадающего списка больше нет: на телефоне тест выбирают карточкой (или из «Скоро появятся»).
  const pick = page.locator('[data-toolcard="ins:usk"]').first();
  if (!(await pick.isVisible())) await page.locator('.soon-list summary').click();
  await pick.click();
  await page.locator('[data-tool="usk"]').waitFor();
  assert.match(page.url(), /tool=usk/);
  assert.deepEqual(errors, []);
});

test('patient: submit failure keeps retry, success praises and identifies psychologist, history stays score-free', async () => {
  const doctor = await ctx.api('plg1');
  const patient = await ctx.api('patA');
  const a = await F.assignTest(ctx.app, doctor, ctx.app.ids.patA, 'bai');
  for (const q of await F.instrumentQuestions(patient, a.id))
    expectOk(await patient.put(`/api/v1/me/assignments/${a.id}/answers/${q.id}`, { value: '0' }));
  const { ctx: session, page } = await B.contextAs(ctx.browser, ctx.app, 'patA');
  ctx.track(session);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await B.open(page, ctx.app, `/app?tab=tests&run=${a.id}`);
  await page.locator('[data-testid="msg.tests.run.submit"]').waitFor();
  await page.route(
    `**/api/v1/me/assignments/${a.id}/submit`,
    (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"E-INTERNAL"}}' }),
    { times: 1 },
  );
  await page.locator('[data-testid="msg.tests.run.submit"]').click();
  await page.locator('[data-submit-error]').waitFor();
  assert.equal(await page.locator('[data-testid="msg.tests.result.done"]').count(), 0);
  await page.locator('[data-testid="msg.tests.run.submit"]').click();
  const done = page.locator('[data-testid="msg.tests.result.done"]');
  await done.waitFor();
  assert.equal(await done.textContent(), 'Тест пройден. Спасибо, что уделили время себе');
  assert.match(await page.locator('[data-testid="msg.tests.result.disclaimer"]').textContent(), /психологу.*На приёме/);
  assert.equal(await page.locator('[data-testid="msg.tests.self.show"]').count(), 0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({ path: `${output}/completed-${width}.png` });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  // test-change: тесты на вкладке «Тесты» страницы «Методики» (2026-10-26)
  await B.open(page, ctx.app, '/app?tab=tests#tests');
  await page.locator('#tests-history').waitFor();
  await page
    .locator('#tests-history')
    .getByText('Тест пройден. Спасибо, что уделили время себе', { exact: true })
    .waitFor();
  assert.match(await page.locator('#tests-history').textContent(), /психологу/);
  const r = expectOk(await patient.get('/api/v1/me/results')).series.find((x) => x.instrument === 'bai');
  assert.equal(r.total_score, null);
});

test('STAI clinician card shows both scales; self-service result is shared only by patient click', async () => {
  const doc = await ctx.api('psy1');
  const patient = await ctx.api('patA');
  const a = await F.assignTest(ctx.app, doc, ctx.app.ids.patA, 'stai');
  const result = expectOk(await F.completeTest(patient, a.id, () => '1'));
  const { ctx: doctorSession, page: doctorPage } = await B.contextAs(ctx.browser, ctx.app, 'psy1');
  ctx.track(doctorSession);
  await B.open(doctorPage, ctx.app, `/work/patients/${ctx.app.ids.patA}?ptab=tests`);
  const scales = doctorPage.locator(`[data-stai="${result.id}"]`);
  await scales.waitFor();
  assert.match(await scales.textContent(), /Ситуативная тревожность.*50.*Личностная тревожность.*41/s);
  const { ctx: patientSession, page } = await B.contextAs(ctx.browser, ctx.app, 'patB');
  ctx.track(patientSession);
  const self = await ctx.api('patB');
  const selfA = expectOk(await self.post('/api/v1/me/self-tests', { instrument_code: 'gad7' }));
  for (const question of await F.instrumentQuestions(self, selfA.id))
    expectOk(await self.put(`/api/v1/me/assignments/${selfA.id}/answers/${question.id}`, { value: '0' }));
  await B.open(page, ctx.app, `/app?tab=tests&run=${selfA.id}`);
  await page.locator('[data-testid="msg.tests.run.submit"]').click();
  await page.locator('[data-testid="msg.tests.result.done"]').waitFor();
  assert.match(await page.locator('[data-testid="msg.tests.result.disclaimer"]').textContent(), /самостоятельно/);
  await page.locator('[data-testid="msg.tests.self.show"]').click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="msg.tests.result.disclaimer"]').textContent.includes('поделился'),
  );
  assert.ok(expectOk(await self.get('/api/v1/me/results')).series[0].shared_at);
});
