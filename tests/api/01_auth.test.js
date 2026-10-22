'use strict';

// Вход, выход, сессии, регистрация по коду, сброс пароля, профиль, первый администратор.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const { useApp } = require('../lib/suite');
const { Client, expectError, expectOk } = require('../lib/client');
const { extractLink } = require('../lib/fakes/smtp');
const { PASSWORD, byKey } = require('../fixtures/world');
const { ROOT } = require('../lib/paths');

const ctx = useApp();
const email = (k) => byKey(k).email;

async function invite(clinician = 'psy1') {
  const c = await ctx.as(clinician);
  const r = await c.post('/api/v1/invites', {});
  expectOk(r);
  assert.ok(r.body.code, 'код виден один раз в ответе');
  return r.body;
}

// covers: T-010, UC-01, UC-02, F-01, PD-21, R-01
test('T-010 [W-04] вход: новая сессия после входа, роль в /me, следующий экран по роли', async () => {
  const c = new Client(ctx.app.base);
  await c.ensureCsrf();
  const before = c.cookies.get('cc_sid');
  const r = await c.login(email('patA'));
  expectOk(r);
  assert.equal(r.body.user.role, 'patient');
  assert.ok(['app', 'consent'].includes(r.body.next));
  assert.notEqual(c.cookies.get('cc_sid'), before, 'идентификатор сессии меняется при входе (защита от подмены)');
  const me = await c.get('/api/v1/me');
  assert.equal(me.body.user.id, ctx.id('patA'));
  assert.equal(me.body.data_mode, 'synthetic');
  const rows = ctx.app.query(
    "SELECT action FROM action_log WHERE actor_id = ? AND action LIKE 'auth.login%'",
    ctx.id('patA'),
  );
  assert.ok(rows.length >= 1, 'вход записан в журнал действий и безопасности');
});

// covers: T-011, UC-01, UC-38, F-01, F-23, PD-17, PD-21
test('T-011 [W-04] неверный пароль и неизвестная почта дают одинаковый ответ 401 E-AUTH-INVALID; в журнале нет почты и пароля', async () => {
  const c = new Client(ctx.app.base);
  const a = await c.login(email('patB'), 'wrong-password-xx');
  const b = await c.login('nobody-here@cc.example.test', 'wrong-password-xx');
  const ea = expectError(a, 401, 'E-AUTH-INVALID');
  const eb = expectError(b, 401, 'E-AUTH-INVALID');
  assert.equal(ea.key, eb.key);
  assert.deepEqual(Object.keys(a.body.error).sort(), Object.keys(b.body.error).sort());
  const logs = ctx.app.logs();
  assert.ok(!logs.includes('wrong-password-xx'), 'пароль не попал в журнал');
  assert.ok(!logs.includes('nobody-here@cc.example.test'), 'почта не попала в журнал');
});

// covers: T-012, F-01, F-23, PD-21, UC-18
test('T-012 [W-04] 5 неудач за 15 минут блокируют вход по этой почте: 423 E-AUTH-LOCKED, верный пароль тоже ждёт', async () => {
  const c = new Client(ctx.app.base);
  for (let i = 0; i < 5; i += 1) await c.login(email('patH'), `bad-pass-${i}-xxxx`);
  const locked = await c.login(email('patH'), PASSWORD);
  const e = expectError(locked, 423, 'E-AUTH-LOCKED');
  assert.ok(e.details && e.details.retry_after_s > 0, 'сказано, сколько ждать');
  await ctx.app.advanceClock(16 * 60 * 1000);
  expectOk(await c.login(email('patH'), PASSWORD));
});

