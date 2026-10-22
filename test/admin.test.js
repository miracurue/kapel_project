'use strict';

require('./helpers').installCsrfFetch(); // W2.S: тесты получают и отправляют CSRF-токен как браузер

// W1.D: кабинет администратора на демо-сиде. Сводка и счётчики, закрытая регистрация + коды-приглашения,
// создание сотрудника и принудительная смена пароля, сброс пароля (полный цикл), деактивация, привязки,
// очередь «Без врача», удаление данных (строки и файлы стёрты, откат при сбое), журналы, экспорт по comparison_pairs.

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-admin-'));
process.env.TDR_DB_PATH = path.join(tmp, 'admin.sqlite3');
process.env.TDR_OUTBOX_PATH = path.join(tmp, 'outbox.log');
process.env.SESSION_SECRET = 'test-secret';
delete process.env.RESEARCH_PSEUDONYM_SALT;

require('../scripts/gc-guard'); // до src/db
const db = require('../src/db');
const { seedDemo, DEMO_PASSWORD } = require('../scripts/seed-demo');
const { seedAdminDemo } = require('../scripts/seed-admin-demo');
const core = require('../src/admin_core');
const invites = require('../src/invites');
const escalation = require('../src/escalation');
const researchExport = require('../src/research_export');
const audit = require('../src/admin_audit');
const deletion = require('../src/admin_deletion');

seedDemo();
const app = require('../src/app');

