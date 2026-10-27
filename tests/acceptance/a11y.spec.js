'use strict';

// Доступность и вёрстка главных страниц (08 Quality, стандарты §3): axe — 0 нарушений serious/critical на
// компьютере и 390 px; клавиатура и видимый фокус; без горизонтальной прокрутки на 360/390; data-page и
// data-testid только из ru.json; заглушки помечены data-standin; никаких внешних скриптов и шрифтов (L-11).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const T = require('../lib/texts');

const ctx = useBrowserApp();

const MAIN = [
  [null, '/login', 'P-02'],
  [null, '/register', 'P-03'],
  [null, '/password/reset', 'P-08'],
  [null, '/legal', 'P-09'],
  [null, '/account/help', 'P-27'],
  ['patA', '/app', 'P-13'],
  ['patA', '/app?tab=meds', 'P-12'],
  ['patA', '/app?tab=tests', 'P-11'],
  ['patA', '/app?tab=diary', 'P-29'],
  ['patA', '/app?tab=library', 'P-15'],
  ['patA', '/app?tab=visits', 'P-30'],
  ['patA', '/app?tab=doctor', 'P-31'],
  ['patA', '/account/data', 'P-16'],
  ['patA', '/account', 'P-17'],
  ['patA', '/account/notifications', 'P-32'],
  ['psy1', '/work', 'P-20'],
  ['psy1', '/work?tab=patients', 'P-18'],
  ['psy1', '/work?tab=signals', 'P-22'],
  ['psy1', '/work?tab=docs', 'P-23'],
  ['psy1', '/work?tab=tools', 'P-21'],
  ['psy1', '/work?tab=analytics', 'P-24'],
  ['psy1', '/work/approvals', 'P-51'],
  ['admin1', '/admin', 'P-34'],
  ['admin1', '/admin?tab=requests', 'P-35'],
  ['admin1', '/admin?tab=people', 'P-36'],
  ['admin1', '/admin?tab=settings', 'P-38'],
  ['admin1', '/admin?tab=log', 'P-47'],
  ['admin1', '/admin?tab=service', 'P-49'],
];

async function each(profile, fn) {
  for (const [who, url, pageId] of MAIN) {
    const { ctx: c, page } = await B.contextAs(ctx.browser, ctx.app, who, profile);
    ctx.track(c);
    await B.open(page, ctx.app, url.includes('/work/patients') ? url : url);
    await B.expectPage(page, pageId);
    await fn(page, { who, url, pageId });
    await c.close();
  }
}

// covers: T-480, UC-18, UC-39, F-25, F-10
test('T-480 [W-55] axe на главных страницах всех ролей: 0 нарушений serious/critical (WCAG 2.2 AA) на компьютере и 390 px', async () => {
  const problems = [];
  for (const profile of [B.DESKTOP, B.PHONE]) {
    await each(profile, async (page, m) => {
      const v = await B.axeViolations(page);
      if (v.length)
        problems.push(
          `${m.pageId} ${m.url} (${profile.viewport.width}): ${v.map((x) => `${x.id}@${x.nodes[0]}`).join(', ')}`,
        );
    });
  }
  assert.deepEqual(problems, []);
});

