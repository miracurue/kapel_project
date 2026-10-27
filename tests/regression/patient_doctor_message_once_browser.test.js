'use strict';
// covers: F-47, S-26 — сообщение врачу: уходит сразу один раз, в ленте сразу и ровно одно, одно уведомление с одной кнопкой «Отменить».

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');

const ctx = useBrowserApp();
const TEXT = 'Одно сообщение врачу без дублей';

test('одно сообщение: один запрос, нет блока «Отменить», в ленте ровно одно сразу, через 6 с и после обновления', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'patA');
  ctx.track(session.ctx);
  const page = session.page;
  const posts = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/v1/me/messages')) posts.push(r.url());
  });
  await B.open(page, ctx.app, '/app?tab=doctor');
  await page.waitForSelector('[data-recipient]');
  await page.fill(B.tid('msg.doctor.placeholder'), TEXT);
  await page.click(B.tid('msg.composer.send'));

  const inFeed = () => page.locator('#v3-doctor .thread .msg.me', { hasText: TEXT }).count();
  await page.waitForFunction((t) => document.querySelector('#v3-doctor .thread')?.innerText.includes(t), TEXT);
  assert.equal(await inFeed(), 1, 'в ленте сразу, не после окна отмены');
  assert.equal(
    await page.locator(B.tid('msg.undo.message_sent')).count(),
    0,
    'блока «Сообщение отправлено · Отменить» нет',
  );
  assert.equal(await page.locator(B.tid('msg.undo.action')).count(), 0, 'кнопки «Отменить» нет');
  assert.equal(await page.getByText('Отправлено', { exact: true }).count(), 1, 'слово «Отправлено» одно');

  await page.waitForTimeout(6000);
  assert.equal(await inFeed(), 1, 'после опроса ленты');
  await page.reload();
  await page.waitForFunction((t) => document.querySelector('#v3-doctor .thread')?.innerText.includes(t), TEXT);
  assert.equal(await inFeed(), 1, 'после обновления страницы');
  assert.equal(posts.length, 1, 'на сервер ушёл один запрос');
  assert.equal(ctx.app.query('SELECT count(*) n FROM care_messages WHERE body=?', [TEXT])[0].n, 1);
});
