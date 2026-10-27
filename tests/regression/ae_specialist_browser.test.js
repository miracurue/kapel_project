'use strict';
// covers: F-45, F-65, F-66, UC-30; пакеты D и F плана 2026-10-23-ae-intake: нежелательное явление у специалиста —
// кнопка в карточке пациента, карточка-опрос психиатра и психолога, путь к черновику извещения, предложение в чате.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const F = require('../lib/flows');
const ctx = useBrowserApp();
const output = '/tmp/cc-ae-specialist';
const card = '[data-ae-wizard]';
const PHONE = { viewport: { width: 375, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function as(key, url, profile) {
  fs.mkdirSync(output, { recursive: true });
  const session = await B.contextAs(ctx.browser, ctx.app, key, profile);
  ctx.track(session.ctx);
  const errors = [];
  session.page.on('pageerror', (e) => errors.push(e.message));
  await B.open(session.page, ctx.app, url);
  return { page: session.page, errors };
}

let planned = false;
async function ensurePlan() {
  if (planned) return;
  planned = true;
  const psy = await ctx.api('psy1');
  const patient = await ctx.api('patA');
  await F.sertralinePrescribedAndAccepted(ctx.app, psy, patient, ctx.app.ids.patA);
}

const counter = (page) => page.locator(B.tid('msg.ae.wizard.counter')).innerText();
const pick = (page, label) => page.locator(`${card} label.choice`, { hasText: label }).click();
const next = (page) =>
  page.locator(`${card} button[data-testid^="msg.ae.wizard."]`).filter({ hasText: /^(Подтвердить|Отправить)$/ }).click();
const latest = () => ctx.app.query('SELECT * FROM adverse_events ORDER BY id DESC LIMIT 1')[0];
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const cardUrl = (key) => `/work/patients/${ctx.app.ids[key]}`;

// Подставляет в ответ чата специалиста поле ae_offer (его ставит пакет E).
async function interceptOffer(page, prefill = {}) {
  await page.route('**/api/v1/ai/clinician/messages', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.ae_offer = { prefill };
    await route.fulfill({ response, json: body });
  });
}
async function ask(page, text) {
  ctx.app.ai.queue({ mode: 'text', text: 'Синтетический ответ о переносимости' });
  await page.fill(B.tid('msg.wchat.placeholder'), text);
  await page.click(B.tid('msg.composer.send'));
}

test('психиатр: кнопка в карточке, три шага, «вероятна» → запись в «Сигналах» и путь в черновик извещения', async () => {
  await ensurePlan();
  const { page, errors } = await as('psy1', cardUrl('patA'));
  await B.expectVisible(page, 'msg.ae.clinician.add');
  assert.match(await page.locator(B.tid('msg.ae.clinician.add')).innerText(), /Нежелательное явление/);
  await page.screenshot({ path: `${output}/psychiatrist-card.png` });
  await page.click(B.tid('msg.ae.clinician.add'));
  await page.waitForSelector(`[data-ae-host] ${card}`);
  assert.equal(await page.locator(`[data-ae-host] ${card}`).count(), 1, 'опрос открывается в карточке пациента');
  assert.match(await page.locator(B.tid('msg.ae.wizard.title.psychiatrist')).innerText(), /оценка врача/);
  assert.equal(await counter(page), '1/3');
  await page.fill(`${card} textarea`, 'Синтетика: тошнота по утрам, сонливость');
  await page.fill(`${card} input[type="date"]`, daysAgo(2));
  await page.screenshot({ path: `${output}/psychiatrist-step1.png`, fullPage: true });
  await next(page);
  assert.equal(await counter(page), '2/3');
  assert.match(await page.locator(card).innerText(), /Сертралин/, 'препараты — из действующего плана пациента');
  assert.equal(await page.locator(`${card} label.choice`, { hasText: 'Ничего не принимаю' }).count(), 0);
  await page.screenshot({ path: `${output}/psychiatrist-step2.png`, fullPage: true });
  await pick(page, 'Сертралин');
  await next(page);
  assert.equal(await counter(page), '3/3');
  await pick(page, 'Заметно');
  await pick(page, 'Вероятна');
  await pick(page, 'Нет');
  await page.screenshot({ path: `${output}/psychiatrist-step3.png`, fullPage: true });
  await next(page);
  await page.waitForSelector('[data-ae-done]');
  assert.match(await page.locator(B.tid('msg.ae.clinician.done.psychiatrist')).innerText(), /Оценка врача: связь вероятна/);
  await B.expectVisible(page, 'msg.ae.clinician.notice_open');
  assert.equal(await page.locator(card).count(), 0);
  await page.screenshot({ path: `${output}/psychiatrist-done.png`, fullPage: true });
  const row = latest();
  assert.deepEqual(
    [row.patient_id, row.source, row.status, row.severity, row.reported_by, row.decision_by, row.serious, row.thread_id],
    [ctx.app.ids.patA, 'form', 'related_likely', 'noticeable', ctx.app.ids.psy1, ctx.app.ids.psy1, 0, null],
  );
  assert.ok(row.item_key, 'препарат плана записан');
  // «Сигналы»: запись с решением
  const signals = await F.signalsOf(await ctx.api('psy1'), 'kind=ae&status=all');
  assert.equal(signals.find((x) => x.id === row.id).status, 'related_likely');
  // из подтверждения — прямо в существующий редактор черновика
  // test-change: извещение открывается во вкладке «Шаблоны и документы» (2026-10-26).
  await page.click(B.tid('msg.ae.clinician.notice_open'));
  await page.waitForURL(/tab=docs&doc=\d+/);
  await page.waitForSelector('[data-doc-form] [data-field="suspect_drugs.0.trade_name"]');
  const field = (name) => page.inputValue(`[data-field="${name}"]`);
  assert.match(await field('suspect_drugs.0.trade_name'), /сертралин|sertraline|зол/i, 'препарат подтянут из выбранного пункта плана');
  assert.equal(await field('reaction_started_on'), daysAgo(2), 'дата начала из опроса');
  assert.match(await field('description'), /тошнота по утрам, сонливость/, 'описание из опроса');
  await page.screenshot({ path: `${output}/notice-from-form.png`, fullPage: true });
  assert.deepEqual(errors, []);
});

test('психиатр: «не связана» не открывает путь к извещению; закрытие крестиком ничего не отправляет', async () => {
  await ensurePlan();
  const { page } = await as('psy1', cardUrl('patA'));
  const before = ctx.app.query('SELECT count(*) n FROM adverse_events')[0].n;
  await page.click(B.tid('msg.ae.clinician.add'));
  await page.waitForSelector(card);
  await page.click(B.tid('msg.ae.wizard.close'));
  await page.waitForFunction(() => !document.querySelector('[data-ae-wizard]'));
  assert.equal(ctx.app.query('SELECT count(*) n FROM adverse_events')[0].n, before);
  await page.click(B.tid('msg.ae.clinician.add'));
  await page.fill(`${card} textarea`, 'Синтетика: головная боль');
  await next(page);
  await pick(page, 'Другой препарат');
  await page.fill(`${card} input[data-ae-field="med_name"]`, 'Мелатонин');
  await next(page);
  await pick(page, 'Немного');
  await pick(page, 'Не связана');
  await pick(page, 'Нет');
  await next(page);
  await page.waitForSelector('[data-ae-done]');
  assert.match(await page.locator('[data-ae-done]').innerText(), /не связано/);
  assert.equal(await page.locator(B.tid('msg.ae.clinician.notice_open')).count(), 0);
  const row = latest();
  assert.equal(row.status, 'not_related');
  assert.equal(row.med_text_enc, 'Мелатонин');
  await page.click(B.tid('msg.ae.clinician.done.close'));
  assert.equal(await page.locator('[data-ae-host]').count(), 0);
});

test('психолог: кнопка есть при психиатре, запись уходит психиатру; без психиатра кнопки нет', async () => {
  await ensurePlan();
  const { page, errors } = await as('plg1', cardUrl('patA'));
  await B.expectVisible(page, 'msg.ae.clinician.add');
  await page.click(B.tid('msg.ae.clinician.add'));
  await page.waitForSelector(card);
  assert.match(await page.locator(B.tid('msg.ae.wizard.title.psychologist')).innerText(), /передадим психиатру/);
  await page.fill(`${card} textarea`, 'Синтетика: пациент жалуется на дрожь в руках');
  await next(page);
  assert.equal(await page.locator(`${card} label.choice`).count(), 0, 'состав плана психологу не показывается');
  await page.fill(`${card} input[data-ae-field="med_name"]`, 'Золофт');
  await next(page);
  await pick(page, 'Сильно');
  await page.screenshot({ path: `${output}/psychologist-step3.png`, fullPage: true });
  await next(page);
  await page.waitForSelector('[data-ae-done]');
  assert.match(await page.locator(B.tid('msg.ae.clinician.done.psychologist')).innerText(), /^Передано психиатру пациента$/);
  assert.equal(await page.locator(B.tid('msg.ae.clinician.notice_open')).count(), 0);
  await page.screenshot({ path: `${output}/psychologist-done.png`, fullPage: true });
  const row = latest();
  assert.deepEqual(
    [row.status, row.reported_by, row.psychiatrist_id, row.med_text_enc, row.severity, row.decision_by],
    ['awaiting_doctor', ctx.app.ids.plg1, ctx.app.ids.psy1, 'Золофт', 'severe', null],
  );
  // пациент без закреплённого психиатра: кнопки у психолога нет
  const none = await as('plg1', cardUrl('patI'));
  await none.page.waitForSelector('.pcard .phead-act');
  await none.page.waitForLoadState('networkidle');
  assert.equal(await none.page.locator(B.tid('msg.ae.clinician.add')).isVisible(), false);
  await none.page.screenshot({ path: `${output}/psychologist-no-psychiatrist.png` });
  assert.deepEqual(errors, []);
});

test('чат психиатра: предложение, «Оформить», сводка в ленте и после перезагрузки, повторно не предлагается', async () => {
  await ensurePlan();
  const { page, errors } = await as('psy1', `/work?tab=chat&p=${ctx.app.ids.patA}`);
  await page.waitForSelector(B.tid('msg.wchat.placeholder'));
  await interceptOffer(page, { symptoms: ['nausea'] });
  await ask(page, 'У пациента тошнота после увеличения дозы');
  await page.waitForSelector(B.tid('msg.ae.clinician.offer.yes'));
  assert.match(await page.locator(B.tid('msg.ae.clinician.offer')).innerText(), /Похоже на возможную побочную реакцию у пациента\. Оформить\?/);
  await page.screenshot({ path: `${output}/chat-offer.png`, fullPage: true });
  await page.click(B.tid('msg.ae.clinician.offer.yes'));
  await page.waitForSelector(card);
  assert.equal(await page.inputValue(`${card} textarea`), 'У пациента тошнота после увеличения дозы');
  await next(page);
  await pick(page, 'Сертралин');
  await next(page);
  await pick(page, 'Заметно');
  await pick(page, 'Недостаточно данных');
  await pick(page, 'Нет');
  await page.screenshot({ path: `${output}/chat-wizard.png`, fullPage: true });
  await next(page);
  const summary = page.locator('.ae-summary');
  await summary.waitFor();
  assert.match(await summary.innerText(), /В карточке пациента записано нежелательное явление/);
  assert.match(await summary.innerText(), /данных недостаточно/);
  assert.equal(await page.locator(card).count(), 0);
  await page.screenshot({ path: `${output}/chat-summary.png`, fullPage: true });
  const row = latest();
  assert.deepEqual([row.source, row.status, row.reported_by], ['ai_chat', 'insufficient', ctx.app.ids.psy1]);
  const thread = ctx.app.query("SELECT max(id) m FROM ai_threads WHERE owner_user_id=? AND purpose='clinician_chat'", [ctx.app.ids.psy1])[0].m;
  assert.equal(row.thread_id, thread);
  // тот же пациент, тот же чат: больше не предлагаем
  await ask(page, 'И ещё сонливость');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="msg.ai.rate.useful"]').length >= 2);
  assert.equal(await page.locator(B.tid('msg.ae.clinician.offer.yes')).count(), 0);
  // перезагрузка: сводка из истории треда
  await B.open(page, ctx.app, `/work?tab=chat&thread=${thread}`);
  await page.locator('.ae-summary[data-kind="ae_summary"]').waitFor();
  assert.match(await page.locator('.ae-summary').innerText(), /В карточке пациента записано/);
  assert.deepEqual(errors, []);
});

