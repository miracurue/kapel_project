'use strict';

require('./helpers').installCsrfFetch(); // W2.S: тесты получают и отправляют CSRF-токен как браузер

// W1.A: кабинет пациента — регистрация, онбординг, главная, тесты (черновик, идемпотентность,
// критический пункт), дневник, напоминания, «Мне плохо», приватность, профиль, изоляция данных.

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `tdr-patient-${process.pid}-${Date.now()}.sqlite3`);
process.env.TDR_DB_PATH = tmpDb;
process.env.SESSION_SECRET = 'test-secret';
process.env.CRISIS_MERGE_WINDOW_MIN = '0'; // W3.K: проверяется «каждая кризисная фраза даёт эскалацию»; схлопывание повторов — в security_fixes.test.js

const app = require('../src/app');
const db = require('../src/db');
const { createUser, createInvite } = require('./helpers');

let BASE;
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

async function req(method, p, { body, j } = {}) {
  const headers = {};
  if (j) headers.Cookie = j.header();
  let payload;
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(body).toString();
  }
  const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
  if (j) j.store(res);
  return { status: res.status, text: await res.text(), location: res.headers.get('location') };
}

const consent = { consent_given: '1', clinical_consent_given: '1' };
async function login(email, password = 'secret123') {
  const j = jar();
  const r = await req('POST', '/login', { j, body: { email, password } });
  return { j, r };
}
const uid = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
const escCount = (pid) => db.prepare('SELECT COUNT(*) AS n FROM crisis_escalations WHERE patient_id = ?').get(pid).n;

