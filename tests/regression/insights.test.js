'use strict';
// Аналитика «диагноз → … → цена»: расчёты на синтетике, подавление малых групп, права и отсутствие идентификаторов.
// Источник: AGENTS.md (приватность), BUILD_RULES §4, миграция 0027, src/modules/insights.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const report = require('../../src/modules/insights/report');
const { loadInsights } = require('../../src/modules/insights/data');
const { narrate } = require('../../src/modules/insights/story');

const ctx = useApp();
const day = (offset = 0) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
const range = { from: day(120), to: day(0) };
const DIAG = [
  { code: 'F41.2', label: 'Смешанное' },
  { code: 'F32', label: 'Депрессивный' },
];

// ---- чистые расчёты
test('Каплан–Мейер: цензура не завышает медиану, доли к сроку считаются по оценке', () => {
  const km = report.kaplanMeier([
    { t: 10, event: true },
    { t: 20, event: true },
    { t: 30, event: false },
    { t: 40, event: true },
    { t: 50, event: false },
  ]);
  // S(10)=0.8, S(20)=0.6, S(40)=0.6*(1-1/2)=0.3 → медиана 40
  assert.equal(km.median, 40);
  assert.equal(Math.round(km.improvedBy(10) * 100), 20);
  assert.equal(Math.round(km.improvedBy(25) * 100), 40);
  assert.equal(report.kaplanMeier([{ t: 5, event: false }]).median, null);
});

test('улучшение по тесту: не ниже порога исходного, половина балла, учёт того же дня', () => {
  const t = (d, s) => ({ day: d, score: s });
  assert.deepEqual(report.testOutcome([t('2026-01-01', 16), t('2026-01-15', 12), t('2026-02-01', 8)], 10), {
    t: 31,
    event: true,
    first: 16,
    last: 8,
  });
  assert.equal(report.testOutcome([t('2026-01-01', 6), t('2026-01-15', 2)], 10), null, 'исходный балл ниже порога');
  assert.equal(report.testOutcome([t('2026-01-01', 16)], 10), null, 'нет повторного измерения');
  const none = report.testOutcome([t('2026-01-01', 16), t('2026-01-20', 14)], 10);
  assert.equal(none.event, false);
  assert.equal(none.t, 19, 'без улучшения наблюдение оборвано на последнем измерении');
});

test('приверженность: отметки против запланированных приёмов; пустые отметки — «неизвестно», не ноль', () => {
  const to = '2026-10-28';
  const items = [{ item_key: 'inn:1', status: 'active', start_date: '2026-09-01', end_date: null, slots_per_day: 1 }];
  const marks = (n) =>
    Array.from({ length: n }, (_, i) => ({
      item_key: 'inn:1',
      day: new Date(Date.UTC(2026, 9, 28) - i * 86400000).toISOString().slice(0, 10),
      slot: 'morning',
      status: 'taken',
    }));
  assert.equal(report.adherenceOf(items, marks(28), to).category, 'regular');
  assert.equal(report.adherenceOf(items, marks(14), to).category, 'partial');
  assert.equal(report.adherenceOf(items, marks(5), to).category, 'rare');
  const unknown = report.adherenceOf(items, [], to);
  assert.equal(unknown.category, 'no_marks');
  assert.equal(unknown.ratio, 0);
  assert.equal(report.adherenceOf([], [], to).category, 'not_active');
  // повторная отметка того же слота не увеличивает приём сверх плана
  const dup = [...marks(3), ...marks(3)];
  assert.equal(report.adherenceOf(items, dup, to).taken, 3);
});

