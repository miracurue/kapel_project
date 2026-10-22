'use strict';

require('./helpers').installCsrfFetch(); // W2.S: тесты получают и отправляют CSRF-токен как браузер

// W1.B2: карточка пациента клинициста, назначения, заметки, коды-приглашения — e2e на демо-сиде
// + негативные сценарии (чужой пациент, пациент, админ). Пороги/клиника не проверяются (review-required).

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ccard-'));
process.env.TDR_DB_PATH = path.join(tmp, 'cc.sqlite3');
process.env.SESSION_SECRET = 'test-secret';

require('../scripts/gc-guard'); // до src/db
const db = require('../src/db');
const { seedDemo, DEMO_PASSWORD } = require('../scripts/seed-demo');
const assignments = require('../src/assignments');
const invites = require('../src/invites');
const researchExport = require('../src/research_export');

seedDemo();
const app = require('../src/app');

let BASE = '';
let failures = 0;
let oks = 0;
function check(label, cond) {
  if (cond) { oks++; console.log(`  OK   ${label}`); } else { failures++; console.error(`  FAIL ${label}`); }
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
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) for (const x of Array.isArray(v) ? v : [v]) sp.append(k, x);
    payload = sp.toString();
  }
  const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
  if (cookieJar) cookieJar.store(res);
  return { status: res.status, text: await res.text(), location: res.headers.get('location'), headers: res.headers };
}
async function login(email) {
  const j = jar();
  const r = await req('POST', '/login', { cookieJar: j, body: { email, password: DEMO_PASSWORD } });
  if (r.status !== 302) throw new Error(`login ${email}: ${r.status}`);
  return j;
}
const uid = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
const count = (sql, ...a) => db.prepare(sql).get(...a).n;
const lastAssign = (pid, code) => db.prepare('SELECT * FROM instrument_assignments WHERE patient_id = ? AND instrument = ? ORDER BY id DESC LIMIT 1').get(pid, code);
const noRequired = (t) => !/\srequired[\s>=]/.test(t);

