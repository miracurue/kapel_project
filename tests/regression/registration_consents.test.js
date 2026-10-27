'use strict';

// covers: AUDIT_CONSENT_ACCESS H4–H7 (Т-1, Т-4, Т-6, Т-7, P0-4, P0-5): регистрация одной формой, согласия с версией и
// хэшем опубликованного текста, привязка к врачу по коду, заявки специалистов, повторное согласие.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { Client, expectError, expectOk } = require('../lib/client');

const ctx = useApp({ env: { STAFF_TERMS_GATE: '1' } });
const PASS = 'Brand-New-Pass-1';

const guest = async () => {
  const g = new Client(ctx.app.base);
  await g.ensureCsrf();
  return g;
};
// После регистрации сессия новая: токен CSRF берём из ответа (как делает браузер, запрашивая его заново).
async function enroll(g, body) {
  const r = expectOk(await g.post('/api/v1/auth/register', body));
  g.csrf = r.csrf;
  return r;
}
const q = (sql, ...args) => ctx.app.query(sql, ...args);

async function invite(key = 'psy1') {
  const c = await ctx.as(key);
  return expectOk(await c.post('/api/v1/invites', {}));
}

test('регистрация без обязательной галочки — 403 E-CONSENT-REQUIRED, аккаунт не создан', async () => {
  const g = await guest();
  expectError(
    await g.post('/api/v1/auth/register', { email: 'nc1@cc.example.test', password: PASS, consents: ['ai'] }),
    403,
    'E-CONSENT-REQUIRED',
  );
  expectError(
    await g.post('/api/v1/auth/register', { email: 'nc1@cc.example.test', password: PASS }),
    403,
    'E-CONSENT-REQUIRED',
  );
  assert.equal(q('SELECT count(*) n FROM users WHERE email = ?', 'nc1@cc.example.test')[0].n, 0);
});

test('регистрация без кода: пациент без врача, журнал хранит версию и хэш опубликованного текста, сессия открыта', async () => {
  const g = await guest();
  const r = expectOk(
    await g.post('/api/v1/auth/register', {
      email: 'solo@cc.example.test',
      password: PASS,
      consents: ['base', 'research'],
    }),
  );
  assert.equal(r.next, 'app');
  const me = expectOk(await g.get('/api/v1/me'));
  assert.equal(me.user.role, 'patient');
  const id = q('SELECT id FROM users WHERE email = ?', 'solo@cc.example.test')[0].id;
  assert.equal(q('SELECT count(*) n FROM care_assignments WHERE patient_id = ?', id)[0].n, 0, 'без врача');
  const events = q(
    'SELECT e.consent_kind k, e.action, e.text_sha256, e.ip_hmac, v.body_sha256, v.status FROM consent_events e JOIN content_versions v ON v.id = e.content_version_id WHERE e.user_id = ? ORDER BY e.id',
    id,
  );
  assert.deepEqual(events.map((e) => e.k).sort(), ['agreement', 'base', 'research']);
  for (const e of events) {
    assert.equal(e.text_sha256, e.body_sha256, 'хэш в журнале = хэш показанного текста');
    assert.equal(e.status, 'published');
    assert.ok(e.ip_hmac, 'ip_hmac заполнен');
  }
  const ai = me.consents.find((c) => c.kind === 'ai');
  assert.notEqual(ai.state, 'given', 'не отмеченное согласие не дано');
  assert.equal(expectOk(await g.get('/api/v1/consents')).items.find((c) => c.kind === 'research').state, 'given');
});

test('тексты документов открываются без входа с версией и датой; API отдаёт опубликованный текст', async () => {
  const g = new Client(ctx.app.base);
  for (const p of [
    '/legal/consent/base',
    '/legal/consent/ai',
    '/legal/consent/research',
    '/legal/privacy',
    '/legal/agreement',
    '/legal/consent/staff_pd',
  ]) {
    const page = await g.get(p, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200, p);
    assert.match(page.body, /Версия \d+ от \d\d\.\d\d\.\d{4}/);
  }
  assert.doesNotMatch(
    (await g.get('/legal/consent/research', { headers: { accept: 'text/html' } })).body,
    /спонсор|фарм/i,
  );
  const doc = expectOk(await g.get('/api/v1/docs/consent.base'));
  assert.match(doc.sha256, /^[0-9a-f]{64}$/);
  expectError(await g.get('/api/v1/docs/users'), 404, 'E-NOT-FOUND');
  const reg = await g.get('/register', { headers: { accept: 'text/html' } });
  assert.equal(reg.status, 200);
  assert.doesNotMatch(reg.body, /<input[^>]*type="checkbox"[^>]*checked/i, 'галочки пустые');
  assert.doesNotMatch(reg.body, /<script(?![^>]*src=)/i, 'без inline-кода');
});