function synthetic(n, o = {}) {
  const data = {
    members: [],
    patients: [],
    links: [],
    interests: [],
    plan: [],
    purchases: [],
    marks: [],
    tests: [],
    mood: [],
    adverse: [],
  };
  for (let i = 0; i < n; i += 1) {
    const code = `s${i}`;
    data.members.push({ subject_code: code });
    data.patients.push({
      subject_code: code,
      dx_code: i % 4 === 0 ? 'F32' : 'F41.2',
      enrolled_day: day(10 + (i % 5) * 20),
    });
    data.links.push({
      subject_code: code,
      clinician_code: `c${i % 5}`,
      role: 'psychiatrist',
      specialty: 'psychiatrist',
      org_id: o.org ?? 1,
      org_name: 'Орг',
      org_kind: 'polyclinic',
      region: 'Москва',
      profile_consent: o.consent ?? 1,
    });
    data.plan.push({
      subject_code: code,
      item_key: 'inn:1',
      inn_id: 1,
      inn_name: 'сертралин',
      drug_group: 'antidepressant',
      start_date: day(60),
      end_date: i % 2 ? day(-30) : null,
      status: 'active',
      duration_days: i % 2 ? 90 : null,
      slots_per_day: 1,
    });
    data.tests.push({ subject_code: code, day: day(60), instrument: 'gad7', version: 1, mode: 'online', score: 16 });
    data.tests.push({
      subject_code: code,
      day: day(30),
      instrument: 'gad7',
      version: 1,
      mode: 'online',
      score: i % 2 ? 6 : 14,
    });
  }
  data.adverse.push({
    subject_code: 's1',
    report_ref: 1,
    day: day(5),
    complaint: 'nausea',
    severity: 'mild',
    inn_id: 1,
    inn_name: 'сертралин',
  });
  data.interests.push(
    ...['c0', 'c1', 'c2'].map((c) => ({
      clinician_code: c,
      kind: 'journal',
      title: 'Журнал А',
      title_norm: 'журнал а',
    })),
  );
  return data;
}
const admin = (data, extra = {}) =>
  narrate(
    report.buildReport(data, { audience: 'admin', dx: 'all', minGroup: 10, diagnoses: DIAG, ...range, ...extra }),
  );

test('расчёт на синтетике: число пациентов, доли, срок, улучшение и приём', () => {
  const r = admin(synthetic(40));
  const s = Object.fromEntries(r.sections.map((x) => [x.key, x]));
  assert.equal(r.n_patients, 40);
  assert.equal(s.prescribed.share_with_plan, 100);
  assert.equal(s.prescribed.by_inn[0].n_patients, 40);
  assert.equal(s.prescribed.duration.find((d) => d.key === 'to90').n, 20);
  assert.equal(s.prescribed.duration.find((d) => d.key === 'none').n, 20);
  assert.equal(s.prescribed.duration_median_days, 90);
  const m = s.outcomes.measures[0];
  assert.equal(m.n_patients, 40);
  assert.equal(m.share_improved, 50, '16→6 вдвое ниже, 16→14 нет');
  assert.equal(r.diagnosis.options.find((d) => d.code === 'F32').n_patients, 10);
  assert.ok(r.summary.length >= 3 && r.summary.length <= 5);
  const f = admin(synthetic(40), { dx: 'F32' });
  assert.equal(f.n_patients, 10, 'диагноз — фильтр');
});

test('малые группы скрыты: меньше порога нет ни чисел, ни выводов, ни скрытого в заголовке', () => {
  const r = admin(synthetic(9));
  assert.equal(r.n_patients, null);
  for (const sec of r.sections) {
    assert.equal(sec.status, 'hidden', sec.key);
    assert.match(sec.headline, /недостаточно|слишком|нет сообщений/i, sec.key);
  }
  assert.equal(r.summary.length, 0);
  assert.doesNotMatch(JSON.stringify(r), /"n_patients":[1-9]\b(?!\d)/, 'ни одной ячейки с малым числом');
});

test('профиль без согласия: место работы и журналы не показываются; меньше 3 специалистов — скрыто', () => {
  const noConsent = admin(synthetic(40, { consent: 0 }));
  const c = noConsent.sections.find((x) => x.key === 'clinicians');
  assert.equal(c.org_kinds.length, 0);
  assert.equal(c.regions.length, 0);
  assert.equal(c.organizations.length, 0);
  assert.ok(c.specialties[0].n_patients, 'специальность по роли остаётся');
  const few = synthetic(40);
  few.links.forEach((l, i) => {
    l.clinician_code = i < 20 ? 'c0' : 'c1';
  });
  const r = admin(few);
  const c2 = r.sections.find((x) => x.key === 'clinicians');
  assert.ok(
    c2.specialties.every((s) => s.suppressed),
    'два специалиста — меньше порога 3',
  );
  const interests = synthetic(40);
  interests.interests = interests.interests.slice(0, 2);
  assert.equal(admin(interests).sections.find((x) => x.key === 'doctors').journals.length, 0);
});

