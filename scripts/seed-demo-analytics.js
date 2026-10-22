#!/usr/bin/env node
'use strict';

/**
 * Демо-данные для аналитики «диагноз → кто ведёт → что назначают → что происходит → что получается → цена».
 * Только синтетика (PD-24): вымышленные организации, «пациент N», почта example.test, ни одного реального человека.
 * Пишет прямо в базу (сервер можно не останавливать), требует применённой миграции 0027:
 *   DB_PATH=… LOG_HMAC_KEY=… node scripts/seed-demo-analytics.js
 * Повторный запуск безопасен: если организации уже созданы, ничего не добавляется.
 * Запускается после seed-demo*.js (нужны справочник МНН, торговые наименования и версия GAD-7).
 */

const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { PASSWORD, insert, hmacHex } = require('../tests/fixtures/world');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tdr.sqlite3');
const LOG_KEY = process.env.LOG_HMAC_KEY || 'synthetic-test-key';

let seed = 20261022;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (list) => list[Math.floor(rnd() * list.length)];
const weighted = (pairs) => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let x = rnd() * total;
  for (const [v, w] of pairs) {
    x -= w;
    if (x <= 0) return v;
  }
  return pairs[pairs.length - 1][0];
};
const DAY = 86400000;
const day = (offset) => new Date(Date.now() - offset * DAY).toISOString().slice(0, 10);
const iso = (offset, hour = 9) => `${day(offset)}T${String(hour).padStart(2, '0')}:00:00Z`;

const ORGS = [
  ['Городская поликлиника № 1 (демо)', 'polyclinic', 'Москва'],
  ['Клиническая больница № 2 (демо)', 'hospital', 'Москва'],
  ['Центр «Ясный день» (демо)', 'private', 'Санкт-Петербург'],
  ['Психоневрологический диспансер № 3 (демо)', 'dispensary', 'Санкт-Петербург'],
  ['Городская поликлиника № 7 (демо)', 'polyclinic', 'Свердловская область'],
  ['Областная клиническая больница (демо)', 'hospital', 'Свердловская область'],
  ['Клиника «Равновесие» (демо)', 'private', 'Республика Татарстан'],
  ['Городская поликлиника № 12 (демо)', 'polyclinic', 'Республика Татарстан'],
  ['Медицинский центр «Северный» (демо)', 'private', 'Новосибирская область'],
];
const JOURNALS = [
  ['Журнал неврологии и психиатрии им. С.С. Корсакова', 9],
  ['Социальная и клиническая психиатрия', 7],
  ['Психиатрия и психофармакотерапия', 7],
  ['Consilium Medicum', 5],
  ['Неврология, нейропсихиатрия, психосоматика', 4],
  ['Обозрение психиатрии и медицинской психологии им. В.М. Бехтерева', 4],
  ['Независимый психиатрический журнал', 3],
  ['Терапевтический архив', 2],
];
const CONFERENCES = [
  ['Конгресс Российского общества психиатров', 8],
  ['Школа психофармакотерапии (демо)', 4],
  ['Межрегиональная конференция по тревожным расстройствам (демо)', 3],
  ['Научно-практическая конференция «Психическое здоровье» (демо)', 3],
];
const DX = [
  ['F41.2', 56],
  ['F41.1', 12],
  ['F32', 11],
  ['F43.2', 8],
  ['F41.0', 5],
  [null, 8],
];
const DRUGS = [
  [1, 24],
  [2, 22],
  [4, 8],
  [3, 7],
  [7, 9],
  [9, 8],
  [10, 6],
  [12, 5],
  [11, 4],
  [17, 7],
];
const COMPLAINTS = [
  ['nausea', 34],
  ['sleepy', 16],
  ['insomnia', 15],
  ['headache', 14],
  ['dizzy', 10],
  ['anxiety', 7],
  ['other', 4],
];

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
if (!db.prepare("SELECT name FROM sqlite_master WHERE name='clinician_profiles'").get()) {
  console.error('нет таблиц аналитики: сначала применить миграцию 0027 (node scripts/migrate.js)');
  process.exit(2);
}
if (db.prepare("SELECT 1 FROM organizations WHERE name LIKE '%(демо)'").get()) {
  console.log('seed-demo-analytics: уже выполнено, пропускаю');
  process.exit(0);
}

