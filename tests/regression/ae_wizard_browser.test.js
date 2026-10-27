'use strict';
// covers: F-30, UC-30; пакет C плана 2026-10-23-ae-intake: карточка-опрос о побочном действии в чате пациента.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const F = require('../lib/flows');
const ctx = useBrowserApp();
const output = '/tmp/cc-ae-wizard';
const card = '[data-ae-wizard]';

async function chatAs(key, profile) {
  fs.mkdirSync(output, { recursive: true });
  const session = await B.contextAs(ctx.browser, ctx.app, key, profile);
  ctx.track(session.ctx);
  const errors = [];
  session.page.on('pageerror', (e) => errors.push(e.message));
  await B.open(session.page, ctx.app, '/app?tab=chat');
  await session.page.waitForSelector(B.tid('msg.chat.placeholder'));
  return { page: session.page, errors };
}

async function ask(page, text = F.AE_PHRASE) {
  ctx.app.ai.queue({ mode: 'text', text: 'Синтетический ответ про самочувствие' });
  await page.fill(B.tid('msg.chat.placeholder'), text);
  await page.click(B.tid('msg.composer.send'));
}

const counter = (page) => page.locator(B.tid('msg.ae.wizard.counter')).innerText();
const pick = (page, label) => page.locator(`${card} label.choice`, { hasText: label }).click();
const confirm = (page) => page.locator(`${card} button[data-testid^="msg.ae.wizard."]`).filter({ hasText: /^(Подтвердить|Отправить)$/ }).click();
const aeCount = () => ctx.app.query('SELECT count(*) n FROM adverse_events')[0].n;

test('карточка по слову из словаря: три шага со счётчиком, «Назад», крестик, повторно в чате не появляется', async () => {
  const psy = await ctx.api('psy1');
  const patient = await ctx.api('patA');
  await F.sertralinePrescribedAndAccepted(ctx.app, psy, patient, ctx.app.ids.patA);
  const { page, errors } = await chatAs('patA');
  await ask(page);
  await page.waitForSelector(B.tid('msg.ae.wizard.title.patient'));
  assert.match(await page.locator(B.tid('msg.ae.wizard.title.patient')).innerText(), /Заполните коротко, врач быстрее увидит/);
  assert.equal(await counter(page), '1/3');
  assert.equal(await page.locator(B.tid('msg.ae.wizard.back')).isVisible(), false);
  assert.equal(await page.inputValue(`${card} textarea`), F.AE_PHRASE, 'текст подставлен из сообщения');
  await B.expectVisible(page, 'msg.ae.urgent_note');
  await page.screenshot({ path: `${output}/patient-step1.png`, fullPage: true });
  // пустое описание не пускает дальше
  await page.fill(`${card} textarea`, '');
  await confirm(page);
  assert.equal(await counter(page), '1/3');
  await B.expectVisible(page, 'msg.ae.wizard.need.what');
  await page.fill(`${card} textarea`, F.AE_PHRASE);
  await confirm(page);
  assert.equal(await counter(page), '2/3');
  assert.match(await page.locator(card).innerText(), /Вы принимаете сертралин/);
  assert.match(await page.locator(card).innerText(), /Другой препарат/);
  assert.match(await page.locator(card).innerText(), /Ничего не принимаю/);
  await page.screenshot({ path: `${output}/patient-step2.png`, fullPage: true });
  await confirm(page);
  await B.expectVisible(page, 'msg.ae.wizard.need.drug');
  await pick(page, 'Сертралин');
  await confirm(page);
  assert.equal(await counter(page), '3/3');
  assert.equal(await page.locator(B.tid('msg.ae.wizard.send')).isVisible(), true);
  await page.screenshot({ path: `${output}/patient-step3.png`, fullPage: true });
  await page.click(B.tid('msg.ae.wizard.back'));
  assert.equal(await counter(page), '2/3');
  const before = aeCount();
  await page.click(B.tid('msg.ae.wizard.close'));
  await page.waitForFunction(() => !document.querySelector('[data-ae-wizard]'));
  assert.equal(aeCount(), before, 'закрытие ничего не отправляет');
  // тот же чат, тот же повод: карточка не возвращается
  await ask(page, 'опять тошнит');
  await page.waitForSelector(B.tid('msg.ai.rate.useful') + ' >> nth=1');
  assert.equal(await page.locator(card).count(), 0);
  assert.deepEqual(errors, []);
});