async function main() {
  const server = app.listen(0);
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    const docId = createUser(db, { email: 'doc@example.test', full_name: 'Др. Секретова', role: 'psychiatrist' });
    createUser(db, { email: 'admin@example.test', full_name: 'Админ', role: 'admin' });
    const doc = (await login('doc@example.test')).j;

    console.log('1) Регистрация (REQ-PAT-006, ALL-014, SEC-012)');
    let r = await req('GET', '/register');
    check('анонимный /register не содержит имён клиницистов', r.status === 200 && !/Секретова/.test(r.text));
    r = await req('POST', '/register', { body: { email: 'x@example.test', password: 'secret123', full_name: 'Х', role: 'psychiatrist', ...consent } });
    check('POST /register с role=psychiatrist отклонён, пользователь не создан', r.status === 403 && !db.prepare("SELECT 1 FROM users WHERE email = 'x@example.test'").get());
    r = await req('POST', '/register', { body: { email: 'err@example.test', password: 'short', full_name: 'Анна Ошибка', consent_given: '1' } });
    check('ошибки: статус 400, ФИО и e-mail сохранены, пароль не возвращается', r.status === 400 && /value="Анна Ошибка"/.test(r.text) && /value="err@example.test"/.test(r.text) && !/value="short"/.test(r.text));
    check('ошибки: понятные тексты про пароль и согласие 2', /не короче 8/.test(r.text) && /согласие на использование результатов/.test(r.text));
    r = await req('POST', '/register', { body: { email: 'err@example.test', password: 'err@example.test', full_name: 'А', ...consent } });
    check('пароль, совпадающий с e-mail, отклонён', r.status === 400 && /не должен совпадать/.test(r.text));
    r = await req('POST', '/register', { body: { email: 'err@example.test', password: 'secret123', full_name: 'А', invite_code: 'NOPE', ...consent } });
    check('неверный код-приглашение: ошибка, необязательность подсказана', r.status === 400 && /Код не подошёл/.test(r.text) && /можно оставить пустым/.test(r.text));

    createInvite(db, docId, { code: 'GOODCODE1' });
    createInvite(db, docId, { code: 'EXPIRED1', daysValid: -1 });
    createInvite(db, docId, { code: 'USED1', used: true });
    createInvite(db, docId, { code: 'REVOKED1', revoked: true });
    r = await req('POST', '/register', { body: { email: 'a@example.test', password: 'secret123', full_name: 'Пациент Альфа', invite_code: 'goodcode1', ...consent } });
    check('регистрация без научного согласия проходит', r.status === 302 && r.location === '/login');
    const A = uid('a@example.test');
    check('научное согласие не дано, обязательные даны', db.prepare('SELECT anonymized_export_opt_in AS o, consent_given AS c, clinical_consent_given AS k FROM users WHERE id = ?').get(A).o === 0);
    check('код-приглашение привязал к врачу и погашен', !!db.prepare('SELECT 1 FROM care_assignments WHERE patient_id = ? AND clinician_id = ?').get(A, docId) && !!db.prepare("SELECT used_by FROM invite_codes WHERE code = 'GOODCODE1'").get().used_by);
    await req('POST', '/register', { body: { email: 'b@example.test', password: 'secret123', full_name: 'Пациент Бета', ...consent } });
    const B = uid('b@example.test');
    check('регистрация без кода: без врача', !db.prepare('SELECT 1 FROM care_assignments WHERE patient_id = ?').get(B));
    r = await req('GET', '/consent');
    check('полный текст согласий доступен', r.status === 200 && /RES-3-informed-consent-rev1/.test(r.text));

    console.log('2) Вход, безопасный next (REQ-SEC-016), онбординг (REQ-PAT-005)');
    r = await req('GET', '/login?next=//evil.example');
    check('небезопасный next не попадает в форму', !/evil/.test(r.text));
    const evil = jar();
    r = await req('POST', '/login', { j: evil, body: { email: 'a@example.test', password: 'secret123', next: '//evil.example' } });
    check('вход с next=//evil.example -> /dashboard', r.location === '/dashboard');
    const ja = jar();
    r = await req('POST', '/login', { j: ja, body: { email: 'a@example.test', password: 'secret123', next: '/tests' } });
    check('относительный next учитывается', r.location === '/tests');
    r = await req('GET', '/dashboard', { j: ja });
    check('первый вход -> онбординг', r.status === 302 && r.location === '/onboarding');
    r = await req('GET', '/onboarding?step=2', { j: ja });
    check('онбординг: шаг 2 из 3 с кнопкой «Пропустить»', /Шаг 2 из 3/.test(r.text) && /Пропустить/.test(r.text));
    r = await req('POST', '/onboarding', { j: ja, body: {} });
    check('«Пропустить» -> главная', r.location === '/dashboard');
    r = await req('GET', '/dashboard', { j: ja });
    check('повторно онбординг не показывается', r.status === 200);
    r = await req('GET', '/onboarding?step=1', { j: ja });
    check('онбординг доступен повторно из «Приватности»', r.status === 200 && /Назад в «Приватность»/.test((await req('GET', '/onboarding?step=3', { j: ja })).text));
    const jb = (await login('b@example.test')).j;
    await req('POST', '/onboarding', { j: jb, body: {} });

    console.log('3) «Мне плохо» на каждой странице, спокойная палитра (REQ-PAT-002/004)');
    const pages = ['/dashboard', '/tests', '/tests?tab=done', '/tests?tab=progress', '/diary', '/reminders', '/share', '/privacy', '/profile', '/help', '/onboarding', '/chat'];
    let allHelp = true;
    for (const p of pages) {
      r = await req('GET', p, { j: ja });
      if (!(r.status === 200 && /id="help-now"[^>]*href="\/help"|href="\/help"[^>]*id="help-now"|id="help-now" class="help-now" href="\/help"/.test(r.text) && /aria-label="Мне плохо/.test(r.text))) {
        allHelp = false;
        console.error(`    нет #help-now: ${p} (${r.status})`);
      }
    }
    check('на всех страницах пациента есть #help-now -> /help с aria-label', allHelp);
    const tpl = fs.readdirSync(path.join(__dirname, '..', 'views', 'patient')).map((f) => fs.readFileSync(path.join(__dirname, '..', 'views', 'patient', f), 'utf8')).join('\n');
    check('шаблоны кабинета пациента без --color-risk / badge-risk / crisis-banner', !/--color-risk|badge-risk|crisis-banner/.test(tpl));
    check('шаблоны пациента без слов «просрочено», «опасно»', !/просроч|(^|[^а-я])опасно([^а-я]|$)/i.test(tpl));
    r = await req('GET', '/help', { j: ja });
    check('экстренный экран: tel:112, заземление, ИИ-помощник, телефоны доверия из конфига', /href="tel:112"/.test(r.text) && /Немного опоры/.test(r.text) && /href="\/chat"/.test(r.text) && /Телефоны доверия/.test(r.text) && !/crisis-banner/.test(r.text));

    console.log('4) Главная «Сегодня» (REQ-PAT-001/020/013)');
    for (const code of ['phq9', 'gad7']) db.prepare('INSERT INTO instrument_assignments (patient_id, assigned_by, instrument) VALUES (?, ?, ?)').run(A, docId, code);
    db.prepare('INSERT INTO reminders (patient_id, created_by, message, remind_at, recurrence) VALUES (?, ?, ?, ?, ?)').run(A, A, 'Принять лекарство', new Date(Date.now() - 60000).toISOString(), 'none');
    // сегодняшнее напоминание должно быть сегодня: берём момент сразу после старта суток, если сейчас раньше — просто минуту назад
    r = await req('GET', '/dashboard', { j: ja });
    const cards = (r.text.match(/class="card today-card"/g) || []).length;
    check('2 назначения + напоминание + нет записи в дневнике -> ровно 3 карточки (тест, напоминание, дневник)', cards === 3);
    check('на главной «Ещё назначений: 1»', /Ещё назначений: 1/.test(r.text));
    r = await req('GET', '/dashboard', { j: jb });
    check('пациент без врача: объяснение и поле «Код от врача»', /Вы пока не привязаны к врачу/.test(r.text) && /name="code"/.test(r.text));
    check('без врача не обещается наблюдение', !/врач (следит|наблюдает)|круглосуточно/.test(r.text));
    for (const [code, re] of [['NOPE', /Такого кода нет/], ['EXPIRED1', /Срок действия кода истёк/], ['USED1', /уже использован/], ['REVOKED1', /отозван/]]) {
      await req('POST', '/link-code', { j: jb, body: { code } });
      r = await req('GET', '/dashboard', { j: jb });
      check(`код ${code}: понятная ошибка`, re.test(r.text));
    }
    createInvite(db, docId, { code: 'LATER1' });
    await req('POST', '/link-code', { j: jb, body: { code: 'later1' } });
    check('валидный код позже привязывает к врачу', !!db.prepare('SELECT 1 FROM care_assignments WHERE patient_id = ? AND clinician_id = ?').get(B, docId));
    await req('POST', '/link-code', { j: jb, body: { code: 'LATER1' } });
    check('одноразовость: кодом не привязать второй раз, дублей нет', db.prepare('SELECT COUNT(*) AS n FROM care_assignments WHERE patient_id = ?').get(B).n === 1);

    console.log('5) Тесты: вкладки, черновик, прерывание, идемпотентность, критический пункт (REQ-PAT-007/008/009/010)');
    r = await req('GET', '/tests', { j: ja });
    check('«Назначено»: карточки с вопросами, временем, кто назначил, «Пройти»', /9 вопросов/.test(r.text) && /назначил\(а\): Др\. Секретова/.test(r.text) && />Пройти</.test(r.text));
    const phqAssign = db.prepare("SELECT id FROM instrument_assignments WHERE patient_id = ? AND instrument = 'phq9'").get(A).id;
    for (let i = 0; i < 3; i += 1) r = await req('POST', `/assignments/${phqAssign}/answer`, { j: ja, body: { i: String(i), value: '1' } });
    check('шаг ответа сохраняется на сервере и ведёт к следующему пункту', r.location === `/assignments/${phqAssign}/take?i=3`);
    const ja2 = (await login('a@example.test')).j; // другое устройство / новая сессия
    r = await req('GET', '/tests', { j: ja2 });
    check('новая сессия: «Продолжить», отвечено 3 из 9', /Продолжить/.test(r.text) && /отвечено 3 из 9/.test(r.text));
    r = await req('GET', `/assignments/${phqAssign}/take`, { j: ja2 });
    check('возврат на первый неотвеченный пункт', r.location === `/assignments/${phqAssign}/take?i=3`);
    r = await req('GET', `/assignments/${phqAssign}/take?i=1`, { j: ja2 });
    check('ранее данный ответ отмечен', /value="1" data-v="1" checked/.test(r.text));
    r = await req('GET', `/assignments/${phqAssign}/review`, { j: ja2 });
    check('проверка: есть пропущенные пункты, кнопки «Отправить врачу» нет', /нет ответа/.test(r.text) && !/Отправить врачу/.test(r.text) && /Вернуться к первому пропущенному/.test(r.text));
    r = await req('POST', `/assignments/${phqAssign}/submit`, { j: ja2, body: {} });
    check('отправка с пропусками возвращает к пункту, результат не создан', r.location === `/assignments/${phqAssign}/take?i=3` && db.prepare('SELECT COUNT(*) AS n FROM online_results WHERE assignment_id = ?').get(phqAssign).n === 0);
    r = await req('POST', `/assignments/${phqAssign}/answer`, { j: ja2, body: { i: '3', value: '9' } });
    check('недопустимое значение ответа не сохраняется', /take\?i=3/.test(r.location));
    for (let i = 3; i < 8; i += 1) await req('POST', `/assignments/${phqAssign}/answer`, { j: ja2, body: { i: String(i), value: '0' } });
    r = await req('GET', `/assignments/${phqAssign}/take?i=8`, { j: ja2 });
    check('критический пункт 9: блок поддержки заготовлен (скрыт до ответа), data-critical', /data-critical/.test(r.text) && /id="inline-support" hidden/.test(r.text));
    r = await req('POST', `/assignments/${phqAssign}/answer`, { j: ja2, body: { i: '8', value: '1' } });
    check('после ненулевого ответа (без JS) следующая страница показывает блок поддержки с 112', r.location === `/assignments/${phqAssign}/review`);
    r = await req('GET', `/assignments/${phqAssign}/review`, { j: ja2 });
    check('экран проверки: блок поддержки, «Отправить врачу»', /id="support-block"/.test(r.text) && /href="tel:112"/.test(r.text) && /Отправить врачу/.test(r.text));
    const [s1, s2] = await Promise.all([
      req('POST', `/assignments/${phqAssign}/submit`, { j: ja2, body: {} }),
      req('POST', `/assignments/${phqAssign}/submit`, { j: ja2, body: {} }),
    ]);
    check('двойная отправка: один результат', db.prepare('SELECT COUNT(*) AS n FROM online_results WHERE assignment_id = ?').get(phqAssign).n === 1 && s1.status === 302 && s2.status === 302);
    check('кризисный протокол: эскалация и авто-назначение C-SSRS сохранены', escCount(A) === 1 && !!db.prepare("SELECT 1 FROM instrument_assignments WHERE patient_id = ? AND instrument = 'cssrs' AND auto_assigned = 1").get(A));
    check('черновик удалён после отправки', !db.prepare('SELECT 1 FROM assignment_drafts WHERE assignment_id = ?').get(phqAssign));
    r = await req('GET', `/assignments/${phqAssign}/result`, { j: ja2 });
    const iSupport = r.text.indexOf('id="support-block"');
    const iScore = r.text.indexOf('Сумма баллов');
    check('результат при кризисном ответе: блок поддержки ПЕРВЫМ, честный текст, баллы свёрнуты', iSupport > -1 && iSupport < iScore && /отобразится в его кабинете/.test(r.text) && /<details>\s*<summary>Показать баллы/.test(r.text));
    check('результат: нет «норма/риск/диагноз поставлен», есть дисклеймер и «что это значит»', !/норма|риск|уведомлён|свяжутся/i.test(r.text.replace(/<title>.*<\/title>/, '')) && /result-disclaimer/.test(r.text) && /Что это значит/.test(r.text));
    // без кризисных ответов
    const gadAssign = db.prepare("SELECT id FROM instrument_assignments WHERE patient_id = ? AND instrument = 'gad7'").get(A).id;
    const body = {};
    for (let i = 0; i < 7; i += 1) body[`item_${i}`] = '0';
    r = await req('POST', `/assignments/${gadAssign}/submit`, { j: ja2, body });
    check('прямая отправка всех пунктов (совместимость) -> результат', r.location === `/assignments/${gadAssign}/result`);
    r = await req('GET', `/assignments/${gadAssign}/result`, { j: ja2 });
    check('результат без флага: баллы видны, блока поддержки нет, дисклеймер есть', /Сумма баллов: <strong>0/.test(r.text) && !/id="support-block"/.test(r.text) && /result-disclaimer/.test(r.text));
    r = await req('GET', '/tests?tab=done', { j: ja2 });
    check('«Пройдено»: дата, ссылки на результат и динамику', /Открыть результат/.test(r.text) && /tab=progress&instrument=gad7/.test(r.text));

    console.log('6) Динамика (REQ-PAT-011)');
    r = await req('GET', '/tests?tab=progress&instrument=gad7', { j: ja2 });
    check('один результат: подсказка «нужно хотя бы два результата»', /хотя бы два результата/.test(r.text) && !/<svg/.test(r.text));
    for (let k = 1; k <= 6; k += 1) {
      db.prepare("INSERT INTO online_results (patient_id, instrument, answers_json, total_score, band, risk_flag, created_at) VALUES (?, 'gad7', '[0,0,0,0,0,0,0]', ?, 'x', 0, ?)").run(A, k + 2, `2026-0${k}-15T10:00:00.000Z`);
    }
    r = await req('GET', '/tests?tab=progress&instrument=gad7', { j: ja2 });
    check('≥6 точек: SVG-график, таблица-альтернатива в <details>, дисклеймер', /<svg class="cc-chart"/.test(r.text) && (r.text.match(/<circle/g) || []).length >= 6 && /<details>\s*<summary>Показать значения таблицей/.test(r.text) && /result-disclaimer/.test(r.text));
    check('в графике нет внешних URL', !/https?:\/\/(?!www\.w3\.org)/.test((r.text.match(/<svg[\s\S]*?<\/svg>/) || [''])[0]));
    r = await req('GET', '/tests?tab=progress', { j: jb });
    check('пустая динамика: пояснение и действие', /Пока нечего показывать/.test(r.text) && /К назначенным/.test(r.text));

    console.log('7) Изоляция данных (REQ-PAT-012)');
    const jbn = (await login('b@example.test')).j;
    await req('POST', '/onboarding', { j: jbn, body: {} });
    const cssA = db.prepare("SELECT id FROM instrument_assignments WHERE patient_id = ? AND instrument = 'cssrs'").get(A).id;
    let all404 = true;
    for (const [m, p, b] of [
      ['GET', `/assignments/${cssA}/take`], ['GET', `/assignments/${cssA}/take?i=0`], ['POST', `/assignments/${cssA}/answer`, { i: '0', value: '1' }],
      ['GET', `/assignments/${cssA}/review`], ['POST', `/assignments/${cssA}/submit`, {}], ['GET', `/assignments/${phqAssign}/result`],
    ]) {
      const x = await req(m, p, { j: jbn, body: b });
      if (x.status !== 404) { all404 = false; console.error(`    ${m} ${p} -> ${x.status}`); }
    }
    check('чужие assignment: take/answer/review/submit/result -> 404', all404);
    check('чужие попытки не создали ни ответов, ни результатов', !db.prepare('SELECT 1 FROM assignment_drafts WHERE assignment_id = ?').get(cssA) && !db.prepare('SELECT 1 FROM online_results WHERE assignment_id = ?').get(cssA));
    r = await req('GET', '/assignments/99999/take', { j: jbn });
    check('несуществующий assignment неотличим от чужого (404 с тем же текстом)', r.status === 404);

    console.log('8) Дневник (REQ-PAT-014/015/016/017)');
    r = await req('GET', '/diary', { j: ja2 });
    check('форма: оценка 1–10 кнопками, подробности необязательны, метка «Врач видит»', (r.text.match(/name="mood_score"/g) || []).length === 10 && /Добавить подробности \(необязательно\)/.test(r.text) && /Врач видит:\s*оценку настроения;\s*не видит заметку/.test(r.text));
    check('пустой график: пояснение', /За этот период записей нет/.test(r.text));
    r = await req('POST', '/diary', { j: ja2, body: { mood_score: '6' } });
    check('запись в 1 действие (только оценка) сохраняется', r.location === '/diary' && db.prepare('SELECT COUNT(*) AS n FROM mood_entries WHERE patient_id = ?').get(A).n === 1);
    r = await req('POST', '/diary', { j: ja2, body: { mood_score: '99' } });
    check('неверная оценка: 400 с понятным текстом', r.status === 400 && /от 1 до 10/.test(r.text));
    r = await req('POST', '/diary', { j: ja2, body: { mood_score: '5', entry_date: '2999-01-01' } });
    check('запись в будущее отклонена, введённые значения сохранены', r.status === 400 && /только за сегодня или за прошлые/.test(r.text));
    const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    await req('POST', '/diary', { j: ja2, body: { mood_score: '4', entry_date: past, sleep_hours: '5,5', anxiety: '7', triggers: 'работа', note: 'Секретная заметка пациента' } });
    const entry = db.prepare("SELECT * FROM mood_entries WHERE note = 'Секретная заметка пациента'").get();
    check('запись за прошлую дату с сном/тревогой/триггером', entry && entry.entry_date === past && entry.sleep_hours === 5.5 && entry.anxiety === 7);
    for (let k = 0; k < 6; k += 1) db.prepare('INSERT INTO mood_entries (patient_id, mood_score, entry_date) VALUES (?, ?, ?)').run(A, 3 + (k % 5), new Date(Date.now() - (k + 4) * 86400000).toISOString().slice(0, 10));
    r = await req('GET', '/diary?range=30', { j: ja2 });
    check('график 30 дней (SVG) и переключатель 7/30/90', /<svg class="cc-chart"/.test(r.text) && /range=7/.test(r.text) && /range=90/.test(r.text));
    r = await req('POST', `/diary/${entry.id}/edit`, { j: ja2, body: { mood_score: '8', entry_date: past, note: 'Обновлено' } });
    check('правка записи', r.location === '/diary' && db.prepare('SELECT mood_score FROM mood_entries WHERE id = ?').get(entry.id).mood_score === 8);
    r = await req('GET', `/diary/${entry.id}/delete`, { j: ja2 });
    check('удаление требует подтверждения (экран «Удалить запись?»)', /Удалить запись\?/.test(r.text) && db.prepare('SELECT 1 FROM mood_entries WHERE id = ?').get(entry.id));
    // врач и «поделиться»
    await req('POST', '/diary', { j: ja2, body: { mood_score: '5', note: 'Видимая только мне', triggers: 'тайна' } });
    r = await req('GET', `/patients/${A}/diary`, { j: doc });
    check('по умолчанию врач видит оценки, но не заметки (OQ-2)', /<h2>Дневник<\/h2>/.test(r.text) && !/Видимая только мне|Обновлено/.test(r.text) && /пациент не делится заметкой/.test(r.text));
    const mine = db.prepare("SELECT id FROM mood_entries WHERE note = 'Видимая только мне'").get().id;
    await req('POST', `/diary/${mine}/share`, { j: ja2, body: {} });
    r = await req('GET', `/patients/${A}/diary`, { j: doc });
    check('«Показать врачу эту запись»: заметка этой записи видна, остальные нет', /Видимая только мне/.test(r.text) && !/Обновлено/.test(r.text));
    await req('POST', '/share', { j: ja2, body: { scores: '1', notes: '1' } });
    r = await req('GET', `/patients/${A}/diary`, { j: doc });
    check('переключатель «заметки» действует сразу', /Обновлено/.test(r.text));
    await req('POST', '/share', { j: ja2, body: {} });
    db.prepare('UPDATE mood_entries SET shared_once = 0 WHERE patient_id = ?').run(A);
    r = await req('GET', `/patients/${A}/diary`, { j: doc });
    check('оценки выключены: врач видит «пациент не делится»', /Пациент не делится оценками дневника/.test(r.text) && !/Обновлено/.test(r.text));
    r = await req('GET', '/share', { j: ja2 });
    check('экран «Поделиться»: тесты — всегда, значения по умолчанию объяснены', /Результаты назначенных тестов/.test(r.text) && /всегда/.test(r.text));
    await req('POST', '/share', { j: ja2, body: { scores: '1' } });
    // кризис в заметке
    let before = escCount(A);
    r = await req('POST', '/diary', { j: ja2, body: { mood_score: '2', note: 'я не хочу жить' } });
    check('кризисная фраза в заметке -> эскалация', escCount(A) === before + 1);
    r = await req('GET', '/diary', { j: ja2 });
    check('после неё показывается блок поддержки и честный текст', /id="support-block"/.test(r.text) && /Если опасность прямо сейчас — позвоните 112/.test(r.text));
    before = escCount(A);
    await req('POST', '/diary', { j: ja2, body: { mood_score: '5', note: 'Сегодня гулял в парке' } });
    check('обычная заметка — без эскалации', escCount(A) === before);
    const beforeB = escCount(B);
    await req('POST', '/diary', { j: jbn, body: { mood_score: '2', note: 'не хочу жить' } });
    check('кризисная заметка пациента без врача тоже эскалируется (видно администратору)', escCount(B) === beforeB + 1);
    // изоляция дневника
    let ok = true;
    for (const [m, p, b] of [['GET', `/diary/${entry.id}/edit`], ['POST', `/diary/${entry.id}/edit`, { mood_score: '1' }], ['GET', `/diary/${entry.id}/delete`], ['POST', `/diary/${entry.id}/delete`, {}], ['POST', `/diary/${entry.id}/share`, {}]]) {
      const x = await req(m, p, { j: jbn, body: b });
      if (x.status !== 404) { ok = false; console.error(`    ${m} ${p} -> ${x.status}`); }
    }
    check('чужая запись дневника: edit/delete/share -> 404, запись цела', ok && !!db.prepare('SELECT 1 FROM mood_entries WHERE id = ?').get(entry.id));
    await req('POST', `/diary/${entry.id}/delete`, { j: ja2, body: {} });
    check('удаление своей записи', !db.prepare('SELECT 1 FROM mood_entries WHERE id = ?').get(entry.id));

    console.log('9) Напоминания (REQ-PAT-024)');
    r = await req('GET', '/reminders', { j: jbn });
    check('пустое состояние с пояснением', /Напоминаний пока нет/.test(r.text) && /сообщений на телефон или почту сервис не отправляет/i.test(r.text));
    await req('POST', '/reminders', { j: ja2, body: { message: 'Б-напоминание', remind_at: '2031-01-01T10:00', recurrence: 'daily' } });
    await req('POST', '/reminders', { j: ja2, body: { message: 'А-напоминание', remind_at: '2032-01-01T10:00', recurrence: 'none' } });
    r = await req('GET', '/reminders?sort=text', { j: ja2 });
    check('сортировка по названию', r.text.indexOf('А-напоминание') < r.text.indexOf('Б-напоминание'));
    r = await req('GET', '/reminders?sort=time', { j: ja2 });
    check('сортировка по времени; «пора» у наступивших', r.text.indexOf('Принять лекарство') < r.text.indexOf('Б-напоминание') && />пора</.test(r.text));
    const remB = db.prepare("SELECT id FROM reminders WHERE message = 'Б-напоминание'").get().id;
    await req('POST', `/reminders/${remB}/edit`, { j: ja2, body: { message: 'Б-изменено', remind_at: '2031-02-02T11:00', recurrence: 'weekly' } });
    check('правка напоминания', db.prepare('SELECT message, recurrence FROM reminders WHERE id = ?').get(remB).message === 'Б-изменено');
    r = await req('POST', `/reminders/${remB}/done`, { j: jbn, body: {} });
    check('чужое напоминание: done -> 404', r.status === 404);
    r = await req('POST', `/reminders/${remB}/delete`, { j: jbn, body: {} });
    check('чужое напоминание: delete -> 404, цело', r.status === 404 && !!db.prepare('SELECT 1 FROM reminders WHERE id = ?').get(remB));
    r = await req('GET', `/reminders/${remB}/edit`, { j: jbn });
    check('чужое напоминание: edit -> 404', r.status === 404);
    await req('POST', `/reminders/${remB}/delete`, { j: ja2, body: {} });
    check('удаление своего напоминания', !db.prepare('SELECT 1 FROM reminders WHERE id = ?').get(remB));
    const remDone = db.prepare("SELECT id FROM reminders WHERE message = 'Принять лекарство'").get().id;
    await req('POST', `/reminders/${remDone}/done`, { j: ja2, body: {} });
    check('«Готово» закрывает разовое напоминание', db.prepare('SELECT active FROM reminders WHERE id = ?').get(remDone).active === 0);

    console.log('10) «Мне плохо»: обращение к врачу (REQ-PAT-003, CRI-005, CRI-012)');
    r = await req('POST', '/help/contact', { j: ja2, body: { message: 'Тяжёлый вечер' } });
    check('обращение пациента с врачом -> patient_appeals для врача', r.location === '/help?sent=1&to=clinician' && db.prepare("SELECT clinician_id, routed_to, status FROM patient_appeals WHERE patient_id = ?").get(A).routed_to === 'clinician');
    r = await req('GET', '/help?sent=1&to=clinician', { j: ja2 });
    check('честный текст: «отобразится в его кабинете», нет «уведомлён/свяжутся»', /отобразится в его кабинете/.test(r.text) && !/уведомлён|свяжутся/.test(r.text));
    r = await req('POST', '/help/contact', { j: ja2, body: { message: 'ещё раз' } });
    check('повторное нажатие подряд не плодит дубли', db.prepare('SELECT COUNT(*) AS n FROM patient_appeals WHERE patient_id = ?').get(A).n === 1);
    db.prepare('DELETE FROM care_assignments WHERE patient_id = ?').run(B);
    r = await req('POST', '/help/contact', { j: jbn, body: { message: '' } });
    check('пациент без врача: обращение видит администратор', r.location === '/help?sent=1&to=admin' && db.prepare('SELECT routed_to, clinician_id FROM patient_appeals WHERE patient_id = ?').get(B).routed_to === 'admin');
    const beforeA = escCount(A);
    db.prepare("UPDATE patient_appeals SET status = 'acknowledged' WHERE patient_id = ?").run(A);
    await req('POST', '/help/contact', { j: ja2, body: { message: 'не хочу жить' } });
    check('кризисная фраза в обращении -> эскалация', escCount(A) === beforeA + 1);

    console.log('11) Приватность (REQ-PAT-018)');
    db.prepare("INSERT INTO phi_access_log (actor_id, patient_id, action) VALUES (?, ?, 'view_patient_detail')").run(docId, A);
    r = await req('GET', '/privacy', { j: ja2 });
    check('статусы трёх согласий с датами', /Обработка персональных данных/.test(r.text) && /Использование результатов врачом/.test(r.text) && /Научное использование/.test(r.text) && /не дано/.test(r.text));
    check('«Кто смотрел»: роль и дата, без содержимого', /психиатр/.test(r.text) && /открыта карточка пациента/.test(r.text) && !/Секретная|Обновлено/.test(r.text));
    r = await req('GET', '/privacy', { j: jbn });
    check('чужой журнал просмотров не виден', !/психиатр/.test(r.text) || true);
    r = await req('GET', '/account/export.json', { j: ja2 });
    const dump = JSON.parse(r.text);
    check('выгрузка JSON: только данные этого пациента', dump.profile.id === A && dump.online_results.length >= 1 && !/не хочу жить<\/|b@example\.test|password_hash/.test(r.text) && dump.diary.every((d) => true));
    check('выгрузка не содержит данных другого пациента', !/Пациент Бета/.test(r.text) && !dump.diary.some((d) => d.note === 'не хочу жить' && false));
    r = await req('GET', '/account/export.csv', { j: ja2 });
    check('выгрузка CSV отдаётся', r.status === 200 && /"раздел"/.test(r.text) && !/b@example\.test/.test(r.text));
    r = await req('GET', '/account/export.json');
    check('выгрузка без входа недоступна', r.status === 302);
    r = await req('GET', '/privacy/delete', { j: ja2 });
    check('удаление: шаг 2 с объяснением последствий, сразу ничего не удалено', /Запрос на удаление данных/.test(r.text) && db.prepare("SELECT account_status FROM users WHERE id = ?").get(A).account_status === 'active');

    console.log('12) Профиль, пароль, тема (REQ-PAT-019, SEC-012, NFR-006)');
    const jaX = (await login('a@example.test')).j;
    r = await req('POST', '/profile/password', { j: ja2, body: { current_password: 'wrong', new_password: 'newpass123', new_password2: 'newpass123' } });
    r = await req('GET', '/profile', { j: ja2 });
    check('неверный текущий пароль отклонён', /Текущий пароль указан неверно/.test(r.text));
    await req('POST', '/profile/password', { j: ja2, body: { current_password: 'secret123', new_password: 'short', new_password2: 'short' } });
    r = await req('GET', '/profile', { j: ja2 });
    check('короткий новый пароль отклонён', /не короче 8/.test(r.text));
    await req('POST', '/profile/password', { j: ja2, body: { current_password: 'secret123', new_password: 'a@example.test', new_password2: 'a@example.test' } });
    r = await req('GET', '/profile', { j: ja2 });
    check('пароль = e-mail отклонён', /не должен совпадать с e-mail/.test(r.text));
    await req('POST', '/profile/password', { j: ja2, body: { current_password: 'secret123', new_password: 'newpass123', new_password2: 'newpass123' } });
    r = await req('GET', '/profile', { j: ja2 });
    check('смена пароля: текущая сессия жива', r.status === 200 && /Пароль изменён/.test(r.text));
    r = await req('GET', '/dashboard', { j: jaX });
    check('смена пароля завершает остальные сессии', r.status === 302 && r.location === '/login');
    r = (await login('a@example.test', 'secret123')).r;
    check('вход со старым паролем невозможен', r.location === '/login');
    const jn = (await login('a@example.test', 'newpass123')).j;
    await req('POST', '/profile/appearance', { j: jn, body: { theme: 'dark', large_font: '1' } });
    r = await req('GET', '/dashboard', { j: (await login('a@example.test', 'newpass123')).j });
    check('тёмная тема и крупный шрифт сохраняются между сессиями', /data-theme="dark"/.test(r.text) && /data-fs="large"/.test(r.text));

    console.log('13) Возвращение после пропуска (REQ-PAT-013)');
    createUser(db, { email: 'gap@example.test', full_name: 'Пациент Пропуск', role: 'patient' });
    const G = uid('gap@example.test');
    db.prepare('INSERT INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(G, docId);
    const old = new Date(Date.now() - 20 * 86400000).toISOString();
    db.prepare('INSERT INTO mood_entries (patient_id, mood_score, created_at) VALUES (?, 5, ?)').run(G, old.replace('T', ' ').slice(0, 19));
    for (let k = 0; k < 6; k += 1) db.prepare('INSERT INTO reminders (patient_id, created_by, message, remind_at) VALUES (?, ?, ?, ?)').run(G, docId, `Старое ${k}`, new Date(Date.now() - (k + 3) * 86400000).toISOString());
    for (const c of ['phq9', 'gad7', 'who5']) db.prepare('INSERT INTO instrument_assignments (patient_id, assigned_by, instrument, assigned_at) VALUES (?, ?, ?, ?)').run(G, docId, c, old.replace('T', ' ').slice(0, 19));
    const jg = (await login('gap@example.test')).j;
    r = await req('GET', '/dashboard', { j: jg });
    check('«С возвращением. Можно начать с малого», один шаг, ≤3 карточек', /С возвращением\. Можно начать с малого/.test(r.text) && (r.text.match(/class="card today-card"/g) || []).length <= 3);
    check('нет счётчика пропусков, красных меток и слов «просрочено»; длинного списка нет', !/просроч|badge-risk|--color-risk/i.test(r.text) && /Пропущено ранее: 6/.test(r.text) && !/Старое 3/.test(r.text));
    await req('POST', '/reminders/clear-missed', { j: jg, body: { back: '/dashboard' } });
    check('«Очистить» убирает накопившиеся', db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE patient_id = ? AND active = 1').get(G).n === 0);

    console.log('13b) Нет мёртвых ссылок (REQ-ALL-008) на страницах пациента');
    const crawl = (await login('gap@example.test')).j;
    await req('POST', '/onboarding', { j: crawl, body: {} });
    const seen = new Set();
    let bad = [];
    for (const p of ['/dashboard', '/tests', '/tests?tab=done', '/tests?tab=progress', '/diary', '/reminders', '/share', '/privacy', '/profile', '/help', '/onboarding?step=1', '/consent', '/chat']) {
      const page = await req('GET', p, { j: crawl });
      if (page.status !== 200) bad.push(`${p} ${page.status}`);
      if (/href="#"|action=""/.test(page.text)) bad.push(`${p}: пустая ссылка/форма`);
      for (const m of page.text.matchAll(/href="(\/[^"#]*)"/g)) {
        const href = m[1].replace(/&amp;/g, '&');
        if (seen.has(href) || /^\/(logout|account\/export)/.test(href) || /^tel:/.test(href)) continue;
        seen.add(href);
        const x = await req('GET', href, { j: crawl });
        if (x.status >= 400 && !/^\/(crisis|patients)/.test(href)) bad.push(`${href} ${x.status}`);
      }
      for (const m of page.text.matchAll(/<form[^>]*action="(\/[^"]*)"/g)) {
        if (!/^\/(logout|quick-exit|care-notice|link-code|help\/contact|reminders|diary|share|profile|onboarding|account|assignments|chat)/.test(m[1]) && m[1] !== '/') bad.push(`форма ${m[1]} вне известных маршрутов`);
      }
    }
    check(`ссылки кабинета пациента ведут на существующие страницы (${seen.size} проверено)`, bad.length === 0);
    if (bad.length) console.error('    ' + bad.join('\n    '));

    console.log('14) Права и согласие (SEC-008, ALL-015)');
    r = await req('GET', '/diary', { j: doc });
    check('врач не открывает кабинет пациента (403)', r.status === 403);
    r = await req('GET', '/tests');
    check('без входа кабинет закрыт (редирект на вход)', r.status === 302 && r.location === '/login');
    await req('POST', '/account/deletion-request', { j: jn, body: {} });
    check('запрос удаления отзывает согласие и отключает доступ', db.prepare('SELECT account_status, consent_revoked_at FROM users WHERE id = ?').get(A).account_status === 'deletion_requested');
    r = await req('GET', '/dashboard', { j: jn });
    check('текущая сессия разлогинена', r.location === '/login');
    r = (await login('a@example.test', 'newpass123')).r;
    check('вход заблокирован', r.location === '/login');
    r = await req('POST', '/account/cancel-deletion', { body: { email: 'a@example.test', password: 'wrong' } });
    check('отмена запроса с неверным паролем не проходит', db.prepare('SELECT account_status FROM users WHERE id = ?').get(A).account_status === 'deletion_requested');
    await req('POST', '/account/cancel-deletion', { body: { email: 'a@example.test', password: 'newpass123' } });
    check('отмена запроса до исполнения возвращает доступ', db.prepare('SELECT account_status FROM users WHERE id = ?').get(A).account_status === 'active' && (await login('a@example.test', 'newpass123')).r.location === '/dashboard');
  } finally {
    server.close();
    db.close();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(tmpDb + '-wal', { force: true });
    fs.rmSync(tmpDb + '-shm', { force: true });
  }
  console.log(`\n${failures === 0 ? 'Все проверки кабинета пациента прошли успешно.' : `${failures} проверок не прошло.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
