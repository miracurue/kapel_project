'use strict';

/**
 * CSRF-защита (W2.S, REQ-SEC-002). Единый механизм для всего приложения:
 *  - токен привязан к сессии (req.session.csrfToken, 256 бит), создаётся при первой отрисовке страницы;
 *  - во все отрисованные `<form method="post">` скрытое поле `_csrf` вставляет обёртка res.render
 *    (шаблоны ничего не подключают); для fetch/XHR токен лежит в `<meta name="csrf-token">`
 *    и уходит заголовком `X-CSRF-Token` (public/csrf.js);
 *  - любой POST/PUT/PATCH/DELETE без верного токена -> 403 (страница в общем layout или JSON для fetch);
 *  - сравнение за постоянное время (SHA-256 обоих значений + timingSafeEqual);
 *  - токен не передаётся в URL (query не читается);
 *  - исключений нет. GET /csrf-token (безопасный метод) отдаёт токен текущей сессии тому же источнику.
 *
 * multipart/form-data (загрузки ИИ-пространства и импорт CSV) разбирается самими маршрутами. Если токена нет
 * в заголовке, тело читается здесь целиком (потолок MULTIPART_MAX, только для вошедших пользователей),
 * поле `_csrf` проверяется, а буфер передаётся маршруту через req.rawBody (см. multipart.readBody).
 */

const crypto = require('crypto');
const multipart = require('../ai/workspace/multipart');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const MULTIPART_MAX = 60 * 1024 * 1024;
const MULTIPART_PATHS = /^\/(ai\/materials\/preview|tools\/import\/upload)$/;
const MESSAGE = 'Страница устарела или сессия завершилась, поэтому действие не выполнено. Обновите страницу (при необходимости войдите снова) и повторите.';

function tokenFor(req) {
  if (!req.session) return '';
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function valid(req, supplied) {
  const expected = req.session && req.session.csrfToken;
  return !!expected && safeEqual(String(supplied || ''), expected);
}

const FORM_RE = /<form\b([^>]*)>/gi;
function inject(html, token) {
  if (typeof html !== 'string' || !token) return html;
  const field = `<input type="hidden" name="_csrf" value="${token}" />`;
  return html.replace(FORM_RE, (m, attrs) => (/\bmethod\s*=\s*["']?post\b/i.test(attrs) ? m + field : m));
}

function wantsJson(req) {
  return req.get('X-Requested-With') === 'fetch' || /application\/json/.test(req.get('Accept') || '');
}

/** Безопасный путь возврата после входа: адрес страницы формы (Referer того же сайта). */
function returnPath(req) {
  try {
    const u = new URL(req.get('referer') || '', 'http://x');
    const p = u.pathname + u.search;
    return /^\/(?!\/)[^\\:\s]*$/.test(p) && p !== '/login' ? p : '';
  } catch { return ''; }
}

function reject(req, res) {
  req.resume();
  if (wantsJson(req)) return res.status(403).json({ ok: false, error: MESSAGE, message: MESSAGE });
  // N2: страница «сессия истекла» с кнопкой «Войти и вернуться» (ввод сохраняет public/form_keeper.js)
  const expired = !(req.session && req.session.user);
  return res.status(403).render('error', { status: 403, message: MESSAGE, sessionLost: expired, loginNext: expired ? returnPath(req) : '' });
}

function middleware(req, res, next) {
  // токен для шаблонов: создаётся лениво, только если страница его использует
  Object.defineProperty(res.locals, 'csrfToken', { enumerable: true, configurable: true, get: () => tokenFor(req) });

  const render = res.render.bind(res);
  res.render = function csrfRender(view, options, cb) {
    if (typeof options === 'function') { cb = options; options = undefined; }
    render(view, options, (err, html) => {
      if (cb) return cb(err, err ? html : inject(html, tokenFor(req)));
      if (err) return req.next(err);
      return res.send(inject(html, tokenFor(req)));
    });
  };

  return next();
}

/**
 * Проверка токена. Подключается после middleware, готовящих переменные шаблонов (user, меню),
 * чтобы страница отказа 403 отрисовалась в общем layout.
 */
function guard(req, res, next) {
  if (SAFE.has(req.method)) return next();

  const header = req.get('x-csrf-token');
  if (header) return valid(req, header) ? next() : reject(req, res);

  const ct = String(req.headers['content-type'] || '');
  if (/^multipart\/form-data/i.test(ct)) {
    // multipart читается целиком в память: допускаем только маршруты загрузки (иначе любой вошедший шлёт 60 МБ на любой URL)
    if (!MULTIPART_PATHS.test(req.path)) return reject(req, res);
    // загрузки доступны только вошедшим; анонимный multipart не читаем вовсе
    if (!req.session || !req.session.user || !req.session.csrfToken) return reject(req, res);
    return multipart.readBody(req, MULTIPART_MAX).then(
      (buf) => {
        let field = '';
        try { field = multipart.parse(buf, ct).fields._csrf; } catch { field = ''; }
        if (Array.isArray(field)) field = field[0];
        if (!valid(req, field)) return reject(req, res);
        req.rawBody = buf;
        return next();
      },
      (e) => (e && e.status === 413
        ? res.status(413).render('error', { status: 413, message: e.message })
        : reject(req, res))
    );
  }

  const body = req.body && typeof req.body === 'object' ? req.body._csrf : undefined;
  return valid(req, body) ? next() : reject(req, res);
}

/** GET /csrf-token — токен текущей сессии для JS (ответ читается только тем же источником). */
function tokenRoute(req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({ token: tokenFor(req) });
}

module.exports = { returnPath, middleware, guard, tokenRoute, safeEqual, inject, tokenFor, MESSAGE, MULTIPART_MAX };