const hash = bcrypt.hashSync(PASSWORD, 4);
const consentVersion = (kind) => {
  const row = db
    .prepare("SELECT id FROM content_versions WHERE kind=? AND status='published' ORDER BY version DESC LIMIT 1")
    .get(`consent.${kind}`);
  if (row) return row.id;
  const body = `STAND-IN: согласие ${kind}`;
  const digest = require('crypto').createHash('sha256').update(body).digest('hex');
  return insert(db, 'content_versions', {
    kind: `consent.${kind}`,
    version: 1,
    body_md: body,
    body_sha256: digest,
    sign_method: 'demo_click',
    status: 'published',
    is_stand_in: 1,
    published_at: iso(240),
  });
};
const sha = (kind) =>
  db.prepare('SELECT body_sha256 FROM content_versions WHERE id=?').get(consentVersion(kind)).body_sha256;
const gadVersion = db
  .prepare(
    "SELECT version FROM instrument_versions WHERE instrument_code='gad7' AND status='published' ORDER BY version DESC",
  )
  .get();
if (!gadVersion) throw new Error('нет опубликованной версии GAD-7');
const products = new Map();
for (const inn of [...DRUGS.map((d) => d[0]), 20, 21])
  products.set(
    inn,
    db
      .prepare(
        "SELECT id FROM drug_products WHERE inn_id=? AND status NOT IN ('rejected','merged','withdrawn') ORDER BY id LIMIT 3",
      )
      .all(inn)
      .map((r) => r.id),
  );

const stats = { orgs: 0, doctors: 0, patients: 0, plans: 0, marks: 0, tests: 0, mood: 0, ae: 0, purchases: 0 };

