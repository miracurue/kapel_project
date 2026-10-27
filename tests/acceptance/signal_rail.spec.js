'use strict';

// Панель «Требует вашего внимания» на главной специалиста: свежий необработанный сигнал виден сразу;
// закрытая панель не показывается, пока не прошло время напоминания, и возвращается позже; нового сигнала ждать не нужно.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const F = require('../lib/flows');

const ctx = useBrowserApp();
const RAIL = '[data-alert-rail]';

test('панель сигналов: видна, закрывается, возвращается после срока напоминания; психологу — без побочных эффектов', async () => {
  const p = await ctx.api('patA');
  await p.post('/api/v1/me/adverse-events', {
    symptoms: ['nausea'],
    text: 'Синтетика: тошнота',
    severity: 'noticeable',
    related: 'yes',
  });
  await F.passUndoWindow(ctx.app);

  const psy = await B.contextAs(ctx.browser, ctx.app, 'psy1');
  ctx.track(psy.ctx);
  await B.open(psy.page, ctx.app, '/work?tab=chat');
  await psy.page.waitForSelector(`${RAIL}:not([hidden])`, { timeout: 15000 });
  assert.match(await psy.page.locator(RAIL).textContent(), /Побочный эффект/);

  await psy.page.click('[data-alert-close]');
  assert.ok(await psy.page.locator(RAIL).isHidden(), 'после закрытия панели нет');

  // при следующем заходе в пределах срока напоминания панель не появляется
  await B.open(psy.page, ctx.app, '/work?tab=chat');
  await psy.page.waitForTimeout(2500);
  assert.ok(await psy.page.locator(RAIL).isHidden(), 'до конца срока панель не возвращается');

  // срок напоминания истёк — панель возвращается
  await psy.page.evaluate(() => localStorage.removeItem('kapel.alertRail.snooze'));
  await B.open(psy.page, ctx.app, '/work?tab=chat');
  await psy.page.waitForSelector(`${RAIL}:not([hidden])`, { timeout: 15000 });

  const plg = await B.contextAs(ctx.browser, ctx.app, 'plg1');
  ctx.track(plg.ctx);
  await B.open(plg.page, ctx.app, '/work?tab=chat');
  await plg.page.waitForTimeout(2500);
  assert.ok(await plg.page.locator(RAIL).isHidden(), 'психологу побочные эффекты не показываются');
});
