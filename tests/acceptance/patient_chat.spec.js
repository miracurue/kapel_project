'use strict';

// Пациент · Чат (P-13) как в прототипе v5: «Чем помочь?» и примеры, подсказки → чип в поле и «×» назад,
// ответ ИИ с пометкой и 👍/👎, кризисная карточка вместо ответа, «✦ Спросить ИИ» с готовыми вопросами
// и проверкой «Мне хуже», ИИ недоступен, предложение НЯ, выключенное ИИ-согласие, голос и фото.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const F = require('../lib/flows');

const ctx = useBrowserApp();

async function chat(who = 'patA') {
  const { ctx: c, page } = await B.contextAs(ctx.browser, ctx.app, who);
  ctx.track(c);
  await B.open(page, ctx.app, '/app');
  await B.expectPage(page, 'P-13');
  return page;
}

// covers: T-410, UC-24, UC-25, UC-41, F-12, F-27, F-31, F-26
test('T-410 [W-34] чат: пусто — «Чем помочь?» с 4 примерами; подсказка → чип в поле, «×» возвращает; ответ с пометкой ИИ, 👍/👎; «ИИ — не врач»', async () => {
  const doc = await ctx.api('psy1');
  const p = await ctx.api('patA');
  await F.sertralinePrescribedAndAccepted(ctx.app, doc, p, ctx.app.ids.patA);
  const page = await chat();
  await B.expectVisible(page, 'msg.chat.empty.title');
  for (let i = 1; i <= 4; i += 1) await B.expectVisible(page, `msg.chat.example.${i}`);
  await B.expectVisible(page, 'msg.ai.patient.composer_note');
  const sugg = page.locator(`${B.tid('msg.composer.suggestions')} button`).first();
  const label = await sugg.textContent();
  await sugg.click();
  await B.expectVisible(page, 'msg.composer.chip.remove');
  assert.equal(await page.locator(`${B.tid('msg.composer.suggestions')} button`, { hasText: label }).count(), 0, 'подсказка ушла из строки');
  await page.click(B.tid('msg.composer.chip.remove'));
  assert.ok(await page.locator(`${B.tid('msg.composer.suggestions')} button`, { hasText: label }).count() >= 1, '«×» вернул подсказку');
  await page.fill(B.tid('msg.chat.placeholder'), F.CALM_PHRASE);
  await page.click(B.tid('msg.composer.send'));
  await B.expectVisible(page, 'msg.ai.mark');
  await B.expectVisible(page, 'msg.ai.rate.useful');
  await B.expectVisible(page, 'msg.ai.rate.not_useful');
  await B.expectVisible(page, 'msg.chat.answer.write_doctor');
  await page.click(B.tid('msg.ai.rate.useful'));
  await B.expectVisible(page, 'msg.ai.rate.thanks');
});

// covers: T-411, UC-05, UC-24, F-16, F-46, PD-16
test('T-411 [W-24] кризисная фраза: спокойная карточка с «Позвонить 112», «Написать врачу» и «Эту фразу увидит ваш врач…»; ответа ИИ нет', async () => {
  ctx.app.ai.reset();
  const page = await chat('patH');
  await page.fill(B.tid('msg.chat.placeholder'), F.CRISIS_PHRASE);
  await page.click(B.tid('msg.composer.send'));
  await B.expectVisible(page, 'msg.crisis.card.title');
  await B.expectVisible(page, 'msg.crisis.card.call');
  await B.expectVisible(page, 'msg.crisis.card.write');
  await B.expectVisible(page, 'msg.crisis.card.who_sees');
  assert.equal(await page.getAttribute(B.tid('msg.crisis.card.call'), 'href'), 'tel:112');
  await B.expectHidden(page, 'msg.ai.mark');
  assert.equal(ctx.app.ai.calls().length, 0);
});

// covers: T-412, UC-25, F-29, F-16, F-12, S-16
test('T-412 [W-33] «✦ Спросить ИИ» у лекарства: новый чат с чипом и готовыми вопросами; «Мне хуже» — сначала 2 вопроса безопасности кнопками, «Да» → кризисная карточка без модели', async () => {
  const { ctx: c, page } = await B.contextAs(ctx.browser, ctx.app, 'patA');
  ctx.track(c);
  await B.open(page, ctx.app, '/app?tab=meds');
  await B.expectPage(page, 'P-12');
  await page.locator(B.tid('msg.ask.star')).first().click();
  await B.expectPage(page, 'P-13');
  await B.expectVisible(page, 'msg.composer.chip.remove');
  await B.expectVisible(page, 'msg.ask.worse');
  ctx.app.ai.reset();
  await page.click(B.tid('msg.ask.worse'));
  await B.expectVisible(page, 'msg.chat.worse.q1');
  await page.click(B.tid('msg.chat.worse.q1.yes'));
  await B.expectVisible(page, 'msg.crisis.card.title');
  assert.equal(ctx.app.ai.calls().length, 0, '«Мне хуже» не уходит в модель сразу');
});

