'use strict';

require('./helpers').installCsrfFetch(); // W2.S: тесты получают и отправляют CSRF-токен как браузер

// W1.B1: кабинет клинициста на демо-сиде — сводка/светофор, список пациентов,
// кризисная очередь; негативные сценарии доступа.

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cdash-'));
process.env.TDR_DB_PATH = path.join(tmp, 'cd.sqlite3');
process.env.TDR_OUTBOX_PATH = path.join(tmp, 'outbox.log');
process.env.SESSION_SECRET = 'test-secret';

require('../scripts/gc-guard'); // до src/db
const db = require('../src/db');
const { seedDemo, DEMO_PASSWORD } = require('../scripts/seed-demo');
const escalation = require('../src/escalation');
const queue = require('../src/crisis_queue');

seedDemo();
const app = require('../src/app');

const PORT = 20000 + Math.floor(Math.random() * 20000); // случайный порт: тесты могут идти параллельно в разных worktree
const BASE = `http://127.0.0.1:${PORT}`;
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
  if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
  const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
  if (cookieJar) cookieJar.store(res);
  return { status: res.status, text: await res.text(), location: res.headers.get('location') };
}
async function login(email) {
  const j = jar();
  const r = await req('POST', '/login', { cookieJar: j, body: { email, password: DEMO_PASSWORD } });
  if (r.status !== 302) throw new Error(`login ${email}: ${r.status}`);
  return j;
}
const uid = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
const idx = (text, s) => text.indexOf(s);

