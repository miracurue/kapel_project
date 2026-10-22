'use strict';

// Запуск приложения для тестов этапа 13: временная папка данных, миграции (W-03), тестовый мир,
// подделки внешних сервисов, процесс `node src/server.js` (W-02) на случайном порту.
// Пока кода нет, запуск падает с понятной причиной — так и должно быть: тесты написаны до кода.
//
// Тестовые хуки, которые приложение поддерживает только при NODE_ENV=test (Handoff отчёта 13):
//   CC_CLOCK_FILE        — сдвиг «текущего времени» сервера: файл {"offset_ms": N} читается при каждом now();
//   SCHEDULER_TICK_MS    — период планировщика F-21 (по умолчанию 60000, в тестах 200);
//   AI_STUB_CAPTURE/SCRIPT — запись и сценарий заглушки ИИ (tests/lib/fakes/ai_stub.js);
//   GIGACHAT_OAUTH_URL/GIGACHAT_API_URL — адреса подделки GigaChat (только тест адаптера).

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { ROOT, SERVER_ENTRY, MIGRATE } = require('./paths');
const { loadWorld } = require('../fixtures/world');
const { startFakeSmtp } = require('./fakes/smtp');
const { startFakeMlWorker } = require('./fakes/ml_worker');
const { AiStub } = require('./fakes/ai_stub');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

const key32 = () => crypto.randomBytes(32).toString('base64');

