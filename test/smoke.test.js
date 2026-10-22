'use strict';

require('./helpers').installCsrfFetch(); // W2.S: тесты получают и отправляют CSRF-токен как браузер

/**
 * Минимальная ручная проверка (не юнит-тесты): поднимает реальный сервер
 * на временной БД и проходит ключевые сценарии из критерия готовности RES-5:
 * логин под тремя ролями, назначение/прохождение теста, кризисный протокол,
 * сравнение офлайн/онлайн, дневник настроения, напоминания, чат-бот, экспорт.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `tdr-smoke-${Date.now()}.sqlite3`);
process.env.TDR_DB_PATH = tmpDb;
process.env.SESSION_SECRET = 'test-secret';

const app = require('../src/app');
const db = require('../src/db');

const PORT = 20000 + Math.floor(Math.random() * 20000); // случайный порт: тесты могут идти параллельно в разных worktree
const BASE = `http://127.0.0.1:${PORT}`;

function jar() {
  const cookies = new Map();
  return {
    store(res) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const idx = pair.indexOf('=');
        cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
      }
    },
    header() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
  };
}

async function req(method, pathname, { body, cookieJar, form = true } = {}) {
  const headers = {};
  if (cookieJar) headers.Cookie = cookieJar.header();
  let payload;
  if (body) {
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(body).toString();
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  const res = await fetch(BASE + pathname, { method, headers, body: payload, redirect: 'manual' });
  if (cookieJar) cookieJar.store(res);
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get('location') };
}

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

async function main() {
  const server = app.listen(PORT);
  try {
    console.log('1) Психиатра создаёт администратор (публичная регистрация только для пациентов)');
    const docJar = jar();
    const helpers = require('./helpers');
    helpers.createUser(db, { email: 'doc@example.com', full_name: 'Др. Иванова', role: 'psychiatrist' });
    let r = await req('POST', '/register', {
      cookieJar: docJar,
      body: { email: 'doc2@example.com', password: 'secret123', full_name: 'Самозванец', role: 'psychiatrist' },
    });
    check('публичная регистрация врача отклонена (REQ-ALL-014)', r.status === 403 && !db.prepare("SELECT 1 FROM users WHERE email = 'doc2@example.com'").get());

    console.log('2) Логин психиатра, чтобы получить его id для привязки пациента');
    r = await req('POST', '/login', { cookieJar: docJar, body: { email: 'doc@example.com', password: 'secret123' } });
    check('логин психиатра успешен', r.status === 302 && r.location === '/dashboard');

    r = await req('GET', '/register');
    check('список врачей анонимам не показывается', !/Иванова/.test(r.text));
    const docId = db.prepare("SELECT id FROM users WHERE email = 'doc@example.com'").get().id;
    const inviteCode = helpers.createInvite(db, docId, { code: 'SMOKEINV1' });

    console.log('3) Регистрация пациента с согласием и привязкой к врачу');
    const patJar = jar();
    r = await req('POST', '/register', {
      cookieJar: patJar,
      body: {
        email: 'patient@example.com',
        password: 'secret123',
        full_name: 'Пациент Петров',
        role: 'patient',
        invite_code: inviteCode,
        consent_given: '1',
        clinical_consent_given: '1',
        anonymized_export_opt_in: '1',
      },
    });
    check('регистрация пациента успешна', r.status === 302 && r.location === '/login');

    r = await req('POST', '/login', { cookieJar: patJar, body: { email: 'patient@example.com', password: 'secret123' } });
    check('логин пациента успешен', r.status === 302 && r.location === '/dashboard');
    check('код-приглашение привязал пациента к врачу', !!db.prepare("SELECT 1 FROM care_assignments ca JOIN users u ON u.id = ca.patient_id WHERE u.email = 'patient@example.com' AND ca.clinician_id = ?").get(docId));
    r = await req('GET', '/dashboard', { cookieJar: patJar });
    check('первый вход пациента ведёт на онбординг', r.status === 302 && r.location === '/onboarding');
    await req('POST', '/onboarding', { cookieJar: patJar, body: {} });

    console.log('4) Врач назначает PHQ-9 пациенту');
    r = await req('GET', '/dashboard', { cookieJar: docJar });
    const patIdMatch = r.text.match(/href="\/patients\/(\d+)"/);
    check('пациент виден в кабинете врача', !!patIdMatch);
    const patientId = patIdMatch[1];

    r = await req('POST', '/assignments', { cookieJar: docJar, body: { patient_id: patientId, instrument: 'phq9' } });
    check('назначение теста редиректит на карточку пациента', r.status === 302 && r.location === `/patients/${patientId}`);

    console.log('5) Пациент видит назначение и проходит тест с кризисным ответом (пункт 9 > 0)');
    r = await req('GET', '/dashboard', { cookieJar: patJar });
    const assignMatch = r.text.match(/\/assignments\/(\d+)\/take/);
    check('пациент видит назначенный тест', !!assignMatch);
    const assignmentId = assignMatch[1];

    const phq9Answers = { item_0: 2, item_1: 2, item_2: 1, item_3: 1, item_4: 0, item_5: 1, item_6: 0, item_7: 0, item_8: 1 };
    r = await req('POST', `/assignments/${assignmentId}/submit`, { cookieJar: patJar, body: phq9Answers });
    check('отправка ответов ведёт на экран результата', r.status === 302 && r.location === `/assignments/${assignmentId}/result`);

    r = await req('GET', `/assignments/${assignmentId}/result`, { cookieJar: patJar });
    check('результат: блок поддержки и честный текст (пункт 9 > 0), без красных меток', /id="support-block"/.test(r.text) && /отобразится в его кабинете/.test(r.text) && !/badge-risk|уведомлён|свяжутся/.test(r.text));

    console.log('6) Кризисная эскалация видна врачу и не зависит от текста на экране');
    r = await req('GET', '/crisis', { cookieJar: docJar });
    check('открытая эскалация видна в /crisis', /PHQ-9 пункт 9/.test(r.text) || /phq9/.test(r.text));
    const ackMatch = r.text.match(/\/crisis\/(\d+)\/acknowledge/);
    check('есть форма подтверждения эскалации', !!ackMatch);
    r = await req('POST', `/crisis/${ackMatch[1]}/acknowledge`, { cookieJar: docJar, body: {} });
    check('эскалация подтверждается', r.status === 302 && r.location === '/crisis');

    console.log('7) Врач вводит офлайн-результат и видит сопоставление');
    r = await req('POST', `/patients/${patientId}/offline-results`, {
      cookieJar: docJar,
      body: { instrument: 'phq9', total_score: '12', test_date: '2026-10-01', notes: 'Бланковый тест на приёме' },
    });
    check('офлайн-результат сохранён', r.status === 302 && r.location === `/patients/${patientId}/offline`);

    r = await req('GET', `/patients/${patientId}/offline`, { cookieJar: docJar });
    check('таблица сопоставления показывает офлайн балл 12', /12<\/td>/.test(r.text));
    check('таблица сопоставления показывает онлайн балл (из PHQ-9)', /8<\/td>/.test(r.text));

    console.log('8) Дневник настроения пациента');
    r = await req('POST', '/mood', { cookieJar: patJar, body: { mood_score: '4', note: 'Тяжёлый день' } });
    check('запись настроения сохранена', r.status === 302 && r.location === '/diary');
    r = await req('GET', '/diary', { cookieJar: patJar });
    check('запись настроения видна в истории', /Тяжёлый день/.test(r.text));

    console.log('9) Напоминание пациенту');
    r = await req('POST', '/reminders', { cookieJar: patJar, body: { message: 'Заполнить дневник', remind_at: '2020-01-01T10:00', recurrence: 'none' } });
    check('напоминание создано', r.status === 302);
    r = await req('GET', '/reminders', { cookieJar: patJar });
    check('напоминание, время которого пришло, помечено «пора»', />пора</.test(r.text));

    console.log('10) Чат-бот: обычное сообщение и кризисная фраза');
    r = await req('GET', '/chat', { cookieJar: patJar });
    check('экран чата открывается (новый диалог)', r.status === 200 && /Новый диалог/.test(r.text));
    r = await req('POST', '/chat/send', { cookieJar: patJar, body: { text: 'мне грустно и тревожно' } });
    check('бот отвечает на сообщение о грусти', r.status === 302 && /^\/chat\/t\/\d+/.test(r.location));
    const threadUrl = r.location.split('#')[0];
    r = await req('GET', threadUrl, { cookieJar: patJar });
    check('ответ бота про поддержку сохранён в истории', /Спасибо, что поделились/.test(r.text));

    r = await req('POST', '/chat/send', { cookieJar: patJar, body: { text: 'я не хочу жить', thread_id: threadUrl.split('/').pop() } });
    r = await req('GET', '/crisis', { cookieJar: docJar });
    check('кризисная фраза в чате создаёт новую эскалацию врачу', /chatbot/.test(r.text));

    console.log('11) Анонимизированный экспорт для научной части');
    r = await req('GET', '/export/comparisons.csv', { cookieJar: docJar });
    check('экспорт отдаёт CSV', r.status === 200 && r.text.startsWith('patient_pseudonym;online_scale;offline_scale'));
    check('экспорт не содержит email/ФИО пациента', !r.text.includes('patient@example.com') && !r.text.includes('Петров'));
    check('экспорт содержит строку сравнения', /;phq9;phq9;same_scale_\w+;[^;]*;\d+;12;/.test(r.text));

    console.log('12) Доступ психолога без привязки к пациенту запрещён (проверка ролей)');
    const psyJar = jar();
    helpers.createUser(db, { email: 'psy@example.com', full_name: 'Психолог Сидорова', role: 'psychologist' });
    await req('POST', '/login', { cookieJar: psyJar, body: { email: 'psy@example.com', password: 'secret123' } });
    r = await req('GET', `/patients/${patientId}`, { cookieJar: psyJar });
    check('чужой специалист не видит карточку пациента (403)', r.status === 403);

    console.log('12b) C-SSRS Screen авто-назначен после PHQ-9 п.9≥1, критический ответ -> Tier 3 с SLA');
    r = await req('GET', '/dashboard', { cookieJar: patJar });
    check('C-SSRS Screen появился в назначениях пациента', /cssrs/i.test(r.text));
    const cssrsTakeMatch = r.text.match(/\/assignments\/(\d+)\/take/);
    check('есть ссылка на прохождение C-SSRS', !!cssrsTakeMatch);
    const cssrsAssignmentId = cssrsTakeMatch[1];

    // идеация уровня 4 (вопросы 1-4 = да, 5 = нет) + поведение = да -> триггеры A и B, Tier 3
    const cssrsAnswers = { item_0: 1, item_1: 1, item_2: 1, item_3: 1, item_4: 0, item_5: 1 };
    r = await req('POST', `/assignments/${cssrsAssignmentId}/submit`, { cookieJar: patJar, body: cssrsAnswers });
    check('отправка C-SSRS ведёт на экран результата', r.status === 302 && r.location === `/assignments/${cssrsAssignmentId}/result`);

    r = await req('GET', '/crisis', { cookieJar: docJar });
    check('после C-SSRS появилась эскалация Tier 3', /Уровень 3/.test(r.text));
    check('в списке триггеров видны A и B', /A — [^,<]+, B — /.test(r.text));

    console.log('12c) Психолог вводит офлайн BDI-II с критическим пунктом 9 (=3) -> Tier 3, cross-instrument сопоставление с онлайн PHQ-9');
    r = await req('POST', `/patients/${patientId}/offline-results`, {
      cookieJar: docJar,
      body: { instrument: 'bdi2', total_score: '45', item9_score: '3', test_date: '2026-10-02', notes: 'Очный приём, бланк BDI-II' },
    });
    check('офлайн BDI-II сохранён', r.status === 302 && r.location === `/patients/${patientId}/offline`);

    r = await req('GET', `/patients/${patientId}/offline`, { cookieJar: docJar });
    check('cross-instrument сопоставление BDI-II<->PHQ-9 видно на карточке', /cross_instrument/.test(r.text));

    r = await req('GET', '/crisis', { cookieJar: docJar });
    check('BDI-II п.9=3 создаёт эскалацию с источником bdi2', /bdi2/.test(r.text));

    console.log('13) Пациент отзывает согласие на научный экспорт (152-ФЗ ст.14/21)');
    r = await req('GET', '/dashboard', { cookieJar: patJar });
    r = await req('GET', '/privacy', { cookieJar: patJar });
    check('в «Приватности» есть форма отзыва согласия на экспорт', /\/account\/export-consent\/revoke/.test(r.text));
    r = await req('POST', '/account/export-consent/revoke', { cookieJar: patJar, body: {} });
    check('отзыв согласия на экспорт ведёт в «Приватность»', r.status === 302 && r.location === '/privacy');
    r = await req('GET', '/privacy', { cookieJar: patJar });
    check('«Приватность» показывает, что согласие на экспорт отозвано', /отозвано/.test(r.text));

    console.log('14) Отозванное согласие на экспорт исключает пациента из следующего научного экспорта');
    r = await req('GET', '/export/comparisons.csv', { cookieJar: docJar });
    check('после отзыва согласия пациент больше не попадает в экспорт', !/;phq9;phq9;/.test(r.text));

    console.log('15) Пациент запрашивает отзыв согласия и удаление данных — доступ блокируется немедленно');
    r = await req('POST', '/account/deletion-request', { cookieJar: patJar, body: {} });
    check('запрос на удаление редиректит на /login', r.status === 302 && r.location === '/login');
    r = await req('GET', '/dashboard', { cookieJar: patJar });
    check('текущая сессия пациента уже разлогинена', r.status === 302 && r.location === '/login');
    r = await req('POST', '/login', { cookieJar: patJar, body: { email: 'patient@example.com', password: 'secret123' } });
    check('повторный логин редиректит обратно на /login', r.status === 302 && r.location === '/login');
    r = await req('GET', '/login', { cookieJar: patJar });
    check('повторный логин заблокирован после запроса удаления данных', /деактивирован/.test(r.text));
  } finally {
    server.close();
    // Явно закрываем native-хендл better-sqlite3 до выхода из процесса —
    // иначе финализация prepared statements при teardown V8 isolate иногда
    // гонится с node::RemoveEnvironmentCleanupHook и крашит процесс (exit 134)
    // даже при зелёных проверках.
    db.close();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(tmpDb + '-wal', { force: true });
    fs.rmSync(tmpDb + '-shm', { force: true });
  }

  console.log(`\n${failures === 0 ? 'Все проверки прошли успешно.' : `${failures} проверок не прошло.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