test('чат психиатра: «вероятна» — под сводкой кнопка «Открыть черновик извещения»; «Не сейчас» убирает предложение', async () => {
  const { page } = await as('psy1', `/work?tab=chat&p=${ctx.app.ids.patH}`);
  await page.waitForSelector(B.tid('msg.wchat.placeholder'));
  await interceptOffer(page);
  await ask(page, 'Новая тошнота и головокружение у пациента');
  await page.waitForSelector(B.tid('msg.ae.clinician.offer.no'));
  await page.click(B.tid('msg.ae.clinician.offer.no'));
  assert.equal(await page.locator(B.tid('msg.ae.clinician.offer.yes')).count(), 0);
  assert.equal(await page.locator(card).count(), 0);
  // другой пациент или новая лента: снова можно
  await B.open(page, ctx.app, `/work?tab=chat&p=${ctx.app.ids.patH}`);
  await page.waitForSelector(B.tid('msg.wchat.placeholder'));
  await interceptOffer(page);
  await ask(page, 'Головокружение усилилось');
  await page.click(`${B.tid('msg.ae.clinician.offer.yes')}`);
  await next(page);
  // у пациента нет плана: препарат вписывается текстом
  await page.fill(`${card} input[data-ae-field="med_name"]`, 'Мелатонин');
  await next(page);
  await pick(page, 'Сильно');
  await pick(page, 'Вероятна');
  await pick(page, /^Да$/);
  await next(page);
  await page.locator('.ae-summary').waitFor();
  await B.expectVisible(page, 'msg.ae.clinician.notice_open');
  assert.equal(latest().serious, 1);
  await page.click(B.tid('msg.ae.clinician.notice_open'));
  await page.waitForSelector('[data-doc-form] [data-field="description"]');
  assert.match(await page.inputValue('[data-field="description"]'), /Головокружение усилилось/);
  assert.equal(await page.inputValue('[data-field="suspect_drugs.0.trade_name"]'), 'Мелатонин', 'препарат из опроса (свободное название)');
});