// opts: { env: {...}, demo: bool, seed: bool, dataMode: 'synthetic'|'real', world: false, beforeStart(dbPath, ids) }
async function startApp(opts = {}) {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error('нет src/server.js — точки запуска из 12 (W-02); тест ожидаемо красный до разработки');
  }
  if (!fs.existsSync(MIGRATE)) {
    throw new Error('нет scripts/migrate.js — запускателя миграций из 12 (W-03); тест ожидаемо красный до разработки');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-t13-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(dataDir, 'tdr.sqlite3');
  const clockFile = path.join(dir, 'clock.json');
  fs.writeFileSync(clockFile, JSON.stringify({ offset_ms: 0 }));
  const smtp = await startFakeSmtp();
  const mlToken = crypto.randomBytes(16).toString('hex');
  const ml = await startFakeMlWorker({ token: mlToken });
  const ai = new AiStub(dir);
  const port = await freePort();

  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'test',
    PORT: String(port),
    DATA_MODE: opts.dataMode || 'synthetic',
    DEMO_MODE: opts.demo ? '1' : '0',
    DB_PATH: dbPath,
    DATA_DIR: dataDir,
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    SESSION_SECRET: key32(),
    SECRETS_MASTER_KEY: key32(),
    PII_ENC_KEY: key32(),
    PII_HMAC_KEY: key32(),
    CLINICAL_ENC_KEY: key32(),
    TOTP_ENC_KEY: key32(),
    LOG_HMAC_KEY: key32(),
    RESEARCH_HMAC_KEY: key32(),
    SMTP_HOST: smtp.host,
    SMTP_PORT: String(smtp.port),
    SMTP_SECURE: '0',
    MAIL_FROM: 'noreply@cc.example.test',
    ML_WORKER_URL: ml.url,
    ML_WORKER_TOKEN: mlToken,
    FILE_SCANNER: 'none',
    LOG_LEVEL: 'info',
    CC_CLOCK_FILE: clockFile,
    SCHEDULER_TICK_MS: '200',
    ...ai.env(),
    ...(opts.env || {}),
  };

  const logFile = path.join(dir, 'server.log');
  const base = `http://127.0.0.1:${port}`;
  let ids = {};
  let child = null;
  try {
    const mig = spawnSync(process.execPath, [MIGRATE], { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
    if (mig.status !== 0) throw new Error(`миграции не прошли: ${mig.stderr || mig.stdout}`);
    if (opts.seed) {
      // демо-сид W-10 (эталон для сброса F-79); мир теста добавляется поверх
      const seed = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-demo.js')], { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
      if (seed.status !== 0) throw new Error(`демо-сид не прошёл: ${seed.stderr || seed.stdout}`);
    }
    if (opts.world !== false) ids = loadWorld(dbPath, env, { extra: opts.extraPeople || [] });
    if (opts.world !== false) require('../fixtures/synthetic_instruments').installSyntheticInstruments(dbPath);
    if (opts.beforeStart) await opts.beforeStart(dbPath, ids, env);
    const out = fs.openSync(logFile, 'a');
    child = spawn(process.execPath, [SERVER_ENTRY], { cwd: ROOT, env, stdio: ['ignore', out, out] });
    const started = Date.now();
    for (;;) {
      if (child.exitCode !== null) {
        const err = new Error(`сервер завершился при запуске (код ${child.exitCode}): ${fs.readFileSync(logFile, 'utf8').slice(-2000)}`);
        err.exitCode = child.exitCode;
        err.log = fs.readFileSync(logFile, 'utf8');
        throw err;
      }
      try {
        const r = await fetch(`${base}/healthz`);
        if (r.ok) break;
      } catch (_) { /* ещё не слушает */ }
      if (Date.now() - started > 20000) { child.kill('SIGKILL'); throw new Error('сервер не ответил на /healthz за 20 с'); }
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch (e) {
    await smtp.close();
    await ml.close();
    if (!process.env.KEEP_TEST_DATA) fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }

  const app = {
    base, dir, dataDir, dbPath, env, ids, smtp, ml, ai, child,
    logs: () => fs.readFileSync(logFile, 'utf8'),
    // Отдельное соединение теста к базе (WAL): проверки «что записалось» и подготовка редких состояний.
    db() {
      const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
      return new Database(dbPath);
    },
    query(sql, ...args) { const d = app.db(); try { return d.prepare(sql).all(...args); } finally { d.close(); } },
    exec(sql) { const d = app.db(); try { d.exec(sql); } finally { d.close(); } },
    async advanceClock(ms) {
      const cur = JSON.parse(fs.readFileSync(clockFile, 'utf8'));
      fs.writeFileSync(clockFile, JSON.stringify({ offset_ms: (cur.offset_ms || 0) + ms }));
      await app.waitJobs();
    },
    async waitJobs(times = 4) { await new Promise((r) => setTimeout(r, Number(env.SCHEDULER_TICK_MS) * times + 100)); },
    async restart(extraEnv = {}) {
      await app.stopProcess();
      Object.assign(env, extraEnv);
      const out2 = fs.openSync(logFile, 'a');
      app.child = spawn(process.execPath, [SERVER_ENTRY], { cwd: ROOT, env, stdio: ['ignore', out2, out2] });
      const t0 = Date.now();
      for (;;) {
        if (app.child.exitCode !== null) return { exited: true, code: app.child.exitCode, log: app.logs() };
        try { const r = await fetch(`${base}/healthz`); if (r.ok) return { exited: false }; } catch (_) { /* ждём */ }
        if (Date.now() - t0 > 20000) return { exited: false, timeout: true };
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    stopProcess() {
      return new Promise((resolve) => {
        if (!app.child || app.child.exitCode !== null) return resolve();
        app.child.once('exit', () => resolve());
        app.child.kill('SIGTERM');
        setTimeout(() => { try { app.child.kill('SIGKILL'); } catch (_) { /* уже */ } }, 5000);
        return undefined;
      });
    },
    async stop() {
      await app.stopProcess();
      await smtp.close();
      await ml.close();
      if (!process.env.KEEP_TEST_DATA) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return app;
}

// Попытка запуска при небезопасной конфигурации (F-24): сервер должен завершиться с E-CONFIG, не открыв порт.
async function tryStart(opts) {
  try {
    const app = await startApp(opts);
    return { started: true, app };
  } catch (e) {
    return { started: false, error: String(e.message || e), exitCode: e.exitCode, log: e.log || '' };
  }
}

module.exports = { startApp, tryStart, freePort };
