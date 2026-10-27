'use strict';
// covers: F-16, F-46, W-34 · аудит кризисных сценариев чата пациента в браузере (2026-10-26):
// кризисная формулировка вне старого словаря и сигнал модели (raise_crisis_signal) показывают закреплённую карточку 112;
// обновление страницы без адреса треда возвращает в тот же кризисный разговор, а не в пустой чат.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');

const ctx = useBrowserApp();

async function sendAndWaitPin(page, text) {
  await page.fill(B.tid('msg.chat.placeholder'), text);
  await page.click(B.tid('msg.composer.send'));
  await B.expectVisible(page, 'msg.crisis.chat.pin');
  assert.equal(await page.locator(`${B.tid('msg.crisis.chat.pin')} a[href="tel:112"]`).count(), 1, '112 наверху чата');
}

test('кодовый путь: «Я готов умереть» открывает кризисный режим, обновление без адреса треда возвращает в него', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'patA');
  ctx.track(session.ctx);
  const page = session.page;
  await B.open(page, ctx.app, '/app?tab=chat');
  await sendAndWaitPin(page, 'Мне плохо, я готов умереть');
  assert.equal(
    ctx.app.query('SELECT count(*) n FROM crisis_escalations WHERE patient_id = ?', ctx.app.ids.patA)[0].n,
    1,
    'сигнал врачу создан',
  );
  // страница открывается заново без параметра thread
  await B.open(page, ctx.app, '/app?tab=chat');
  await B.expectVisible(page, 'msg.crisis.chat.pin');
  await page.waitForFunction(() => document.querySelectorAll('#v3-chat .chat-msg').length >= 2);
  assert.equal(await page.locator(B.tid('msg.crisis.chat.pin')).count(), 1, 'карточка одна');
  // и новое сообщение уходит в тот же кризисный тред
  await page.fill(B.tid('msg.chat.placeholder'), 'не знаю что делать');
  await page.click(B.tid('msg.composer.send'));
  await page.waitForFunction(() => document.querySelectorAll('#v3-chat .chat-msg_assistant').length >= 2);
  assert.equal(
    ctx.app.query("SELECT count(*) n FROM ai_threads WHERE mode = 'crisis' AND owner_user_id = ?", ctx.app.ids.patA)[0]
      .n,
    1,
    'один кризисный тред',
  );
});

test('путь модели: raise_crisis_signal в обычном разговоре показывает карточку 112 и включает кризисный режим', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'patB');
  ctx.track(session.ctx);
  const page = session.page;
  await B.open(page, ctx.app, '/app?tab=chat');
  ctx.app.ai.reset();
  ctx.app.ai.queue(
    { mode: 'tool', name: 'raise_crisis_signal', arguments: { reason: 'говорит, что не видит выхода' } },
    { mode: 'text', text: 'Я здесь.' },
  );
  await sendAndWaitPin(page, 'не вижу выхода, дальше никак');
  await page.waitForFunction(() => document.querySelectorAll('#v3-chat .chat-msg').length >= 2);
  assert.match(await page.locator('#v3-chat .chat-msg').last().innerText(), /ты сейчас в безопасности/);
  const row = ctx.app.query(
    "SELECT mode, crisis_escalation_id FROM ai_threads WHERE owner_user_id = ? AND mode = 'crisis'",
    ctx.app.ids.patB,
  );
  assert.equal(row.length, 1);
  assert.ok(row[0].crisis_escalation_id, 'тред связан с сигналом врачу');
});
