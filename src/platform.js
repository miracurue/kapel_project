'use strict';

const crypto = require('crypto');
const Database = require('better-sqlite3');
const { now } = require('./config');

const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const iso = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

function openDb(config) {
  const db = new Database(config.dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  return db;
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const i = item.indexOf('=');
        return [item.slice(0, i), item.slice(i + 1)];
      }),
  );
}

// W-41 (S-40): таймауты сессий — настройка auth.session_timeouts, действует для
// новых сессий. Модуль settings передаёт провайдер при старте; без него —
// прежние встроенные значения. Созданная сессия запоминает свои лимиты
// (снимок в data.timeouts), смена настройки не закрывает прежние сессии.
let timeoutsProvider = null;

function setTimeoutsProvider(fn) {
  timeoutsProvider = fn;
}

function currentTimeouts() {
  let t = { idle_minutes: 30, staff_absolute_minutes: 120, patient_remember_minutes: 720 };
  try {
    const s = timeoutsProvider ? timeoutsProvider() : null;
    if (s && typeof s === 'object') t = { ...t, ...s };
  } catch (_) {
    /* настройки недоступны — встроенные значения */
  }
  return t;
}

function sessionTimes(config, role, created = now(config), timeouts = null) {
  const t = timeouts || currentTimeouts();
  const staff = ['psychiatrist', 'psychologist', 'admin'].includes(role);
  // Бездействие (S-40) — единый лимит для всех ролей; у гостя своей сессии нет.
  const idleMinutes = !role ? 45 * 24 * 60 : t.idle_minutes;
  const absoluteMinutes = !role ? 45 * 24 * 60 : staff ? t.staff_absolute_minutes : t.patient_remember_minutes;
  const idle = new Date(created.getTime() + idleMinutes * 60 * 1000);
  return {
    idle: iso(idle),
    absolute: iso(new Date(created.getTime() + absoluteMinutes * 60 * 1000)),
    idle_minutes: idleMinutes,
  };
}

function createSession(db, config, res, { userId = null, role = null, data = {} } = {}) {
  const raw = token(32);
  const current = now(config);
  const timeouts = currentTimeouts();
  const times = sessionTimes(config, role, current, timeouts);
  const state = { csrf: token(24), role, timeouts, ...data };
  db.prepare(
    `INSERT INTO sessions
    (sid_hash,user_id,data,created_at,last_seen_at,idle_expires_at,abs_expires_at)
    VALUES (?,?,?,?,?,?,?)`,
  ).run(sha(raw), userId, JSON.stringify(state), iso(current), iso(current), times.idle, times.absolute);
  res.setHeader('Set-Cookie', `cc_sid=${raw}; Path=/; HttpOnly; SameSite=Lax`);
  return { raw, hash: sha(raw), user_id: userId, data: state, ...times };
}

function loadSession(db, config, req) {
  const raw = parseCookies(req.headers.cookie).cc_sid;
  if (!raw) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE sid_hash = ?').get(sha(raw));
  if (!row || row.closed_at) return null;
  const current = now(config);
  if (current > new Date(row.idle_expires_at) || current > new Date(row.abs_expires_at)) {
    db.prepare("UPDATE sessions SET closed_at=?, close_reason='expired' WHERE sid_hash=?").run(
      iso(current),
      row.sid_hash,
    );
    return null;
  }
  const user = row.user_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) : null;
  if (user && user.sessions_valid_from && new Date(row.created_at) < new Date(user.sessions_valid_from)) return null;
  // W-50: запрос на стирание ('deletion_requested') не убивает сессию — пациенту
  // нужна возможность отменить запрос (T-202); стёртый аккаунт ('tombstone') и
  // прочие статусы сессию закрывают.
  if (user && !['active', 'deletion_requested'].includes(user.status)) return null;
  const state = JSON.parse(row.data);
  const role = user ? user.role : state.role;
  // Скользящее окно бездействия — по снимку лимитов, снятому при входе (S-40
  // действует для новых сессий и не закрывает уже открытые).
  const times = sessionTimes(config, role, current, state.timeouts);
  db.prepare('UPDATE sessions SET last_seen_at=?, idle_expires_at=? WHERE sid_hash=?').run(
    iso(current),
    times.idle,
    row.sid_hash,
  );
  return { ...row, raw, data: state, user };
}

function closeSession(db, config, session, reason = 'logout') {
  if (session)
    db.prepare('UPDATE sessions SET closed_at=?, close_reason=? WHERE sid_hash=?').run(
      iso(now(config)),
      reason,
      session.sid_hash,
    );
}

function requestId() {
  return crypto.randomUUID();
}

function errorBody(req, code, extra = {}) {
  return { error: { code, key: `err.${code.toLowerCase()}`, request_id: req.requestId, ...extra } };
}

function sendError(req, res, status, code, extra) {
  return res.status(status).json(errorBody(req, code, extra));
}

function hmac(config, value) {
  return crypto
    .createHmac('sha256', config.logHmacKey || 'synthetic-test-key')
    .update(String(value).toLowerCase())
    .digest('hex');
}

function safeEvent(db, session, event) {
  try {
    db.prepare('INSERT INTO product_events(event,role,app_version,session_pseudo) VALUES (?,?,?,?)').run(
      event,
      session?.user?.role || session?.data?.role || 'guest',
      '0.1.0',
      sha(session?.sid_hash || 'guest').slice(0, 24),
    );
    require('./modules/analytics/reporting').recordProductEvent(db, session, event);
  } catch (_) {
    /* продуктовая аналитика не ломает действие */
  }
}

module.exports = {
  openDb,
  sha,
  token,
  iso,
  parseCookies,
  createSession,
  loadSession,
  closeSession,
  requestId,
  errorBody,
  sendError,
  hmac,
  safeEvent,
  setTimeoutsProvider,
  currentTimeouts,
};
