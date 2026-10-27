'use strict';
// «Настройки → Промпт»: слои с описаниями, выбор промпта, версии и итоговый промпт для роли.
// covers: F-101, P-40
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const ctx = useBrowserApp();
const output = '/tmp/cc-prompt-catalog';

test('админка: слои промптов с описаниями, выбор задачи, версии и итоговый промпт', async () => {
  fs.mkdirSync(output, { recursive: true });
  const session = await B.contextAs(ctx.browser, ctx.app, 'admin1', { viewport: { width: 1280, height: 1000 } });
  ctx.track(session.ctx);
  const page = session.page;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await B.open(page, ctx.app, '/admin?tab=settings&s=prompt');
  const pane = page.locator('[data-prompt-pane]');
  await pane.waitFor();
  const tabs = await pane.locator('[data-pcat]').allTextContents();
  assert.deepEqual(tabs, ['Роли', 'Инструменты', 'Навыки', 'Задачи']);
  assert.match(await pane.locator('.prompt-cat-note').innerText(), /Промпт сценария/);
  // по умолчанию открыты задачи; у каждой есть описание и «Где применяется»
  const cards = pane.locator('[data-pitem]');
  assert.equal(await cards.count(), 9);
  assert.match(await cards.first().innerText(), /Где применяется/);
  await pane.locator('[data-pitem="task.document_template"]').click();
  await pane.locator('.prompt-head h3', { hasText: 'Шаблон документа' }).waitFor();
  assert.equal(await pane.locator('[data-pver]').count(), 1);
  await pane.locator('[data-prole]').selectOption('psychologist');
  await pane.locator('[data-pcompose]').click();
  const text = await pane.locator('[data-pcompose-out] .prompt-diff').innerText();
  assert.match(text, /помощник психолога/);
  assert.match(text, /ШАБЛОН/);
  await page.screenshot({ path: `${output}/tasks.png`, fullPage: true });
  await pane.locator('[data-pcat="role"]').click();
  await pane.locator('[data-pitem="role.patient"]').waitFor();
  assert.equal(await pane.locator('[data-pitem]').count(), 3);
  assert.equal(await pane.locator('[data-pcompose]').count(), 0, 'итоговый промпт показывается только для задач и навыков');
  await page.screenshot({ path: `${output}/roles.png`, fullPage: true });
  assert.deepEqual(errors, []);
});
