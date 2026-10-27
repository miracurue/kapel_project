'use strict';
// Три уровня аналитических данных (docs/AUDIT_CONSENT_ACCESS_2026-10-27.md, H7, решение владелицы):
// 1 — служебные счётчики по всем, 2 — агрегаты по здоровью и 3 — построчные псевдонимы по согласию 'research'.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const cohort = require('../../src/modules/analytics/cohort');

const todayOf = (offset = 0) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
const CONSENT =
  "INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method) VALUES (?,?,?,1,'x','demo')";

// Пациенты 100..: с согласием 'research' первые `consenting`; у остальных только base (и, для проверки, 'program').
function makeDb(patients, consenting) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-levels-'));
  const file = path.join(dir, 'a.sqlite3');
  execFileSync('node', [path.join(__dirname, '../../scripts/migrate.js')], {
    env: { ...process.env, DB_PATH: file },
    stdio: 'pipe',
  });
  const db = new Database(file);
  db.pragma('foreign_keys = OFF');
  db.prepare(
    "INSERT INTO users(id,service_no,role,email,full_name) VALUES (1,'Т-001','psychiatrist','d@x.test','Д')",
  ).run();
  for (let i = 0; i < patients; i += 1) {
    const id = 100 + i;
    db.prepare("INSERT INTO users(id,service_no,role,full_name) VALUES (?,?,'patient','Синтетика')").run(id, `П-${id}`);
    db.prepare('INSERT INTO care_assignments(patient_id,clinician_id) VALUES (?,1)').run(id);
    db.prepare(CONSENT).run(id, 'base', 'given');
    db.prepare(CONSENT).run(id, i < consenting ? 'research' : 'program', 'given');
    for (let d = 0; d < 4; d += 1)
      db.prepare(
        "INSERT INTO mood_entries(patient_id,entry_date,mood,sleep,anxiety,created_at) VALUES (?,?,?,'ok','none','2026-10-21T00:00:00Z')",
      ).run(id, todayOf(d), 3);
    db.prepare(
      "INSERT INTO research_pseudonyms(patient_id,pseudonym,expires_at) VALUES (?,?,datetime('now','+30 days'))",
    ).run(id, `ps-${id}`);
  }
  return {
    db,
    close: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
const range = { from: todayOf(30), to: todayOf(0), minGroup: 10 };
const n = (db, sql) => db.prepare(sql).get().n;

test('уровень 1: служебные счётчики не зависят от согласия, оценки и заметки в них не попадают', () => {
  const t = makeDb(12, 0);
  try {
    assert.equal(n(t.db, 'SELECT COUNT(*) n FROM analytics_service_members'), 12);
    assert.equal(
      n(t.db, "SELECT COUNT(DISTINCT subject_code) n FROM analytics_service_facts WHERE metric='diary_entry'"),
      12,
    );
    assert.equal(n(t.db, "SELECT COUNT(*) n FROM analytics_service_facts WHERE metric<>'diary_entry'"), 0);
    const rep = cohort.diaryReport(t.db, { scope: 'program', ...range });
    assert.deepEqual(rep.service, { level: 1, patients: 12, diary_writers: 12 });
    assert.equal(rep.suppressed, true, 'уровень 2 при нуле согласившихся скрыт');
    assert.doesNotMatch(JSON.stringify(rep.service), /subject_code|patient_id/);
  } finally {
    t.close();
  }
});

test('уровень 2: считаются только согласившиеся на research; согласие program не считается; отзыв исключает сразу', () => {
  const t = makeDb(14, 10);
  try {
    const rep = () => cohort.diaryReport(t.db, { scope: 'program', ...range });
    assert.equal(rep().rows[0].denominator, 10, 'четверо с одним program не входят');
    assert.equal(rep().service.patients, 14, 'уровень 1 по всем');
    t.db.prepare(CONSENT).run(100, 'research', 'revoked');
    assert.equal(rep().suppressed, true, 'осталось 9 — ячейки скрыты');
    assert.equal(rep().members_suppressed, true);
    assert.equal(rep().service.patients, 14, 'отзыв не меняет служебные счётчики');
  } finally {
    t.close();
  }
});

test('малые группы: меньше порога — уровень 1 и 2 скрыты', () => {
  const t = makeDb(9, 9);
  try {
    const rep = cohort.diaryReport(t.db, { scope: 'program', ...range });
    assert.equal(rep.service.patients, null);
    assert.equal(rep.service.diary_writers, null);
    assert.ok(rep.rows.every((r) => r.value === null && r.denominator === null));
    assert.ok(rep.mood_bands.every((b) => b.n_patients === null));
  } finally {
    t.close();
  }
});

test('уровень 3: псевдонимы видны только при действующем research; отзыв убирает при следующем запросе; patient_id нет', () => {
  const t = makeDb(3, 2);
  try {
    const list = () => t.db.prepare('SELECT * FROM analytics_research_pseudonyms ORDER BY pseudonym').all();
    assert.deepEqual(
      list().map((r) => r.pseudonym),
      ['ps-100', 'ps-101'],
    );
    assert.ok(!('patient_id' in list()[0]));
    t.db.prepare(CONSENT).run(100, 'research', 'revoked');
    assert.deepEqual(
      list().map((r) => r.pseudonym),
      ['ps-101'],
    );
    t.db.prepare(CONSENT).run(101, 'program', 'given');
    assert.equal(list().length, 1, 'program доступа к уровню 3 не даёт');
  } finally {
    t.close();
  }
});