test('код врача: одноразовый, перебор ограничен, привязка позже через /me/care-link', async () => {
  const solo = await guest();
  await enroll(solo, { email: 'late@cc.example.test', password: PASS, consents: ['base'] });
  const inv = await invite('psy1');
  expectError(await solo.post('/api/v1/me/care-link', { invite_code: 'CC-NOPE' }), 422, 'E-INVITE-INVALID');
  expectOk(await solo.post('/api/v1/me/care-link', { invite_code: inv.code.toLowerCase() }));
  const id = q('SELECT id FROM users WHERE email = ?', 'late@cc.example.test')[0].id;
  assert.deepEqual(
    q('SELECT clinician_id FROM care_assignments WHERE patient_id = ? AND ended_at IS NULL', id).map(
      (x) => x.clinician_id,
    ),
    [ctx.id('psy1')],
  );
  expectError(await solo.post('/api/v1/me/care-link', { invite_code: (await invite()).code }), 409, 'E-CONFLICT');
  const other = await guest();
  await enroll(other, { email: 'late2@cc.example.test', password: PASS, consents: ['base'] });
  expectError(await other.post('/api/v1/me/care-link', { invite_code: inv.code }), 422, 'E-INVITE-INVALID');
  let last;
  for (let i = 0; i < 11; i += 1) last = await other.post('/api/v1/me/care-link', { invite_code: `CC-BAD${i}` });
  expectError(last, 429, 'E-RATE-LIMIT');
  assert.ok(
    q("SELECT 1 FROM action_log WHERE action = 'care.link.invite' AND target_id = ?", String(id)).length,
    'запись в журнале',
  );
  // регистрация с кодом закрепляет сразу
  const withCode = await guest();
  expectOk(
    await withCode.post('/api/v1/auth/register', {
      email: 'coded@cc.example.test',
      password: PASS,
      invite_code: (await invite('plg1')).code,
      consents: ['base'],
    }),
  );
  const cid = q('SELECT id FROM users WHERE email = ?', 'coded@cc.example.test')[0].id;
  assert.equal(q('SELECT count(*) n FROM care_assignments WHERE patient_id = ? AND ended_at IS NULL', cid)[0].n, 1);
  // не пациент и не вошедший
  expectError(await (await ctx.as('psy1')).post('/api/v1/me/care-link', { invite_code: 'x' }), 403, 'E-ACCESS');
  expectError(await (await guest()).post('/api/v1/me/care-link', { invite_code: 'x' }), 401, 'E-SESSION-EXPIRED');
});

const staffBody = (email, extra = {}) => ({
  full_name: 'Анна Заявкина',
  email,
  password: PASS,
  role: 'psychologist',
  specialty: 'clinical_psychologist',
  workplace: 'Тестовая клиника',
  consents: ['staff_pd', 'agreement'],
  ...extra,
});

