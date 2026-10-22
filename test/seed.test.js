'use strict';

// W0.5: демо-сид (scripts/seed-demo.js) на временной БД.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-seed-'));
process.env.TDR_DB_PATH = path.join(tmp, 'seed.sqlite3');

const bcrypt = require('bcryptjs');
require('../scripts/gc-guard'); // до src/db (обход GC-сбоя better-sqlite3)
const db = require('../src/db');
const { seedDemo, ACCOUNTS, DEMO_PASSWORD } = require('../scripts/seed-demo');
const { scoreInstrument } = require('../src/instruments');
const catalog = require('../src/instruments_catalog');

let fails = 0;
let oks = 0;
function check(name, fn) {
  try {
    fn();
    oks++;
    console.log(`  OK   ${name}`);
  } catch (e) {
    fails++;
    console.log(`  FAIL ${name}: ${e.message}`);
  }
}
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const uid = (email) => one('SELECT id FROM users WHERE email = ?', email).id;
const TABLES = ['users', 'care_assignments', 'instrument_assignments', 'online_results', 'offline_results', 'comparison_pairs',
  'crisis_escalations', 'crisis_incident_log', 'mood_entries', 'reminders', 'chatbot_sessions', 'chatbot_messages', 'catalog_protocols', 'phi_access_log'];
const counts = () => Object.fromEntries(TABLES.map((t) => [t, one(`SELECT COUNT(*) AS n FROM ${t}`).n]));

const first = seedDemo();
const c1 = counts();

