'use strict';

// Сквозные проверки контракта API по замороженному описанию этапа 12 (все 244 операции):
// вход обязателен, CSRF, роль без права, ключ повтора, тело ошибки, маршруты = описание, заголовки.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { useApp } = require('../lib/suite');
const { Client } = require('../lib/client');
const C = require('../lib/contract');
const T = require('../lib/texts');
const { ROOT } = require('../lib/paths');

const ctx = useApp();

// Пользователь мира для роли R- (без отметок КО, ИП и ПС — чтобы проверить отказ без отметки).
const ROLE_USER = { 'R-02': 'patA', 'R-03': 'psy2', 'R-04': 'plg2', 'R-05': 'admin1' };
const SKIP_TAGS = new Set(['demo']); // при DEMO_MODE=0 демо-маршрутов нет вовсе (отдельно в 20_demo)
const SKIP_PERMS = new Set(['session.pending_2fa']);

function checkEnvelope(op, res, failures) {
  if (res.status < 400) return;
  const e = res.body && res.body.error;
  if (!e) { failures.push(`${op.method} ${op.path}: ${res.status} без тела {"error":…}`); return; }
  if (!T.has(T.errKey(e.code))) failures.push(`${op.method} ${op.path}: код ${e.code} без ключа ${T.errKey(e.code)} в ru.json`);
  if (e.key !== T.errKey(e.code)) failures.push(`${op.method} ${op.path}: key ${e.key} ≠ ${T.errKey(e.code)}`);
  if (!e.request_id) failures.push(`${op.method} ${op.path}: нет request_id`);
  const allowed = op.errors[e.code];
  if (allowed && !allowed.includes(res.status)) failures.push(`${op.method} ${op.path}: ${e.code} пришёл с ${res.status}, по контракту ${allowed}`);
}

// covers: T-001, F-01, F-02, F-11, PD-02, PD-21, R-01
test('T-001 [W-05] без входа каждая закрытая операция API отвечает 401 E-SESSION-EXPIRED', async () => {
  const failures = [];
  const guest = ctx.guest();
  await guest.ensureCsrf();
  for (const op of C.api().filter((o) => !o.public && !SKIP_TAGS.has(o.tag))) {
    const res = await guest.raw(op.method, C.fillPath(op.path), C.isMutating(op) ? {} : undefined);
    if (res.status !== 401 || (res.body && res.body.error && res.body.error.code) !== 'E-SESSION-EXPIRED') {
      failures.push(`${op.method} ${op.path}: ${res.status} ${res.body && res.body.error && res.body.error.code}`);
    }
    checkEnvelope(op, res, failures);
  }
  assert.deepEqual(failures, [], `операции открыты без входа:\n${failures.join('\n')}`);
});

// covers: T-002, F-18, F-01, PD-02
test('T-002 [W-04] изменяющий запрос без X-CSRF-Token отклоняется 403 E-CSRF у каждой роли', async () => {
  const failures = [];
  for (const op of C.api().filter((o) => C.isMutating(o) && !SKIP_TAGS.has(o.tag))) {
    const allowed = C.allowedRoles(op);
    const roleKey = ['R-02', 'R-03', 'R-04', 'R-05'].find((r) => allowed.has(r));
    const client = op.public || !roleKey ? ctx.guest() : await ctx.as(ROLE_USER[roleKey] === 'psy2' ? 'psy1' : ROLE_USER[roleKey]);
    if (op.public) await client.ensureCsrf();
    const res = await client.raw(op.method, C.fillPath(op.path), {}, { csrf: false });
    if (res.status !== 403 || res.body?.error?.code !== 'E-CSRF') failures.push(`${op.method} ${op.path}: ${res.status} ${res.body?.error?.code}`);
    checkEnvelope(op, res, failures);
  }
  assert.deepEqual(failures, [], `запись без CSRF-токена принята:\n${failures.join('\n')}`);
});

// covers: T-003, F-11, PD-02, PD-20, R-02, R-03, R-04, R-05
test('T-003 [W-05] роль без права получает 403 E-ACCESS на каждой операции (матрица x-roles)', async () => {
  const failures = [];
  for (const op of C.api().filter((o) => !o.public && !SKIP_TAGS.has(o.tag) && !SKIP_PERMS.has(o.permission))) {
    const allowed = C.allowedRoles(op);
    for (const [R, key] of Object.entries(ROLE_USER)) {
      const scope = allowed.get(R);
      // разрешено без отметки — пропускаем; отметки КО/ИП/ПС у ROLE_USER нет, поэтому ждём отказ
      if (scope && !['КО', 'ИП'].includes(scope) && !(scope === 'ПС' && R === 'R-03')) continue;
      const client = await ctx.as(key);
      const res = await client.raw(op.method, C.fillPath(op.path), C.isMutating(op) ? {} : undefined);
      if (res.status !== 403 || res.body?.error?.code !== 'E-ACCESS') failures.push(`${R} ${op.method} ${op.path}: ${res.status} ${res.body?.error?.code}`);
      checkEnvelope(op, res, failures);
    }
  }
  assert.deepEqual(failures, [], `роль без права получила доступ или не тот ответ:\n${failures.join('\n')}`);
});

