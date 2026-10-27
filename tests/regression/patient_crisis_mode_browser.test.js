'use strict';
// covers: F-16, F-46, W-34 · кризисный режим чата пациента в браузере: кризисная фраза открывает разговор с
// закреплённой карточкой 112, сценарное сообщение и быстрые ответы; перезагрузка возвращает в тот же разговор;
// кнопка «Поговорить сейчас» на странице справки открывает его без текста.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const F = require('../lib/flows');

const ctx = useBrowserApp();
const msgs = (page) => page.locator('#v3-chat .chat-msg');

test('кризисная фраза в чате: карточка 112 закреплена, есть сценарный ответ и быстрые ответы, разговор продолжается', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'patA');
  ctx.track(session.ctx);
  const page = session.page;
  await B.open(page, ctx.app, '/app?tab=chat');
  await B.expectPage(page, 'P-13');
  await page.fill(B.tid('msg.chat.placeholder'), F.CRISIS_PHRASE);
  await page.click(B.tid('msg.composer.send'));
  await B.expectVisible(page, 'msg.crisis.chat.pin');
  assert.equal(
    await page.locator(`${B.tid('msg.crisis.chat.pin')} a[href="tel:112"]`).count(),
    1,
    '112 в закреплённой карточке',
  );
  assert.equal(
    await page.locator(B.tid('msg.crisis.chat.contacts_standin')).count(),
    1,
    'место под остальные телефоны помечено как условное',
  );
  await page.waitForFunction(() => document.querySelectorAll('#v3-chat .chat-msg').length >= 2);
  assert.match(await msgs(page).last().innerText(), /ты сейчас в безопасности/);
  assert.equal(
    await page
      .locator(B.tid('msg.crisis.chat.status'))
      .innerText()
      .then((x) => x.length > 0),
    true,
    'статус сигнала виден',
  );

  const pin = page.locator(B.tid('msg.crisis.chat.pin'));
  assert.equal(await pin.getAttribute('data-collapsed'), null, 'в начале карточка полная');
  assert.equal(await page.locator(B.tid('msg.crisis.chat.quick.safe')).isVisible(), true);

  await page.click(B.tid('msg.crisis.chat.quick.safe'));
  assert.equal(await pin.getAttribute('data-collapsed'), '1', 'после первого ответа карточка свёрнута');
  assert.equal(await page.locator(`${B.tid('msg.crisis.chat.pin')} a[href="tel:112"]`).isVisible(), true, '112 видно');
  assert.equal(await page.locator(B.tid('msg.crisis.chat.quick.safe')).isVisible(), false, 'кнопки скрыты');
  await page.waitForFunction(() => document.querySelectorAll('#v3-chat .chat-msg').length >= 4);
  assert.equal(
    await page.locator('#v3-chat .chat-msg_assistant').count(),
    2,
    'на «Да, я в безопасности» пришёл ответ (модель или сценарий)',
  );

  await page.fill(B.tid('msg.chat.placeholder'), 'Рядом никого нет');
  await page.click(B.tid('msg.composer.send'));
  await page.waitForFunction(() => document.querySelectorAll('#v3-chat .chat-msg').length >= 6);
  assert.equal(await page.locator(B.tid('msg.crisis.chat.pin')).count(), 1, 'карточка одна');
  assert.equal(await page.locator(B.tid('msg.crisis.chat.quick.unsafe')).isVisible(), false, 'кнопки не вернулись');
  await page.click(`${B.tid('msg.crisis.chat.pin')} [data-crisis-toggle]`);
  assert.equal(await pin.getAttribute('data-collapsed'), null, 'карточка разворачивается по нажатию');
  await page.click(`${B.tid('msg.crisis.chat.pin')} [data-crisis-toggle]`);

  const shot = process.env.CRISIS_SHOT;
  if (shot) await page.screenshot({ path: shot, fullPage: false });

  const thread = ctx.app.query(
    "SELECT id FROM ai_threads WHERE mode = 'crisis' AND owner_user_id = ?",
    ctx.app.ids.patA,
  )[0].id;
  await B.open(page, ctx.app, `/app?tab=chat&thread=${thread}`);
  await B.expectVisible(page, 'msg.crisis.chat.pin');
  await page.waitForFunction(() => document.querySelectorAll('#v3-chat .chat-msg').length >= 6);
  assert.equal(await page.locator(B.tid('msg.crisis.chat.pin')).count(), 1, 'после перезагрузки тот же разговор');
  assert.equal(await page.locator(B.tid('msg.crisis.chat.quick.safe')).isVisible(), false, 'после перезагрузки кнопок нет');
  assert.equal(await pin.getAttribute('data-collapsed'), '1', 'после перезагрузки карточка свёрнута');
});

test('справка: «Поговорить сейчас» отправляет сигнал и открывает разговор', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'patB');
  ctx.track(session.ctx);
  const page = session.page;
  await B.open(page, ctx.app, '/account/help');
  await B.expectVisible(page, 'msg.help.talk_now');
  await page.click(B.tid('msg.help.talk_now'));
  await B.expectVisible(page, 'msg.crisis.chat.pin');
  assert.match(page.url(), /thread=\d+/);
  await page.waitForFunction(() => document.querySelectorAll('#v3-chat .chat-msg').length >= 1);
  assert.equal(
    ctx.app.query('SELECT count(*) n FROM crisis_escalations WHERE patient_id = ?', ctx.app.ids.patB)[0].n,
    1,
  );
});
