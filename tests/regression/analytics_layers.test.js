'use strict';
// Общая аналитика: факты из дневника, толкование для пациента и специалиста, когорты без идентификаторов
// с подавлением малых групп. Источник: BUILD_RULES §4, UC-23, UC-42, PD-19.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const interpret = require('../../src/modules/analytics/interpret');
const cohort = require('../../src/modules/analytics/cohort');

const ctx = useApp();
const todayOf = (offset = 0) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);

test('дневник пишет факты: числа и отметка «заметка есть», без текста; правка и удаление обновляют факты', async () => {
  const p = await ctx.as('patB');
  const pid = ctx.id('patB');
  const saved = expectOk(
    await p.post('/api/v1/me/diary', {
      mood: 2,
      sleep: 'bad',
      anxiety: 'strong',
      note: 'Синтетическая заметка про Т1',
    }),
  );
  const facts = () =>
    ctx.app.query(
      'SELECT metric, value FROM analytics_facts WHERE patient_id = ? AND day = ? ORDER BY metric',
      pid,
      todayOf(),
    );
  assert.deepEqual(Object.fromEntries(facts().map((f) => [f.metric, f.value])), {
    anxiety_score: 2,
    diary_entry: 1,
    mood: 2,
    note_present: 1,
    sleep_score: 0,
  });
  assert.doesNotMatch(
    JSON.stringify(ctx.app.query('SELECT * FROM analytics_facts WHERE patient_id = ?', pid)),
    /Синтетическая заметка/,
  );
  expectOk(await p.patch(`/api/v1/me/diary/${saved.entry.id}`, { mood: 4 }));
  assert.equal(facts().find((f) => f.metric === 'mood').value, 4, 'правка сегодняшней записи обновляет факт');
  const second = expectOk(await p.post('/api/v1/me/diary', { mood: 5 }));
  assert.equal(facts().find((f) => f.metric === 'mood').value, 5, 'за день берётся последняя запись');
  expectOk(await p.del(`/api/v1/me/diary/${second.entry.id}`));
  assert.equal(facts().find((f) => f.metric === 'mood').value, 4, 'после удаления последней — предыдущая');
  expectOk(await p.del(`/api/v1/me/diary/${saved.entry.id}`));
  assert.equal(facts().length, 0, 'без записей за день фактов нет');
  assert.ok(
    ctx.app.query('SELECT 1 FROM analytics_subjects WHERE patient_id = ?', pid).length,
    'код субъекта остаётся',
  );
});

test('пациент получает толкование по общим фактам; специалист — своё; чужой специалист не видит', async () => {
  const pid = ctx.id('patA');
  const rows = [
    [2, 'bad', 'strong'],
    [2, 'bad', 'strong'],
    [3, 'ok', 'some'],
    [3, 'ok', 'some'],
    [4, 'good', 'none'],
    [4, 'good', 'none'],
    [5, 'good', 'none'],
    [4, 'good', 'none'],
  ];
  rows.forEach(([m, s, a], i) =>
    ctx.app.exec(
      `INSERT INTO mood_entries(patient_id,entry_date,mood,sleep,anxiety,created_at) VALUES (${pid},'${todayOf(rows.length - 1 - i)}',${m},'${s}','${a}','${new Date().toISOString()}')`,
    ),
  );
  const p = await ctx.as('patA');
  const mine = expectOk(await p.get('/api/v1/me/diary'));
  assert.equal(mine.today, todayOf());
  const keys = mine.analytics.observations.map((o) => o.key);
  assert.ok(keys.includes('trend') && keys.includes('sleep') && keys.includes('coverage'), keys.join());
  const doc = await ctx.as('psy1');
  const card = expectOk(await doc.get(`/api/v1/patients/${pid}?tab=diary`));
  assert.ok(card.analytics.lines.some((l) => /Динамика настроения/.test(l.text)));
  assert.ok(!JSON.stringify(card.analytics).includes('Попробуйте'), 'специалисту — числа, не советы');
  const other = await ctx.as('psy2');
  expectError(await other.get(`/api/v1/patients/${pid}?tab=diary`), 404, 'E-NOT-FOUND');
});