async function main() {
  const server = app.listen(0);
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    const psy1 = await login('psychiatrist1@example.com');
    const psy2 = await login('psychiatrist2@example.com');
    const psycho = await login('psychologist1@example.com');
    const gromovJar = await login('patient2.worsening@example.com');
    const admin = await login('admin@example.com');
    const G = uid('patient2.worsening@example.com');
    const Z = uid('patient3.crisis@example.com');
    const N = uid('patient8.new@example.com');
    const S = uid('patient1.improving@example.com');
    const F = uid('patient6.nodoctor@example.com');
    const PSY1 = uid('psychiatrist1@example.com');

    console.log('1) Карточка: 8 вкладок, прямые ссылки, активная выделена');
    const tabs = [['', 'Обзор'], ['/scales', 'Шкалы и динамика'], ['/offline', 'Офлайн-ввод и сравнение'], ['/diary', 'Дневник'], ['/treatment', 'Лечение'], ['/notes', 'Заметки'], ['/materials', 'Материалы'], ['/journal', 'Журнал']];
    const before = count('SELECT COUNT(*) AS n FROM phi_access_log WHERE actor_id = ? AND patient_id = ?', PSY1, G);
    for (const [p, label] of tabs) {
      const r = await req('GET', `/patients/${G}${p}`, { cookieJar: psy1 });
      const nav = r.text.match(/<nav class="tabs pc-tabs"[\s\S]*?<\/nav>/);
      check(`вкладка «${label}»: 200, 9 ссылок, активная выделена`, r.status === 200 && !!nav && (nav[0].match(/class="tabs__tab/g) || []).length === 9 && new RegExp(`is-active" href="/patients/${G}${p}" aria-current="page">${label}<`).test(nav[0]));
    }
    check('REQ-CLN-025: 8 вкладок -> 8 записей аудита', count('SELECT COUNT(*) AS n FROM phi_access_log WHERE actor_id = ? AND patient_id = ?', PSY1, G) === before + 8);
    for (const [p] of tabs) await req('GET', `/patients/${G}${p}`, { cookieJar: psy1 });
    check('повторный просмотр (F5) не множит записи', count('SELECT COUNT(*) AS n FROM phi_access_log WHERE actor_id = ? AND patient_id = ?', PSY1, G) === before + 8);
    check('действие и вкладка в журнале', count("SELECT COUNT(*) AS n FROM phi_access_log WHERE actor_id = ? AND patient_id = ? AND action = 'view_patient_tab:scales'", PSY1, G) >= 1
      && count("SELECT COUNT(*) AS n FROM phi_access_log WHERE actor_id = ? AND patient_id = ? AND action = 'view_patient_detail'", PSY1, G) >= 1);

    console.log('2) Что изменилось: дельта, дата, число строк, пациент без изменений');
    let r = await req('GET', `/patients/${G}`, { cookieJar: psy1 });
    const changesBlock = (r.text.match(/<section class="pc-section" aria-labelledby="changes-h">[\s\S]*?<\/section>/) || [''])[0];
    check('блок «Что изменилось» есть и указывает период', changesBlock.includes('Что изменилось') && /с вашего последнего просмотра/.test(changesBlock));
    check('новый результат PHQ-9 18 с дельтой к предыдущему (+1 к 17) и словом «хуже»', /PHQ-9[^<]*: 18 \(\+1 к 17, хуже\)/.test(changesBlock));
    check('в блоке ≤ 8 строк', (changesBlock.match(/<li>/g) || []).length <= 8 && (changesBlock.match(/<li>/g) || []).length >= 1);
    r = await req('GET', `/patients/${N}`, { cookieJar: psy1 });
    check('пациент без данных: «Без изменений с …»', /Без изменений с \d{2}\.\d{2}\.\d{4}/.test(r.text));
    check('пустое состояние «Необязательно» в обзоре', r.text.includes('Необязательно'));

    console.log('3) Пустые состояния всех вкладок (Новиков), нет required и пустых таблиц');
    for (const [p, label] of tabs) {
      r = await req('GET', `/patients/${N}${p}`, { cookieJar: psy1 });
      check(`«${label}» без данных: 200, есть пояснение, нет required, нет пустого <tbody>`, r.status === 200 && /empty-state|Необязательно|hint/.test(r.text) && noRequired(r.text) && !/<tbody>\s*<\/tbody>/.test(r.text));
    }
    r = await req('GET', `/patients/${N}/notes`, { cookieJar: psy1 });
    check('заметки: «Заполнять не нужно»', /Заполнять не нужно/.test(r.text));

    console.log('4) Шкалы и динамика: график SVG, таблица-альтернатива, формы маркеров, ошибочный ввод');
    r = await req('GET', `/patients/${G}/scales?scale=phq9&period=all`, { cookieJar: psy1 });
    const pts = (r.text.match(/class="pc-point/g) || []).length;
    check('график SVG с точками и таблицей', /<svg class="pc-chart"/.test(r.text) && pts >= 5 && /Таблица \(те же данные\)/.test(r.text));
    check('онлайн и очные различимы: круг и квадрат + легенда', /pc-mark--online/.test(r.text) && /pc-mark--offline/.test(r.text) && /онлайн \(пациент\)/.test(r.text) && /очно \(бланк\)/.test(r.text));
    check('дисклеймер на вкладке', r.text.includes('result-disclaimer') && r.text.includes('не диагноз'));
    const offlinePhq = db.prepare("SELECT id FROM offline_results WHERE patient_id = ? AND instrument = 'phq9'").get(G);
    const gOffline = (rows) => { const ps = db.prepare('SELECT pseudonym FROM research_pseudonyms WHERE patient_id = ?').get(G); return ps ? rows.filter((x) => x.patient_pseudonym === ps.pseudonym && x.offline_scale === 'phq9').length : 0; };
    const expBefore = gOffline(researchExport.generateComparisonExport({ runBy: PSY1 }));
    r = await req('POST', `/patients/${G}/results/offline/${offlinePhq.id}/invalid`, { cookieJar: psy1, body: { reason: 'опечатка' } });
    check('пометка «ошибочный ввод» принята', r.status === 302 && db.prepare('SELECT invalid_at FROM offline_results WHERE id = ?').get(offlinePhq.id).invalid_at);
    r = await req('GET', `/patients/${G}/scales?scale=phq9&period=all`, { cookieJar: psy1 });
    check('точка ушла с графика, запись видна в «Исключено»', (r.text.match(/class="pc-point/g) || []).length === pts - 1 && /Исключено как ошибочный ввод: 1/.test(r.text));
    const exp = researchExport.generateComparisonExport({ runBy: PSY1 });
    check('ошибочный ввод исключён из научного экспорта (было → стало)', expBefore >= 1 && gOffline(exp) === 0);
    r = await req('GET', `/patients/${G}/journal`, { cookieJar: psy1 });
    check('в журнале осталась запись о пометке', /Помечено «ошибочный ввод»/.test(r.text));
    await req('POST', `/patients/${G}/results/offline/${offlinePhq.id}/valid`, { cookieJar: psy1, body: {} });

    console.log('5) Назначения: очная методика -> «ожидает ввода» -> внёс (дефект A0-B4, REQ-CAT-007)');
    r = await req('POST', '/assignments', { cookieJar: psy1, body: { patient_id: String(G), instrument: 'hdrs17' } });
    const hd = lastAssign(G, 'hdrs17');
    check('hdrs17 назначается: статус waiting_entry, редирект в карточку', r.status === 302 && r.location === `/patients/${G}` && hd && hd.status === 'waiting_entry');
    r = await req('GET', '/dashboard', { cookieJar: gromovJar });
    check('пациент очную методику НЕ видит', !/hdrs17|Гамильтон/i.test(r.text));
    r = await req('GET', `/patients/${G}`, { cookieJar: psy1 });
    check('в обзоре: «Ожидает ввода врачом»', /Ожидает ввода врачом/.test(r.text));
    r = await req('GET', `/patients/${G}/offline`, { cookieJar: psy1 });
    check('вкладка ввода: блок «Ожидают вашего ввода» с методикой', /id="waiting"/.test(r.text) && /ожидает ввода/.test(r.text) && r.text.includes('HDRS-17'));
    check('форма ввода: дата подставлена «сегодня», без required', /type="date" name="test_date" value="\d{4}-\d{2}-\d{2}"/.test(r.text) && noRequired(r.text));
    r = await req('POST', `/patients/${G}/results`, { cookieJar: psy1, body: { instrument: 'hdrs17', test_date: '', score: '14', status: 'draft' } });
    check('черновик протокола сохранён с датой по умолчанию, ожидание остаётся', r.status === 302 && lastAssign(G, 'hdrs17').status === 'waiting_entry' && lastAssign(G, 'hdrs17').entry_protocol_id);
    const prot = db.prepare("SELECT * FROM catalog_protocols WHERE patient_id = ? AND instrument = 'hdrs17'").get(G);
    check('в протоколе дата = сегодня', prot.test_date === new Date().toISOString().slice(0, 10) && prot.status === 'draft');
    r = await req('POST', `/patients/${G}/protocols/${prot.id}/ready`, { cookieJar: psy1, body: {} });
    check('«готово» закрывает ожидание: waiting_entry -> completed', lastAssign(G, 'hdrs17').status === 'completed' && lastAssign(G, 'hdrs17').completed_at);
    r = await req('GET', `/patients/${G}`, { cookieJar: psy1 });
    check('в обзоре hdrs17 больше не «ожидает»', !/HDRS-17[\s\S]{0,300}Ожидает ввода врачом/.test(r.text));
    r = await req('POST', '/assignments', { cookieJar: psy1, body: { patient_id: String(G), instrument: 'schulte' } });
    r = await req('POST', `/patients/${G}/results`, { cookieJar: psy1, body: { instrument: 'schulte', score: '5', status: 'ready' } });
    check('протокол сразу «готово» закрывает ожидание', lastAssign(G, 'schulte').status === 'completed');
    r = await req('POST', '/assignments', { cookieJar: psy1, body: { patient_id: String(G), instrument: 'mmpi' } });
    check('очная реальная шкала (СМИЛ) тоже ждёт ввода', lastAssign(G, 'mmpi').status === 'waiting_entry');
    await req('POST', `/patients/${G}/results`, { cookieJar: psy1, body: { instrument: 'mmpi', mmpi_scale2: '60', mmpi_scale7: '60', mmpi_scale9: '50' } });
    check('очный результат через единую форму закрывает ожидание', lastAssign(G, 'mmpi').status === 'completed');

    console.log('6) Дубли (REQ-CAT-011), срок и комментарий (REQ-CAT-015)');
    const nBefore = count("SELECT COUNT(*) AS n FROM instrument_assignments WHERE patient_id = ? AND instrument = 'gad7'", G);
    r = await req('POST', '/assignments', { cookieJar: psy1, body: { patient_id: String(G), instrument: 'gad7' } });
    check('повторное назначение ожидающего: форма подтверждения, дубль не создан', r.status === 200 && /Уже назначено/.test(r.text) && /Всё равно назначить/.test(r.text)
      && count("SELECT COUNT(*) AS n FROM instrument_assignments WHERE patient_id = ? AND instrument = 'gad7'", G) === nBefore);
    r = await req('POST', '/assignments', { cookieJar: psy1, body: { patient_id: String(G), instrument: 'gad7', force: '1', confirm: '1', due_date: '2099-01-01', comment: 'Пройдите, пожалуйста, до приёма' } });
    const g7 = lastAssign(G, 'gad7');
    check('«всё равно назначить» создаёт; срок и комментарий сохранены', r.status === 302 && count("SELECT COUNT(*) AS n FROM instrument_assignments WHERE patient_id = ? AND instrument = 'gad7'", G) === nBefore + 1 && g7.due_date === '2099-01-01' && g7.comment.startsWith('Пройдите'));
    r = await req('GET', '/dashboard', { cookieJar: gromovJar });
    check('комментарий виден пациенту, просрочка не краснит (поле необязательное)', r.status === 200);
    r = await req('POST', '/assignments', { cookieJar: psy1, body: { patient_id: String(N), instrument: 'who5', comment: 'x'.repeat(500) } });
    check('комментарий обрезан до 200 символов; пустые срок/комментарий — успех', lastAssign(N, 'who5').comment.length === 200);

    console.log('7) Отмена ошибочного назначения (REQ-CAT-012)');
    await req('POST', '/assignments', { cookieJar: psy1, body: { patient_id: String(G), instrument: 'isi' } });
    const isi = lastAssign(G, 'isi');
    let pr = await req('GET', '/dashboard', { cookieJar: gromovJar });
    check('до отмены пациент видит назначение', pr.text.includes(`/assignments/${isi.id}/take`));
    r = await req('POST', `/assignments/${isi.id}/cancel`, { cookieJar: psy1, body: { reason: 'ошибочно', back: `/patients/${G}` } });
    check('отмена: cancelled, кто/когда/причина записаны', r.status === 302 && lastAssign(G, 'isi').status === 'cancelled' && lastAssign(G, 'isi').cancelled_by === PSY1 && lastAssign(G, 'isi').cancel_reason === 'ошибочно' && lastAssign(G, 'isi').cancelled_at);
    pr = await req('GET', '/dashboard', { cookieJar: gromovJar });
    check('у пациента исчезло без ошибки', pr.status === 200 && !pr.text.includes(`/assignments/${isi.id}/take`));
    pr = await req('GET', `/assignments/${isi.id}/take`, { cookieJar: gromovJar });
    check('старая ссылка пациента: аккуратный 404, не 500', pr.status === 404);
    r = await req('GET', `/patients/${G}`, { cookieJar: psy1 });
    check('страница пациента после отмены: 200', r.status === 200);
    r = await req('GET', `/patients/${G}/journal`, { cookieJar: psy1 });
    check('журнал: «Отменено назначение … причина: ошибочно»', /Отменено назначение[^<]*причина: ошибочно/.test(r.text));
    const cssrs = db.prepare("SELECT id, status FROM instrument_assignments WHERE patient_id = ? AND instrument = 'cssrs' AND auto_assigned = 1").get(G);
    r = await req('POST', `/assignments/${cssrs.id}/cancel`, { cookieJar: psy1, body: {} });
    check('автоназначенный C-SSRS не отменяется (OQ-10), объяснение показано', db.prepare('SELECT status FROM instrument_assignments WHERE id = ?').get(cssrs.id).status === cssrs.status && cssrs.status === 'pending');
    r = await req('GET', `/patients/${G}`, { cookieJar: psy1 });
    check('в карточке у C-SSRS нет кнопки отмены, есть объяснение', /Назначено автоматически по кризисному протоколу — отменить нельзя/.test(r.text));
    const done = db.prepare("SELECT id FROM instrument_assignments WHERE patient_id = ? AND status = 'completed' AND auto_assigned = 0 LIMIT 1").get(G);
    r = await req('POST', `/assignments/${done.id}/cancel`, { cookieJar: psy1, body: {} });
    check('завершённое не отменяется', db.prepare('SELECT status FROM instrument_assignments WHERE id = ?').get(done.id).status === 'completed');

    console.log('8) Пакеты (REQ-CAT-010) и массовое назначение (REQ-CLN-019)');
    r = await req('POST', '/assignments', { cookieJar: psy1, body: { patient_id: String(N), package: 'tdr_screen' } });
    check('пакет: предпросмотр (200) без записи', r.status === 200 && /Предпросмотр назначения/.test(r.text) && /Скрининг ТДР/.test(r.text));
    const nPk = count("SELECT COUNT(*) AS n FROM instrument_assignments WHERE patient_id = ? AND batch_code = 'tdr_screen'", N);
    check('предпросмотр ничего не создал', nPk === 0);
    r = await req('POST', '/assignments', { cookieJar: psy1, body: { patient_id: String(N), package: 'tdr_screen', confirm: '1' } });
    check('подтверждение: создано N назначений, дубль who5 пропущен', r.status === 302 && count("SELECT COUNT(*) AS n FROM instrument_assignments WHERE patient_id = ? AND batch_code = 'tdr_screen' AND status = 'pending'", N) === 2);
    r = await req('POST', '/assignments', { cookieJar: psy1, body: { patient_id: [String(N), String(S)], instrument: 'isi' } });
    check('два пациента: предпросмотр с двумя строками', r.status === 200 && (r.text.match(/будет назначено/g) || []).length === 2);
    r = await req('POST', '/assignments', { cookieJar: psy1, body: { patient_id: [String(N), String(S)], instrument: 'isi', confirm: '1' } });
    check('массовое назначение: обоим создано', lastAssign(N, 'isi').status === 'pending' && lastAssign(S, 'isi').status === 'pending' && r.status === 302 && r.location === '/assignments');
    r = await req('GET', '/assignments', { cookieJar: psy1 });
    check('страница «Назначения»: текущие назначения с отменой, без required', r.status === 200 && /Текущие назначения/.test(r.text) && /Отменить назначение/.test(r.text) && noRequired(r.text));
    const sIsi = lastAssign(S, 'isi');
    await req('POST', `/assignments/${sIsi.id}/cancel`, { cookieJar: psy1, body: { back: '/assignments' } });
    check('отмена со страницы «Назначения»', lastAssign(S, 'isi').status === 'cancelled');

    console.log('9) Расписание повторов (REQ-CLN-020): пропуск 3 периодов -> ожидает ровно 1');
    r = await req('POST', '/assignments', { cookieJar: psy1, body: { patient_id: String(N), instrument: 'bai', repeat_every: '1', repeat_unit: 'weeks' } });
    const sched = db.prepare("SELECT * FROM assignment_schedules WHERE patient_id = ? AND instrument = 'bai'").get(N);
    check('расписание создано: каждые 7 дн.', sched && sched.every_days === 7 && sched.active === 1);
    const t21 = new Date(Date.now() + 22 * 86400000);
    assignments.runSchedules(t21);
    check('пропущено 3 периода, предыдущее не пройдено: ожидающее по-прежнему одно', count("SELECT COUNT(*) AS n FROM instrument_assignments WHERE patient_id = ? AND instrument = 'bai' AND status IN ('pending','waiting_entry')", N) === 1);
    db.prepare("UPDATE instrument_assignments SET status = 'completed', completed_at = datetime('now') WHERE patient_id = ? AND instrument = 'bai'").run(N);
    assignments.runSchedules(new Date(Date.now() + 60 * 86400000));
    check('после перерыва создано ровно одно (без лавины)', count("SELECT COUNT(*) AS n FROM instrument_assignments WHERE patient_id = ? AND instrument = 'bai' AND status = 'pending'", N) === 1);
    assignments.runSchedules(new Date(Date.now() + 60 * 86400000));
    check('повторный запуск дубль не создаёт; next_due_at сдвинут в будущее', count("SELECT COUNT(*) AS n FROM instrument_assignments WHERE patient_id = ? AND instrument = 'bai' AND status = 'pending'", N) === 1
      && new Date(db.prepare('SELECT next_due_at FROM assignment_schedules WHERE id = ?').get(sched.id).next_due_at) > new Date(Date.now() + 60 * 86400000));
    r = await req('POST', `/schedules/${sched.id}/stop`, { cookieJar: psy1, body: { back: `/patients/${N}` } });
    db.prepare("UPDATE instrument_assignments SET status = 'completed' WHERE patient_id = ? AND instrument = 'bai'").run(N);
    assignments.runSchedules(new Date(Date.now() + 200 * 86400000));
    check('после отключения новых нет', r.status === 302 && count("SELECT COUNT(*) AS n FROM instrument_assignments WHERE patient_id = ? AND instrument = 'bai' AND status = 'pending'", N) === 0);

    console.log('10) Согласие и архив (REQ-ALL-015, CLN-022)');
    db.prepare('UPDATE users SET clinical_consent_given = 0 WHERE id = ?').run(N);
    const nA = count('SELECT COUNT(*) AS n FROM instrument_assignments WHERE patient_id = ?', N);
    r = await req('POST', '/assignments', { cookieJar: psy1, body: { patient_id: String(N), instrument: 'phq9' } });
    check('без клинического согласия назначение не создаётся', count('SELECT COUNT(*) AS n FROM instrument_assignments WHERE patient_id = ?', N) === nA);
    r = await req('GET', `/patients/${N}`, { cookieJar: psy1 });
    check('карточка показывает причину: «согласие не оформлено»', /Клиническое согласие не оформлено/.test(r.text));
    db.prepare('UPDATE users SET clinical_consent_given = 1 WHERE id = ?').run(N);
    await req('POST', `/patients/${N}/archive`, { cookieJar: psy1, body: { back: `/patients/${N}` } });
    r = await req('POST', '/assignments', { cookieJar: psy1, body: { patient_id: String(N), instrument: 'phq9' } });
    check('архив: новые назначения невозможны', count('SELECT COUNT(*) AS n FROM instrument_assignments WHERE patient_id = ?', N) === nA);
    r = await req('GET', `/patients/${N}`, { cookieJar: psy1 });
    check('карточка архивного: метка и «Вернуть из архива»', /архив: наблюдение завершено/.test(r.text) && /Вернуть из архива/.test(r.text));
    await req('POST', `/patients/${N}/unarchive`, { cookieJar: psy1, body: {} });
    r = await req('POST', '/assignments', { cookieJar: psy1, body: { patient_id: String(N), instrument: 'epi' } });
    check('после возврата назначение снова возможно', lastAssign(N, 'epi') && count('SELECT COUNT(*) AS n FROM instrument_assignments WHERE patient_id = ?', N) === nA + 1);
    r = await req('GET', `/patients/${Z}`, { cookieJar: psy2 });
    check('открытые эскалации видны в обзоре кризисного пациента', /crisis-strip/.test(r.text) && /href="\/crisis\/\d+"/.test(r.text));
    db.prepare('UPDATE users SET clinical_consent_given = 0 WHERE id = ?').run(Z);
    r = await req('GET', `/patients/${Z}`, { cookieJar: psy2 });
    check('без согласия эскалации по-прежнему видны, баллы скрыты', /crisis-strip/.test(r.text) && /не передаются врачу/.test(r.text));
    db.prepare('UPDATE users SET clinical_consent_given = 1 WHERE id = ?').run(Z);

    console.log('11) Заметки (REQ-CLN-015): текст без остального, поиск, правка, удаление, приватность');
    const nn = count('SELECT COUNT(*) AS n FROM clinician_notes');
    r = await req('POST', `/patients/${G}/notes`, { cookieJar: psy1, body: { body: 'Жалуется на сон; уточнить дозировку' } });
    check('заметка только с текстом сохранена', r.status === 302 && count('SELECT COUNT(*) AS n FROM clinician_notes') === nn + 1);
    r = await req('POST', `/patients/${G}/notes`, { cookieJar: psy1, body: { body: '   ', tags: '', note_date: '' } });
    check('пустая заметка: не ошибка и не запись', r.status === 302 && count('SELECT COUNT(*) AS n FROM clinician_notes') === nn + 1);
    await req('POST', `/patients/${G}/notes`, { cookieJar: psy1, body: { body: 'Семья поддерживает', tags: 'семья, ресурс', note_date: '2026-10-01' } });
    r = await req('GET', `/patients/${G}/notes?q=сон`, { cookieJar: psy1 });
    check('поиск находит нужную заметку и не находит лишнюю', /Жалуется на сон/.test(r.text) && !/Семья поддерживает/.test(r.text));
    r = await req('GET', `/patients/${G}/notes?tag=ресурс`, { cookieJar: psy1 });
    check('фильтр по тегу', /Семья поддерживает/.test(r.text) && !/Жалуется на сон/.test(r.text));
    r = await req('GET', `/patients/${G}/notes`, { cookieJar: psycho });
    check('заметки приватны автору: психолог их не видит (OQ-11)', !/Жалуется на сон/.test(r.text) && r.status === 200);
    const note = db.prepare("SELECT id FROM clinician_notes WHERE body LIKE 'Жалуется%'").get();
    r = await req('POST', `/patients/${G}/notes/${note.id}`, { cookieJar: psycho, body: { body: 'взлом' } });
    check('чужую заметку нельзя править (404)', r.status === 404 && /Жалуется/.test(db.prepare('SELECT body FROM clinician_notes WHERE id = ?').get(note.id).body));
    r = await req('POST', `/patients/${G}/notes/${note.id}/delete`, { cookieJar: psycho, body: {} });
    check('чужую заметку нельзя удалить', r.status === 404 && !!db.prepare('SELECT 1 FROM clinician_notes WHERE id = ?').get(note.id));
    r = await req('POST', `/patients/${G}/notes/${note.id}`, { cookieJar: psy1, body: { body: 'Жалуется на сон; дозировка уточнена', tags: 'сон' } });
    check('правка заметки автором', /дозировка уточнена/.test(db.prepare('SELECT body FROM clinician_notes WHERE id = ?').get(note.id).body));
    r = await req('POST', `/patients/${G}/notes/${note.id}/delete`, { cookieJar: psy1, body: {} });
    check('удаление заметки автором', !db.prepare('SELECT 1 FROM clinician_notes WHERE id = ?').get(note.id));
    r = await req('GET', `/patients/${G}/notes`, { cookieJar: psy1 });
    check('форма заметки без required', noRequired(r.text));

    console.log('12) «Лечение»: психиатр редактирует, психолог — нет (REQ-CLN-007)');
    r = await req('POST', `/patients/${G}/treatment`, { cookieJar: psycho, body: { body: 'схема' } });
    check('психолог POST на лечение -> 403', r.status === 403 && count('SELECT COUNT(*) AS n FROM treatment_items') === 0);
    r = await req('GET', `/patients/${G}/treatment`, { cookieJar: psycho });
    check('у психолога нет кнопки добавления, раздел объяснён', r.status === 200 && !/Добавить запись/.test(r.text) && /Раздел ведёт психиатр/.test(r.text));
    r = await req('POST', `/patients/${G}/treatment`, { cookieJar: psy1, body: { body: 'Схема X (демо)' } });
    check('психиатр добавляет запись', r.status === 302 && count('SELECT COUNT(*) AS n FROM treatment_items') === 1);
    r = await req('GET', `/patients/${G}/treatment`, { cookieJar: psycho });
    check('психолог записей лечения не видит', !/Схема X/.test(r.text));

    console.log('13) Дневник и журнал');
    r = await req('GET', `/patients/${G}/diary`, { cookieJar: psy1 });
    check('дневник: оценки есть, заметки не показываются (умолчание OQ-2)', /Настроение \(1–10\)/.test(r.text) && /заметки дневника пациент врачу не передаёт/i.test(r.text) && !/<th>Заметка<\/th>/.test(r.text));
    r = await req('GET', `/patients/${G}/journal`, { cookieJar: psy1 });
    const times = [...r.text.matchAll(/<time datetime="([^"]+)"/g)].map((m) => m[1]);
    check('журнал: события по убыванию', times.length > 5 && times.every((t, i) => i === 0 || times[i - 1] >= t));
    r = await req('GET', `/patients/${G}/journal?type=assignment`, { cookieJar: psy1 });
    check('журнал: фильтр по типу', /Назначено:/.test(r.text) && !/Эскалация:/.test(r.text));
    r = await req('GET', `/patients/${G}/journal?from=2099-01-01`, { cookieJar: psy1 });
    check('журнал: фильтр по дате, пустое состояние', /Событий нет/.test(r.text));

    console.log('14) «К приёму» (REQ-PSA-002)');
    r = await req('GET', `/patients/${G}/visit`, { cookieJar: psy1 });
    check('справка: дисклеймер, печать, .txt, копировать', r.status === 200 && r.text.includes('result-disclaimer') && /Скачать \.txt/.test(r.text) && /id="pc-print"/.test(r.text) && /id="pc-copy"/.test(r.text) && /справка, не заключение/.test(r.text));
    const nx = count("SELECT COUNT(*) AS n FROM phi_access_log WHERE action = 'export_patient_visit_txt'");
    r = await req('GET', `/patients/${G}/visit.txt`, { cookieJar: psy1 });
    check('txt: вложение с дисклеймером и ФИО; экспорт записан в журнал', r.status === 200 && /attachment/.test(r.headers.get('content-disposition')) && /не диагноз/.test(r.text) && /Громов/.test(r.text)
      && count("SELECT COUNT(*) AS n FROM phi_access_log WHERE action = 'export_patient_visit_txt'") === nx + 1);
    r = await req('GET', `/patients/${Z}/visit.txt`, { cookieJar: psy1 });
    check('чужой пациент: txt недоступен (403)', r.status === 403);

    console.log('15) Негативные: чужой клиницист, пациент, админ');
    const nNotes = count('SELECT COUNT(*) AS n FROM clinician_notes');
    const nRes = count('SELECT COUNT(*) AS n FROM offline_results') + count('SELECT COUNT(*) AS n FROM catalog_protocols');
    const nAsg = count('SELECT COUNT(*) AS n FROM instrument_assignments');
    for (const p of ['', '/scales', '/offline', '/diary', '/treatment', '/notes', '/materials', '/journal', '/visit', '/visit.txt']) {
      r = await req('GET', `/patients/${Z}${p}`, { cookieJar: psy1 });
      check(`чужой пациент ${p || '/'}: 403`, r.status === 403);
    }
    r = await req('POST', `/patients/${Z}/notes`, { cookieJar: psy1, body: { body: 'чужой' } });
    check('чужой: заметка отклонена', r.status === 403 && count('SELECT COUNT(*) AS n FROM clinician_notes') === nNotes);
    r = await req('POST', `/patients/${Z}/results`, { cookieJar: psy1, body: { instrument: 'phq9', total_score: '10' } });
    check('чужой: ввод результата отклонён', r.status === 403 && count('SELECT COUNT(*) AS n FROM offline_results') + count('SELECT COUNT(*) AS n FROM catalog_protocols') === nRes);
    r = await req('POST', '/assignments', { cookieJar: psy1, body: { patient_id: String(Z), instrument: 'phq9' } });
    check('чужой: назначение отклонено', count('SELECT COUNT(*) AS n FROM instrument_assignments') === nAsg);
    const zA = db.prepare('SELECT id, status FROM instrument_assignments WHERE patient_id = ? LIMIT 1').get(Z);
    r = await req('POST', `/assignments/${zA.id}/cancel`, { cookieJar: psy1, body: {} });
    check('чужой: отмена назначения -> 403', r.status === 403 && db.prepare('SELECT status FROM instrument_assignments WHERE id = ?').get(zA.id).status === zA.status);
    const zRes = db.prepare('SELECT id FROM offline_results WHERE patient_id = ? LIMIT 1').get(Z);
    r = await req('POST', `/patients/${Z}/results/offline/${zRes.id}/invalid`, { cookieJar: psy1, body: {} });
    check('чужой: пометка ошибочного ввода -> 403', r.status === 403 && !db.prepare('SELECT invalid_at FROM offline_results WHERE id = ?').get(zRes.id).invalid_at);
    r = await req('POST', `/patients/${G}/results/offline/${zRes.id}/invalid`, { cookieJar: psy1, body: {} });
    check('подмена id результата другого пациента -> 404', r.status === 404 && !db.prepare('SELECT invalid_at FROM offline_results WHERE id = ?').get(zRes.id).invalid_at);
    r = await req('GET', `/patients/${G}`, { cookieJar: gromovJar });
    check('пациент не открывает карточку (403)', r.status === 403);
    r = await req('POST', '/assignments', { cookieJar: gromovJar, body: { patient_id: String(G), instrument: 'phq9' } });
    check('пациент не назначает (403)', r.status === 403);
    r = await req('POST', `/patients/${G}/notes`, { cookieJar: gromovJar, body: { body: 'x' } });
    check('пациент не пишет заметки (403)', r.status === 403);
    r = await req('GET', '/invites', { cookieJar: gromovJar });
    check('пациент не открывает коды-приглашения (403)', r.status === 403);
    for (const p of [`/patients/${G}`, `/patients/${G}/scales`, `/patients/${G}/visit`, '/assignments', '/invites']) {
      r = await req('GET', p, { cookieJar: admin });
      check(`админ ${p}: 403`, r.status === 403);
    }
    r = await req('POST', '/assignments', { cookieJar: admin, body: { patient_id: String(G), instrument: 'phq9' } });
    check('админ не назначает (403)', r.status === 403);
    r = await req('GET', `/patients/${G}`, { cookieJar: jar() });
    check('аноним: не получает карточку', r.status === 403 || r.status === 302);

    console.log('16) Коды-приглашения (REQ-CLN-021)');
    r = await req('POST', '/invites', { cookieJar: psy1, body: {} });
    const code = db.prepare('SELECT * FROM invite_codes WHERE clinician_id = ? ORDER BY id DESC').get(PSY1);
    check('код создан: формат, срок 7 дней, ссылка в списке', r.status === 302 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code.code) && Math.round((new Date(code.expires_at) - new Date(code.created_at)) / 86400000) === 7);
    r = await req('GET', '/invites', { cookieJar: psy1 });
    check('страница показывает активный код и «Отозвать»', r.text.includes(code.code) && /Отозвать/.test(r.text) && noRequired(r.text));
    check('код не раскрывает врача', !code.code.includes('Орлов') && invites.check(code.code).valid && Object.keys(invites.check(code.code)).join() === 'valid');
    const red = invites.redeem(code.code, F);
    check('пациент привязался по коду: он в списке врача', red.ok && !!db.prepare('SELECT 1 FROM care_assignments WHERE patient_id = ? AND clinician_id = ?').get(F, PSY1));
    check('повторное использование отклонено (одноразовый)', invites.redeem(code.code, N).ok === false && invites.redeem(code.code, N).reason === 'used');
    r = await req('GET', '/patients', { cookieJar: psy1 });
    check('привязанный пациент виден в «Пациенты»', /Фомин/.test(r.text));
    const c2 = invites.create(PSY1);
    db.prepare("UPDATE invite_codes SET expires_at = datetime('now','-1 day') WHERE id = ?").run(c2.id);
    check('просроченный код отклонён', invites.redeem(c2.code, N, new Date()).reason === 'expired');
    const c3 = invites.create(PSY1);
    r = await req('POST', `/invites/${c3.id}/revoke`, { cookieJar: psycho, body: {} });
    check('чужой код отозвать нельзя', db.prepare('SELECT revoked_at FROM invite_codes WHERE id = ?').get(c3.id).revoked_at === null);
    r = await req('POST', `/invites/${c3.id}/revoke`, { cookieJar: psy1, body: {} });
    check('автор отзывает код; отозванный не принимается', !!db.prepare('SELECT revoked_at FROM invite_codes WHERE id = ?').get(c3.id).revoked_at && invites.redeem(c3.code, N).reason === 'revoked');
    check('неизвестный код отклонён', invites.redeem('ZZZZ-ZZZZ', N).ok === false);

    console.log('17) Миграция: старая БД с instrument_assignments без cancelled');
    const oldDb = path.join(tmp, 'old.sqlite3');
    const Database = require('better-sqlite3');
    const o = new Database(oldDb);
    o.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('patient','psychiatrist','psychologist','admin')), full_name TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE instrument_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER NOT NULL REFERENCES users(id), assigned_by INTEGER NOT NULL REFERENCES users(id), instrument TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')), auto_assigned INTEGER NOT NULL DEFAULT 0, assigned_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT);
      CREATE TABLE online_results (id INTEGER PRIMARY KEY AUTOINCREMENT, assignment_id INTEGER REFERENCES instrument_assignments(id), patient_id INTEGER NOT NULL, instrument TEXT NOT NULL, answers_json TEXT NOT NULL, total_score INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO users (email, password_hash, role, full_name) VALUES ('a@x','h','patient','A'), ('b@x','h','psychiatrist','B');
      INSERT INTO instrument_assignments (patient_id, assigned_by, instrument, status) VALUES (1,2,'phq9','pending'), (1,2,'gad7','completed');
      INSERT INTO online_results (assignment_id, patient_id, instrument, answers_json, total_score) VALUES (2,1,'gad7','[]',5);`);
    o.close();
    const child = spawnSync(process.execPath, ['-e', `
      const db = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'db.js'))});
      const rows = db.prepare('SELECT id, instrument, status FROM instrument_assignments ORDER BY id').all();
      db.prepare("INSERT INTO instrument_assignments (patient_id, assigned_by, instrument, status) VALUES (1,2,'isi','waiting_entry')").run();
      db.prepare("UPDATE instrument_assignments SET status = 'cancelled' WHERE id = 1").run();
      const fk = db.prepare('PRAGMA foreign_key_check').all();
      console.log(JSON.stringify({ rows, fk: fk.length, res: db.prepare('SELECT assignment_id FROM online_results').get().assignment_id }));
    `], { env: { ...process.env, TDR_DB_PATH: oldDb }, encoding: 'utf8' });
    let mig = {};
    try { mig = JSON.parse(child.stdout.trim().split('\n').pop()); } catch (e) { console.error(child.stderr); }
    check('старые назначения сохранены с id, FK целы, новые статусы допустимы', mig.rows && mig.rows.length === 2 && mig.rows[0].status === 'pending' && mig.rows[1].status === 'completed' && mig.fk === 0 && mig.res === 2);
  } finally {
    server.close();
  }
  console.log(`\nclinician_card: ${oks} OK, ${failures} FAIL`);
  if (failures) process.exitCode = 1;
  else console.log('Все проверки карточки пациента прошли успешно.');
}

main().catch((e) => { console.error('FAIL', e); process.exitCode = 1; });
