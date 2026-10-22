'use strict';

// Демо (P-01, P-26), регистрация по коду и 4 согласия (P-03…P-07), сброс пароля по ссылке из письма (P-08),
// экран заблокированного (R-07).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const { extractLink } = require('../lib/fakes/smtp');

const ctx = useBrowserApp({ demo: true, seed: true });

// covers: T-470, UC-40, F-78, F-79, F-10
test('T-470 [W-10] P-01: «Войти как» 4 роли и маршрут показа; ведущий сбрасывает демо-данные через диалог с предупреждением о сессиях', async () => {
  const { ctx: c, page } = await B.contextAs(ctx.browser, ctx.app, null);
  ctx.track(c);
  await B.open(page, ctx.app, '/');
  await B.expectPage(page, 'P-01');
  for (const r of ['patient', 'psychiatrist', 'psychologist', 'admin']) await B.expectVisible(page, `msg.p01.role.${r}`);
  await B.expectVisible(page, 'msg.p01.route.title');
  await page.click(B.tid('msg.p01.link.host'));
  await B.expectPage(page, 'P-26');
  await page.click(B.tid('msg.nav.host.data'));
  await page.click(B.tid('msg.host.data.reset'));
  await B.expectVisible(page, 'msg.host.reset.sessions_warning');
  await page.click(B.tid('msg.host.reset.confirm'));
  await B.expectVisible(page, 'msg.host.reset.done');
});

// covers: T-475, UC-01, F-04, F-05, PD-09
test('T-475 [W-07] регистрация по коду: код, почта, пароль → «Согласие 1 из 4» с пустым флажком; без флажка дальше нельзя; «Не сейчас» у необязательных', async () => {
  const doc = await ctx.api('psy1');
  const inv = (await doc.post('/api/v1/invites', {})).body;
  const { ctx: c, page } = await B.contextAs(ctx.browser, ctx.app, null);
  ctx.track(c);
  await B.open(page, ctx.app, '/register');
  await B.expectPage(page, 'P-03');
  await page.fill(B.tid('msg.register.code'), inv.code);
  await page.fill(B.tid('msg.register.email'), 'browser.new@cc.example.test');
  await page.fill(B.tid('msg.register.password'), 'Browser-Pass-2026');
  await page.click(B.tid('msg.register.next'));
  await B.expectPage(page, 'P-04');
  assert.equal(await page.isChecked(B.tid('msg.consent.pd.checkbox')), false, 'флажок пустой (L-04)');
  await page.click(B.tid('msg.consent.agree'));
  await B.expectVisible(page, 'err.e-consent-required');
  await B.expectPage(page, 'P-04');
  await page.check(B.tid('msg.consent.pd.checkbox'));
  await page.click(B.tid('msg.consent.agree'));
  for (const id of ['P-05', 'P-06', 'P-07']) {
    await B.expectPage(page, id);
    await page.click(B.tid('msg.consent.not_now'));
  }
  await B.expectPage(page, 'P-13');
});

// covers: T-476, UC-38, F-07, F-20
test('T-476 [W-08] «Забыли пароль?» → одинаковый ответ → ссылка из письма открывает новый пароль → вход; повтор ссылки — «Ссылка недействительна»', async () => {
  const { ctx: c, page } = await B.contextAs(ctx.browser, ctx.app, null);
  ctx.track(c);
  await B.open(page, ctx.app, '/login');
  await page.click(B.tid('msg.login.forgot'));
  await B.expectPage(page, 'P-08');
  await page.fill(B.tid('msg.reset.email'), 'pat.b@cc.example.test');
  await page.click(B.tid('msg.reset.submit'));
  await B.expectVisible(page, 'msg.reset.sent');
  await ctx.app.waitJobs(10);
  const link = extractLink(ctx.app.smtp.lastTo('pat.b@cc.example.test').text);
  await page.goto(link);
  await page.fill(B.tid('msg.reset.new.password'), 'Browser-Reset-2026');
  await page.fill(B.tid('msg.reset.new.repeat'), 'Browser-Reset-2026');
  await page.click(B.tid('msg.reset.new.submit'));
  await B.expectVisible(page, 'msg.reset.new.done');
  await page.goto(link);
  await B.expectVisible(page, 'err.e-reset-token');
});

// covers: T-477, UC-05, F-01, F-46, R-07
test('T-477 [W-04] заблокированный: отдельный экран с причиной, контактом клиники и 112', async () => {
  const { ctx: c, page } = await B.contextAs(ctx.browser, ctx.app, null);
  ctx.track(c);
  await B.open(page, ctx.app, '/login');
  await page.fill(B.tid('msg.login.email'), 'pat.f@cc.example.test');
  await page.fill(B.tid('msg.login.password'), 'Synthetic-Pass-2026');
  await page.click(B.tid('msg.login.submit'));
  await B.expectVisible(page, 'msg.blocked.title');
  await B.expectVisible(page, 'msg.blocked.reason');
  await B.expectVisible(page, 'msg.blocked.emergency');
});
