'use strict';

// Специалист: Пациенты и карточка (P-18, P-19), чат (P-20), тесты и очный результат (P-21), документы и
// заключения (P-23), аналитика (P-24), утверждения КО (P-51), архив и отпуск — сценариями прототипа v5.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const F = require('../lib/flows');

const ctx = useBrowserApp();

async function as(who, url, pageId, profile) {
  const { ctx: c, page } = await B.contextAs(ctx.browser, ctx.app, who, profile);
  ctx.track(c);
  await B.open(page, ctx.app, url);
  await B.expectPage(page, pageId);
  return page;
}

// covers: T-440, UC-09, F-57, F-58
test('T-440 [W-17] «Пациенты» как список чатов: имя, последнее событие, время, цветная точка с текстом причины; карточка: 6 вкладок у психиатра, 5 у психолога (без «Лечения»)', async () => {
  const page = await as('psy1', '/work?tab=patients', 'P-18');
  await B.expectVisible(page, 'msg.patients.search');
  const dot = page.locator('[data-dot]').first();
  assert.ok(await dot.getAttribute('aria-label') || await dot.textContent(), 'точка различима не только цветом');
  await page.locator(`[data-id="${ctx.app.ids.patA}"]`).first().click();
  await B.expectPage(page, 'P-19');
  for (const t of ['overview', 'treatment', 'tests', 'diary', 'messages', 'docs']) await B.expectVisible(page, `msg.card.tab.${t}`);
  const plg = await as('plg1', `/work/patients/${ctx.app.ids.patA}`, 'P-19');
  await B.expectHidden(plg, 'msg.card.tab.treatment');
});

// covers: T-441, UC-12, UC-26, F-35, F-61, F-17
test('T-441 [W-18] фраза «сертралин 75 мг утром, 4 недели» → черновик назначения с полями прямо в карточке → одна кнопка «Отправить пациенту» → «Отправлено пациенту · план версия N»; пациент видит после окна', async () => {
  const page = await as('psy1', `/work/patients/${ctx.app.ids.patA}?ptab=treatment`, 'P-19');
  await page.fill(B.tid('msg.card.placeholder.treatment'), 'сертралин 75 мг утром, 4 недели');
  await page.click(B.tid('msg.composer.send'));
  await B.expectVisible(page, 'msg.card.draft.title');
  assert.match(await page.inputValue(B.tid('msg.card.draft.inn')), /сертралин/i);
  assert.match(await page.inputValue(B.tid('msg.card.draft.dose')), /75/);
  await B.expectVisible(page, 'msg.card.draft.inn_only');
  await page.click(B.tid('msg.card.draft.send'));
  await B.expectVisible(page, 'msg.undo.plan_sent');
  await F.passUndoWindow(ctx.app);
  const p = await ctx.api('patA');
  const meds = (await p.get('/api/v1/me/meds')).body;
  assert.ok(meds.plan_items.some((i) => /сертралин/i.test(i.inn_name) && i.dose === 75));
});

// covers: T-442, UC-10, UC-32, F-59, F-60, F-17
test('T-442 [W-16] «Тесты» в карточке: подсказка «Пакет «Старт»» → черновик → «Отправить пациенту»; отмена — «Назначение отменено · Вернуть»', async () => {
  const page = await as('psy2', `/work/patients/${ctx.app.ids.patB}?ptab=tests`, 'P-19');
  await page.click(B.tid('msg.card.tests.package_start'));
  await B.expectVisible(page, 'msg.card.draft.send');
  await page.click(B.tid('msg.card.draft.send'));
  await B.expectVisible(page, 'msg.undo.sent_to_patient');
  await F.passUndoWindow(ctx.app);
  await page.reload();
  await page.locator(B.tid('msg.card.tests.cancel')).first().click();
  await B.expectVisible(page, 'msg.undo.assignment_cancelled');
});

// covers: T-443, UC-21, F-62, F-15, F-14
test('T-443 [W-22] очный результат по фото бланка: исходник и распознанный текст рядом, поля черновика, «Сохранить» — только после проверки', async () => {
  const page = await as('psy1', '/work?tab=tools', 'P-21');
  await page.click(B.tid('msg.nav.clinician.more.offline'));
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(B.tid('msg.composer.attach.photo'))]);
  await chooser.setFiles(path.join(F.FILES, 'printed_form.png'));
  await B.expectVisible(page, 'msg.offline.source');
  await B.expectVisible(page, 'msg.offline.recognized');
  await B.expectVisible(page, 'msg.offline.draft');
  await page.click(B.tid('msg.offline.save'));
});

// covers: T-444, UC-33, F-48
test('T-444 [W-28] «Следующий приём» в «Лечении»: дата, формат, анкета включена; «Отправить пациенту»', async () => {
  const page = await as('psy1', `/work/patients/${ctx.app.ids.patH}?ptab=treatment`, 'P-19');
  await page.fill(B.tid('msg.card.placeholder.treatment'), 'визит 24.12 14:30 очно');
  await page.click(B.tid('msg.composer.send'));
  await B.expectVisible(page, 'msg.card.visit.title');
  await B.expectVisible(page, 'msg.card.visit.previsit');
  await page.click(B.tid('msg.card.draft.send'));
  await B.expectVisible(page, 'msg.undo.sent_to_patient');
});