check('сид создаёт 18 пользователей: 1 админ, 4 психиатра, 2 психолога, 11 пациентов', () => {
  assert.strictEqual(first.skipped, false);
  assert.strictEqual(c1.users, 18);
  const by = Object.fromEntries(all('SELECT role, COUNT(*) AS n FROM users GROUP BY role').map((r) => [r.role, r.n]));
  assert.deepStrictEqual(by, { admin: 1, patient: 11, psychiatrist: 4, psychologist: 2 });
});
check('только синтетика: почты @example.com, имена начинаются с «Демо»', () => {
  for (const u of all('SELECT email, full_name FROM users')) {
    assert.ok(u.email.endsWith('@example.com'), u.email);
    assert.ok(u.full_name.startsWith('Демо'), u.full_name);
  }
});
check('у всех демо-аккаунтов пароль demo-pass-123', () => {
  assert.strictEqual(DEMO_PASSWORD, 'demo-pass-123');
  for (const a of ACCOUNTS) {
    const u = one('SELECT password_hash, role FROM users WHERE email = ?', a.email);
    assert.ok(bcrypt.compareSync(DEMO_PASSWORD, u.password_hash), a.email);
    assert.strictEqual(u.role, a.role);
  }
});
check('каждый балл и band онлайн-результата совпадают с пересчётом существующими функциями скоринга', () => {
  const rows = all('SELECT instrument, answers_json, total_score, band, risk_flag FROM online_results');
  assert.ok(rows.length >= 100, `online_results: ${rows.length}`);
  for (const r of rows) {
    const s = catalog.scoreAny(r.instrument, JSON.parse(r.answers_json));
    assert.strictEqual(r.total_score, s.total, r.instrument);
    assert.strictEqual(r.band, s.band, r.instrument);
    assert.strictEqual(r.risk_flag, s.riskFlag ? 1 : 0, r.instrument);
  }
  void scoreInstrument;
});
check('представлены PHQ-9, GAD-7, HADS, WHO-5, C-SSRS и заглушки каталога; офлайн BDI-II, СМИЛ, STAI', () => {
  const on = new Set(all('SELECT DISTINCT instrument FROM online_results').map((r) => r.instrument));
  for (const c of ['phq9', 'gad7', 'hads', 'who5', 'cssrs', 'isi', 'zung_sds', 'bai']) assert.ok(on.has(c), `online ${c}`);
  const off = new Set(all('SELECT DISTINCT instrument FROM offline_results').map((r) => r.instrument));
  for (const c of ['bdi2', 'mmpi', 'stai', 'phq9', 'gad7']) assert.ok(off.has(c), `offline ${c}`);
  assert.ok(c1.catalog_protocols >= 3);
  for (const p of all('SELECT instrument, status FROM catalog_protocols')) {
    assert.strictEqual(catalog.getEntry(p.instrument).mode, 'clinician_entered');
    assert.strictEqual(p.status, 'draft');
  }
});
check('история 8–12 недель по неделям у пациентов с данными', () => {
  const span = (email) => {
    const r = one('SELECT MIN(created_at) AS a, MAX(created_at) AS b, COUNT(*) AS n FROM online_results WHERE patient_id = ?', uid(email));
    return { weeks: (new Date(r.b.replace(' ', 'T') + 'Z') - new Date(r.a.replace(' ', 'T') + 'Z')) / (7 * 86400000), n: r.n };
  };
  assert.ok(span('patient1.improving@example.com').weeks >= 11);
  assert.ok(span('patient2.worsening@example.com').weeks >= 9);
  assert.ok(span('patient7.revoked@example.com').weeks >= 7);
});
check('траектории: у «улучшения» PHQ-9 падает, у «ухудшения» растёт', () => {
  const series = (email) => all("SELECT total_score FROM online_results WHERE patient_id = ? AND instrument = 'phq9' ORDER BY created_at", uid(email)).map((r) => r.total_score);
  const imp = series('patient1.improving@example.com');
  const wor = series('patient2.worsening@example.com');
  assert.ok(imp[0] - imp[imp.length - 1] >= 10, imp.join(','));
  assert.ok(wor[wor.length - 1] - wor[0] >= 8, wor.join(','));
});
check('дневник: по дням, тренд вверх у улучшения и вниз у ухудшения', () => {
  const avg = (email, limit, order) => {
    const rows = all(`SELECT mood_score FROM mood_entries WHERE patient_id = ? ORDER BY created_at ${order} LIMIT ?`, uid(email), limit);
    return rows.reduce((s, r) => s + r.mood_score, 0) / rows.length;
  };
  assert.ok(avg('patient1.improving@example.com', 10, 'DESC') - avg('patient1.improving@example.com', 10, 'ASC') >= 2);
  assert.ok(avg('patient2.worsening@example.com', 10, 'ASC') - avg('patient2.worsening@example.com', 10, 'DESC') >= 2);
  assert.ok(one('SELECT COUNT(*) AS n FROM mood_entries WHERE patient_id = ?', uid('patient1.improving@example.com')).n >= 60);
});
check('кризисные эскалации Tier 1, 2 и 3 реально открыты и созданы через протокол (с журналом инцидентов)', () => {
  for (const tier of [1, 2, 3]) {
    const open = all("SELECT * FROM crisis_escalations WHERE tier = ? AND status = 'open'", tier);
    assert.ok(open.length >= 1, `нет открытой Tier ${tier}`);
    for (const e of open) {
      assert.ok(one("SELECT 1 FROM crisis_incident_log WHERE escalation_id = ? AND event_type = 'created'", e.id), 'нет события created');
      if (tier >= 2) {
        assert.ok(e.due_at, 'Tier 2/3 без SLA');
        assert.ok(one("SELECT 1 FROM crisis_incident_log WHERE escalation_id = ? AND event_type = 'specialist_notified'", e.id));
      }
    }
  }
  const t2 = one("SELECT * FROM crisis_escalations WHERE tier = 2 AND status = 'open'");
  assert.strictEqual(one('SELECT instrument FROM online_results WHERE id = ?', t2.online_result_id).instrument, 'cssrs');
  assert.strictEqual(t2.unresolved, 1, 'Tier 2 с просроченным SLA без резерва должна быть unresolved');
  assert.ok(one("SELECT 1 FROM crisis_incident_log WHERE escalation_id = ? AND event_type = 'unresolved'", t2.id));
  const t3 = one("SELECT * FROM crisis_escalations WHERE tier = 3 AND status = 'open'");
  assert.strictEqual(t3.instrument, 'chatbot');
  assert.ok(one("SELECT 1 FROM chatbot_messages WHERE intent = 'crisis'"));
  assert.ok(one("SELECT 1 FROM crisis_escalations WHERE status = 'acknowledged' AND acknowledged_by IS NOT NULL"), 'нужна и подтверждённая эскалация');
});
check('открытая Tier 1 у «ухудшения» и авто-назначенный C-SSRS ждёт прохождения', () => {
  const p2 = uid('patient2.worsening@example.com');
  assert.ok(one("SELECT 1 FROM crisis_escalations WHERE patient_id = ? AND tier = 1 AND status = 'open'", p2));
  assert.ok(one("SELECT 1 FROM instrument_assignments WHERE patient_id = ? AND instrument = 'cssrs' AND status = 'pending' AND auto_assigned = 1", p2));
});
check('пары сравнения существуют: все три типа, ссылки целы, расхождение посчитано', () => {
  const pairs = all('SELECT * FROM comparison_pairs');
  assert.ok(pairs.length >= 5, `пар: ${pairs.length}`);
  assert.deepStrictEqual(new Set(pairs.map((p) => p.comparability)), new Set(['same_scale_within_window', 'same_scale_wide_window', 'cross_instrument']));
  for (const p of pairs) {
    const on = one('SELECT total_score FROM online_results WHERE id = ?', p.online_result_id);
    const off = one('SELECT total_score FROM offline_results WHERE id = ?', p.offline_result_id);
    assert.ok(on && off);
    assert.strictEqual(p.discrepancy_raw, on.total_score - off.total_score);
  }
});
check('сценарии: пациент без врача, с отозванным научным согласием, новый без данных', () => {
  const p6 = uid('patient6.nodoctor@example.com');
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM care_assignments WHERE patient_id = ?', p6).n, 0);
  assert.ok(one('SELECT COUNT(*) AS n FROM online_results WHERE patient_id = ?', p6).n > 0);
  const p7 = one('SELECT * FROM users WHERE email = ?', 'patient7.revoked@example.com');
  assert.strictEqual(p7.anonymized_export_opt_in, 0);
  assert.ok(p7.export_consent_revoked_at);
  assert.ok(one("SELECT 1 FROM data_subject_requests WHERE patient_id = ? AND request_type = 'export_consent_revocation'", p7.id));
  const p8 = uid('patient8.new@example.com');
  for (const t of ['online_results', 'offline_results', 'mood_entries', 'instrument_assignments', 'reminders', 'chatbot_sessions', 'crisis_escalations']) {
    assert.strictEqual(one(`SELECT COUNT(*) AS n FROM ${t} WHERE patient_id = ?`, p8).n, 0, t);
  }
  assert.ok(one('SELECT 1 FROM care_assignments WHERE patient_id = ?', p8));
});
check('пропуски: непройденные и просроченные (старше 3 недель) назначения, накопившиеся напоминания, нет свежей активности', () => {
  const p4 = uid('patient4.inactive@example.com');
  const old = all("SELECT assigned_at FROM instrument_assignments WHERE patient_id = ? AND status = 'pending'", p4);
  assert.ok(old.length >= 3);
  assert.ok(old.some((a) => Date.now() - new Date(a.assigned_at.replace(' ', 'T') + 'Z') > 21 * 86400000));
  assert.ok(one('SELECT COUNT(*) AS n FROM reminders WHERE patient_id = ? AND active = 1 AND remind_at < ?', p4, new Date().toISOString()).n >= 3);
  const last = one('SELECT MAX(created_at) AS m FROM mood_entries WHERE patient_id = ?', p4).m;
  assert.ok(Date.now() - new Date(last.replace(' ', 'T') + 'Z') > 21 * 86400000);
  assert.ok(one("SELECT COUNT(*) AS n FROM instrument_assignments WHERE status = 'pending' AND instrument IN ('bai','zung_sas')").n >= 2, 'ожидающие заглушки каталога');
});
check('напоминания (в т.ч. от врача) и диалоги с чат-ботом есть', () => {
  assert.ok(c1.reminders >= 8);
  assert.ok(one('SELECT COUNT(*) AS n FROM reminders WHERE created_by != patient_id').n >= 1);
  assert.ok(c1.chatbot_messages >= 20);
  assert.ok(one("SELECT 1 FROM chatbot_messages WHERE sender = 'bot' AND intent = 'greeting'"));
});
check('закрепления: у всех пациентов кроме одного есть врач; психолог и психиатр видят общих пациентов', () => {
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM users u WHERE role = ? AND NOT EXISTS (SELECT 1 FROM care_assignments c WHERE c.patient_id = u.id)', 'patient').n, 1);
  const psy = uid('psychologist1@example.com');
  const doc = uid('psychiatrist1@example.com');
  const shared = one('SELECT COUNT(*) AS n FROM care_assignments a JOIN care_assignments b ON a.patient_id = b.patient_id WHERE a.clinician_id = ? AND b.clinician_id = ?', psy, doc).n;
  assert.ok(shared >= 2);
});

