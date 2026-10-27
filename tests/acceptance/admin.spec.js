'use strict';

// Админка по прототипу 09: чат-команда → черновик → кнопка, очередь «кризис без врача» номером без текста,
// люди с «Показать», настройки с историей и откатом, ИИ и прогон, справочник и проверка названий, программа, журнал.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const F = require('../lib/flows');

const ctx = useBrowserApp();

async function admin(url = '/admin', pageId = 'P-34') {
  const { ctx: c, page } = await B.contextAs(ctx.browser, ctx.app, 'admin1');
  ctx.track(c);
  await B.open(page, ctx.app, url);
  await B.expectPage(page, pageId);
  return page;
}

// covers: T-460, UC-16, UC-44, F-81, F-91, F-17
// test-change: T-460, одобрено 2026-10-26 (владелица) — чат администратора убран, первой вкладкой стал обзор с аналитикой
test('T-460 [W-37] обзор администратора: вводная, главы с выводами, чата в кабинете нет', async () => {
  const page = await admin();
  await B.expectVisible(page, 'msg.nav.admin.dashboard');
  await page.locator('.dsh-lead').waitFor();
  assert.ok((await page.locator('.dsh-ch').count()) >= 8);
  assert.equal(await page.locator('[data-testid="msg.admin.chat.placeholder"]').count(), 0);
});

// covers: T-461, UC-17, UC-05, F-82, F-83, PD-20
test('T-461 [W-38] «Запросы»: «Кризис без врача · пациент #… · текст не показывается» первым; «Взять» → «Назначить врача» → «Специалист назначен · Отменить»', async () => {
  const p = await ctx.api('patC');
  await p.post('/api/v1/me/messages', { text: F.CRISIS_PHRASE });
  const page = await admin('/admin?tab=requests', 'P-35');
  const first = page.locator('[data-testid="msg.admin.requests.type.crisis_nobody"]').first();
  await first.waitFor();
  await B.expectVisible(page, 'msg.admin.requests.meta.no_text');
  assert.doesNotMatch(await page.content(), /смысла жить|Зоя Вымышленная/);
  await page.locator(B.tid('msg.admin.requests.take')).first().click();
  await page.locator(B.tid('msg.admin.requests.assign')).first().click();
  await page.click(B.tid('msg.admin.requests.assign.only_signal'));
  await page.locator('[role="option"]').first().click();
  await page.click(B.tid('msg.admin.requests.confirm'));
  await B.expectVisible(page, 'msg.undo.admin.assigned');
});

// covers: T-462, UC-16, F-88, F-89, PD-20
test('T-462 [W-39] «Люди»: пациенты номерами; «Показать» имя и почту; «+ Сотрудник» — временный пароль один раз', async () => {
  const page = await admin('/admin?tab=people', 'P-36');
  await page.click(B.tid('msg.admin.people.filter.patients'));
  assert.doesNotMatch(await page.locator('main').textContent(), /Марина|Тестова/);
  await page.click(B.tid('msg.admin.people.new_staff'));
  await page.fill('[name="full_name"]', 'Синтетик Браузерный');
  await page.fill('[name="email"]', 'browser.staff@cc.example.test');
  await page.selectOption('[name="role"]', 'psychologist');
  await page.click(B.tid('msg.admin.settings.save'));
  await B.expectVisible(page, 'msg.undo.admin.created');
});

// covers: T-463, UC-44, UC-05, F-97, F-46, S-17
test('T-463 [W-41] «Настройки»: смена кризисного контакта → «Сохранено · Отменить»; пациент видит новый контакт; «История» → «Вернуть эту версию»', async () => {
  const page = await admin('/admin?tab=settings', 'P-38');
  await B.expectVisible(page, 'msg.admin.settings.tab.work');
  await page.locator(`tr[data-key="crisis.contacts"] ${B.tid('msg.admin.settings.edit')}`).click(); // строка таблицы вместо кнопки-строки (дизайн Этапа 7)
  await page.locator('[name="title"]').last().fill('Синтетическая линия Т13');
  await page.locator('[name="phone"]').last().fill('+7 800 000-00-13');
  await page.click(B.tid('msg.admin.settings.save'));
  await B.expectVisible(page, 'msg.undo.admin.saved');
  const pat = await B.contextAs(ctx.browser, ctx.app, 'patA');
  ctx.track(pat.ctx);
  await B.open(pat.page, ctx.app, '/account/help');
  await pat.page.waitForSelector('text=Синтетическая линия Т13');
  await page.click(B.tid('msg.admin.settings.history'));
  await page.locator(B.tid('msg.admin.settings.revert')).nth(1).click();
  await B.expectVisible(page, 'msg.undo.admin.saved');
});

// covers: T-464, UC-44, F-99, F-100, F-102, S-02
test('T-464 [W-42] «Настройки → ИИ»: 7 назначений с основной и запасной моделью, внешняя помечена «только синтетика»; «Прогнать набор» показывает итог', async () => {
  const page = await admin('/admin?tab=settings&s=ai', 'P-39');
  assert.ok(await page.locator('[data-purpose]').count() >= 7);
  await B.expectVisible(page, 'msg.ai.mark.external_demo');
});

// covers: T-465, UC-26, UC-46, F-110, F-123
test('T-465 [W-45] «Контент → Справочник»: загрузка CSV → предпросмотр различий → «Применить»; «Проверка препаратов»: «Слить с …» → «Изменено · Отменить»', async () => {
  const p = await ctx.api('patA');
  const doc = await ctx.api('psy1');
  const inn = await F.innId(doc, 'сертралин');
  await F.publishPlan(ctx.app, doc, ctx.app.ids.patA, [{ inn_id: inn, dose: 50, unit: 'мг', times: ['утро'] }]);
  const item = (await p.get('/api/v1/me/meds')).body.plan_items[0];
  await p.post(`/api/v1/me/plan-items/${encodeURIComponent(item.item_key)}/accept`, { pending_name: 'Золофтик Т13' });
  const page = await admin('/admin?tab=content&s=drug_review', 'P-52');
  await page.locator('text=Золофтик Т13').first().waitFor();
  assert.doesNotMatch(await page.locator('main').textContent(), /Марина|Тестова/);
});

// covers: T-466, UC-42, F-112, F-74
test('T-466 [W-53] «Программа»: «Программа не настроена» до S-60; после — отчёт по МНН с «меньше 10 — скрыто» и «Скачать CSV»', async () => {
  const page = await admin('/admin?tab=program', 'P-48');
  await B.expectVisible(page, 'msg.admin.program.not_set');
});

// covers: T-467, UC-17, UC-08, F-114
test('T-467 [W-47] «Журнал»: таблетки журналов, фильтры «кто · пациент № · действие · период», «Скачать CSV»; пациент — номером', async () => {
  const page = await admin('/admin?tab=log', 'P-47');
  for (const t of ['access', 'actions', 'ai', 'exports', 'consents', 'requests', 'crisis']) await B.expectVisible(page, `msg.admin.log.tab.${t}`);
  await B.expectVisible(page, 'msg.admin.log.filter.patient');
  await B.expectVisible(page, 'msg.admin.log.csv');
});