async function main() {
  const server = app.listen(PORT);
  try {
    const psy1 = await login('psychiatrist1@example.com');
    const psy2 = await login('psychiatrist2@example.com');
    const psycho = await login('psychologist1@example.com');
    const p1 = await login('patient1.improving@example.com');
    const admin = await login('admin@example.com');
    const ids = {
      zorina: uid('patient3.crisis@example.com'), gromov: uid('patient2.worsening@example.com'),
      novikov: uid('patient8.new@example.com'), svetlova: uid('patient1.improving@example.com'),
      lebedev: uid('patient4.inactive@example.com'), fomin: uid('patient6.nodoctor@example.com'),
      nesterova: uid('patient5.mixed@example.com'),
    };

    console.log('1) Сводка: светофор, порядок, счётчики, фильтр');
    let r = await req('GET', '/dashboard', { cookieJar: psy1 });
    check('сводка отвечает 200', r.status === 200);
    check('есть жёлтый («Внимание») и серый («Мало данных»)', r.text.includes('triage--yellow') && r.text.includes('triage--gray'));
    check('порядок: жёлтые выше серых', idx(r.text, 'triage--yellow') < idx(r.text, 'triage--gray'));
    check('«почему» одной строкой у Громова (эскалация Tier 1)', /Громов[\s\S]*Открыта эскалация уровня 1/.test(r.text));
    check('«спокойные» по умолчанию не в списке, но есть в счётчике', !r.text.includes('Светлова') && /Спокойно<\/span>\s*<span class="stat-card__value">[12]</.test(r.text)); // Светлова (+ Алексеева: 5→6 больше не жёлтый, worseningMinDelta)
    check('дисклеймер светофора', r.text.includes('result-disclaimer') && r.text.includes('не диагноз'));
    check('чужой пациент (Зорина) не виден', !r.text.includes('Зорина'));
    check('иконка и слово у статуса', r.text.includes('triage__icon') && r.text.includes('Внимание'));
    check('в сводке нет required', !/\srequired[\s>=]/.test(r.text));
    r = await req('GET', '/dashboard?status=green', { cookieJar: psy1 });
    check('фильтр «Спокойно» показывает Светлову', r.text.includes('Светлова') && !r.text.includes('Громов'));

    console.log('2) Красный: очередь, бейдж, SLA, отсутствие чужого');
    r = await req('GET', '/dashboard', { cookieJar: psy2 });
    check('красный первым: Зорина — «Кризис»', r.text.includes('triage--red') && (!r.text.includes('triage--yellow') || idx(r.text, 'triage--red') < idx(r.text, 'triage--yellow')));
    check('бейдж в меню и в <title> = 2', /<title>\(2\) /.test(r.text) && /badge badge-risk"[^>]*>2</.test(r.text));
    r = await req('GET', '/crisis', { cookieJar: psy2 });
    check('очередь: «просрочено на» и «осталось» без JS', r.text.includes('просрочено на') && r.text.includes('осталось'));
    check('очередь: явное время due_at (time datetime)', /<time datetime="\d{4}-/.test(r.text));
    check('очередь: «Нет резерва — разбор вручную»', r.text.includes('Нет резерва — разбор вручную'));
    check('очередь: Tier 3 выше Tier 2', idx(r.text, 'Уровень 3') < idx(r.text, 'Уровень 2'));
    check('очередь: группа пациента со счётчиком', r.text.includes('2 записей'));
    check('очередь: честность каналов и рабочее время', r.text.includes('только внутри сервиса') && r.text.includes('SLA 15 мин'));
    check('очередь: Нестерова (подтверждённые) отдельно', r.text.includes('Подтверждённые недавно'));

    console.log('3) Негативные: чужие данные и роли');
    const zorinaEsc = db.prepare("SELECT id FROM crisis_escalations WHERE patient_id = ? AND status='open' ORDER BY tier DESC").get(ids.zorina).id;
    r = await req('GET', `/crisis/${zorinaEsc}`, { cookieJar: psy1 });
    check('чужая карточка эскалации -> 403', r.status === 403);
    r = await req('POST', `/crisis/${zorinaEsc}/acknowledge`, { cookieJar: psy1, body: {} });
    check('подтверждение чужой эскалации -> 403', r.status === 403);
    check('и она осталась открытой', db.prepare('SELECT status FROM crisis_escalations WHERE id = ?').get(zorinaEsc).status === 'open');
    r = await req('POST', `/patients/${ids.zorina}/archive`, { cookieJar: psy1, body: {} });
    check('архивирование чужого пациента -> 403', r.status === 403);
    r = await req('POST', `/patients/${ids.zorina}/tags`, { cookieJar: psy1, body: { tag: 'x' } });
    check('тег чужому пациенту -> 403', r.status === 403);
    r = await req('POST', `/patients/${ids.zorina}/snooze`, { cookieJar: psy1, body: {} });
    check('snooze чужого пациента -> 403', r.status === 403);
    r = await req('GET', '/patients?q=%D0%B7%D0%BE%D1%80%D0%B8%D0%BD%D0%B0', { cookieJar: psy1 });
    check('поиск не находит чужого пациента', !r.text.includes('Зорина'));
    for (const url of ['/crisis', '/patients']) {
      r = await req('GET', url, { cookieJar: p1 });
      check(`пациент не видит ${url} (403)`, r.status === 403);
    }
    r = await req('POST', `/crisis/${zorinaEsc}/acknowledge`, { cookieJar: p1, body: {} });
    check('пациент не подтверждает эскалации (403)', r.status === 403);
    r = await req('GET', '/crisis', { cookieJar: admin });
    check('админ не видит клиническую очередь здесь (403)', r.status === 403);
    r = await req('GET', '/crisis', { cookieJar: null });
    check('без входа -> 403', r.status === 403);

    console.log('4) Психолог и психиатр видят одинаково; психолог — только своих');
    r = await req('GET', '/dashboard', { cookieJar: psycho });
    check('психолог: сводка со светофором, есть Лебедев (пропуски)', r.status === 200 && r.text.includes('Лебедев') && r.text.includes('Нет активности'));
    check('психолог: нет Зориной (не его пациент)', !r.text.includes('Зорина'));
    r = await req('GET', '/crisis', { cookieJar: psycho });
    check('психолог: очередь содержит уровня 1 своего пациента (Громов), но не Зорину', r.status === 200 && r.text.includes('Громов') && !r.text.includes('Зорина'));

    console.log('5) Подтверждение: пустое тело и с исходом');
    r = await req('POST', `/crisis/${zorinaEsc}/acknowledge`, { cookieJar: psy2, body: {} });
    check('подтверждение пустым телом -> редирект на /crisis', r.status === 302 && r.location === '/crisis');
    check('статус acknowledged', db.prepare('SELECT status FROM crisis_escalations WHERE id = ?').get(zorinaEsc).status === 'acknowledged');
    const other = db.prepare("SELECT id FROM crisis_escalations WHERE patient_id = ? AND status='open'").get(ids.zorina).id;
    r = await req('POST', `/crisis/${other}/acknowledge`, { cookieJar: psy2, body: { outcome: 'reached', note: 'созвонились' } });
    check('подтверждение с исходом', r.status === 302);
    const ev = db.prepare("SELECT detail_json FROM crisis_incident_log WHERE escalation_id = ? AND event_type = 'manual_review_outcome'").get(other);
    check('исход записан в crisis_incident_log', ev && JSON.parse(ev.detail_json).outcome === 'reached');
    r = await req('GET', '/dashboard', { cookieJar: psy2 });
    check('бейдж = 0 после подтверждения (нет «(2)»)', !/<title>\(\d/.test(r.text));
    r = await req('POST', `/crisis/${other}/acknowledge`, { cookieJar: psy2, body: {} });
    check('повторное подтверждение отклоняется', r.status === 403);
    r = await req('GET', `/crisis/${other}`, { cookieJar: psy2 });
    check('карточка эскалации: цитата, пациент, телефон-пояснение, история', r.status === 200 && r.text.includes('Что сработало') && r.text.includes('Телефон для срочной связи') && r.text.includes('История событий'));

    console.log('6) Просрочка SLA обрабатывается и вне /crisis (REQ-CRI-003)');
    const eid = escalation.createEscalation({ patientId: ids.svetlova, instrument: 'phq9', reasons: ['тест'], tier: 2, triggers: ['C'] });
    db.prepare('UPDATE crisis_escalations SET due_at = ? WHERE id = ?').run(new Date(Date.now() - 3600000).toISOString(), eid);
    check('до запроса резерву не передано', db.prepare('SELECT escalated_to_backup_at AS t FROM crisis_escalations WHERE id = ?').get(eid).t === null);
    r = await req('GET', '/dashboard', { cookieJar: psycho });
    check('запрос /dashboard выставил escalated_to_backup_at', !!db.prepare('SELECT escalated_to_backup_at AS t FROM crisis_escalations WHERE id = ?').get(eid).t);
    r = await req('GET', '/crisis', { cookieJar: psy1 });
    check('в очереди «передано <кому> в <время>»', /передано: [^<]+ в \d{2}\.\d{2}\.\d{4}/.test(r.text));

    console.log('7) Обращение пациента (patient_appeals)');
    db.prepare("INSERT INTO patient_appeals (patient_id, clinician_id, routed_to, message, status, created_at) VALUES (?, ?, 'clinician', NULL, 'open', datetime('now'))").run(ids.svetlova, uid('psychiatrist1@example.com'));
    db.prepare("INSERT INTO patient_appeals (patient_id, clinician_id, routed_to, message, status, created_at) VALUES (?, NULL, 'admin', NULL, 'open', datetime('now'))").run(ids.fomin);
    r = await req('GET', '/crisis', { cookieJar: psy1 });
    check('обращение видно врачу отдельной меткой', r.text.includes('Обращение пациента'));
    check('обращение без врача (admin) в очереди клинициста не видно', !r.text.includes('Фомин'));
    r = await req('GET', '/dashboard', { cookieJar: psy1 });
    check('светофор: Светлова стала красной из-за обращения', /triage--red[\s\S]*Светлова/.test(r.text.split('<tbody>')[1] || ''));
    const appealId = db.prepare("SELECT id FROM patient_appeals WHERE patient_id = ?").get(ids.svetlova).id;
    r = await req('POST', `/crisis/a${appealId}/acknowledge`, { cookieJar: psy1, body: {} });
    check('обращение подтверждается как эскалация', r.status === 302 && db.prepare('SELECT status FROM patient_appeals WHERE id = ?').get(appealId).status === 'acknowledged');
    r = await req('POST', `/crisis/a${appealId}/acknowledge`, { cookieJar: psycho, body: {} });
    check('повторно/чужому — отказ', r.status === 403);

    console.log('8) Список пациентов: поиск, теги, архив, snooze');
    r = await req('GET', '/patients?q=%D0%90%D0%A0%D0%A2%D0%95%D0%9C', { cookieJar: psycho });
    check('поиск без учёта регистра и ё/е («АРТЕМ» находит «Артём»)', r.text.includes('Лебедев'));
    r = await req('GET', '/patients?q=%D1%81%D0%B2%D0%B5%D1%82%D0%BB%D0%BE%D0%B2%D0%B0', { cookieJar: psy1 });
    check('поиск по фамилии', r.text.includes('Светлова') && !r.text.includes('Громов'));
    r = await req('POST', `/patients/${ids.novikov}/tags`, { cookieJar: psy1, body: { tag: 'новый', back: '/patients' } });
    check('тег добавляется', r.status === 302);
    r = await req('GET', '/patients?tag=%D0%BD%D0%BE%D0%B2%D1%8B%D0%B9', { cookieJar: psy1 });
    check('фильтр по тегу', r.text.includes('Новиков') && !r.text.includes('Светлова'));
    r = await req('GET', '/patients?tag=%D0%BD%D0%BE%D0%B2%D1%8B%D0%B9', { cookieJar: psy2 });
    check('теги личные: у другого врача их нет', !r.text.includes('Новиков'));
    r = await req('POST', `/patients/${ids.novikov}/archive`, { cookieJar: psy1, body: { back: '/patients' } });
    r = await req('GET', '/patients', { cookieJar: psy1 });
    check('архив: скрыт из основного списка', !r.text.includes('Новиков'));
    r = await req('GET', '/patients?view=archive', { cookieJar: psy1 });
    check('архив: виден в «Архиве» с кнопкой возврата', r.text.includes('Новиков') && r.text.includes('Вернуть из архива'));
    r = await req('POST', `/patients/${ids.novikov}/unarchive`, { cookieJar: psy1, body: {} });
    r = await req('GET', '/patients', { cookieJar: psy1 });
    check('возврат из архива', r.text.includes('Новиков'));
    // архив + открытая эскалация -> остаётся в очереди
    const zEsc2 = escalation.createEscalation({ patientId: ids.zorina, instrument: 'phq9', reasons: ['тест архива'], tier: 3, triggers: ['E'] });
    await req('POST', `/patients/${ids.zorina}/archive`, { cookieJar: psy2, body: {} });
    r = await req('GET', '/crisis', { cookieJar: psy2 });
    check('архив + открытая эскалация -> она в очереди', r.text.includes('тест архива'));
    r = await req('GET', '/dashboard', { cookieJar: psy2 });
    check('и пациент виден в сводке красным', r.text.includes('Зорина') && r.text.includes('triage--red'));
    // snooze
    r = await req('POST', `/patients/${ids.zorina}/snooze`, { cookieJar: psy2, body: {} });
    check('snooze красного -> отказ (остаётся красным)', db.prepare('SELECT COUNT(*) AS n FROM triage_snoozes WHERE patient_id = ?').get(ids.zorina).n === 0);
    r = await req('POST', `/patients/${ids.lebedev}/snooze`, { cookieJar: psycho, body: { days: '7', back: '/dashboard' } });
    check('snooze жёлтого -> принят', r.status === 302 && db.prepare('SELECT COUNT(*) AS n FROM triage_snoozes WHERE patient_id = ?').get(ids.lebedev).n === 1);
    r = await req('GET', '/dashboard', { cookieJar: psycho });
    check('отложенный пропал из «внимания»', !/Лебедев[\s\S]{0,400}Нет активности/.test(r.text));
    // возвращается при новом ухудшении
    db.prepare("INSERT INTO online_results (patient_id, instrument, answers_json, total_score, band, created_at) VALUES (?, 'phq9', '[]', 6, 'лёгкая депрессия', datetime('now','-1 day'))").run(ids.lebedev);
    db.prepare("INSERT INTO online_results (patient_id, instrument, answers_json, total_score, band, created_at) VALUES (?, 'phq9', '[]', 15, 'умеренно тяжёлая депрессия', datetime('now'))").run(ids.lebedev);
    r = await req('GET', '/dashboard', { cookieJar: psycho });
    check('при ухудшении отложенный флаг возвращается', /Лебедев[\s\S]{0,600}Ухудшение по PHQ9: 6 → 15/.test(r.text));

    console.log('9) Оповещение-заглушка (outbox) без ПД');
    queue.sweepNotifications();
    const lines = fs.existsSync(process.env.TDR_OUTBOX_PATH) ? fs.readFileSync(process.env.TDR_OUTBOX_PATH, 'utf8').trim().split('\n') : [];
    check('в outbox есть записи по Tier >=2', lines.length >= 3);
    const parsed = lines.map((l) => JSON.parse(l));
    check('запись: id, tier, время', parsed.every((e) => e.id && e.tier >= 2 && e.at));
    check('в outbox нет ФИО/текста', !/Зорина|Громов|Светлова|тест/.test(lines.join('\n')));
    check('каждая эскалация записывается один раз', new Set(parsed.map((e) => e.id)).size === parsed.length);
    void zEsc2;
  } finally {
    server.close();
  }
  console.log(`\nclinician_dash: ${oks} OK, ${failures} FAIL`);
  if (failures) process.exitCode = 1;
  else console.log('Все проверки кабинета клинициста прошли успешно.');
}

main().catch((e) => { console.error('FAIL', e); process.exitCode = 1; });
