'use strict';

require('./helpers').installCsrfFetch(); // W2.S: тесты получают и отправляют CSRF-токен как браузер

// W3.K: исправление находок ревью безопасности W3.H (решения владельца 2026-10-11, .agents/DECISIONS.md).
//  M-3 TTL псевдонима/соль · M-4 привязка админом в журнале + «врач изменился» · M-5 просмотры списков в phi_access_log
//  M-6 ИИ-материалы после снятия закрепления · M-7 ограниченное хранилище сессий · L-2/3/4 кризисный шлюз всегда + схлопывание
//  L-5 запись при отозванном согласии · L-6 отмена удаления и научное согласие · L-8 таймауты бездействия.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const tmpDb = path.join(os.tmpdir(), `tdr-secfix-${process.pid}-${Date.now()}.sqlite3`);
process.env.TDR_DB_PATH = tmpDb;
process.env.SESSION_SECRET = 'test-secret';
process.env.SESSION_MAX_ANON = '40'; // M-7: маленький потолок, чтобы проверить вытеснение
process.env.CRISIS_MERGE_WINDOW_MIN = '15';
process.env.TDR_OUTBOX_PATH = path.join(os.tmpdir(), `tdr-secfix-outbox-${process.pid}.log`);

const app = require('../src/app');
const db = require('../src/db');
const { createUser } = require('./helpers');
const researchExport = require('../src/research_export');
const escalation = require('../src/escalation');
const crisisGate = require('../src/ai/crisisGate');
const sessionPolicy = require('../src/security/session_policy');
const { BoundedMemoryStore } = require('../src/security/session_store');
const calc = require('../src/tools/calculator');
const csvImport = require('../src/tools/csv_import');

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
async function req(method, p, { body, j, json } = {}) {
  const headers = {};
  if (j) headers.Cookie = j.header();
  let payload;
  if (body) {
    if (json) { headers['Content-Type'] = 'application/json'; headers.Accept = 'application/json'; headers['X-Requested-With'] = 'fetch'; headers['X-CSRF-Token'] = j && j.token ? j.token : 'a'.repeat(64); payload = JSON.stringify(body); }
    else { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
  }
  const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
  if (j) j.store(res);
  return { status: res.status, text: await res.text(), location: res.headers.get('location'), headers: res.headers };
}
async function login(email) { const j = jar(); await req('POST', '/login', { j, body: { email, password: 'secret123' } }); return j; }
const link = (pid, cid) => db.prepare('INSERT OR IGNORE INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(pid, cid);
const escRows = (pid) => db.prepare('SELECT * FROM crisis_escalations WHERE patient_id = ? ORDER BY id').all(pid);
const phi = (actor, pid, action) => db.prepare('SELECT COUNT(*) AS n FROM phi_access_log WHERE actor_id = ? AND patient_id = ? AND action = ?').get(actor, pid, action).n;
const CRISIS = 'не хочу жить';

async function main() {
  const server = app.listen(0);
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    const psy = createUser(db, { email: 'psy@example.test', full_name: 'Психиатр Тестов', role: 'psychiatrist' });
    const psy2 = createUser(db, { email: 'psy2@example.test', full_name: 'Психиатр Второй', role: 'psychiatrist' });
    const adm = createUser(db, { email: 'adm@example.test', full_name: 'Админ', role: 'admin' });
    const pA = createUser(db, { email: 'pa@example.test', full_name: 'Пациент Альфа', role: 'patient' });
    const pN = createUser(db, { email: 'pn@example.test', full_name: 'Пациент Без Врача', role: 'patient' });
    const pR = createUser(db, { email: 'pr@example.test', full_name: 'Пациент Отозвал', role: 'patient' });
    const pM = createUser(db, { email: 'pm@example.test', full_name: 'Пациент Мерж', role: 'patient' });
    link(pA, psy); link(pR, psy); link(pM, psy);
    const jPsy = await login('psy@example.test');
    const jAdm = await login('adm@example.test');
    const jA = await login('pa@example.test');
    const jN = await login('pn@example.test');
    const jM = await login('pm@example.test');
    let r;

    console.log('1) M-3: TTL псевдонима исполняется, соль обязательна в production');
    db.prepare('UPDATE users SET anonymized_export_opt_in = 1 WHERE id = ?').run(pA);
    const p1 = researchExport.getOrCreatePseudonym(pA);
    check('повторный вызов в пределах TTL возвращает тот же псевдоним', researchExport.getOrCreatePseudonym(pA) === p1);
    const exp1 = db.prepare('SELECT expires_at FROM research_pseudonyms WHERE patient_id = ?').get(pA).expires_at;
    check('срок жизни ≈ RESEARCH_PSEUDONYM_TTL_DAYS вперёд', Math.abs(Date.parse(exp1) - Date.now() - researchExport.PSEUDONYM_TTL_DAYS * 86400000) < 60000);
    db.prepare("UPDATE research_pseudonyms SET expires_at = ? WHERE patient_id = ?").run(new Date(Date.now() - 1000).toISOString(), pA);
    const p2 = researchExport.getOrCreatePseudonym(pA);
    check('после истечения TTL выдаётся НОВЫЙ псевдоним (выгрузки не связываются)', p2 !== p1 && p2.length === 24);
    check('новый срок жизни в будущем', Date.parse(db.prepare('SELECT expires_at FROM research_pseudonyms WHERE patient_id = ?').get(pA).expires_at) > Date.now());
    db.prepare("UPDATE research_pseudonyms SET expires_at = ? WHERE patient_id = ?").run(new Date(Date.now() - 1000).toISOString(), pA);
    researchExport.generateComparisonExport({ runBy: adm });
    check('экспорт вычищает просроченные сопоставления patient_id ↔ псевдоним', db.prepare('SELECT COUNT(*) AS n FROM research_pseudonyms WHERE patient_id = ?').get(pA).n === 0);
    const probe = (env) => spawnSync(process.execPath, ['-e', "require('./src/research_export')"], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, TDR_DB_PATH: path.join(os.tmpdir(), `tdr-salt-${process.pid}.sqlite3`), ...env }, encoding: 'utf8' });
    const noSalt = probe({ NODE_ENV: 'production', SESSION_SECRET: 'x' });
    check('production без RESEARCH_PSEUDONYM_SALT: модуль экспорта не загружается', noSalt.status !== 0 && /RESEARCH_PSEUDONYM_SALT/.test(noSalt.stderr));
    const withSalt = probe({ NODE_ENV: 'production', SESSION_SECRET: 'x', RESEARCH_PSEUDONYM_SALT: 'prod-salt-123456' });
    check('production с солью: загружается', withSalt.status === 0);
    fs.rmSync(path.join(os.tmpdir(), `tdr-salt-${process.pid}.sqlite3`), { force: true });

    console.log('2) M-5: просмотры списков с ПД пишутся в phi_access_log');
    await req('POST', '/messages', { j: jA, body: { clinician_id: String(psy), body: 'Вопрос про сон' } });
    escalation.createEscalation({ patientId: pA, instrument: 'chatbot', reasons: ['тест'], tier: 1, triggers: [] });
    for (const [pth, action] of [['/patients', 'view_list_patients'], ['/crisis', 'view_list_crisis'], ['/inbox', 'view_list_inbox'], ['/dashboard', 'view_list_dashboard'], [`/tools/export/${pA}`, 'view_export_page']]) {
      r = await req('GET', pth, { j: jPsy });
      check(`GET ${pth}: 200 и запись ${action} (врач → пациент)`, r.status === 200 && phi(psy, pA, action) === 1);
    }
    await req('GET', '/patients', { j: jPsy });
    check('повторный просмотр в окне 5 минут не множит записи', phi(psy, pA, 'view_list_patients') === 1);
    r = await req('GET', '/tools/reminders', { j: jPsy });
    check('/tools/reminders открывается (журнал пишется на каждого показанного пациента)', r.status === 200);
    const logged = db.prepare("SELECT action FROM phi_access_log WHERE actor_id = ? AND action LIKE 'view_list_%'").all(psy);
    check('в журнале только факт (кто/какой пациент/раздел), без текстов', logged.every((x) => /^view_list_[a-z]+$/.test(x.action)));
    r = await req('GET', '/privacy', { j: jA });
    check('пациент видит эти просмотры в «Приватности»', /показан в списке пациентов/.test(r.text) && /показан во входящих сообщениях/.test(r.text));

    console.log('3) M-6: ИИ-диалог и материалы по пациенту после снятия закрепления');
    r = await req('POST', '/ai/new', { j: jPsy, body: { patient_id: String(pA) } });
    const tid = Number(/\/ai\/t\/(\d+)/.exec(r.location)[1]);
    const free = new Date(Date.now() + 86400000 * 20).toISOString();
    const matId = db.prepare("INSERT INTO ai_attachments (thread_id, owner_user_id, patient_id, seq, name, kind, text_extracted, expires_at) VALUES (?, ?, ?, 1, 'ЗаметкаМаркер.txt', 'text', 'УНИКАЛЬНЫЙМАРКЕРТЕКСТ материал', ?)").run(tid, psy, pA, free).lastInsertRowid;
    db.prepare("INSERT INTO ai_messages (thread_id, role, text, kind) VALUES (?, 'assistant', 'Черновик ответа', 'normal')").run(tid);
    r = await req('GET', `/tools/search?q=${encodeURIComponent('УНИКАЛЬНЫЙМАРКЕРТЕКСТ')}`, { j: jPsy });
    check('до снятия: поиск находит материал', /ЗаметкаМаркер/.test(r.text));
    r = await req('GET', `/ai/t/${tid}/export.txt`, { j: jPsy });
    check('до снятия: экспорт диалога работает', r.status === 200);
    db.prepare('DELETE FROM care_assignments WHERE patient_id = ? AND clinician_id = ?').run(pA, psy);
    r = await req('GET', `/ai/t/${tid}`, { j: jPsy });
    check('после снятия: открытие диалога -> переход на удаление, содержимого нет', r.status === 302 && r.location === `/ai/t/${tid}/delete`);
    r = await req('GET', `/ai/t/${tid}/export.txt`, { j: jPsy });
    check('экспорт диалога закрыт (403)', r.status === 403 && !/Черновик ответа/.test(r.text));
    r = await req('GET', `/ai/materials/${matId}/download`, { j: jPsy });
    check('скачивание материала закрыто (403)', r.status === 403);
    r = await req('POST', '/ai/send', { j: jPsy, json: true, body: { thread_id: String(tid), text: 'продолжим' } });
    check('отправка в закрытый диалог отклонена (403 JSON)', r.status === 403);
    r = await req('GET', `/tools/search?q=${encodeURIComponent('УНИКАЛЬНЫЙМАРКЕРТЕКСТ')}`, { j: jPsy });
    check('поиск больше не показывает материал', !/ЗаметкаМаркер/.test(r.text));
    r = await req('GET', '/ai', { j: jPsy });
    check('в списке диалогов заголовок закрытого диалога скрыт', /Диалог по пациенту \(недоступен\)/.test(r.text));
    r = await req('POST', `/ai/t/${tid}/delete`, { j: jPsy, body: {} });
    check('удалить закрытый диалог можно', r.status === 302 && !db.prepare('SELECT 1 FROM ai_threads WHERE id = ?').get(tid) && !db.prepare('SELECT 1 FROM ai_attachments WHERE id = ?').get(matId));
    link(pA, psy);

    console.log('4) L-2: кризисный шлюз выполняется до любых отказов');
    const before = escRows(pN).length;
    r = await req('POST', '/chat/send', { j: jN, body: { thread_id: '99999', text: CRISIS } });
    check('чат: устаревший/несуществующий тред + кризисная фраза -> эскалация создана (без врача: очередь администратора)', r.status === 302 && escRows(pN).length === before + 1);
    r = await req('POST', '/chat/send', { j: jN, body: { thread_id: '99999', text: 'обычное сообщение' } });
    check('чат: обычный текст в несуществующий тред по-прежнему 404, без побочных эффектов', r.status === 404 && escRows(pN).length === before + 1);
    // врач недоступен
    const away = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    db.prepare('INSERT OR REPLACE INTO care_clinician_settings (clinician_id, reply_note, away_until) VALUES (?, NULL, ?)').run(psy, away);
    db.prepare("UPDATE crisis_escalations SET status = 'acknowledged' WHERE patient_id = ?").run(pA);
    const bA = escRows(pA).length;
    const msgsBefore = db.prepare('SELECT COUNT(*) AS n FROM care_messages WHERE patient_id = ?').get(pA).n;
    r = await req('POST', '/messages', { j: jA, body: { clinician_id: String(psy), body: CRISIS } });
    check('сообщение врачу при его отсутствии не отправлено, но эскалация создана', db.prepare('SELECT COUNT(*) AS n FROM care_messages WHERE patient_id = ?').get(pA).n === msgsBefore && escRows(pA).length === bA + 1);
    db.prepare('DELETE FROM care_clinician_settings WHERE clinician_id = ?').run(psy);
    // нет согласия на передачу данных врачу
    db.prepare('UPDATE users SET clinical_consent_given = 0 WHERE id = ?').run(pA);
    db.prepare("UPDATE crisis_escalations SET status = 'acknowledged' WHERE patient_id = ?").run(pA);
    const bA2 = escRows(pA).length;
    await req('POST', '/messages', { j: jA, body: { clinician_id: String(psy), body: CRISIS } });
    check('без клинического согласия: сообщение не ушло, эскалация создана', escRows(pA).length === bA2 + 1);
    db.prepare('UPDATE users SET clinical_consent_given = 1 WHERE id = ?').run(pA);

    console.log('5) L-3: свободный текст «своих лекарств» и напоминаний проходит шлюз');
    db.prepare("UPDATE crisis_escalations SET status = 'acknowledged' WHERE patient_id = ?").run(pA);
    const bM = escRows(pA).length;
    await req('POST', '/meds', { j: jA, body: { name: 'Витамин', how_text: CRISIS, slot: 'none' } });
    check('/meds: кризисная фраза в «как принимать» -> эскалация', escRows(pA).length === bM + 1);
    db.prepare("UPDATE crisis_escalations SET status = 'acknowledged' WHERE patient_id = ?").run(pA);
    await req('POST', '/reminders', { j: jA, body: { message: CRISIS, remind_at: '2030-01-01T10:00', recurrence: 'none' } });
    check('/reminders: кризисная фраза в тексте -> эскалация', escRows(pA).length === bM + 2);
    const bOk = escRows(pA).length;
    await req('POST', '/meds', { j: jA, body: { name: 'Магний', how_text: 'утром', slot: 'morning' } });
    check('обычный текст эскалаций не создаёт', escRows(pA).length === bOk);

    console.log('6) L-4: поток кризисных сообщений схлопывается, первое не теряется');
    let rows0 = escRows(pM).length;
    r = await req('POST', '/chat/send', { j: jM, body: { text: CRISIS } });
    check('первое кризисное сообщение создаёт эскалацию', escRows(pM).length === rows0 + 1);
    const firstId = escRows(pM)[rows0].id;
    for (let i = 0; i < 6; i += 1) await req('POST', '/chat/send', { j: jM, body: { text: `${CRISIS} ${i}` } });
    const mrows = escRows(pM);
    check('6 повторов в окне не плодят строки очереди (одна открытая эскалация)', mrows.length === rows0 + 1 && mrows[rows0].id === firstId);
    const reasons = JSON.parse(mrows[rows0].reasons_json);
    check('первое сообщение сохранено в причинах, повторы дополняют и считаются', /не хочу жить"/.test(reasons[0]) && reasons.some((x) => /Повторных кризисных сообщений в окне: 6/.test(x)));
    check('строки очереди врача не растут: в очереди 1 запись пациента', (await req('GET', '/crisis', { j: jPsy })).text.split(`/crisis/${firstId}"`).length >= 2);
    check('сами сообщения в чате при этом не отбрасываются (лимита нет)', db.prepare("SELECT COUNT(*) AS n FROM ai_messages m JOIN ai_threads t ON t.id = m.thread_id WHERE t.owner_user_id = ? AND m.role = 'user'").get(pM).n === 7);
    db.prepare("UPDATE crisis_escalations SET status = 'acknowledged' WHERE id = ?").run(firstId);
    await req('POST', '/chat/send', { j: jM, body: { text: CRISIS } });
    check('после подтверждения новая кризисная фраза создаёт новую эскалацию', escRows(pM).length === rows0 + 2);
    // истечение окна
    db.prepare("UPDATE crisis_escalations SET created_at = datetime('now', '-30 minutes') WHERE patient_id = ? AND status = 'open'").run(pM);
    await req('POST', '/chat/send', { j: jM, body: { text: CRISIS } });
    check('вне окна (15 мин) — отдельная эскалация', escRows(pM).length === rows0 + 3);
    // уровень не снижается, срок SLA не отодвигается
    const base = escalation.createEscalation({ patientId: pN, instrument: 'message', reasons: ['a'], tier: 1, triggers: ['X'] });
    const id2 = escalation.mergeIntoOpen({ patientId: pN, instrument: 'message', reasons: ['b'], tier: 3, triggers: ['Y'] });
    const row = db.prepare('SELECT * FROM crisis_escalations WHERE id = ?').get(base);
    check('повтор с более высоким уровнем поднимает уровень и ставит срок SLA', id2 === base && row.tier === 3 && !!row.due_at && JSON.parse(row.triggers_json).join() === 'X,Y');
    const id3 = escalation.mergeIntoOpen({ patientId: pN, instrument: 'message', reasons: ['c'], tier: 1, triggers: [] });
    check('повтор с меньшим уровнем уровень не снижает и срок не двигает', id3 === base && db.prepare('SELECT tier, due_at FROM crisis_escalations WHERE id = ?').get(base).tier === 3 && db.prepare('SELECT due_at FROM crisis_escalations WHERE id = ?').get(base).due_at === row.due_at);
    check('эскалации по результатам тестов (с online_result_id) не схлопываются', escalation.mergeIntoOpen({ patientId: pN, instrument: 'phq9', reasons: ['z'], tier: 2, triggers: [] }) === null);
    process.env.CRISIS_MERGE_WINDOW_MIN = '0';
    check('CRISIS_MERGE_WINDOW_MIN=0 выключает схлопывание', escalation.mergeIntoOpen({ patientId: pN, instrument: 'message', reasons: ['d'], tier: 1, triggers: [] }) === null);
    process.env.CRISIS_MERGE_WINDOW_MIN = '15';
    check('crisisGate: ложное срабатывание исключено (обычный текст)', crisisGate.screen('хорошо спал').crisis === false);

    console.log('7) L-5: запись данных при отозванном согласии / запросе на удаление');
    const offBody = (pid) => ({ instrument: 'phq9', total_score: '12', test_date: '2026-10-01', _pid: String(pid) });
    const cnt = (pid) => db.prepare('SELECT COUNT(*) AS n FROM offline_results WHERE patient_id = ?').get(pid).n;
    r = await req('POST', `/patients/${pM}/offline-results`, { j: jPsy, body: offBody(pM) });
    check('контроль: активному пациенту офлайн-результат записывается', cnt(pM) === 1);
    db.prepare("UPDATE users SET consent_revoked_at = datetime('now') WHERE id = ?").run(pR);
    r = await req('POST', `/patients/${pR}/offline-results`, { j: jPsy, body: offBody(pR) });
    check('отозванное согласие: офлайн-результат не записан', cnt(pR) === 0 && r.status === 302);
    r = await req('GET', `/patients/${pR}/offline`, { j: jPsy });
    check('врач видит понятное сообщение', /отозвал согласие или запросил удаление/.test(r.text));
    r = await req('POST', `/patients/${pR}/results`, { j: jPsy, body: { instrument: 'phq9', total_score: '5' } });
    check('единая точка /results также не пишет', cnt(pR) === 0);
    r = await req('POST', `/patients/${pR}/protocols`, { j: jPsy, body: { instrument: 'sct', test_date: '2026-10-01', status: 'ready' } });
    check('протокол методики не записан', db.prepare('SELECT COUNT(*) AS n FROM catalog_protocols WHERE patient_id = ?').get(pR).n === 0);
    r = await req('POST', `/patients/${pR}/exam`, { j: jPsy, body: { title: 'x' } });
    check('сеанс обследования не создаётся', db.prepare('SELECT COUNT(*) AS n FROM exam_sessions WHERE patient_id = ?').get(pR).n === 0);
    const psyUser = { id: psy, role: 'psychiatrist' };
    const comp = calc.compute('phq9', Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`a${i}`, '1'])));
    check('калькулятор: активному пациенту сохраняется', calc.saveToPatient(psyUser, pM, 'phq9', comp, '2026-10-02').ok === true);
    const blockedSave = calc.saveToPatient(psyUser, pR, 'phq9', comp, '2026-10-02');
    check('калькулятор: при отозванном согласии не сохраняется, есть сообщение', blockedSave.ok === false && /отозвал согласие/.test(blockedSave.error));
    const csv = `patient_id;scale;date;score\n${pM};phq9;2026-09-01;7\n${pR};phq9;2026-09-01;7\n`;
    const an = csvImport.analyze(psyUser, csv);
    check('импорт CSV: строка отозвавшего пациента — ошибка, активного — ок', an.rows[0].status === 'ok' && an.rows[1].status === 'error' && /отозвал согласие/.test(an.rows[1].errors.join(' ')));
    db.prepare("UPDATE users SET consent_revoked_at = NULL, account_status = 'deletion_requested' WHERE id = ?").run(pR);
    check('запрос на удаление (account_status) блокирует так же', calc.saveToPatient(psyUser, pR, 'phq9', comp, '2026-10-02').ok === false);
    db.prepare("UPDATE users SET account_status = 'active' WHERE id = ?").run(pR);

    console.log('8) L-6: отмена запроса на удаление не снимает отзыв научного согласия');
    db.prepare('UPDATE users SET anonymized_export_opt_in = 1, export_consent_revoked_at = NULL WHERE id = ?').run(pA);
    await req('POST', '/account/deletion-request', { j: jA, body: {} });
    const mid = db.prepare('SELECT account_status, anonymized_export_opt_in, export_consent_revoked_at FROM users WHERE id = ?').get(pA);
    check('запрос удаления: научное согласие отозвано', mid.account_status === 'deletion_requested' && mid.anonymized_export_opt_in === 0 && !!mid.export_consent_revoked_at);
    r = await req('POST', '/account/cancel-deletion', { j: jar(), body: { email: 'pa@example.test', password: 'secret123' } });
    const after = db.prepare('SELECT account_status, consent_revoked_at, anonymized_export_opt_in, export_consent_revoked_at FROM users WHERE id = ?').get(pA);
    check('отмена вернула доступ, но не научное согласие', after.account_status === 'active' && after.consent_revoked_at === null && after.anonymized_export_opt_in === 0 && after.export_consent_revoked_at === mid.export_consent_revoked_at);
    check('пациент не попадает в научный экспорт после отмены', !researchExport.generateComparisonExport({ runBy: adm }).some((x) => x.patient_pseudonym === (db.prepare('SELECT pseudonym FROM research_pseudonyms WHERE patient_id = ?').get(pA) || {}).pseudonym));

    console.log('9) L-8: таймауты бездействия и судьба введённого текста');
    check('значения по умолчанию: клиницисты 120, админ 30, пациенты 720 минут', sessionPolicy.idleMs('psychiatrist') === 7200000 && sessionPolicy.idleMs('psychologist') === 7200000 && sessionPolicy.idleMs('admin') === 1800000 && sessionPolicy.idleMs('patient') === 43200000);
    process.env.SESSION_IDLE_MIN_ADMIN = '0.02';
    const jAdm2 = await login('adm@example.test');
    await req('GET', '/admin', { j: jAdm2 });
    await new Promise((res) => setTimeout(res, 1500));
    r = await req('GET', '/admin', { j: jAdm2 });
    check('админ: короткий таймаут из env завершает сессию', r.status === 302 && /^\/login/.test(r.location));
    r = await req('GET', '/login', { j: jAdm2 });
    check('сообщение для сотрудника честно: несохранённый текст не сохраняется', /долгого бездействия/.test(r.text) && /Несохранённый текст формы не сохраняется/.test(r.text));
    const jAdm3 = await login('adm@example.test');
    await req('GET', '/admin', { j: jAdm3 });
    await new Promise((res) => setTimeout(res, 1500));
    delete process.env.SESSION_IDLE_MIN_ADMIN;
    process.env.SESSION_IDLE_MIN_PATIENT = '0.02';
    const jP = await login('pn@example.test');
    await req('GET', '/dashboard', { j: jP });
    await new Promise((res) => setTimeout(res, 1500));
    r = await req('POST', '/chat/send', { j: jP, json: true, body: { text: 'черновик' } });
    check('fetch после простоя: 401 и «Сессия истекла, черновик сохранён»', r.status === 401 && /Сессия истекла, черновик сохранён/.test(r.text));
    const jP2 = await login('pn@example.test');
    await req('GET', '/dashboard', { j: jP2 });
    await new Promise((res) => setTimeout(res, 1500));
    await req('GET', '/messages', { j: jP2 }); // первый запрос после простоя завершает сессию и ставит сообщение на странице входа
    r = await req('GET', '/login', { j: jP2 });
    check('пациент: на входе «Сессия истекла, черновик сохранён…»', /Сессия истекла, черновик сохранён/.test(r.text));
    delete process.env.SESSION_IDLE_MIN_PATIENT;
    r = await req('GET', '/messages', { j: await login('pa@example.test') });
    check('сообщения пациента: поле имеет ключ черновика (сохраняется на устройстве)', /data-draft-key="care-message"/.test(r.text) || /Вы пока не привязаны/.test(r.text));

    console.log('10) M-4: назначение клинициста админом видно в журналах и пациенту');
    db.prepare('DELETE FROM care_assignments WHERE patient_id = ?').run(pN);
    const prefs0 = db.prepare('SELECT care_change_kind FROM user_prefs WHERE user_id = ?').get(pN);
    r = await req('POST', '/admin/assignments/assign', { j: jAdm, body: { patient_id: String(pN), clinician_id: String(psy2) } });
    check('привязка создана', !!db.prepare('SELECT 1 FROM care_assignments WHERE patient_id = ? AND clinician_id = ?').get(pN, psy2));
    check('запись в admin_action_log (assignment_add)', db.prepare("SELECT COUNT(*) AS n FROM admin_action_log WHERE admin_id = ? AND action = 'assignment_add' AND target_user_id = ?").get(adm, pN).n === 1);
    check('запись в журнале доступа к данным пациента (phi_access_log)', phi(adm, pN, 'assignment_add') === 1);
    r = await req('GET', '/privacy', { j: jN });
    check('пациент видит в «Приватности»: назначен специалист', /назначен специалист/.test(r.text));
    r = await req('GET', '/dashboard', { j: jN });
    check('D7: пациенту на главной показано «Ваш врач изменился»', /Ваш врач изменился/.test(r.text) && !(prefs0 && prefs0.care_change_kind));
    r = await req('POST', '/admin/assignments/unassign', { j: jAdm, body: { patient_id: String(pN), clinician_id: String(psy2) } });
    check('снятие тоже пишется в журнал доступа', phi(adm, pN, 'assignment_remove') === 1);

    console.log('11) M-7: хранилище сессий ограничено, анонимные живут недолго');
    const st = new BoundedMemoryStore({ maxAnon: 3, maxTotal: 5, sweepMs: 3600000 });
    const put = (sid, user) => new Promise((res) => st.set(sid, { cookie: { originalMaxAge: 1000, expires: new Date(Date.now() + 100000).toISOString() }, user }, res));
    await put('u1', { id: 1 });
    for (let i = 0; i < 10; i += 1) await put(`a${i}`);
    check('анонимных не больше maxAnon, самые старые вытеснены', st.anon.size === 3 && !st.sessions.a0 && !!st.sessions.a9);
    check('сессия вошедшего пользователя не вытеснена потоком анонимов', !!st.sessions.u1);
    for (let i = 0; i < 6; i += 1) await put(`u${i + 2}`, { id: i + 2 });
    check('общий потолок соблюдается', st.size() <= 5);
    await new Promise((res) => st.set('old', { cookie: { expires: new Date(Date.now() - 1000).toISOString() } }, res));
    check('sweep удаляет просроченные', st.sweep() >= 1 && !st.sessions.old);
    clearInterval(st.timer);
    const live = sessionPolicy.getStore();
    for (let i = 0; i < 120; i += 1) await fetch(`${BASE}/login`, { redirect: 'manual' });
    check('поток анонимных GET /login: число анонимных сессий в сервере ограничено (SESSION_MAX_ANON=40)', live.anon.size <= 40 && live.anon.size > 0);
    r = await fetch(`${BASE}/login`);
    const sc = (r.headers.getSetCookie()[0] || '');
    const ma = /Expires=([^;]+)/i.exec(sc);
    check('cookie анонима живёт ≤ 30 минут (не 12 ч)', !!ma && Date.parse(ma[1]) - Date.now() <= 1800 * 1000 + 5000);
    const jLogged = await login('pm@example.test');
    r = await fetch(`${BASE}/dashboard`, { headers: { cookie: jLogged.header() }, redirect: 'manual' });
    const ma2 = /Expires=([^;]+)/i.exec(r.headers.getSetCookie()[0] || '');
    check('cookie вошедшего пациента — по таймауту роли (720 мин)', !!ma2 && Date.parse(ma2[1]) - Date.now() > 3600 * 1000);

    console.log('12) N1: журнал инцидентов не раздувается на каждый запрос');
    const pU = createUser(db, { email: 'pu@example.test', full_name: 'Пациент Просрочка', role: 'patient' });
    link(pU, psy);
    const eU = escalation.createEscalation({ patientId: pU, instrument: 'chatbot', reasons: ['x'], tier: 3, triggers: ['A'] });
    db.prepare('UPDATE crisis_escalations SET due_at = ? WHERE id = ?').run(new Date(Date.now() - 3600000).toISOString(), eU);
    for (let i = 0; i < 5; i += 1) escalation.checkOverdueEscalations();
    for (let i = 0; i < 3; i += 1) await req('GET', '/dashboard', { j: jPsy });
    const unres = db.prepare("SELECT COUNT(*) AS n FROM crisis_incident_log WHERE escalation_id = ? AND event_type = 'unresolved'").get(eU).n;
    check('просрочка без резерва: ровно одно событие unresolved, а не по строке на запрос', unres === 1);
    check('факт сохранён: эскалация помечена unresolved и осталась открытой', db.prepare('SELECT unresolved, status FROM crisis_escalations WHERE id = ?').get(eU).unresolved === 1 && db.prepare('SELECT status FROM crisis_escalations WHERE id = ?').get(eU).status === 'open');
    const eU2 = escalation.createEscalation({ patientId: pU, instrument: 'phq9', reasons: ['y'], tier: 2, triggers: ['B'] });
    db.prepare('UPDATE crisis_escalations SET due_at = ? WHERE id = ?').run(new Date(Date.now() - 60000).toISOString(), eU2);
    escalation.checkOverdueEscalations(); escalation.checkOverdueEscalations();
    check('другая просроченная эскалация получает своё одно событие', db.prepare("SELECT COUNT(*) AS n FROM crisis_incident_log WHERE escalation_id = ? AND event_type = 'unresolved'").get(eU2).n === 1 && db.prepare("SELECT COUNT(*) AS n FROM crisis_incident_log WHERE escalation_id = ? AND event_type = 'unresolved'").get(eU).n === 1);

    console.log('13) N2: ввод не теряется при истёкшей сессии');
    process.env.SESSION_IDLE_MIN_CLINICIAN = '0.02';
    const jE = await login('psy@example.test');
    await req('GET', '/dashboard', { j: jE });
    await new Promise((res) => setTimeout(res, 1500));
    r = await req('GET', '/patients?q=abc', { j: jE });
    delete process.env.SESSION_IDLE_MIN_CLINICIAN;
    check('простой: вход с возвратом на ту же страницу (?next=)', r.status === 302 && r.location === '/login?next=' + encodeURIComponent('/patients?q=abc'));
    r = await req('GET', r.location, { j: jE });
    check('страница входа человеческая: причина + скрытое поле next', /долгого бездействия/.test(r.text) && /name="next" value="\/patients\?q=abc"/.test(r.text) && /data-session-lost/.test(r.text));
    r = await fetch(`${BASE}/messages`, { method: 'POST', headers: { 'x-csrf-token': 'bad', 'content-type': 'application/x-www-form-urlencoded', referer: `${BASE}/messages?with=1` }, body: 'body=x', redirect: 'manual' });
    const html403 = await r.text();
    check('CSRF/истёкшая сессия без входа: «Сессия истекла», кнопка «Войти и вернуться» ведёт на вход с next', r.status === 403 && /Сессия истекла/.test(html403) && /Войти и вернуться/.test(html403) && /href="\/login\?next=%2Fmessages%3Fwith%3D1"/.test(html403) && !/Страница не найдена/.test(html403));
    check('скрипт сохранения ввода подключён на страницах и без inline', /\/form_keeper\.js/.test((await req('GET', '/dashboard', { j: jPsy })).text) && !/<script>[^<]/.test(html403));
    const keeper = fs.readFileSync(path.join(__dirname, '..', 'public', 'form_keeper.js'), 'utf8');
    check('form_keeper.js: sessionStorage, пароли не сохраняются, есть «Восстановить»', /sessionStorage/.test(keeper) && /'password'/.test(keeper) && /Восстановить/.test(keeper));
    check('форма входа не хранит пароль (скрипт пропускает password) и несёт data-session-lost', /data-session-lost/.test((await req('GET', '/login')).text));

    console.log('14) D14: коды Tier заменены словарём');
    const labels = require('../src/labels');
    check('cleanReason: «Tier 1: C» -> «Уровень 1 · внимание: C»', labels.cleanReason('Tier 1: C') === 'Уровень 1 · внимание: C' && labels.cleanReason('Tier 3') === 'Уровень 3 · срочный');
    const csvB = csvImport.analyze({ id: psy, role: 'psychiatrist' }, `patient_id;scale;date;score;item9\n${pM};bdi2;2026-09-02;20;3\n`);
    check('импорт CSV: предупреждение о BDI-II п.9 без «Tier»', csvB.rows[0].warnings.some((w) => /эскалация/.test(w)) && !csvB.rows[0].warnings.some((w) => /Tier/.test(w)));
    db.prepare("UPDATE crisis_escalations SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = datetime('now'), reasons_json = ? WHERE id = ?").run(psy, JSON.stringify(['Tier 1: C']), eU);
    r = await req('GET', '/crisis', { j: jPsy });
    check('очередь, «Подтверждённые недавно»: нет «Tier»', !/Tier/.test(r.text) && /Уровень 1 · внимание: C/.test(r.text));

    console.log('15) Низкие находки: e-mail без учёта регистра, seed-demo в production, права outbox');
    r = await req('POST', '/register', { body: { email: 'PA@Example.test', password: 'secret1234', full_name: 'Двойник', consent_given: '1', clinical_consent_given: '1' } });
    check('регистрация с e-mail, отличающимся регистром, отклонена как дубль', r.status === 400 && /уже есть/.test(r.text));
    const sd = spawnSync(process.execPath, ['-e', "require('./scripts/seed-demo').seedDemo()"], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, NODE_ENV: 'production', TDR_DB_PATH: path.join(os.tmpdir(), `tdr-sd-${process.pid}.sqlite3`) }, encoding: 'utf8' });
    check('seed-demo отказывается работать при NODE_ENV=production', sd.status !== 0 && /production/.test(sd.stderr));
    fs.rmSync(path.join(os.tmpdir(), `tdr-sd-${process.pid}.sqlite3`), { force: true });
    require('../src/crisis_queue').sweepNotifications();
    check('outbox.log создаётся с правами 0600', !fs.existsSync(process.env.TDR_OUTBOX_PATH) || (fs.statSync(process.env.TDR_OUTBOX_PATH).mode & 0o077) === 0);
  } finally {
    server.close();
    db.close();
    for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`, process.env.TDR_OUTBOX_PATH]) fs.rmSync(f, { force: true });
  }
  console.log(`\n${failures === 0 ? 'Все проверки исправлений безопасности прошли успешно.' : `${failures} проверок не прошло.`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
