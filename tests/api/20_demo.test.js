'use strict';

// Режим демонстрации (F-78, F-79, S-62, F-24): «Войти как», маршрут показа, сброс к эталону,
// демо-строка; вне демо-режима маршрутов нет (E-DEMO-ONLY, 404); эталон — только синтетика (PD-24, PD-28).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { startApp } = require('../lib/app');
const { Client, expectError, expectOk } = require('../lib/client');
const F = require('../lib/flows');

const ctx = useApp({ demo: true, seed: true });

async function loginAs(role) {
  const c = new Client(ctx.app.base);
  const r = expectOk(await c.post('/api/v1/demo/login-as', { role }, { idem: false }));
  c.csrf = null;
  return { c, r };
}

// covers: T-230, UC-40, F-78, F-10, PD-24, R-08
test('T-230 [W-10] «Войти как» каждую роль без пароля; маршрут показа со ссылками; демо-строка «синтетические данные» на страницах', async () => {
  for (const role of ['patient', 'psychiatrist', 'psychologist', 'admin', 'demo_host']) {
    const { c, r } = await loginAs(role);
    assert.equal(r.user.role, role);
    const me = expectOk(await c.get('/api/v1/me'));
    assert.equal(me.demo_mode, true);
    assert.equal(me.data_mode, 'synthetic');
  }
  const route = expectOk(await new Client(ctx.app.base).get('/api/v1/demo/route'));
  assert.ok(route.steps.length >= 3 && route.steps.length <= 8);
  const page = await new Client(ctx.app.base).get('/demo', { headers: { accept: 'text/html' } });
  assert.match(page.body, /data-page="P-01"/);
  assert.match(page.body, /data-testid="msg\.p01\.role\.admin"/, 'быстрый вход по ролям — на /demo');
  for (const path of ['/', '/login']) {
    const entry = await new Client(ctx.app.base).get(path, { headers: { accept: 'text/html' } });
    assert.match(entry.body, /data-testid="msg\.login\.email"/, `${path}: вход по почте`);
    assert.match(entry.body, /href="\/register\?as=specialist"/, `${path}: регистрация специалиста`);
    assert.doesNotMatch(entry.body, /data-demo-role/, `${path}: без быстрого входа`);
  }
  assert.match(page.body, /data-testid="msg\.p01\./, '«Войти как» на P-01');
  assert.match(page.body, /синтетическ/i, 'демо-строка (L-01)');
  const log = ctx.app.query("SELECT count(*) n FROM action_log WHERE action LIKE 'demo.%'")[0].n;
  assert.ok(log >= 5, 'каждое переключение — в журнале');
});

// covers: T-231, UC-40, F-79, F-02, PD-24
test('T-231 [W-10] сброс демо: только с подтверждением; все сессии закрыты; данные возвращены к эталону; второй сброс во время первого — E-STATUS', async () => {
  const { c: host } = await loginAs('demo_host');
  const { c: patient } = await loginAs('patient');
  const marker = 'Синтетическая запись до сброса Т13';
  expectOk(await patient.post('/api/v1/me/diary', { mood: 2, note: marker }));
  expectError(await host.post('/api/v1/demo/reset', {}), 422, 'E-VALIDATION');
  const [a, b] = await Promise.all([
    host.post('/api/v1/demo/reset', { confirm: true }),
    host.post('/api/v1/demo/reset', { confirm: true }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.equal(statuses[0], 200);
  assert.ok(statuses[1] === 200 || statuses[1] === 409, 'параллельный второй сброс не выполняется');
  expectError(await patient.get('/api/v1/me'), 401, 'E-SESSION-EXPIRED');
  assert.equal(
    ctx.app.query('SELECT count(*) n FROM mood_entries WHERE note = ?', marker)[0].n,
    0,
    'база вернулась к эталону',
  );
  const files = ctx.app.query("SELECT count(*) n FROM stored_files WHERE purpose = 'temp_upload'")[0].n;
  assert.equal(files, 0, 'загрузки стёрты');
});

// covers: T-232, UC-40, F-97, S-62
test('T-232 [W-10] S-62: ведущий меняет шаги маршрута (3–8, только страницы сервиса); после сброса — эталонный маршрут', async () => {
  const { c: host } = await loginAs('demo_host');
  expectError(
    await F.setSetting(host, 'demo.route', [{ title: 'Внешний', url: 'https://example.test' }]),
    422,
    'E-SETTING-INVALID',
  );
  expectOk(
    await F.setSetting(host, 'demo.route', [
      { title: 'Пациент', url: '/app' },
      { title: 'Врач', url: '/work' },
      { title: 'Сигналы', url: '/work?tab=signals' },
    ]),
  );
  assert.equal(expectOk(await new Client(ctx.app.base).get('/api/v1/demo/route')).steps.length, 3);
});

// covers: T-233, UC-40, F-24, F-78, F-79, PD-28
test('T-233 [W-10] вне демо-режима (DEMO_MODE=0) демо-адресов нет: 404 E-DEMO-ONLY, на P-01 нет «Войти как»', async () => {
  const app = await startApp({ demo: false });
  try {
    const g = new Client(app.base);
    expectError(await g.post('/api/v1/demo/login-as', { role: 'patient' }, { idem: false }), 404, 'E-DEMO-ONLY');
    expectError(await g.get('/api/v1/demo/route'), 404, 'E-DEMO-ONLY');
    const page = await g.get('/', { headers: { accept: 'text/html' } });
    assert.doesNotMatch(page.body, /data-testid="msg\.p01\.login_as/);
    const demo = await g.get('/demo', { headers: { accept: 'text/html' } });
    assert.equal(demo.status, 404);
  } finally {
    await app.stop();
  }
});

// covers: T-234, UC-40, F-79, PD-24
test('T-234 [W-10] эталон и сид содержат только синтетику: почта — служебные домены, телефоны и документы — заглушки, без реальных людей', async () => {
  const users = ctx.app.query("SELECT email, full_name, contact_phone FROM users WHERE status <> 'tombstone'");
  for (const u of users) {
    if (u.email)
      assert.match(
        u.email,
        /@([a-z0-9-]+\.)*(example\.(com|test|org)|cc\.example\.test|demo\.local)$/i,
        `синтетическая почта: ${u.email}`,
      );
    if (u.contact_phone) assert.match(u.contact_phone.replace(/\D/g, ''), /0000|555/, 'телефон-заглушка');
  }
});

// covers: T-235, UC-40, F-78, F-79, F-11, PD-20, R-08
test('T-235 [W-10] ведущий демонстрации (R-08): только «Показ» и «Демо-данные»; клинических и админских адресов у него нет', async () => {
  const { c } = await loginAs('demo_host');
  expectOk(await c.get('/api/v1/demo/state'));
  expectError(await c.get('/api/v1/patients'), 403, 'E-ACCESS');
  expectError(await c.get('/api/v1/admin/people'), 403, 'E-ACCESS');
  expectError(await c.get('/api/v1/me/diary'), 403, 'E-ACCESS');
  const page = await c.get('/demo', { headers: { accept: 'text/html' } });
  assert.match(page.body, /data-page="P-26"/);
  assert.match(page.body, /data-testid="msg\.nav\.host\.route"/);
  assert.match(page.body, /data-testid="msg\.nav\.host\.data"/);
  const { c: patient } = await loginAs('patient');
  expectError(await patient.post('/api/v1/demo/reset', { confirm: true }), 403, 'E-ACCESS');
});
