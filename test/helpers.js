'use strict';

// Общие помощники тестов. Публичная регистрация создаёт только пациентов
// (REQ-ALL-014), поэтому врачей и администраторов тесты создают напрямую в БД.

const bcrypt = require('bcryptjs');

function createUser(db, { email, password = 'secret123', full_name, role, patient = false, consents = true }) {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, role, full_name, consent_given, consent_version, consent_at, clinical_consent_given, clinical_consent_at)
       VALUES (?, ?, ?, ?, ?, 'test', ?, ?, ?)`
    )
    .run(email, bcrypt.hashSync(password, 4), role, full_name, consents && role === 'patient' ? 1 : 0, now, consents && role === 'patient' ? 1 : 0, now);
  return info.lastInsertRowid;
}

function createInvite(db, clinicianId, { code = 'TESTCODE1', daysValid = 7, used = false, revoked = false } = {}) {
  const exp = new Date(Date.now() + daysValid * 86400000).toISOString();
  db.prepare('INSERT INTO invite_codes (code, clinician_id, expires_at, used_at, revoked_at) VALUES (?, ?, ?, ?, ?)').run(
    code,
    clinicianId,
    exp,
    used ? new Date().toISOString() : null,
    revoked ? new Date().toISOString() : null
  );
  return code;
}

// ---- CSRF (W2.S) ----
// Защита включена и в тестах. Тесты ходят в приложение через fetch и вручную ведут cookie, поэтому вместо
// правки каждого запроса installCsrfFetch() ставит обёртку над global fetch, которая ведёт себя как браузер:
// перед изменяющим запросом получает токен сессии (GET /csrf-token с теми же cookie) и отправляет его
// заголовком X-CSRF-Token. Если у сессии нет (устарела), как браузер, получает новую cookie.
// Запросы, где тест сам задал токен (заголовок X-CSRF-Token), идут как есть; `realFetch` — fetch без обёртки.
const realFetch = globalThis.fetch;
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function installCsrfFetch() {
  if (globalThis.__csrfFetchInstalled) return;
  globalThis.__csrfFetchInstalled = true;
  const cache = new Map();
  globalThis.fetch = async function csrfFetch(url, opts = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    const u = new URL(String(url));
    if (SAFE.has(method) || u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return realFetch(url, opts);
    const headers = new Headers(opts.headers || {});
    if (headers.has('x-csrf-token')) return realFetch(url, opts);
    let cookie = headers.get('cookie') || '';
    const key = cookie ? `${u.origin}|${cookie}` : null;
    let token = key ? cache.get(key) : null;
    let freshCookie = null;
    if (!token) {
      const r = await realFetch(`${u.origin}/csrf-token`, { headers: cookie ? { cookie } : {} });
      token = (await r.json()).token;
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      if (sc.length) {
        freshCookie = sc;
        cookie = sc.map((c) => c.split(';')[0]).join('; ');
        headers.set('cookie', cookie);
      }
      cache.set(`${u.origin}|${cookie}`, token);
    }
    headers.set('x-csrf-token', token);
    const res = await realFetch(url, { ...opts, headers });
    if (freshCookie && !(res.headers.getSetCookie && res.headers.getSetCookie().length)) {
      const h = new Headers(res.headers);
      freshCookie.forEach((c) => h.append('set-cookie', c));
      return new Response(res.status === 204 || res.status === 304 ? null : res.body, { status: res.status, statusText: res.statusText, headers: h });
    }
    return res;
  };
}

module.exports = { createUser, createInvite, installCsrfFetch, realFetch };