const run = db.transaction(() => {
  const orgIds = ORGS.map(([name, kind, region]) => {
    stats.orgs += 1;
    return insert(db, 'organizations', {
      name,
      name_norm: name.toLowerCase().replace(/ё/g, 'е'),
      kind,
      region,
      created_at: iso(200),
    });
  });

  // ---- специалисты: роль в сервисе psychiatrist/psychologist, специальность — в профиле
  const doctorSpec = [
    ...Array(15).fill(['psychiatrist', 'psychiatrist']),
    ...Array(6).fill(['psychiatrist', 'psychotherapist']),
    ...Array(3).fill(['psychiatrist', 'neurologist']),
    ...Array(3).fill(['psychiatrist', 'somatic']),
    ...Array(9).fill(['psychologist', 'clinical_psychologist']),
  ];
  const doctors = [];
  doctorSpec.forEach(([role, specialty], i) => {
    const email = `doc.a${String(i + 1).padStart(2, '0')}@cc.example.test`;
    const id = insert(db, 'users', {
      service_no: `Д-А${String(i + 1).padStart(3, '0')}`,
      email,
      email_hmac: hmacHex(LOG_KEY, email),
      password_hash: hash,
      role,
      full_name: `Специалист Демо ${i + 1}`,
      status: 'active',
      is_demo: 1,
      created_at: iso(240),
      password_changed_at: iso(30),
    });
    insert(db, 'user_prefs', { user_id: id, onboarding_done_at: iso(200) });
    const org = orgIds[i % orgIds.length];
    const consent = rnd() < 0.82 ? 1 : 0;
    insert(db, 'clinician_profiles', {
      user_id: id,
      specialty,
      organization_id: org,
      analytics_consent: consent,
      consent_at: consent ? iso(60) : null,
      updated_at: iso(60),
    });
    const js = new Set();
    for (let k = between(1, 4); k > 0; k -= 1) js.add(weighted(JOURNALS));
    for (const title of js)
      insert(db, 'clinician_interests', {
        user_id: id,
        kind: 'journal',
        title,
        title_norm: title
          .toLowerCase()
          .replace(/ё/g, 'е')
          .replace(/[.,«»]/g, ''),
        created_at: iso(60),
      });
    const cs = new Set();
    for (let k = between(0, 2); k > 0; k -= 1) cs.add(weighted(CONFERENCES));
    for (const title of cs)
      insert(db, 'clinician_interests', {
        user_id: id,
        kind: 'conference',
        title,
        title_norm: title
          .toLowerCase()
          .replace(/ё/g, 'е')
          .replace(/[.,«»]/g, ''),
        year: pick([2024, 2025, 2026]),
        created_at: iso(60),
      });
    doctors.push({ id, role, specialty });
    stats.doctors += 1;
  });
  // Уже существующие демо-специалисты тоже получают профиль (если его нет).
  db.prepare(
    "SELECT id,role FROM users WHERE role IN ('psychiatrist','psychologist') AND id NOT IN (SELECT user_id FROM clinician_profiles)",
  )
    .all()
    .forEach((u, i) => {
      insert(db, 'clinician_profiles', {
        user_id: u.id,
        specialty: u.role === 'psychiatrist' ? 'psychiatrist' : 'clinical_psychologist',
        organization_id: orgIds[i % orgIds.length],
        analytics_consent: 1,
        consent_at: iso(30),
        updated_at: iso(30),
      });
    });

  const psychiatrists = doctors.filter((d) => d.role === 'psychiatrist');
  const psychologists = doctors.filter((d) => d.role === 'psychologist');
  const admin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get().id;

  const lead = (role, email) =>
    db.prepare("SELECT id,role FROM users WHERE role=? AND status='active' AND email=?").get(role, email) ||
    db
      .prepare("SELECT id,role FROM users WHERE role=? AND status='active' AND email LIKE 'demo.%' ORDER BY id LIMIT 1")
      .get(role);
  const leadPsy = lead('psychiatrist', 'journey.psychiatrist@demo.example.test');
  const leadPlg = lead('psychologist', 'journey.psychologist@demo.example.test');

  // ---- пациенты
  const N = 300;
  for (let i = 0; i < N; i += 1) {
    const email = `pat.a${String(i + 1).padStart(3, '0')}@cc.example.test`;
    const pid = insert(db, 'users', {
      service_no: `П-А${String(i + 1).padStart(4, '0')}`,
      email,
      email_hmac: hmacHex(LOG_KEY, email),
      password_hash: hash,
      role: 'patient',
      full_name: `Пациент Демо ${i + 1}`,
      age_band: pick(['18-24', '25-34', '35-44', '45-54', '55-64']),
      sex: pick(['f', 'f', 'm']),
      status: 'active',
      is_demo: 1,
      created_at: iso(240),
      password_changed_at: iso(30),
    });
    insert(db, 'user_prefs', { user_id: pid, onboarding_done_at: iso(200) });
    const startOffset = between(14, 190); // сколько дней назад началось наблюдение
    const consentGiven = [['base', startOffset + 1]];
    if (rnd() < 0.9) consentGiven.push(['program', startOffset + 1]);
    for (const [kind, off] of consentGiven)
      insert(db, 'consent_events', {
        user_id: pid,
        consent_kind: kind,
        action: 'given',
        content_version_id: consentVersion(kind),
        text_sha256: sha(kind),
        sign_method: 'demo_click',
        created_at: iso(off),
      });

    // Первые пациенты закрепляются за ведущими демо-специалистами, чтобы их кабинет тоже был живым.
    const medicated = i < 44 || rnd() < 0.78;
    const psychiatrist =
      i < 44 ? leadPsy || pick(psychiatrists) : medicated || rnd() < 0.4 ? pick(psychiatrists) : null;
    const psychologist =
      i >= 44 && i < 72 ? leadPlg || pick(psychologists) : !psychiatrist || rnd() < 0.3 ? pick(psychologists) : null;
    const episode = insert(db, 'care_episodes', {
      patient_id: pid,
      started_at: iso(startOffset),
      opened_by: admin,
      created_at: iso(startOffset),
    });
    for (const d of [psychiatrist, psychologist].filter(Boolean))
      insert(db, 'care_assignments', {
        patient_id: pid,
        clinician_id: d.id,
        episode_id: episode,
        started_at: iso(startOffset),
        created_by: admin,
      });
    const prescriber = medicated ? psychiatrist : null;

    const dx = weighted(DX);
    if (dx)
      insert(db, 'patient_diagnoses', {
        patient_id: pid,
        code: dx,
        set_by: (psychiatrist || psychologist) && psychiatrist ? psychiatrist.id : admin,
        set_at: iso(startOffset),
      });
    stats.patients += 1;

    // ---- назначение, покупка, приём
    const items = [];
    if (prescriber) {
      const planId = insert(db, 'plan_versions', {
        patient_id: pid,
        version: 1,
        status: 'published',
        author_id: prescriber.id,
        published_at: iso(startOffset - 1),
        visible_from: iso(startOffset - 1),
        created_at: iso(startOffset - 1),
      });
      const innIds = [weighted(DRUGS)];
      if (rnd() < 0.22) innIds.push(pick([17, 20, 21, 10].filter((x) => x !== innIds[0])));
      for (const inn of innIds) {
        const times = inn === 17 || inn === 12 ? ['evening'] : rnd() < 0.2 ? ['morning', 'evening'] : ['morning'];
        const term = weighted([
          [28, 12],
          [56, 18],
          [84, 24],
          [180, 22],
          [null, 24],
        ]);
        const startDay = Math.max(2, startOffset - between(0, 3));
        const row = {
          plan_version_id: planId,
          item_key: `inn:${inn}`,
          inn_id: inn,
          dose_value: pick([25, 50, 10, 20]),
          dose_unit: 'мг',
          times_json: JSON.stringify(times),
          start_date: day(startDay),
          end_date: term ? new Date(Date.now() - startDay * DAY + term * DAY).toISOString().slice(0, 10) : null,
          status: 'active',
        };
        insert(db, 'plan_items', row);
        items.push({ ...row, startDay, slots: times });
      }
      stats.plans += 1;
      for (const it of items) {
        if (products.get(it.inn_id).length && rnd() < 0.78) {
          insert(db, 'purchase_marks', {
            patient_id: pid,
            item_key: it.item_key,
            product_id: pick(products.get(it.inn_id)),
            status: 'current',
            created_at: iso(it.startDay - between(0, 2)),
          });
          stats.purchases += 1;
        }
      }
      // приверженность: профиль пациента задаёт долю отмеченных приёмов
      const profile = weighted([
        ['regular', 44],
        ['partial', 24],
        ['rare', 11],
        ['none', 21],
      ]);
      const rate = { regular: 0.93, partial: 0.62, rare: 0.22, none: 0 }[profile];
      if (rate > 0) {
        for (const it of items) {
          for (let d = Math.min(it.startDay, 40); d >= 0; d -= 1) {
            for (const slot of it.slots) {
              if (rnd() > rate) continue;
              insert(db, 'med_log', {
                patient_id: pid,
                item_key: it.item_key,
                day: day(d),
                slot,
                status: rnd() < 0.96 ? 'taken' : 'skipped',
                logged_at: iso(d, 10),
              });
              stats.marks += 1;
            }
          }
        }
      }
      // побочные эффекты
      if (rnd() < 0.24) {
        for (let k = rnd() < 0.3 ? 2 : 1; k > 0; k -= 1) {
          const codes = [weighted(COMPLAINTS)];
          if (rnd() < 0.25) codes.push(weighted(COMPLAINTS));
          const onset = between(1, Math.max(2, startOffset - 2));
          insert(db, 'adverse_events', {
            patient_id: pid,
            complaint_codes_json: JSON.stringify([...new Set(codes)]),
            onset_date: day(onset),
            severity: weighted([
              ['mild', 50],
              ['noticeable', 35],
              ['severe', 15],
            ]),
            relation_patient: pick(['yes', 'unknown', 'unknown']),
            item_key: items[0].item_key,
            inn_id: items[0].inn_id,
            source: 'form',
            status: weighted([
              ['awaiting_doctor', 55],
              ['related_likely', 20],
              ['not_related', 12],
              ['insufficient', 13],
            ]),
            visible_from: iso(onset),
            psychiatrist_id: prescriber.id,
            created_at: iso(onset),
          });
          stats.ae += 1;
        }
      }
    }

    // ---- результаты GAD-7 и самочувствие: траектория одна на пациента
    const responder = rnd() < (medicated ? 0.64 : 0.52);
    const timeToImprove = responder ? between(10, 60) : 9999;
    const baseline = between(10, 19);
    const visits = [0, 14, 28, 42, 56, 70, 84].filter((d) => d <= startOffset - 1);
    for (const d of visits) {
      if (d > 0 && rnd() < 0.14) break; // выбыл из наблюдения
      const progress = responder ? 1 / (1 + Math.exp(-(d - timeToImprove) / 8)) : 0.12 * (d / 84);
      const score = Math.max(0, Math.min(21, Math.round(baseline * (1 - 0.78 * progress) + between(-1, 1))));
      insert(db, 'online_results', {
        patient_id: pid,
        instrument: 'gad7',
        instrument_version: gadVersion.version,
        answers_json: '[]',
        total_score: score,
        self_initiated: 0,
        created_at: `${day(startOffset - 1 - d)}T10:00:00Z`,
      });
      stats.tests += 1;
    }
    if (rnd() < 0.62) {
      const b = 2.1 + rnd() * 0.9;
      for (let d = startOffset - 1; d >= 0; d -= between(1, 3)) {
        const t = startOffset - 1 - d;
        const progress = responder ? 1 / (1 + Math.exp(-(t - timeToImprove) / 9)) : 0.08;
        const mood = Math.max(1, Math.min(5, Math.round(b + 1.9 * progress + (rnd() - 0.5))));
        db.prepare(
          'INSERT INTO mood_entries(patient_id,entry_date,mood,sleep,anxiety,created_at) VALUES (?,?,?,?,?,?)',
        ).run(
          pid,
          day(d),
          mood,
          mood >= 4 ? 'good' : mood >= 3 ? 'ok' : 'bad',
          mood >= 4 ? 'none' : mood >= 3 ? 'some' : 'strong',
          `${day(d)}T19:00:00Z`,
        );
        stats.mood += 1;
      }
    }
  }
});
run();
console.log('seed-demo-analytics:', JSON.stringify(stats));
