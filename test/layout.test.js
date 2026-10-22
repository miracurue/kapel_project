'use strict';

require('./helpers').installCsrfFetch(); // W2.S: тесты получают и отправляют CSRF-токен как браузер

// W0.6: общая инфраструктура каркаса: страницы ошибок в layout, баннер демо-версии,
// Cache-Control: no-store, флаги cookie сессии, доступность (skip-link, label),
// нейтральные тексты заглушек, экран прохождения, фильтры каталога.

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDb = path.join(os.tmpdir(), `tdr-layout-${Date.now()}.sqlite3`);
process.env.TDR_DB_PATH = tmpDb;
process.env.SESSION_SECRET = 'test-secret';

const bcrypt = require('bcryptjs');
const app = require('../src/app');
const db = require('../src/db');
const catalog = require('../src/instruments_catalog');

const PORT = 20000 + Math.floor(Math.random() * 20000); // случайный порт: тесты могут идти параллельно в разных worktree
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  OK   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

function jar() {
  const cookies = new Map();
  return {
    store(res) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
    },
    header: () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

async function req(method, p, { body, cookieJar } = {}) {
  const headers = {};
  if (cookieJar) headers.Cookie = cookieJar.header();
  let payload;
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(body).toString();
  }
  const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
  if (cookieJar) cookieJar.store(res);
  return { status: res.status, text: await res.text(), location: res.headers.get('location'), headers: res.headers };
}

