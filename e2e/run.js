#!/usr/bin/env node
'use strict';

// `npm run e2e` — браузерные сценарии (Playwright + axe) на сид-БД. Не входит в `npm test`.
// Для каждого файла e2e/*.e2e.js поднимается свой сервер на временной БД и случайном порту.
// Фильтр: `npm run e2e -- a11y layout`. Браузер: CHROMIUM_PATH или ~/.cache/ms-playwright.
// Нет браузера -> SKIP (код 0) с пояснением, а не FAIL.

const fs = require('fs');
const path = require('path');
const L = require('./lib');

(async () => {
  if (!L.findChromium()) {
    console.log('SKIP e2e: не найден Chromium. Укажите CHROMIUM_PATH=/путь/к/chrome или установите браузер (npx playwright-core install chromium).');
    process.exit(0);
  }
  const only = process.argv.slice(2);
  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.e2e.js')).sort()
    .filter((f) => !only.length || only.some((o) => f.includes(o)));
  let fails = 0; let total = 0;
  for (const f of files) {
    const mod = require(path.join(__dirname, f));
    console.log(`\n> ${f}`);
    const srv = await L.startServer();
    const browser = await L.launch();
    const t = {
      check(name, ok, detail) {
        total++;
        if (ok) console.log(`  ok   ${name}`);
        else { fails++; console.log(`  FAIL ${name}${detail ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); }
      },
      info(msg) { console.log('  ..   ' + msg); },
    };
    try {
      await mod.run({ srv, base: srv.base, browser, t, L });
    } catch (e) {
      fails++; total++;
      console.log(`  FAIL ${f} выбросил исключение :: ${e && e.stack || e}`);
    } finally {
      await browser.close().catch(() => {});
      srv.stop();
    }
  }
  console.log(`\ne2e: ${total - fails} ok, ${fails} FAIL`);
  if (!fails) console.log('Все e2e-проверки прошли успешно.');
  process.exit(fails ? 1 : 0);
})();
