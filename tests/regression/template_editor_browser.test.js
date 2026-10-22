'use strict';
// covers: owner-requested template editor parity with articles (2026-10-21).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const { expectOk } = require('../lib/client');
const ctx = useBrowserApp();

test('templates: chat, current-text edits, resize, preview, persistence, retry and patient-copy isolation', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'psy1', { viewport: { width: 1440, height: 1000 } });
  ctx.track(session.ctx);
  const page = session.page,
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await B.open(page, ctx.app, '/work?tab=docs');
  await page.locator('[data-tpl-example]').first().click();
  ctx.app.ai.queue({ mode: 'text', text: 'Шаблон первого приёма\nПациент: [ФИО]\nЖалобы: [жалобы]' });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/work/api/templates/ai', async (route) => {
    await gate;
    await route.continue();
  });
  await page.locator('[data-tpl-ai]').click();
  await page.locator('[data-tpl-editor][aria-busy=true]').waitFor();
  assert.ok(await page.locator('[data-tpl-new]').isDisabled());
  release();
  await page.waitForFunction(() => !document.querySelector('[data-tpl-ai]').disabled);
  await page.unroute('**/work/api/templates/ai');
  assert.match(await page.locator('[data-tpl-body]').inputValue(), /Пациент/);
  const separator = page.locator('[data-tpl-resizer]');
  const before = await page.locator('[data-tpl-editor]').boundingBox();
  await separator.press('ArrowLeft');
  assert.ok((await page.locator('[data-tpl-editor]').boundingBox()).width > before.width);
  await page.locator('[data-tpl-title]').fill('Мой шаблон');
  await page.locator('[data-tpl-body]').fill('Пациент: [ФИО]\nРучная правка');
  await page.locator('[data-tpl-preview-toggle]').click();
  assert.match(await page.locator('.pane [data-tpl-preview]').textContent(), /Ручная правка/);
  await page.locator('[data-tpl-edit]').click();
  await page.route('**/work/api/templates/*', (route) =>
    route.request().method() === 'PUT' ? route.fulfill({ status: 500, body: '{}' }) : route.continue(),
  );
  await page.locator('[data-tpl-save]').click();
  await page.waitForFunction(() =>
    document.querySelector('[data-tpl-panel-msg]').textContent.includes('Не удалось сохранить'),
  );
  assert.equal(await page.locator('[data-tpl-body]').inputValue(), 'Пациент: [ФИО]\nРучная правка');
  await page.unroute('**/work/api/templates/*');
  await page.locator('[data-tpl-save]').click();
  await page.locator('[data-tpl-editor]').waitFor({ state: 'hidden' });
  const api = await ctx.api('psy1');
  let item = expectOk(await api.get('/work/api/templates')).own.find((x) => x.title === 'Мой шаблон');
  assert.equal(item.messages.length, 2);
  await page.locator('[data-tpl-ai-input]').fill('Сократи шаблон');
  ctx.app.ai.queue({ mode: 'text', text: 'У вас депрессия.' });
  await page.locator('[data-tpl-ai]').click();
  await page.waitForFunction(() => !document.querySelector('[data-tpl-ai]').disabled);
  assert.equal(await page.locator('[data-tpl-body]').inputValue(), item.body);
  assert.equal(await page.locator('[data-tpl-ai-input]').inputValue(), 'Сократи шаблон');
  ctx.app.ai.queue({ mode: 'text', text: 'Краткий шаблон\nПациент: [ФИО]' });
  await page.locator('[data-tpl-chat] button').last().click();
  await page.waitForFunction(() => !document.querySelector('[data-tpl-ai]').disabled);
  const modelData = JSON.parse(ctx.app.ai.calls().at(-1).messages.at(-1).content);
  assert.equal(modelData.current.body, item.body);
  assert.equal(modelData.request, 'Сократи шаблон');
  assert.ok(modelData.history.length >= 2);
  await page.locator('[data-tpl-panel-msg] button').click();
  assert.equal(await page.locator('[data-tpl-body]').inputValue(), item.body);
  await page.locator('[data-tpl-save]').click();
  await page.locator('[data-tpl-editor]').waitFor({ state: 'hidden' });
  await page.reload();
  await page.locator(`[data-tpl-own] [data-id="${item.id}"]`).click();
  await page.locator('[data-tpl-edit]').click();
  assert.ok((await page.locator('[data-tpl-chat] .u').count()) >= 3);
  await page.locator('[data-tpl-patient]').selectOption(String(ctx.app.ids.patA));
  await page.locator('[data-tpl-fill]').click();
  await page.locator('[data-tpl-editor]').waitFor({ state: 'hidden' });
  assert.ok(!(await page.locator('[data-tpl-preview]').textContent()).includes('[ФИО]'));
  item = expectOk(await api.get('/work/api/templates')).own.find((x) => x.id === item.id);
  assert.match(item.body, /\[ФИО\]/);
  await page.locator('[data-tpl-edit]').click();
  assert.match(await page.locator('[data-tpl-body]').inputValue(), /\[ФИО\]/);
  fs.mkdirSync('/tmp/cc-template-editor', { recursive: true });
  await page.screenshot({ path: '/tmp/cc-template-editor/desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  // Дизайн: на телефоне панель правки открывается поверх чата на весь экран (а не скрывает его через display:none).
  assert.ok(await page.locator('[data-tpl-editor]').isVisible());
  assert.ok(await B.noHorizontalOverflow(page));
  await page.screenshot({ path: '/tmp/cc-template-editor/mobile.png' });
  await page.locator('[data-tpl-close]').click();
  assert.ok(await page.locator('[data-tpl-preview]').isVisible());
  assert.ok(await page.locator('[data-tpl-mobile-select]').isVisible());
  assert.ok(await B.noHorizontalOverflow(page));
  assert.deepEqual(errors, []);
});
