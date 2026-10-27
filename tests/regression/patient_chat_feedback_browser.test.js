'use strict';
// covers: F-27, W-34 · обратная связь в чате пациента: после «Отправить» сразу видно сообщение и этапы ответа, кнопка занята;
// напоминания показываются по одному и с перерывом, действие убирает карточку, главные кнопки читаются.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');

const ctx = useBrowserApp();

test('после «Отправить» сразу видно сообщение, этапы ответа и занятую кнопку; потом только ответ', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'patA');
  ctx.track(session.ctx);
  const page = session.page;
  ctx.app.ai.reset();
  ctx.app.ai.queue(
    { mode: 'tool', name: 'get_my_diary', arguments: {} },
    { mode: 'text', text: 'Вижу записи в дневнике.', delay_ms: 3000 },
  );
  await B.open(page, ctx.app, '/app?tab=chat');
  await page.fill(B.tid('msg.chat.placeholder'), 'Как у меня с дневником?');
  await page.click(B.tid('msg.composer.send'));
  await B.expectVisible(page, 'msg.chat.progress');
  assert.equal(await page.locator('#v3-chat .chat-msg_user').count(), 1, 'своё сообщение уже в ленте');
  assert.equal(await page.locator(B.tid('msg.composer.send')).isDisabled(), true, 'кнопка занята');
  assert.equal(await page.inputValue(B.tid('msg.chat.placeholder')), '', 'поле очищено');
  assert.match(await page.locator('#v3-chat .progress').innerText(), /Сообщение отправлено/);
  await page.waitForFunction(
    () => /твой дневник/.test(document.querySelector('#v3-chat .progress')?.innerText || ''),
    null,
    { timeout: 8000 },
  );
  await page.waitForFunction(() => !document.querySelector('[data-testid="msg.chat.progress"]'), null, {
    timeout: 15000,
  });
  assert.match(await page.locator('#v3-chat .chat-msg_assistant').last().innerText(), /Вижу записи в дневнике/);
  assert.equal(await page.locator(B.tid('msg.composer.send')).isDisabled(), false, 'кнопка снова доступна');
});

test('сбой ответа: сообщение возвращается в поле, индикатор исчезает', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'patA');
  ctx.track(session.ctx);
  const page = session.page;
  ctx.app.ai.reset();
  ctx.app.ai.queue({ mode: 'error' }, { mode: 'error' });
  await B.open(page, ctx.app, '/app?tab=chat&new=1');
  await page.fill(B.tid('msg.chat.placeholder'), 'Сообщение при сбое');
  await page.click(B.tid('msg.composer.send'));
  await B.expectVisible(page, 'msg.shell.retry');
  assert.equal(await page.locator(B.tid('msg.chat.progress')).count(), 0);
  assert.equal(await page.inputValue(B.tid('msg.chat.placeholder')), 'Сообщение при сбое', 'текст не потерян');
  assert.equal(await page.locator('#v3-chat .chat-msg_user').count(), 0, 'не ушедшее сообщение убрано из ленты');
});

test('напоминания: видна одна карточка, «Позже» убирает её, следующая — после перерыва; кнопки читаются', async () => {
  const db = ctx.app.db();
  try {
    const starts = new Date(Date.now() + 30 * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    db.prepare(
      "INSERT INTO visits(patient_id,clinician_id,starts_at,format,status,previsit_enabled,created_at) VALUES (?,?,?,'remote','scheduled',0,?)",
    ).run(ctx.app.ids.patB, ctx.app.ids.psy2, starts, starts);
  } finally {
    db.close();
  }
  const session = await B.contextAs(ctx.browser, ctx.app, 'patB');
  ctx.track(session.ctx);
  const page = session.page;
  await B.open(page, ctx.app, '/app?tab=chat');
  const visible = () => page.locator('.reminders .reminder:not([hidden])');
  assert.equal(await visible().count(), 1, 'одна карточка из нескольких');
  assert.ok((await page.locator('.reminders .reminder').count()) >= 2, 'остальные ждут');
  const colors = await page
    .locator('.reminders .btn.primary')
    .first()
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor };
    });
  assert.notEqual(colors.color, colors.background, 'текст отличается от фона кнопки');
  assert.notEqual(colors.background, 'rgb(255, 255, 255)', 'главная кнопка не белая');
  await page.click(`.reminders .reminder:not([hidden]) ${B.tid('msg.reminder.later')}`);
  assert.equal(await visible().count(), 0, 'перерыв: следующая карточка не показывается сразу');
  await B.open(page, ctx.app, '/app?tab=chat');
  assert.equal(await visible().count(), 0, 'перерыв помнится после обновления');
  await page.evaluate(() => {
    const v = JSON.parse(localStorage.getItem('cc.reminders') || '{}');
    v.next = 0;
    localStorage.setItem('cc.reminders', JSON.stringify(v));
  });
  await B.open(page, ctx.app, '/app?tab=chat');
  assert.equal(await visible().count(), 1, 'после перерыва показана следующая');
  assert.equal(await page.locator('.reminders .reminder[data-reminder="visit"]').count(), 0, 'отложенная не вернулась');
  await page.click(`.reminders .reminder:not([hidden]) ${B.tid('msg.reminder.later')}`);
  assert.equal(await visible().count(), 0);
});

