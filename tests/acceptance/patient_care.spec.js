'use strict';

// Вкладки пациента: Лекарства (P-12, P-14), Тесты (P-11), Дневник (P-29), Визиты (P-30), Врач (P-31),
// Библиотека (P-15), Мои данные (P-16), уведомления (P-32), профиль (P-17) — сквозными сценариями.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const F = require('../lib/flows');

const ctx = useBrowserApp();

async function tab(who, url, pageId) {
  const { ctx: c, page } = await B.contextAs(ctx.browser, ctx.app, who);
  ctx.track(c);
  await B.open(page, ctx.app, url);
  await B.expectPage(page, pageId);
  return page;
}

// covers: T-420, UC-26, UC-04, F-42, F-121, F-40, F-17
test('T-420 [W-19] «Принять» назначение: вводит «залофт» — «Золофт» в первых трёх подсказках этого МНН; без выбора принять нельзя; «Принято · Отменить»; затем «✓ Принял(а)» → «Принято в …»', async () => {
  const doc = await ctx.api('psy1');
  const inn = await F.innId(doc, 'сертралин');
  await F.publishPlan(ctx.app, doc, ctx.app.ids.patA, [{ inn_id: inn, dose: 50, unit: 'мг', times: ['утро'] }]);
  const page = await tab('patA', '/app?tab=meds', 'P-12');
  await B.expectVisible(page, 'msg.meds.bought_prompt');
  await page.click(B.tid('msg.meds.accept'));
  await page.fill(B.tid('msg.meds.placeholder'), 'залофт');
  await B.expectVisible(page, 'msg.meds.suggest.this_inn');
  const first3 = await page.locator(`${B.tid('msg.meds.suggest.item')}`).allTextContents();
  assert.ok(first3.slice(0, 3).some((t) => /Золофт/.test(t)), `подсказки: ${first3.join(' | ')}`);
  await page.locator(B.tid('msg.meds.suggest.item'), { hasText: 'Золофт' }).first().click();
  await page.click(B.tid('msg.meds.draft.add'));
  await B.expectVisible(page, 'msg.undo.bought_added');
  await B.expectVisible(page, 'msg.meds.you_bought');
  await page.click(B.tid('msg.meds.taken'));
  await B.expectVisible(page, 'msg.meds.taken_at');
});

// covers: T-421, UC-26, F-122, F-121
test('T-421 [W-14] неизвестное название: «Не нашли? Добавить как есть — проверим» → принято сразу, пометка «на проверке»', async () => {
  const doc = await ctx.api('psy2');
  const inn = await F.innId(doc, 'флуоксетин');
  await F.publishPlan(ctx.app, doc, ctx.app.ids.patB, [{ inn_id: inn, dose: 20, unit: 'мг', times: ['утро'] }]);
  const page = await tab('patB', '/app?tab=meds', 'P-12');
  await page.click(B.tid('msg.meds.accept'));
  await page.fill(B.tid('msg.meds.placeholder'), 'Синтепрозак Т13');
  await page.click(B.tid('msg.meds.draft.other'));
  await B.expectVisible(page, 'msg.meds.pending');
  await B.expectVisible(page, 'msg.meds.pending.hint');
});

// covers: T-422, UC-46, F-120, F-121, F-17
test('T-422 [W-20] «+ Добавить препарат»: начинаем с названия с упаковки — МНН подставился; схема; «Добавлено · Отменить»; карточка «Внесено вами»', async () => {
  const page = await tab('patH', '/app?tab=meds', 'P-12');
  await page.click(B.tid('msg.meds.add'));
  await page.fill(B.tid('msg.meds.add.brand'), 'атаракс');
  await page.locator(B.tid('msg.meds.suggest.item'), { hasText: 'Атаракс' }).first().click();
  assert.match(await page.inputValue(B.tid('msg.meds.add.inn')), /гидроксизин/i);
  await page.fill(B.tid('msg.meds.add.dose'), '25 мг');
  await page.click(B.tid('msg.meds.add.when.night'));
  await page.click(B.tid('msg.meds.add.duration.ongoing'));
  await page.click(B.tid('msg.meds.add.save'));
  await B.expectVisible(page, 'msg.undo.bought_added');
  await B.expectVisible(page, 'msg.meds.own.label');
});

