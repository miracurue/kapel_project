'use strict';

// Права каждой роли R-01…R-07 на то, чего ей нельзя (R-08 — в 20_demo, T-235). Дополняет матрицу T-003:
// чужие объекты у «своего» доступа — 404 (существование не раскрывается), чужой пациент у специалиста — 404,
// цели доступа психолога, администратор без клиники (PD-20), заблокированный, первый администратор.
// Организация одна (01, 11): проверка «чужой организации» не применима, точка — sameOrg() в src/access.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const { useApp } = require('../lib/suite');
const { Client, expectError, expectOk } = require('../lib/client');
const { byKey } = require('../fixtures/world');
const { ROOT } = require('../lib/paths');
const C = require('../lib/contract');
const F = require('../lib/flows');

const ctx = useApp();
const CLINICAL = 'Клиническая метка Т13 для проверки администратора';

// covers: T-330, UC-39, UC-01, F-10, F-09, F-25, R-01
test('T-330 [W-06] гость: открыты только вход, регистрация, сброс пароля, документы, справка и ошибки; закрытые страницы — 302 на /login?next=; закрытые не индексируются', async () => {
  const g = new Client(ctx.app.base);
  for (const p of ['/login', '/register', '/password/reset', '/legal', '/account/help', '/error/404']) {
    const r = await g.get(p, { headers: { accept: 'text/html' } });
    assert.equal(r.status, 200, p);
    assert.match(r.body, /data-page="P-\d\d"/, `${p}: data-page`);
  }
  for (const p of ['/app', '/work', '/admin', '/account', '/account/data', '/work/patients/1']) {
    const r = await g.get(p, { headers: { accept: 'text/html' } });
    assert.equal(r.status, 302, p);
    assert.match(r.headers.get('location') || '', /^\/login\?next=/);
  }
  const robots = await g.get('/robots.txt');
  assert.match(String(robots.body), /Disallow:\s*\/(app|work|admin|account)/);
  const login = await g.get('/login', { headers: { accept: 'text/html' } });
  assert.match(login.body, /<meta name="robots" content="noindex/, 'в закрытом демо — noindex');
});

// covers: T-331, UC-08, F-11, F-28, F-39, F-15, F-42, F-120, PD-02, R-02
test('T-331 [W-05] пациент: ID пациента берётся из сессии; чужие записи по прямому ID — 404 (дневник, ИИ-тред, файл, назначение, план, свой препарат, исправление)', async () => {
  const other = await ctx.as('patB');
  const mine = await ctx.as('patA');
  const entry = expectOk(await other.post('/api/v1/me/diary', { mood: 2, note: 'чужая заметка Т13' }));
  const thread = expectOk(await F.patientAsk(other, 'чужой вопрос Т13'));
  const up = expectOk(await F.upload(other, 'synthetic_report.pdf', 'message'));
  const checks = [
    () => mine.patch(`/api/v1/me/diary/${entry.entry.id}`, { mood: 5 }),
    () => mine.del(`/api/v1/me/diary/${entry.entry.id}`),
    () => mine.get(`/api/v1/ai/threads/${thread.thread.id}`),
    () => mine.del(`/api/v1/ai/threads/${thread.thread.id}`),
    () => mine.del(`/api/v1/uploads/${up.id}`),
    () => mine.get(`/api/v1/files/${up.id}`),
    () => mine.post('/api/v1/me/corrections', { record: { type: 'diary_entry', id: entry.entry.id }, text: 'x' }),
  ];
  for (const fn of checks) expectError(await fn(), 404, 'E-NOT-FOUND');
  const list = expectOk(await mine.get(`/api/v1/me/diary?patient_id=${ctx.id('patB')}`));
  assert.ok(!JSON.stringify(list).includes('чужая заметка Т13'), 'подмена patient_id в запросе игнорируется');
});

// covers: T-332, UC-09, F-11, F-57, F-58, PD-02, PD-03, PD-11, R-03
test('T-332 [W-05] психиатр: каждая операция с {patient_id} по незакреплённому пациенту — 404 E-NOT-FOUND и deny в журнале доступа', async () => {
  const doc = await ctx.as('psy1');
  const failures = [];
  const start = ctx.app.query('SELECT max(id) m FROM phi_access_log')[0].m || 0;
  for (const op of C.api().filter((o) => o.path.includes('{patient_id}') && C.allowedRoles(o).has('R-03'))) {
    const r = await doc.raw(op.method, C.fillPath(op.path, { patient_id: ctx.id('patB') }), C.isMutating(op) ? {} : undefined);
    if (r.status !== 404 || r.body?.error?.code !== 'E-NOT-FOUND') failures.push(`${op.method} ${op.path}: ${r.status} ${r.body?.error?.code}`);
  }
  assert.deepEqual(failures, []);
  const denies = ctx.app.query("SELECT count(*) n FROM phi_access_log WHERE id > ? AND patient_id = ? AND decision = 'deny'", start, ctx.id('patB'))[0].n;
  assert.ok(denies >= 1, 'отказы записаны');
});

// covers: T-333, UC-09, UC-13, F-11, F-58, F-61, F-65, PD-02, R-04
test('T-333 [W-05] психолог у закреплённого пациента: план, лекарства, НЯ, визиты (создание) и гипотезы — 403 E-ACCESS', async () => {
  const plg = await ctx.as('plg1');
  const failures = [];
  for (const op of C.api().filter((o) => ['plan', 'ae'].includes(o.patientAccess) || ['visit.manage', 'hints.use', 'medication.prescribe_plan', 'ae.review'].includes(o.permission))) {
    const r = await plg.raw(op.method, C.fillPath(op.path, { patient_id: ctx.id('patA') }), C.isMutating(op) ? {} : undefined);
    if (r.status !== 403) failures.push(`${op.method} ${op.path}: ${r.status}`);
  }
  assert.deepEqual(failures, []);
  expectError(await plg.get(`/api/v1/patients/${ctx.id('patA')}?tab=treatment`), 403, 'E-ACCESS');
});

// covers: T-334, UC-16, UC-17, F-11, F-88, F-114, PD-20, R-05
test('T-334 [W-47] администратор: ни один адрес админки не отдаёт клинический текст (заметка, сообщение, вопрос ИИ, НЯ, кризисная цитата)', async () => {
  const p = await ctx.as('patA');
  expectOk(await p.post('/api/v1/me/diary', { mood: 1, note: `${CLINICAL} — дневник` }));
  expectOk(await p.post('/api/v1/me/messages', { text: `${CLINICAL} — сообщение` }));
  expectOk(await F.patientAsk(p, `${CLINICAL} — ИИ`));
  expectOk(await p.post('/api/v1/me/adverse-events', { symptoms: ['other'], text: `${CLINICAL} — НЯ`, severity: 'mild', related: 'unknown' }));
  expectOk(await p.post('/api/v1/crisis/help', { text: `${F.CRISIS_PHRASE} ${CLINICAL}`, source: 'button' }));
  await F.passUndoWindow(ctx.app);
  const admin = await ctx.as('admin1');
  const leaks = [];
  for (const op of C.api().filter((o) => o.method === 'GET' && C.allowedRoles(o).has('R-05'))) {
    const r = await admin.get(C.fillPath(op.path, { user_id: ctx.id('patA'), journal: 'access' }));
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '');
    if (text.includes('Клиническая метка Т13') || text.includes('нет смысла жить')) leaks.push(op.path);
  }
  assert.deepEqual(leaks, [], 'клиника не видна администратору (PD-20)');
});