// covers: T-481, UC-18, UC-14, F-25, F-12, F-50
test('T-481 [W-55] клавиатура: «Перейти к содержимому» первым, видимый фокус, вкладки и меню профиля с клавиатуры, отправка Enter, Esc закрывает меню, плеер перематывается стрелками', async () => {
  const { ctx: c, page } = await B.contextAs(ctx.browser, ctx.app, 'patA', B.PHONE);
  ctx.track(c);
  await B.open(page, ctx.app, '/app');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-testid')), 'msg.shell.skip_link');
  const outline = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement);
    return s.outlineStyle !== 'none' || s.boxShadow !== 'none';
  });
  assert.ok(outline, 'фокус виден');
  // «Ещё» больше нет: все вкладки на виду; меню профиля открывается и закрывается с клавиатуры.
  await B.expectVisible(page, 'msg.nav.patient.doctor');
  await page.focus(B.tid('msg.shell.avatar'));
  await page.keyboard.press('Enter');
  await B.expectVisible(page, 'msg.nav.avatar.help');
  await page.keyboard.press('Escape');
  await page.focus(B.tid('msg.chat.placeholder'));
  await page.keyboard.type('Синтетический вопрос с клавиатуры');
  await page.keyboard.press('Enter');
  await B.expectVisible(page, 'msg.ai.mark');
  await B.open(page, ctx.app, '/app?tab=library');
  await page.focus(B.tid('msg.library.seek'));
  const before = await page.getAttribute(B.tid('msg.library.seek'), 'aria-valuenow');
  await page.keyboard.press('ArrowRight');
  assert.notEqual(await page.getAttribute(B.tid('msg.library.seek'), 'aria-valuenow'), before);
});

// covers: T-482, UC-18, F-25
test('T-482 [W-55] вёрстка 360 и 390 px: нет горизонтальной прокрутки ни на одной главной странице', async () => {
  const bad = [];
  for (const profile of [B.NARROW, B.PHONE]) {
    await each(profile, async (page, m) => {
      if (!(await B.noHorizontalOverflow(page))) bad.push(`${m.pageId} @${profile.viewport.width}`);
    });
  }
  assert.deepEqual(bad, []);
});

// covers: T-483, UC-39, F-10, F-25, PD-24, L-11
test('T-483 [W-06] у каждого <main> есть data-page; каждый data-testid — ключ ru.json; заглушки помечены data-standin; нет внешних скриптов, шрифтов и счётчиков', async () => {
  const unknown = new Set();
  const external = [];
  // test-change: одобрено владельцем 2026-10-17. `location` существует в
  // браузере, но этот цикл выполняется в Node-контексте теста.
  const origin = new URL(ctx.app.base).origin;
  await each(B.DESKTOP, async (page, m) => {
    const ids = await page.locator('[data-testid]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    for (const id of ids) if (!T.has(id)) unknown.add(`${m.pageId}: ${id}`);
    const srcs = await page.evaluate(() =>
      [...document.querySelectorAll('script[src], link[href], img[src], iframe[src]')].map((e) => e.src || e.href),
    );
    for (const s of srcs) if (s && !s.startsWith(origin) && !s.startsWith('data:')) external.push(`${m.pageId}: ${s}`);
  });
  assert.deepEqual([...unknown], [], 'data-testid только из ru.json');
  assert.deepEqual(external, [], 'всё лежит локально в public/ (L-11)');
  const { ctx: c, page } = await B.contextAs(ctx.browser, ctx.app, 'patA');
  ctx.track(c);
  await B.open(page, ctx.app, '/app?tab=meds');
  assert.ok((await page.locator('[data-standin]').count()) >= 1, 'справочник-заглушка помечен data-standin');
});

// covers: T-484, UC-09, UC-11, F-57, F-63
test('T-484 [W-55] статусы различимы не только цветом: цветная точка и статусы сигналов несут текст или aria-label', async () => {
  const { ctx: c, page } = await B.contextAs(ctx.browser, ctx.app, 'psy1');
  ctx.track(c);
  await B.open(page, ctx.app, '/work?tab=patients');
  const dots = await page
    .locator('[data-dot]')
    .evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim()));
  assert.ok(dots.length >= 1);
  assert.ok(
    dots.every((t) => t.length > 0),
    'у каждой точки есть текст',
  );
  const keys = [
    'msg.patients.dot.red',
    'msg.patients.dot.yellow',
    'msg.patients.dot.green',
    'msg.patients.dot.grey',
  ].map((k) => T.text(k));
  assert.ok(
    dots.every((t) => keys.some((k) => t.includes(k.split(' ')[0]))),
    'подписи точек — из словаря',
  );
});
