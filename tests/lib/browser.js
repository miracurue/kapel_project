'use strict';

// Браузерные приёмочные тесты: Chromium через playwright-core (devDependencies, 12 «Разработка и проверки»),
// проверка доступности axe-core. Элементы ищутся по data-testid = ключ ru.json, страница — по data-page.
// Браузер: CHROMIUM_PATH или кеш ~/.cache/ms-playwright. Нет браузера — тест падает с понятной причиной.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { as } = require('./client');
const T = require('./texts');

const DESKTOP = { viewport: { width: 1280, height: 800 } };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const NARROW = { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

function findChromium() {
  if (process.env.CHROMIUM_PATH) return fs.existsSync(process.env.CHROMIUM_PATH) ? process.env.CHROMIUM_PATH : null;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  let dirs = [];
  try { dirs = fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)); } catch (_) { /* нет кеша */ }
  dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) { const p = path.join(cache, d, sub); if (fs.existsSync(p)) return p; }
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (fs.existsSync(p)) return p;
  return null;
}

async function launch() {
  const exe = findChromium();
  if (!exe) throw new Error('Chromium не найден: задайте CHROMIUM_PATH (12: e2e — локально и в CI с Chromium)');
  const { chromium } = require('playwright-core');
  return chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
}

// Контекст браузера, вошедший участником мира: сессия берётся из входа через API и кладётся в cookie.
async function contextAs(browser, app, key, profile = DESKTOP) {
  const ctx = await browser.newContext({ ...profile, locale: 'ru-RU', timezoneId: 'Europe/Moscow', permissions: ['microphone'] });
  if (key) {
    const c = await as(app, key);
    const url = new URL(app.base);
    await ctx.addCookies([...c.cookies.entries()].map(([name, value]) => ({ name, value, domain: url.hostname, path: '/', httpOnly: true, sameSite: 'Lax' })));
  }
  const page = await ctx.newPage();
  return { ctx, page };
}

const tid = (key, id) => {
  if (!T.has(key)) throw new Error(`data-testid «${key}» нет в ru.json: ключи не выдумываются (12)`);
  return id === undefined ? `[data-testid="${key}"]` : `[data-testid="${key}"][data-id="${id}"]`;
};

async function open(page, app, url) {
  const res = await page.goto(app.base + url, { waitUntil: 'domcontentloaded' });
  return res;
}

async function expectPage(page, pageId) {
  await page.waitForSelector(`main[data-page="${pageId}"]`, { timeout: 10000 });
}

async function expectVisible(page, key, id) {
  await page.waitForSelector(tid(key, id), { state: 'visible', timeout: 10000 });
}

async function expectHidden(page, key) {
  assert.equal(await page.locator(tid(key)).count(), 0, `элемента ${key} нет на экране`);
}

const AXE_SRC = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

// Нарушения WCAG 2.2 AA уровня serious/critical (08 Quality: axe — 0 серьёзных).
async function axeViolations(page) {
  await page.evaluate(AXE_SRC);
  const res = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  });
  return res.filter((v) => ['serious', 'critical'].includes(v.impact));
}

async function noHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

module.exports = { DESKTOP, PHONE, NARROW, launch, contextAs, tid, open, expectPage, expectVisible, expectHidden, axeViolations, noHorizontalOverflow };