test('«Ничего не принимаю»: мягкое завершение без записи', async () => {
  const { page } = await chatAs('patA');
  const before = aeCount();
  await ask(page);
  await page.waitForSelector(card);
  await confirm(page);
  await pick(page, 'Ничего не принимаю');
  await confirm(page);
  await B.expectVisible(page, 'msg.ae.wizard.not_adverse');
  assert.match(await page.locator(B.tid('msg.ae.wizard.not_adverse')).innerText(), /скорее всего, не побочное действие/);
  await B.expectVisible(page, 'msg.ae.wizard.write_doctor');
  await page.screenshot({ path: `${output}/patient-none.png`, fullPage: true });
  assert.equal(aeCount(), before);
});

test('отправка пациента с психиатром: сводка в ленте и после перезагрузки, запись в «Сигналах» психиатра', async () => {
  const { page, errors } = await chatAs('patA');
  await ask(page);
  await page.waitForSelector(card);
  await confirm(page);
  await pick(page, 'Другой препарат');
  await page.fill(`${card} input[data-ae-field="med_name"]`, 'Мелатонин');
  await confirm(page);
  assert.match(await page.locator('[data-ae-who]').innerText(), /Увидит ваш психиатр/);
  await confirm(page);
  await B.expectVisible(page, 'msg.ae.wizard.send').catch(() => {});
  await B.expectVisible(page, 'msg.ae.need.choice').catch(() => {});
  assert.match(await page.locator(`${card} [data-ae-error]`).innerText(), /Выберите вариант/);
  await pick(page, 'Заметно');
  await pick(page, 'Да');
  await page.screenshot({ path: `${output}/patient-step3-filled.png`, fullPage: true });
  await page.locator(B.tid('msg.ae.wizard.send')).click();
  const summary = page.locator('.ae-summary');
  await summary.waitFor();
  assert.match(await summary.innerText(), /Вы сообщили врачу/);
  assert.match(await summary.innerText(), /Мелатонин/);
  assert.equal(await page.locator(card).count(), 0, 'карточка ушла после отправки');
  await page.screenshot({ path: `${output}/patient-summary.png`, fullPage: true });
  const row = ctx.app.query("SELECT * FROM adverse_events WHERE source='ai_chat' ORDER BY id DESC LIMIT 1")[0];
  assert.equal(row.patient_id, ctx.app.ids.patA);
  assert.equal(row.thread_id, ctx.app.query('SELECT max(id) m FROM ai_threads WHERE owner_user_id=?', [ctx.app.ids.patA])[0].m);
  // в той же ленте повторно не предлагаем
  await ask(page, 'ещё тошнит');
  await page.waitForSelector(B.tid('msg.ai.rate.useful') + ' >> nth=1');
  assert.equal(await page.locator(card).count(), 0);
  // перезагрузка чата: сводка берётся из истории треда
  await B.open(page, ctx.app, `/app?tab=chat&thread=${row.thread_id}`);
  await page.locator('.ae-summary[data-kind="ae_summary"]').waitFor();
  assert.match(await page.locator('.ae-summary').innerText(), /Вы сообщили врачу/);
  await F.passUndoWindow(ctx.app);
  const signals = await F.signalsOf(await ctx.api('psy1'), 'kind=ae&status=all');
  assert.ok(signals.some((x) => x.id === row.id));
  assert.deepEqual(errors, []);
});

test('пациент без психиатра: препарат текстом, сводка про «не прикреплены», в списке «Сохранено у вас»', async () => {
  const { page, errors } = await chatAs('patI');
  await ask(page);
  await page.waitForSelector(card);
  await confirm(page);
  assert.match(await page.locator(card).innerText(), /Какой препарат вы принимаете\?/);
  await page.fill(`${card} input[data-ae-field="med_name"]`, 'Валерьянка');
  await confirm(page);
  await pick(page, 'Немного');
  await confirm(page);
  const summary = page.locator('.ae-summary');
  await summary.waitFor();
  assert.match(await summary.innerText(), /не прикреплены к врачу/);
  assert.equal(ctx.app.query("SELECT count(*) n FROM service_queue WHERE kind='ae_no_psychiatrist'")[0].n, 0);
  await page.screenshot({ path: `${output}/patient-no-psychiatrist.png`, fullPage: true });
  await F.passUndoWindow(ctx.app);
  await B.open(page, ctx.app, '/app?tab=meds');
  await page.waitForSelector('text=Сохранено у вас');
  assert.deepEqual(errors, []);
});

