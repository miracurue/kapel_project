'use strict';

require('./helpers').installCsrfFetch(); // W2.S: тесты получают и отправляют CSRF-токен как браузер

// W2.F: психообразование, лечение и приём, сообщения врач<->пациент, опросник перед приёмом.

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDb = path.join(os.tmpdir(), `tdr-care-${process.pid}-${Date.now()}.sqlite3`);
process.env.TDR_DB_PATH = tmpDb;
process.env.SESSION_SECRET = 'test-secret';
process.env.CRISIS_MERGE_WINDOW_MIN = '0'; // W3.K: проверяется «каждая кризисная фраза даёт эскалацию»; схлопывание повторов — в security_fixes.test.js

const app = require('../src/app');
const db = require('../src/db');
const { createUser } = require('./helpers');

let BASE;
let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  OK   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
}
function jar() {
  const cookies = new Map();
  return {
    store(res) { for (const c of res.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); cookies.set(pair.slice(0, i), pair.slice(i + 1)); } },
    header: () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
  };
}
async function req(method, p, { body, j } = {}) {
  const headers = {};
  if (j) headers.Cookie = j.header();
  let payload;
  if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
  const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
  if (j) j.store(res);
  return { status: res.status, text: await res.text(), location: res.headers.get('location') };
}
async function login(email) { const j = jar(); await req('POST', '/login', { j, body: { email, password: 'secret123' } }); return j; }
const esc = (pid) => db.prepare('SELECT COUNT(*) AS n FROM crisis_escalations WHERE patient_id = ?').get(pid).n;
const link = (pid, cid) => db.prepare('INSERT OR IGNORE INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(pid, cid);

async function main() {
  const server = app.listen(0);
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    const psy = createUser(db, { email: 'psy@example.test', full_name: 'Психиатр Тестов', role: 'psychiatrist' });
    const psl = createUser(db, { email: 'psl@example.test', full_name: 'Психолог Тестова', role: 'psychologist' });
    const other = createUser(db, { email: 'other@example.test', full_name: 'Чужой Врач', role: 'psychiatrist' });
    const adm = createUser(db, { email: 'adm@example.test', full_name: 'Админ', role: 'admin' });
    const pA = createUser(db, { email: 'pa@example.test', full_name: 'Пациент Альфа', role: 'patient' });
    const pB = createUser(db, { email: 'pb@example.test', full_name: 'Пациент Бета', role: 'patient' });
    const pN = createUser(db, { email: 'pn@example.test', full_name: 'Пациент Без Врача', role: 'patient' });
    link(pA, psy); link(pA, psl); link(pB, other);
    const jPsy = await login('psy@example.test');
    const jPsl = await login('psl@example.test');
    const jOther = await login('other@example.test');
    const jAdm = await login('adm@example.test');
    const jA = await login('pa@example.test');
    const jB = await login('pb@example.test');
    const jN = await login('pn@example.test');
    let r;

    console.log('1) Пациент без врача (MSG-004)');
    r = await req('GET', '/messages', { j: jN });
    check('страница понятная: нет врача, путь — код / ИИ / 112', r.status === 200 && /не привязаны к врачу/.test(r.text) && /ИИ-помощник/.test(r.text) && !/<textarea/.test(r.text));
    r = await req('POST', '/messages', { j: jN, body: { clinician_id: String(psy), body: 'Здравствуйте' } });
    check('POST не создаёт сообщение', db.prepare('SELECT COUNT(*) AS n FROM care_messages WHERE patient_id = ?').get(pN).n === 0);
    r = await req('GET', '/meds', { j: jN });
    check('«Лечение» без врача: можно вести свой список, плана нет', r.status === 200 && /Врач пока ничего не показал/.test(r.text));

    console.log('2) Сообщения: доставка, прочтение, ответ, плашка (MSG-001/002)');
    r = await req('GET', '/messages', { j: jA });
    check('плашка «не для срочных случаев» и «Мне плохо»', /Не для срочных случаев/.test(r.text) && /Мне плохо/.test(r.text) && /maxlength="2000"/.test(r.text));
    await req('POST', '/messages', { j: jA, body: { clinician_id: String(psy), body: 'Добрый день, вопрос про сон.' } });
    r = await req('GET', `/messages?with=${psy}`, { j: jA });
    check('сообщение видно пациенту, статус «доставлено»', /вопрос про сон/.test(r.text) && /доставлено/.test(r.text));
    r = await req('GET', '/inbox', { j: jPsy });
    check('врач: входящие с бейджем непрочитанных', /Пациент Альфа/.test(r.text) && /новых: 1/.test(r.text) && /aria-label="новых: 1"/.test(r.text));
    r = await req('GET', '/inbox', { j: jPsl });
    check('другой клиницист (психолог) не видит чужой тред', !/Пациент Альфа/.test(r.text));
    r = await req('GET', `/patients/${pA}/messages`, { j: jPsy });
    check('врач открывает диалог, видит текст', r.status === 200 && /вопрос про сон/.test(r.text));
    r = await req('GET', `/messages?with=${psy}`, { j: jA });
    check('пациент видит «прочитано врачом»', /прочитано врачом/.test(r.text));
    r = await req('GET', '/inbox', { j: jPsy });
    check('бейдж непрочитанных уменьшился, «не обработано»', !/новых: 1/.test(r.text) && /не обработано/.test(r.text));
    await req('POST', `/patients/${pA}/messages`, { j: jPsy, body: { body: 'Обсудим на приёме.' } });
    check('ответ закрывает входящие как обработанные', db.prepare("SELECT COUNT(*) AS n FROM care_messages WHERE patient_id = ? AND sender_role = 'patient' AND handled_at IS NULL").get(pA).n === 0);
    r = await req('GET', '/dashboard', { j: jA });
    check('на главной пациента карточка «Сообщение от врача»', /Сообщение от врача/.test(r.text));
    r = await req('GET', `/patients/${pA}/messages?tpl=got_it`, { j: jPsy });
    check('быстрый ответ подставляется в поле без JS', /Получил\(а\) ваше сообщение/.test(r.text));

    console.log('3) Кризисная фраза в сообщении (PAT-016)');
    const e0 = esc(pA);
    r = await req('POST', '/messages', { j: jA, body: { clinician_id: String(psy), body: 'Мне обычно нормально, спасибо.' } });
    check('обычный текст: эскалации нет', esc(pA) === e0);
    r = await req('POST', '/messages', { j: jA, body: { clinician_id: String(psy), body: 'я не хочу жить' } });
    r = await req('GET', `/messages?with=${psy}`, { j: jA });
    check('кризисная фраза: эскалация создана и показан блок поддержки', esc(pA) === e0 + 1 && /support-block/.test(r.text));
    check('в эскалации источник «message»', !!db.prepare("SELECT 1 FROM crisis_escalations WHERE patient_id = ? AND instrument = 'message'").get(pA));

    console.log('4) Изоляция и роли (SEC-001, MSG-003)');
    r = await req('GET', `/patients/${pA}/messages`, { j: jOther });
    check('чужой врач: 403 на диалог', r.status === 403);
    r = await req('POST', `/patients/${pA}/messages`, { j: jOther, body: { body: 'взлом' } });
    check('чужой врач не может писать', r.status === 403 && db.prepare("SELECT COUNT(*) AS n FROM care_messages WHERE body = 'взлом'").get().n === 0);
    r = await req('GET', `/patients/${pA}/messages`, { j: jAdm });
    check('админ не видит сообщения (403)', r.status === 403);
    r = await req('GET', '/inbox', { j: jAdm });
    check('админ: /inbox 403', r.status === 403);
    r = await req('GET', '/inbox', { j: jA });
    check('пациент: /inbox 403', r.status === 403);
    r = await req('GET', `/messages?with=${other}`, { j: jA });
    check('пациент не может писать чужому врачу', !/<textarea/.test(r.text) || !new RegExp(`name="clinician_id" value="${other}"`).test(r.text));
    await req('POST', '/messages', { j: jA, body: { clinician_id: String(other), body: 'чужому' } });
    check('POST чужому врачу не сохранён', db.prepare("SELECT COUNT(*) AS n FROM care_messages WHERE body = 'чужому'").get().n === 0);
    r = await req('GET', '/messages', { j: jB });
    check('пациент B не видит треды пациента A', !/Обсудим на приёме/.test(r.text));
    r = await req('GET', '/learn', { j: jPsy });
    check('врач не открывает кабинет пациента /learn', r.status === 403);

    console.log('5) Недоступность врача (MSG-004)');
    await req('POST', '/inbox/settings', { j: jPsl, body: { reply_note: 'Отвечаю в рабочие дни до 18:00', away_until: '2999-01-01' } });
    r = await req('GET', `/messages?with=${psl}`, { j: jA });
    check('пациент видит подпись и «недоступен до»', /Отвечаю в рабочие дни до 18:00/.test(r.text) && /недоступен до 01\.01\.2999/.test(r.text) && !new RegExp(`name="clinician_id" value="${psl}"`).test(r.text));
    await req('POST', '/messages', { j: jA, body: { clinician_id: String(psl), body: 'тест недоступности' } });
    check('отправка недоступному врачу отклонена', db.prepare("SELECT COUNT(*) AS n FROM care_messages WHERE body = 'тест недоступности'").get().n === 0);
    await req('POST', '/inbox/settings', { j: jPsl, body: { reply_note: '', away_until: '' } });

    console.log('6) План приёма и журнал (PAT-023, CLN-014, permissions)');
    r = await req('POST', `/patients/${pA}/plan`, { j: jPsl, body: { name: 'ПрепаратПсихолога', slot: 'morning' } });
    check('психолог не может внести план лекарств (403, строки нет)', r.status === 403 && db.prepare('SELECT COUNT(*) AS n FROM med_items WHERE patient_id = ? AND source = ?').get(pA, 'clinician').n === 0);
    r = await req('GET', `/patients/${pA}/treatment`, { j: jPsl });
    check('психолог: раздел без формы плана', r.status === 200 && !/plan-name/.test(r.text));
    r = await req('POST', `/patients/${pA}/plan`, { j: jOther, body: { name: 'Чужой', slot: 'morning' } });
    check('чужой врач не вносит план (403)', r.status === 403);
    r = await req('POST', `/patients/${pA}/plan`, { j: jPsy, body: { name: 'Препарат-тест', how_text: 'как договорились', slot: 'both' } });
    const item = db.prepare("SELECT id FROM med_items WHERE patient_id = ? AND source = 'clinician'").get(pA);
    check('психиатр добавил пункт (свободный текст)', !!item);
    r = await req('GET', '/meds', { j: jA });
    check('пациент не видит пункт до публикации', !/Препарат-тест/.test(r.text));
    r = await req('POST', `/meds/log`, { j: jA, body: { item_id: String(item.id), slot: 'morning', status: 'taken' } });
    check('отметка непоказанного пункта: 404, записи нет', r.status === 404 && db.prepare('SELECT COUNT(*) AS n FROM med_log').get().n === 0);
    await req('POST', `/patients/${pA}/plan/${item.id}/publish`, { j: jPsy, body: {} });
    r = await req('GET', '/meds', { j: jA });
    check('после «Показать пациенту» пункт виден, дисклеймер без дозировок', /Препарат-тест/.test(r.text) && /не подсказывает дозы/.test(r.text) && !/badge-risk|crisis-banner/.test(r.text));
    await req('POST', '/meds/log', { j: jA, body: { item_id: String(item.id), slot: 'morning', status: 'taken' } });
    r = await req('POST', '/meds/log', { j: jA, body: { item_id: String(item.id), slot: 'evening', status: 'skipped' } });
    r = await req('GET', '/meds', { j: jA });
    check('отметки «принято» и «пропущено»', /принято/.test(r.text) && /пропущено/.test(r.text));
    r = await req('POST', '/meds/log', { j: jB, body: { item_id: String(item.id), slot: 'morning', status: 'taken' } });
    check('чужой пациент не отмечает чужой пункт (404)', r.status === 404);
    await req('POST', `/meds/${item.id}/ack`, { j: jA, body: {} });
    check('«понял» сохранён', !!db.prepare('SELECT ack_at FROM med_items WHERE id = ?').get(item.id).ack_at);
    r = await req('POST', '/meds/log', { j: jA, body: { item_id: String(item.id), slot: 'morning', status: 'later' } });
    check('«позже» не считается пропуском (нейтрально)', db.prepare("SELECT status FROM med_log WHERE item_id = ? AND slot = 'morning'").get(item.id).status === 'later');
    r = await req('GET', `/patients/${pA}/treatment`, { j: jPsy });
    check('психиатр видит блок отметок приёма', /Отметки приёма пациента/.test(r.text) && /План приёма для пациента/.test(r.text));

    console.log('7) Приверженность и согласие «делиться»');
    const meds = require('../src/care/meds');
    db.prepare('UPDATE med_items SET published_at = ? WHERE id = ?').run(new Date(Date.now() - 6 * 86400000).toISOString(), item.id);
    const ad = meds.adherence(pA);
    check('ожидаемые приёмы считаются по дням после публикации (5 дней x 2)', ad.expected === 10 && ad.taken === 0 && ad.unlogged === 10);
    meds.logIntake({ patientId: pA, itemId: item.id, slot: 'morning', status: 'taken', day: meds.dayStr(new Date(Date.now() - 86400000)) });
    meds.logIntake({ patientId: pA, itemId: item.id, slot: 'evening', status: 'skipped', day: meds.dayStr(new Date(Date.now() - 86400000)) });
    const ad2 = meds.adherence(pA);
    check('taken/skipped учтены', ad2.taken === 1 && ad2.skipped === 1);
    r = await req('GET', `/patients/${pA}/treatment`, { j: jPsy });
    check('врач видит «отмечено принято 1 из 10»', /«принято» — 1 из 10/.test(r.text));
    await req('POST', '/share', { j: jA, body: { scores: '1' } });
    r = await req('GET', `/patients/${pA}/treatment`, { j: jPsy });
    check('пациент выключил «делиться»: врач видит «не делится»', /не делится журналом приёма/.test(r.text) && !/«принято» — 1 из 10/.test(r.text));
    check('и личный список врачу не виден', (await req('GET', `/patients/${pA}/treatment`, { j: jPsy })).text.includes('не показывает'));
    await req('POST', '/meds', { j: jA, body: { name: 'МойЛичныйПрепарат', slot: 'none' } });
    r = await req('GET', `/patients/${pA}/treatment`, { j: jPsy });
    check('личный список скрыт, пока не разрешён', !/МойЛичныйПрепарат/.test(r.text));
    await req('POST', '/share', { j: jA, body: { scores: '1', med_log: '1', med_own: '1' } });
    r = await req('GET', `/patients/${pA}/treatment`, { j: jPsy });
    check('после разрешения личный список виден', /МойЛичныйПрепарат/.test(r.text));

    console.log('8) Светофор и приверженность (конфиг, review-required)');
    const rules = require('../src/triage_rules');
    const snap = { consent: { clinical: true, active: true }, openEscalations: [], results: [], pending: [], assignedInWindow: 0, completedInWindow: 0, lastActivityAt: new Date().toISOString(), meds: { expected: 10, taken: 1, days: 7 } };
    check('по умолчанию светофор приём не учитывает', rules.evaluate(snap).color === 'green' && rules.CONFIG.medAdherenceEnabled === false);
    const v = rules.evaluate(snap, new Date(), { medAdherenceEnabled: true });
    check('при включении конфига — «Внимание» с причиной', v.color === 'yellow' && /плану приёма/.test(v.oneLine));

    console.log('9) Психообразование (PAT-022, PSY-007)');
    r = await req('GET', '/learn', { j: jA });
    check('4 модуля, пометка review-required', (r.text.match(/class="item-card"/g) || []).length === 4 && /не прошёл клиническое ревью/.test(r.text));
    r = await req('GET', '/learn/nonexistent', { j: jA });
    check('неизвестный модуль: 404', r.status === 404);
    await req('POST', `/patients/${pA}/learn/assign`, { j: jPsl, body: { module: 'thought_diary' } });
    check('психолог назначил модуль', !!db.prepare("SELECT 1 FROM psychoed_assignments WHERE patient_id = ? AND module_key = 'thought_diary'").get(pA));
    r = await req('POST', `/patients/${pB}/learn/assign`, { j: jPsl, body: { module: 'tdr' } });
    check('психолог не назначает чужому пациенту (403)', r.status === 403 && !db.prepare('SELECT 1 FROM psychoed_assignments WHERE patient_id = ?').get(pB));
    r = await req('POST', `/patients/${pA}/learn/assign`, { j: jA, body: { module: 'tdr' } });
    check('пациент не может назначать (403)', r.status === 403);
    r = await req('GET', '/dashboard', { j: jA });
    check('назначенный модуль на главной', /Дневник мыслей/.test(r.text));
    await req('POST', '/learn/thought_diary/read', { j: jA, body: { done: '1' } });
    r = await req('GET', '/learn', { j: jA });
    check('прогресс сохраняется: прочитано 1 из 4', /Прочитано: 1 из 4/.test(r.text));
    await req('POST', '/learn/thought_diary/read', { j: jA, body: { done: '0' } });
    check('можно вернуть в «не прочитано»', !db.prepare('SELECT 1 FROM psychoed_progress WHERE patient_id = ?').get(pA));

    console.log('10) Опросник перед приёмом (PAT-025)');
    r = await req('GET', '/previsit', { j: jA });
    check('без запроса врача анкеты нет', /Сейчас анкета не нужна/.test(r.text) && !/<form/.test(r.text.replace(/<form method="POST" action="\/logout"[\s\S]*?<\/form>/, '')));
    await req('POST', `/patients/${pA}/previsit/request`, { j: jPsy, body: {} });
    r = await req('GET', '/previsit', { j: jA });
    check('после запроса врача анкета видна, вопросы необязательные (нет required)', /Отправить врачу/.test(r.text) && !/required/.test(r.text));
    const e1 = esc(pA);
    await req('POST', '/previsit', { j: jA, body: { action: 'send', general: '4', topics: 'не хочу жить', meds: 'partly' } });
    check('кризисная фраза в анкете: эскалация', esc(pA) === e1 + 1);
    r = await req('GET', `/patients/${pA}/visit`, { j: jPsy });
    check('ответы анкеты в «К приёму»', /Перед приёмом от пациента/.test(r.text) && /Частично/.test(r.text));
    r = await req('GET', `/patients/${pA}/visit.txt`, { j: jPsy });
    check('и в .txt', /Анкета перед приёмом/.test(r.text));
    await req('POST', `/patients/${pA}/previsit/request`, { j: jPsy, body: {} });
    await req('POST', '/previsit', { j: jA, body: { action: 'skip' } });
    check('«пропустить» закрывает запрос без ответов', !db.prepare("SELECT 1 FROM previsit_forms WHERE patient_id = ? AND status = 'open'").get(pA));

    console.log('11) Без согласия и удаление данных');
    db.prepare('UPDATE users SET clinical_consent_given = 0 WHERE id = ?').run(pB);
    link(pB, psy);
    r = await req('POST', '/messages', { j: jB, body: { clinician_id: String(psy), body: 'без согласия' } });
    check('без клинического согласия сообщение не отправляется', db.prepare("SELECT COUNT(*) AS n FROM care_messages WHERE body = 'без согласия'").get().n === 0);
    const adminDel = require('../src/admin_deletion');
    const inv = adminDel.inventory(pA).map((x) => x.table);
    check('удаление данных покрывает таблицы ухода', ['care_messages', 'med_items', 'med_log', 'previsit_forms', 'psychoed_progress', 'psychoed_assignments'].every((t) => inv.includes(t)));
    r = await req('GET', `/patients/${pA}/journal`, { j: jPsy });
    check('просмотр диалога попал в журнал доступа', /Открыт диалог с пациентом/.test(r.text));
  } finally {
    server.close();
    db.close();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(tmpDb + '-wal', { force: true });
    fs.rmSync(tmpDb + '-shm', { force: true });
  }
  console.log(`\n${failures === 0 ? 'Все проверки ухода и сообщений прошли успешно.' : `${failures} проверок не прошло.`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