function addUser(email, role, name) {
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, role, full_name, consent_given, consent_at, clinical_consent_given, clinical_consent_at)
       VALUES (?, ?, ?, ?, 1, datetime('now'), 1, datetime('now'))`
    )
    .run(email, bcrypt.hashSync('pass-1234', 4), role, name);
  return Number(info.lastInsertRowid);
}

async function login(email) {
  const j = jar();
  const r = await req('POST', '/login', { body: { email, password: 'pass-1234' }, cookieJar: j });
  return { j, res: r };
}

const BANNER = 'Демо-версия: данные вымышленные';

async function main() {
  const server = app.listen(PORT);
  try {
    const doc = addUser('doc@example.com', 'psychiatrist', 'Демо Врач');
    const pat = addUser('pat@example.com', 'patient', 'Демо Пациент');
    db.prepare('INSERT INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(pat, doc);
    const asg = db.prepare("INSERT INTO instrument_assignments (patient_id, assigned_by, instrument, status) VALUES (?, ?, 'zung_sds', 'pending')").run(pat, doc).lastInsertRowid;

    console.log('1) Страницы ошибок внутри layout (ALL-003/005)');
    const anon404 = await req('GET', '/no-such-page');
    check('аноним: 404, не голый «Cannot GET»', anon404.status === 404 && !/Cannot GET/.test(anon404.text));
    check('аноним: есть h1, текст по-русски, путь «Ко входу»', /<h1>Страница не найдена<\/h1>/.test(anon404.text) && /href="\/login"[^>]*>Ко входу/.test(anon404.text));
    check('в теле нет стека/путей', !/node_modules|\bat \w+.*\(|SQLITE/.test(anon404.text));

    const { j: pj, res: pLogin } = await login('pat@example.com');
    check('вход пациента перенаправляет на /dashboard', pLogin.status === 302 && pLogin.location === '/dashboard');
    const pat404 = await req('GET', '/no-such-page', { cookieJar: pj });
    check('вошедший: 404 с навигацией и «На главную»', pat404.status === 404 && /class="sidenav"/.test(pat404.text) && /href="\/dashboard"[^>]*>На главную/.test(pat404.text));
    const pat403 = await req('GET', '/crisis', { cookieJar: pj });
    check('403: заголовок «Нет доступа» и «На главную»', pat403.status === 403 && /<h1>Нет доступа<\/h1>/.test(pat403.text) && /На главную/.test(pat403.text));

    console.log('2) Баннер демо-версии, заголовки, cookie (ALL-010/011, SEC-003)');
    const loginPage = await req('GET', '/login');
    check('баннер на странице входа', loginPage.text.includes(BANNER));
    check('баннер на кабинете пациента', (await req('GET', '/dashboard', { cookieJar: pj })).text.includes(BANNER));
    check('баннер на странице 404', pat404.text.includes(BANNER));
    check('Cache-Control: no-store на странице входа', /no-store/.test(loginPage.headers.get('cache-control') || ''));
    const dash = await req('GET', '/dashboard', { cookieJar: pj });
    check('Cache-Control: no-store на авторизованной странице', /no-store/.test(dash.headers.get('cache-control') || ''));
    check('Cache-Control: no-store на 404', /no-store/.test(pat404.headers.get('cache-control') || ''));
    const cookieRes = await fetch(BASE + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'pat@example.com', password: 'pass-1234' }).toString(), redirect: 'manual' });
    const sc = cookieRes.headers.getSetCookie().join('\n');
    check('cookie сессии: HttpOnly и SameSite=Lax', /HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc));
    await req('POST', '/logout', { cookieJar: pj });
    const after = await req('GET', '/dashboard', { cookieJar: pj });
    check('после выхода кабинет недоступен (редирект на вход), без данных', after.status === 302 && after.location === '/login' && /no-store/.test(after.headers.get('cache-control') || ''));

    console.log('3) Доступность (NFR-004/005)');
    check('skip-link ведёт на main#main-content', /class="skip-link" href="#main-content"/.test(loginPage.text) && /<main[^>]*id="main-content"/.test(loginPage.text));
    check('логин: поля связаны с label', /<label for="email">/.test(loginPage.text) && /<input[^>]*id="email"/.test(loginPage.text) && /<label for="password">/.test(loginPage.text) && /<input[^>]*id="password"/.test(loginPage.text));
    const reg = await req('GET', '/register');
    const ids = [...reg.text.matchAll(/<(?:input|select)[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
    const fors = [...reg.text.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]);
    check('регистрация: у каждого текстового поля есть label for', ['full_name', 'email', 'password'].every((i) => ids.includes(i) && fors.includes(i)));
    const flashPage = await (async () => {
      const j = jar();
      await req('POST', '/login', { body: { email: 'pat@example.com', password: 'wrong' }, cookieJar: j });
      return req('GET', '/login', { cookieJar: j });
    })();
    check('flash об ошибке: role="alert" и иконка', /role="alert"/.test(flashPage.text) && /flash__icon/.test(flashPage.text));

    console.log('4) Каталог и прохождение (CAT-004/006/008)');
    const stubs = catalog.CATALOG.filter((e) => e.mode === 'online_stub');
    check('пункты заглушек — нейтральные плейсхолдеры, без тематических формулировок', stubs.every((e) => e.items.length >= 3 && e.items.every((t) => /^Демонстрационный вопрос \d+ — текст будет заменён после клинического ревью$/.test(t))));
    const { j: pj2 } = await login('pat@example.com');
    const take = await req('GET', `/assignments/${asg}/take?i=0`, { cookieJar: pj2 });
    await req('POST', `/assignments/${asg}/answer`, { cookieJar: pj2, body: { i: '0', value: '0' } });
    const take2 = await req('GET', `/assignments/${asg}/take?i=1`, { cookieJar: pj2 });
    check('экран прохождения: «Вопрос N из M», прогресс, «Назад», «Продолжить позже»', take.status === 200 && /Вопрос 1 из 4/.test(take.text) && /<progress/.test(take.text) && /Продолжить позже/.test(take.text) && /Вопрос 2 из 4/.test(take2.text) && />Назад</.test(take2.text));
    check('экран прохождения работает без JS: пошаговая форма с серверным черновиком', /action="\/assignments\/\d+\/answer"/.test(take.text) && /type="radio"/.test(take.text));
    const { j: dj } = await login('doc@example.com');
    const card = await req('GET', `/assignments?patient=${pat}`, { cookieJar: dj });
    check('страница «Назначения»: фильтры domain/kind/mode в каталоге', card.status === 200 && ['domain', 'kind', 'mode'].every((f) => card.text.includes(`data-filter="${f}"`)));
    check('элементы каталога несут data-domain/kind/mode', /class="catalog-item"[^>]*data-domain="[a-z_]+" data-kind="[a-z_]+" data-mode="[a-z_]+"/.test(card.text));
  } finally {
    server.close();
    db.close();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(tmpDb + '-wal', { force: true });
    fs.rmSync(tmpDb + '-shm', { force: true });
  }
  console.log(`\n${failures === 0 ? 'Все проверки каркаса прошли успешно.' : `${failures} проверок каркаса не прошло.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
