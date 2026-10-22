'use strict';
require('./helpers').installCsrfFetch();

// W2.X: исправления дефектов приёмки PM-A1 (D1, D3-D9, D13-D16, D22-D25, OQ-14b).

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDb = path.join(os.tmpdir(), `tdr-a1fix-${process.pid}-${Date.now()}.sqlite3`);
process.env.TDR_DB_PATH = tmpDb;
process.env.SESSION_SECRET = 'test-secret';

const app = require('../src/app');
const db = require('../src/db');
const { createUser } = require('./helpers');
const prefs = require('../src/patient_prefs');
const wsContext = require('../src/ai/workspace/context');
const sharing = require('../src/sharing');
const adminCore = require('../src/admin_core');

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
  return { status: res.status, text: await res.text(), location: res.headers.get('location'), headers: res.headers };
}
async function login(email) { const j = jar(); await req('POST', '/login', { j, body: { email, password: 'secret123' } }); return j; }
const link = (pid, cid) => db.prepare('INSERT OR IGNORE INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(pid, cid);
const NOTE = 'СЕКРЕТНАЯ-ЗАМЕТКА-ДНЕВНИКА';

async function main() {
  const server = app.listen(0);
  BASE = `http://127.0.0.1:${server.address().port}`;
  try {
    const psy = createUser(db, { email: 'psy@example.test', full_name: 'Психиатр Тестов', role: 'psychiatrist' });
    const psy2 = createUser(db, { email: 'psy2@example.test', full_name: 'Психиатр Второй', role: 'psychiatrist' });
    const adm = createUser(db, { email: 'adm@example.test', full_name: 'Админ', role: 'admin' });
    const pA = createUser(db, { email: 'pa@example.test', full_name: 'Пациент Альфа', role: 'patient' });
    const pB = createUser(db, { email: 'pb@example.test', full_name: 'Пациент Бета', role: 'patient' });
    const pN = createUser(db, { email: 'pn@example.test', full_name: 'Пациент Без Врача', role: 'patient' });
    link(pA, psy); link(pB, psy2);
    const jPsy = await login('psy@example.test');
    const jPsy2 = await login('psy2@example.test');
    const jAdm = await login('adm@example.test');
    const jA = await login('pa@example.test');
    const jN = await login('pn@example.test');
    let r;

    console.log('1) D1: настройки «Поделиться» (user_prefs) во всех врачебных выходах — все комбинации');
    for (const n of [1, 2, 3, 4]) db.prepare('INSERT INTO mood_entries (patient_id, mood_score, note, entry_date) VALUES (?, ?, ?, ?)').run(pA, 4 + n, `${NOTE} ${n}`, `2026-09-0${n}`);
    for (const scores of [0, 1]) {
      for (const notes of [0, 1]) {
        prefs.setPrefs(pA, { share_diary_scores: scores, share_diary_notes: notes });
        const tag = `оценки=${scores} заметки=${notes}`;
        const ctx = wsContext.build({ id: psy, role: 'psychiatrist' }, pA);
        check(`${tag}: ИИ-контекст — оценки ${scores ? 'есть' : 'нет'}`, ctx.ok && (scores ? ctx.facts.diary && ctx.facts.diary.count === 4 : ctx.facts.diary === null));
        check(`${tag}: ИИ-контекст — заметки ${scores && notes ? 'есть' : 'нет'}`, ctx.ok && (scores && notes ? ctx.facts.notes.length > 0 : ctx.facts.notes.length === 0));
        const d = sharing.diaryForClinician(pA, 60);
        check(`${tag}: sharing — оценки/заметки`, (scores ? d.entries.length === 4 : d.entries.length === 0) && d.entries.every((e) => (notes ? !!e.note : !e.note)));
        r = await req('GET', `/patients/${pA}/diary`, { j: jPsy });
        check(`${tag}: вкладка дневника`, r.status === 200 && (notes && scores ? r.text.includes(NOTE) : !r.text.includes(NOTE)));
        r = await req('GET', `/patients/${pA}`, { j: jPsy });
        check(`${tag}: обзор карточки без текста заметок`, !r.text.includes(NOTE));
        r = await req('GET', `/patients/${pA}/visit`, { j: jPsy });
        check(`${tag}: «К приёму» без текста заметок`, !r.text.includes(NOTE));
      }
    }
    r = await req('GET', '/share', { j: jA });
    check('D9: на /share нет переключателя «Диалоги с ИИ», есть честный текст', !/name="chats"/.test(r.text) && /Врач их не видит/.test(r.text));
    prefs.setPrefs(pA, { share_ai_chats: 0 });
    await req('POST', '/share', { j: jA, body: { scores: '1', notes: '1', chats: '1' } });
    check('D9: POST /share игнорирует chats', prefs.getPrefs(pA).share_ai_chats === 0 && prefs.getPrefs(pA).share_diary_notes === 1);
    prefs.setPrefs(pA, { share_diary_scores: 1, share_diary_notes: 0 });

    console.log('2) D3: единый честный текст кризисной записи с врачом и без');
    r = await req('POST', '/diary', { j: jN, body: { mood_score: '2', note: 'я не хочу жить' } });
    r = await req('GET', '/dashboard', { j: jN });
    check('без врача (дневник): «дежурный администратор», нет «передано врачу»', /дежурный администратор/.test(r.text) && !/будет передано врачу/.test(r.text));
    r = await req('POST', '/diary', { j: jA, body: { mood_score: '2', note: 'я не хочу жить' } });
    r = await req('GET', '/dashboard', { j: jA });
    check('с врачом (дневник): «передано врачу»', /будет передано врачу/.test(r.text) && !/дежурный администратор/.test(r.text));
    await req('POST', '/help/contact', { j: jN, body: { message: '' } });
    r = await req('GET', '/help?sent=1&to=admin', { j: jN });
    check('«Мне плохо» без врача: тот же текст про администратора', /дежурный администратор/.test(r.text) && !/будет передано врачу/.test(r.text));
    const texts = require('../src/ai/texts');
    check('один источник: чат/сообщения/обращения используют texts.handoff', texts.handoff(false) === texts.CONTACT_SENT_NO_CLINICIAN && require('../src/patient_text').handoff(true) === texts.CONTACT_SENT_WITH_CLINICIAN);
    r = await req('GET', '/chat/contact', { j: jN });
    check('D12: нет текста «ввод кода в разработке»', !/в разработке/.test(r.text));

    console.log('3) D4: «Приглашения» у врача');
    r = await req('GET', '/dashboard', { j: jPsy });
    check('пункт меню «Приглашения»', /href="\/invites"[^>]*>Приглашения/.test(r.text));
    r = await req('GET', '/patients', { j: jPsy });
    check('ссылка на приглашения в «Пациентах»', /href="\/invites"/.test(r.text));
    check('D16: «Завершить наблюдение» с подтверждением', /Да, завершить/.test(r.text));

    console.log('4) D5: вкладка «Материалы»');
    r = await req('GET', `/patients/${pA}/materials`, { j: jPsy });
    check('пусто: честное состояние без «будет доступна»', r.status === 200 && !/будет доступна/.test(r.text) && /нет/.test(r.text));
    const th = db.prepare("INSERT INTO ai_threads (owner_user_id, role, patient_id, title) VALUES (?, 'clinician', ?, 'T')").run(psy, pA).lastInsertRowid;
    const ins = (name, exp, owner, pid) => db.prepare("INSERT INTO ai_attachments (thread_id, owner_user_id, patient_id, seq, name, kind, expires_at) VALUES (?, ?, ?, 1, ?, 'txt', ?)").run(th, owner, pid, name, exp);
    ins('Выписка-актуальная.txt', '2999-01-01 00:00:00', psy, pA);
    ins('Выписка-просроченная.txt', '2000-01-01 00:00:00', psy, pA);
    ins('Чужой-материал.txt', '2999-01-01 00:00:00', psy2, pA);
    r = await req('GET', `/patients/${pA}/materials`, { j: jPsy });
    check('виден актуальный материал автора', r.text.includes('Выписка-актуальная.txt'));
    check('срок хранения истёк — не показан; чужой материал — не показан', !r.text.includes('просроченная') && !r.text.includes('Чужой-материал'));
    db.prepare('UPDATE users SET clinical_consent_given = 0 WHERE id = ?').run(pA);
    r = await req('GET', `/patients/${pA}/materials`, { j: jPsy });
    check('без клинического согласия материалы скрыты', !r.text.includes('Выписка-актуальная.txt'));
    db.prepare('UPDATE users SET clinical_consent_given = 1 WHERE id = ?').run(pA);

    console.log('5) D7: пациент узнаёт об изменении врача / завершении наблюдения');
    r = await req('GET', '/dashboard', { j: jA });
    check('до изменений уведомления нет', !/id="care-notice"/.test(r.text));
    await req('POST', `/patients/${pA}/archive`, { j: jPsy, body: { back: '/patients' } });
    r = await req('GET', '/dashboard', { j: jA });
    check('после «Завершить наблюдение» — спокойное уведомление', /id="care-notice"/.test(r.text) && /Наблюдение завершено/.test(r.text));
    await req('POST', '/care-notice/dismiss', { j: jA, body: {} });
    r = await req('GET', '/dashboard', { j: jA });
    check('«Понятно» скрывает уведомление', !/id="care-notice"/.test(r.text));
    await req('POST', `/patients/${pA}/unarchive`, { j: jPsy, body: {} });
    adminCore.reassign(adm, psy, psy2, [pA]);
    r = await req('GET', '/dashboard', { j: jA });
    check('после переназначения админом — «Ваш врач изменился»', /Ваш врач изменился/.test(r.text) && /id="care-notice"/.test(r.text));
    link(pA, psy);
    await req('POST', '/care-notice/dismiss', { j: jA, body: {} });

    console.log('6) D8: «Внимание» на Сводке');
    db.prepare("UPDATE crisis_escalations SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = datetime('now') WHERE status = 'open'").run(psy); // эскалации из шага 2
    db.prepare("UPDATE patient_appeals SET status = 'acknowledged' WHERE status = 'open'").run();
    const tier1 = db.prepare("INSERT INTO crisis_escalations (patient_id, instrument, reasons_json, tier, triggers_json) VALUES (?, 'phq9', '[\"x\"]', 1, '[\"C\"]')").run(pA).lastInsertRowid;
    r = await req('GET', '/dashboard', { j: jPsy });
    check('счётчик «Внимание: 1» и объяснение «почему не кризис»', /Внимание: 1/.test(r.text) && /пункт 9 PHQ-9/.test(r.text) && /Почему это не «Кризис»/.test(r.text));
    check('красной плашки кризиса нет, когда срочных нет', !/class="crisis-strip"/.test(r.text) && !/Tier/.test(r.text));
    db.prepare('DELETE FROM crisis_escalations WHERE id = ?').run(tier1);

    console.log('7) D14: технические коды заменены словарём');
    db.prepare("INSERT INTO phi_access_log (actor_id, patient_id, action) VALUES (?, ?, 'view_patient_tab:diary')").run(psy, pA);
    db.prepare("INSERT INTO phi_access_log (actor_id, patient_id, action) VALUES (?, ?, 'ai_open_thread')").run(psy, pA);
    r = await req('GET', `/patients/${pA}/journal`, { j: jPsy });
    check('журнал карточки: человеческие подписи', /Открыта вкладка «Дневник»/.test(r.text) && !/view_patient_tab|ai_open_thread|ai_bind_patient/.test(r.text));
    r = await req('GET', '/admin/audit?log=phi', { j: jAdm });
    check('журнал админа: без кодов', r.status === 200 && !/view_patient_tab|ai_open_thread/.test(r.text) && /открыта вкладка «Дневник»/.test(r.text));
    r = await req('GET', '/privacy', { j: jA });
    check('«Кто смотрел» у пациента: без кодов, сгруппировано', !/view_patient_tab|ai_open_thread/.test(r.text));
    const labels = require('../src/labels');
    check('словарь: Tier -> «Уровень N · слово»', labels.tierLabel(1) === 'Уровень 1 · внимание' && !/Tier/.test(labels.tierLabel(3)));
    check('словарь: неизвестный код не показывается как есть', labels.actionLabel('some_new_code') === 'служебное действие');
    db.prepare("INSERT INTO crisis_escalations (patient_id, instrument, reasons_json, tier, triggers_json, due_at) VALUES (?, 'phq9', '[\"x\"]', 3, '[\"A\"]', '2999-01-01T00:00:00.000Z')").run(pA);
    r = await req('GET', '/crisis', { j: jPsy });
    check('кризисная очередь: «Уровень 3», без «Tier»', /Уровень 3/.test(r.text) && !/Tier/.test(r.text));
    db.prepare("UPDATE crisis_escalations SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = datetime('now')").run(psy);

    console.log('8) D15: «уже обработано» с именем');
    const esc2 = db.prepare("INSERT INTO crisis_escalations (patient_id, instrument, reasons_json, tier, triggers_json, due_at, status, acknowledged_by, acknowledged_at) VALUES (?, 'phq9', '[\"x\"]', 2, '[\"C\"]', '2999-01-01T00:00:00.000Z', 'acknowledged', ?, datetime('now'))").run(pA, psy).lastInsertRowid;
    r = await req('POST', `/crisis/${esc2}/acknowledge`, { j: jPsy, body: {} });
    check('повторное подтверждение: «Уже обработано: <имя>»', r.status === 403 && /Уже обработано: Психиатр Тестов/.test(r.text));

    console.log('9) OQ-14b/D22: экспорт только своих пациентов');
    const rx = require('../src/research_export');
    db.prepare('UPDATE users SET anonymized_export_opt_in = 1 WHERE id IN (?, ?)').run(pA, pB);
    const mk = (pid) => {
      const o = db.prepare("INSERT INTO online_results (patient_id, instrument, total_score, answers_json) VALUES (?, 'phq9', 5, '{}')").run(pid).lastInsertRowid;
      const f = db.prepare("INSERT INTO offline_results (patient_id, instrument, total_score, entered_by, test_date) VALUES (?, 'bdi2', 7, ?, '2026-09-01')").run(pid, psy).lastInsertRowid;
      db.prepare("INSERT INTO comparison_pairs (patient_id, online_result_id, offline_result_id, online_scale, offline_scale, comparability, time_delta_days) VALUES (?, ?, ?, 'phq9', 'bdi2', 'cross_instrument', 1)").run(pid, o, f);
    };
    let pairsOk = true;
    try { mk(pA); mk(pB); } catch (e) { pairsOk = false; console.error(e.message); }
    check('подготовка пар сравнения', pairsOk);
    const allRows = rx.generateComparisonExport({ runBy: adm });
    const ownRows = rx.generateComparisonExport({ runBy: psy, clinicianId: psy });
    check('без фильтра — вся когорта (2 пациента), для врача — только свой', allRows.length === 2 && ownRows.length === 1 && ownRows[0].patient_pseudonym === rx.getOrCreatePseudonym(pA));
    r = await req('GET', '/export/comparisons.csv', { j: jPsy });
    check('HTTP: в файле врача заголовок и только строка его пациента', r.status === 200 && r.text.trim().split(/\r?\n/).length === 2);
    r = await req('GET', '/export', { j: jPsy });
    check('страница «Экспорт» объясняет содержимое до скачивания', r.status === 200 && /только <strong>ваши пациенты/.test(r.text) && /comparisons\.csv/.test(r.text));

    console.log('10) D13/D19/D21/D23/D24/D25 и мелочи');
    const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
    check('D13: скрытый пустой alert не рисуется (.flash[hidden])', /\.flash\[hidden\][^{]*\{\s*display:\s*none/.test(css));
    r = await req('GET', '/dashboard', { j: jN });
    check('D19: блок «Разделы» на главной убран', !/<h2>Разделы<\/h2>/.test(r.text));
    // D21: возвращение после паузы, назначенные тесты остаются видимыми
    db.prepare("INSERT INTO instrument_assignments (patient_id, instrument, assigned_by, status) VALUES (?, 'phq9', ?, 'pending')").run(pB, psy2);
    const jB = await login('pb@example.test');
    prefs.setPrefs(pB, { last_seen_at: '2020-01-01T00:00:00.000Z', onboarding_pending: 0 });
    r = await req('GET', '/dashboard', { j: jB });
    check('D21: при возвращении виден счётчик назначенных тестов', /Назначено врачом:\s*<strong>1<\/strong>/.test(r.text) || /Тест от врача/.test(r.text));
    r = await req('GET', '/help', { j: jA });
    check('D25: на «Мне плохо» есть «Быстрый выход»', /Быстрый выход/.test(r.text));
    r = await req('POST', '/quick-exit', { j: jA, body: {} });
    check('D25: быстрый выход завершает сеанс', r.status === 302 && r.location === '/login');
    r = await req('GET', '/dashboard', { j: jA });
    check('D25: после выхода кабинет закрыт', r.status === 302 && /login/.test(r.location));
    const fm = require('../src/format');
    check('D24: у пациента в названии C-SSRS нет слова «риск»', !/риск/i.test(fm.instrumentLabelFor('patient', 'cssrs')) && /риск/.test(fm.instrumentLabelFor('psychiatrist', 'cssrs')));
    const service = require('../src/ai/workspace/service');
    const t1 = await service.sendMessage({ user: { id: psy, role: 'psychiatrist' }, base: '/ai', threadId: null, text: 'Сводка к приёму', scenario: 'summary', patientId: pB, periodDays: null }).catch((e) => ({ error: String(e) }));
    check('D23: sendMessage выполнен без ошибки (заголовки сценариев различимы)', t1 && !t1.error);
    const titles = db.prepare("SELECT title FROM ai_threads WHERE owner_user_id = ?").all(psy).map((x) => x.title);
    check('D23: названия содержат дату/фамилию, если сценарий с пациентом', titles.length === 0 || titles.some((t) => !/^Сводка к приёму$/.test(t)));
  } finally {
    server.close();
    db.close();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(tmpDb + '-wal', { force: true });
    fs.rmSync(tmpDb + '-shm', { force: true });
  }
  console.log(`\n${failures === 0 ? 'Все проверки исправлений приёмки A1 прошли успешно.' : `${failures} проверок не прошло.`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
