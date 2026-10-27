'use strict';
// covers: вкладка «Шаблоны и документы»: метка встроенных шаблонов, кнопка «Сохранить как документ» после подстановки.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const ctx = useBrowserApp();

test('встроенный шаблон помечен; после подстановки данных пациента текст сохраняется как документ', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'psy1', { viewport: { width: 1440, height: 900 } });
  ctx.track(session.ctx);
  const page = session.page,
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await B.open(page, ctx.app, '/work?tab=docs');
  await page.waitForSelector('[data-tpl-builtin] a');
  assert.ok(await page.locator('[data-tpl-builtin] a.th-builtin').count());
  assert.equal(await page.locator('[data-tpl-own] a.th-builtin').count(), 0);

  await page.locator('[data-tpl-builtin] a', { hasText: 'Памятка' }).click();
  assert.ok(await page.locator('[data-tpl-builtin-tag]').isVisible());
  assert.ok(await page.locator('[data-tpl-save-doc]').isHidden(), 'до подстановки кнопки нет');

  await page.locator('[data-tpl-edit]').click();
  await page.locator('[data-tpl-patient]').selectOption(String(ctx.app.ids.patA));
  await page.locator('[data-tpl-fill]').click();
  await page.waitForSelector('[data-tpl-save-doc]:not([hidden])');
  await page.locator('[data-tpl-save-doc]').click();
  await page.waitForFunction(() =>
    /Сохранено в «Документах»/.test(document.querySelector('[data-tpl-msg]').textContent),
  );

  await page.locator('[data-doc-mode="documents"]').first().click();
  const row = page.locator('[data-doc-list] a.doc-row', { hasText: 'Памятка пациенту' });
  await row.first().waitFor();
  await row.first().click();
  await page.waitForSelector('[data-doc-text]');
  assert.doesNotMatch(await page.locator('[data-doc-text]').textContent(), /\[ФИО\]/);
  assert.deepEqual(errors, []);
});