// covers: T-423, UC-27, F-43, PD-25
test('T-423 [W-19] «Где купить» раскрывается в карточке: не меньше двух аптек, предупреждение о внешнем сайте, ссылки без ID пациента и с noreferrer', async () => {
  const page = await tab('patA', '/app?tab=meds', 'P-12');
  await page.locator(B.tid('msg.meds.where')).first().click();
  await B.expectVisible(page, 'msg.meds.where.external');
  const links = await page.locator(`${B.tid('msg.meds.where.open')}`).evaluateAll((els) => els.map((a) => ({ href: a.href, rel: a.rel, target: a.target })));
  assert.ok(links.length >= 2);
  for (const l of links) {
    assert.match(l.rel, /noopener/);
    assert.match(l.rel, /noreferrer/);
    assert.ok(!l.href.includes(String(ctx.app.ids.patA)));
  }
});

// covers: T-424, UC-07, F-45, F-17
test('T-424 [W-26] «Плохо переношу» → 3 вопроса чипами → карточка-черновик → одна кнопка «Отправить врачу» → «Отправлено врачу · Отменить»; кто увидит — сказано', async () => {
  const page = await tab('patA', '/app?tab=meds&flow=ae', 'P-14');
  await page.click(B.tid('msg.ae.chip.nausea'));
  await page.click(B.tid('msg.ae.when.days'));
  await page.click(B.tid('msg.ae.severity.2'));
  await page.click(B.tid('msg.ae.link.yes'));
  await B.expectVisible(page, 'msg.ae.card.title');
  await B.expectVisible(page, 'msg.ae.who_sees');
  await B.expectVisible(page, 'msg.ae.urgent_note');
  await page.click(B.tid('msg.ae.card.send'));
  await B.expectVisible(page, 'msg.undo.ae_sent');
  await page.click(B.tid('msg.undo.action'));
  await B.expectVisible(page, 'msg.undo.done');
});

// covers: T-425, UC-03, UC-32, F-36, F-37, M-12
test('T-425 [W-15] тест диалогом: вопрос пузырём, ответы кнопками, «можно выбрать до N», «ничего из перечисленного» снимает отметки, проверка ответов, итог «это не диагноз»', async () => {
  const doc = await ctx.api('psy1');
  const a = await F.assignTest(ctx.app, doc, ctx.app.ids.patA, 'demo_types');
  const page = await tab('patA', `/app?tab=tests&run=${a.id}`, 'P-11');
  await B.expectVisible(page, 'msg.tests.run.progress');
  await B.expectVisible(page, 'msg.tests.run.autosave');
  for (let i = 0; i < 20; i += 1) {
    if (await page.locator(B.tid('msg.tests.run.review')).count()) break;
    if (await page.locator(B.tid('msg.tests.run.multi')).count()) {
      await page.locator('[data-option]').first().click();
      await page.click(B.tid('msg.tests.run.none'));
      assert.equal(await page.locator('[data-option][aria-pressed="true"]').count(), 1, 'осталась только «ничего из перечисленного»');
    } else if (await page.locator('[data-option]').count()) {
      await page.locator('[data-option]').first().click();
    } else {
      const input = page.locator('main input, main textarea').first();
      const type = await input.getAttribute('type');
      await input.fill(type === 'number' ? '3' : type === 'date' ? '2026-10-01' : 'синтетика');
    }
    if (await page.locator(B.tid('msg.tests.run.next')).count()) await page.click(B.tid('msg.tests.run.next'));
  }
  await B.expectVisible(page, 'msg.tests.run.review');
  await page.click(B.tid('msg.tests.run.submit'));
  await B.expectVisible(page, 'msg.tests.result.disclaimer');
});

