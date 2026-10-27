'use strict';
// covers: F-15, F-12, W-34 · визуал поля ввода чата пациента: панель вложений открывается
// поверх, а не «в потоке» — композер не растягивается и лента чата не прыгает
// (было: #v3-attach попадал в третью строку сетки .chat-input, .scroll сжимался,
//  .hello с justify-content: center пересчитывал центрирование).
// Проверка решения владелицы 2026-10-25: подсказок прикрепления «Прикреплять:» в поле ввода нет.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const F = require('../lib/flows');

const ctx = useBrowserApp();

const box = (page, selector) => page.locator(selector).boundingBox();
const shown = (page) => page.locator('#v3-attach').isVisible();

test('чат пациента: «+» поднимает панель вложений над полем ввода, ничего не съезжает, панель закрывается', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'patA');
  ctx.track(session.ctx);
  const page = session.page;
  await B.open(page, ctx.app, '/app?tab=chat');
  await B.expectPage(page, 'P-13');
  await page.waitForSelector('.chat-input');
  await page.waitForTimeout(600); // панель «Ваш цветок» справа успевает открыться до замеров

  assert.equal(
    await page.locator(B.tid('msg.composer.suggestions')).count(),
    0,
    'подсказок прикрепления в поле ввода нет',
  );
  assert.equal(await shown(page), false, 'панель вложений закрыта');

  const inputBefore = await box(page, '.chat-input');
  const helloBefore = await box(page, '#v2-chat-hello');
  const attachBefore = await box(page, B.tid('msg.composer.attach'));
  const sendBefore = await box(page, B.tid('msg.composer.send'));

  await page.click(B.tid('msg.composer.attach'));
  await page.waitForSelector('#v3-attach:not([hidden])');
  const panel = await box(page, '#v3-attach');
  const inputAfter = await box(page, '.chat-input');
  const helloAfter = await box(page, '#v2-chat-hello');
  const attachAfter = await box(page, B.tid('msg.composer.attach'));
  const sendAfter = await box(page, B.tid('msg.composer.send'));

  assert.deepEqual(
    { h: Math.round(inputAfter.height), y: Math.round(inputAfter.y) },
    { h: Math.round(inputBefore.height), y: Math.round(inputBefore.y) },
    'поле ввода той же высоты и на том же месте',
  );
  assert.equal(Math.round(helloAfter.y), Math.round(helloBefore.y), 'лента чата не сдвинулась');
  assert.deepEqual(
    { x: Math.round(attachAfter.x), y: Math.round(attachAfter.y) },
    { x: Math.round(attachBefore.x), y: Math.round(attachBefore.y) },
    'кнопка «+» не уехала',
  );
  assert.deepEqual(
    { x: Math.round(sendAfter.x), y: Math.round(sendAfter.y) },
    { x: Math.round(sendBefore.x), y: Math.round(sendBefore.y) },
    'кнопка «Отправить» не уехала',
  );
  assert.ok(panel.width > 0 && panel.height > 0, 'панель вложений видна');
  assert.ok(panel.y + panel.height <= inputAfter.y + 10, 'панель над полем ввода, а не внутри него');

  // закрытие: Esc и повторный клик по «+»
  await page.keyboard.press('Escape');
  assert.equal(await shown(page), false, 'Esc закрывает панель');
  await page.click(B.tid('msg.composer.attach'));
  await page.waitForSelector('#v3-attach:not([hidden])');
  await page.click(B.tid('msg.composer.attach'));
  assert.equal(await shown(page), false, 'второй клик по «+» закрывает панель');

  // клик вне панели — закрытие; выбранный файл при этом не теряется
  await page.click(B.tid('msg.composer.attach'));
  await page.waitForSelector('#v3-attach:not([hidden])');
  await page.locator('#v3-photo').setInputFiles(`${F.FILES}/synthetic_report.pdf`);
  await B.expectVisible(page, 'msg.composer.file.remove');
  await page.locator(B.tid('msg.ai.patient.composer_note')).click({ position: { x: 5, y: 5 } });
  assert.equal(await shown(page), false, 'клик вне панели закрывает её');
  await page.click(B.tid('msg.composer.attach'));
  await page.waitForSelector('#v3-attach:not([hidden])');
  assert.match(await page.locator('#v3-attach').textContent(), /synthetic_report\.pdf/, 'файл остался прикреплён');
});
