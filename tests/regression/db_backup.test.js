'use strict';
// covers: резервная копия SQLite задачей планировщика (src/jobs/dbBackup.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runBackup, list, settings } = require('../../src/jobs/dbBackup');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-db-backup-'));
  const db = new Database(path.join(dir, 'tdr.sqlite3'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO t(v) VALUES (?)').run('synthetic');
  return { dir, db, config: { env: 'production', dataDir: dir }, env: { DB_BACKUP_KEEP: '3' } };
}

test('копия читается, права 0600, вторая за сутки не делается', async () => {
  const { dir, db, config, env } = fixture();
  const t0 = new Date('2026-10-24T03:00:00Z');
  const made = await runBackup({ db, config, current: t0, env });
  assert.ok(made && fs.existsSync(made.file));
  assert.equal(fs.statSync(made.file).mode & 0o777, 0o600);
  const copy = new Database(made.file, { readonly: true });
  assert.equal(copy.prepare('SELECT v FROM t').get().v, 'synthetic');
  copy.close();
  assert.equal(await runBackup({ db, config, current: new Date(t0.getTime() + 3600000), env }), null);
  assert.equal(list(path.join(dir, 'backups')).length, 1);
});

test('хранятся последние N копий', async () => {
  const { dir, db, config, env } = fixture();
  for (let day = 0; day < 5; day += 1)
    await runBackup({ db, config, current: new Date(Date.UTC(2026, 9, 20 + day, 3)), env });
  const names = list(path.join(dir, 'backups'));
  assert.deepEqual(names, [
    'tdr-20261022T030000Z.sqlite3',
    'tdr-20261023T030000Z.sqlite3',
    'tdr-20261024T030000Z.sqlite3',
  ]);
});

test('в тестовой среде и при DB_BACKUP_KEEP=0 выключено', async () => {
  assert.equal(settings({ env: 'test', dataDir: '/x' }, {}).keep, 0);
  assert.equal(settings({ env: 'production', dataDir: '/x' }, {}).keep, 7);
  const { db, config } = fixture();
  assert.equal(await runBackup({ db, config, env: { DB_BACKUP_KEEP: '0' } }), null);
});
