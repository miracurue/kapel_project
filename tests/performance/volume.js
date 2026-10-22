'use strict';

// Синтетический объём «через год работы» (08 Basis и Quality): 2 000 пациентов, 50 специалистов,
// около 1 млн записей (дневник, отметки приёма, результаты, сообщения, уведомления, журнал доступа, сигналы).
// Пишется прямо в базу после миграций по схеме этапа 11 — так быстрее, чем через API, и объём точный.
// Только синтетика (PD-24). PERF_SCALE=0.1 — уменьшенный прогон для проверки самого теста.

const path = require('path');
const crypto = require('crypto');
const { insert, hmacHex } = require('../fixtures/world');

const SCALE = Number(process.env.PERF_SCALE || 1);
const N_PATIENTS = Math.round(2000 * SCALE);
const N_CLINICIANS = 50;
const DAYS = 365;

function iso(d) { return d.toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function dayStr(d) { return d.toISOString().slice(0, 10); }

function generate(dbPath, ids, env) {
  const Database = require(path.join(__dirname, '..', '..', 'node_modules', 'better-sqlite3'));
  const bcrypt = require(path.join(__dirname, '..', '..', 'node_modules', 'bcryptjs'));
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const hash = bcrypt.hashSync('Synthetic-Pass-2026', 4);
  const now = Date.now();
  const counts = {};
  const bump = (t, n = 1) => { counts[t] = (counts[t] || 0) + n; };
  const tx = db.transaction(() => {
    const clinicians = [ids.psy1, ids.plg1];
    for (let i = 0; i < N_CLINICIANS - 2; i += 1) {
      const role = i % 3 === 2 ? 'psychologist' : 'psychiatrist';
      const email = `perf.staff${i}@cc.example.test`;
      clinicians.push(insert(db, 'users', { service_no: `Т-S${String(i).padStart(4, '0')}`, email, email_hmac: hmacHex(env.LOG_HMAC_KEY, email), password_hash: hash, role, full_name: `Специалист Объёмный ${i}`, status: 'active', is_demo: 1 }));
    }
    const moodStmt = db.prepare('INSERT INTO mood_entries (patient_id, entry_date, mood, sleep, anxiety, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const medStmt = db.prepare("INSERT INTO med_log (patient_id, item_key, day, slot, status, logged_at) VALUES (?, ?, ?, 'morning', ?, ?)");
    const resStmt = db.prepare('INSERT INTO online_results (patient_id, instrument, answers_json, total_score, band, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const msgStmt = db.prepare("INSERT INTO care_messages (patient_id, clinician_id, sender_id, sender_role, body, visible_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const notStmt = db.prepare("INSERT INTO notifications (recipient_id, type, event_key, title, visible_from, created_at) VALUES (?, 'perf', ?, 'Новое событие', ?, ?)");
    const phiStmt = db.prepare("INSERT INTO phi_access_log (actor_id, actor_role, patient_id, section, action, decision, basis, created_at) VALUES (?, 'psychiatrist', ?, 'card.overview', 'view', 'allow', 'assignment', ?)");
    const crisisStmt = db.prepare("INSERT INTO crisis_escalations (patient_id, source, tier, triggers_json, status, created_at) VALUES (?, 'diary', 2, '[]', ?, ?)");
    for (let p = 0; p < N_PATIENTS; p += 1) {
      const email = `perf.patient${p}@cc.example.test`;
      const pid = insert(db, 'users', { service_no: `Т-P${String(p).padStart(5, '0')}`, email, email_hmac: hmacHex(env.LOG_HMAC_KEY, email), password_hash: hash, role: 'patient', full_name: `Пациент Объёмный ${p}`, status: 'active', is_demo: 1 });
      bump('users');
      const ep = insert(db, 'care_episodes', { patient_id: pid, started_at: iso(new Date(now - DAYS * 86400000)) });
      // psy1 ведёт 400 пациентов (самый тяжёлый список), остальные распределены по специалистам
      const doc = p < 400 * SCALE ? ids.psy1 : clinicians[2 + (p % (clinicians.length - 2))];
      insert(db, 'care_assignments', { patient_id: pid, clinician_id: doc, episode_id: ep, started_at: iso(new Date(now - DAYS * 86400000)) });
      for (let d = 0; d < DAYS; d += 1) {
        if (d % 6 === 5) continue;
        const day = new Date(now - d * 86400000);
        moodStmt.run(pid, dayStr(day), 1 + ((p + d) % 5), ['bad', 'ok', 'good'][d % 3], ['none', 'some', 'strong'][(p + d) % 3], d % 10 === 0 ? 'Синтетическая заметка' : null, iso(day));
        bump('mood_entries');
        if (d % 2 === 0) { medStmt.run(pid, `perf-${pid}`, dayStr(day), d % 9 === 0 ? 'skipped' : 'taken', iso(day)); bump('med_log'); }
      }
      for (let k = 0; k < 20; k += 1) { resStmt.run(pid, k % 2 ? 'gad7' : 'phq9', '{}', (p + k) % 21, 'STAND-IN', iso(new Date(now - k * 18 * 86400000))); bump('online_results'); }
      for (let k = 0; k < 20; k += 1) { const t = iso(new Date(now - k * 17 * 86400000)); msgStmt.run(pid, doc, k % 2 ? doc : pid, k % 2 ? 'clinician' : 'patient', 'Синтетическое сообщение', t, t); bump('care_messages'); }
      for (let k = 0; k < 50; k += 1) { const t = iso(new Date(now - k * 7 * 86400000)); notStmt.run(pid, `perf-${pid}-${k}`, t, t); bump('notifications'); }
      for (let k = 0; k < 50; k += 1) { phiStmt.run(doc, pid, iso(new Date(now - k * 7 * 86400000))); bump('phi_access_log'); }
      if (p % 2 === 0) { crisisStmt.run(pid, p % 10 === 0 ? 'new' : 'handled', iso(new Date(now - (p % 30) * 86400000))); bump('crisis_escalations'); }
    }
  });
  tx();
  db.close();
  const total = Object.values(counts).reduce((s, x) => s + x, 0);
  return { counts, total };
}

// 20 000 синтетических торговых наименований для проверки скорости подсказок F-121 (08: каталог до 20 000).
function bigCatalogCsv(stand) {
  const syll = ['ра', 'ло', 'фе', 'ксин', 'зап', 'тил', 'мер', 'дон', 'нал', 'вит', 'сан', 'пром', 'лек', 'тра', 'зол', 'мир', 'кве', 'тиа', 'пин', 'ол'];
  const rows = [stand.trimEnd()];
  const header = stand.split('\n')[0];
  const inns = [...new Set(stand.split('\n').slice(1).map((l) => l.split(',')[0]).filter(Boolean))];
  let n = 0;
  const seen = new Set();
  while (n < 20000) {
    const h = crypto.createHash('md5').update(String(n)).digest();
    const name = (syll[h[0] % 20] + syll[h[1] % 20] + syll[h[2] % 20] + syll[h[3] % 20]).replace(/^./, (c) => c.toUpperCase()) + ` Т${h[4] % 90 + 10}`;
    if (seen.has(name)) { n += 1; continue; }
    seen.add(name);
    rows.push(`${inns[n % inns.length]},other,,1,${name},STAND-IN производитель,таблетки,${(h[5] % 9 + 1) * 10} мг,stand_in,2026-10-17`);
    n += 1;
  }
  void header;
  return rows.join('\n') + '\n';
}

module.exports = { generate, bigCatalogCsv, N_PATIENTS };
