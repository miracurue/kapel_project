'use strict';

// Запуск и режимы (F-24, PD-01, PD-28), журналы без ПДн — тест-«канарейка» (PD-17, F-75), планировщик (F-21),
// разделение идентификаторов (PD-04), секреты (PD-05), синтетика в тестах и сиде (PD-24), инцидент без
// отключения кризисного пути (PD-26), копии и восстановление (PD-23).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { useApp } = require('../lib/suite');
const { tryStart } = require('../lib/app');
const { Client, expectOk } = require('../lib/client');
const { ROOT } = require('../lib/paths');
const F = require('../lib/flows');

const ctx = useApp();
const CANARY = 'КАНАРЕЙКА-Т13-7f3a9c';

// covers: T-310, UC-40, UC-44, F-24, PD-01, PD-28, S-59, S-39
test('T-310 [W-57] сервер не стартует (E-CONFIG) при real без чек-листа, при real + DEMO_MODE=1, при real + FILE_SCANNER=none', async () => {
  const cases = [
    { DATA_MODE: 'real', DEMO_MODE: '0', FILE_SCANNER: 'clamd', CLAMD_HOST: '127.0.0.1', CLAMD_PORT: '3310', COOKIE_SECURE: '1' },
    { DATA_MODE: 'real', DEMO_MODE: '1', FILE_SCANNER: 'clamd', CLAMD_HOST: '127.0.0.1', CLAMD_PORT: '3310', COOKIE_SECURE: '1' },
    { DATA_MODE: 'real', DEMO_MODE: '0', FILE_SCANNER: 'none', COOKIE_SECURE: '1' },
  ];
  for (const env of cases) {
    const r = await tryStart({ env });
    if (r.started) { await r.app.stop(); assert.fail(`сервер запустился с небезопасной конфигурацией ${JSON.stringify(env)}`); }
    assert.notEqual(r.exitCode, 0);
    assert.match(r.log + r.error, /E-CONFIG/, 'в журнале запуска — E-CONFIG');
  }
});

// covers: T-311, F-24, F-10, PD-01, PD-24
test('T-311 [W-02] режим данных виден в /me и демо-строке и не меняется через API', async () => {
  const p = await ctx.as('patA');
  assert.equal(expectOk(await p.get('/api/v1/me')).data_mode, 'synthetic');
  const admin = await ctx.as('admin1');
  const r = await F.setSetting(admin, 'data_mode', 'real');
  assert.ok(r.status === 404 || r.status === 422, 'DATA_MODE нет среди настроек');
  assert.ok(!require('../lib/contract').api().some((o) => /data[-_]mode/.test(o.path) && o.method !== 'GET'), 'адреса для смены режима нет');
});

// covers: T-312, UC-19, F-75, F-22, F-26, PD-17, L-46
test('T-312 [W-11] «канарейка»: уникальная фраза во всех полях ввода не находится ни в одном журнале и таблице журналов', async () => {
  const p = await ctx.as('patA');
  const doc = await ctx.as('psy1');
  await new Client(ctx.app.base).login(`${CANARY}@cc.example.test`, `${CANARY}-pw`);
  expectOk(await p.post('/api/v1/me/diary', { mood: 3, note: `заметка ${CANARY}` }));
  expectOk(await p.post('/api/v1/me/messages', { text: `сообщение ${CANARY}` }));
  expectOk(await F.patientAsk(p, `вопрос ${CANARY}`));
  expectOk(await p.post('/api/v1/me/adverse-events', { symptoms: ['other'], text: `НЯ ${CANARY}`, severity: 'mild', related: 'unknown' }));
  await p.get(`/api/v1/catalog/search?q=${encodeURIComponent(CANARY)}&scope=products`);
  await p.get(`/api/v1/me/diary?period=${encodeURIComponent(CANARY)}`);
  expectOk(await doc.post('/api/v1/ai/clinician/messages', { patient_id: ctx.id('patA'), text: `врач ${CANARY}`, chips: [{ type: 'patient', id: ctx.id('patA') }] }));
  await ctx.app.waitJobs(5);
  assert.ok(!ctx.app.logs().includes(CANARY), 'нет в техническом журнале (stdout)');
  for (const t of ['phi_access_log', 'action_log', 'ai_audit', 'export_log', 'product_events', 'crisis_incident_log', 'login_attempts', 'idempotency_keys', 'job_marks', 'mail_queue']) {
    const rows = ctx.app.query(`SELECT * FROM ${t}`);
    assert.ok(!JSON.stringify(rows).includes(CANARY), `нет в таблице ${t}`);
  }
});

// covers: T-313, UC-19, F-75, PD-17
test('T-313 [W-11] продуктовые события: тип, роль, версия, псевдонимный ID сессии — без текста и ID пациента; сбой записи события действие не ломает', async () => {
  const p = await ctx.as('patB');
  expectOk(await p.post('/api/v1/me/diary', { mood: 4 }));
  const ev = ctx.app.query('SELECT * FROM product_events ORDER BY id DESC LIMIT 20');
  assert.ok(ev.length >= 1);
  assert.ok(!ev.some((e) => Object.values(e).includes(ctx.id('patB'))), 'без ID пациента');
  ctx.app.exec("CREATE TRIGGER t13_ev_fail BEFORE INSERT ON product_events BEGIN SELECT RAISE(ABORT, 'test'); END;");
  try { expectOk(await p.post('/api/v1/me/diary', { mood: 5 })); } finally { ctx.app.exec('DROP TRIGGER t13_ev_fail;'); }
});

