'use strict';

/**
 * Ограничение перебора и частоты запросов (W2.S, REQ-SEC-004).
 *
 * Счётчики хранятся В ПАМЯТИ ПРОЦЕССА (демо-ограничение): при перезапуске сервера они обнуляются,
 * при нескольких процессах не разделяются. Для реальной эксплуатации — общее хранилище (Redis/БД).
 * Ключи содержат IP и логин, но никогда не пароль. Старые записи вычищаются по таймеру.
 *
 * Два вида лимитера:
 *  - failureLimiter: считает НЕУДАЧИ (пароль, код). После `max` неудач за `windowMs` ключ блокируется на
 *    baseLockMs, затем 2x, 4x ... до maxLockMs (экспоненциальная задержка). Успех сбрасывает счётчик.
 *  - rateLimiter: мягкий лимит частоты (`max` запросов за `windowMs`), без наказания.
 * Значения по умолчанию переопределяются переменными окружения RATE_<NAME>_MAX / _WINDOW_S / _LOCK_S / _MAX_LOCK_S.
 */

let clock = () => Date.now();
const registry = new Map();

function envNum(name, key, def) {
  const v = Number(process.env[`RATE_${name.toUpperCase()}_${key}`]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

function waitText(ms) {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s} сек.`;
  return `${Math.ceil(s / 60)} мин.`;
}

function failureLimiter(name, { max, windowS, lockS, maxLockS }) {
  const cfg = {
    max: envNum(name, 'MAX', max),
    windowMs: envNum(name, 'WINDOW_S', windowS) * 1000,
    baseLockMs: envNum(name, 'LOCK_S', lockS) * 1000,
    maxLockMs: envNum(name, 'MAX_LOCK_S', maxLockS) * 1000,
  };
  const map = new Map(); // key -> { count, start, lockedUntil, level, last }
  const api = {
    name, cfg, map,
    /** { blocked, retryAfterMs } */
    check(key) {
      const e = map.get(key);
      const now = clock();
      if (e && e.lockedUntil > now) return { blocked: true, retryAfterMs: e.lockedUntil - now };
      return { blocked: false, retryAfterMs: 0 };
    },
    /** Регистрирует неудачу. Возвращает { locked, retryAfterMs, justLocked }. */
    fail(key) {
      const now = clock();
      let e = map.get(key);
      if (!e) { e = { count: 0, start: now, lockedUntil: 0, level: 0, last: now }; map.set(key, e); }
      if (e.lockedUntil <= now && now - e.start > cfg.windowMs) { e.count = 0; e.start = now; }
      if (e.lockedUntil <= now && now - e.last > cfg.windowMs + cfg.maxLockMs) e.level = 0; // давно не было попыток
      e.last = now;
      if (e.lockedUntil > now) return { locked: true, retryAfterMs: e.lockedUntil - now };
      e.count += 1;
      if (e.count >= cfg.max) {
        const lock = Math.min(cfg.maxLockMs, cfg.baseLockMs * 2 ** e.level);
        e.level += 1;
        e.count = 0;
        e.start = now;
        e.lockedUntil = now + lock;
        return { locked: true, retryAfterMs: lock, justLocked: true };
      }
      return { locked: false, retryAfterMs: 0 };
    },
    success(key) { map.delete(key); },
    reset() { map.clear(); },
    prune() {
      const now = clock();
      for (const [k, e] of map) if (e.lockedUntil <= now && now - e.last > cfg.windowMs + cfg.maxLockMs) map.delete(k);
    },
  };
  registry.set(name, api);
  return api;
}

function rateLimiter(name, { max, windowS }) {
  const cfg = { max: envNum(name, 'MAX', max), windowMs: envNum(name, 'WINDOW_S', windowS) * 1000 };
  const map = new Map(); // key -> { count, start }
  const api = {
    name, cfg, map,
    /** Учитывает запрос. { allowed, retryAfterMs } */
    hit(key) {
      const now = clock();
      let e = map.get(key);
      if (!e || now - e.start >= cfg.windowMs) { e = { count: 0, start: now }; map.set(key, e); }
      if (e.count >= cfg.max) return { allowed: false, retryAfterMs: e.start + cfg.windowMs - now };
      e.count += 1;
      return { allowed: true, retryAfterMs: 0 };
    },
    reset() { map.clear(); },
    prune() {
      const now = clock();
      for (const [k, e] of map) if (now - e.start >= cfg.windowMs) map.delete(k);
    },
  };
  registry.set(name, api);
  return api;
}

const L = {
  // вход: 5 неудач / 15 мин на (IP + логин); блокировка 1 мин, 2, 4 ... до 15 мин
  login: failureLimiter('login', { max: 5, windowS: 900, lockS: 60, maxLockS: 900 }),
  // общий потолок неудач с одного IP по любым логинам (перебор списка логинов)
  loginIp: failureLimiter('login_ip', { max: 40, windowS: 900, lockS: 60, maxLockS: 900 }),
  // смена пароля и подпись заключения паролем: неудачи на пользователя
  password: failureLimiter('password', { max: 5, windowS: 900, lockS: 60, maxLockS: 900 }),
  cancelDeletion: failureLimiter('cancel_deletion', { max: 5, windowS: 600, lockS: 60, maxLockS: 900 }),
  sign: failureLimiter('sign', { max: 5, windowS: 900, lockS: 60, maxLockS: 900 }),
  // регистрация: неверные коды-приглашения с одного IP (перебор кодов)
  inviteCode: failureLimiter('invite_code', { max: 10, windowS: 900, lockS: 60, maxLockS: 900 }),
  register: rateLimiter('register', { max: 20, windowS: 3600 }),
  inviteCreate: rateLimiter('invite_create', { max: 30, windowS: 3600 }),
  // ИИ-чат уже ограничен в src/ai/chatService.js (20 сообщений/мин, кризисные не ограничиваются) — здесь не дублируется
  upload: rateLimiter('upload', { max: 20, windowS: 600 }),
};

const timer = setInterval(() => registry.forEach((l) => l.prune()), 5 * 60 * 1000);
timer.unref();

module.exports = {
  ...L,
  waitText,
  setClock(fn) { clock = fn || (() => Date.now()); },
  resetAll() { registry.forEach((l) => l.reset()); },
  registry,
};
