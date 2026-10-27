'use strict';
// covers: вкладка «Шаблоны и документы» (2026-10-26): список шаблонов и документов по пациентам, форма извещения,
// автосохранение с проверкой версии, «Готово», «Исправленная версия», скачивание docx, переход из «Сигналов».
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const F = require('../lib/flows');
const { expectOk } = require('../lib/client');
const ctx = useBrowserApp();
const SHOTS = process.env.CC_SHOTS_DIR || '/tmp/cc-documents-ui';
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });

async function relatedAe() {
  const psy = await ctx.api('psy1');
  const pat = await ctx.api('patA');
  const sertraline = await F.innId(psy, 'сертралин');
  const other = await F.innId(psy, 'эсциталопрам');
  await F.publishPlan(ctx.app, psy, ctx.app.ids.patA, [
    { inn_id: sertraline, dose: 50, unit: 'мг', times: ['утро'] },
    { inn_id: other, dose: 10, unit: 'мг', times: ['вечер'] },
  ]);
  const plan = expectOk(await pat.get('/api/v1/me/meds')).plan_items;
  const product = await F.productOf(pat, sertraline, 'Золофт');
  expectOk(
    await pat.post(`/api/v1/me/plan-items/${encodeURIComponent(plan[0].item_key)}/accept`, { product_id: product.id }),
  );
  return expectOk(
    await psy.post(`/api/v1/patients/${ctx.app.ids.patA}/adverse-events`, {
      text: 'Синтетика: тремор рук',
      severity: 'severe',
      started_on: '2026-10-19',
      symptoms: ['dizzy'],
      decision: 'probable',
      med: { kind: 'plan_item', item_key: plan[0].item_key },
    }),
  ).ae.id;
}

