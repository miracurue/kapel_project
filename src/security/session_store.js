'use strict';

/**
 * Хранилище сессий в памяти с ограничениями (W3.K, M-7). Стандартный MemoryStore не ограничивает число сессий
 * и не вычищает просроченные, которых никто не читает: поток анонимных GET /login копил бы память без предела.
 *  - анонимные сессии (без user) — не больше SESSION_MAX_ANON (по умолчанию 5000), при превышении вытесняются самые старые анонимные;
 *  - всего сессий не больше SESSION_MAX_TOTAL (по умолчанию 50000), при превышении сначала вытесняются анонимные, затем самые старые;
 *  - просроченные сессии удаляются периодически (раз в 5 минут), таймер не удерживает процесс.
 * Сессии вошедших пользователей при потоке анонимов не вытесняются, пока есть анонимные.
 */

const session = require('express-session');

const num = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
};

class BoundedMemoryStore extends session.MemoryStore {
  constructor({ maxAnon = num('SESSION_MAX_ANON', 5000), maxTotal = num('SESSION_MAX_TOTAL', 50000), sweepMs = 5 * 60 * 1000 } = {}) {
    super();
    this.maxAnon = maxAnon;
    this.maxTotal = maxTotal;
    this.anon = new Map(); // sid -> true, порядок вставки = возраст
    this.evicted = 0;
    this.timer = setInterval(() => this.sweep(), sweepMs);
    if (this.timer.unref) this.timer.unref();
  }

  size() {
    return Object.keys(this.sessions).length;
  }

  _drop(sid) {
    delete this.sessions[sid];
    this.anon.delete(sid);
    this.evicted += 1;
  }

  set(sid, sess, cb) {
    super.set(sid, sess, (err) => {
      if (!err) {
        const authed = !!(sess && sess.user);
        this.anon.delete(sid);
        if (!authed) this.anon.set(sid, true); // обновление «освежает» позицию
        this._enforce(sid);
      }
      if (cb) cb(err);
    });
  }

  destroy(sid, cb) {
    this.anon.delete(sid);
    super.destroy(sid, cb);
  }

  _enforce(keepSid) {
    while (this.anon.size > this.maxAnon) {
      const oldest = this.anon.keys().next().value;
      if (oldest === keepSid && this.anon.size === 1) break;
      this._drop(oldest === keepSid ? [...this.anon.keys()][1] : oldest);
    }
    let total = this.size();
    if (total <= this.maxTotal) return;
    for (const sid of [...this.anon.keys()]) {
      if (total <= this.maxTotal) return;
      if (sid !== keepSid) { this._drop(sid); total -= 1; }
    }
    for (const sid of Object.keys(this.sessions)) {
      if (total <= this.maxTotal) return;
      if (sid !== keepSid) { this._drop(sid); total -= 1; }
    }
  }

  sweep(now = Date.now()) {
    let n = 0;
    for (const [sid, raw] of Object.entries(this.sessions)) {
      let exp = null;
      try { const s = JSON.parse(raw); exp = s && s.cookie && s.cookie.expires ? Date.parse(s.cookie.expires) : null; } catch { exp = null; }
      if (exp !== null && exp <= now) { this._drop(sid); n += 1; }
    }
    return n;
  }
}

module.exports = { BoundedMemoryStore };