// covers: T-004, F-18, F-25
test('T-004 [W-09] запись без заголовка Idempotency-Key — 422 E-VALIDATION с полем Idempotency-Key', async () => {
  const failures = [];
  for (const op of C.api().filter((o) => o.idempotency === 'required' && !SKIP_TAGS.has(o.tag))) {
    const allowed = C.allowedRoles(op);
    const R = ['R-02', 'R-03', 'R-04', 'R-05'].find((r) => allowed.has(r) && !['КО', 'ИП'].includes(allowed.get(r)));
    if (!R) continue;
    const key = { 'R-02': 'patA', 'R-03': 'psy1', 'R-04': 'plg1', 'R-05': 'admin1' }[R];
    const client = await ctx.as(key);
    const res = await client.raw(op.method, C.fillPath(op.path), {}, { idem: false });
    const fields = (res.body?.error?.fields || []).map((f) => String(f.field).toLowerCase());
    if (res.status !== 422 || res.body?.error?.code !== 'E-VALIDATION' || !fields.includes('idempotency-key')) {
      failures.push(`${op.method} ${op.path}: ${res.status} ${res.body?.error?.code} ${fields}`);
    }
  }
  assert.deepEqual(failures, [], `запись без ключа повтора принята:\n${failures.join('\n')}`);
});

// covers: T-005, F-11, F-25, PD-02, PD-27
test('T-005 [W-05] каждый маршрут объявлен (fn, perm) и совпадает с описанием API; лишних маршрутов нет', async () => {
  // Контракт для W-05: src/access/index.js экспортирует routes() → [{ method, path (Express), fn:[], perm, patient }].
  const access = require(path.join(ROOT, 'src', 'access'));
  assert.equal(typeof access.routes, 'function', 'src/access экспортирует routes()');
  const declared = access.routes().filter((r) => r.path.startsWith('/api/'));
  const byKey = new Map(declared.map((r) => [`${r.method.toUpperCase()} ${C.fromExpress(r.path)}`, r]));
  const missing = [];
  const wrong = [];
  for (const op of C.api()) {
    const r = byKey.get(`${op.method} ${op.path}`);
    if (!r) { missing.push(`${op.method} ${op.path}`); continue; }
    if (r.perm !== op.permission) wrong.push(`${op.method} ${op.path}: perm ${r.perm} ≠ ${op.permission}`);
    for (const f of op.functions) if (!(r.fn || []).includes(f)) wrong.push(`${op.method} ${op.path}: нет ${f} в fn`);
    if ((r.patient && r.patient.purpose) !== (op.patientAccess || undefined) && op.patientAccess) wrong.push(`${op.method} ${op.path}: цель доступа ${r.patient && r.patient.purpose} ≠ ${op.patientAccess}`);
  }
  const extra = declared.filter((r) => !C.api().some((o) => o.method === r.method.toUpperCase() && o.path === C.fromExpress(r.path)))
    .map((r) => `${r.method} ${r.path}`);
  assert.deepEqual({ missing, wrong, extra }, { missing: [], wrong: [], extra: [] });
});

// covers: T-006, PD-21, PD-25, F-10
test('T-006 [W-04] заголовки безопасности и cookie сессии: CSP без внешних источников, nosniff, cc_sid HttpOnly SameSite=Lax', async () => {
  const c = new Client(ctx.app.base);
  const page = await c.get('/login', { headers: { accept: 'text/html' } });
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/, 'CSP без inline-скриптов');
  assert.doesNotMatch(csp, /https?:\/\/(?!127\.0\.0\.1)/, 'никаких внешних источников (L-11)');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(page.headers.get('referrer-policy'), 'Referrer-Policy задан');
  const login = await c.login('pat.a@cc.example.test');
  const sid = login.setCookie.find((s) => s.startsWith('cc_sid='));
  assert.ok(sid, 'cookie называется cc_sid');
  assert.match(sid, /HttpOnly/i);
  assert.match(sid, /SameSite=Lax/i);
  const app = await c.get('/app', { headers: { accept: 'text/html' } });
  assert.match(app.headers.get('cache-control') || '', /no-store/, 'закрытые страницы не кешируются');
});

// covers: T-007, F-115, F-75
test('T-007 [W-11] /healthz без входа и /readyz: база открыта, миграции применены, режим известен', async () => {
  const c = new Client(ctx.app.base);
  const h = await c.get('/healthz');
  assert.equal(h.status, 200);
  assert.equal(h.body.status, 'ok');
  const r = await c.get('/readyz');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ready');
  assert.ok(r.body.version, 'версия видна');
  assert.ok(!JSON.stringify(r.body).includes('ml-worker'), 'подробности частей — только администратору');
});

// covers: T-008, F-25, F-57, F-63, F-19, F-88
test('T-008 [W-17] списки отдают {items, page, page_size:50, total}, page с 1', async () => {
  const lists = [
    ['psy1', '/api/v1/patients?page=1'],
    ['psy1', '/api/v1/signals?page=1'],
    ['patA', '/api/v1/notifications?page=1'],
    ['admin1', '/api/v1/admin/people?page=1'],
    ['admin1', '/api/v1/admin/logs/access?page=1'],
  ];
  for (const [who, url] of lists) {
    const c = await ctx.as(who);
    const r = await c.get(url);
    assert.equal(r.status, 200, `${url}: ${r.status}`);
    assert.ok(Array.isArray(r.body.items), `${url}: items`);
    assert.equal(r.body.page, 1);
    assert.equal(r.body.page_size, 50);
    assert.equal(typeof r.body.total, 'number');
  }
});

// covers: T-009, F-25, UC-18
test('T-009 [W-06] неизвестный адрес API — 404 E-NOT-FOUND в общем теле, без технических подробностей', async () => {
  const c = await ctx.as('patA');
  const r = await c.get('/api/v1/no-such-endpoint');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'E-NOT-FOUND');
  assert.doesNotMatch(JSON.stringify(r.body), /at .*\.js:\d+|Error:|stack/i, 'без трассы стека');
  const p = await c.get('/no-such-page', { headers: { accept: 'text/html' } });
  assert.equal(p.status, 404);
  assert.match(p.body, /data-page="P-28"/);
  assert.doesNotMatch(p.body, /at .*\.js:\d+/);
});