test('дополняющее подавление: скрыта одна ячейка — скрывается и вторая; пустая ячейка ничего не скрывает', () => {
  const d = synthetic(39);
  d.patients.forEach((p, i) => {
    p.dx_code = i < 11 ? 'F32' : i < 36 ? 'F41.2' : 'F41.1';
  });
  const diag = [...DIAG, { code: 'F41.1', label: 'ГТР' }];
  const r = admin(d, { diagnoses: diag });
  const hidden = r.diagnosis.options
    .filter((o) => o.suppressed)
    .map((o) => o.code)
    .sort();
  assert.deepEqual(
    hidden,
    ['F32', 'F41.1'],
    'скрыта малая ячейка (3) и наименьшая из оставшихся (11): вычитанием не восстановить',
  );
  const noSmall = admin(synthetic(40)); // F32=10, F41.2=30, пустой «не указан»
  assert.ok(
    noSmall.diagnosis.options.every((o) => !o.suppressed),
    'пустая ячейка не вызывает скрытия соседей',
  );
});

test('врач: свои цифры без порога, психолог не получает лекарства и побочные', () => {
  const data = synthetic(5);
  const psy = report.buildReport(data, {
    audience: 'psychiatrist',
    dx: 'all',
    diagnoses: DIAG,
    ...range,
    withSubjects: true,
  });
  assert.equal(psy.n_patients, 5);
  assert.deepEqual(
    psy.sections.map((s) => s.key),
    ['who', 'prescribed', 'reality', 'outcomes', 'cost'],
    'о других специалистах врач не видит ничего',
  );
  const plg = report.buildReport(data, { audience: 'psychologist', dx: 'all', diagnoses: DIAG, ...range });
  assert.deepEqual(
    plg.sections.map((s) => s.key),
    ['who', 'outcomes'],
  );
  assert.ok(psy.per_subject.length === 5 && psy.sections[0].low_n === true);
});