test('шаблоны и документы: один список шаблонов, форма извещения, автосохранение, «Готово», исправленная версия, docx', async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const aeId = await relatedAe();
  const session = await B.contextAs(ctx.browser, ctx.app, 'psy1', { viewport: { width: 1440, height: 900 } });
  ctx.track(session.ctx);
  const page = session.page,
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await B.open(page, ctx.app, '/work?tab=docs');
  await page.waitForSelector('[data-tpl-builtin] a');

  // Название вкладки и единый список без «Заготовок» и «Моих шаблонов».
  assert.match(await page.locator('nav.tabs a[aria-current="page"]').textContent(), /Шаблоны и документы/);
  const body = await page.locator('[data-work-docs]').textContent();
  assert.doesNotMatch(body, /Заготовк|Мои шаблоны/);
  assert.match(await page.locator('[data-tpl-builtin] a', { hasText: 'Запись приёма' }).textContent(), /Встроенный/);
  await shot(page, '01-templates');

  // Шаблон-форма открывается не текстом, а кнопками «Заполнить для пациента» и пустой бланк (только docx).
  await page.locator('[data-tpl-builtin] a', { hasText: 'Росздравнадзор' }).click();
  assert.ok(await page.locator('[data-doc-fill]').isVisible());
  assert.ok(await page.locator('[data-tpl-ai]').isHidden(), 'у формы нет поля ИИ');
  assert.match(await page.locator('[data-doc-blank]').getAttribute('href'), /format=docx/);
  assert.doesNotMatch(await page.locator('[data-work-docs]').textContent(), /PDF/i);
  await page.locator('[data-doc-fill]').click();
  await page.locator('[data-doc-fill-patient]').selectOption(String(ctx.app.ids.patA));
  await page.waitForFunction(() => !document.querySelector('[data-doc-fill-ae]').disabled);
  await page.locator('[data-doc-fill-ae]').selectOption(String(aeId));
  await shot(page, '02-fill');
  await page.locator('[data-doc-fill-create]').click();
  await page.waitForSelector('[data-doc-form] .doc-card');

  // Автозаполнение, обязательные поля, список «Не заполнено» ведёт к полю.
  assert.equal(await page.locator('[data-field="patient_code"]').inputValue(), 'Т-00108');
  assert.equal(await page.locator('[data-field="suspect_drugs.0.trade_name"]').inputValue(), 'Золофт');
  assert.equal(await page.locator('[data-doc-missing] .doc-missing-chip').count(), 1);
  await page.locator('[data-doc-missing] .doc-missing-chip').click();
  assert.equal(await page.evaluate(() => document.activeElement.dataset.field), 'region');
  assert.match(page.url(), /doc=\d+/);
  await page.setViewportSize({ width: 1440, height: 2600 });
  await shot(page, '03-draft-tall');
  await page.setViewportSize({ width: 1440, height: 900 });

  // Условные поля, ограничение препаратов, исключающие флажки.
  assert.ok(await page.locator('[data-field="pregnancy_weeks"]').isHidden());
  await page.locator('[data-field="pregnant"]').check();
  assert.ok(await page.locator('[data-field="pregnancy_weeks"]').isVisible());
  await page.locator('[data-add="suspect_drugs"]').click();
  await page.locator('[data-add="suspect_drugs"]').click();
  assert.ok(await page.locator('[data-add="suspect_drugs"]').isDisabled());
  assert.equal(await page.locator('[data-drug^="suspect_drugs."]').count(), 3);
  await page.locator('[data-drug="suspect_drugs.2"] button', { hasText: 'Убрать' }).click();
  await page.locator('[data-field="seriousness"][value="death"]').check();
  await page.locator('[data-field="seriousness"][value="not_applicable"]').check();
  assert.equal(await page.locator('[data-field="seriousness"]:checked').count(), 1);

  // Автосохранение.
  const api = await ctx.api('psy1');
  const id = Number(new URL(page.url()).searchParams.get('doc'));
  await page.locator('[data-field="suspect_drugs.1.trade_name"]').fill('Второй препарат');
  await page.locator('[data-field="region"]').fill('Москва');
  await page
    .locator('[data-doc-missing] .doc-missing-chip')
    .first()
    .waitFor({ state: 'detached' })
    .catch(() => {});
  await page.waitForSelector('[data-save="saved"]');
  let doc = expectOk(await api.get(`/work/api/documents/${id}`)).document;
  assert.equal(doc.fields.region, 'Москва');
  assert.equal(doc.fields.pregnant, true);
  assert.deepEqual(doc.fields.seriousness, ['not_applicable']);
  assert.equal(doc.fields.suspect_drugs.length, 2);

  // Конфликт версий: документ изменили в другом окне.
  expectOk(await api.put(`/work/api/documents/${id}`, { version: doc.version, fields: doc.fields }, { idem: false }));
  await page.locator('[data-field="contact"]').fill('psy1@example.test');
  await page.waitForSelector('[data-save="conflict"]');
  await shot(page, '04-conflict');
  await page.locator('.doc-bar-state button', { hasText: 'Загрузить актуальную' }).click();
  await page.waitForSelector('[data-save="saved"]');
  await page.locator('[data-field="contact"]').fill('psy1@example.test');
  await page.waitForSelector('[data-save="saved"]');
  await page.waitForFunction(() => !document.querySelector('[data-doc-missing] .doc-missing-chip'));

  // «Готово»: подтверждение словами, затем форма только для чтения.
  await page.locator('[data-doc-ready]').click();
  assert.match(await page.locator('.doc-confirm').textContent(), /нельзя будет изменить/);
  await shot(page, '05-confirm');
  await page.locator('.doc-confirm .btn', { hasText: 'Вернуться к правке' }).click();
  await page.locator('[data-doc-ready]').click();
  await page.locator('[data-testid="msg.doc.ready.confirm"]').click();
  await page.waitForSelector('.doc-locked');
  assert.equal(await page.locator('[data-doc-form] input, [data-doc-form] textarea').count(), 0);
  assert.match(await page.locator('.doc-view .st-pill').first().textContent(), /Готово/);
  assert.match(await page.locator('.doc-row[aria-current] .st-pill').textContent(), /Готово/);
  assert.equal(expectOk(await api.get(`/work/api/documents/${id}`)).document.status, 'ready');
  await page.setViewportSize({ width: 1440, height: 2600 });
  await shot(page, '06-ready-tall');
  await page.setViewportSize({ width: 1440, height: 900 });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-testid="msg.doc.download.docx"]').click(),
  ]);
  assert.match(download.suggestedFilename(), /\.docx$/);
  assert.equal(await page.getByText('PDF').count(), 0);

  // «Исправленная версия»: новый черновик, прежний остаётся готовым.
  await page.locator('[data-testid="msg.doc.revise_btn"]').click();
  await page.waitForSelector('[data-doc-bar]');
  const revised = Number(new URL(page.url()).searchParams.get('doc'));
  assert.notEqual(revised, id);
  assert.ok(await page.locator('.doc-head-tags .chip', { hasText: 'Исправленная версия' }).isVisible());
  assert.equal(expectOk(await api.get(`/work/api/documents/${id}`)).document.status, 'ready');
  await shot(page, '07-list-grouped');

  // Удаление черновика с подтверждением.
  await page.locator('[data-testid="msg.doc.delete_draft"]').click();
  await page.locator('[data-testid="msg.doc.delete.yes"]').click();
  await page.waitForSelector('[data-doc-empty]:not([hidden])');
  assert.equal((await api.get(`/work/api/documents/${revised}`)).status, 404);

  // Перезагрузка по прямой ссылке открывает документ.
  await B.open(page, ctx.app, `/work?tab=docs&doc=${id}`);
  await page.waitForSelector('.doc-locked');
  assert.deepEqual(errors, []);
});

