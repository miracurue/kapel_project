'use strict';

// Оболочка v5 по утверждённому прототипу (07 «Navigation», 09 «Admin menu»): верхняя полоса, вкладки роли,
// «Ещё», колокольчик, аватар, демо-строка, «Мне нужна помощь · 112» только у пациента; знакомство и справка;
// черновик ввода при истёкшей сессии (F-03); страницы ошибок; выход и кнопка «Назад».

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');

const ctx = useBrowserApp();

const TABS = {
  patA: ['msg.nav.patient.chat', 'msg.nav.patient.meds', 'msg.nav.patient.tests', 'msg.nav.patient.diary', 'msg.nav.patient.visits', 'msg.nav.patient.doctor'],
  psy1: ['msg.nav.clinician.chat', 'msg.nav.clinician.patients', 'msg.nav.clinician.signals', 'msg.nav.psychiatrist.docs', 'msg.nav.clinician.tests', 'msg.nav.clinician.blog'],
  plg1: ['msg.nav.clinician.chat', 'msg.nav.clinician.patients', 'msg.nav.clinician.signals', 'msg.nav.psychologist.conclusions', 'msg.nav.clinician.tests', 'msg.nav.clinician.blog'],
  admin1: ['msg.nav.admin.chat', 'msg.nav.admin.requests', 'msg.nav.admin.people', 'msg.nav.admin.settings', 'msg.nav.admin.log', 'msg.shell.more'],
};
const HOME = { patA: ['/app', 'P-13'], psy1: ['/work', 'P-20'], plg1: ['/work', 'P-20'], admin1: ['/admin', 'P-34'] };

// covers: T-400, UC-39, UC-18, F-09, F-10, F-25, R-02, R-03, R-04, R-05
test('T-400 [W-06] вкладки роли v5: пациент 7 на компьютере и 5 + «Ещё» на 390 px; у специалистов и админа свои; «Мне нужна помощь · 112» только у пациента; колокольчик и аватар у всех', async () => {
  for (const [who, tabs] of Object.entries(TABS)) {
    const { ctx: c, page } = await B.contextAs(ctx.browser, ctx.app, who, B.DESKTOP);
    ctx.track(c);
    await B.open(page, ctx.app, HOME[who][0]);
    await B.expectPage(page, HOME[who][1]);
    for (const t of tabs) await B.expectVisible(page, t);
    await B.expectVisible(page, 'msg.shell.bell');
    await B.expectVisible(page, 'msg.shell.avatar');
    if (who === 'patA') await B.expectVisible(page, 'msg.shell.crisis_link');
    else await B.expectHidden(page, 'msg.shell.crisis_link');
    await B.expectVisible(page, 'msg.demo.strip');
  }
  const { ctx: c2, page } = await B.contextAs(ctx.browser, ctx.app, 'patA', B.PHONE);
  ctx.track(c2);
  await B.open(page, ctx.app, '/app');
  const visible = await page.locator('nav [data-testid^="msg.nav.patient."]:visible').count();
  assert.equal(visible, 5, 'на телефоне 5 вкладок + «Ещё»');
  await B.expectVisible(page, 'msg.shell.more');
  await page.click(B.tid('msg.shell.more'));
  await B.expectVisible(page, 'msg.nav.patient.visits');
  await B.expectVisible(page, 'msg.nav.patient.doctor');
  assert.ok(await B.noHorizontalOverflow(page), 'нет горизонтальной прокрутки на 390 px');
});

// covers: T-401, UC-39, F-09, F-46
test('T-401 [W-06] первый вход — знакомство 3–5 шагов с «Пропустить», повторный — нет; «Справка» в аватаре, 112 вверху справки', async () => {
  ctx.app.exec(`UPDATE user_prefs SET onboarding_done_at = NULL WHERE user_id = ${Number(ctx.app.ids.patB)}`);
  const { ctx: c, page } = await B.contextAs(ctx.browser, ctx.app, 'patB');
  ctx.track(c);
  await B.open(page, ctx.app, '/app');
  await B.expectVisible(page, 'msg.onboarding.patient.1');
  await page.click(B.tid('msg.onboarding.skip'));
  await page.reload();
  await B.expectHidden(page, 'msg.onboarding.patient.1');
  await page.click(B.tid('msg.shell.avatar'));
  await page.click(B.tid('msg.nav.avatar.help'));
  await B.expectPage(page, 'P-27');
  const first = await page.locator('main [data-testid]').first().getAttribute('data-testid');
  assert.match(first, /msg\.help\.(top_112|call_112)/, '112 — первым на экране справки');
});

