'use strict';
// covers: F-27, F-16; мягкая пауза чата пациента (статус ТРОЛЛЬ): третья метка за 3 часа сразу блокирует поле ввода с
// дословной подписью, перезагрузка страницы сохраняет паузу (сервер), экстренная помощь на месте
// (кризисный разговор снимает паузу с экрана в patient_crisis.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');

const ctx = useBrowserApp();
const PAUSED = 'Мне кажется, вы меня разыгрываете, я от этого очень устаю. Ровно час я буду отдыхать, потом можем снова пообщаться.';

test('третья метка блокирует поле с подписью; после перезагрузки пауза остаётся; 112 виден', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'patB');
  ctx.track(session.ctx);
  const page = session.page;
  ctx.app.ai.reset();
  ctx.app.ai.queue(
    { mode: 'text', text: 'Давай к делу.\n[[GAME]]' },
    { mode: 'text', text: 'Хочется вежливо.\n[[RUDE]]' },
    { mode: 'text', text: 'Вернёмся к теме.\n[[GAME]]' },
  );
  await B.open(page, ctx.app, '/app?tab=chat&new=1');
  for (const text of ['спорим?', 'ты тупая', 'слабо?']) {
    await page.fill(B.tid('msg.chat.placeholder'), text);
    await page.click(B.tid('msg.composer.send'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="msg.chat.progress"]'), null, { timeout: 15000 });
  }
  assert.doesNotMatch(await page.locator('#v3-chat').innerText(), /GAME|RUDE/, 'метки не видны');
  await page.waitForFunction(() => document.querySelector(`[data-testid="msg.chat.placeholder"]`)?.disabled === true, null, {
    timeout: 5000,
  });
  assert.equal(await page.locator(B.tid('msg.composer.send')).isDisabled(), true);
  assert.equal((await page.locator(B.tid('msg.chat.troll.paused')).innerText()).trim(), PAUSED);
  assert.equal(await page.locator(B.tid('msg.chat.troll.call')).isVisible(), true, 'экстренная помощь видна');

  await B.open(page, ctx.app, '/app?tab=chat&new=1');
  assert.equal(await page.locator(B.tid('msg.chat.placeholder')).isDisabled(), true, 'пауза сохранилась на сервере');
  assert.equal((await page.locator(B.tid('msg.chat.troll.paused')).innerText()).trim(), PAUSED);
});

test('админ: в «Людях» у пациента с паузой метка ТРОЛЛЬ и кнопка «Снять статус»', async () => {
  const pid = ctx.app.ids.patC;
  ctx.app.exec(
    `INSERT INTO patient_chat_blocks(patient_id, started_at, blocked_until) VALUES (${pid}, '${new Date().toISOString()}', '${new Date(Date.now() + 3600000).toISOString()}')`,
  );
  const session = await B.contextAs(ctx.browser, ctx.app, 'admin1');
  ctx.track(session.ctx);
  const page = session.page;
  await B.open(page, ctx.app, '/admin?tab=people');
  await page.click('[data-filter="patients"]');
  const row = page.locator(`.prow[data-id="${pid}"]`);
  await row.waitFor({ timeout: 8000 });
  assert.match(await row.innerText(), /ТРОЛЛЬ/);
  assert.doesNotMatch(await row.innerText(), /Зоя|Вымышленная|pat\.c@/, 'ФИО пациента скрыто');
  await row.locator(B.tid('msg.admin.people.troll.clear')).click();
  await page.waitForFunction(() => /Статус снят/.test(document.querySelector('[data-out]')?.textContent || ''), null, { timeout: 5000 });
  assert.equal(ctx.app.query('SELECT cleared_at FROM patient_chat_blocks WHERE patient_id = ?', pid)[0].cleared_at !== null, true);
  assert.doesNotMatch(await page.locator(`.prow[data-id="${pid}"]`).innerText(), /ТРОЛЛЬ/);
});
