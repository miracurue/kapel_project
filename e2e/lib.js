'use strict';

// Общие средства e2e: временная сид-БД, сервер на случайном порту (CSRF включён),
// поиск Chromium, вход под ролью, axe, проверка переполнения, обход ссылок.
// Браузера нет -> findChromium() вернёт null, а запуск честно сообщит SKIP.

const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'demo-pass-123';
const ACC = {
  admin: 'admin@example.com',
  psy1: 'psychiatrist1@example.com',
  psy2: 'psychiatrist2@example.com',
  psy3: 'psychiatrist3@example.com',
  plg: 'psychologist1@example.com',
  plg2: 'psychologist2@example.com',
  p1: 'patient1.improving@example.com',
  p2: 'patient2.worsening@example.com',
  p3: 'patient3.crisis@example.com',
  p4: 'patient4.inactive@example.com',
  p5: 'patient5.mixed@example.com',
  p6: 'patient6.nodoctor@example.com',
  p7: 'patient7.revoked@example.com',
  p8: 'patient8.new@example.com',
  p9: 'patient9.draft@example.com',
  p10: 'patient10.private@example.com',
  p11: 'patient11.longtext@example.com',
};
// Роли для обходов (аккаунт сида для каждой роли меню).
const ROLE_ACCOUNTS = { patient: 'p2', psychiatrist: 'psy1', psychologist: 'plg', admin: 'admin' };
const DESKTOP = { viewport: { width: 1280, height: 800 } };
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const NARROW = { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

function findChromium() {
  const env = process.env.CHROMIUM_PATH;
  if (env) return fs.existsSync(env) ? env : null;
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  let dirs = [];
  try { dirs = fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)); } catch (_) { /* нет кэша */ }
  dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = path.join(cache, d, sub);
      if (fs.existsSync(p)) return p;
    }
  }
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (fs.existsSync(p)) return p;
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-'));
  const env = { ...process.env, TDR_DB_PATH: path.join(dir, 'e2e.sqlite3'), DB_PATH: path.join(dir, 'e2e.sqlite3'), DATA_DIR: dir, DATA_MODE: 'synthetic', DEMO_MODE: '1', NODE_ENV: 'development', TDR_UPLOAD_DIR: path.join(dir, 'uploads'), SESSION_SECRET: 'e2e-secret' };
  const mig = spawnSync(process.execPath, ['scripts/migrate.js'], { cwd: ROOT, env, encoding: 'utf8' });
  if (mig.status !== 0) throw new Error('migrate failed: ' + (mig.stderr || mig.stdout));
  const seed = spawnSync(process.execPath, ['scripts/seed-demo.js', '--reset'], { cwd: ROOT, env, encoding: 'utf8' });
  if (seed.status !== 0) throw new Error('seed failed: ' + (seed.stderr || seed.stdout));
  const port = await freePort();
  const child = spawn(process.execPath, ['src/app.js'], { cwd: ROOT, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/login'); if (r.ok) break; } catch (_) { /* ещё не слушает */ }
    if (child.exitCode !== null) throw new Error('server exited: ' + log);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base, dir, env, log: () => log,
    stop() { try { child.kill('SIGTERM'); } catch (_) { /* уже остановлен */ } fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

async function launch() {
  const { chromium } = require('playwright-core');
  const exe = findChromium();
  if (!exe) return null;
  return chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
}

async function login(browser, base, who, profile = DESKTOP) {
  const ctx = await browser.newContext({ ...profile, locale: 'ru-RU' });
  const page = await ctx.newPage();
  await page.goto(base + '/login');
  await page.fill('input[name=email]', ACC[who] || who);
  await page.fill('input[name=password]', PASSWORD);
  await Promise.all([page.waitForLoadState(), page.click('form[action="/login"] button[type=submit]')]);
  return { ctx, page };
}

const AXE_SRC = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

// Возвращает serious/critical нарушения (минимум полей).
async function axeViolations(page, impacts = ['serious', 'critical']) {
  await page.evaluate(AXE_SRC);
  const res = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { resultTypes: ['violations'] });
    return r.violations.map((v) => ({
      id: v.id, impact: v.impact, help: v.help, count: v.nodes.length,
      nodes: v.nodes.slice(0, 4).map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 160), summary: (n.failureSummary || '').split('\n').slice(1, 3).join(' ') })),
    }));
  });
  return res.filter((v) => impacts.includes(v.impact));
}

async function overflow(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const w = window.innerWidth;
    const bad = [];
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > w + 1) {
        let p = el.parentElement; let scroll = false;
        while (p && p !== document.body) {
          const o = getComputedStyle(p).overflowX;
          if (o === 'auto' || o === 'scroll' || o === 'hidden') { scroll = true; break; }
          p = p.parentElement;
        }
        if (!scroll && bad.length < 3) bad.push(el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : ''));
      }
    }
    return { scrollWidth: Math.max(de.scrollWidth, document.body.scrollWidth), innerWidth: w, bad };
  });
}

const SKIP_HREF = /^\/(logout|quick-exit)\b|\.(csv|json|pdf|docx|zip)(\?|$)|\/download|\/export\//;
function normalize(p) { return p.replace(/\/\d+/g, '/:id').replace(/^(\/tools\/(calculator|templates))\/[^/]+(\/edit)?$/, '$1/:slug$3').split('?')[0]; }

// Обход: ссылки на страницах (GET, тот же хост), не более perPattern страниц на шаблон маршрута.
async function crawl(page, base, { max = 90, perPattern = 2 } = {}) {
  const seen = new Set(); const counts = {}; const queue = ['/dashboard']; const out = [];
  while (queue.length && out.length < max) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const pat = normalize(url);
    if ((counts[pat] || 0) >= perPattern) continue;
    let resp;
    try { resp = await page.goto(base + url, { waitUntil: 'domcontentloaded' }); } catch (_) { continue; }
    if (!resp || resp.status() >= 400 || !(resp.headers()['content-type'] || '').includes('text/html')) continue;
    if (/\/login/.test(page.url()) && !/login/.test(url)) continue;
    counts[pat] = (counts[pat] || 0) + 1;
    out.push(url);
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
    for (const h of hrefs) {
      if (!h || !h.startsWith('/') || h.startsWith('//') || SKIP_HREF.test(h)) continue;
      const u = h.split('#')[0];
      if (u && !seen.has(u)) queue.push(u);
    }
  }
  return out;
}

// Список экранов роли (кэшируется на сервер): обход от /dashboard под аккаунтом роли.
const _screens = {};
async function screensFor(browser, base, role) {
  const key = base + role;
  if (!_screens[key]) {
    const { ctx, page } = await login(browser, base, ROLE_ACCOUNTS[role]);
    _screens[key] = await crawl(page, base);
    await ctx.close();
  }
  return _screens[key];
}

module.exports = { screensFor, ROOT, PASSWORD, ACC, ROLE_ACCOUNTS, DESKTOP, MOBILE, NARROW, findChromium, startServer, launch, login, axeViolations, overflow, crawl };