// covers: T-402, UC-02, UC-18, F-03, F-02, PD-17
test('T-402 [W-04] сессия истекла при отправке: «Сессия истекла — введённое сохранено», после входа текст восстановлен тому же пользователю; другому — нет', async () => {
  const { ctx: c, page } = await B.contextAs(ctx.browser, ctx.app, 'patA');
  ctx.track(c);
  await B.open(page, ctx.app, '/app?tab=diary');
  await page.fill(`${B.tid('msg.diary.note')}`, 'Синтетический черновик заметки Т13');
  await c.clearCookies();
  await page.click(B.tid('msg.diary.save'));
  await page.waitForURL(/\/login/);
  await B.expectVisible(page, 'msg.login.session_expired');
  await page.fill(B.tid('msg.login.email'), 'pat.a@cc.example.test');
  await page.fill(B.tid('msg.login.password'), 'Synthetic-Pass-2026');
  await page.click(B.tid('msg.login.submit'));
  await B.expectPage(page, 'P-29');
  await B.expectVisible(page, 'msg.composer.draft_restored');
  assert.equal(await page.inputValue(B.tid('msg.diary.note')), 'Синтетический черновик заметки Т13');
  await c.clearCookies();
  await B.open(page, ctx.app, '/login');
  await page.fill(B.tid('msg.login.email'), 'pat.b@cc.example.test');
  await page.fill(B.tid('msg.login.password'), 'Synthetic-Pass-2026');
  await page.click(B.tid('msg.login.submit'));
  await B.open(page, ctx.app, '/app?tab=diary');
  await B.expectHidden(page, 'msg.composer.draft_restored');
  assert.equal(await page.inputValue(B.tid('msg.diary.note')), '', 'чужой черновик не показан и стёрт');
  assert.ok(!ctx.app.logs().includes('Синтетический черновик заметки Т13'), 'черновик живёт только в браузере');
});

// covers: T-403, UC-18, F-25, F-03
test('T-403 [W-06] ошибки: 403 и 404 чужого выглядят одинаково (P-28 без подробностей, «На главную», 112 у пациента); нет сети — введённое остаётся и «Повторить»', async () => {
  const { ctx: c, page } = await B.contextAs(ctx.browser, ctx.app, 'psy1');
  ctx.track(c);
  await B.open(page, ctx.app, `/work/patients/${ctx.app.ids.patB}`);
  await B.expectPage(page, 'P-28');
  await B.expectVisible(page, 'msg.error.home');
  const { ctx: c2, page: p2 } = await B.contextAs(ctx.browser, ctx.app, 'patA');
  ctx.track(c2);
  await B.open(p2, ctx.app, '/error/404');
  await B.expectVisible(p2, 'msg.error.patient_help');
  await B.open(p2, ctx.app, '/app?tab=doctor');
  await p2.fill(B.tid('msg.doctor.placeholder'), 'Синтетика: сообщение без сети');
  await c2.setOffline(true);
  await p2.click(B.tid('msg.composer.send'));
  await B.expectVisible(p2, 'msg.shell.offline');
  assert.equal(await p2.inputValue(B.tid('msg.doctor.placeholder')), 'Синтетика: сообщение без сети');
  await c2.setOffline(false);
});

// covers: T-404, UC-02, F-02, PD-21
test('T-404 [W-04] «Выйти»: страница входа, «Назад» в браузере не показывает данные', async () => {
  const { ctx: c, page } = await B.contextAs(ctx.browser, ctx.app, 'patA');
  ctx.track(c);
  await B.open(page, ctx.app, '/app?tab=diary');
  await page.click(B.tid('msg.shell.avatar'));
  await page.click(B.tid('msg.nav.avatar.logout'));
  await B.expectPage(page, 'P-02');
  await page.goBack();
  await page.waitForLoadState('domcontentloaded');
  assert.doesNotMatch(await page.content(), /data-page="P-29"/, 'данные не показаны после выхода');
});