// covers: T-314, F-21, F-41, M-18
test('T-314 [W-08] планировщик: отметка выполнения не даёт повторить задачу после перезапуска сервера', async () => {
  const before = ctx.app.query('SELECT count(*) n FROM job_marks')[0].n;
  await ctx.app.waitJobs(10);
  const notifications = ctx.app.query('SELECT count(*) n FROM notifications')[0].n;
  const r = await ctx.app.restart();
  assert.equal(r.exited, false);
  ctx.clients = {};
  await ctx.app.waitJobs(10);
  assert.equal(ctx.app.query('SELECT count(*) n FROM notifications')[0].n, notifications, 'после перезапуска уведомления не задвоились');
  assert.ok(ctx.app.query('SELECT count(*) n FROM job_marks')[0].n >= before);
});

// covers: T-315, F-11, F-74, PD-04, M-13
test('T-315 [W-03] идентификаторы отделены от клиники: ФИО и почта есть только в users; аналитика читает представления без идентификаторов', async () => {
  const tables = ctx.app.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((t) => t.name);
  const offenders = [];
  for (const t of tables.filter((x) => x !== 'users')) {
    const cols = ctx.app.query(`PRAGMA table_info(${t})`).map((c) => c.name);
    for (const c of cols) if (/^(email|full_name|contact_phone)$/.test(c)) offenders.push(`${t}.${c}`);
  }
  assert.deepEqual(offenders, [], 'клинические таблицы не содержат прямых идентификаторов');
  const views = ctx.app.query("SELECT name, sql FROM sqlite_master WHERE type = 'view'");
  for (const v of views.filter((x) => /analytic|agg|research/i.test(x.name))) assert.doesNotMatch(v.sql, /full_name|email/i, `${v.name} без идентификаторов`);
});

// covers: T-316, F-104, F-24, PD-05, PD-24
test('T-316 [W-01] секреты не в Git и не в базе: .env.example с пустыми значениями, в индексе Git нет .env и ключей; ключи окружения не встречаются в базе', async () => {
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  for (const line of example.split('\n').filter((l) => /^[A-Z_]+=/.test(l))) {
    const [k, v] = line.split('=');
    if (/KEY|SECRET|PASS|TOKEN|HASH/.test(k)) assert.equal((v || '').trim(), '', `${k} пустой в .env.example`);
  }
  const files = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n');
  assert.ok(!files.some((f) => /(^|\/)\.env$/.test(f)), '.env не в Git');
  assert.ok(!files.some((f) => /\.sqlite3$|secrets\.enc$/.test(f)), 'база и хранилище секретов не в Git');
  const dbBytes = fs.readFileSync(ctx.app.dbPath);
  for (const k of ['SESSION_SECRET', 'SECRETS_MASTER_KEY', 'PII_ENC_KEY', 'CLINICAL_ENC_KEY', 'LOG_HMAC_KEY']) {
    assert.ok(!dbBytes.includes(Buffer.from(ctx.app.env[k])), `${k} не лежит в базе`);
  }
});

// covers: T-317, UC-08, F-77, PD-23, PD-12
test('T-317 [W-57] учебное восстановление: копия зашифрована отдельным ключом, восстановление проходит и повторно применяет стирания после точки копии', async () => {
  const r = spawnSync('npm', ['run', '--silent', 'backup:drill'], { cwd: ROOT, env: ctx.app.env, encoding: 'utf8', timeout: 180000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const report = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(report.encrypted, true);
  assert.equal(report.restored, true);
  assert.equal(report.erasures_reapplied, true);
});

// covers: T-318, UC-05, F-46, F-91, F-117, F-02, PD-26, PD-16
test('T-318 [W-41] изоляция при инциденте (выйти везде, выключить ИИ, обслуживание) не отключает кризисный путь: 112 и «Мне нужна помощь» работают', async () => {
  const admin = await ctx.as('admin1');
  expectOk(await F.setSetting(admin, 'ai.enabled', { all: false }));
  expectOk(await admin.post(`/api/v1/admin/people/${ctx.id('patH')}/status`, { action: 'logout_all' }));
  const p = await ctx.fresh('patH');
  const r = expectOk(await p.post('/api/v1/crisis/help', { text: F.CRISIS_PHRASE, source: 'button' }));
  assert.equal(r.crisis.contacts[0].phone, '112');
  const chat = expectOk(await F.patientAsk(p, F.CRISIS_PHRASE));
  assert.ok(chat.crisis, 'кризисная проверка работает без ИИ');
  expectOk(await F.setSetting(admin, 'ai.enabled', { all: true }));
});

// covers: T-319, F-78, F-79, PD-24
test('T-319 [W-10] в тестовых данных и сиде только синтетика: почта служебных доменов, телефоны и документы — заглушки', async () => {
  const roots = [path.join(ROOT, 'tests', 'fixtures'), path.join(ROOT, 'scripts', 'seed-demo.js')];
  const realPhone = /(?:\+7|8)[\s(-]*9\d{2}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g;
  const problems = [];
  const scan = (file) => {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) {
      if (!/example\.(com|test|org)$|cc\.example\.test$|demo\.local$/i.test(m)) problems.push(`${path.basename(file)}: почта ${m}`);
    }
    for (const m of text.match(realPhone) || []) if (!/000|555/.test(m.replace(/\D/g, '').slice(4))) problems.push(`${path.basename(file)}: телефон ${m}`);
  };
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const st = fs.statSync(r);
    if (st.isFile()) scan(r);
    else for (const f of fs.readdirSync(r, { recursive: true })) { const full = path.join(r, f); if (fs.statSync(full).isFile() && /\.(js|json|csv|md|txt)$/.test(f)) scan(full); }
  }
  assert.deepEqual(problems, []);
});