test('заявка специалиста: без согласий отказ, ожидание без доступа, подтверждение админом, вход с ролью', async () => {
  const g = await guest();
  expectError(
    await g.post('/api/v1/auth/register-specialist', staffBody('s1@cc.example.test', { consents: ['staff_pd'] })),
    403,
    'E-CONSENT-REQUIRED',
  );
  expectError(
    await g.post('/api/v1/auth/register-specialist', staffBody('s1@cc.example.test', { role: 'admin' })),
    422,
    'E-VALIDATION',
  );
  const sent = expectOk(await g.post('/api/v1/auth/register-specialist', staffBody('s1@cc.example.test')), 201);
  assert.equal(sent.application.status, 'pending');
  expectError(
    await (await guest()).post('/api/v1/auth/register-specialist', staffBody('S1@cc.example.test')),
    409,
    'E-EMAIL-TAKEN',
  );
  assert.equal(
    q('SELECT count(*) n FROM users WHERE email = ?', 's1@cc.example.test')[0].n,
    0,
    'учётной записи нет до подтверждения',
  );
  // вход заявителя: ни сессии, ни доступа
  const pend = await guest();
  expectError(
    await pend.post('/api/v1/auth/login', { email: 's1@cc.example.test', password: PASS }),
    403,
    'E-AUTH-PENDING',
  );
  expectError(await pend.get('/api/v1/patients'), 401, 'E-SESSION-EXPIRED');
  const page = await pend.post('/login', { email: 's1@cc.example.test', password: PASS }, { csrf: false });
  assert.equal(page.status, 200);
  assert.match(page.body, /ожидайте подтверждения/);
  // очередь: только админ
  for (const key of ['patA', 'psy1', 'plg1'])
    expectError(await (await ctx.as(key)).get('/api/v1/admin/staff-applications'), 403, 'E-ACCESS');
  const admin = await ctx.as('admin1');
  const list = expectOk(await admin.get('/api/v1/admin/staff-applications'));
  const mine = list.items.find((x) => x.email === 's1@cc.example.test');
  assert.ok(mine && mine.workplace === 'Тестовая клиника' && !JSON.stringify(mine).includes('password'));
  expectError(await admin.post(`/api/v1/admin/staff-applications/${mine.id}/approve`, {}), 422, 'E-VALIDATION');
  expectOk(await admin.post(`/api/v1/admin/staff-applications/${mine.id}/approve`, { role: 'psychiatrist' }));
  expectError(
    await admin.post(`/api/v1/admin/staff-applications/${mine.id}/reject`, { reason: 'поздно' }),
    409,
    'E-CONFLICT',
  );
  const user = q("SELECT id, role FROM users WHERE email = 's1@cc.example.test'")[0];
  assert.equal(user.role, 'psychiatrist');
  const kinds = q('SELECT consent_kind k, text_sha256 FROM consent_events WHERE user_id = ?', user.id)
    .map((e) => e.k)
    .sort();
  assert.deepEqual(kinds, ['agreement', 'staff_pd']);
  assert.ok(q("SELECT 1 FROM action_log WHERE action = 'staff.application.approved'").length);
  const doc = new Client(ctx.app.base);
  await doc.ensureCsrf();
  const login = expectOk(await doc.post('/api/v1/auth/login', { email: 's1@cc.example.test', password: PASS }));
  assert.equal(login.next, 'work');
  // новый врач не видит чужих пациентов
  expectError(await doc.get(`/api/v1/patients/${ctx.id('patA')}`), 404, 'E-NOT-FOUND');
});

test('отклонение заявки: причина обязательна, видна заявителю, повторная подача возможна', async () => {
  const g = await guest();
  expectOk(await g.post('/api/v1/auth/register-specialist', staffBody('s2@cc.example.test')), 201);
  const admin = await ctx.as('admin1');
  const row = expectOk(await admin.get('/api/v1/admin/staff-applications')).items.find(
    (x) => x.email === 's2@cc.example.test',
  );
  expectError(
    await admin.post(`/api/v1/admin/staff-applications/${row.id}/reject`, { reason: ' ' }),
    422,
    'E-VALIDATION',
  );
  expectOk(
    await admin.post(`/api/v1/admin/staff-applications/${row.id}/reject`, { reason: 'Нет подтверждения квалификации' }),
  );
  const e = expectError(
    await (await guest()).post('/api/v1/auth/login', { email: 's2@cc.example.test', password: PASS }),
    403,
    'E-AUTH-PENDING',
  );
  assert.equal(e.details.reason, 'Нет подтверждения квалификации');
  expectOk(await (await guest()).post('/api/v1/auth/register-specialist', staffBody('s2@cc.example.test')), 201);
});