test('чат психолога: предложение, запись психиатру, сводка без состава плана', async () => {
  await ensurePlan();
  const { page, errors } = await as('plg1', `/work?tab=chat&p=${ctx.app.ids.patA}`);
  await page.waitForSelector(B.tid('msg.wchat.placeholder'));
  await interceptOffer(page);
  await ask(page, 'Пациент говорит, что после таблеток дрожат руки');
  await page.waitForSelector(B.tid('msg.ae.clinician.offer.yes'));
  await page.click(B.tid('msg.ae.clinician.offer.yes'));
  await page.waitForSelector(card);
  assert.match(await page.locator(B.tid('msg.ae.wizard.title.psychologist')).innerText(), /психиатру/);
  await next(page);
  await page.fill(`${card} input[data-ae-field="med_name"]`, 'Золофт');
  await next(page);
  await pick(page, 'Заметно');
  await next(page);
  const summary = page.locator('.ae-summary');
  await summary.waitFor();
  assert.match(await summary.innerText(), /передано психиатру пациента/);
  assert.doesNotMatch(await summary.innerText(), /сертралин|50/i);
  assert.equal(await page.locator(B.tid('msg.ae.clinician.notice_open')).count(), 0);
  await page.screenshot({ path: `${output}/chat-psychologist-summary.png`, fullPage: true });
  const row = latest();
  assert.deepEqual([row.source, row.status, row.reported_by, row.psychiatrist_id], ['ai_chat', 'awaiting_doctor', ctx.app.ids.plg1, ctx.app.ids.psy1]);
  assert.ok(row.thread_id);
  assert.deepEqual(errors, []);
});

