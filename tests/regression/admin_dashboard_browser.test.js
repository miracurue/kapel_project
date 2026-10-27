'use strict';
// covers: обзор администратора на странице /admin: вводная, главы, смена периода, старая ссылка на чат.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');

const ctx = useBrowserApp();

test('обзор открывается первым, чата нет, период переключается, ссылка на чат ведёт на обзор', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'admin1', { viewport: { width: 1280, height: 900 } });
  ctx.track(session.ctx);
  const page = session.page;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await B.open(page, ctx.app, '/admin');
  await B.expectPage(page, 'P-34');
  await page.locator('.dsh-lead').waitFor();
  assert.equal(await page.locator('.dsh-ch').count(), 11);
  assert.equal(await page.locator('#admin-chat, [data-testid="msg.admin.chat.placeholder"]').count(), 0);
  assert.equal(await page.locator('a[data-tab="chat"]').count(), 0);
  assert.equal(await page.locator('.top .tabs a').first().getAttribute('data-tab'), 'dashboard');

  await page.locator('[data-days="30"]').click();
  await page.locator('.dsh-periods [data-days="30"][aria-pressed="true"]').waitFor();
  assert.equal(await page.locator('.dsh-ch').count(), 11);

  await B.open(page, ctx.app, '/admin?tab=chat');
  await page.locator('.dsh-lead').waitFor();
  assert.match(page.url(), /\/admin$/);
  assert.deepEqual(errors, []);
});