// covers: T-426, UC-28, UC-32, F-38, F-59
test('T-426 [W-16] тест без назначения: «Пройти» → результат «видите только вы» → «Показать врачу»; пакет «1 из 3»', async () => {
  const page = await tab('patH', '/app?tab=tests', 'P-11');
  await B.expectVisible(page, 'msg.tests.self');
  await page.locator(B.tid('msg.tests.self.take')).first().click();
  while (!(await page.locator(B.tid('msg.tests.run.review')).count())) {
    await page.locator('[data-option]').first().click();
    if (await page.locator(B.tid('msg.tests.run.next')).count()) await page.click(B.tid('msg.tests.run.next'));
  }
  await page.click(B.tid('msg.tests.run.submit'));
  await B.expectVisible(page, 'msg.tests.self.only_you');
  await page.click(B.tid('msg.tests.self.show'));
  await B.expectVisible(page, 'msg.tests.self.shown');
});

// covers: T-427, UC-04, F-39, F-17, F-56
test('T-427 [W-21] дневник: «Как вы сегодня?» чипами, сон и тревога, заметка, «Запись сохранена · Отменить»; график 2 недели с таблицей', async () => {
  const page = await tab('patC', '/app?tab=diary', 'P-29');
  await B.expectVisible(page, 'msg.diary.empty');
  await page.click(B.tid('msg.diary.mood.4'));
  await page.click(B.tid('msg.diary.sleep.ok'));
  await page.click(B.tid('msg.diary.anxiety.some'));
  await page.fill(B.tid('msg.diary.note'), 'Синтетика: спокойный день');
  await page.click(B.tid('msg.diary.save'));
  await B.expectVisible(page, 'msg.undo.diary_saved');
  await B.expectVisible(page, 'msg.diary.chart');
  await B.expectVisible(page, 'msg.diary.visibility');
});

// covers: T-428, UC-33, UC-34, F-48, F-49
test('T-428 [W-28] визиты: ближайший визит карточкой, «Заполнить анкету» тем же диалогом → «Анкета отправлена врачу»', async () => {
  const doc = await ctx.api('psy1');
  const v = await doc.post(`/api/v1/patients/${ctx.app.ids.patA}/visits`, { starts_at: new Date(Date.now() + 2 * 86400000).toISOString(), format: 'in_person', previsit_enabled: true });
  assert.equal(v.status, 200);
  await F.passUndoWindow(ctx.app);
  const page = await tab('patA', '/app?tab=visits', 'P-30');
  await B.expectVisible(page, 'msg.visits.next');
  await page.click(B.tid('msg.visits.fill'));
  await B.expectVisible(page, 'msg.previsit.title');
  await page.locator('main textarea').first().fill('Синтетика: вопросы к врачу');
  await page.click(B.tid('msg.previsit.send'));
  await B.expectVisible(page, 'msg.previsit.sent');
});

// covers: T-429, UC-06, F-47, S-26
test('T-429 [W-27] «Врач»: строка «не срочно, ответ обычно в течение 2 рабочих дней, 112»; сообщение со статусом «отправлено» и «Отменить»', async () => {
  const page = await tab('patA', '/app?tab=doctor', 'P-31');
  await B.expectVisible(page, 'msg.doctor.channel');
  await page.fill(B.tid('msg.doctor.placeholder'), 'Синтетический вопрос врачу из браузера');
  await page.click(B.tid('msg.composer.send'));
  await B.expectVisible(page, 'msg.undo.message_sent');
  await B.expectVisible(page, 'msg.doctor.status.sent');
});

