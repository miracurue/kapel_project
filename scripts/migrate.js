#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const dbPath = process.env.DB_PATH || path.join(root, 'data', 'tdr.sqlite3');
const migrationDir = path.join(root, 'migrations');
fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const files = fs
  .readdirSync(migrationDir)
  .filter((name) => /^\d{4}_.+\.(sql|js)$/.test(name))
  .sort();
async function migrate() {
  for (const file of files) {
    const version = Number(file.slice(0, 4));
    const sql = fs.readFileSync(path.join(migrationDir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const hasLedger =
      db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get().n > 0;
    const applied = hasLedger
      ? db.prepare('SELECT checksum FROM schema_migrations WHERE version = ?').get(version)
      : null;
    if (applied) {
      if (applied.checksum !== checksum) throw new Error(`checksum mismatch for ${file}`);
      continue;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0 && version > 1) {
        // Freeze writers before copying, so the rollback snapshot includes every
        // committed transaction before the schema change, including WAL pages.
        const backupPath = `${dbPath}.before-${String(version).padStart(4, '0')}.bak`;
        const source = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
          await source.backup(backupPath);
        } finally {
          source.close();
        }
        const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
        try {
          if (backup.pragma('integrity_check', { simple: true }) !== 'ok' || backup.pragma('foreign_key_check').length)
            throw new Error('backup verification failed');
        } finally {
          backup.close();
        }
      }
      if (file.endsWith('.js')) require(path.join(migrationDir, file))(db);
      else db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version, name, checksum) VALUES (?, ?, ?)').run(
        version,
        file,
        checksum,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`integrity_check: ${integrity}`);
  if (db.pragma('foreign_key_check').length) throw new Error('foreign_key_check failed');
  db.close();
  console.log(JSON.stringify({ migrated: files.length, db: dbPath }));
}
migrate().catch((error) => {
  if (db.open) db.close();
  console.error(error.message);
  process.exitCode = 1;
});