test('толкование: серия тревоги, недостаток данных и подавление с дополнением', () => {
  const mk = (list) => list.map(([day, mood, anx]) => ({ day, mood, anxiety_score: anx }));
  const f = interpret.analyse(
    mk([
      ['2026-10-19', 2, 2],
      ['2026-10-20', 2, 2],
      ['2026-10-21', 1, 2],
    ]),
    '2026-10-21',
  );
  assert.equal(f.anxietyStreak.length, 3);
  assert.equal(f.trend, null, 'мало записей — о динамике не говорим');
  const patient = interpret.forPatient(f);
  assert.equal(patient.flag.action, 'message_clinician');
  assert.match(patient.flag.text, /3 дня подряд/);
  const old = interpret.analyse(
    mk([
      ['2026-10-01', 2, 2],
      ['2026-10-02', 2, 2],
      ['2026-10-03', 2, 2],
    ]),
    '2026-10-21',
  );
  assert.equal(old.anxietyStreak, null, 'давняя серия не выводится как текущая');
  const cells = interpret.suppressCells(
    [
      { key: 'a', n: 3 },
      { key: 'b', n: 12 },
      { key: 'c', n: 20 },
    ],
    10,
  );
  assert.equal(
    cells.filter((c) => c.suppressed).length,
    2,
    'скрыта одна — скрывается ещё одна, вычитанием не восстановить',
  );
});

// Когорты на отдельной базе с настоящими миграциями: так видно, что читают представления и что скрывается.
function cohortDb(patients, consenting = patients) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-analytics-'));
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
  const ver = 1;
  for (let i = 0; i < patients; i += 1) {
    const id = 100 + i;
    db.prepare("INSERT INTO users(id,service_no,role,full_name) VALUES (?,?,'patient','Синтетика')").run(id, `П-${id}`);
    db.prepare('INSERT INTO care_assignments(patient_id,clinician_id) VALUES (?,1)').run(id);
    db.prepare(
      "INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method) VALUES (?,'base','given',?,'x','demo')",
    ).run(id, ver);
    if (i < consenting)
      db.prepare(
        "INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method) VALUES (?,'program','given',?,'x','demo')",
      ).run(id, ver);
    for (let d = 0; d < 6; d += 1)
      db.prepare(
        "INSERT INTO mood_entries(patient_id,entry_date,mood,sleep,anxiety,created_at) VALUES (?,?,?,?,?,'2026-10-21T00:00:00Z')",
      ).run(id, todayOf(d), 2 + (i % 4), 'ok', i % 5 === 0 ? 'strong' : 'none');
  }
  return {
    db,
    file,
    close: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
const range = { from: todayOf(30), to: todayOf(0), minGroup: 10 };

test('когорта специалиста: от 10 человек цифры видны с определением и знаменателем, меньше — скрыты', () => {
  const big = cohortDb(12);
  const small = cohortDb(9);
  try {
    const r = cohort.diaryReport(big.db, { scope: 'clinician', clinicianId: 1, ...range });
    assert.equal(r.suppressed, false);
    const active = r.rows.find((x) => x.key === 'diary_active_share');
    assert.equal(active.value, 100);
    assert.equal(active.denominator, 12);
    for (const row of r.rows) assert.ok(row.definition && 'denominator' in row && row.updated_at);
    assert.doesNotMatch(
      JSON.stringify(r),
      /"patient_id"|"subject_code"|П-1\d\d/,
      'ни идентификаторов, ни кодов субъектов',
    );
    const hidden = cohort.diaryReport(small.db, { scope: 'clinician', clinicianId: 1, ...range });
    assert.equal(hidden.suppressed, true);
    assert.ok(hidden.rows.every((x) => x.value === null && x.denominator === null));
    assert.ok(hidden.mood_bands.every((b) => b.n_patients === null));
    assert.equal(
      cohort.diaryReport(big.db, { scope: 'clinician', clinicianId: 999, ...range }).suppressed,
      true,
      'чужая когорта пуста',
    );
  } finally {
    big.close();
    small.close();
  }
});

test('программа поддержки: считаются только согласившиеся; отзыв согласия исключает сразу', () => {
  const t = cohortDb(14, 10);
  try {
    const rep = () => cohort.diaryReport(t.db, { scope: 'program', ...range });
    assert.equal(rep().rows[0].denominator, 10);
    t.db
      .prepare(
        "INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method) VALUES (100,'program','revoked',1,'x','demo')",
      )
      .run();
    assert.equal(rep().suppressed, true, 'после отзыва осталось 9 — всё скрыто');
    assert.equal(rep().members_suppressed, true);
  } finally {
    t.close();
  }
});

test('слой когорт читает только представления без идентификаторов, соединение — только чтение', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/modules/analytics/cohort.js'), 'utf8');
  assert.doesNotMatch(
    src.replace(/\/\/.*$/gm, ''),
    /patient_id|mood_entries|FROM users|analytics_facts|analytics_subjects/,
  );
  assert.match(src, /readonly: true/);
  const t = cohortDb(1);
  try {
    assert.throws(() => cohort.readOnly(t.db).prepare('DELETE FROM analytics_facts').run(), /readonly/i);
  } finally {
    t.close();
  }
});

