'use strict';

/**
 * Политика сессий (W2.S, REQ-SEC-003).
 *  - cookie: httpOnly, sameSite=lax, secure при HTTPS (COOKIE_SECURE=true|false; по умолчанию true при NODE_ENV=production;
 *    за прокси задайте TRUST_PROXY=1, иначе express не увидит HTTPS и не выдаст Secure-cookie);
 *  - скользящий таймаут бездействия (W3.K, решение владельца 2026-10-11; значения review-required, задаются env, минуты):
 *    SESSION_IDLE_MIN_CLINICIAN (психиатр/психолог, по умолчанию 120), SESSION_IDLE_MIN_ADMIN (админ, 30),
 *    SESSION_IDLE_MIN_PATIENT (пациенты, 720 = 12 ч: дольше, чтобы не прерывать самопомощь и тесты);
 *  - анонимные сессии (страница входа/регистрации) живут SESSION_IDLE_MIN_ANON (по умолчанию 30) минут и ограничены по числу
 *    (src/security/session_store.js: SESSION_MAX_ANON, SESSION_MAX_TOTAL);
 *  - в production без SESSION_SECRET приложение не стартует.
 */

const crypto = require('crypto');
const { BoundedMemoryStore } = require('./session_store');

function minutes(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const isProd = () => process.env.NODE_ENV === 'production';

function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (isProd()) throw new Error('SESSION_SECRET обязателен при NODE_ENV=production.');
  return crypto.randomBytes(32).toString('hex');
}

function cookieSecure() {
  const v = String(process.env.COOKIE_SECURE || '').toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return isProd();
}

const idleMs = (role) => 60000 * (role === 'patient' ? minutes('SESSION_IDLE_MIN_PATIENT', 720) : role === 'admin' ? minutes('SESSION_IDLE_MIN_ADMIN', 30) : minutes('SESSION_IDLE_MIN_CLINICIAN', 120));
const maxIdleMs = () => Math.max(idleMs('patient'), idleMs('admin'), idleMs('psychiatrist'));
const anonMs = () => Math.min(60000 * minutes('SESSION_IDLE_MIN_ANON', 30), maxIdleMs());

let currentStore = null;
const getStore = () => currentStore;

function sessionOptions() {
  currentStore = new BoundedMemoryStore();
  return {
    secret: secret(),
    resave: false,
    saveUninitialized: false,
    store: currentStore,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: cookieSecure(), maxAge: maxIdleMs() },
  };
}

const EXPIRED = 'Сессия завершена из-за долгого бездействия. Войдите снова.';
// W3.K (L-8): честно о судьбе введённого текста. Черновики пациента (дневник, обращение, сообщения врачу) хранятся на устройстве,
// ответы теста — на сервере; у клинициста несохранённый текст формы не сохраняется (в чате он остаётся в поле ввода).
const EXPIRED_PATIENT = `${EXPIRED} Сессия истекла, черновик сохранён: черновики дневника, сообщений и ответы теста вернутся после входа.`;
const EXPIRED_STAFF = `${EXPIRED} Несохранённый текст формы не сохраняется.`;
const EXPIRED_JSON = 'Сессия истекла, черновик сохранён в поле ввода. Войдите заново (можно в новой вкладке) и отправьте снова.';
const wantsJson = (req) => req.get('X-Requested-With') === 'fetch' || /application\/json/.test(req.get('Accept') || '');

/** Завершает сессию, если с последнего запроса прошло больше таймаута роли. Уровень «now» можно подменить в тесте. */
function idleMiddleware(req, res, next) {
  const u = req.session && req.session.user;
  // M-7: анонимная сессия (cookie нужна только для CSRF формы входа) живёт недолго
  if (req.session && req.session.cookie) req.session.cookie.maxAge = u ? maxIdleMs() : anonMs();
  if (!u) return next();
  const now = Date.now();
  const last = req.session.lastSeen || now;
  if (now - last > idleMs(u.role)) {
    return req.session.regenerate(() => {
      if (wantsJson(req)) return res.status(401).json({ ok: false, error: EXPIRED_JSON, message: EXPIRED_JSON });
      req.session.flash = { message: u.role === 'patient' ? EXPIRED_PATIENT : EXPIRED_STAFF, kind: 'info' };
      // N2: после входа вернуть на ту же страницу (для POST - на страницу формы), чтобы восстановить введённое
      const back = req.method === 'GET' ? req.originalUrl : require('./csrf').returnPath(req);
      const next = /^\/(?!\/)[^\\:\s]*$/.test(back || '') && back !== '/login' ? back : '';
      return res.redirect(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
    });
  }
  if (now - last > 30000 || !req.session.lastSeen) req.session.lastSeen = now;
  return next();
}

module.exports = { getStore, anonMs, sessionOptions, idleMiddleware, idleMs, cookieSecure, EXPIRED };