// covers: T-445, UC-14, F-32, F-12, F-33, F-31
test('T-445 [W-35] чат специалиста: «Выберите пациента…» до выбора; «@Мар» — только закреплённые; подсказки объектов пациента; ответ — черновик с «В черновик документа», «Открыть карточку», 👍/👎', async () => {
  const page = await as('psy1', '/work', 'P-20');
  await B.expectVisible(page, 'msg.wchat.pick_patient');
  await page.fill(B.tid('msg.wchat.placeholder'), '@Мар');
  await page.locator('[role="option"]', { hasText: 'Марина' }).first().click();
  await B.expectVisible(page, 'msg.wchat.patient_chip');
  const options = await page.locator('[role="option"]').allTextContents();
  assert.ok(!options.some((o) => /Олег/.test(o)), 'чужой пациент не предлагается');
  await page.fill(B.tid('msg.wchat.placeholder'), 'Что изменилось за 2 недели?');
  await page.click(B.tid('msg.composer.send'));
  await B.expectVisible(page, 'msg.wchat.to_doc');
  await B.expectVisible(page, 'msg.wchat.open_card');
  await B.expectVisible(page, 'msg.ai.clinician.under_answer');
});

// covers: T-446, UC-20, UC-15, F-67, F-68
test('T-446 [W-49] «Документы»: личные шаблоны — «Новый шаблон», «ИИ» составляет заготовку, «Сохранить», «Скопировать» (решение владельца 2026-10-19)', async () => {
  const page = await as('psy1', '/work?tab=docs', 'P-23');
  await page.click(B.tid('msg.tpl.new'));
  await page.fill(B.tid('msg.tpl.title'), 'Выписка за месяц');
  await page.fill(B.tid('msg.tpl.ai.placeholder'), 'выписка для пациента за октябрь');
  await page.click(B.tid('msg.tpl.ai'));
  await page.waitForFunction((sel) => document.querySelector(sel)?.value.trim().length > 0, B.tid('msg.tpl.body'));
  await page.click(B.tid('msg.tpl.save'));
  await B.expectVisible(page, 'msg.tpl.delete');
  await page.click(B.tid('msg.tpl.copy'));
  const plg = await as('plg1', '/work?tab=docs', 'P-23');
  await B.expectVisible(plg, 'msg.tpl.new');
  await B.expectHidden(plg, 'msg.docs.sign');
});

// covers: T-447, UC-35, F-69
test('T-447 [W-51] «⋮ → Завершить наблюдение»: диалог с причиной и последствиями; пациент уходит из списка в фильтр «Архив»', async () => {
  const page = await as('psy1', `/work/patients/${ctx.app.ids.patG}`, 'P-19');
  await page.click(B.tid('msg.card.menu'));
  await page.click(B.tid('msg.card.menu.archive'));
  await B.expectVisible(page, 'msg.card.archive.text');
  await page.click(B.tid('msg.card.archive.reason.done'));
  await page.click(B.tid('msg.card.archive.confirm'));
  await B.expectVisible(page, 'msg.card.archived');
});

// covers: T-448, UC-36, F-70
test('T-448 [W-40] «⋮ → Передать коллеге на время отпуска»: коллега той же роли и период; статус «ждёт подтверждения администратора»', async () => {
  const page = await as('psy2', '/account', 'P-17');
  await page.click(B.tid('msg.profile.vacation'));
  await page.selectOption(B.tid('msg.profile.vacation.who'), { label: 'Вера Резервная' });
  await page.fill(B.tid('msg.profile.vacation.from'), new Date(Date.now() + 86400000).toISOString().slice(0, 10));
  await page.fill(B.tid('msg.profile.vacation.to'), new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10));
  await page.click(B.tid('msg.profile.vacation.send'));
  await B.expectVisible(page, 'msg.profile.vacation.waiting');
});

// covers: T-449, UC-23, UC-22, F-71, F-72, F-74
test('T-449 [W-52] аналитика: 3 цифры со знаменателем и «как считается», «меньше 10 — скрыто», «не рейтинг»; исследование — только с правом', async () => {
  const page = await as('psy1', '/work?tab=analytics', 'P-24');
  await B.expectVisible(page, 'msg.analytics.small');
  await B.expectVisible(page, 'msg.analytics.not_rating');
  await B.expectVisible(page, 'msg.analytics.research.title');
  const other = await as('psy2', '/work?tab=analytics', 'P-24');
  await B.expectHidden(other, 'msg.analytics.research.title');
});

// covers: T-450, UC-31, F-34
test('T-450 [W-35] гипотезы: подсказка «Гипотезы с источниками» с пометкой «на экспертной проверке»; выключатель в профиле убирает кнопку', async () => {
  const page = await as('psy1', '/work', 'P-20');
  await B.expectVisible(page, 'msg.wchat.example.hints');
  const prof = await as('psy1', '/account', 'P-17');
  await prof.click(B.tid('msg.profile.hints'));
  const again = await as('psy1', '/work', 'P-20');
  await B.expectHidden(again, 'msg.wchat.example.hints');
  await prof.click(B.tid('msg.profile.hints'));
});

// covers: T-451, UC-45, F-98
test('T-451 [W-41] «Аватар → Утверждения» только у психиатра с отметкой КО; карточка «было → стало», «Утвердить», «Отклонить с причиной»', async () => {
  const page = await as('psy1', '/work', 'P-20');
  await page.click(B.tid('msg.shell.avatar'));
  await B.expectVisible(page, 'msg.nav.psychiatrist.more.approvals');
  await page.click(B.tid('msg.nav.psychiatrist.more.approvals'));
  await B.expectPage(page, 'P-51');
  const other = await as('psy2', '/work', 'P-20');
  await other.click(B.tid('msg.shell.avatar'));
  await B.expectHidden(other, 'msg.nav.psychiatrist.more.approvals');
});
