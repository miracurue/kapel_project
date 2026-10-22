'use strict';

// HTTP-клиент тестов: ведёт cookie как браузер, берёт CSRF-токен из GET /api/v1/csrf,
// ставит заголовок Idempotency-Key у каждой записи (F-18), разбирает тело ошибки
// {"error":{code,key,request_id,fields,details}} (12, «Соглашения»).

const assert = require('node:assert/strict');
const crypto = require('crypto');
const { PASSWORD, byKey } = require('../fixtures/world');
const { errKey } = require('./texts');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

class Client {
  constructor(base, who = null) {
    this.base = base;
    this.who = who;
    this.cookies = new Map();
    this.csrf = null;
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(res) {
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return list;
  }

  async ensureCsrf() {
    if (this.csrf) return this.csrf;
    const r = await this.raw('GET', '/api/v1/csrf', undefined, { csrf: false });
    this.csrf = r.body && (r.body.token || r.body.csrf || r.body.csrf_token);
    return this.csrf;
  }

  // opts: { csrf: true|false|'<token>', idem: true|false|'<key>', headers, form: FormData, raw: Buffer, redirect }
  async raw(method, path, body, opts = {}) {
    method = method.toUpperCase();
    const headers = { accept: 'application/json', ...(opts.headers || {}) };
    if (this.cookies.size) headers.cookie = this.cookieHeader();
    let payload;
    if (opts.form) payload = opts.form;
    else if (opts.rawBody) { payload = opts.rawBody; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    if (MUTATING.has(method)) {
      if (opts.csrf !== false) {
        const token = typeof opts.csrf === 'string' ? opts.csrf : await this.ensureCsrf();
        if (token) headers['x-csrf-token'] = token;
        if (this.cookies.size) headers.cookie = this.cookieHeader();
      }
      if (opts.idem !== false) headers['idempotency-key'] = typeof opts.idem === 'string' ? opts.idem : crypto.randomUUID();
    }
    const res = await fetch(this.base + path, { method, headers, body: payload, redirect: opts.redirect || 'manual' });
    const setCookie = this.storeCookies(res);
    const ct = res.headers.get('content-type') || '';
    let parsed;
    if (opts.binary) parsed = Buffer.from(await res.arrayBuffer());
    else if (ct.includes('application/json')) { try { parsed = await res.json(); } catch (_) { parsed = null; } }
    else parsed = await res.text();
    return { status: res.status, headers: res.headers, body: parsed, setCookie, idem: headers['idempotency-key'] };
  }

  get(path, opts) { return this.raw('GET', path, undefined, opts); }
  post(path, body = {}, opts) { return this.raw('POST', path, body, opts); }
  put(path, body = {}, opts) { return this.raw('PUT', path, body, opts); }
  patch(path, body = {}, opts) { return this.raw('PATCH', path, body, opts); }
  del(path, body, opts) { return this.raw('DELETE', path, body, opts); }

  async login(email, password = PASSWORD) {
    const r = await this.post('/api/v1/auth/login', { email, password }, { idem: false });
    // после входа — новая сессия, а значит и новый CSRF-токен
    this.csrf = null;
    return r;
  }
}

// Клиент, вошедший участником мира (key из tests/fixtures/world.js).
async function as(app, key) {
  const c = new Client(app.base, key);
  const r = await c.login(byKey(key).email);
  assert.equal(r.status, 200, `вход ${key}: ожидался 200, пришёл ${r.status} ${JSON.stringify(r.body)}`);
  return c;
}

function guest(app) {
  return new Client(app.base, 'guest');
}

// Проверка ошибки по контракту: статус, код, ключ текста err.<код>, номер запроса.
function expectError(res, status, code) {
  assert.equal(res.status, status, `ожидался ${status} ${code}, пришёл ${res.status} ${JSON.stringify(res.body).slice(0, 400)}`);
  assert.ok(res.body && res.body.error, `тело ошибки должно быть {"error":{…}}: ${JSON.stringify(res.body).slice(0, 200)}`);
  if (code) assert.equal(res.body.error.code, code);
  assert.equal(res.body.error.key, errKey(res.body.error.code), 'key = err.<код в нижнем регистре>');
  assert.ok(res.body.error.request_id, 'в ошибке есть номер запроса');
  return res.body.error;
}

function expectOk(res, status = 200) {
  assert.ok(res.status === status || (status === 200 && res.status === 201),
    `ожидался ${status}, пришёл ${res.status} ${JSON.stringify(res.body).slice(0, 400)}`);
  return res.body;
}

// Предупреждение в warnings[] успешного ответа (информационные коды, 12 «Что внутри»).
function hasWarning(body, code) {
  return Array.isArray(body && body.warnings) && body.warnings.some((w) => w.code === code);
}

module.exports = { Client, as, guest, expectError, expectOk, hasWarning };
