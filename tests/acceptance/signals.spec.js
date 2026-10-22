'use strict';

// Сигналы (P-22): кризис пациента видят психиатр и психолог в двух браузерах одновременно; один «Взять в работу»
// — у второго «В работе у …» без перезагрузки (≤ 30 с), кнопки неактивны; НЯ — решение и черновик извещения.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const F = require('../lib/flows');

const ctx = useBrowserApp();

// covers: T-455, UC-05, UC-11, F-16, F-63, F-19, PD-16
test('T-455 [W-25] два специалиста: пациент пишет кризисную фразу и жмёт «Мне нужна помощь»; психиатр берёт — у психолога «В работе у …» за ≤ 30 с, «Взять в работу» неактивна; «Связались · Отменить»', async () => {
  const pat = await B.contextAs(ctx.browser, ctx.app, 'patA');
  ctx.track(pat.ctx);
  await B.open(pat.page, ctx.app, '/app');
  await pat.page.fill(B.tid('msg.chat.placeholder'), F.CRISIS_PHRASE);
  await pat.page.click(B.tid('msg.composer.send'));
  await B.expectVisible(pat.page, 'msg.crisis.card.title');
  await pat.page.click(B.tid('msg.shell.crisis_link'));
  await B.expectPage(pat.page, 'P-27');
  await B.expectVisible(pat.page, 'msg.help.call_112');

  const psy = await B.contextAs(ctx.browser, ctx.app, 'psy1');
  const plg = await B.contextAs(ctx.browser, ctx.app, 'plg1');
  ctx.track(psy.ctx); ctx.track(plg.ctx);
  await B.open(psy.page, ctx.app, '/work?tab=signals');
  await B.open(plg.page, ctx.app, '/work?tab=signals');
  for (const s of [psy, plg]) {
    await B.expectPage(s.page, 'P-22');
    await B.expectVisible(s.page, 'msg.signals.quote');
    await B.expectVisible(s.page, 'msg.signals.shown_112');
    await B.expectVisible(s.page, 'msg.signals.take');
  }
  await psy.page.locator(B.tid('msg.signals.take')).first().click();
  await B.expectVisible(psy.page, 'msg.undo.signal_taken');
  await plg.page.waitForSelector(B.tid('msg.signals.status.in_work'), { timeout: 35000 });
  const takeBtn = plg.page.locator(B.tid('msg.signals.take')).first();
  assert.ok(!(await takeBtn.count()) || await takeBtn.isDisabled(), 'кнопка захвата у второго неактивна');
  assert.match(await plg.page.locator(B.tid('msg.signals.status.in_work')).first().textContent(), /Анна Синтетикова|психиатр/);
  await psy.page.locator(B.tid('msg.signals.contacted')).first().click();
  await B.expectVisible(psy.page, 'msg.undo.signal_contacted');
  await plg.page.locator(B.tid('msg.signals.filter.handled')).click();
  await plg.page.waitForSelector(B.tid('msg.signals.status.handled'), { timeout: 35000 });
});

// covers: T-456, UC-13, F-65, F-66
test('T-456 [W-26] НЯ у психиатра: «Связь вероятна» → подсказка сроков и «Черновик извещения» → «Скачать для отправки» — не отправляется автоматически', async () => {
  const p = await ctx.api('patA');
  await p.post('/api/v1/me/adverse-events', { symptoms: ['nausea'], text: 'Синтетика: тошнота', severity: 'noticeable', related: 'yes' });
  await F.passUndoWindow(ctx.app);
  const psy = await B.contextAs(ctx.browser, ctx.app, 'psy1');
  ctx.track(psy.ctx);
  await B.open(psy.page, ctx.app, '/work?tab=signals');
  await psy.page.click(B.tid('msg.signals.filter.ae'));
  await psy.page.locator(B.tid('msg.signals.ae.likely')).first().click();
  await B.expectVisible(psy.page, 'msg.signals.ae.deadlines');
  await psy.page.click(B.tid('msg.signals.notice.open'));
  await B.expectVisible(psy.page, 'msg.signals.notice.manual');
  const [download] = await Promise.all([psy.page.waitForEvent('download'), psy.page.click(B.tid('msg.signals.notice.download'))]);
  assert.ok(download.suggestedFilename().length > 0);
  const plg = await B.contextAs(ctx.browser, ctx.app, 'plg1');
  ctx.track(plg.ctx);
  await B.open(plg.page, ctx.app, '/work?tab=signals');
  await B.expectHidden(plg.page, 'msg.signals.filter.ae');
});