test('мобильный вид 375px: нет горизонтальной прокрутки, кнопки крупные, клавиатура ведёт по шагам', async () => {
  const phone = { viewport: { width: 375, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const { page } = await chatAs('patA', phone);
  await ask(page);
  await page.waitForSelector(card);
  await page.locator(card).scrollIntoViewIfNeeded();
  assert.equal(await B.noHorizontalOverflow(page), true);
  await page.screenshot({ path: `${output}/mobile-step1.png` });
  const box = await page.locator(B.tid('msg.ae.wizard.confirm')).boundingBox();
  assert.ok(box.height >= 44);
  // клавиатура: Enter в поле даты идёт дальше, Escape закрывает
  await page.focus(`${card} input[type="date"]`);
  await page.keyboard.press('Enter');
  assert.equal(await counter(page), '2/3');
  await page.screenshot({ path: `${output}/mobile-step2.png` });
  await confirm(page);
  await pick(page, 'Другой препарат');
  await page.fill(`${card} input[data-ae-field="med_name"]`, 'Мелатонин');
  await confirm(page);
  await page.locator(card).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${output}/mobile-step3.png` });
  assert.equal(await B.noHorizontalOverflow(page), true);
  const bad = (await B.axeViolations(page)).filter((v) => v.nodes.some((n) => n.includes('ae-wiz')));
  assert.deepEqual(bad, []);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-ae-wizard]'));
});

test('предложение модели: кнопки «Да, расскажу подробнее» / «Не сейчас» (поле ae_offer ставит пакет E)', async () => {
  const { page } = await chatAs('patA');
  await page.route('**/api/v1/ai/patient/messages', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.ae_offer = { prefill: { symptoms: [] } };
    await route.fulfill({ response, json: body });
  });
  await ask(page, 'Что-то странное после новой таблетки');
  await page.waitForSelector(B.tid('msg.ae.wizard.offer.yes'));
  await page.screenshot({ path: `${output}/offer.png`, fullPage: true });
  await page.click(B.tid('msg.ae.wizard.offer.yes'));
  await page.waitForSelector(card);
  assert.equal(await page.inputValue(`${card} textarea`), 'Что-то странное после новой таблетки');
  await page.click(B.tid('msg.ae.wizard.close'));
  ctx.app.ai.queue({ mode: 'text', text: 'Ещё один синтетический ответ' });
  await page.fill(B.tid('msg.chat.placeholder'), 'Ещё что-то');
  await page.click(B.tid('msg.composer.send'));
  await page.waitForSelector(B.tid('msg.ai.rate.useful') + ' >> nth=1');
  assert.equal(await page.locator(B.tid('msg.ae.wizard.offer.yes')).count(), 0, 'после закрытия предложение не повторяется');
  // «Не сейчас» просто убирает кнопки
  await B.open(page, ctx.app, '/app?tab=chat');
  await ask(page, 'Что-то странное после новой таблетки');
  await page.waitForSelector(B.tid('msg.ae.wizard.offer.no'));
  await page.click(B.tid('msg.ae.wizard.offer.no'));
  assert.equal(await page.locator(B.tid('msg.ae.wizard.offer.no')).count(), 0);
  assert.equal(await page.locator(card).count(), 0);
});

test('режимы психиатра и психолога: тестовый монтаж компонента, состав шагов и тела отправки', async () => {
  const { page } = await chatAs('patA');
  const run = (mode, meds) =>
    page.evaluate(
      async ({ mode, meds }) => {
        document.querySelectorAll('[data-test-mount]').forEach((n) => n.remove());
        const host = document.createElement('div');
        host.dataset.testMount = mode;
        document.body.prepend(host);
        window.__sent = null;
        const wizard = window.AeWizard.mount(host, {
          mode,
          prefill: { text: 'Синтетика: сонливость днём' },
          meds,
          onSubmit: async (payload) => {
            window.__sent = payload;
            return { ae: { id: 1 } };
          },
          onClose: ({ reason }) => (window.__closed = reason),
        });
        await wizard.ready;
      },
      { mode, meds },
    );
  const host = (mode) => `[data-test-mount="${mode}"]`;
  const next = (mode) => page.locator(`${host(mode)} button[data-testid^="msg.ae.wizard."]`).filter({ hasText: /^(Подтвердить|Отправить)$/ }).click();
  const choose = (mode, label) => page.locator(`${host(mode)} label.choice`, { hasText: label }).click();

  await run('psychiatrist', [{ item_key: 'k1', name: 'Сертралин' }]);
  assert.match(await page.locator(`${host('psychiatrist')} ${B.tid('msg.ae.wizard.title.psychiatrist')}`).innerText(), /оценка врача/);
  await next('psychiatrist');
  await choose('psychiatrist', 'Сертралин');
  await next('psychiatrist');
  assert.equal(await page.locator(`${host('psychiatrist')} ${B.tid('msg.ae.wizard.counter')}`).innerText(), '3/3');
  await page.screenshot({ path: `${output}/psychiatrist-step3.png`, fullPage: true });
  await choose('psychiatrist', 'Заметно');
  await choose('psychiatrist', 'Вероятна');
  await next('psychiatrist');
  assert.match(await page.locator(`${host('psychiatrist')} [data-ae-error]`).innerText(), /Выберите вариант/);
  await choose('psychiatrist', 'Нет');
  await next('psychiatrist');
  await page.waitForFunction(() => window.__closed === 'submitted');
  const sent = await page.evaluate(() => window.__sent);
  const { symptoms, ...rest } = sent;
  assert.deepEqual(symptoms, []);
  assert.deepEqual(
    rest,
    {
      text: 'Синтетика: сонливость днём',
      severity: 'noticeable',
      med: { kind: 'plan_item', item_key: 'k1' },
      decision: 'probable',
      serious: false,
    },
  );

  await run('psychologist', []);
  await next('psychologist');
  assert.match(await page.locator(`${host('psychologist')} [data-ae-q]`).innerText(), /принимает пациент, по его словам/);
  assert.equal(await page.locator(`${host('psychologist')} label.choice`).count(), 0, 'без списка препаратов и без «ничего не принимаю»');
  await page.fill(`${host('psychologist')} input[data-ae-field="med_name"]`, 'Золофт');
  await next('psychologist');
  assert.equal(await page.locator(`${host('psychologist')} label.choice`).count(), 3, 'только тяжесть');
  await page.screenshot({ path: `${output}/psychologist-step3.png`, fullPage: true });
  await choose('psychologist', 'Сильно');
  await next('psychologist');
  await page.waitForFunction(() => window.__sent && window.__sent.severity === 'severe');
  assert.deepEqual(await page.evaluate(() => window.__sent.med), { kind: 'other', name: 'Золофт' });
  assert.equal(await page.evaluate(() => 'decision' in window.__sent), false);
});

test('prefill с тяжестью и связью: в шаге 3 эти значения не выбраны', async () => {
  const psy = await ctx.api('psy1');
  const patient = await ctx.api('patA');
  await F.sertralinePrescribedAndAccepted(ctx.app, psy, patient, ctx.app.ids.patA);
  const { page } = await chatAs('patA');
  await page.route('**/api/v1/ai/patient/messages', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (body.ae_suggestion) body.ae_suggestion.prefill = { ...body.ae_suggestion.prefill, severity: 3, related: 'likely' };
    await route.fulfill({ response: res, json: body });
  });
  await ask(page);
  await page.waitForSelector(card);
  await confirm(page);
  await pick(page, 'Сертралин');
  await confirm(page);
  assert.equal(await counter(page), '3/3');
  const checked = await page.locator(`${card} label.choice input:checked`).evaluateAll((els) => els.map((e) => e.value));
  assert.ok(!checked.includes('severe') && !checked.includes('yes'), `выбрано: ${checked}`);
});