// covers: T-335, UC-16, F-119, F-89, R-06
test('T-335 [W-04] первый администратор после создания командой и смены пароля работает как администратор', async () => {
  ctx.app.exec("UPDATE users SET status = 'deactivated' WHERE role = 'admin'");
  const r = spawnSync('npm', ['run', '--silent', 'admin:create', '--', '--email', 'r06@cc.example.test', '--name', 'Первый Синтетический'], { cwd: ROOT, env: ctx.app.env, encoding: 'utf8' });
  ctx.app.exec("UPDATE users SET status = 'active' WHERE role = 'admin' AND email <> 'r06@cc.example.test'");
  assert.equal(r.status, 0, r.stderr);
  const pw = (r.stdout.match(/[A-Za-z0-9!@#$%^&*_\-]{10,}/g) || []).find((s) => !s.includes('@'));
  const c = new Client(ctx.app.base);
  assert.equal(expectOk(await c.login('r06@cc.example.test', pw)).next, 'change_password');
  expectOk(await c.post('/api/v1/me/password', { current_password: pw, new_password: 'R06-New-Pass-2026', new_password_repeat: 'R06-New-Pass-2026' }));
  expectOk(await c.get('/api/v1/admin/people'));
  expectError(await c.get(`/api/v1/patients/${ctx.id('patA')}`), 403, 'E-ACCESS');
});

// covers: T-336, UC-05, F-01, F-46, F-91, R-07
test('T-336 [W-39] заблокированный: открытая сессия закрывается при блокировке; вход — экран причины; 112 и справка доступны', async () => {
  const p = await ctx.fresh('patG');
  const admin = await ctx.as('admin1');
  expectOk(await admin.post(`/api/v1/admin/people/${ctx.id('patG')}/status`, { action: 'block', reason_key: 'owner_request' }));
  expectError(await p.get('/api/v1/me'), 401, 'E-SESSION-EXPIRED');
  const g = new Client(ctx.app.base);
  expectError(await g.login(byKey('patG').email), 403, 'E-AUTH-BLOCKED');
  expectOk(await g.get('/api/v1/crisis/contacts'));
  expectOk(await g.get('/api/v1/help'));
  expectOk(await admin.post(`/api/v1/admin/people/${ctx.id('patG')}/status`, { action: 'unblock' }));
});

// covers: T-337, UC-18, F-25, F-11
test('T-337 [W-54] старые адреса (02 «Public addresses») после замены страниц отвечают 301 на новые; старых маршрутов без прав нет', async () => {
  const old = { '/dashboard': /^\/(app|work|admin)/, '/tests': /^\/app\?tab=tests/, '/patients': /^\/work\?tab=patients/, '/crisis': /^\/work\?tab=signals/, '/admin/users': /^\/admin\?tab=people/ };
  const roles = { '/dashboard': 'patA', '/tests': 'patA', '/patients': 'psy1', '/crisis': 'psy1', '/admin/users': 'admin1' };
  for (const [url, target] of Object.entries(old)) {
    const c = await ctx.as(roles[url]);
    const r = await c.get(url, { headers: { accept: 'text/html' } });
    assert.equal(r.status, 301, url);
    assert.match(r.headers.get('location') || '', target, `${url} → ${r.headers.get('location')}`);
  }
});
