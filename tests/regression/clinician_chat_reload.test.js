'use strict';
// covers: F-32 — чат специалиста: обновление страницы во время ответа не теряет ответ, «Новый чат» не перезагружает страницу
// и открывает новый тред, вопрос из открытого треда уходит в него же.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const ctx = useBrowserApp();
const output = '/tmp/cc-clinician-chat-reload';

async function open(key = 'psy1', url = '/work?tab=chat') {
  fs.mkdirSync(output, { recursive: true });
  const session = await B.contextAs(ctx.browser, ctx.app, key);
  ctx.track(session.ctx);
  const errors = [];
  session.page.on('pageerror', (e) => errors.push(e.message));
  await B.open(session.page, ctx.app, url);
  return { page: session.page, errors };
}
const ask = async (page, text) => {
  await page.fill(B.tid('msg.wchat.placeholder'), text);
  await page.click(B.tid('msg.composer.send'));
};
const threads = () => ctx.app.query("SELECT id, title FROM ai_threads WHERE purpose='clinician_chat' ORDER BY id");

test('обновление страницы во время ответа: тред открывается по адресу, ответ появляется сам', async () => {
  const { page, errors } = await open();
  ctx.app.ai.queue({ mode: 'text', text: 'Ответ после задержки', delay_ms: 4000 });
  await ask(page, 'Вопрос с долгим ответом');
  await page.waitForFunction(() => /[?&]thread=\d+/.test(location.search), null, { timeout: 5000 });
  await page.reload();
  await page.waitForSelector('.msg.ai .bubble.is-working');
  const box = await page.locator('.msg.ai .bubble.is-working .progress').boundingBox();
  assert.ok(box.height > 16, 'список этапов не сжат в полоску');
  await page.screenshot({ path: `${output}/waiting-after-reload.png` });
  await page.waitForFunction(() => /Ответ после задержки/.test(document.querySelector('[data-feed]').innerText), null, { timeout: 15000 });
  assert.equal(await page.locator('.msg.ai .bubble.is-working').count(), 0);
  await page.screenshot({ path: `${output}/answer-after-reload.png` });
  assert.deepEqual(errors, []);
});

test('«Новый чат» не перезагружает страницу, следующий вопрос идёт в новый тред; вопрос в открытом треде — в него', async () => {
  const { page, errors } = await open();
  ctx.app.ai.setDefault({ mode: 'text', text: 'Синтетический ответ' });
  const before = threads().length;
  await ask(page, 'Первый вопрос');
  await page.waitForSelector('.msg.ai .bubble:not(.is-working)', { timeout: 10000 });
  const first = threads().at(-1).id;
  await page.evaluate(() => { window.__marker = 1; });
  await page.click(B.tid('msg.chat.history.new'));
  assert.equal(await page.evaluate(() => window.__marker), 1, 'страница не перезагружалась');
  assert.equal(await page.locator('[data-feed] .msg').count(), 0, 'лента очищена');
  await ask(page, 'Второй вопрос в новом чате');
  await page.waitForSelector('.msg.ai .bubble:not(.is-working)', { timeout: 10000 });
  const rows = threads();
  assert.equal(rows.length, before + 1, 'новый чат создал один новый тред');
  const second = rows.at(-1).id;
  assert.notEqual(second, first);
  await ask(page, 'Продолжение во втором');
  await page.waitForFunction(() => document.querySelectorAll('[data-feed] .msg.ai .bubble:not(.is-working)').length === 2, null, { timeout: 10000 });
  assert.equal(threads().length, before + 1, 'новых тредов не прибавилось');
  const inSecond = ctx.app.query('SELECT COUNT(*) AS n FROM ai_messages WHERE thread_id = ? AND role = ?', [second, 'user'])[0].n;
  assert.equal(inSecond, 2);
  assert.equal(await page.locator('[data-feed] .msg.me').count(), 2, 'вопросы в ленте не дублируются');
  await page.screenshot({ path: `${output}/new-chat.png` });
  assert.deepEqual(errors, []);
});