test('API: специалист — когорта и проверка периода; администратор — цифры программы; пациент закрыт', async () => {
  const doc = await ctx.as('psy1');
  const r = expectOk(await doc.get('/api/v1/analytics/my-patients?by=diary'));
  assert.equal(r.suppressed, true, 'в синтетическом мире групп по 10 нет');
  expectError(await doc.get('/api/v1/analytics/my-patients?from=2023-01-01&to=2026-12-31'), 422, 'E-VALIDATION');
  const admin = await ctx.as('admin1');
  const m = expectOk(await admin.get('/api/v1/admin/metrics?by=diary'));
  assert.equal(m.scope, 'program');
  assert.doesNotMatch(JSON.stringify(m), /patient_id|Марина|Тестова/);
  expectError(await (await ctx.as('patA')).get('/api/v1/analytics/my-patients'), 403, 'E-ACCESS');
});

test('weekly mood suppression counts actual mood contributors, independent of active diary patients', () => {
  const t = cohortDb(12);
  try {
    t.db.prepare('UPDATE mood_entries SET mood=NULL WHERE patient_id<>100').run();
    const r = cohort.diaryReport(t.db, { scope: 'clinician', clinicianId: 1, ...range });
    assert.ok(r.weekly.length > 0);
    assert.ok(r.weekly.every((w) => w.mood_mean === null && w.suppressed));
    const mood = r.rows.find((r) => r.key === 'mood_mean');
    assert.equal(mood.numerator, null);
    assert.equal(mood.observation_denominator, null);
  } finally {
    t.close();
  }
});
test('fourteen inclusive complete diary days mean exactly seven days per week with explicit observation denominator', () => {
  const t = cohortDb(12);
  try {
    t.db.prepare('DELETE FROM mood_entries').run();
    const insert = t.db.prepare("INSERT INTO mood_entries(patient_id,entry_date,mood,anxiety) VALUES (?,?,4,'strong')");
    for (let id = 100; id < 112; id += 1)
      for (let day = 0; day < 14; day += 1)
        insert.run(id, new Date(Date.UTC(2026, 9, 1) + day * 86400000).toISOString().slice(0, 10));
    const r = cohort.diaryReport(t.db, {
      scope: 'clinician',
      clinicianId: 1,
      from: '2026-10-01',
      to: '2026-10-14',
      minGroup: 10,
    });
    const days = r.rows.find((r) => r.key === 'diary_days_per_week');
    assert.equal(days.value, 7);
    assert.equal(days.numerator, 168);
    assert.equal(days.observation_denominator, 24);
    const anxiety = r.rows.find((r) => r.key === 'anxiety_strong_share');
    assert.equal(anxiety.value, 100);
    assert.equal(anxiety.numerator, 168);
    assert.equal(anxiety.observation_denominator, 168);
  } finally {
    t.close();
  }
});
