'use strict';
// covers: капелька с цифрой у методик и тестов, капельки за пройденное упражнение на странице методики, настройки тёплых фраз.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const { RULES } = require('../../src/modules/flower/rules');
const ctx = useBrowserApp();

test('badge shows the drops, the technique page marks it done once, preferences are saved', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'patB', { viewport: { width: 1440, height: 1000 } });
  ctx.track(session.ctx);
  const page = session.page;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await B.open(page, ctx.app, '/app?tab=tests');
  const card = page.locator('[data-technique="grounding-54321"] [data-flower-badge]');
  await card.locator('.drop').waitFor();
  assert.match((await card.textContent()).replace(/\s+/g, ''), new RegExp(`\\+${RULES.technique.drops}`));
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/methods.png`, fullPage: false });

  // test-change: вместо кнопки «Я выполнил(а)» упражнение проходится до конца (владелица, 2026-10-26)
  await B.open(page, ctx.app, '/methods/grounding-54321');
  await page.locator('[data-begin]').click();
  for (const need of [5, 4, 3, 2, 1]) {
    const inputs = page.locator('.tx-fields input');
    assert.equal(await inputs.count(), need);
    await inputs.first().fill('что-то');
    await page.locator('[data-next]').click();
  }
  await page.waitForFunction(() => document.querySelector('[data-technique-feedback]')?.textContent.trim());
  assert.match(await page.locator('[data-technique-feedback]').textContent(), /уже у цветка/);
  await page.locator('.tech-reward-hint [data-flower-badge].is-done').waitFor();
  await page.locator('[data-again]').click();
  await page.locator('[data-begin]').click();
  for (let i = 0; i < 5; i += 1) {
    await page.locator('.tx-fields input').first().fill('ещё');
    await page.locator('[data-next]').click();
  }
  await page.waitForFunction(() =>
    /уже получены/.test(document.querySelector('[data-technique-feedback]').textContent),
  );
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/technique.png`, fullPage: false });

  await B.open(page, ctx.app, '/account/notifications');
  await page.locator('#acc-address_form').selectOption('f');
  await page.locator('#acc-praise_mode').selectOption('quiet');
  await page.waitForTimeout(400);
  const prefs = await page.evaluate(async () => (await fetch('/api/v1/me/prefs')).json());
  assert.equal(prefs.address_form, 'f');
  assert.equal(prefs.praise_mode, 'quiet');
  assert.deepEqual(errors, []);
});
