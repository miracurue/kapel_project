'use strict';

/**
 * Обход известного сбоя better-sqlite3 + Node 24 на этой машине: если сборщик
 * мусора (scavenge) финализирует Statement, процесс падает с abort()
 * (`Assertion failed: (env) != nullptr` в RemoveEnvironmentCleanupHook, exit 134;
 * см. комментарий в test/run-all.js). Подключайте ПЕРВЫМ, до src/db.js, в
 * короткоживущих скриптах (сид, тесты сида): модуль удерживает все Statement и
 * обёртки транзакций, чтобы GC их не собирал. В приложение (src/) не
 * подключается; для долгоживущего сервера не годится (память росла бы).
 */

const Database = require('better-sqlite3');

if (!Database.prototype.__gcGuard) {
  const keep = [];
  const cache = new WeakMap(); // db -> Map(sql -> Statement)
  const origPrepare = Database.prototype.prepare;
  const origTransaction = Database.prototype.transaction;

  Database.prototype.prepare = function prepare(sql) {
    let m = cache.get(this);
    if (!m) { m = new Map(); cache.set(this, m); }
    let st = m.get(sql);
    if (!st) { st = origPrepare.call(this, sql); m.set(sql, st); }
    return st;
  };

  // оригинальный pragma создаёт временный Statement через внутренний cppdb.prepare
  Database.prototype.pragma = function pragma(source, options = {}) {
    const st = this.prepare(`PRAGMA ${source}`);
    const rows = st.reader ? st.all() : (st.run(), []);
    if (options && options.simple) return rows.length ? Object.values(rows[0])[0] : undefined;
    return rows;
  };

  Database.prototype.transaction = function transaction(fn) {
    const wrapped = origTransaction.call(this, fn);
    keep.push(wrapped);
    return wrapped;
  };

  Database.prototype.__gcGuard = true;
}

module.exports = {};