// ---- слой данных на отдельной базе с настоящими миграциями
function insightsDb(patients, { program = patients, doctors = 4, consent = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-insights-'));
  const file = path.join(dir, 'a.sqlite3');
  execFileSync('node', [path.join(__dirname, '../../scripts/migrate.js')], {
    env: { ...process.env, DB_PATH: file },
    stdio: 'pipe',
  });
  const db = new Database(file);
  db.pragma('foreign_keys = OFF');
  const user = db.prepare('INSERT INTO users(id,service_no,role,email,full_name) VALUES (?,?,?,?,?)');
  db.prepare(
    "INSERT INTO organizations(id,name,name_norm,kind,region) VALUES (1,'Секретная клиника','секретная клиника','private','Секретный регион')",
  ).run();
  db.prepare(
    "INSERT INTO content_versions(id,kind,version,body_md,body_sha256,sign_method,status,is_stand_in) VALUES (1,'consent.base',1,'x','x','demo','published',1)",
  ).run();
  for (let d = 0; d < doctors; d += 1) {
    user.run(1 + d, `Т-${d}`, 'psychiatrist', `d${d}@x.test`, `Имя Врача ${d}`);
    db.prepare(
      'INSERT INTO clinician_profiles(user_id,specialty,organization_id,analytics_consent) VALUES (?,?,1,?)',
    ).run(1 + d, 'psychiatrist', consent);
    db.prepare(
      "INSERT INTO clinician_interests(user_id,kind,title,title_norm) VALUES (?,'journal','Журнал Икс','журнал икс')",
    ).run(1 + d);
  }
  const ep = db.prepare("INSERT INTO care_episodes(patient_id,started_at) VALUES (?,'2026-06-01T00:00:00Z')");
  for (let i = 0; i < patients; i += 1) {
    const id = 100 + i;
    user.run(id, `П-${id}`, 'patient', null, 'Конфиденциальное Имя');
    db.prepare('INSERT INTO care_assignments(patient_id,clinician_id,started_at) VALUES (?,?,?)').run(
      id,
      1 + (i % doctors),
      '2026-06-01T00:00:00Z',
    );
    ep.run(id);
    db.prepare(
      "INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method) VALUES (?,'base','given',1,'x','demo')",
    ).run(id);
    if (i < program)
      db.prepare(
        "INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method) VALUES (?,'program','given',1,'x','demo')",
      ).run(id);
    db.prepare("INSERT INTO patient_diagnoses(patient_id,code,set_by) VALUES (?,'F41.2',1)").run(id);
    db.prepare(
      "INSERT INTO adverse_events(patient_id,complaint_codes_json,severity,status,psychiatrist_id,description_enc,created_at) VALUES (?,?,'mild','awaiting_doctor',?,'СЕКРЕТНЫЙ ТЕКСТ',?)",
    ).run(id, '["nausea"]', 1 + (i % doctors), `${day(5)}T00:00:00Z`);
  }
  return {
    db,
    close: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
const load = (t, p) => loadInsights(t.db, { now: new Date().toISOString(), ...range, ...p });

test('программа: только согласившиеся, без идентификаторов и текстов в выдаче', () => {
  const t = insightsDb(14, { program: 12, doctors: 4 });
  try {
    const data = load(t, { scope: 'program' });
    assert.equal(data.members.length, 12);
    const r = admin(data, { dx: 'F41.2' });
    assert.equal(r.n_patients, 12);
    const json = JSON.stringify(r);
    assert.doesNotMatch(
      json,
      /patient_id|subject_code|П-1\d\d|Конфиденциальное Имя|Имя Врача|СЕКРЕТНЫЙ ТЕКСТ|@x\.test/,
    );
    assert.equal(r.sections.find((s) => s.key === 'cost').n_reporters, 12);
    // отзыв согласия на программу: осталось 9 — всё скрыто
    t.db
      .prepare(
        "INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method) VALUES (100,'program','revoked',1,'x','demo')",
      )
      .run();
    t.db
      .prepare(
        "INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method) VALUES (101,'program','revoked',1,'x','demo')",
      )
      .run();
    t.db
      .prepare(
        "INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method) VALUES (102,'program','revoked',1,'x','demo')",
      )
      .run();
    const after = admin(load(t, { scope: 'program' }), { dx: 'F41.2' });
    assert.equal(after.n_patients, null);
    assert.ok(after.sections.every((s) => s.status === 'hidden'));
  } finally {
    t.close();
  }
});

test('организация: видна только при согласии специалиста; журнал — при ≥3 специалистах', () => {
  const t = insightsDb(20, { doctors: 4 });
  try {
    const on = admin(load(t, { scope: 'program' }), { dx: 'F41.2' });
    assert.equal(on.sections.find((s) => s.key === 'clinicians').organizations[0]?.label, 'Секретная клиника');
    assert.equal(on.sections.find((s) => s.key === 'doctors').journals[0]?.title, 'Журнал Икс');
    t.db.prepare('UPDATE clinician_profiles SET analytics_consent=0').run();
    const off = admin(load(t, { scope: 'program' }), { dx: 'F41.2' });
    assert.doesNotMatch(JSON.stringify(off), /Секретная клиника|Секретный регион|Журнал Икс/);
  } finally {
    t.close();
  }
});

test('специалист видит только своих: сообщения о побочных — только свои как получатель', () => {
  const t = insightsDb(20, { doctors: 4 });
  try {
    const mine = load(t, { scope: 'current', clinicianId: 1 });
    assert.equal(mine.members.length, 5);
    assert.ok(mine.adverse.every((a) => a.clinician_id === 1));
    assert.equal(mine.links.length, 0);
    assert.equal(mine.interests.length, 0, 'о коллегах ничего');
    const other = load(t, { scope: 'current', clinicianId: 999 });
    assert.equal(other.members.length, 0);
    // чужое закрепление завершено — пациент выходит из списка сразу
    t.db
      .prepare(
        "UPDATE care_assignments SET ended_at='2026-07-01T00:00:00Z', end_reason='reassign' WHERE patient_id=100",
      )
      .run();
    assert.equal(load(t, { scope: 'current', clinicianId: 1 }).members.length, 4);
    // показ отложен: сообщение пока не видно врачу
    t.db.prepare("UPDATE adverse_events SET visible_from='2999-01-01T00:00:00Z' WHERE patient_id=104").run();
    assert.equal(
      load(t, { scope: 'current', clinicianId: 1 }).adverse.some((a) => a.subject_code && false),
      false,
    );
    const n = load(t, { scope: 'current', clinicianId: 1 }).adverse.length;
    assert.equal(n, 3);
  } finally {
    t.close();
  }
});

test('слой данных читает только представления, соединение — только чтение', () => {
  const src = fs
    .readFileSync(path.join(__dirname, '../../src/modules/insights/data.js'), 'utf8')
    .replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(
    src,
    /\b(patient_id|mood_entries|users|analytics_facts|analytics_subjects|purchase_marks|adverse_events|plan_items|med_log)\b/,
  );
  assert.match(src, /readOnly/);
  const rep = fs
    .readFileSync(path.join(__dirname, '../../src/modules/insights/report.js'), 'utf8')
    .replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(rep, /patient_id|require\('better-sqlite3'\)/);
});

// ---- API
test('API: администратор получает отчёт без идентификаторов, остальные роли закрыты', async () => {
  const a = await ctx.as('admin1');
  const r = expectOk(await a.get('/api/v1/admin/insights?dx=all'));
  assert.equal(r.scope, 'program');
  assert.equal(r.preliminary, true);
  assert.doesNotMatch(JSON.stringify(r), /patient_id|subject_code|Марина|Тестова|Синтетикова|pat\.a@/);
  expectError(await a.get('/api/v1/admin/insights?dx=Z99'), 422, 'E-VALIDATION');
  expectError(await a.get('/api/v1/admin/insights?from=2020-01-01&to=2026-12-31'), 422, 'E-VALIDATION');
  expectError(await (await ctx.as('psy1')).get('/api/v1/admin/insights'), 403, 'E-ACCESS');
  expectError(await (await ctx.as('patA')).get('/api/v1/admin/insights'), 403, 'E-ACCESS');
  expectError(await (await ctx.as('patA')).get('/api/v1/analytics/my-insights'), 403, 'E-ACCESS');
  expectError(await a.get('/api/v1/analytics/my-insights'), 403, 'E-ACCESS');
});

test('API: CSV только из показанного, с отметкой в журнале выгрузок', async () => {
  const a = await ctx.as('admin1');
  const before = ctx.app.query("SELECT COUNT(*) n FROM export_log WHERE kind='program'")[0].n;
  const res = await a.get('/api/v1/admin/insights/export?dx=all');
  assert.equal(res.status, 200);
  const text = typeof res.body === 'string' ? res.body : res.text || JSON.stringify(res.body);
  assert.match(String(text), /Предварительные данные/);
  assert.doesNotMatch(String(text), /patient_id|Марина/);
  assert.equal(ctx.app.query("SELECT COUNT(*) n FROM export_log WHERE kind='program'")[0].n, before + 1);
});

test('API: специалист видит только своих пациентов; диагноз — только у своих; психолог не ставит', async () => {
  const doc = await ctx.as('psy1');
  const mine = ctx.app
    .query('SELECT patient_id FROM care_assignments WHERE clinician_id=? AND ended_at IS NULL', ctx.id('psy1'))
    .map((r) => r.patient_id);
  const r = expectOk(await doc.get('/api/v1/analytics/my-insights'));
  assert.equal(r.scope, 'own');
  assert.ok(r.patients.every((p) => mine.includes(p.id)));
  assert.ok(!r.patients.some((p) => p.id === ctx.id('patB')), 'пациент другого врача не виден');
  assert.doesNotMatch(JSON.stringify(r), /Олег Пробный|subject_code|patient_id/);
  assert.ok(!r.sections.some((s) => ['clinicians', 'doctors'].includes(s.key)));

  const put = (c, id, code) => c.put(`/api/v1/patients/${id}/diagnosis`, { code });
  const set = expectOk(await put(doc, ctx.id('patA'), 'F41.2'));
  assert.equal(set.current.code, 'F41.2');
  expectError(await put(doc, ctx.id('patA'), 'Z99'), 422, 'E-VALIDATION');
  expectError(await put(await ctx.as('psy2'), ctx.id('patA'), 'F32'), 404, 'E-NOT-FOUND');
  expectError(await put(await ctx.as('plg1'), ctx.id('patA'), 'F32'), 403, 'E-ACCESS');
  expectOk(await (await ctx.as('plg1')).get(`/api/v1/patients/${ctx.id('patA')}/diagnosis`));
  expectError(await (await ctx.as('psy2')).get(`/api/v1/patients/${ctx.id('patA')}/diagnosis`), 404, 'E-NOT-FOUND');
  // смена диагноза сохраняет историю, текущий один
  expectOk(await put(doc, ctx.id('patA'), 'F32'));
  const rows = ctx.app.query(
    'SELECT code, ended_at FROM patient_diagnoses WHERE patient_id=? ORDER BY id',
    ctx.id('patA'),
  );
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((x) => !x.ended_at).length, 1);
  expectOk(await put(doc, ctx.id('patA'), null));
  assert.equal(
    ctx.app.query('SELECT 1 FROM patient_diagnoses WHERE patient_id=? AND ended_at IS NULL', ctx.id('patA')).length,
    0,
  );

  const plg = expectOk(await (await ctx.as('plg1')).get('/api/v1/analytics/my-insights'));
  assert.deepEqual(
    plg.sections.map((s) => s.key),
    ['who', 'outcomes'],
    'психолог без лекарств и побочных',
  );
});

test('API: профиль специалиста — проверка полей, согласие, отзыв убирает из представлений', async () => {
  const doc = await ctx.as('psy2');
  const body = {
    specialty: 'neurologist',
    organization: { name: 'Поликлиника Тест', kind: 'polyclinic', region: 'Москва', city: 'Москва' },
    analytics_consent: true,
    journals: ['Журнал Один', 'журнал один', 'Журнал Два'],
    conferences: [{ title: 'Конференция А', year: 2025 }, 'Конференция Б'],
  };
  const saved = expectOk(await doc.put('/api/v1/me/clinician-profile', body));
  assert.equal(saved.specialty, 'neurologist');
  assert.equal(saved.journals.length, 2, 'дубликаты по названию объединяются');
  assert.equal(saved.conferences.length, 2);
  assert.equal(ctx.app.query('SELECT COUNT(*) n FROM insights_clinician_interests')[0].n, 4);
  expectError(await doc.put('/api/v1/me/clinician-profile', { ...body, specialty: 'wizard' }), 422, 'E-VALIDATION');
  expectError(
    await doc.put('/api/v1/me/clinician-profile', {
      ...body,
      organization: { name: 'А', kind: 'polyclinic', region: 'М' },
    }),
    422,
    'E-VALIDATION',
  );
  expectOk(await doc.put('/api/v1/me/clinician-profile', { ...body, analytics_consent: false }));
  assert.equal(
    ctx.app.query('SELECT COUNT(*) n FROM insights_clinician_interests')[0].n,
    0,
    'без согласия журналы не попадают в аналитику',
  );
  const link = ctx.app.query(
    "SELECT org_name, specialty FROM insights_patient_clinicians WHERE role='psychiatrist' AND clinician_code=(SELECT subject_code FROM analytics_subjects WHERE patient_id=?) LIMIT 1",
    ctx.id('psy2'),
  )[0];
  assert.equal(link.org_name, null);
  assert.equal(link.specialty, 'neurologist');
  expectError(await (await ctx.as('patA')).get('/api/v1/me/clinician-profile'), 403, 'E-ACCESS');
  expectError(await (await ctx.as('admin1')).get('/api/v1/me/clinician-profile'), 403, 'E-ACCESS');
});
