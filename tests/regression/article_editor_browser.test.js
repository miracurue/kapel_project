'use strict';
// covers: author-approved article chat/editor routes (2026-10-21), public draft isolation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const { expectOk } = require('../lib/client');
const F = require('../lib/flows');
const ctx = useBrowserApp();
const output = '/tmp/cc-article-editor';
// Дизайн: в панели текст по умолчанию показан как у читателя; поле с разметкой открывается кнопкой «Править текст».
const source = async (page) => {
  if (!(await page.locator('[data-lib-body]').isVisible())) await page.locator('[data-lib-text-toggle]').click();
};

test('article editor: chat, resize, central preview, persistence, failure/retry and mobile', async () => {
  fs.mkdirSync(output, { recursive: true });
  const session = await B.contextAs(ctx.browser, ctx.app, 'psy1', { viewport: { width: 1440, height: 1000 } });
  ctx.track(session.ctx);
  const page = session.page;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await B.open(page, ctx.app, '/work?tab=library');
  await page.locator('[data-lib-example]').first().click();
  assert.ok(await page.locator('[data-lib-ai-input]').inputValue());
  await page.screenshot({ path: `${output}/desktop-empty.png` });
  ctx.app.ai.queue({
    mode: 'text',
    text: 'ЗАГОЛОВОК: Первая неделя\nКРАТКО: Объяснение\nТЕГИ: тема:лекарства\n---\nАвторский черновик. Обсудите вопросы с врачом.',
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/work/api/library/ai', async (route) => {
    await gate;
    await route.continue();
  });
  await page.locator('[data-lib-ai]').click();
  await page.locator('[data-lib-editor][aria-busy=true]').waitFor();
  await page.screenshot({ path: `${output}/desktop-working.png` });
  release();
  await page.locator('[data-lib-text-toggle]').waitFor();
  await source(page);
  await page.locator('[data-lib-body]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-lib-body]').value.startsWith('Авторский черновик'));
  await page.unroute('**/work/api/library/ai');
  assert.match(await page.locator('[data-lib-chat]').textContent(), /Первая|Черновик|готов|стать/i);
  const separator = page.locator('[data-lib-resizer]');
  const box = await separator.boundingBox();
  const before = await page.locator('[data-lib-editor]').boundingBox();
  await page.mouse.move(box.x + 3, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x - 90, box.y + 100);
  await page.mouse.up();
  const after = await page.locator('[data-lib-editor]').boundingBox();
  assert.ok(after.width > before.width + 40);
  await separator.press('ArrowRight');
  await page.locator('[data-lib-title]').fill('Ручной заголовок');
  await source(page);
  await page.locator('[data-lib-body]').fill('Ручной текст статьи.');
  await page.locator('[data-lib-preview-toggle]').click();
  assert.ok(await page.locator('.pane [data-lib-preview]').isVisible());
  assert.match(await page.locator('[data-lib-preview]').textContent(), /Ручной текст/);
  await page.screenshot({ path: `${output}/desktop-preview.png` });
  await page.locator('[data-lib-edit]').click();
  await page.locator('[data-lib-save]').click();
  await page.waitForFunction(() => document.querySelector('[data-lib-msg]').textContent.includes('Сохран'));
  const id = new URL(page.url()).searchParams.get('id');
  const doc = await ctx.api('psy1');
  assert.equal(expectOk(await doc.get(`/work/api/library/${id}`)).body_md, 'Ручной текст статьи.');
  assert.ok(!(await page.locator('[data-lib-editor]').isVisible()));
  await page.locator('[data-lib-edit]').click();
  await page.locator('[data-lib-publish]').click();
  await page.waitForFunction(() => document.querySelector('[data-lib-status]').dataset.status === 'published');
  await page.locator('[data-lib-edit]').click();
  await source(page);
  await page.locator('[data-lib-body]').fill('Черновые изменения.');
  await page.locator('[data-lib-save]').click();
  const patient = await ctx.api('patA');
  assert.equal(expectOk(await patient.get(`/api/v1/library/${id}`)).body_md, 'Ручной текст статьи.');
  ctx.app.ai.queue({ mode: 'text', text: 'У вас депрессия.' });
  await page.locator('[data-lib-ai-input]').fill('Сократи статью');
  await page.locator('[data-lib-ai]').click();
  await page.waitForFunction(() => !document.querySelector('[data-lib-ai]').disabled);
  assert.equal(await page.locator('[data-lib-body]').inputValue(), 'Черновые изменения.');
  await page.locator('[data-lib-chat] button').last().waitFor();
  await page.locator('[data-lib-chat] button').last().click();
  await page.waitForFunction(() => !document.querySelector('[data-lib-ai]').disabled);
  await page.screenshot({ path: `${output}/desktop-editor.png` });
  await page.locator('[data-lib-close]').click();
  await page.locator('[data-lib-new]').click();
  await page.locator('[data-lib-empty]').waitFor();
  await page.locator(`[data-lib-mine] [data-id="${id}"], [data-lib-pub] [data-id="${id}"]`).click();
  await page.locator('[data-lib-reading]').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-lib-chat] .u').length >= 3);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/mobile-reading.png` });
  await page.locator('[data-lib-edit]').click();
  assert.ok(await page.locator('[data-lib-editor]').isVisible());
  // Дизайн: на телефоне панель правки открывается поверх чата на весь экран.
  assert.ok(await page.locator('[data-lib-editor]').isVisible());
  assert.ok(await B.noHorizontalOverflow(page));
  await page.screenshot({ path: `${output}/mobile-editor.png` });
  await page.locator('[data-lib-preview-toggle]').click();
  assert.ok(await page.locator('[data-lib-preview]').isVisible());
  assert.ok(await B.noHorizontalOverflow(page));
  await page.screenshot({ path: `${output}/mobile-preview.png` });
  assert.deepEqual(errors, []);
});