test('действие по напоминанию убирает карточку: форма обращения сохраняется и карточка уходит', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'patC');
  ctx.track(session.ctx);
  const page = session.page;
  const noPause = () =>
    page.evaluate(() => {
      const v = JSON.parse(localStorage.getItem('cc.reminders') || '{}');
      v.next = 0;
      localStorage.setItem('cc.reminders', JSON.stringify(v));
    });
  await B.open(page, ctx.app, '/app?tab=chat');
  // Порядок карточек зависит от времени суток (вечером впереди дневник): откладываем лишние, пока не дойдём до вопроса.
  for (let i = 0; i < 4; i += 1) {
    await noPause();
    await page.reload();
    const first = page.locator('.reminders .reminder:not([hidden])').first();
    if ((await first.getAttribute('data-reminder')) === 'profile') break;
    await first.locator(B.tid('msg.reminder.later')).click();
  }
  const card = page.locator('.reminders .reminder[data-reminder="profile"]:not([hidden])');
  assert.equal(await card.count(), 1, 'вопрос о форме обращения показан');
  await card.locator(B.tid('msg.reminder.profile.f')).click();
  await page.waitForFunction(() => !document.querySelector('.reminders .reminder[data-reminder="profile"]'));
  assert.equal(ctx.app.query('SELECT address_form f FROM user_prefs WHERE user_id = ?', ctx.app.ids.patC)[0].f, 'f');
});

test('ответ ИИ показан форматированным: без звёздочек и решёток, с жирным, списками и заголовком; в истории так же', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'patA');
  ctx.track(session.ctx);
  const page = session.page;
  ctx.app.ai.reset();
  ctx.app.ai.queue({
    mode: 'text',
    text: '## Что видно\n**Сон** был плохим, *настроение* среднее.\nВторая строка.\n\n- пункт один\n- пункт два\n\n1. первое\n2. второе\n\nСсылка [статья](https://example.com/x) и `код`.',
  });
  await B.open(page, ctx.app, '/app?tab=chat&new=1');
  await page.fill(B.tid('msg.chat.placeholder'), 'Расскажи про сон');
  await page.click(B.tid('msg.composer.send'));
  const reply = page.locator('#v3-chat .chat-msg_assistant .chat-msg__text.md').last();
  await reply.waitFor({ timeout: 10000 });
  const check = async (box) => {
    const text = await box.innerText();
    assert.doesNotMatch(text, /\*\*|\*|##|`|\]\(/, 'знаков разметки на экране нет');
    assert.equal(await box.locator('strong').count(), 1);
    assert.equal(await box.locator('em').count(), 1);
    assert.equal(await box.locator('ul > li').count(), 2);
    assert.equal(await box.locator('ol > li').count(), 2);
    assert.equal(await box.locator('h4').count(), 1);
    assert.equal(await box.locator('a').count(), 0, 'ссылок наружу нет');
    assert.match(text, /статья/);
    assert.equal((await box.locator('br').count()) >= 1, true, 'одиночный перенос строки сохранён');
  };
  await check(reply);
  const thread = ctx.app.query(
    'SELECT id FROM ai_threads WHERE owner_user_id = ? AND mode IS NULL ORDER BY id DESC LIMIT 1',
    ctx.app.ids.patA,
  )[0].id;
  await B.open(page, ctx.app, `/app?tab=chat&thread=${thread}`);
  const again = page.locator('#v3-chat .chat-msg_assistant .chat-msg__text.md').last();
  await again.waitFor({ timeout: 10000 });
  await check(again);
});