test('мобильный вид 375px: кнопка в карточке, опрос и предложение в чате без горизонтальной прокрутки', async () => {
  await ensurePlan();
  const { page } = await as('psy1', cardUrl('patA'), PHONE);
  await B.expectVisible(page, 'msg.ae.clinician.add');
  await page.screenshot({ path: `${output}/mobile-card.png` });
  const tap = await page.locator(B.tid('msg.ae.clinician.add')).boundingBox();
  assert.ok(tap.height >= 36, 'кнопка достаточно крупная');
  assert.ok(tap.x >= 0 && tap.x + tap.width <= 375, 'кнопка помещается в экран');
  await page.click(B.tid('msg.ae.clinician.add'));
  await page.waitForSelector(card);
  assert.equal(await B.noHorizontalOverflow(page), true);
  await page.screenshot({ path: `${output}/mobile-step1.png` });
  const box = await page.locator(B.tid('msg.ae.wizard.confirm')).boundingBox();
  assert.ok(box.height >= 44);
  const bad = (await B.axeViolations(page)).filter((v) => v.nodes.some((n) => n.includes('ae-wiz') || n.includes('ae-card')));
  assert.deepEqual(bad, []);
  // чат
  const chat = await as('psy1', `/work?tab=chat&p=${ctx.app.ids.patG}`, PHONE);
  await chat.page.waitForSelector(B.tid('msg.wchat.placeholder'));
  await interceptOffer(chat.page);
  await ask(chat.page, 'Появилась тревожная дрожь после таблетки');
  await chat.page.waitForSelector(B.tid('msg.ae.clinician.offer.yes'));
  await chat.page.screenshot({ path: `${output}/mobile-chat-offer.png` });
  assert.equal(await B.noHorizontalOverflow(chat.page), true);
  const yes = await chat.page.locator(B.tid('msg.ae.clinician.offer.yes')).boundingBox();
  assert.ok(yes.height >= 44);
  await chat.page.click(B.tid('msg.ae.clinician.offer.yes'));
  await chat.page.waitForSelector(card);
  await chat.page.locator(card).scrollIntoViewIfNeeded();
  assert.equal(await B.noHorizontalOverflow(chat.page), true);
  await chat.page.screenshot({ path: `${output}/mobile-chat-wizard.png` });
});
