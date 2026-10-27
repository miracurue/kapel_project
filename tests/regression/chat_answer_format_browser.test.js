'use strict';
// covers: чат специалиста — вопрос уходит из поля сразу, ход ответа по этапам, форматированный ответ,
// метки источников [n] — кнопки, открывающие источник.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const ctx = useBrowserApp();

test('ответ чата: поле очищается, этапы доступны, markdown отрисован, [n] открывает источник', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'psy1');
  ctx.track(session.ctx);
  const page = session.page;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await B.open(page, ctx.app, '/work?tab=chat');
  await page.waitForSelector(B.tid('msg.wchat.placeholder'));
  await page.addInitScript(() => {
    window.__opened = [];
    window.open = (u) => window.__opened.push(u);
  });
  await page.evaluate(() => {
    window.__opened = [];
    window.open = (u) => window.__opened.push(u);
  });
  let progressId = null;
  await page.route('**/api/v1/ai/clinician/messages', async (route) => {
    progressId = JSON.parse(route.request().postData()).progress_id;
    const response = await route.fetch();
    const body = await response.json();
    body.reply.sources = [{ n: 1, kind: 'literature', literature: true, url: 'https://example.org/article', label: 'Статья', path: 'Журнал, 2024', snippet: 'Аннотация статьи.' }];
    await route.fulfill({ response, json: body });
  });
  ctx.app.ai.queue({ mode: 'text', text: '## Итог\n\n- первый **важный** пункт [1]\n- второй пункт [7]\n\nТекст с `кодом`.' });
  await page.fill(B.tid('msg.wchat.placeholder'), 'Вопрос про терапию');
  await page.click(B.tid('msg.composer.send'));
  await page.waitForSelector('.bubble.md strong');
  assert.equal(await page.inputValue(B.tid('msg.wchat.placeholder')), '', 'вопрос не остаётся в поле');
  const bubble = page.locator('[data-testid="msg.wchat.assistant"] .bubble');
  assert.equal(await bubble.locator('h4').innerText(), 'Итог');
  assert.equal(await bubble.locator('li').count(), 2);
  assert.ok(!(await bubble.innerText()).includes('**'), 'служебные символы не видны');
  assert.equal(await bubble.locator('button.cite').count(), 1, 'кликабельна только метка с известным источником');
  assert.ok((await bubble.innerText()).includes('[7]'), 'метка без источника остаётся текстом');
  await bubble.locator('button.cite').click();
  // статья: в правой панели название, пояснение и ссылка на внешний сайт (не переход без запроса)
  const view = page.locator(B.tid('msg.wchat.source.view'));
  await view.waitFor();
  assert.equal(await view.getAttribute('data-kind'), 'literature');
  const link = page.locator(B.tid('msg.wchat.source.external'));
  assert.equal(await link.getAttribute('href'), 'https://example.org/article');
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  assert.deepEqual(await page.evaluate(() => window.__opened), []);
  assert.equal(await page.locator(B.tid('msg.wchat.source.card')).count(), 1, 'карточка источника под ответом');
  const stages = await page.evaluate(async (id) => (await (await fetch(`/work/api/chat-progress/${id}`)).json()).stages, progressId);
  assert.equal(stages[0], 'Читаю вопрос');
  assert.deepEqual(errors, []);
});