test('шаблоны и документы: телефон 390 px без горизонтальной прокрутки', async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const api = await ctx.api('psy1');
  const created = expectOk(
    await api.post(
      '/work/api/documents',
      { template_key: 'b-roszdravnadzor', patient_id: ctx.app.ids.patA },
      { idem: false },
    ),
    201,
  ).document;
  const session = await B.contextAs(ctx.browser, ctx.app, 'psy1', B.PHONE);
  ctx.track(session.ctx);
  const page = session.page;
  await B.open(page, ctx.app, '/work?tab=docs');
  await page.waitForSelector('[data-tpl-mobile-select]');
  assert.ok(await B.noHorizontalOverflow(page));
  await shot(page, '10-phone-templates');
  await page.locator('[data-doc-seg="mobile"] [data-doc-mode="documents"]').click();
  await page.waitForSelector('[data-doc-mobile-select]');
  await page.locator('[data-doc-mobile-select]').selectOption(String(created.id));
  await page.waitForSelector('[data-doc-form] .doc-card');
  assert.ok(await B.noHorizontalOverflow(page));
  await shot(page, '11-phone-draft');
  await page.locator('[data-doc-missing] .doc-missing-chip').first().click();
  assert.ok(await B.noHorizontalOverflow(page));
  // Ни один элемент документа не выходит за экран (общая проверка прокрутки такое может скрыть).
  const wide = await page.evaluate(() =>
    [...document.querySelectorAll('.doc-view *')]
      .filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1 && n.offsetParent)
      .map((n) => n.className || n.tagName)
      .slice(0, 5),
  );
  assert.deepEqual(wide, []);
  await page.setViewportSize({ width: 390, height: 4200 });
  await shot(page, '12-phone-draft-tall');
});

test('«Сигналы»: вместо редактора одна кнопка «Открыть извещение»', async () => {
  const api = await ctx.api('psy1');
  const items = expectOk(await api.get('/api/v1/signals')).items.filter((x) => x.kind === 'ae');
  assert.ok(items.length, 'есть запись о побочном эффекте');
  const session = await B.contextAs(ctx.browser, ctx.app, 'psy1', { viewport: { width: 1440, height: 900 } });
  ctx.track(session.ctx);
  const page = session.page;
  await B.open(page, ctx.app, '/work?tab=signals');
  const card = page.locator('[data-signal^="ae-"]').first();
  await card.waitFor();
  assert.equal(await page.locator('[data-notice], [data-notice-field]').count(), 0, 'редактора извещения нет');
  await card.locator(B.tid('msg.signals.notice.open')).click();
  await page.waitForURL(/tab=docs&doc=\d+/);
  await page.waitForSelector('[data-doc-form] .doc-card, .doc-locked');
});