test('article editor: audience preview, visible uploaded cover and save returns to reading on desktop/mobile', async () => {
  const doc = await ctx.api('psy1');
  for (const [width, audience, label] of [
    [1440, 'specialist', 'Как увидит специалист'],
    [390, 'patient', 'Как увидит пациент'],
  ]) {
    const item = expectOk(
      await doc.post(
        '/work/api/library',
        { title: 'Обложка и сохранение', body_md: 'Текст статьи.', audience },
        { idem: false },
      ),
      201,
    );
    const session = await B.contextAs(ctx.browser, ctx.app, 'psy1', { viewport: { width, height: 900 } });
    ctx.track(session.ctx);
    const page = session.page;
    await B.open(page, ctx.app, `/work?tab=library&id=${item.id}`);
    await page.locator('[data-lib-edit]').click();
    assert.equal(await page.locator('[data-lib-preview-toggle]').textContent(), label);
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    await page.route('**/api/v1/uploads', async (route) => {
      await pending;
      await route.continue();
    });
    await page.locator('[data-lib-cover-file]').setInputFiles(`${F.FILES}/photo_with_gps.jpg`);
    await page.waitForFunction(() =>
      document.querySelector('[data-lib-panel-msg]').textContent.includes('Загружаю обложку'),
    );
    release();
    await page.waitForFunction(() =>
      document.querySelector('[data-lib-panel-msg]').textContent.includes('Обложка добавлена'),
    );
    await page.waitForFunction(() => document.querySelector('[data-lib-cover-img]').naturalWidth > 0);
    const cover = await page.locator('[data-lib-cover]').boundingBox();
    assert.ok(cover.height >= 100 && cover.y >= 0 && cover.y + cover.height < 900, 'thumbnail is visible after upload');
    assert.equal(await page.locator('[data-lib-cover-label]').textContent(), 'Сменить обложку');
    await page.locator('[data-lib-title]').fill('Сохранённая статья');
    await page.route(`**/work/api/library/${item.id}`, (route) =>
      route.request().method() === 'PUT' ? route.fulfill({ status: 500, body: '{}' }) : route.continue(),
    );
    await page.locator('[data-lib-save]').click();
    await page.waitForFunction(() =>
      document.querySelector('[data-lib-panel-msg]').textContent.includes('Не удалось сохранить'),
    );
    assert.ok(await page.locator('[data-lib-editor]').isVisible());
    assert.equal(await page.locator('[data-lib-title]').inputValue(), 'Сохранённая статья');
    await page.unroute(`**/work/api/library/${item.id}`);
    await page.locator('[data-lib-save]').click();
    await page.locator('[data-lib-editor]').waitFor({ state: 'hidden' });
    assert.ok(await page.locator('[data-lib-reading]').isVisible());
    assert.ok(!(await page.locator('[data-lib-chat]').isVisible()));
    assert.match(await page.locator('[data-lib-preview]').textContent(), /Сохранённая статья/);
    await page.waitForFunction(() => document.querySelector('[data-lib-preview] img').naturalWidth > 0);
    assert.equal(expectOk(await doc.get(`/work/api/library/${item.id}`)).title, 'Сохранённая статья');
    await page.reload();
    await page.locator('[data-lib-edit]').click();
    assert.equal(await page.locator('[data-lib-preview-toggle]').textContent(), label);
    assert.ok(await page.locator('[data-lib-cover]').isVisible());
    await session.ctx.close();
  }
});
