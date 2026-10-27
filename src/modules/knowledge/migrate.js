'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { withTransaction } = require('./pg');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
// Произвольная константа для pg_advisory_xact_lock: один мигратор за раз.
const LOCK_KEY = 7_353_100_001;

function listMigrations(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(dir, name), 'utf8');
      return {
        version: Number(name.slice(0, 4)),
        name,
        sql,
        checksum: crypto.createHash('sha256').update(sql).digest('hex'),
      };
    });
}

// Применяет недостающие миграции, каждую в своей транзакции под advisory-lock.
// Повторный прогон ничего не меняет; изменённая применённая миграция — ошибка.
async function migrate(pool, { dir = MIGRATIONS_DIR } = {}) {
  const files = listMigrations(dir);
  const seen = new Set();
  for (const f of files) {
    if (seen.has(f.version)) throw new Error(`duplicate migration number ${f.version}`);
    seen.add(f.version);
  }
  const applied = [];
  for (const file of files) {
    const done = await withTransaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      await client.query(
        `CREATE TABLE IF NOT EXISTS public.knowledge_schema_migrations (
           version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
           applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      const { rows } = await client.query(
        'SELECT checksum FROM public.knowledge_schema_migrations WHERE version = $1',
        [file.version],
      );
      if (rows.length) {
        if (rows[0].checksum !== file.checksum) throw new Error(`checksum mismatch for ${file.name}`);
        return false;
      }
      await client.query(file.sql);
      await client.query(
        'INSERT INTO public.knowledge_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [file.version, file.name, file.checksum],
      );
      return true;
    });
    if (done) applied.push(file.name);
  }
  return { applied, total: files.length };
}

module.exports = { migrate, listMigrations, MIGRATIONS_DIR };