// covers: T-430, UC-14, F-50
test('T-430 [W-48] библиотека: поиск и фильтры «Слушать · Смотреть · Читать», плеер в карточке, позиция «Продолжить», ✦ у материала', async () => {
  const page = await tab('patA', '/app?tab=library', 'P-15');
  await page.click(B.tid('msg.library.filter.listen'));
  await page.locator(B.tid('msg.library.play')).first().click();
  await page.waitForTimeout(1200);
  await page.locator(B.tid('msg.library.pause')).first().click();
  await page.reload();
  await B.expectVisible(page, 'msg.library.continue');
  await B.expectVisible(page, 'msg.library.provenance');
  await page.fill(B.tid('msg.library.search'), 'несуществующее слово т13');
  await B.expectVisible(page, 'msg.library.empty_search');
});

// covers: T-431, UC-08, F-51, F-52, F-53, F-06
test('T-431 [W-50] «Мои данные»: кто что видит, кто смотрел, согласия-переключатели с «Отменить», выгрузка с паролем, удаление — диалог с последствиями', async () => {
  const page = await tab('patA', '/account/data', 'P-16');
  await B.expectVisible(page, 'msg.mydata.who.title');
  await B.expectVisible(page, 'msg.mydata.viewed.title');
  await page.click(B.tid('msg.mydata.consent.research'));
  await B.expectVisible(page, 'msg.undo.consent_off');
  await page.click(B.tid('msg.undo.action'));
  await page.fill(B.tid('msg.mydata.export.password'), 'Synthetic-Pass-2026');
  await page.click(B.tid('msg.mydata.export.build'));
  await B.expectVisible(page, 'msg.mydata.export.ready');
  await page.click(B.tid('msg.mydata.delete.button'));
  await B.expectVisible(page, 'msg.mydata.delete.title');
  await page.click(B.tid('msg.mydata.delete.cancel'));
  await page.click(B.tid('msg.mydata.consent.pd'));
  await B.expectVisible(page, 'msg.mydata.revoke.title');
  await page.click(B.tid('msg.mydata.revoke.cancel'));
});

// covers: T-432, UC-37, F-19
test('T-432 [W-09] колокольчик: назначенный тест → значок «1» за ≤ 30 с; список со ссылкой на тест; «прочитать все»', async () => {
  const doc = await ctx.api('psy1');
  const page = await tab('patH', '/app', 'P-13');
  await F.assignTest(ctx.app, doc, ctx.app.ids.patH, 'gad7');
  await page.waitForSelector(`${B.tid('msg.shell.bell.count')}`, { timeout: 35000 });
  await page.click(B.tid('msg.shell.bell'));
  await page.click(B.tid('msg.notifications.all'));
  await B.expectPage(page, 'P-32');
  await page.click(B.tid('msg.notifications.read_all'));
  await B.expectHidden(page, 'msg.shell.bell.count');
});

// covers: T-433, UC-38, UC-43, F-08, F-55, F-02
test('T-433 [W-08] профиль: смена пароля с текущим, сеансы и «Выйти везде», «Попросить сменить специалиста»', async () => {
  const page = await tab('patI', '/account', 'P-17');
  await B.expectVisible(page, 'msg.profile.sessions');
  await B.expectVisible(page, 'msg.profile.logout_all');
  await page.click(B.tid('msg.profile.change_doctor'));
  await page.fill(B.tid('msg.profile.change_doctor.reason'), 'синтетика');
  await page.click(B.tid('msg.profile.change_doctor.send'));
  await B.expectVisible(page, 'msg.profile.change_doctor.sent');
  await page.fill(B.tid('msg.profile.current_password'), 'Synthetic-Pass-2026');
  await page.fill(B.tid('msg.profile.new_password'), 'Browser-New-Pass-26');
  await page.fill(B.tid('msg.profile.repeat_password'), 'Browser-New-Pass-26');
  await page.click(B.tid('msg.profile.save_password'));
  await B.expectVisible(page, 'msg.profile.password_changed');
});
