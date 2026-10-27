'use strict';
// covers: flower presentation, full-screen navigation, accessible watering and reduced motion.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const { expectOk } = require('../lib/client');
const ctx = useBrowserApp();

test('flower panel is open on the right in the diary; expand top-left, cross top-right; full screen, watering and Back', async () => {
  const patient = await ctx.api('patA');
  expectOk(await patient.get('/api/v1/me/flower'));
  const db = ctx.app.db();
  try {
    const pid = ctx.app.ids.patA;
    const stamp = new Date().toISOString();
    db.prepare(
      "INSERT INTO flower_ledger(patient_id,kind,action,amount,steps,idem_key,source,day,created_at) VALUES (?,'earn','demo_bonus',1000,0,'browser:bonus','test',?,?)",
    ).run(pid, stamp.slice(0, 10), stamp);
    db.prepare(
      "INSERT INTO flower_ledger(patient_id,kind,action,amount,steps,idem_key,source,day,created_at) VALUES (?,'spend','water',-500,250,'browser:growth','test',?,?)",
    ).run(pid, stamp.slice(0, 10), stamp);
  } finally {
    db.close();
  }
  const session = await B.contextAs(ctx.browser, ctx.app, 'patA', { viewport: { width: 1440, height: 1000 } });
  ctx.track(session.ctx);
  const page = session.page;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await B.open(page, ctx.app, '/app?tab=diary');
  // В дневнике, как и на остальных страницах, цветок открыт справа; рамкой ничего не обведено.
  const screen = page.locator('#flower-panel');
  await page.locator('#flower-panel.is-sidebar').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-fm-plant]').count(), 0);
  assert.equal(
    await page.evaluate(() => document.querySelector('#flower-panel').contains(document.activeElement)),
    false,
  );
  assert.ok((await screen.boundingBox()).width < 600);
  assert.equal(new URL(page.url()).searchParams.has('flower'), false);
  // «Развернуть» — в левом верхнем углу, крестик — в правом верхнем, слова «Закрыть» на кнопке нет.
  const head = await screen.locator('.fp-head').boundingBox();
  const expand = await screen.locator('.fp-expand').boundingBox();
  const cross = await screen.locator('[data-flower-close]').boundingBox();
  assert.ok(expand.x - head.x < 40 && expand.x < cross.x);
  assert.ok(head.x + head.width - (cross.x + cross.width) < 40);
  assert.equal((await screen.locator('[data-flower-close]').textContent()).trim(), '');
  assert.equal(await screen.locator('[data-flower-close]').getAttribute('aria-label'), 'Закрыть');
  await page.locator('.fp-expand').click();
  await page.waitForURL((url) => url.searchParams.get('flower') === '1');
  assert.equal(await screen.evaluate((el) => el.classList.contains('is-sidebar')), false);
  assert.equal(expectOk(await patient.get('/api/v1/me/flower')).steps, 250, 'enlarging never waters');
  await page.locator('[data-flower-close]').click();
  await page.waitForURL((url) => !url.searchParams.has('flower'));
  assert.equal(await screen.evaluate((el) => el.classList.contains('is-sidebar')), true);
  await page.keyboard.press('Escape');
  await screen.waitFor({ state: 'hidden' });
  await page.locator('[data-flower-counter]').click();
  await page.locator('#flower-panel.is-sidebar').waitFor({ state: 'visible' });
  await page.locator('[data-fp-plant]').click();
  await page.waitForURL((url) => url.searchParams.get('flower') === '1');
  assert.equal(await screen.evaluate((el) => el instanceof HTMLDialogElement && el.open), true);
  const bounds = await screen.boundingBox();
  assert.ok(bounds.width >= 1438 && bounds.height >= 998);
  assert.ok((await page.locator('[data-fp-plant]').boundingBox()).width > 600);
  const colors = await page.evaluate(() => ({
    rain: getComputedStyle(document.querySelector('#flower-panel .fl-rain')).fill,
    pink: getComputedStyle(document.querySelector('#flower-panel .fl-petal-pink-b')).stopColor,
    lilac: getComputedStyle(document.querySelector('#flower-panel .fl-petal-lilac-b')).stopColor,
  }));
  const rgb = (value) => value.match(/[\d.]+/g).map(Number);
  assert.ok(rgb(colors.rain)[2] > rgb(colors.rain)[0]);
  assert.ok(rgb(colors.pink)[0] > rgb(colors.pink)[2]);
  assert.ok(rgb(colors.lilac)[2] > rgb(colors.lilac)[0]);
  const canopy = page.locator('#flower-panel .fl-canopy');
  assert.equal(await canopy.evaluate((el) => getComputedStyle(el).animationName), 'fl-wind');
  const beforeWind = await canopy.evaluate((el) => getComputedStyle(el).transform);
  await page.waitForTimeout(200);
  assert.notEqual(await canopy.evaluate((el) => getComputedStyle(el).transform), beforeWind);
  assert.deepEqual(errors, []);
  const before = expectOk(await patient.get('/api/v1/me/flower'));
  await page.locator('[data-fp-plant]').click();
  await page.waitForFunction(() => document.querySelector('[data-fp-feedback]')?.textContent.length > 0);
  const after = expectOk(await patient.get('/api/v1/me/flower'));
  assert.equal(after.steps, before.steps + 20);
  assert.equal(after.balance, before.balance - 40);
  fs.mkdirSync('/tmp/cc-flower-screen', { recursive: true });
  await page.screenshot({ path: '/tmp/cc-flower-screen/desktop.png' });
  await page.goBack();
  await page.locator('#flower-panel.is-sidebar').waitFor({ state: 'visible' });
  await page.goForward();
  await page.waitForFunction(() => !document.querySelector('#flower-panel').classList.contains('is-sidebar'));
  await page.keyboard.press('Escape');
  await page.waitForURL((url) => !url.searchParams.has('flower'));
  await page.locator('#flower-panel.is-sidebar').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await screen.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-flower-counter]').click();
  await page.locator('[data-fp-plant]').click();
  await page.waitForFunction(() => !document.querySelector('#flower-panel').classList.contains('is-sidebar'));
  assert.ok((await screen.boundingBox()).width >= 388);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: '/tmp/cc-flower-screen/mobile.png' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await canopy.evaluate((el) => getComputedStyle(el).animationName), 'none');
  assert.deepEqual(errors, []);
  await page.locator('[data-flower-close]').click();
  await page.waitForURL((url) => !url.searchParams.has('flower'));
  await page.keyboard.press('Escape');
  await screen.waitFor({ state: 'hidden' });
  // Deep-link refresh opens the same full-screen view and Back has an in-page fallback.
  await B.open(page, ctx.app, '/app?tab=diary&flower=1');
  await screen.waitFor({ state: 'visible' });
  await page.locator('[data-flower-close]').click();
  await screen.waitFor({ state: 'hidden' });
  assert.equal(new URL(page.url()).searchParams.has('flower'), false);
});
