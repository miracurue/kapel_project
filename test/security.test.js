'use strict';

// W2.S: защита веб-уровня — CSRF, заголовки/CSP, лимиты перебора, политика сессий.
// Все запросы идут через НАСТОЯЩИЙ fetch (helpers.realFetch) без обёртки токена: токен берётся со страниц, как у браузера.

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDb = path.join(os.tmpdir(), `tdr-security-${process.pid}-${Date.now()}.sqlite3`);
process.env.TDR_DB_PATH = tmpDb;
process.env.SESSION_SECRET = 'test-secret';

const { realFetch, createUser } = require('./helpers');
const app = require('../src/app');
const db = require('../src/db');
const limits = require('../src/security/rate_limit');
const sessionPolicy = require('../src/security/session_policy');
const csrf = require('../src/security/csrf');

let BASE;
let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log(`  OK   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); }
}

// ---- HTTP без обёртки ----
function cookiesOf(res, into = {}) {
  for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); into[pair.slice(0, i)] = pair.slice(i + 1); }
  return into;
}
const cookieHeader = (c) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; ');
async function http(method, p, { cookies, body, form, headers = {}, multipart: mp } = {}) {
  const h = { ...headers };
  if (cookies) h.Cookie = cookieHeader(cookies);
  let payload;
  if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (mp) {
    const boundary = '----sec' + Math.random().toString(16).slice(2);
    h['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    const parts = [];
    for (const [k, v] of Object.entries(mp.fields || {})) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
    for (const f of mp.files || []) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n${f.data}\r\n`);
    parts.push(`--${boundary}--\r\n`);
    payload = Buffer.from(parts.join(''), 'utf8');
  } else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await realFetch(BASE + p, { method, headers: h, body: payload, redirect: 'manual' });
  if (cookies) cookiesOf(res, cookies);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers, location: res.headers.get('location') };
}
const tokenOf = (html) => (/name="_csrf" value="([0-9a-f]{64})"/.exec(html) || [])[1];
const metaToken = (html) => (/<meta name="csrf-token" content="([0-9a-f]{64})"/.exec(html) || [])[1];

async function loginAs(email, password = 'secret123') {
  const cookies = {};
  const page = await http('GET', '/login', { cookies });
  const r = await http('POST', '/login', { cookies, form: { email, password, _csrf: tokenOf(page.text) } });
  return { cookies, status: r.status, location: r.location, text: r.text };
}
async function freshToken(s, p = '/dashboard') {
  const r = await http('GET', p, { cookies: s.cookies });
  return metaToken(r.text);
}

// ---- обход маршрутов приложения ----
function postRoutes() {
  const out = [];
  const walk = (stack) => {
    for (const l of stack) {
      if (l.route) {
        for (const m of Object.keys(l.route.methods)) {
          if (['post', 'put', 'patch', 'delete'].includes(m) && typeof l.route.path === 'string') out.push({ method: m.toUpperCase(), path: l.route.path });
        }
      } else if (l.name === 'router' && l.handle && l.handle.stack) walk(l.handle.stack);
    }
  };
  walk(app._router.stack);
  return out;
}

async function crawl(s, start = '/dashboard', limit = 60) {
  const seen = new Set();
  const queue = [start];
  const pages = [];
  while (queue.length && pages.length < limit) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    const r = await http('GET', p, { cookies: s.cookies });
    if (r.status !== 200 || !/text\/html/.test(r.headers.get('content-type') || '')) continue;
    pages.push({ path: p, html: r.text, headers: r.headers });
    for (const m of r.text.matchAll(/href="(\/[^"#?]*(?:\?[^"#]*)?)"/g)) {
      const href = m[1].replace(/&amp;/g, '&');
      if (!/^\/(logout|help\/.*download|.*\.(css|js|csv|docx|pdf|txt))/.test(href) && !/export|download|print|\.csv/.test(href) && !seen.has(href)) queue.push(href);
    }
  }
  return pages;
}

