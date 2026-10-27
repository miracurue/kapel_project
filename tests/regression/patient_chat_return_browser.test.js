'use strict';
// covers: F-27, F-28 — возврат на вкладку «Чат»: открывается последний чат с историей, следующее сообщение идёт в него же,
// черновик ввода не пропадает, а ответ, который готовился в момент ухода, появляется сам.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');

const ctx = useBrowserApp();

const threadsOf = (key) =>
  ctx.app.query("SELECT id FROM ai_threads WHERE owner_user_id=? AND purpose='patient_assistant' ORDER BY id", [
    ctx.app.ids[key],
  ]);
const ask = async (page, text) => {
  await page.fill(B.tid('msg.chat.placeholder'), text);
  await page.click(B.tid('msg.composer.send'));
};

test('ушёл в дневник и вернулся: открыт тот же чат с историей, новое сообщение идёт в него', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'patC');
  ctx.track(session.ctx);
  const page = session.page;
  ctx.app.ai.reset();
  ctx.app.ai.setDefault({ mode: 'text', text: 'Я рядом, расскажи подробнее.' });
  await B.open(page, ctx.app, '/app?tab=chat&new=1');
  await ask(page, 'Мне сегодня тяжело');
  await page.locator('#v3-chat .chat-msg_assistant .chat-msg__text').last().waitFor({ timeout: 10000 });
  await page.waitForFunction(() => /[?&]thread=\d+/.test(location.search), null, { timeout: 5000 });
  const threadId = threadsOf('patC')[0].id;
  assert.equal(threadsOf('patC').length, 1);

  await B.open(page, ctx.app, '/app?tab=diary');
  await B.open(page, ctx.app, '/app?tab=chat');
  await page.waitForFunction(() => /[?&]thread=\d+/.test(location.search));
  assert.match(page.url(), new RegExp(`thread=${threadId}$`));
  await page.locator('#v3-chat .chat-msg_user').first().waitFor({ timeout: 10000 });
  assert.match(await page.locator('#v3-chat').innerText(), /Мне сегодня тяжело/);
  assert.equal(await page.locator('#v2-chat-hello').isVisible(), false, 'вместо приветствия — история');

  await ask(page, 'Спасибо, уже легче');
  await page.waitForFunction(() => document.querySelectorAll('#v3-chat .chat-msg_assistant').length === 2, null, {
    timeout: 10000,
  });
  assert.equal(threadsOf('patC').length, 1, 'сообщение ушло в тот же тред');

  await B.open(page, ctx.app, '/app?tab=chat&new=1');
  assert.equal(await page.locator('#v3-chat .chat-msg').count(), 0, '«Новый чат» открывает пустой');
});

test('черновик ввода переживает переход на другую вкладку', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'patD');
  ctx.track(session.ctx);
  const page = session.page;
  await B.open(page, ctx.app, '/app?tab=chat');
  await page.fill(B.tid('msg.chat.placeholder'), 'Хочу спросить про сон, но не отправил');
  await B.open(page, ctx.app, '/app?tab=diary');
  await B.open(page, ctx.app, '/app?tab=chat');
  assert.equal(await page.inputValue(B.tid('msg.chat.placeholder')), 'Хочу спросить про сон, но не отправил');
});

test('ушёл, пока готовился ответ: вернулся — этапы и ответ появляются сами, без повторной отправки', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'patB');
  ctx.track(session.ctx);
  const page = session.page;
  ctx.app.ai.reset();
  ctx.app.ai.queue({ mode: 'text', text: 'Ответ после долгого раздумья', delay_ms: 5000 });
  await B.open(page, ctx.app, '/app?tab=chat&new=1');
  await ask(page, 'Вопрос с долгим ответом');
  await page.waitForFunction(() => document.querySelector('[data-testid="msg.chat.progress"]'));
  await B.open(page, ctx.app, '/app?tab=tests');
  await B.open(page, ctx.app, '/app?tab=chat');
  await page.waitForFunction(() => /[?&]thread=\d+/.test(location.search));
  await B.expectVisible(page, 'msg.chat.progress');
  await page.waitForFunction(
    () => /Ответ после долгого раздумья/.test(document.querySelector('#v3-chat').innerText),
    null,
    {
      timeout: 20000,
    },
  );
  assert.equal(await page.locator(B.tid('msg.chat.progress')).count(), 0);
  assert.equal(threadsOf('patB').length, 1);
  assert.equal(ctx.app.ai.calls().length, 1, 'модель вызвана один раз');
});
