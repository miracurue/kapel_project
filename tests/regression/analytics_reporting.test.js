'use strict';
// covers: F-71, F-74, PD-19 — event provenance, distinct users, visibility, cohort history.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const report = require('../../src/modules/analytics/reporting');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');

const period = { from: '2026-10-01', to: '2026-10-31' };
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reporting-'));
  const file = path.join(dir, 'test.sqlite3');
  execFileSync(process.execPath, [path.resolve(__dirname, '../../scripts/migrate.js')], {
    env: { ...process.env, DB_PATH: file },
    stdio: 'pipe',
  });
  const db = new Database(file);
  db.pragma('foreign_keys = OFF');
  for (const [id, role] of [
    [1, 'psychiatrist'],
    [2, 'psychologist'],
    [10, 'patient'],
    [11, 'patient'],
  ]) {
    db.prepare('INSERT INTO users(id,service_no,role,email,full_name) VALUES (?,?,?,?,?)').run(
      id,
      `T-${id}`,
      role,
      `${id}@test.invalid`,
      'Synthetic',
    );
    db.prepare('INSERT INTO user_prefs(user_id) VALUES (?)').run(id);
  }
  for (const id of [10, 11])
    for (const kind of ['base', 'research'])
      db.prepare(
        "INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method) VALUES (?,?,'given',1,'x','demo')",
      ).run(id, kind);
  return {
    db,
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
const mood = (db, id, day, n, hours) =>
  db
    .prepare(
      "INSERT INTO mood_entries(patient_id,entry_date,mood,legacy_sleep_hours,created_at) VALUES (?,?,?,?,'2026-10-20T00:00:00Z')",
    )
    .run(id, day, n, hours);

test('source events retain repeat tests/doses, version and unit; hidden sources and private habits stay private', () => {
  const t = fixture();
  const db = t.db;
  try {
    mood(db, 10, '2026-10-20', 2, 6);
    mood(db, 10, '2026-10-20', 3, 7.5);
    db.prepare(
      "INSERT INTO online_results(patient_id,instrument,instrument_version,answers_json,total_score,created_at) VALUES (10,'test-a',?,'{}',?,'2026-10-20T10:00:00Z')",
    ).run(1, 3);
    db.prepare(
      "INSERT INTO online_results(patient_id,instrument,instrument_version,answers_json,total_score,created_at) VALUES (10,'test-a',?,'{}',?,'2026-10-20T11:00:00Z')",
    ).run(2, 6);
    for (const slot of ['morning', 'evening'])
      db.prepare(
        "INSERT INTO med_log(patient_id,item_key,day,slot,status) VALUES (10,'med-a','2026-10-20',?,'taken')",
      ).run(slot);
    db.exec('BEGIN');
    db.prepare("INSERT INTO diary_habits(patient_id,habit_id,current_version) VALUES (10,'water',1)").run();
    db.prepare(
      "INSERT INTO diary_habit_versions(patient_id,habit_id,version,definition_json,created_at) VALUES (10,'water',1,?,'2026-10-20T00:00:00Z')",
    ).run(JSON.stringify({ id: 'water', type: 'measure', unit: 'ml', shared: false }));
    for (let ordinal = 0; ordinal < 2; ordinal++)
      db.prepare(
        "INSERT INTO diary_habit_values(patient_id,habit_id,version,day,ordinal,value_json,recorded_at) VALUES (10,'water',1,'2026-10-20',?,'250','2026-10-20T00:00:00Z')",
      ).run(ordinal);
    db.exec('COMMIT');
    const r = report.patientReport(db, 10, period);
    assert.equal(r.events.filter((e) => e.metric === 'mood').length, 1, 'wellbeing snapshots select latest per day');
    assert.ok(
      report
        .patientReport(db, 10, period, { role: 'psychologist' })
        .events.every((e) => !['medication_status', 'adverse_event'].includes(e.metric)),
    );
    assert.equal(r.events.filter((e) => e.metric === 'test_score').length, 2);
    assert.equal(r.rows.filter((e) => e.metric === 'test_score').length, 2, 'versions separate');
    assert.equal(r.rows.find((e) => e.metric === 'medication_status').n_events, 2);
    assert.equal(r.rows.find((e) => e.metric === 'sleep_hours').mean, 7.5);
    assert.equal(r.events.filter((e) => e.metric === 'habit_value').length, 0);
    const own = report.patientReport(db, 10, period, 'patient');
    assert.equal(own.events.filter((e) => e.metric === 'habit_value').length, 2);
    assert.equal(own.events.filter((e) => e.metric === 'test_score').length, 0, 'no test scores returned to patient');
    assert.equal(own.events.filter((e) => e.metric === 'test_completed').length, 2);
    db.prepare('UPDATE user_prefs SET share_diary_scores=0,share_med_log=0 WHERE user_id=10').run();
    const redacted = report.patientReport(db, 10, period);
    assert.ok(redacted.events.every((e) => !['mood', 'sleep_hours', 'medication_status'].includes(e.metric)));
    db.prepare("UPDATE online_results SET invalid_at='2026-10-21' WHERE instrument_version=2").run();
    assert.equal(report.patientReport(db, 10, period).events.filter((e) => e.metric === 'test_score').length, 1);
  } finally {
    t.close();
  }
});

test('historical assignments/episodes filter event dates, deduplicate patients and honour current revocation', () => {
  const t = fixture();
  const db = t.db;
  try {
    db.prepare(
      "INSERT INTO care_episodes(id,patient_id,started_at,ended_at) VALUES (1,10,'2026-10-10','2026-10-20')",
    ).run();
    for (const clinician of [1, 2])
      db.prepare(
        "INSERT INTO care_assignments(patient_id,clinician_id,episode_id,started_at,ended_at) VALUES (10,?,1,'2026-10-01','2026-10-25')",
      ).run(clinician);
    mood(db, 10, '2026-10-05', 1, 6);
    mood(db, 10, '2026-10-15', 4, 8);
    mood(db, 10, '2026-10-22', 5, 8);
    const historical = report.cohortReport(db, { scope: 'historical', clinicianId: 1, ...period, minGroup: 1 });
    assert.equal(historical.n_people, 1);
    const beforeEpisode = report.cohortReport(db, {
      scope: 'historical',
      clinicianId: 1,
      from: '2026-10-01',
      to: '2026-10-05',
      minGroup: 1,
    });
    assert.equal(
      beforeEpisode.n_people,
      null,
      'assignment without an overlapping episode is not denominator membership',
    );
    assert.equal(beforeEpisode.members_suppressed, true);
    assert.deepEqual(beforeEpisode.rows, []);
    assert.equal(historical.rows.find((r) => r.metric === 'mood').n_events, 1, 'episode intersects assignment');
    assert.equal(
      report.cohortReport(db, { scope: 'current', clinicianId: 1, ...period, minGroup: 1 }).members_suppressed,
      true,
    );
    const program = report.cohortReport(db, { scope: 'program', ...period, minGroup: 1 });
    assert.equal(program.n_people, 2, 'two patients, not assignments');
    assert.equal(program.rows.find((r) => r.metric === 'mood').n_events, 3, 'no double counting across clinicians');
    assert.doesNotMatch(JSON.stringify(program), /subject_code|patient_id|source_id/);
    assert.equal(
      report.cohortReport(db, { scope: 'program', ...period, minGroup: 2 }).rows.find((r) => r.metric === 'mood').mean,
      null,
      'metric-specific participants below min',
    );
    db.prepare(
      "INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method) VALUES (10,'research','revoked',1,'x','demo')",
    ).run();
    assert.equal(report.cohortReport(db, { scope: 'program', ...period, minGroup: 1 }).rows.length, 0);
    db.prepare(
      "INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method) VALUES (10,'base','revoked',1,'x','demo')",
    ).run();
    assert.equal(
      report.cohortReport(db, { scope: 'historical', clinicianId: 1, ...period, minGroup: 1 }).members_suppressed,
      true,
    );
  } finally {
    t.close();
  }
});

test('product reports distinguish people/events/sessions, snapshot role at event, no invented history', () => {
  const t = fixture();
  const db = t.db;
  try {
    const started = db
      .prepare("SELECT value FROM analytics_product_metadata WHERE key='history_started_at'")
      .get().value;
    assert.ok(started);
    const record = (id, role, event, session) =>
      db
        .prepare(
          'INSERT INTO analytics_product_activity(user_id,role,event,session_code,recorded_at) VALUES (?,?,?,?,?)',
        )
        .run(id, role, event, session, '2026-10-20T00:00:00Z');
    record(10, 'patient', 'session_started', 'a');
    record(10, 'patient', 'session_started', 'b');
    record(10, 'patient', 'diary.saved', 'a');
    record(1, 'psychiatrist', 'session_started', 'c');
    record(2, 'psychologist', 'session_started', 'd');
    const r = report.productReport(db, { ...period, minGroup: 1 });
    assert.equal(r.active_people, 3);
    assert.equal(r.rows[0].active_people, 1);
    assert.equal(r.rows[0].n_events, 3);
    assert.equal(r.rows[0].n_sessions, 2);
    record(1, 'patient', 'diary.saved', 'c');
    assert.equal(
      report.productReport(db, { ...period, minGroup: 1 }).active_people,
      3,
      'same person in two roles counted once in total',
    );
    assert.equal(report.productReport(db, { ...period, minGroup: 2 }).active_people, null, 'complementary suppression');
    assert.equal(
      report.productReport(db, { from: '2020-01-01', to: '2020-12-31', minGroup: 1 }).rows[0].active_people,
      null,
      'no historical backfill',
    );
    assert.doesNotMatch(JSON.stringify(r), /subject_code|user_id|session_code/);
  } finally {
    t.close();
  }
});

const ctx = useApp();
test('report endpoints reject wrong role, foreign/detached/revoked patient and cross-scope access', async () => {
  const doc = await ctx.as('psy1'),
    other = await ctx.as('psy2'),
    patient = await ctx.as('patA'),
    admin = await ctx.as('admin1');
  const id = ctx.id('patA');
  expectOk(await doc.get(`/api/v1/analytics/patients/${id}`));
  expectOk(await patient.get('/api/v1/me/analytics'));
  expectError(await other.get(`/api/v1/analytics/patients/${id}`), 404, 'E-NOT-FOUND');
  expectError(await patient.get(`/api/v1/analytics/patients/${id}`), 403, 'E-ACCESS');
  expectError(await admin.get(`/api/v1/analytics/patients/${id}`), 403, 'E-ACCESS');
  expectError(await doc.get('/api/v1/admin/analytics/users'), 403, 'E-ACCESS');
  expectError(await doc.get('/api/v1/analytics/reports?scope=program'), 403, 'E-ACCESS');
  expectError(await admin.get('/api/v1/analytics/reports?scope=historical'), 403, 'E-ACCESS');
  expectError(await doc.get('/api/v1/analytics/reports?to=not-a-date'), 422, 'E-VALIDATION');
  expectError(await doc.get('/api/v1/analytics/reports?to=2026-02-30'), 422, 'E-VALIDATION');
  expectOk(await admin.get('/api/v1/admin/analytics/users'));
  ctx.app.exec(
    `INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method) VALUES (${id},'base','revoked',1,'x','demo')`,
  );
  expectError(await doc.get(`/api/v1/analytics/patients/${id}`), 403, 'E-CONSENT-REQUIRED');
  expectError(await patient.get('/api/v1/me/analytics'), 403, 'E-ACCESS');
  ctx.app.exec(
    `INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method) VALUES (${id},'base','given',1,'x','demo')`,
  );
  ctx.app.exec(
    `UPDATE care_assignments SET ended_at='2026-10-21' WHERE patient_id=${id} AND clinician_id=${ctx.id('psy1')}`,
  );
  expectError(await doc.get(`/api/v1/analytics/patients/${id}`), 404, 'E-NOT-FOUND');
});

test('AE facts honour psychiatrist recipient and embargo; psychologist has no medication/AE facts', () => {
  const t = fixture();
  try {
    for (const [psy, date] of [
      [1, '2026-10-01'],
      [2, '2026-10-01'],
      [1, '2026-11-01'],
    ])
      t.db
        .prepare(
          "INSERT INTO adverse_events(patient_id,status,psychiatrist_id,visible_from,onset_date) VALUES (10,'submitted',?,?,'2026-10-20')",
        )
        .run(psy, date);
    assert.equal(
      report
        .patientReport(t.db, 10, period, { role: 'psychiatrist', id: 1 }, '2026-10-21')
        .events.filter((e) => e.metric === 'adverse_event').length,
      1,
    );
    assert.equal(
      report
        .patientReport(t.db, 10, period, { role: 'psychologist', id: 2 }, '2026-10-21')
        .events.filter((e) => e.metric === 'adverse_event').length,
      0,
    );
  } finally {
    t.close();
  }
});

test('unversioned scores remain separate events without invented cross-version means', () => {
  const rows = report.summarize(
    [3, 7].map((value) => ({
      metric: 'test_score',
      dimension: JSON.stringify({ instrument: 'test-a', version: null, mode: 'offline' }),
      unit: 'score',
      value,
    })),
    1,
  );
  assert.equal(rows[0].n_events, 2);
  assert.equal(rows[0].denominator, 2);
  assert.equal(rows[0].mean, null);
  assert.equal(rows[0].numerator, null);
});

test('psychologist cohort excludes medication and adverse-event measures; program remains aggregate-only', () => {
  const t = fixture();
  try {
    t.db.prepare("INSERT INTO care_assignments(patient_id,clinician_id,started_at) VALUES (10,2,'2026-10-01')").run();
    t.db
      .prepare(
        "INSERT INTO med_log(patient_id,item_key,day,slot,status) VALUES (10,'med-a','2026-10-15','morning','taken')",
      )
      .run();
    t.db
      .prepare(
        "INSERT INTO adverse_events(patient_id,status,psychiatrist_id,onset_date) VALUES (10,'submitted',1,'2026-10-15')",
      )
      .run();
    for (const scope of ['current', 'historical']) {
      const result = report.cohortReport(t.db, {
        scope,
        clinicianId: 2,
        actorRole: 'psychologist',
        ...period,
        minGroup: 1,
      });
      assert.ok(result.rows.every((r) => !['medication_status', 'adverse_event'].includes(r.metric)));
    }
    const program = report.cohortReport(t.db, { scope: 'program', actorRole: 'admin', ...period, minGroup: 1 });
    assert.ok(program.rows.some((r) => r.metric === 'adverse_event'));
  } finally {
    t.close();
  }
});