async function main() {
  const server = app.listen(0);
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    const psy = createUser(db, { email: 'psy@example.test', full_name: 'Психиатр Тестов', role: 'psychiatrist' });
    const psl = createUser(db, { email: 'psl@example.test', full_name: 'Психолог Тестова', role: 'psychologist' });
    createUser(db, { email: 'adm@example.test', full_name: 'Админ', role: 'admin' });
    const spare = createUser(db, { email: 'spare@example.test', full_name: 'Запасной Пациент', role: 'patient' });
    const pA = createUser(db, { email: 'pa@example.test', full_name: 'Пациент Альфа', role: 'patient' });
    db.prepare('INSERT OR IGNORE INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(pA, psy);
    db.prepare('INSERT OR IGNORE INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(pA, psl);

    console.log('1) CSRF: токен в формах, отказ без токена');
    const c0 = {};
    const loginPage = await http('GET', '/login', { cookies: c0 });
    const t0 = tokenOf(loginPage.text);
    check('форма входа содержит скрытое поле _csrf (вставлено сервером)', !!t0);
    check('meta csrf-token совпадает с полем формы', metaToken(loginPage.text) === t0);
    check('токен не в URL: ссылки и action форм без _csrf', !/(href|action)="[^"]*_csrf/.test(loginPage.text));
    const noTok = await http('POST', '/login', { cookies: { ...c0 }, form: { email: 'pa@example.test', password: 'secret123' } });
    check('вход без токена -> 403', noTok.status === 403);
    check('403: понятная русская страница в общем layout', /Обновите страницу/.test(noTok.text) && /class="topbar"/.test(noTok.text) && /<h1>Сессия истекла<\/h1>/.test(noTok.text));
    const wrong = await http('POST', '/login', { cookies: { ...c0 }, form: { email: 'pa@example.test', password: 'secret123', _csrf: 'a'.repeat(64) } });
    check('неверный токен -> 403', wrong.status === 403);
    const empty = await http('POST', '/login', { cookies: { ...c0 }, form: { email: 'pa@example.test', password: 'secret123', _csrf: '' } });
    check('пустой токен -> 403', empty.status === 403);
    const other = {};
    const otherPage = await http('GET', '/login', { cookies: other });
    const inQuery = await http('POST', `/login?_csrf=${t0}`, { cookies: { ...c0 }, form: { email: 'pa@example.test', password: 'secret123' } });
    check('токен в query не принимается (не читаем из URL)', inQuery.status === 403);
    const foreign = await http('POST', '/login', { cookies: { ...c0 }, form: { email: 'pa@example.test', password: 'secret123', _csrf: tokenOf(otherPage.text) } });
    check('токен другой сессии -> 403', foreign.status === 403);
    const noCookie = await http('POST', '/login', { form: { email: 'pa@example.test', password: 'secret123', _csrf: t0 } });
    check('токен без cookie сессии -> 403', noCookie.status === 403);
    const viaHeader = await http('POST', '/login', { cookies: { ...c0 }, headers: { 'X-CSRF-Token': t0 }, form: { email: 'nobody@example.test', password: 'x' } });
    check('заголовок X-CSRF-Token принимается (fetch): запрос доходит до обработчика', viaHeader.status === 302 && viaHeader.location === '/login');
    check('safeEqual: разная длина/пустое значение не бросает и даёт false', (() => { try { return csrf.safeEqual('abc', 'abcd') === false && csrf.safeEqual('', '') === false && csrf.safeEqual(undefined, 'a') === false && csrf.safeEqual('x'.repeat(64), 'x'.repeat(64)) === true; } catch { return false; } })());

    console.log('2) Регенерация сессии, выход');
    const s = await loginAs('psy@example.test');
    check('вход по токену из формы -> редирект в кабинет', s.status === 302 && s.location === '/dashboard');
    check('id сессии при входе новый (regenerate)', s.cookies['connect.sid'] && s.cookies['connect.sid'] !== c0['connect.sid']);
    const old = await http('GET', '/dashboard', { cookies: { 'connect.sid': c0['connect.sid'] } });
    check('старый id сессии (до входа) не даёт доступа', old.status === 302 && old.location === '/login');
    const newTok = await freshToken(s);
    check('токен после входа новый, привязан к новой сессии', !!newTok && newTok !== t0);
    const oldTokOnNew = await http('POST', '/logout', { cookies: { ...s.cookies }, form: { _csrf: t0 } });
    check('токен прежней (анонимной) сессии не подходит к новой', oldTokOnNew.status === 403);
    const lo = await http('POST', '/logout', { cookies: s.cookies, form: { _csrf: newTok } });
    check('выход с токеном из формы работает', lo.status === 302 && lo.location === '/login');
    const afterLo = await http('GET', '/dashboard', { cookies: { 'connect.sid': s.cookies['connect.sid'] } });
    check('после выхода старая cookie недействительна', afterLo.status === 302 && afterLo.location === '/login');
    check('выход очищает cookie', /connect\.sid=;|Expires=Thu, 01 Jan 1970/.test(lo.headers.getSetCookie().join('\n')));

    console.log('3) Все изменяющие маршруты: без токена -> 403');
    const sPsy = await loginAs('psy@example.test');
    const sPsl = await loginAs('psl@example.test');
    const sAdm = await loginAs('adm@example.test');
    const sPat = await loginAs('pa@example.test');
    const routes = postRoutes();
    check(`найдено изменяющих маршрутов: ${routes.length} (>=100)`, routes.length >= 100);
    const bad = [];
    for (const rt of routes) {
      const p = rt.path.replace(/:(\w+)(\([^)]*\))?/g, (m, n) => (/kind/.test(n) ? 'diary' : /action/.test(n) ? 'valid' : '1'));
      for (const who of [sAdm, sPat]) {
        const r = await http(rt.method, p, { cookies: who.cookies, form: { x: '1' } });
        if (r.status !== 403 || !/Обновите страницу/.test(r.text)) bad.push(`${rt.method} ${rt.path} -> ${r.status}`);
      }
    }
    check('каждый POST/PUT/PATCH/DELETE без токена -> 403 (админ и пациент)', bad.length === 0, bad.slice(0, 5).join('; '));
    const anonBad = [];
    for (const rt of routes.filter((x) => ['/login', '/register', '/logout', '/account/cancel-deletion'].includes(x.path))) {
      const r = await http(rt.method, rt.path, { form: { x: '1' } });
      if (r.status !== 403) anonBad.push(rt.path);
    }
    check('анонимные POST (вход, регистрация, выход, отмена удаления) без токена -> 403', anonBad.length === 0, anonBad.join());

    console.log('4) Классы форм: без токена 403, с токеном обработчик отрабатывает');
    const tokPsy = await freshToken(sPsy);
    const tokPsl = await freshToken(sPsl);
    const tokAdm = await freshToken(sAdm);
    const tokPat = await freshToken(sPat);
    const cases = [
      ['назначение теста', sPsy, tokPsy, 'POST', '/assignments', { patient_id: String(pA), instrument: 'phq9' }],
      ['ввод результата врачом', sPsy, tokPsy, 'POST', `/patients/${pA}/results`, { instrument: 'phq9' }],
      ['заметка о пациенте', sPsy, tokPsy, 'POST', `/patients/${pA}/notes`, { body: 'тест' }],
      ['подпись заключения', sPsl, tokPsl, 'POST', '/conclusions/1/sign', { confirm_password: 'secret123' }],
      ['создание пользователя админом', sAdm, tokAdm, 'POST', '/admin/users', { email: 'x@example.test' }],
      ['сброс пароля админом', sAdm, tokAdm, 'POST', `/admin/users/${spare}/reset`, {}],
      ['дневник пациента', sPat, tokPat, 'POST', '/diary', { mood: '3' }],
      ['сообщение врачу', sPat, tokPat, 'POST', '/messages', { clinician_id: String(psy), body: 'здравствуйте' }],
      ['смена пароля', sPat, tokPat, 'POST', '/profile/password', { current_password: 'x' }],
    ];
    for (const [label, who, tok, m, p, f] of cases) {
      const a = await http(m, p, { cookies: who.cookies, form: f });
      const b = await http(m, p, { cookies: who.cookies, form: { ...f, _csrf: tok } });
      check(`${label}: без токена 403, с токеном обработчик (не 403)`, a.status === 403 && b.status !== 403, `${a.status}/${b.status}`);
    }
    const chatNo = await http('POST', '/chat/send', { cookies: sPat.cookies, body: { text: 'привет' }, headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' } });
    check('ИИ-чат (fetch JSON) без токена -> 403 JSON с русским текстом', chatNo.status === 403 && /Обновите страницу/.test(JSON.parse(chatNo.text).error));
    const chatOk = await http('POST', '/chat/send', { cookies: sPat.cookies, body: { text: 'привет' }, headers: { 'X-Requested-With': 'fetch', Accept: 'application/json', 'X-CSRF-Token': tokPat } });
    check('ИИ-чат с заголовком X-CSRF-Token -> 200', chatOk.status === 200, String(chatOk.status));
    const piiNo = await http('POST', '/ai/pii/detect', { cookies: sPsy.cookies, body: { text: 'x' }, headers: { 'X-Requested-With': 'fetch' } });
    check('детектор ПДн (fetch JSON) без токена -> 403', piiNo.status === 403);
    const autosaveNo = await http('POST', '/conclusions/1/autosave', { cookies: sPsl.cookies, form: { x: '1' }, headers: { 'X-Requested-With': 'fetch', Accept: 'application/json' } });
    check('автосохранение заключения (fetch) без токена -> 403 JSON', autosaveNo.status === 403 && JSON.parse(autosaveNo.text).ok === false);

    const csv = { field: 'file', name: 'import.csv', type: 'text/csv', data: 'fio,date\r\nИванов,2026-01-01\r\n' };
    const upNo = await http('POST', '/tools/import/upload', { cookies: sPsy.cookies, multipart: { files: [csv] } });
    check('загрузка CSV без токена -> 403', upNo.status === 403);
    const upBad = await http('POST', '/tools/import/upload', { cookies: sPsy.cookies, multipart: { fields: { _csrf: 'b'.repeat(64) }, files: [csv] } });
    check('загрузка CSV с неверным токеном в multipart -> 403', upBad.status === 403);
    const upOk = await http('POST', '/tools/import/upload', { cookies: sPsy.cookies, multipart: { fields: { _csrf: tokPsy }, files: [csv] } });
    check('загрузка CSV с токеном в multipart-поле -> редирект на черновик (токен прочитан, тело передано маршруту)', upOk.status === 302 && /\/tools\/import/.test(upOk.location || ''), `${upOk.status} ${upOk.location}`);
    const upHdr = await http('POST', '/tools/import/upload', { cookies: sPsy.cookies, headers: { 'X-CSRF-Token': tokPsy }, multipart: { files: [csv] } });
    check('загрузка CSV с токеном в заголовке -> тоже принимается', upHdr.status === 302, String(upHdr.status));
    const ws = { field: 'files', name: 'note.txt', type: 'text/plain', data: 'Тестовый текст материала' };
    const wsNo = await http('POST', '/ai/materials/preview', { cookies: sPsy.cookies, multipart: { files: [ws] } });
    check('загрузка материалов ИИ-пространства без токена -> 403', wsNo.status === 403);
    const wsOk = await http('POST', '/ai/materials/preview', { cookies: sPsy.cookies, multipart: { fields: { _csrf: tokPsy }, files: [ws] } });
    check('загрузка материалов ИИ-пространства с токеном в поле -> 200 (предпросмотр)', wsOk.status === 200, String(wsOk.status));
    const anonUp = await http('POST', '/tools/import/upload', { multipart: { fields: { _csrf: tokPsy }, files: [csv] } });
    check('анонимный multipart не читается и не принимается -> 403', anonUp.status === 403);

    console.log('5) Каждая отрисованная форма POST содержит ровно одно поле _csrf; нет inline-кода (CSP)');
    const roles = [['психиатр', sPsy], ['психолог', sPsl], ['админ', sAdm], ['пациент', sPat]];
    let forms = 0; let noField = 0; let dup = 0; let inline = []; let pagesN = 0; let hdrBad = [];
    for (const [name, who] of roles) {
      const pages = await crawl(who);
      pagesN += pages.length;
      for (const pg of pages) {
        for (const m of pg.html.matchAll(/<form\b[^>]*>/gi)) {
          if (!/method\s*=\s*["']?post/i.test(m[0])) continue;
          forms += 1;
          const after = pg.html.slice(m.index + m[0].length, m.index + m[0].length + 120);
          if (!/^<input type="hidden" name="_csrf" value="[0-9a-f]{64}" \/>/.test(after)) noField += 1;
          const end = pg.html.indexOf('</form>', m.index);
          if ((pg.html.slice(m.index, end).match(/name="_csrf"/g) || []).length !== 1) dup += 1;
        }
        if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(pg.html) || /\son[a-z]+\s*=\s*["']/i.test(pg.html.replace(/data-[a-z-]+="[^"]*"/g, '')) || /<style\b/i.test(pg.html) || /\sstyle\s*=\s*["']/i.test(pg.html) || /javascript:/i.test(pg.html)) inline.push(`${name} ${pg.path}`);
        const h = pg.headers;
        if (!/default-src 'self'/.test(h.get('content-security-policy') || '') || h.get('x-content-type-options') !== 'nosniff' || h.get('cache-control') !== 'no-store') hdrBad.push(pg.path);
      }
    }
    check(`обойдено страниц: ${pagesN}, форм POST: ${forms} (форм >= 40)`, pagesN >= 40 && forms >= 40);
    check('у каждой формы POST скрытое поле _csrf сразу после тега', noField === 0, String(noField));
    check('в каждой форме ровно одно поле _csrf (без дублей)', dup === 0, String(dup));
    check('в HTML нет inline-скриптов, on*-обработчиков, <style>, style="" и javascript:', inline.length === 0, inline.slice(0, 4).join('; '));
    check('на всех страницах CSP, nosniff и no-store', hdrBad.length === 0, hdrBad.slice(0, 4).join(', '));
    check('шаблоны не подключают отдельный партиал _csrf (механизм один)', !fs.existsSync(path.join(__dirname, '..', 'views', 'clinician', '_csrf.ejs')) && !/include\([^)]*_csrf/.test(require('child_process').execSync('grep -rn "_csrf" ../views || true', { cwd: __dirname }).toString()));

    console.log('6) Заголовки безопасности');
    for (const [label, cookies, p] of [['гость, вход', {}, '/login'], ['пациент', sPat.cookies, '/dashboard'], ['врач', sPsy.cookies, '/dashboard'], ['админ', sAdm.cookies, '/dashboard'], ['404', sPat.cookies, '/net-takoy-stranicy']]) {
      const r = await http('GET', p, { cookies });
      const h = r.headers;
      const csp = h.get('content-security-policy') || '';
      check(`${label}: CSP default-src 'self', script-src 'self' без unsafe-inline, frame-ancestors 'none', object-src 'none'`,
        /default-src 'self'/.test(csp) && /script-src 'self'(;|$)/.test(csp) && /style-src 'self'(;|$)/.test(csp) && !/unsafe-inline|unsafe-eval|https?:/.test(csp) && /frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp) && /form-action 'self'/.test(csp) && /base-uri 'self'/.test(csp));
      check(`${label}: nosniff, Referrer-Policy, X-Frame-Options, Permissions-Policy, no-store`,
        h.get('x-content-type-options') === 'nosniff' && h.get('referrer-policy') === 'same-origin' && h.get('x-frame-options') === 'DENY' && /camera=\(\)/.test(h.get('permissions-policy') || '') && h.get('cache-control') === 'no-store');
    }
    const css = await realFetch(`${BASE}/style.css`);
    check('статика тоже с nosniff и CSP', css.headers.get('x-content-type-options') === 'nosniff' && !!css.headers.get('content-security-policy'));
    const sc = sPat.cookies;
    const setc = (await realFetch(`${BASE}/login`)).headers.getSetCookie().join('\n');
    check('cookie сессии: HttpOnly; SameSite=Lax; без Secure по умолчанию (HTTP)', /HttpOnly/i.test(setc) && /SameSite=Lax/i.test(setc) && !/Secure/i.test(setc) && !!sc);

    console.log('7) Лимит перебора входа');
    limits.resetAll();
    const loginTry = async (email, password, extra = {}) => {
      const cookies = {};
      const page = await http('GET', '/login', { cookies });
      return http('POST', '/login', { cookies, form: { email, password, _csrf: tokenOf(page.text), ...extra } });
    };
    let last;
    for (let i = 0; i < 4; i++) { last = await loginTry('pa@example.test', 'wrong-pass-' + i); }
    check('4 неудачи: обычное сообщение, редирект', last.status === 302);
    last = await loginTry('pa@example.test', 'wrong-pass-5');
    check('5-я неудача включает блокировку: 429 и понятное русское сообщение с временем', last.status === 429 && /Слишком много неудачных попыток входа\. Подождите 1 мин\./.test(last.text), `${last.status}`);
    check('Retry-After задан', Number(last.headers.get('retry-after')) > 0);
    last = await loginTry('pa@example.test', 'secret123');
    check('во время блокировки даже верный пароль не пускает (429)', last.status === 429);
    const otherUser = await loginTry('psy@example.test', 'secret123');
    check('другой логин не заблокирован', otherUser.status === 302 && otherUser.location === '/dashboard');
    const ghostA = await loginTry('no-such-user@example.test', 'x');
    let ghostLast; for (let i = 0; i < 5; i++) ghostLast = await loginTry('no-such-user@example.test', 'x' + i);
    check('несуществующий логин блокируется так же и тем же текстом (нет раскрытия существования)', ghostA.status === 302 && ghostLast.status === 429 && /Слишком много неудачных попыток входа\. Подождите 1 мин\./.test(ghostLast.text));
    const flashOf = async (email) => { const cookies = {}; const pg = await http('GET', '/login', { cookies }); await http('POST', '/login', { cookies, form: { email, password: 'bad', _csrf: tokenOf(pg.text) } }); const r = await http('GET', '/login', { cookies }); return (/class="flash[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(r.text) || /Неверный email или пароль\./.exec(r.text) || [])[0]; };
    limits.resetAll();
    const fa = await flashOf('pa@example.test'); const fb = await flashOf('absent@example.test');
    check('сообщение «Неверный email или пароль» совпадает для обоих случаев', !!fa && fa === fb && /Неверный email или пароль\./.test(fa));
    limits.resetAll();

    // экспоненциальная задержка и разблокировка по времени
    let now = Date.now();
    limits.setClock(() => now);
    for (let i = 0; i < 5; i++) await loginTry('pa@example.test', 'bad' + i);
    last = await loginTry('pa@example.test', 'secret123');
    check('блокировка 1: 429', last.status === 429);
    now += 61 * 1000;
    for (let i = 0; i < 5; i++) last = await loginTry('pa@example.test', 'bad' + i);
    check('через 61 с блокировка снята; после следующих 5 неудач она уже 2 мин', last.status === 429 && /Подождите 2 мин\./.test(last.text), last.text.match(/Подождите [^.]*\./) + '');
    now += 121 * 1000;
    last = await loginTry('pa@example.test', 'secret123');
    check('после ожидания верный пароль пускает', last.status === 302 && last.location === '/dashboard');
    limits.setClock(null);
    limits.resetAll();

    const lockRows = db.prepare("SELECT * FROM admin_action_log WHERE action LIKE '%lockout'").all();
    check('блокировки записаны в журнал (admin_action_log)', lockRows.length >= 2 && lockRows.some((x) => x.action === 'login_lockout'));
    const wholeLog = JSON.stringify(db.prepare('SELECT * FROM admin_action_log').all());
    check('в журнале нет паролей и e-mail попыток', !/secret123|wrong-pass|bad\d|no-such-user|pa@example/.test(wholeLog));

    console.log('8) Лимиты: смена пароля, подпись заключения, коды, загрузки');
    const sP2 = await loginAs('pa@example.test');
    let t = await freshToken(sP2);
    let r8;
    for (let i = 0; i < 5; i++) r8 = await http('POST', '/profile/password', { cookies: sP2.cookies, form: { current_password: 'nope' + i, new_password: 'newpass-123', new_password2: 'newpass-123', _csrf: t } });
    const flashAfter = await http('GET', '/profile', { cookies: sP2.cookies });
    r8 = await http('POST', '/profile/password', { cookies: sP2.cookies, form: { current_password: 'secret123', new_password: 'newpass-123', new_password2: 'newpass-123', _csrf: t } });
    const flashAfter2 = await http('GET', '/profile', { cookies: sP2.cookies });
    check('смена пароля: после 5 неверных текущих пароль блокируется даже верный', /Слишком много неверных паролей/.test(flashAfter2.text) && !!flashAfter);
    check('пароль не изменился во время блокировки', require('bcryptjs').compareSync('secret123', db.prepare('SELECT password_hash FROM users WHERE id = ?').get(pA).password_hash));
    limits.resetAll();

    const sPsl2 = await loginAs('psl@example.test');
    t = await freshToken(sPsl2);
    const mk = await http('POST', `/patients/${pA}/conclusions`, { cookies: sPsl2.cookies, form: { _csrf: t } });
    const cid = (/\/conclusions\/(\d+)/.exec(mk.location || '') || [])[1];
    check('заключение для проверки подписи создано', !!cid, `${mk.status} ${mk.location}`);
    const signPath = `/conclusions/${cid}/sign`;
    for (let i = 0; i < 5; i++) await http('POST', signPath, { cookies: sPsl2.cookies, form: { confirm_password: 'wrong' + i, _csrf: t } });
    await http('POST', signPath, { cookies: sPsl2.cookies, form: { confirm_password: 'secret123', _csrf: t } });
    const signed = db.prepare("SELECT status FROM conclusion_versions WHERE conclusion_id = ? ORDER BY version DESC").get(cid);
    check('подпись паролем: после 5 неверных даже верный пароль не подписывает', !!signed && signed.status !== 'signed', JSON.stringify(signed));
    check('блокировка подписи записана в журнал', db.prepare("SELECT COUNT(*) AS n FROM admin_action_log WHERE action = 'sign_lockout'").get().n === 1);
    limits.resetAll();

    for (let i = 0; i < 10; i++) {
      const c = {};
      const pg = await http('GET', '/register', { cookies: c });
      await http('POST', '/register', { cookies: c, form: { full_name: 'X', email: `bad${i}@example.test`, password: 'password-1', invite_code: 'ZZZZ-ZZZZ', consent_given: '1', clinical_consent_given: '1', _csrf: tokenOf(pg.text) } });
    }
    const rc = {};
    const regPage = await http('GET', '/register', { cookies: rc });
    const reg = await http('POST', '/register', { cookies: rc, form: { full_name: 'X', email: 'late@example.test', password: 'password-1', invite_code: 'ZZZZ-ZZZZ', consent_given: '1', clinical_consent_given: '1', _csrf: tokenOf(regPage.text) } });
    check('перебор кодов-приглашений: после 10 неверных -> 429 и понятный текст', reg.status === 429 && /Слишком много неверных кодов/.test(reg.text), String(reg.status));
    limits.resetAll();

    const sI = await loginAs('psy@example.test');
    const ti = await freshToken(sI);
    let blocked = null;
    for (let i = 0; i < 32 && !blocked; i++) {
      await http('POST', '/invites', { cookies: sI.cookies, form: { _csrf: ti } });
      const pg = await http('GET', '/invites', { cookies: sI.cookies });
      if (/Создано слишком много кодов/.test(pg.text)) blocked = i;
    }
    check('создание кодов-приглашений ограничено (30/час)', blocked !== null && blocked >= 29 && blocked <= 31, String(blocked));
    limits.resetAll();

    const up = limits.upload;
    let hit; for (let i = 0; i < up.cfg.max + 1; i++) hit = up.hit('u-test');
    check('мягкий лимит загрузок: после порога отказ с retryAfter; окно сбрасывается', !hit.allowed && hit.retryAfterMs > 0);
    limits.resetAll();

    console.log('9) Политика сессий');
    check('в production без SESSION_SECRET запуск отказывается', (() => {
      const saved = { n: process.env.NODE_ENV, s: process.env.SESSION_SECRET };
      process.env.NODE_ENV = 'production'; delete process.env.SESSION_SECRET;
      let threw = false;
      try { sessionPolicy.sessionOptions(); } catch { threw = true; }
      process.env.NODE_ENV = saved.n === undefined ? '' : saved.n; if (saved.n === undefined) delete process.env.NODE_ENV; process.env.SESSION_SECRET = saved.s;
      return threw;
    })());
    check('cookie Secure включается в production и по COOKIE_SECURE=true; COOKIE_SECURE=false выключает', (() => {
      const sv = { n: process.env.NODE_ENV, c: process.env.COOKIE_SECURE };
      process.env.NODE_ENV = 'production'; delete process.env.COOKIE_SECURE;
      const a = sessionPolicy.cookieSecure();
      process.env.COOKIE_SECURE = 'false'; const b = sessionPolicy.cookieSecure();
      process.env.NODE_ENV = 'test'; process.env.COOKIE_SECURE = 'true'; const c = sessionPolicy.cookieSecure();
      if (sv.n === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = sv.n;
      if (sv.c === undefined) delete process.env.COOKIE_SECURE; else process.env.COOKIE_SECURE = sv.c;
      return a === true && b === false && c === true;
    })());
    check('таймаут бездействия по умолчанию (W3.K): клиницисты 120 мин, админ 30 мин, пациенты 720 мин (конфигурируется)', sessionPolicy.idleMs('psychiatrist') === 120 * 60000 && sessionPolicy.idleMs('psychologist') === 120 * 60000 && sessionPolicy.idleMs('admin') === 30 * 60000 && sessionPolicy.idleMs('patient') === 720 * 60000);

    process.env.SESSION_IDLE_MIN_CLINICIAN = '0.02'; // 1,2 с
    const sIdle = await loginAs('psy@example.test');
    await http('GET', '/dashboard', { cookies: sIdle.cookies });
    const pat = await loginAs('pa@example.test');
    await http('GET', '/dashboard', { cookies: pat.cookies });
    await new Promise((res) => setTimeout(res, 1500));
    const idleR = await http('GET', '/dashboard', { cookies: sIdle.cookies });
    check('клиницист: после простоя сессия завершена, редирект на вход', idleR.status === 302 && /^\/login/.test(idleR.location));
    const loginAfter = await http('GET', '/login', { cookies: sIdle.cookies });
    check('на странице входа объяснено: сессия завершена из-за бездействия', /долгого бездействия/.test(loginAfter.text));
    const stale = await http('GET', '/dashboard', { cookies: { 'connect.sid': sIdle.cookies['connect.sid'] } });
    check('старый id сессии после таймаута недействителен', stale.status === 302);
    const patR = await http('GET', '/dashboard', { cookies: pat.cookies });
    check('пациенту короткий таймаут не навязывается', patR.status === 200);
    const sIdle2 = await loginAs('psy@example.test');
    await http('GET', '/dashboard', { cookies: sIdle2.cookies });
    await new Promise((res) => setTimeout(res, 1500));
    const idleJson = await http('POST', '/ai/send', { cookies: sIdle2.cookies, body: { text: 'x' }, headers: { 'X-Requested-With': 'fetch', Accept: 'application/json', 'X-CSRF-Token': 'a'.repeat(64) } });
    check('fetch после простоя получает 401 JSON, а не страницу', idleJson.status === 401 && JSON.parse(idleJson.text).ok === false);
    delete process.env.SESSION_IDLE_MIN_CLINICIAN;

    console.log('10) Запрос удаления данных по-прежнему блокирует вход');
    db.prepare("UPDATE users SET account_status = 'deletion_requested' WHERE id = ?").run(pA);
    const del = await loginAs('pa@example.test');
    const delPage = await http('GET', '/dashboard', { cookies: del.cookies });
    check('после запроса удаления вход не создаёт сессию', del.status === 302 && del.location === '/login' && delPage.status === 302 && delPage.location === '/login');
    db.prepare("UPDATE users SET account_status = 'active' WHERE id = ?").run(pA);
  } finally {
    server.close();
    db.close();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(tmpDb + '-wal', { force: true });
    fs.rmSync(tmpDb + '-shm', { force: true });
  }
  console.log(`\n${failures === 0 ? 'Все проверки защиты веб-уровня прошли успешно.' : `${failures} проверок не прошло.`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
