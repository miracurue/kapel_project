'use strict';

// W0.5: миграция users.role CHECK -> допускает 'admin'. Старая БД (CHECK без
// admin) с данными открывается через src/db.js в дочернем процессе (db.js —
// синглтон, читает TDR_DB_PATH при require).

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
let fails = 0;
let oks = 0;
function check(name, fn) {
  try {
    fn();
    oks++;
    console.log(`  OK   ${name}`);
  } catch (e) {
    fails++;
    console.log(`  FAIL ${name}: ${e.message}`);
  }
}

const OLD_SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('patient','psychiatrist','psychologist')),
  full_name TEXT NOT NULL,
  consent_given INTEGER NOT NULL DEFAULT 0,
  consent_version TEXT,
  consent_at TEXT,
  consent_revoked_at TEXT,
  clinical_consent_given INTEGER NOT NULL DEFAULT 0,
  clinical_consent_at TEXT,
  anonymized_export_opt_in INTEGER NOT NULL DEFAULT 0,
  export_consent_revoked_at TEXT,
  account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','deletion_requested','deleted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE care_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(patient_id, clinician_id)
);
CREATE TABLE mood_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  mood_score INTEGER NOT NULL CHECK (mood_score BETWEEN 1 AND 10),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mig-'));
const dbPath = path.join(tmp, 'old.sqlite3');

// только exec (без prepared statements): деструктор Statement в этом окружении
// вызывает известный abort при teardown (см. test/run-all.js)
const old = new Database(dbPath);
old.exec(OLD_SCHEMA);
old.exec(`
INSERT INTO users (email, password_hash, role, full_name) VALUES ('old-psy@example.com', 'h', 'psychiatrist', 'Демо Старый Врач');
INSERT INTO users (email, password_hash, role, full_name, consent_given, clinical_consent_given, anonymized_export_opt_in)
  VALUES ('old-pat@example.com', 'h', 'patient', 'Демо Старый Пациент', 1, 1, 1);
INSERT INTO users (email, password_hash, role, full_name) VALUES ('gone@example.com', 'h', 'patient', 'Демо Удалённый');
DELETE FROM users WHERE id = 3;
INSERT INTO care_assignments (patient_id, clinician_id) VALUES (2, 1);
INSERT INTO mood_entries (patient_id, mood_score, note) VALUES (2, 6, 'заметка');
`);
old.close();

const CHILD = `
const db = require(process.argv[1]);
let adminInsert = 'ok';
try {
  db.prepare("INSERT OR IGNORE INTO users (email, password_hash, role, full_name) VALUES ('adm@example.com','h','admin','Демо Админ')").run();
} catch (e) { adminInsert = e.message; }
let badRole = 'no-error';
try { db.prepare("INSERT INTO users (email, password_hash, role, full_name) VALUES ('bad@example.com','h','root','x')").run(); } catch (e) { badRole = 'rejected'; }
const out = {
  users: db.prepare('SELECT id, email, role, full_name, consent_given, clinical_consent_given, anonymized_export_opt_in FROM users ORDER BY id').all(),
  care: db.prepare('SELECT patient_id, clinician_id FROM care_assignments').all(),
  mood: db.prepare('SELECT patient_id, note FROM mood_entries').all(),
  fk: db.prepare('PRAGMA foreign_key_check').all(),
  fkOn: db.pragma('foreign_keys', { simple: true }),
  seq: db.prepare("SELECT seq FROM sqlite_sequence WHERE name='users'").get(),
  adminInsert, badRole,
  sql: db.prepare("SELECT sql FROM sqlite_master WHERE name='users'").get().sql,
  leftover: db.prepare("SELECT name FROM sqlite_master WHERE name='users_new'").all(),
};
require('fs').writeFileSync(process.argv[2], JSON.stringify(out));
`;

function openWithDbJs(tag) {
  const outFile = path.join(tmp, `out-${tag}.json`);
  const r = spawnSync(process.execPath, ['-e', CHILD, path.join(ROOT, 'src', 'db.js'), outFile], {
    env: { ...process.env, TDR_DB_PATH: dbPath },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // известный abort() при teardown better-sqlite3 (см. run-all.js) не важен, если файл результата записан
  if (!fs.existsSync(outFile)) throw new Error(`db.js did not produce output (exit ${r.status}): ${r.stderr}`);
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}

const first = openWithDbJs('1');

check('старая БД открывается, роль admin теперь допускается', () => {
  assert.strictEqual(first.adminInsert, 'ok');
  assert.ok(first.sql.includes("'admin'"));
});
check('прежние пользователи сохранены с теми же id и полями', () => {
  const [a, b] = first.users;
  assert.strictEqual(a.id, 1);
  assert.strictEqual(a.email, 'old-psy@example.com');
  assert.strictEqual(a.role, 'psychiatrist');
  assert.strictEqual(b.id, 2);
  assert.strictEqual(b.full_name, 'Демо Старый Пациент');
  assert.strictEqual(b.consent_given, 1);
  assert.strictEqual(b.anonymized_export_opt_in, 1);
});
check('ссылающиеся таблицы целы, foreign_key_check пуст, FK снова включены', () => {
  assert.deepStrictEqual(first.care, [{ patient_id: 2, clinician_id: 1 }]);
  assert.strictEqual(first.mood[0].note, 'заметка');
  assert.deepStrictEqual(first.fk, []);
  assert.strictEqual(first.fkOn, 1);
});
check('неизвестная роль по-прежнему отвергается CHECK', () => assert.strictEqual(first.badRole, 'rejected'));
check('AUTOINCREMENT не откатился назад; временной таблицы не осталось', () => {
  assert.ok(first.seq.seq >= 4);
  assert.ok(first.users[2].id >= 4, `admin id ${first.users[2].id} должен быть > удалённого 3`);
  assert.deepStrictEqual(first.leftover, []);
});

const second = openWithDbJs('2');
check('повторное открытие идемпотентно (данные не дублируются и не теряются)', () => {
  assert.strictEqual(second.users.length, first.users.length);
  assert.deepStrictEqual(second.care, first.care);
  assert.deepStrictEqual(second.fk, []);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`migration: ${oks} OK, ${fails} FAIL`);
if (fails) process.exit(1);
console.log('Все проверки миграции прошли успешно.');
