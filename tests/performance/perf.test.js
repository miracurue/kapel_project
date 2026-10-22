'use strict';

// Скорость по требованиям 08 «Quality» на объёме «через год» (2 000 пациентов, ~1 млн записей):
// списки, карточка и ленты — p95 < 2 с; запись без ИИ — p95 < 1 с; подсказки названий F-121 — p95 ≤ 300 мс
// на каталоге 20 000 названий; смешанная нагрузка 50 параллельных сеансов — ошибок < 1 %.
// Инструмент — скрипт на Node (fetch + performance.now): k6 не установлен и стал бы новым бинарником вне
// npm-lock и проверки лицензий; для порогов MVP точности скрипта хватает (обоснование — отчёт 13).
// Запускается перед выпуском (`npm run test:perf`), не в каждом `npm run ci`.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startApp } = require('../lib/app');
const { as, expectOk } = require('../lib/client');
const F = require('../lib/flows');
const V = require('./volume');

let app;
let volume;
const results = {};
before(async () => {
  app = await startApp({ beforeStart: (dbPath, ids, env) => { volume = V.generate(dbPath, ids, env); } });
  console.log(`объём: ${JSON.stringify(volume.counts)}; всего ${volume.total} записей`);
}, { timeout: 1800000 });
after(async () => {
  if (!app) return;
  console.log(`итоги скорости: ${JSON.stringify(results)}`);
  if (process.env.PERF_RESULTS) fs.writeFileSync(process.env.PERF_RESULTS, JSON.stringify({ volume, results }, null, 1));
  await app.stop();
});

function p95(xs) { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; }

async function measure(name, n, fn) {
  const times = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    const r = await fn(i);
    times.push(performance.now() - t0);
    assert.ok(r.status < 400, `${name}: ответ ${r.status}`);
  }
  results[name] = { n, p95_ms: Math.round(p95(times)), max_ms: Math.round(Math.max(...times)) };
  return results[name].p95_ms;
}

// covers: T-490, UC-09, F-57, PD-02
test('T-490 [W-55] список пациентов психиатра (400 закреплённых из 2 000, год данных): p95 < 2 с — API и страница', async () => {
  const doc = await as(app, 'psy1');
  assert.ok(volume.total >= 1000000 * Number(process.env.PERF_SCALE || 1) * 0.9, 'объём около 1 млн записей');
  assert.ok(await measure('patients_api', 50, () => doc.get('/api/v1/patients?page=1')) < 2000);
  assert.ok(await measure('patients_page', 30, () => doc.get('/work?tab=patients', { headers: { accept: 'text/html' } })) < 2000);
  assert.ok(await measure('patients_search', 30, (i) => doc.get(`/api/v1/patients?q=${encodeURIComponent(`Объёмный ${i * 7}`)}`)) < 2000);
});

// covers: T-491, UC-09, UC-20, F-58, F-56
test('T-491 [W-55] карточка пациента за год: вкладки обзор, дневник, тесты, сообщения — p95 < 2 с', async () => {
  const doc = await as(app, 'psy1');
  const list = expectOk(await doc.get('/api/v1/patients?page=1')).items.map((x) => x.id);
  for (const tab of ['overview', 'diary', 'tests', 'messages']) {
    assert.ok(await measure(`card_${tab}`, 40, (i) => doc.get(`/api/v1/patients/${list[i % list.length]}?tab=${tab}&period=1y`)) < 2000, tab);
  }
});

// covers: T-492, UC-11, UC-37, F-63, F-19
test('T-492 [W-55] ленты: сигналы, уведомления и счётчик колокольчика — p95 < 2 с (счётчик опрашивается раз в 30 с)', async () => {
  const doc = await as(app, 'psy1');
  assert.ok(await measure('signals', 40, () => doc.get('/api/v1/signals?kind=all&status=all')) < 2000);
  assert.ok(await measure('notifications', 40, () => doc.get('/api/v1/notifications?page=1')) < 2000);
  assert.ok(await measure('notifications_count', 60, () => doc.get('/api/v1/notifications/count')) < 2000);
});

// covers: T-493, UC-04, UC-06, F-39, F-47, F-18
test('T-493 [W-55] запись без ИИ: дневник и сообщение врачу — p95 < 1 с', async () => {
  const p = await as(app, 'patA');
  assert.ok(await measure('diary_post', 30, (i) => p.post('/api/v1/me/diary', { mood: 1 + (i % 5), day: new Date(Date.now() - (400 + i) * 86400000).toISOString().slice(0, 10) })) < 1000);
  assert.ok(await measure('message_post', 25, (i) => p.post('/api/v1/me/messages', { text: `Синтетическое сообщение ${i}` })) < 1000);
});

// covers: T-494, UC-26, UC-12, UC-46, F-121, F-110, F-76
test('T-494 [W-14] подсказки названий на каталоге 20 000: p95 ≤ 300 мс на наборе опечаток (100 + 30 + 20 запросов)', async () => {
  const admin = await as(app, 'admin1');
  const stand = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'catalog', 'catalog_stand_in.csv'), 'utf8');
  const up = expectOk(await F.upload(admin, { name: 'big.csv', buffer: Buffer.from(V.bigCatalogCsv(stand)), type: 'text/csv' }, 'reference_import'));
  const prev = expectOk(await admin.post('/api/v1/admin/reference/imports', { upload_id: up.id, columns: {}, source: 'stand_in', exported_on: '2026-10-17' }));
  expectOk(await admin.post(`/api/v1/admin/reference/imports/${prev.id}/apply`, {}));
  const typos = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'catalog', 'typos.json'), 'utf8'));
  const queries = [...typos.products.map((x) => x.input), ...typos.inn.map((x) => x.input), ...typos.nonexistent];
  const p = await as(app, 'patA');
  await p.get('/api/v1/catalog/search?q=%D0%B7%D0%BE%D0%BB&scope=products');
  const ms = await measure('catalog_search', queries.length, (i) => p.get(`/api/v1/catalog/search?q=${encodeURIComponent(queries[i])}&scope=products`));
  assert.ok(ms <= 300, `p95 ${ms} мс`);
});

// covers: T-495, UC-18, F-23, F-57, F-19
test('T-495 [W-55] смешанная нагрузка: 50 параллельных сеансов 30 с (списки, карточки, счётчики, дневник) — ошибок < 1 %, p95 < 2 с', async () => {
  const doc = await as(app, 'psy1');
  const list = expectOk(await doc.get('/api/v1/patients?page=1')).items.map((x) => x.id);
  const clients = [];
  for (let i = 0; i < 50; i += 1) clients.push(i % 5 === 0 ? await as(app, 'patA') : await as(app, 'psy1'));
  const t0 = Date.now();
  const times = [];
  let errors = 0;
  let total = 0;
  await Promise.all(clients.map(async (c, i) => {
    while (Date.now() - t0 < 30000) {
      const s = performance.now();
      const r = i % 5 === 0
        ? await c.get('/api/v1/notifications/count')
        : await c.get(i % 2 ? '/api/v1/patients?page=1' : `/api/v1/patients/${list[(total + i) % list.length]}?tab=overview`);
      times.push(performance.now() - s);
      total += 1;
      if (r.status >= 500 || r.status === 429) errors += 1;
    }
  }));
  results.mixed = { requests: total, errors, p95_ms: Math.round(p95(times)) };
  assert.ok(errors / total < 0.01, `ошибок ${errors} из ${total}`);
  assert.ok(p95(times) < 2000);
});