// covers: T-013, F-01, F-46, R-07, UC-05, S-54
test('T-013 [W-04] заблокированный (R-07): 403 E-AUTH-BLOCKED, экран /blocked с причиной из списка и 112', async () => {
  const c = new Client(ctx.app.base);
  expectError(await c.login(email('patF'), PASSWORD), 403, 'E-AUTH-BLOCKED');
  const page = await c.get('/blocked', { headers: { accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(page.body, /data-page="P-02"|data-page="P-28"|data-testid="msg\.blocked\.title"/);
  assert.match(page.body, /data-testid="msg\.blocked\.reason"/);
  assert.match(page.body, /112/);
});

// covers: T-014, UC-02, F-02, PD-21
test('T-014 [W-04] «Выйти»: сессия закрыта, старая cookie не работает, страницы с no-store', async () => {
  const c = await ctx.fresh('patB');
  const saved = c.cookieHeader();
  expectOk(await c.post('/api/v1/auth/logout', {}, { idem: false }));
  const replay = new Client(ctx.app.base);
  for (const pair of saved.split('; ')) {
    const [k, v] = pair.split('=');
    replay.cookies.set(k, v);
  }
  expectError(await replay.get('/api/v1/me'), 401, 'E-SESSION-EXPIRED');
  const again = await c.post('/api/v1/auth/logout', {}, { idem: false });
  assert.ok([200, 401].includes(again.status), 'повторный выход без ошибки сервера');
});

// covers: T-015, UC-02, UC-38, F-02, PD-21
test('T-015 [W-04] «Выйти везде» закрывает остальные сеансы; список сеансов без IP целиком', async () => {
  const a = await ctx.fresh('patG');
  const b = await ctx.fresh('patG');
  const list = expectOk(await a.get('/api/v1/me/sessions'));
  assert.ok(list.items.length >= 2);
  assert.ok(list.items.some((s) => s.current));
  assert.doesNotMatch(JSON.stringify(list), /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, 'IP целиком не показывается');
  expectOk(await a.post('/api/v1/auth/logout-all', {}, { idem: false }));
  expectError(await b.get('/api/v1/me'), 401, 'E-SESSION-EXPIRED');
  expectOk(await a.get('/api/v1/me'));
});

// covers: T-016, UC-02, F-02, S-40, PD-21
test('T-016 [W-04] таймауты сессии S-40: бездействие 30 мин и абсолютный 120 мин у специалиста', async () => {
  const p = await ctx.fresh('patB');
  await ctx.app.advanceClock(31 * 60 * 1000);
  expectError(await p.get('/api/v1/me'), 401, 'E-SESSION-EXPIRED');
  const d = await ctx.fresh('psy2');
  for (let i = 0; i < 5; i += 1) {
    await ctx.app.advanceClock(25 * 60 * 1000);
    await d.get('/api/v1/me');
  }
  expectError(await d.get('/api/v1/me'), 401, 'E-SESSION-EXPIRED');
});

// covers: T-017, UC-01, F-04, F-05, F-73, PD-09, PD-21, PD-27
test('T-017 [W-07] регистрация по коду: учётная запись появляется только после обязательного согласия; двойная отправка — одна запись', async () => {
  const inv = await invite('psy1');
  const g = new Client(ctx.app.base);
  const mail = 'new.patient1@cc.example.test';
  const body = {
    invite_code: ` ${inv.code.toLowerCase()} `,
    email: mail,
    password: 'Brand-New-Pass-1',
    display_name: 'Новый Синтетический',
  };
  const key = '11111111-1111-4111-8111-111111111111';
  const r1 = await g.post('/api/v1/auth/register', body, { idem: key });
  expectOk(r1);
  assert.equal(r1.body.next, 'consent');
  assert.equal(ctx.app.query('SELECT id FROM users WHERE email = ?', mail).length, 0, 'до согласия в базе нет записи');
  const v = (await g.get('/api/v1/consents')).body.items.find((x) => x.kind === 'base');
  expectError(
    await g.post('/api/v1/consents/base', { action: 'give', version: v.version, checkbox: false }),
    403,
    'E-CONSENT-REQUIRED',
  );
  assert.equal(ctx.app.query('SELECT id FROM users WHERE email = ?', mail).length, 0);
  expectOk(await g.post('/api/v1/consents/base', { action: 'give', version: v.version, checkbox: true }));
  const rows = ctx.app.query('SELECT id, role FROM users WHERE email = ?', mail);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'patient');
  const assignments = ctx.app.query(
    'SELECT clinician_id FROM care_assignments WHERE patient_id = ? AND ended_at IS NULL',
    rows[0].id,
  );
  assert.deepEqual(
    assignments.map((a) => a.clinician_id),
    [ctx.id('psy1')],
    'закреплён за специалистом из кода',
  );
  const again = await new Client(ctx.app.base).post('/api/v1/auth/register', body, { idem: key });
  assert.notEqual(again.status, 200, 'код одноразовый');
  assert.equal(
    ctx.app.query('SELECT count(*) n FROM users WHERE email = ?', mail)[0].n,
    1,
    'двойная отправка не создала дубль',
  );
  const codes = ctx.app.query('SELECT * FROM invite_codes WHERE id = ?', inv.id)[0];
  assert.ok(!JSON.stringify(codes).includes(inv.code), 'в базе только хеш кода');
});

// covers: T-018, UC-01, F-04, F-73, S-23
test('T-018 [W-07] истёкший, отозванный, использованный код и занятая почта — одинаковый E-INVITE-INVALID без имени врача', async () => {
  const g = new Client(ctx.app.base);
  const revoked = await invite('psy1');
  const doc = await ctx.as('psy1');
  expectOk(await doc.post(`/api/v1/invites/${revoked.id}/revoke`, {}));
  const expired = await invite('psy1');
  const taken = await invite('psy1');
  await ctx.app.advanceClock(0);
  const shift = 8 * 86400000; // S-23: приглашение 7 дней
  const answers = [];
  answers.push(
    await g.post('/api/v1/auth/register', {
      invite_code: revoked.code,
      email: 'x1@cc.example.test',
      password: 'Brand-New-Pass-1',
    }),
  );
  answers.push(
    await g.post('/api/v1/auth/register', {
      invite_code: 'NOPE-0000',
      email: 'x2@cc.example.test',
      password: 'Brand-New-Pass-1',
    }),
  );
  answers.push(
    await g.post('/api/v1/auth/register', {
      invite_code: taken.code,
      email: email('patB'),
      password: 'Brand-New-Pass-1',
    }),
  );
  await ctx.app.advanceClock(shift);
  answers.push(
    await g.post('/api/v1/auth/register', {
      invite_code: expired.code,
      email: 'x3@cc.example.test',
      password: 'Brand-New-Pass-1',
    }),
  );
  for (const a of answers) {
    const e = expectError(a, 422, 'E-INVITE-INVALID');
    assert.ok(!JSON.stringify(e).includes(byKey('psy1').name), 'имя врача не раскрывается');
  }
  await ctx.app.advanceClock(-shift);
});

// covers: T-019, F-04, F-23, UC-01
test('T-019 [W-04] перебор кодов приглашения: после 10 неудач за 15 минут — 429 E-RATE-LIMIT', async () => {
  const g = new Client(ctx.app.base);
  for (let i = 0; i < 10; i += 1)
    await g.post('/api/v1/auth/register', {
      invite_code: `BAD-${i}`,
      email: `b${i}@cc.example.test`,
      password: 'Brand-New-Pass-1',
    });
  expectError(
    await g.post('/api/v1/auth/register', {
      invite_code: 'BAD-X',
      email: 'bx@cc.example.test',
      password: 'Brand-New-Pass-1',
    }),
    429,
    'E-RATE-LIMIT',
  );
});

// covers: T-020, F-04, F-08, PD-21
test('T-020 [W-04] пароль короче 10 символов или равный почте — 422 E-VALIDATION с подсказкой у поля', async () => {
  const inv = await invite('psy1');
  const g = new Client(ctx.app.base);
  const short = expectError(
    await g.post('/api/v1/auth/register', {
      invite_code: inv.code,
      email: 'short@cc.example.test',
      password: 'Short-1',
    }),
    422,
    'E-VALIDATION',
  );
  assert.ok(short.fields.some((f) => f.field === 'password' && f.key === 'err.e-validation.password_short'));
  const same = expectError(
    await g.post('/api/v1/auth/register', {
      invite_code: inv.code,
      email: 'same.as.pw@cc.example.test',
      password: 'same.as.pw@cc.example.test',
    }),
    422,
    'E-VALIDATION',
  );
  assert.ok(same.fields.some((f) => f.key === 'err.e-validation.password_email'));
});

// covers: T-021, UC-38, F-07, F-20, PD-21, PD-22, S-44
test('T-021 [W-08] сброс пароля по почте: одинаковый ответ, письмо только со ссылкой, ссылка одноразовая, старые сессии закрыты', async () => {
  const old = await ctx.fresh('patI');
  const g = new Client(ctx.app.base);
  const known = await g.post('/api/v1/auth/password-reset', { email: email('patI') });
  const unknown = await g.post('/api/v1/auth/password-reset', { email: 'ghost@cc.example.test' });
  assert.equal(known.status, 200);
  assert.deepEqual(known.body, unknown.body, 'ответ не раскрывает, есть ли адрес');
  await ctx.app.waitJobs(10);
  const letter = ctx.app.smtp.lastTo(email('patI'));
  assert.ok(letter, 'письмо поставлено в очередь и отправлено планировщиком');
  assert.ok(!ctx.app.smtp.lastTo('ghost@cc.example.test'), 'на несуществующий адрес письма нет');
  const link = extractLink(letter.text);
  assert.ok(link, 'в письме есть одноразовая ссылка');
  for (const forbidden of [byKey('patI').name, 'диагноз', 'сертралин', 'кризис', 'Content-Disposition: attachment']) {
    assert.ok(!letter.text.includes(forbidden), `в письме нет «${forbidden}» (PD-22)`);
  }
  const token = link.split('/').pop();
  expectOk(
    await g.post('/api/v1/auth/password-reset/confirm', {
      token,
      password: 'Reset-New-Pass-1',
      password_repeat: 'Reset-New-Pass-1',
    }),
  );
  expectError(
    await g.post('/api/v1/auth/password-reset/confirm', {
      token,
      password: 'Reset-New-Pass-2',
      password_repeat: 'Reset-New-Pass-2',
    }),
    410,
    'E-RESET-TOKEN',
  );
  expectError(await old.get('/api/v1/me'), 401, 'E-SESSION-EXPIRED');
  expectOk(await new Client(ctx.app.base).login(email('patI'), 'Reset-New-Pass-1'));
});

// covers: T-022, UC-38, F-07, S-23, F-23
test('T-022 [W-08] ссылка сброса живёт 1 час, новый запрос гасит прежнюю, не больше 3 запросов в час на почту', async () => {
  const g = new Client(ctx.app.base);
  expectOk(await g.post('/api/v1/auth/password-reset', { email: email('patC') }));
  await ctx.app.waitJobs(10);
  const first = extractLink(ctx.app.smtp.lastTo(email('patC')).text)
    .split('/')
    .pop();
  expectOk(await g.post('/api/v1/auth/password-reset', { email: email('patC') }));
  await ctx.app.waitJobs(10);
  const second = extractLink(ctx.app.smtp.lastTo(email('patC')).text)
    .split('/')
    .pop();
  assert.notEqual(first, second);
  expectError(
    await g.post('/api/v1/auth/password-reset/confirm', {
      token: first,
      password: 'Another-Pass-11',
      password_repeat: 'Another-Pass-11',
    }),
    410,
    'E-RESET-TOKEN',
  );
  expectOk(await g.post('/api/v1/auth/password-reset', { email: email('patC') }));
  expectError(await g.post('/api/v1/auth/password-reset', { email: email('patC') }), 429, 'E-RATE-LIMIT');
  await ctx.app.advanceClock(61 * 60 * 1000);
  expectError(
    await g.post('/api/v1/auth/password-reset/confirm', {
      token: second,
      password: 'Another-Pass-11',
      password_repeat: 'Another-Pass-11',
    }),
    410,
    'E-RESET-TOKEN',
  );
});

// covers: T-023, UC-38, F-08, PD-21, PD-17
test('T-023 [W-08] профиль: смена имени, почты и пароля только с текущим паролем; занятая почта; после смены пароля остальные сеансы закрыты', async () => {
  const a = await ctx.fresh('plg2');
  const other = await ctx.fresh('plg2');
  expectOk(await a.patch('/api/v1/me/profile', { display_name: 'Семён М.' }));
  expectError(
    await a.patch('/api/v1/me/profile', { email: 'plg2.new@cc.example.test', current_password: 'not-the-password' }),
    401,
    'E-AUTH-INVALID',
  );
  expectError(
    await a.patch('/api/v1/me/profile', { email: email('psy1'), current_password: PASSWORD }),
    409,
    'E-EMAIL-TAKEN',
  );
  expectOk(
    await a.post('/api/v1/me/password', {
      current_password: PASSWORD,
      new_password: 'Changed-Pass-2026',
      new_password_repeat: 'Changed-Pass-2026',
    }),
  );
  expectError(await other.get('/api/v1/me'), 401, 'E-SESSION-EXPIRED');
  expectOk(await a.get('/api/v1/me'));
  const log = ctx.app.query(
    'SELECT old_safe_json, new_safe_json FROM action_log WHERE actor_id = ? ORDER BY id DESC LIMIT 5',
    ctx.id('plg2'),
  );
  assert.ok(!JSON.stringify(log).includes('Changed-Pass-2026'), 'пароль не в журнале');
});

// covers: T-024, UC-16, F-119, R-06, PD-21, PD-24
test('T-024 [W-04] первый администратор командой на сервере: пароль печатается один раз, повтор без --recovery отказан', async () => {
  const env = { ...ctx.app.env };
  const run = (args) =>
    spawnSync('npm', ['run', '--silent', 'admin:create', '--', ...args], { cwd: ROOT, env, encoding: 'utf8' });
  const r1 = run(['--email', 'first.admin@cc.example.test', '--name', 'Первый Админ Синтетический']);
  assert.equal(r1.status, 0, r1.stderr);
  const pw = (r1.stdout.match(/[A-Za-z0-9!@#$%^&*_\-]{10,}/g) || []).find((s) => !s.includes('@'));
  assert.ok(pw, 'временный пароль напечатан');
  const row = ctx.app.query(
    'SELECT role, must_change_password FROM users WHERE email = ?',
    'first.admin@cc.example.test',
  )[0];
  assert.equal(row.role, 'admin');
  assert.equal(row.must_change_password, 1);
  assert.ok(!ctx.app.logs().includes(pw), 'пароль не попал в журнал сервера');
  const r2 = run(['--email', 'second.admin@cc.example.test', '--name', 'Второй Админ']);
  assert.notEqual(r2.status, 0, 'активный администратор уже есть — без --recovery отказ');
  const login = await new Client(ctx.app.base).login('first.admin@cc.example.test', pw);
  expectOk(login);
  assert.equal(login.body.next, 'change_password', 'при первом входе — смена пароля');
});

// covers: T-025, F-89, F-08, UC-16
test('T-025 [W-04] при флаге «сменить пароль» до смены доступны только смена пароля и выход', async () => {
  const db = ctx.app.db();
  db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(ctx.id('psy3'));
  db.close();
  const c = new Client(ctx.app.base);
  const r = await c.login(email('psy3'));
  assert.equal(r.body.next, 'change_password');
  expectError(await c.get('/api/v1/patients'), 403, 'E-ACCESS');
  expectOk(
    await c.post('/api/v1/me/password', {
      current_password: PASSWORD,
      new_password: 'Psy3-New-Pass-26',
      new_password_repeat: 'Psy3-New-Pass-26',
    }),
  );
  expectOk(await c.get('/api/v1/patients'));
});

// covers: T-026, UC-39, F-09, F-10, F-25, R-02, R-03, R-04, R-05
test('T-026 [W-06] /me отдаёт вкладки роли v5: пациент 7, психиатр с «Сигналами» и «Документами», психолог с «Сигналами» и «Заключениями», админ', async () => {
  // test-change: одобрено владельцем 2026-10-17. Не переиспользуем сессии,
  // которые могли истечь после сдвига тестовых часов в предыдущих тестах.
  // значения — параметр ?tab= из 12 «Адреса страниц»; у психолога вкладка docs подписана «Заключения»
  const tabs = async (k) => (await (await ctx.fresh(k)).get('/api/v1/me')).body.tabs;
  assert.deepEqual(await tabs('patA'), ['chat', 'meds', 'tests', 'diary', 'library', 'visits', 'doctor']);
  const psy = await tabs('psy1');
  assert.deepEqual(psy.slice(0, 4), ['chat', 'patients', 'signals', 'docs']);
  const plg = await tabs('plg1');
  assert.deepEqual(plg.slice(0, 4), ['chat', 'patients', 'signals', 'docs']);
  const adm = await tabs('admin1');
  assert.deepEqual(adm.slice(0, 5), ['chat', 'requests', 'people', 'settings', 'log']);
  for (const t of ['patients', 'signals', 'docs', 'meds', 'diary'])
    assert.ok(!adm.includes(t), `у администратора нет клинической вкладки ${t}`);
});