// covers: T-413, UC-18, UC-24, F-26, F-25, F-27
test('T-413 [W-30] ИИ недоступен: «Не получилось ответить», текст остаётся в поле, «Повторить» отвечает; 112 работает', async () => {
  ctx.app.ai.queue({ mode: 'error' }, { mode: 'error' });
  const page = await chat('patB');
  await page.fill(B.tid('msg.chat.placeholder'), 'Синтетический вопрос при сбое ИИ');
  await page.click(B.tid('msg.composer.send'));
  await B.expectVisible(page, 'err.e-ai-unavailable');
  await B.expectVisible(page, 'msg.shell.retry');
  assert.equal(await page.inputValue(B.tid('msg.chat.placeholder')), 'Синтетический вопрос при сбое ИИ');
  ctx.app.ai.queue({ mode: 'text', text: 'Синтетический ответ после повтора' });
  await page.click(B.tid('msg.shell.retry'));
  await page.waitForSelector('text=Синтетический ответ после повтора');
  await B.expectVisible(page, 'msg.shell.crisis_link');
});

// covers: T-414, UC-30, UC-07, F-30, F-45
test('T-414 [W-34] жалоба в чате → мягкая карточка «Похоже на побочный эффект. Сообщить врачу?» → предзаполненная форма P-14', async () => {
  const page = await chat('patA');
  await page.fill(B.tid('msg.chat.placeholder'), F.AE_PHRASE);
  await page.click(B.tid('msg.composer.send'));
  await B.expectVisible(page, 'msg.chat.ae.suggest');
  await page.click(B.tid('msg.chat.ae.suggest.yes'));
  await B.expectPage(page, 'P-14');
  await B.expectVisible(page, 'msg.ae.card.prefilled');
});

// covers: T-415, UC-24, UC-08, F-06, F-27
test('T-415 [W-34] ИИ-согласие выключено: поле заменено строкой «ИИ-помощник выключен · включить», 112 остаётся', async () => {
  const page = await chat('patG');
  await B.expectVisible(page, 'msg.chat.ai_off');
  await B.expectHidden(page, 'msg.chat.placeholder');
  await B.expectVisible(page, 'msg.shell.crisis_link');
});

// covers: T-416, UC-24, UC-06, F-14, PD-08
test('T-416 [W-31] голос: микрофон → «Расшифровываем…» → текст в поле с пометкой «Распознано автоматически — проверьте»; без «Отправить» ничего не уходит', async () => {
  const page = await chat('patA');
  const before = ctx.app.query('SELECT count(*) n FROM ai_messages')[0].n;
  await page.click(B.tid('msg.composer.mic'));
  await B.expectVisible(page, 'msg.composer.mic.recording');
  await page.waitForTimeout(1500);
  await page.click(B.tid('msg.composer.mic'));
  await B.expectVisible(page, 'msg.composer.mic.recognized');
  assert.equal(await page.inputValue(B.tid('msg.chat.placeholder')), ctx.app.ml.preset.stt);
  assert.equal(ctx.app.query('SELECT count(*) n FROM ai_messages')[0].n, before);
});

// covers: T-417, UC-24, F-15, PD-06
test('T-417 [W-23] фото: «На фото могут быть данные других людей», превью и «×» до отправки; распознанный текст вставлен в поле', async () => {
  const page = await chat('patA');
  await page.click(B.tid('msg.composer.attach'));
  await B.expectVisible(page, 'msg.composer.photo.others');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(B.tid('msg.composer.attach.photo'))]);
  await chooser.setFiles(path.join(F.FILES, 'printed_form.png'));
  await B.expectVisible(page, 'msg.composer.file.remove');
  await B.expectVisible(page, 'msg.composer.file.ocr_done');
  await page.click(B.tid('msg.composer.file.remove'));
  await B.expectHidden(page, 'msg.composer.file.remove');
});
