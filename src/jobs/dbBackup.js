'use strict';

/**
 * Задача планировщика: резервная копия основной базы SQLite.
 * Вызывается из общего цикла планировщика src/server.js (никаких своих setInterval):
 *  - копия делается онлайн-бэкапом SQLite (db.backup), сервер продолжает работать;
 *  - новая копия — если последней больше intervalHours (по умолчанию 24 ч);
 *  - хранятся последние keep копий (по умолчанию 7), старые удаляются;
 *  - файлы — <dataDir>/backups/tdr-<UTC-время>.sqlite3, права 0600 (там же, где база: том cc_data).
 * Выключение: DB_BACKUP_KEEP=0. В тестах (NODE_ENV=test) выключено, если не задано явно.
 * Восстановление: остановить приложение, заменить файл базы копией, запустить (docs/DEPLOY_DEMO.md).
 */

const fs = require('fs');
const path = require('path');

const PREFIX = 'tdr-';
const SUFFIX = '.sqlite3';

function settings(config, env = process.env) {
  const fallbackKeep = config.env === 'test' ? 0 : 7;
  const keep = env.DB_BACKUP_KEEP === undefined ? fallbackKeep : Number(env.DB_BACKUP_KEEP);
  const intervalHours = Number(env.DB_BACKUP_INTERVAL_HOURS || 24);
  return {
    keep: Number.isInteger(keep) && keep > 0 ? keep : 0,
    intervalMs: (intervalHours > 0 ? intervalHours : 24) * 3600000,
    dir: env.DB_BACKUP_DIR || path.join(config.dataDir, 'backups'),
  };
}

function list(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(PREFIX) && name.endsWith(SUFFIX))
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function stamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function parseStamp(name) {
  const m = /^tdr-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.sqlite3$/.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
}

let running = false;

/**
 * Делает копию, если пора. Возвращает { file } при новой копии, иначе null.
 * `current` — время планировщика (now(config)), чтобы тестовые часы работали так же.
 */
async function runBackup({ db, config, current = new Date(), env = process.env }) {
  const opts = settings(config, env);
  if (!opts.keep || running) return null;
  running = true;
  try {
    fs.mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    const existing = list(opts.dir);
    const last = existing.length ? parseStamp(existing[existing.length - 1]) : 0;
    if (last && current.getTime() - last < opts.intervalMs) return null;
    const file = path.join(opts.dir, `${PREFIX}${stamp(current)}${SUFFIX}`);
    const temp = `${file}.part`;
    await db.backup(temp);
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
    for (const name of list(opts.dir).slice(0, -opts.keep)) fs.unlinkSync(path.join(opts.dir, name));
    return { file };
  } finally {
    running = false;
  }
}

module.exports = { runBackup, settings, list, parseStamp };
