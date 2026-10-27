'use strict';
// covers: методики на странице приложения (2026-10-26): дыхание и релаксация проходятся до конца, без внутренней прокрутки,
// капельки начисляются за пройденное упражнение, а не за нажатие.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const { expectOk } = require('../lib/client');
const { RULES } = require('../../src/modules/flower/rules');
const ctx = useBrowserApp();

async function open(who, slug) {
  const s = await B.contextAs(ctx.browser, ctx.app, who, { viewport: { width: 1440, height: 900 } });
  ctx.track(s.ctx);
  const errors = [];
  s.page.on('pageerror', (e) => errors.push(e.message));
  await s.page.clock.install();
  await B.open(s.page, ctx.app, `/methods/${slug}`);
  await s.page.locator('[data-technique-app] .tx').waitFor();
  return { page: s.page, errors };
}

test('breathing: drops come only when all cycles are done, page has no inner scroll or iframe', async () => {
  const api = await ctx.api('patB');
  const before = expectOk(await api.get('/api/v1/me/flower')).balance;
  const { page, errors } = await open('patB', 'breathing-box');
  assert.equal(await page.locator('iframe').count(), 0);
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1),
    'страница помещается без прокрутки',
  );
  await page.locator('[data-toggle]').click();
  await page.clock.runFor(30000);
  assert.equal(await page.locator('[data-done]').isHidden(), true, 'на полпути упражнение не засчитано');
  assert.equal(expectOk(await api.get('/api/v1/me/flower')).balance, before);
  await page.clock.runFor(70000);
  await page.locator('[data-done]').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('[data-technique-feedback]')?.textContent.trim());
  assert.equal(expectOk(await api.get('/api/v1/me/flower')).balance - before, RULES.technique.drops);
  assert.deepEqual(errors, []);
});

test('muscle relaxation finishes after all seven groups and a specialist sees it without rewards', async () => {
  const { page, errors } = await open('patB', 'pmr');
  await page.locator('[data-toggle]').click();
  await page.clock.runFor(130000);
  await page.locator('[data-done]').waitFor({ state: 'visible' });
  const doc = await open('psy1', 'breathing-478');
  assert.equal(await doc.page.locator('[data-technique-feedback]').count(), 0, 'у специалиста наград нет');
  assert.deepEqual(errors.concat(doc.errors), []);
});