const PORT = 20000 + Math.floor(Math.random() * 20000); // случайный порт: параллельные запуски в разных worktree
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
let oks = 0;
function check(label, cond) {
  if (cond) { oks++; console.log(`  OK   ${label}`); } else { failures++; console.error(`  FAIL ${label}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function req(method, p, { body, cookieJar, raw } = {}) {
  const headers = {};
  if (cookieJar) headers.Cookie = cookieJar.header();
  let payload;
  if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; const u = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) (Array.isArray(v) ? v : [v]).forEach((x) => u.append(k, x));
    payload = u.toString(); }
  const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
  if (cookieJar) cookieJar.store(res);
  if (raw) return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  return { status: res.status, text: await res.text(), location: res.headers.get('location'), headers: res.headers };
}
async function login(email, password = DEMO_PASSWORD) {
  const j = jar();
  const r = await req('POST', '/login', { cookieJar: j, body: { email, password } });
  return { j, status: r.status, location: r.location };
}
async function loginOk(email, password) {
  const r = await login(email, password);
  if (r.status !== 302) throw new Error(`login ${email}: ${r.status}`);
  return r.j;
}
const uid = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
const one = (sql, ...a) => db.prepare(sql).get(...a);
const count = (sql, ...a) => db.prepare(sql).get(...a).n;
const tempPass = (html) => (html.match(/<code id="temp-pass">([^<]+)<\/code>/) || [])[1];

async function main() {
  const server = app.listen(PORT);
  try {
    const admin = await loginOk('admin@example.com');
    const psy1 = await loginOk('psychiatrist1@example.com');
    const psy2 = await loginOk('psychiatrist2@example.com');
    const pat = await loginOk('patient1.improving@example.com');
    const ids = {
      admin: uid('admin@example.com'), psy1: uid('psychiatrist1@example.com'), psy2: uid('psychiatrist2@example.com'),
      psy3: uid('psychiatrist3@example.com'), p1: uid('patient1.improving@example.com'), p2: uid('patient2.worsening@example.com'),
      p8: uid('patient8.new@example.com'), fomin: uid('patient6.nodoctor@example.com'), zorina: uid('patient3.crisis@example.com'),
    };

    console.log('1) Админ входит: /dashboard — «Требует решения» (дефект A0-B3), меню без «скоро»');
    let r = await req('GET', '/dashboard', { cookieJar: admin });
    check('/dashboard админа = 200 и «Требует решения»', r.status === 200 && r.text.includes('Требует решения'));
    check('в меню нет пунктов «скоро»; есть Без врача, Запросы на удаление, Журналы, Пользователи', !/badge-soon/.test(r.text) && ['Без врача', 'Запросы на удаление', 'Журналы', 'Пользователи', 'Привязки', 'Приглашения', 'Система'].every((t) => r.text.includes(t)));
    check('в шапке у админа нет ссылки на кризисную очередь врача', !/<a href="\/crisis">/.test(r.text));
    // счётчики совпадают с данными: у Фомина (без врача) открыта Tier-1 только в БД seed? считаем по данным
    const seedNoDoc = require('../src/admin_queue').countOpen();
    check('счётчик «Без врача» на сводке равен данным', r.text.includes(`<div class="stat-card__value">${seedNoDoc}</div>`));

    console.log('2) Негативные: клиницист/пациент -> 403 на админке; админ -> 403 на клиническое');
    for (const p of ['/admin', '/admin/users', '/admin/audit', '/admin/deletion', '/admin/nobody', '/admin/assignments', '/admin/invites', '/admin/system', '/admin/consents']) {
      const a = await req('GET', p, { cookieJar: psy1 });
      const b = await req('GET', p, { cookieJar: pat });
      check(`${p}: психиатр 403, пациент 403`, a.status === 403 && b.status === 403);
    }
    r = await req('GET', '/admin', { cookieJar: jar() });
    check('аноним на /admin не получает страницу (403)', r.status === 403);
    r = await req('POST', '/admin/users', { cookieJar: psy1, body: { full_name: 'X', email: 'x@example.com', role: 'admin' } });
    check('психиатр не может создать админа (403, пользователя нет)', r.status === 403 && !one("SELECT 1 FROM users WHERE email = 'x@example.com'"));
    for (const p of [`/patients/${ids.p1}`, '/crisis', '/export/comparisons.csv', '/patients']) {
      r = await req('GET', p, { cookieJar: admin });
      check(`админ: ${p} -> 403`, r.status === 403);
    }
    r = await req('POST', `/patients/${ids.p1}/archive`, { cookieJar: admin, body: {} });
    check('админ: действие над карточкой -> 403', r.status === 403);

    console.log('3) Открытая регистрация не создаёт врача; список врачей аноним не видит');
    const anon = jar();
    r = await req('GET', '/register', { cookieJar: anon });
    check('GET /register: нет имён клиницистов, нет выбора роли и врача', r.status === 200 && !/Орлов|Крылова|Белова|Беляев/.test(r.text) && !/<select[^>]*name="role"/.test(r.text) && !/name="clinician_id"/.test(r.text) && /name="invite_code"/.test(r.text));
    const before = count('SELECT COUNT(*) AS n FROM users');
    for (const role of ['psychiatrist', 'psychologist', 'admin']) {
      r = await req('POST', '/register', { cookieJar: anon, body: { email: `evil-${role}@example.com`, password: 'password123', full_name: 'Самозванец', role, consent_given: '1', clinical_consent_given: '1' } });
      check(`POST /register role=${role}: отказ, пользователь не создан`, (r.status === 403 || r.status === 302) && count('SELECT COUNT(*) AS n FROM users') === before);
    }
    r = await req('POST', '/register', { cookieJar: anon, body: { email: 'short@example.com', password: 'abc', full_name: 'Короткий', consent_given: '1', clinical_consent_given: '1' } });
    check('пароль короче 8 -> отказ', !one("SELECT 1 FROM users WHERE email = 'short@example.com'"));

    console.log('4) Привязка пациента по коду-приглашению');
    const inv = invites.create(ids.psy3);
    const reg = (email, code) => req('POST', '/register', { cookieJar: jar(), body: { email, password: 'password123', full_name: `Пациент ${email}`, invite_code: code, consent_given: '1', clinical_consent_given: '1' } });
    r = await reg('code-ok@example.com', inv.code.toLowerCase());
    const codeOk = one("SELECT id FROM users WHERE email = 'code-ok@example.com'");
    check('верный код (в любом регистре, с дефисом): пациент создан и привязан к врачу', r.status === 302 && !!codeOk && !!one('SELECT 1 FROM care_assignments WHERE patient_id = ? AND clinician_id = ?', codeOk.id, ids.psy3));
    r = await reg('code-reuse@example.com', inv.code);
    check('повторное использование кода -> отказ, пользователь не создан', !one("SELECT 1 FROM users WHERE email = 'code-reuse@example.com'"));
    r = await reg('code-bad@example.com', 'ZZZZ-ZZZZ');
    check('неверный код -> отказ, пользователь не создан', !one("SELECT 1 FROM users WHERE email = 'code-bad@example.com'"));
    const expired = invites.create(ids.psy3);
    db.prepare("UPDATE invite_codes SET expires_at = datetime('now', '-1 day') WHERE id = ?").run(expired.id);
    await reg('code-exp@example.com', expired.code);
    check('истёкший код -> отказ', !one("SELECT 1 FROM users WHERE email = 'code-exp@example.com'"));
    const revoked = invites.create(ids.psy3);
    invites.revoke(ids.psy3, revoked.id);
    await reg('code-rev@example.com', revoked.code);
    check('отозванный код -> отказ', !one("SELECT 1 FROM users WHERE email = 'code-rev@example.com'"));
    await reg('code-none@example.com', '');
    const none = one("SELECT id FROM users WHERE email = 'code-none@example.com'");
    check('без кода регистрация возможна, врача нет', !!none && !one('SELECT 1 FROM care_assignments WHERE patient_id = ?', none.id));

    console.log('5) Админ создаёт клиницициста: пароль показан один раз, при первом входе смена обязательна');
    r = await req('GET', '/admin/users/new', { cookieJar: admin });
    check('форма создания сотрудника', r.status === 200 && r.text.includes('Новый сотрудник'));
    r = await req('POST', '/admin/users', { cookieJar: admin, body: { full_name: 'Новый Врач Тестов', email: 'new.doc@example.com', role: 'psychiatrist' } });
    check('создание -> редирект на показ пароля', r.status === 302 && r.location === '/admin/credentials');
    const newDoc = one("SELECT * FROM users WHERE email = 'new.doc@example.com'");
    check('создан психиатр с обязательной сменой пароля', newDoc && newDoc.role === 'psychiatrist' && newDoc.must_change_password === 1);
    r = await req('GET', '/admin/credentials', { cookieJar: admin });
    const temp1 = tempPass(r.text);
    check('временный пароль показан (12 символов)', !!temp1 && temp1.length === 12);
    r = await req('GET', '/admin/credentials', { cookieJar: admin });
    check('повторно пароль не показывается', !tempPass(r.text) && r.text.includes('больше не показывается'));
    check('в БД лежит только хэш, пароль в журнале админа отсутствует', newDoc.password_hash !== temp1 && !JSON.stringify(db.prepare('SELECT * FROM admin_action_log').all()).includes(temp1));
    r = await req('POST', '/admin/users', { cookieJar: admin, body: { full_name: 'Дубль', email: 'NEW.doc@example.com', role: 'psychiatrist' } });
    check('дубликат e-mail (без учёта регистра) -> 422', r.status === 422 && r.text.includes('уже есть'));
    r = await req('POST', '/admin/users', { cookieJar: admin, body: { full_name: 'Пациент', email: 'p@example.com', role: 'patient' } });
    check('админом нельзя создать пациента через форму сотрудника', r.status === 422 && !one("SELECT 1 FROM users WHERE email = 'p@example.com'"));
    const nd = jar();
    r = await req('POST', '/login', { cookieJar: nd, body: { email: 'new.doc@example.com', password: temp1 } });
    check('вход с временным паролем -> /account/password', r.status === 302 && r.location === '/account/password');
    r = await req('GET', '/patients', { cookieJar: nd });
    check('до смены пароля остальные разделы недоступны (редирект)', r.status === 302 && r.location === '/account/password');
    r = await req('GET', '/account/password', { cookieJar: nd });
    check('страница смены пароля доступна', r.status === 200 && r.text.includes('Временный пароль'));
    r = await req('POST', '/account/password', { cookieJar: nd, body: { current_password: temp1, new_password: 'short', confirm_password: 'short' } });
    check('слишком короткий новый пароль отклонён', r.status === 302 && one("SELECT must_change_password AS m FROM users WHERE email = 'new.doc@example.com'").m === 1);
    r = await req('POST', '/account/password', { cookieJar: nd, body: { current_password: temp1, new_password: 'new.doc@example.com', confirm_password: 'new.doc@example.com' } });
    check('пароль, равный e-mail, отклонён', one("SELECT must_change_password AS m FROM users WHERE email = 'new.doc@example.com'").m === 1);
    r = await req('POST', '/account/password', { cookieJar: nd, body: { current_password: 'wrong-password', new_password: 'good-password-1', confirm_password: 'good-password-1' } });
    check('неверный текущий пароль отклонён', one("SELECT must_change_password AS m FROM users WHERE email = 'new.doc@example.com'").m === 1);
    r = await req('POST', '/account/password', { cookieJar: nd, body: { current_password: temp1, new_password: 'good-password-1', confirm_password: 'good-password-1' } });
    check('смена пароля успешна -> /dashboard', r.status === 302 && r.location === '/dashboard' && one("SELECT must_change_password AS m FROM users WHERE email = 'new.doc@example.com'").m === 0);
    r = await req('GET', '/patients', { cookieJar: nd });
    check('после смены кабинет врача доступен', r.status === 200);

    console.log('6) Сброс пароля: потерял -> админ -> вход -> принудительная смена; старые сессии завершены');
    const patOld = await loginOk('patient2.worsening@example.com');
    r = await req('GET', '/dashboard', { cookieJar: patOld });
    check('сессия пациента до сброса работает', r.status === 200);
    await sleep(15);
    r = await req('GET', `/admin/users/${ids.p2}/reset`, { cookieJar: admin });
    check('шаг подтверждения сброса с пояснением последствий', r.status === 200 && r.text.includes('Что произойдёт') && r.text.includes('Все сессии'));
    r = await req('POST', `/admin/users/${ids.p2}/reset`, { cookieJar: admin, body: {} });
    check('сброс -> показ пароля', r.status === 302 && r.location === '/admin/credentials');
    r = await req('GET', '/admin/credentials', { cookieJar: admin });
    const temp2 = tempPass(r.text);
    check('временный пароль выдан', !!temp2);
    r = await req('GET', '/dashboard', { cookieJar: patOld });
    check('старая сессия пациента завершена (редирект на вход)', r.status === 302 && r.location === '/login');
    r = await req('POST', '/login', { cookieJar: jar(), body: { email: 'patient2.worsening@example.com', password: DEMO_PASSWORD } });
    check('старый пароль не подходит', r.status === 302 && r.location === '/login');
    const pn = jar();
    r = await req('POST', '/login', { cookieJar: pn, body: { email: 'patient2.worsening@example.com', password: temp2 } });
    check('вход по временному -> принудительная смена', r.location === '/account/password');
    r = await req('GET', '/dashboard', { cookieJar: pn });
    check('до смены пациентский кабинет закрыт', r.status === 302 && r.location === '/account/password');
    r = await req('POST', '/account/password', { cookieJar: pn, body: { current_password: temp2, new_password: 'brand-new-pass-1', confirm_password: 'brand-new-pass-1' } });
    r = await req('GET', '/dashboard', { cookieJar: pn });
    check('после смены кабинет пациента открыт', r.status === 200);
    const log = db.prepare("SELECT * FROM admin_action_log WHERE action = 'password_reset'").all();
    check('сброс записан в admin_action_log (кто, над кем), пароля в журнале нет', log.length === 1 && log[0].admin_id === ids.admin && log[0].target_user_id === ids.p2 && !JSON.stringify(log).includes(temp2));
    r = await req('POST', `/admin/users/${ids.admin}/reset`, { cookieJar: admin, body: {} });
    check('свой пароль админ сбросить не может', r.status === 302 && count("SELECT COUNT(*) AS n FROM admin_action_log WHERE action = 'password_reset'") === 1);
    // смена пароля завершает остальные сессии
    const s1 = await loginOk('patient2.worsening@example.com', 'brand-new-pass-1');
    const s2 = await loginOk('patient2.worsening@example.com', 'brand-new-pass-1');
    await sleep(15);
    await req('POST', '/account/password', { cookieJar: s1, body: { current_password: 'brand-new-pass-1', new_password: 'even-newer-pass-2', confirm_password: 'even-newer-pass-2' } });
    r = await req('GET', '/dashboard', { cookieJar: s2 });
    check('смена пароля завершает остальные сессии', r.status === 302 && r.location === '/login');
    r = await req('GET', '/dashboard', { cookieJar: s1 });
    check('текущая сессия остаётся', r.status === 200);

    console.log('7) Список пользователей, деактивация/активация');
    r = await req('GET', '/admin/users?role=psychiatrist&q=%D0%BE%D1%80%D0%BB%D0%BE%D0%B2', { cookieJar: admin });
    check('фильтр роль + поиск (без учёта регистра)', r.status === 200 && r.text.includes('Орлов') && !r.text.includes('Крылова'));
    r = await req('GET', '/admin/users?status=password', { cookieJar: admin });
    check('фильтр «ждёт смены пароля» пуст -> пояснение, не пустая таблица', r.status === 200 && (r.text.includes('Никого не найдено') || r.text.includes('<tbody>')));
    r = await req('GET', `/admin/users/${ids.psy1}/deactivate`, { cookieJar: admin });
    check('деактивация врача: шаг подтверждения показывает пациентов и эскалации', r.status === 200 && r.text.includes('Что произойдёт') && r.text.includes('закреплено пациентов'));
    r = await req('POST', `/admin/users/${ids.admin}/deactivate`, { cookieJar: admin, body: {} });
    check('нельзя деактивировать себя', !one('SELECT deactivated_at AS d FROM users WHERE id = ?', ids.admin).d);
    check('нельзя деактивировать последнего администратора', core.deactivate(9999, ids.admin).ok === false && /последнего/.test(core.deactivate(9999, ids.admin).error));
    await sleep(15);
    r = await req('POST', `/admin/users/${ids.psy3}/deactivate`, { cookieJar: admin, body: {} });
    const psy3jar = null;
    check('деактивация применена и записана в журнал', !!one('SELECT deactivated_at AS d FROM users WHERE id = ?', ids.psy3).d && count("SELECT COUNT(*) AS n FROM admin_action_log WHERE action = 'user_deactivate'") >= 1);
    r = await req('POST', '/login', { cookieJar: jar(), body: { email: 'psychiatrist3@example.com', password: DEMO_PASSWORD } });
    check('деактивированный не входит', r.status === 302 && r.location === '/login');
    const active3 = await (async () => { await req('POST', `/admin/users/${ids.psy3}/activate`, { cookieJar: admin, body: {} }); return loginOk('psychiatrist3@example.com'); })();
    r = await req('GET', '/dashboard', { cookieJar: active3 });
    check('после активации вход возможен', r.status === 200);
    await sleep(15);
    await req('POST', `/admin/users/${ids.psy3}/deactivate`, { cookieJar: admin, body: {} });
    r = await req('GET', '/dashboard', { cookieJar: active3 });
    check('сессия деактивированного завершается сразу', r.status === 302 && r.location === '/login');
    await req('POST', `/admin/users/${ids.psy3}/activate`, { cookieJar: admin, body: {} });

    console.log('8) Привязки: массовое переназначение при уходе врача; эскалации видны новому врачу');
    const psy1Patients = db.prepare('SELECT patient_id FROM care_assignments WHERE clinician_id = ? ORDER BY patient_id').all(ids.psy1).map((x) => x.patient_id);
    const three = [ids.p1, ids.p2, ids.p8];
    check('у психиатра 1 есть эти пациенты', three.every((p) => psy1Patients.includes(p)));
    r = await req('GET', `/admin/assignments/reassign?from=${ids.psy1}`, { cookieJar: admin });
    check('форма переназначения показывает пациентов и открытые эскалации', r.status === 200 && r.text.includes('Громов') && r.text.includes('открытых эскалаций'));
    const psy3b = await loginOk('psychiatrist3@example.com');
    r = await req('GET', '/crisis', { cookieJar: psy3b });
    check('до переназначения новый врач не видит эскалаций Громова', !r.text.includes('Громов'));
    r = await req('POST', '/admin/assignments/reassign', { cookieJar: admin, body: { from: String(ids.psy1), to: String(ids.psy3), patient_ids: three.map(String) } });
    check('переназначение трёх пациентов', r.status === 302 && three.every((p) => !!one('SELECT 1 FROM care_assignments WHERE patient_id = ? AND clinician_id = ?', p, ids.psy3) && !one('SELECT 1 FROM care_assignments WHERE patient_id = ? AND clinician_id = ?', p, ids.psy1)));
    r = await req('GET', '/crisis', { cookieJar: psy3b });
    check('открытая эскалация Громова видна новому врачу', r.text.includes('Громов'));
    r = await req('GET', '/crisis', { cookieJar: psy1 });
    check('прежний врач её больше не видит', !r.text.includes('Громов'));
    check('переназначение записано в журнал по каждому пациенту', count("SELECT COUNT(*) AS n FROM admin_action_log WHERE action = 'assignment_move'") === 3);
    r = await req('GET', `/admin/assignments/unassign?patient_id=${ids.zorina}&clinician_id=${ids.psy2}`, { cookieJar: admin });
    check('снятие специалиста: перед снятием видны открытые эскалации', r.status === 200 && r.text.includes('Открытых эскалаций пациента'));
    r = await req('POST', '/admin/assignments/assign', { cookieJar: admin, body: { patient_id: String(ids.fomin), clinician_id: String(ids.psy3) } });
    check('назначение специалиста пациенту без врача', !!one('SELECT 1 FROM care_assignments WHERE patient_id = ? AND clinician_id = ?', ids.fomin, ids.psy3));
    r = await req('POST', '/admin/assignments/unassign', { cookieJar: admin, body: { patient_id: String(ids.fomin), clinician_id: String(ids.psy3) } });
    check('снятие специалиста', !one('SELECT 1 FROM care_assignments WHERE patient_id = ? AND clinician_id = ?', ids.fomin, ids.psy3));
    r = await req('GET', '/admin/assignments?clinician=none', { cookieJar: admin });
    check('фильтр «без активного врача» показывает Фомина', r.status === 200 && r.text.includes('Фомин'));

    console.log('9) Очередь «Без врача» (CRI-007, ADM-009)');
    const queue = require('../src/admin_queue');
    const nb0 = queue.countOpen();
    const eid = escalation.createEscalation({ patientId: ids.fomin, instrument: 'phq9', reasons: ['СЕКРЕТНАЯ-ЦИТАТА-ПАЦИЕНТА'], tier: 3, triggers: ['C'] });
    check('счётчик очереди вырос на 1', queue.countOpen() === nb0 + 1);
    r = await req('GET', '/admin/nobody', { cookieJar: admin });
    check('запись видна админу: пациент, Tier 3, SLA', r.status === 200 && r.text.includes('Фомин') && r.text.includes('Уровень 3') && /sla__text/.test(r.text));
    check('цитата/причина администратору НЕ показывается', !r.text.includes('СЕКРЕТНАЯ-ЦИТАТА'));
    r = await req('GET', '/dashboard', { cookieJar: admin });
    check('бейдж в меню админа равен числу записей', new RegExp(`aria-label="требует решения: ${nb0 + 1}"`).test(r.text));
    db.prepare("INSERT INTO patient_contact_requests (patient_id, clinician_id, to_admin, text) VALUES (?, NULL, 1, 'СЕКРЕТНЫЙ-ТЕКСТ-ОБРАЩЕНИЯ')").run(ids.fomin);
    db.prepare("INSERT INTO patient_appeals (patient_id, clinician_id, routed_to, message, status, created_at) VALUES (?, NULL, 'admin', 'СЕКРЕТНОЕ-СООБЩЕНИЕ', 'open', datetime('now'))").run(ids.fomin);
    r = await req('GET', '/admin/nobody', { cookieJar: admin });
    check('обращения пациента без врача видны с меткой, текст скрыт', (r.text.match(/Обращение пациента/g) || []).length >= 2 && !r.text.includes('СЕКРЕТНЫЙ-ТЕКСТ') && !r.text.includes('СЕКРЕТНОЕ-СООБЩЕНИЕ'));
    // подтвердить обращение
    const contactRef = `c${one("SELECT id FROM patient_contact_requests WHERE patient_id = ?", ids.fomin).id}`;
    r = await req('POST', `/admin/nobody/${contactRef}/acknowledge`, { cookieJar: admin, body: {} });
    check('«Подтвердить» обращение: статус handled', one('SELECT status FROM patient_contact_requests WHERE patient_id = ?', ids.fomin).status === 'handled');
    // передать врачу эскалацию
    r = await req('POST', `/admin/nobody/e${eid}/handover`, { cookieJar: admin, body: { clinician_id: String(ids.psy2) } });
    check('«Передать врачу»: пациент привязан, эскалация остаётся открытой', !!one('SELECT 1 FROM care_assignments WHERE patient_id = ? AND clinician_id = ?', ids.fomin, ids.psy2) && one('SELECT status FROM crisis_escalations WHERE id = ?', eid).status === 'open');
    r = await req('GET', '/crisis', { cookieJar: psy2 });
    check('эскалация видна выбранному врачу', r.text.includes('Фомин'));
    r = await req('GET', '/admin/nobody', { cookieJar: admin });
    check('из очереди админа она ушла', !queue.findOpen(`e${eid}`));
    // подтверждение эскалации админом
    const eid2 = escalation.createEscalation({ patientId: uid('patient4.inactive@example.com'), instrument: 'chatbot', reasons: ['x'], tier: 2, triggers: ['E'] });
    // врач пациента (психолог1) деактивируется -> эскалация попадает в «Без врача»
    const hasPsycho = db.prepare('SELECT clinician_id FROM care_assignments WHERE patient_id = ?').all(uid('patient4.inactive@example.com'));
    check('у пациента один врач (сид)', hasPsycho.length === 1);
    check('пока врач активен, в очереди админа её нет', !queue.findOpen(`e${eid2}`));
    db.prepare("UPDATE users SET deactivated_at = datetime('now') WHERE id = ?").run(hasPsycho[0].clinician_id);
    check('врач деактивирован -> эскалация в очереди «Без врача»', !!queue.findOpen(`e${eid2}`));
    r = await req('POST', `/admin/nobody/e${eid2}/acknowledge`, { cookieJar: admin, body: {} });
    const e2 = one('SELECT status, acknowledged_by FROM crisis_escalations WHERE id = ?', eid2);
    check('подтверждение админом: статус и журнал инцидентов', e2.status === 'acknowledged' && e2.acknowledged_by === ids.admin && count("SELECT COUNT(*) AS n FROM crisis_incident_log WHERE escalation_id = ? AND event_type = 'acknowledged' AND actor_id = ?", eid2, ids.admin) === 1);
    db.prepare('UPDATE users SET deactivated_at = NULL WHERE id = ?').run(hasPsycho[0].clinician_id);
    check('действия очереди записаны в admin_action_log', count("SELECT COUNT(*) AS n FROM admin_action_log WHERE action IN ('queue_acknowledge','queue_handover')") >= 3);
    r = await req('POST', '/admin/nobody/e999999/acknowledge', { cookieJar: admin, body: {} });
    check('несуществующая запись: ошибка без падения', r.status === 302);
    r = await req('POST', `/admin/nobody/e${eid}/acknowledge`, { cookieJar: psy1, body: {} });
    check('врач не может пользоваться очередью админа (403)', r.status === 403);

    console.log('9b) E2E CRI-007: пациент без врача сам создаёт эскалацию -> запись у админа');
    const nodoc = await loginOk('patient6.nodoctor@example.com');
    db.prepare('DELETE FROM care_assignments WHERE patient_id = ?').run(ids.fomin);
    const nbBefore = queue.countOpen();
    const asg = db.prepare("INSERT INTO instrument_assignments (patient_id, assigned_by, instrument) VALUES (?, ?, 'phq9')").run(ids.fomin, ids.psy1).lastInsertRowid;
    r = await req('POST', `/assignments/${asg}/submit`, { cookieJar: nodoc, body: { item_0: '1', item_1: '1', item_2: '1', item_3: '1', item_4: '1', item_5: '1', item_6: '1', item_7: '1', item_8: '2' } });
    check('PHQ-9 с пунктом 9 > 0 без врача: эскалация создана', r.status === 302 && count("SELECT COUNT(*) AS n FROM crisis_escalations WHERE patient_id = ? AND instrument = 'phq9' AND status = 'open'", ids.fomin) >= 1);
    check('у админа появилась запись (счётчик вырос)', queue.countOpen() > nbBefore);
    const nbBefore2 = queue.countOpen();
    r = await req('POST', '/chat/send', { cookieJar: nodoc, body: { text: 'я не хочу жить' } });
    check('кризисная фраза в чате без врача -> ещё одна запись у админа (AIP-007)', queue.countOpen() > nbBefore2);
    r = await req('GET', '/admin/nobody', { cookieJar: admin });
    check('на экране «Без врача» видно пациента', r.text.includes('Фомин'));

    console.log('10) Удаление данных по запросу (ADM-006)');
    const dd = seedDeletionPatient();
    const patDel = await loginOk('del.patient@example.com', 'password123');
    r = await req('POST', '/account/deletion-request', { cookieJar: patDel, body: {} });
    check('пациент запросил удаление', r.status === 302 && one('SELECT account_status AS s FROM users WHERE id = ?', dd.id).s === 'deletion_requested');
    const dsr = one("SELECT * FROM data_subject_requests WHERE patient_id = ? AND request_type = 'consent_revocation_and_deletion'", dd.id);
    r = await req('GET', '/admin/deletion', { cookieJar: admin });
    check('очередь: запрос с датой, сроком и статусом', r.status === 200 && r.text.includes('Del Patient') && r.text.includes('ожидает исполнения') && r.text.includes('Ожидаемый срок'));
    r = await req('GET', `/admin/deletion/${dsr.id}`, { cookieJar: admin });
    check('шаг 1: перечень категорий (результаты, дневник, чаты, напоминания, файлы) и что останется', ['Результаты онлайн-тестов', 'Дневник настроения', 'Напоминания', 'Сообщения чат-бота', 'Что останется', 'ai_materials'].every((t) => r.text.includes(t)));
    r = await req('POST', `/admin/deletion/${dsr.id}/execute`, { cookieJar: admin, body: { confirm_email: 'wrong@example.com' } });
    check('шаг 2: неверный e-mail -> отказ, ничего не удалено', r.status === 422 && count('SELECT COUNT(*) AS n FROM mood_entries WHERE patient_id = ?', dd.id) === 2);
    r = await req('POST', `/admin/deletion/${dsr.id}/execute`, { cookieJar: admin, body: { confirm_email: 'del.patient@example.com' } });
    check('открытая эскалация без осознанного подтверждения -> отказ', r.status === 422 && /эскалаци/.test(r.text) && count('SELECT COUNT(*) AS n FROM mood_entries WHERE patient_id = ?', dd.id) === 2);
    // откат: триггер ломает удаление метки
    db.exec("CREATE TRIGGER fail_del BEFORE DELETE ON patient_tags BEGIN SELECT RAISE(ABORT, 'test-fail'); END;");
    r = await req('POST', `/admin/deletion/${dsr.id}/execute`, { cookieJar: admin, body: { confirm_email: 'del.patient@example.com', force_open: '1' } });
    check('сбой посреди удаления: транзакция откатана, всё на месте', r.status === 422 && count('SELECT COUNT(*) AS n FROM mood_entries WHERE patient_id = ?', dd.id) === 2 && count('SELECT COUNT(*) AS n FROM online_results WHERE patient_id = ?', dd.id) === 1 && fs.existsSync(dd.fileA) && one('SELECT status FROM data_subject_requests WHERE id = ?', dsr.id).status === 'pending' && one("SELECT status FROM crisis_escalations WHERE id = ?", dd.escId).status === 'open');
    check('после отката foreign_keys снова включены', db.pragma('foreign_keys', { simple: true }) === 1);
    db.exec('DROP TRIGGER fail_del');
    const phiBefore = count('SELECT COUNT(*) AS n FROM phi_access_log WHERE patient_id = ?', dd.id);
    const auditBefore = count('SELECT COUNT(*) AS n FROM ai_audit WHERE user_id = ?', dd.id);
    r = await req('POST', `/admin/deletion/${dsr.id}/execute`, { cookieJar: admin, body: { confirm_email: 'del.patient@example.com', force_open: '1' } });
    check('исполнение -> редирект на отчёт', r.status === 302 && r.location === `/admin/deletion/${dsr.id}`);
    const clinicalTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name).filter((t) => !['users', 'phi_access_log', 'data_subject_requests', 'crisis_incident_log', 'crisis_escalations', 'admin_action_log', 'export_audit_log', 'ai_audit'].includes(t) && db.prepare(`PRAGMA table_info("${t}")`).all().some((c) => c.name === 'patient_id'));
    check('все таблицы с patient_id: строк пациента не осталось', clinicalTables.length > 8 && clinicalTables.every((t) => count(`SELECT COUNT(*) AS n FROM "${t}" WHERE patient_id = ?`, dd.id) === 0));
    check('сообщения чат-бота и ИИ-чата удалены', count('SELECT COUNT(*) AS n FROM chatbot_messages WHERE session_id = ?', dd.sessionId) === 0 && count('SELECT COUNT(*) AS n FROM ai_messages WHERE thread_id = ?', dd.threadId) === 0 && count('SELECT COUNT(*) AS n FROM ai_threads WHERE id = ?', dd.threadId) === 0);
    check('файлы на диске удалены (и каталог пациента)', !fs.existsSync(dd.fileA) && !fs.existsSync(dd.fileB) && !fs.existsSync(path.dirname(dd.fileA)));
    check('файл вне каталога данных не тронут', fs.existsSync(dd.outsideFile));
    const u = one('SELECT * FROM users WHERE id = ?', dd.id);
    check('учётная запись обезличена: ни ФИО, ни e-mail, вход невозможен', u.account_status === 'deleted' && u.full_name === 'Удалённый пользователь' && !/del\.patient/.test(u.email) && u.consent_given === 0);
    r = await req('POST', '/login', { cookieJar: jar(), body: { email: 'del.patient@example.com', password: 'password123' } });
    check('вход под удалённым невозможен', r.status === 302 && r.location === '/login');
    const esc = one('SELECT * FROM crisis_escalations WHERE id = ?', dd.escId);
    check('кризисная запись: факт остался, текст цитаты стёрт, эскалация закрыта', esc && !esc.reasons_json.includes('СЕКРЕТ') && esc.status === 'acknowledged' && esc.tier === 2);
    check('журнал инцидентов: события остались, текст стёрт', count('SELECT COUNT(*) AS n FROM crisis_incident_log WHERE escalation_id = ?', dd.escId) >= 2 && !JSON.stringify(db.prepare('SELECT detail_json FROM crisis_incident_log WHERE escalation_id = ?').all(dd.escId)).includes('СЕКРЕТ'));
    check('журналы аудита (phi, ai_audit) на месте', count('SELECT COUNT(*) AS n FROM phi_access_log WHERE patient_id = ?', dd.id) === phiBefore && count('SELECT COUNT(*) AS n FROM ai_audit WHERE user_id = ?', dd.id) === auditBefore && phiBefore > 0);
    const done = one('SELECT * FROM data_subject_requests WHERE id = ?', dsr.id);
    const rep = JSON.parse(done.report_json);
    check('запись о факте: статус, дата, кто, отчёт без ПД', done.status === 'executed' && !!done.executed_at && done.executed_by === ids.admin && rep.deleted_total > 8 && rep.files_deleted >= 2 && !/del\.patient|СЕКРЕТ|Del Patient/.test(done.report_json));
    check('в admin_action_log: deletion_execute', count("SELECT COUNT(*) AS n FROM admin_action_log WHERE action = 'deletion_execute' AND target_user_id = ?", dd.id) === 1);
    r = await req('GET', `/admin/deletion/${dsr.id}`, { cookieJar: admin });
    check('отчёт «что удалено» доступен в интерфейсе', r.status === 200 && r.text.includes('Отчёт: что удалено') && r.text.includes('Что осталось'));
    r = await req('POST', `/admin/deletion/${dsr.id}/execute`, { cookieJar: admin, body: { confirm_email: 'deleted-x@deleted.invalid' } });
    check('повторное исполнение невозможно', r.status === 422);
    check('псевдоним для экспорта удалён', count('SELECT COUNT(*) AS n FROM research_pseudonyms WHERE patient_id = ?', dd.id) === 0);

    console.log('11) Журналы аудита (ADM-008): фильтры, пагинация, CSV, только чтение');
    db.prepare("INSERT INTO phi_access_log (actor_id, patient_id, action) VALUES (?, ?, 'view_patient_detail')").run(ids.psy2, ids.zorina);
    r = await req('GET', '/admin/audit?log=phi&subject=%D0%B7%D0%BE%D1%80%D0%B8%D0%BD%D0%B0', { cookieJar: admin });
    check('фильтр «чьи данные» по ФИО: только Зорина', r.status === 200 && r.text.includes('Зорина') && !r.text.includes('Светлова') && /Найдено записей: \d+/.test(r.text));
    r = await req('GET', `/admin/audit?log=phi&who=${ids.psy2}&action=%D0%BA%D0%B0%D1%80%D1%82%D0%BE%D1%87%D0%BA%D0%B0`, { cookieJar: admin });
    check('фильтр «кто» (№) и «действие»', r.status === 200 && r.text.includes('Крылова') && !r.text.includes('Орлов'));
    r = await req('GET', '/admin/audit?log=phi&from=2999-01-01', { cookieJar: admin });
    check('период без записей -> пояснение', r.text.includes('Записей нет'));
    for (const l of ['phi', 'export', 'ai', 'dsr', 'admin']) {
      const x = await req('GET', `/admin/audit?log=${l}`, { cookieJar: admin });
      check(`журнал ${l} открывается`, x.status === 200);
    }
    const big = audit.query('phi', {});
    check('пагинация по 50', big.pageRows.length <= 50 && big.pages === Math.ceil(big.total / 50));
    r = await req('GET', '/admin/audit?log=admin&format=csv', { cookieJar: admin, raw: true });
    const csv = r.bytes.toString('utf8');
    check('CSV: BOM, разделитель «;», заголовки', r.status === 200 && r.bytes[0] === 0xef && r.bytes[1] === 0xbb && r.bytes[2] === 0xbf && csv.includes(';') && /text\/csv/.test(r.headers.get('content-type')));
    check('выгрузка попала в журнал администраторов', count("SELECT COUNT(*) AS n FROM admin_action_log WHERE action = 'audit_export'") === 1);
    check('CSV защищён от формул', audit.csvCell('=1+1') === "'=1+1" && audit.csvCell('@x') === "'@x" && audit.csvCell('a;b') === '"a;b"');
    // журналы не изменяются: нет маршрутов DELETE/PUT/PATCH и изменяющих POST для журналов
    const routes = [];
    const walk = (stack) => stack.forEach((l) => { if (l.route) routes.push({ path: l.route.path, methods: Object.keys(l.route.methods) }); else if (l.handle && l.handle.stack) walk(l.handle.stack); });
    walk(app._router.stack);
    check('нет маршрутов DELETE/PUT/PATCH вообще', !routes.some((x) => x.methods.some((m) => ['delete', 'put', 'patch'].includes(m))));
    check('нет изменяющих маршрутов у журналов', !routes.some((x) => /\/audit/i.test(String(x.path)) && x.methods.some((m) => m !== 'get')));
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'src', 'admin_audit.js'), 'utf8');
    check('код журналов не содержит UPDATE/DELETE над таблицами журналов', !/(UPDATE|DELETE FROM)\s+(phi_access_log|export_audit_log|ai_audit|admin_action_log)/i.test(src));

    console.log('12) Приглашения (админ выдаёт и смотрит)');
    r = await req('POST', '/admin/invites', { cookieJar: admin, body: { clinician_id: String(ids.psy2), days: '7' } });
    const newInv = one('SELECT * FROM invite_codes WHERE clinician_id = ? ORDER BY id DESC', ids.psy2);
    check('код выдан админом, срок 7 дней, одноразовый', r.status === 302 && newInv && newInv.created_by === ids.admin && !newInv.used_by);
    r = await req('GET', '/admin/invites', { cookieJar: admin });
    check('список кодов: код, специалист, статус', r.status === 200 && r.text.includes(newInv.code) && r.text.includes('активен'));
    r = await req('POST', `/admin/invites/${newInv.id}/revoke`, { cookieJar: admin, body: {} });
    check('код отозван', !!one('SELECT revoked_at AS r FROM invite_codes WHERE id = ?', newInv.id).r);

    console.log('13) Система и согласия (ADM-010/012)');
    r = await req('GET', '/admin/system', { cookieJar: admin });
    check('Система: версия, режим, роли, SLA', r.status === 200 && r.text.includes('Версия') && r.text.includes('Режим') && r.text.includes('SLA'));
    check('предупреждение о соли псевдонимизации (по умолчанию)', r.text.includes('RESEARCH_PSEUDONYM_SALT'));
    check('SESSION_SECRET задан — предупреждения о нём нет', !r.text.includes('SESSION_SECRET не задан'));
    r = await req('GET', '/admin/consents', { cookieJar: admin });
    check('Согласия: статусы без клинических данных, отозванное видно', r.status === 200 && r.text.includes('Алексеева') && r.text.includes('отозвано'));

    console.log('14) Научный экспорт читает comparison_pairs (TLS-004, SEC-013)');
    const exportsBefore = count('SELECT COUNT(*) AS n FROM export_audit_log');
    const rows = researchExport.generateComparisonExport({ runBy: ids.psy1 });
    check('запуск экспорта журналируется', count('SELECT COUNT(*) AS n FROM export_audit_log') === exportsBefore + 1 && one('SELECT row_count AS n FROM export_audit_log ORDER BY id DESC').n === rows.length);
    const eligiblePairs = db.prepare(
      `SELECT cp.id FROM comparison_pairs cp JOIN users u ON u.id = cp.patient_id
       WHERE u.anonymized_export_opt_in = 1 AND u.export_consent_revoked_at IS NULL AND u.account_status = 'active'`
    ).all().length;
    check('число строк = числу пар сравнения с действующим согласием', rows.length === eligiblePairs && rows.length > 0);
    check('cross-instrument и окна из comparison_pairs присутствуют в датасете', rows.every((x) => ['same_scale_within_window', 'same_scale_wide_window', 'cross_instrument'].includes(x.comparability)));
    const revokedId = uid('patient7.revoked@example.com');
    const revokedPseudo = db.prepare('SELECT pseudonym FROM research_pseudonyms WHERE patient_id = ?').get(revokedId);
    check('пациент с отозванным согласием исключён (псевдоним не создан)', !revokedPseudo);
    // заметка врача и заглушки не попадают
    const anyPair = db.prepare('SELECT cp.id FROM comparison_pairs cp JOIN users u ON u.id = cp.patient_id WHERE u.anonymized_export_opt_in = 1 LIMIT 1').get();
    db.prepare("UPDATE comparison_pairs SET clinician_note = 'СЕКРЕТНАЯ-ЗАМЕТКА-ВРАЧА' WHERE id = ?").run(anyPair.id);
    const rowsAfterNote = researchExport.generateComparisonExport({ runBy: ids.psy1 });
    const csvText = researchExport.toCsv(rowsAfterNote);
    check('clinician_note и ФИО/e-mail в CSV отсутствуют', !csvText.includes('СЕКРЕТНАЯ') && !/Светлова|example\.com/.test(csvText));
    check('CSV: BOM, разделитель «;», CRLF', csvText.startsWith('﻿patient_pseudonym;online_scale;offline_scale;comparability') && csvText.includes('\r\n') && !csvText.split('\r\n')[1].includes(','));
    const stubPatient = db.prepare('SELECT cp.patient_id AS pid FROM comparison_pairs cp JOIN users u ON u.id = cp.patient_id WHERE u.anonymized_export_opt_in = 1 LIMIT 1').get().pid;
    const on = db.prepare("INSERT INTO online_results (patient_id, instrument, answers_json, total_score) VALUES (?, 'bai', '[1,1,1]', 3)").run(stubPatient).lastInsertRowid;
    const off = db.prepare("INSERT INTO offline_results (patient_id, entered_by, instrument, total_score, test_date) VALUES (?, ?, 'bai', 3, date('now'))").run(stubPatient, ids.psy1).lastInsertRowid;
    db.prepare("INSERT INTO comparison_pairs (patient_id, online_result_id, offline_result_id, online_scale, offline_scale, comparability, time_delta_days) VALUES (?, ?, ?, 'bai', 'bai', 'same_scale_within_window', 1)").run(stubPatient, on, off);
    check('пары по методикам-заглушкам исключены', researchExport.generateComparisonExport({ runBy: ids.psy1 }).length === rows.length);
    check('экранирование формул', researchExport.csvCell('=cmd|calc') === "'=cmd|calc" && researchExport.csvCell('+1') === "'+1" && researchExport.csvCell('-1x') === "'-1x" && researchExport.csvCell('@a') === "'@a" && researchExport.csvCell(-3) === '-3');
    db.prepare('UPDATE users SET anonymized_export_opt_in = 0 WHERE id = ?').run(stubPatient);
    check('снятое согласие немедленно исключает пациента', researchExport.generateComparisonExport({ runBy: null }).every((x) => x.patient_pseudonym !== researchExport.getOrCreatePseudonym(stubPatient)));

    console.log('15) Демо-добавка и пустые состояния');
    check('seed-admin-demo идемпотентен', seedAdminDemo().skipped === false && seedAdminDemo().skipped === true);
    r = await req('GET', '/admin/nobody', { cookieJar: admin });
    check('очередь после демо-добавки непуста', r.status === 200 && r.text.includes('Передать врачу'));
    const adm2 = core.createStaff(ids.admin, { full_name: 'Второй Админ', email: 'admin2@example.com', role: 'admin' });
    check('админ может создать другого админа', adm2.ok && one('SELECT role FROM users WHERE id = ?', adm2.id).role === 'admin');
  } finally {
    server.close();
  }

  if (failures) { console.error(`\n${failures} проверок не прошло (прошло ${oks}).`); process.exit(1); }
  console.log(`\nВсе проверки кабинета администратора прошли успешно. (${oks})`);
  process.exit(0);
}

/** Пациент с данными по всем категориям + файлы на диске. Всё синтетическое. */
function seedDeletionPatient() {
  const bcrypt = require('bcryptjs');
  const info = db.prepare(
    `INSERT INTO users (email, password_hash, role, full_name, consent_given, consent_version, consent_at, clinical_consent_given, clinical_consent_at, anonymized_export_opt_in)
     VALUES ('del.patient@example.com', ?, 'patient', 'Del Patient', 1, 'v', datetime('now'), 1, datetime('now'), 1)`
  ).run(bcrypt.hashSync('password123', 4));
  const id = Number(info.lastInsertRowid);
  const psy = uid('psychiatrist2@example.com');
  db.prepare('INSERT INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(id, psy);
  const ia = db.prepare("INSERT INTO instrument_assignments (patient_id, assigned_by, instrument, status) VALUES (?, ?, 'phq9', 'completed')").run(id, psy).lastInsertRowid;
  const on = db.prepare("INSERT INTO online_results (assignment_id, patient_id, instrument, answers_json, total_score) VALUES (?, ?, 'phq9', '[1,1,1,1,1,1,1,1,0]', 8)").run(ia, id).lastInsertRowid;
  const off = db.prepare("INSERT INTO offline_results (patient_id, entered_by, instrument, total_score, test_date, notes) VALUES (?, ?, 'phq9', 9, date('now'), 'заметка')").run(id, psy).lastInsertRowid;
  db.prepare("INSERT INTO comparison_pairs (patient_id, online_result_id, offline_result_id, online_scale, offline_scale, comparability, time_delta_days) VALUES (?, ?, ?, 'phq9', 'phq9', 'same_scale_within_window', 1)").run(id, on, off);
  db.prepare("INSERT INTO catalog_protocols (patient_id, entered_by, instrument, test_date, protocol_json) VALUES (?, ?, 'schulte', date('now'), '{}')").run(id, psy);
  db.prepare("INSERT INTO mood_entries (patient_id, mood_score, note) VALUES (?, 5, 'дневник 1')").run(id);
  db.prepare("INSERT INTO mood_entries (patient_id, mood_score, note) VALUES (?, 6, 'дневник 2')").run(id);
  db.prepare("INSERT INTO reminders (patient_id, created_by, message, remind_at) VALUES (?, ?, 'напоминание', datetime('now'))").run(id, id);
  const sessionId = db.prepare('INSERT INTO chatbot_sessions (patient_id) VALUES (?)').run(id).lastInsertRowid;
  db.prepare("INSERT INTO chatbot_messages (session_id, sender, text) VALUES (?, 'user', 'привет')").run(sessionId);
  const threadId = db.prepare("INSERT INTO ai_threads (owner_user_id, role, title) VALUES (?, 'patient', 'Диалог')").run(id).lastInsertRowid;
  db.prepare("INSERT INTO ai_messages (thread_id, role, text) VALUES (?, 'user', 'сообщение')").run(threadId);
  db.prepare("INSERT INTO ai_prefs (user_id, intro_seen_at) VALUES (?, datetime('now'))").run(id);
  db.prepare("INSERT INTO ai_audit (user_id, role, thread_id, event) VALUES (?, 'patient', ?, 'message')").run(id, threadId);
  db.prepare("INSERT INTO patient_contact_requests (patient_id, clinician_id, to_admin, text) VALUES (?, ?, 0, 'обращение')").run(id, psy);
  db.prepare("INSERT INTO patient_appeals (patient_id, clinician_id, routed_to, message, status, created_at) VALUES (?, ?, 'clinician', 'тяжело', 'open', datetime('now'))").run(id, psy);
  db.prepare("INSERT INTO patient_tags (clinician_id, patient_id, tag) VALUES (?, ?, 'тег')").run(psy, id);
  db.prepare("INSERT INTO triage_snoozes (clinician_id, patient_id, until) VALUES (?, ?, datetime('now', '+3 days'))").run(psy, id);
  researchExport.getOrCreatePseudonym(id);
  db.prepare("INSERT INTO phi_access_log (actor_id, patient_id, action) VALUES (?, ?, 'view_patient_detail')").run(psy, id);
  // таблица другой волны (материалы ИИ-пространства): удаление универсальное по patient_id и file_path
  db.exec('CREATE TABLE IF NOT EXISTS ai_materials (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER, file_path TEXT)');
  const dir = path.join(deletion.uploadRoot(), String(id));
  fs.mkdirSync(dir, { recursive: true });
  const fileA = path.join(dir, 'a.bin');
  const fileB = path.join(dir, 'b.bin');
  fs.writeFileSync(fileA, 'file-a');
  fs.writeFileSync(fileB, 'file-b');
  db.prepare('INSERT INTO ai_materials (patient_id, file_path) VALUES (?, ?)').run(id, fileA);
  db.prepare('INSERT INTO ai_materials (patient_id, file_path) VALUES (?, ?)').run(id, fileB);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-outside-'));
  const outsideFile = path.join(outsideDir, 'keep.txt');
  fs.writeFileSync(outsideFile, 'outside');
  db.prepare('INSERT INTO ai_materials (patient_id, file_path) VALUES (?, ?)').run(id, outsideFile);
  // открытая эскалация с цитатой + события журнала инцидентов
  const escId = escalation.createEscalation({ patientId: id, instrument: 'chatbot', reasons: ['СЕКРЕТНАЯ-ЦИТАТА: "не хочу жить"'], tier: 2, triggers: ['E'] });
  escalation.logIncident(escId, id, 'manual_review_outcome', psy, { outcome: 'reached', note: 'СЕКРЕТ-заметка врача' });
  db.prepare('UPDATE crisis_escalations SET online_result_id = ? WHERE id = ?').run(on, escId);
  return { id, sessionId, threadId, fileA, fileB, outsideFile, escId };
}

main().catch((e) => { console.error(e); process.exit(1); });