check('NFR-010: врач без пациентов, второй психолог, резервный врач, черновик, не делится данными, длинные строки', () => {
  const noPatients = uid('psychiatrist3@example.com');
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM care_assignments WHERE clinician_id = ?', noPatients).n, 0);
  const psy2 = uid('psychologist2@example.com');
  assert.strictEqual(one('SELECT role FROM users WHERE id = ?', psy2).role, 'psychologist');
  assert.ok(one('SELECT COUNT(*) AS n FROM care_assignments WHERE clinician_id = ?', psy2).n >= 3);
  const p9 = uid('patient9.draft@example.com');
  const reserve = uid('psychiatrist4@example.com');
  assert.ok(one('SELECT 1 FROM care_assignments WHERE patient_id = ? AND clinician_id = ?', p9, reserve), 'резерв закреплён вторым специалистом');
  assert.ok(one("SELECT 1 FROM catalog_protocols WHERE patient_id = ? AND status = 'draft'", p9), 'черновик протокола');
  assert.ok(one("SELECT COUNT(*) AS n FROM instrument_assignments WHERE patient_id = ? AND status = 'pending'", p9).n >= 2);
  const p10 = one('SELECT * FROM users WHERE email = ?', 'patient10.private@example.com');
  assert.strictEqual(p10.anonymized_export_opt_in, 0);
  const p11 = one('SELECT * FROM users WHERE email = ?', 'patient11.longtext@example.com');
  assert.ok(p11.full_name.length > 60);
  assert.ok(one('SELECT MAX(LENGTH(message)) AS m FROM reminders WHERE patient_id = ?', p11.id).m > 200);
  assert.ok(one('SELECT MAX(LENGTH(protocol_json)) AS m FROM catalog_protocols WHERE patient_id = ?', p11.id).m > 500);
});

const second = seedDemo();
const c2 = counts();
check('идемпотентность: повторный запуск ничего не добавляет', () => {
  assert.strictEqual(second.skipped, true);
  assert.deepStrictEqual(c2, c1);
});

const third = seedDemo({ reset: true });
const c3 = counts();
check('--reset пересоздаёт те же данные без дублей', () => {
  assert.strictEqual(third.skipped, false);
  assert.deepStrictEqual(c3, c1);
  assert.strictEqual(one("SELECT COUNT(*) AS n FROM users WHERE email = 'admin@example.com'").n, 1);
  assert.deepStrictEqual(all('PRAGMA foreign_key_check'), []);
});

console.log(`seed: ${oks} OK, ${fails} FAIL`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* БД ещё открыта — не критично */ }
if (fails) process.exit(1);
console.log('Все проверки сида прошли успешно.');