test('смена версии текста: обязательное блокирует кабинет, необязательное — один экран; подтверждение снимает', async () => {
  const p = await guest();
  await enroll(p, { email: 'renew@cc.example.test', password: PASS, consents: ['base', 'research'] });
  const admin = await ctx.as('admin1');
  expectOk(
    await admin.post('/api/v1/admin/content/docs/consent.research/versions', {
      markdown: '# Согласие\nНовая редакция исследований.',
      comment: 'тест',
    }),
  );
  const me = expectOk(await p.get('/api/v1/me'));
  assert.equal(me.onboarding_pending, true);
  const r = me.consents.find((c) => c.kind === 'research');
  assert.equal(r.stale, true);
  assert.equal(r.state, 'given', 'прежнее действует до решения');
  const redirect = await p.get('/app', { headers: { accept: 'text/html' } });
  assert.equal(redirect.status, 302);
  assert.match(redirect.headers.get('location'), /\/onboarding\/consent/);
  const screen = await p.get('/onboarding/consent', { headers: { accept: 'text/html' } });
  assert.match(screen.body, /data-page="P-06"/);
  assert.doesNotMatch(screen.body, /<input[^>]*type="checkbox"[^>]*checked/i);
  expectError(
    await p.post('/api/v1/consents/research', { action: 'give', version: r.version - 1, checkbox: true }),
    409,
    'E-CONFLICT',
  );
  expectOk(await p.post('/api/v1/consents/research', { action: 'give', version: r.version }));
  assert.equal(expectOk(await p.get('/api/v1/me')).onboarding_pending, false);
  // обязательное
  expectOk(
    await admin.post('/api/v1/admin/content/docs/consent.base/versions', {
      markdown: '# Основное\nНовая редакция.',
      comment: 'тест',
    }),
  );
  expectError(await p.post('/api/v1/me/diary', { mood: 3 }), 403, 'E-CONSENT-REQUIRED');
  expectOk(await p.get('/api/v1/me'));
  expectOk(await p.post('/api/v1/crisis/help', { text: 'мне плохо', source: 'button' }));
  const v = expectOk(await p.get('/api/v1/consents')).items.find((c) => c.kind === 'base').version;
  expectError(await p.post('/api/v1/consents/base', { action: 'give', version: v }), 403, 'E-CONSENT-REQUIRED');
  expectOk(await p.post('/api/v1/consents/base', { action: 'give', version: v, checkbox: true }));
  expectOk(await p.post('/api/v1/me/diary', { mood: 3 }));
});

test('существующие специалист и админ при входе принимают соглашение; без этого страницы ведут на экран принятия', async () => {
  const doc = await ctx.fresh('psy1');
  const page = await doc.get('/work', { headers: { accept: 'text/html' } });
  assert.equal(page.status, 302);
  assert.match(page.headers.get('location'), /^\/terms\/accept/);
  const screen = await doc.get('/terms/accept', { headers: { accept: 'text/html' } });
  assert.match(screen.body, /msg\.terms\.accept/);
  expectError(await doc.post('/api/v1/me/terms/accept', { checkbox: false }), 403, 'E-CONSENT-REQUIRED');
  expectError(await (await guest()).post('/api/v1/me/terms/accept', { checkbox: true }), 401, 'E-SESSION-EXPIRED');
  expectOk(await doc.post('/api/v1/me/terms/accept', { checkbox: true }));
  const after = await doc.get('/work', { headers: { accept: 'text/html' } });
  assert.equal(after.status, 200);
  const items = expectOk(await doc.get('/api/v1/me/terms')).items;
  assert.ok(items.every((i) => i.state === 'given' && !i.stale));
});

test('имя меняется через PATCH /me/profile: обрезка, границы, без HTML, значение не попадает в журнал', async () => {
  const p = await guest();
  await enroll(p, { email: 'name@cc.example.test', password: PASS, consents: ['base'] });
  expectError(await p.patch('/api/v1/me/profile', { display_name: '   ' }), 422, 'E-VALIDATION');
  expectError(await p.patch('/api/v1/me/profile', { display_name: '<b>x</b>' }), 422, 'E-VALIDATION');
  expectError(await p.patch('/api/v1/me/profile', { display_name: 'я'.repeat(81) }), 422, 'E-VALIDATION');
  expectOk(await p.patch('/api/v1/me/profile', { display_name: '  Мария   Т.  ' }));
  assert.equal(expectOk(await p.get('/api/v1/me')).user.display_name, 'Мария Т.');
  assert.ok(q("SELECT 1 FROM action_log WHERE action = 'profile.name_changed'").length);
});
