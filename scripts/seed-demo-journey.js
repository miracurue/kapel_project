#!/usr/bin/env node
'use strict';

// Fictional history, deliberately backdated for a demonstration, never real care/audit events.
// Additive and atomic: existing patients are untouched; a second run does nothing.
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { PEOPLE } = require('../src/modules/demo/scenario');

function seedFlower(db, patientId, now) {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const patient = db.prepare('SELECT created_at FROM users WHERE id=? AND is_demo=1').get(patientId);
  if (!patient) throw new Error('Journey patient must be synthetic');
  db.prepare('INSERT OR IGNORE INTO flower_state(patient_id,started_at,synced_at) VALUES (?,?,?)').run(
    patientId,
    patient.created_at,
    stamp,
  );
  // Explicit demo bonus, separate from normal reward rules; zero growth until the user waters.
  // Never rewind an existing flower or replenish this bonus on repeated seed runs.
  db.prepare(
    "INSERT OR IGNORE INTO flower_ledger(patient_id,kind,action,amount,steps,idem_key,source,day,created_at) VALUES (?,'earn','demo_bonus',1000,0,'demo:journey:bonus:v1','demo:journey',?,?)",
  ).run(patientId, patient.created_at.slice(0, 10), stamp);
}

function seedJourney(db, env, now = new Date()) {
  if (env.DATA_MODE !== 'synthetic' || env.DEMO_MODE !== '1' || !env.LOG_HMAC_KEY)
    throw new Error('Requires DATA_MODE=synthetic, DEMO_MODE=1 and LOG_HMAC_KEY');
  // Browser QA can create accounts without is_demo in a synthetic preview.
  // Accept those only on reserved example domains; refuse plausible real accounts.
  const unmarked = db.prepare('SELECT email FROM users WHERE is_demo<>1').all();
  if (unmarked.some((u) => !/@(?:[a-z0-9-]+\.)*example\.(?:test|com|org)$/i.test(u.email || '')))
    throw new Error('Refusing to seed a database containing non-synthetic accounts');
  const existing = db
    .prepare("SELECT id FROM users WHERE email=? AND role='patient' AND is_demo=1")
    .get(PEOPLE.patient.email);
  if (existing) {
    db.transaction(() => seedFlower(db, existing.id, now)).immediate();
    return { skipped: true };
  }
  const at = (days, hour = 9) => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + days);
    date.setUTCHours(hour, 0, 0, 0);
    return date.toISOString().replace('.000Z', 'Z');
  };
  const day = (offset) => at(offset).slice(0, 10);
  const instrument = db
    .prepare(
      "SELECT v.* FROM instruments i JOIN instrument_versions v ON v.instrument_code=i.code AND v.version=i.current_version WHERE i.code='gad7' AND i.status='published' AND v.is_stand_in=0",
    )
    .get();
  if (!instrument) throw new Error('Start the application first to initialize the digitized GAD-7');
  const questions = JSON.parse(instrument.schema_json).questions;
  if (questions.length !== 7) throw new Error('Unexpected GAD-7 version');
  const bands = JSON.parse(instrument.bands_json);
  const hash = bcrypt.hashSync('Synthetic-Journey-2026', 10);
  const ids = {};
  const result = db
    .transaction(() => {
      for (const [role, person] of Object.entries(PEOPLE)) {
        ids[role] = Number(
          db
            .prepare(
              'INSERT INTO users(service_no,email,email_hmac,password_hash,role,full_name,is_demo,age_band,sex,created_at) VALUES (?,?,?,?,?,?,1,?,?,?)',
            )
            .run(
              `DEMO-JOURNEY-${role}`,
              person.email,
              crypto.createHmac('sha256', env.LOG_HMAC_KEY).update(person.email).digest('hex'),
              hash,
              role,
              person.name,
              role === 'patient' ? '35-44' : null,
              role === 'patient' ? 'f' : null,
              at(-42),
            ).lastInsertRowid,
        );
        db.prepare(
          'INSERT INTO user_prefs(user_id,onboarding_done_at,share_diary_notes,course_support_enabled,timezone) VALUES (?,?,1,1,?)',
        ).run(ids[role], at(-42), 'Europe/Moscow');
      }
      const pid = ids.patient;
      seedFlower(db, pid, now);
      db.prepare("INSERT INTO patient_diagnoses(patient_id,code,set_by,set_at) VALUES (?,'F41.1',?,?)").run(
        pid,
        ids.psychiatrist,
        at(-28),
      );
      // Reuse the demo's published consent versions. No research/program consent is invented.
      for (const kind of ['base', 'ai']) {
        const version = db
          .prepare("SELECT * FROM content_versions WHERE kind=? AND status='published' ORDER BY version DESC LIMIT 1")
          .get(`consent.${kind}`);
        if (!version) throw new Error(`Missing published demo consent: ${kind}`);
        db.prepare(
          'INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method,created_at) VALUES (?,?,?,?,?,?,?)',
        ).run(pid, kind, 'given', version.id, version.body_sha256, 'demo_click', at(-42));
      }
      const episode = Number(
        db
          .prepare('INSERT INTO care_episodes(patient_id,started_at,opened_by,created_at) VALUES (?,?,?,?)')
          .run(pid, at(-42), ids.psychologist, at(-42)).lastInsertRowid,
      );
      for (const role of ['psychologist', 'psychiatrist']) {
        const stamp = at(role === 'psychologist' ? -42 : -28);
        db.prepare(
          'INSERT INTO care_assignments(patient_id,clinician_id,episode_id,started_at,created_by) VALUES (?,?,?,?,?)',
        ).run(pid, ids[role], episode, stamp, ids[role]);
      }
      const message = (role, sender, offset, text, hour = 10) => {
        const stamp = at(offset, hour);
        db.prepare(
          'INSERT INTO care_messages(patient_id,clinician_id,sender_id,sender_role,body,visible_from,created_at,read_at) VALUES (?,?,?,?,?,?,?,?)',
        ).run(
          pid,
          ids[role],
          sender === 'patient' ? pid : ids[role],
          sender === 'patient' ? 'patient' : 'clinician',
          `Демонстрационный сценарий. ${text}`,
          stamp,
          stamp,
          stamp,
        );
      };
      message(
        'psychologist',
        'patient',
        -42,
        'Мне 36 лет, я руководитель проектов. Уже восемь месяцев тревожусь о работе, деньгах и близких, даже когда всё спокойно. Плохо засыпаю, устаю, трудно сосредоточиться. Хочу разобраться с психологом.',
      );
      message(
        'psychologist',
        'clinician',
        -41,
        'Начнём встречи и дневник самочувствия в сервисе. Между консультациями можно писать мне здесь.',
      );
      message(
        'psychologist',
        'clinician',
        -35,
        'Тревога продолжает мешать сну и работе. Назначила ГТР-7: короткий опросник поможет обсудить выраженность симптомов. Сам тест не устанавливает диагноз.',
      );
      message(
        'psychologist',
        'clinician',
        -34,
        'Я посмотрела ответы и учитываю нашу беседу: тревога длительная и заметно влияет на повседневную жизнь. Рекомендую обратиться к психиатру для оценки состояния и вариантов помощи. Наши встречи продолжим.',
      );
      message(
        'psychologist',
        'patient',
        -33,
        'Согласна на консультацию психиатра. Хочу сохранить связь с вами и добавить врача в сервисе.',
      );
      message(
        'psychiatrist',
        'clinician',
        -28,
        'После очной консультации в этой вымышленной истории установлен диагноз «генерализованное тревожное расстройство». Обсудили варианты помощи и выбрали Авиандр (маритупирдин). План внесён в сервис: 20 мг утром и вечером; длительность определяем на приёмах. Психологическая работа продолжается.',
      );
      message(
        'psychiatrist',
        'patient',
        -27,
        'Купила назначенный Авиандр, выбрала упаковку в плане и включила напоминания. Буду отмечать приём и самочувствие.',
      );
      message(
        'psychiatrist',
        'patient',
        -20,
        'Вчера пропустила вечерний приём в поездке. Пока не чувствую заметных перемен и думаю, стоит ли продолжать. Хочу обсудить это с вами, прежде чем что-то менять.',
      );
      message(
        'psychiatrist',
        'clinician',
        -20,
        'Спасибо, что написали. Вижу отметку пропуска и ваш дневник. Давайте обсудим ожидания, переносимость и удобство расписания на контрольном приёме. До обсуждения ориентируйтесь на согласованный план; самостоятельно менять его не нужно.',
        12,
      );
      message(
        'psychiatrist',
        'patient',
        -18,
        'На контрольном приёме всё обсудили. Перенесла напоминание на удобное время, продолжаю согласованный план.',
      );
      message(
        'psychologist',
        'clinician',
        -14,
        'Продолжим работу с постоянным беспокойством и режимом сна. На встрече разберём записи из дневника; вопросы о лекарствах обсуждайте с Михаилом Воронцовым.',
      );
      message(
        'psychiatrist',
        'clinician',
        -7,
        'На повторном приёме обсудили дневник, отметки приёма и повторный ГТР-7. Вы сообщаете, что стало легче справляться с повседневными делами. Продолжение лечения согласовано; следующий контроль уже в расписании.',
      );
      message(
        'psychiatrist',
        'patient',
        -2,
        'Продолжаю приём и встречи с психологом. Иногда тревога возвращается, но я знаю, кому написать, и не остаюсь с вопросами одна.',
      );

      for (const [offset, role, values] of [
        [-35, 'psychologist', [3, 3, 2, 2, 2, 2, 2]],
        [-8, 'psychiatrist', [1, 2, 1, 1, 1, 1, 1]],
      ]) {
        const assigned = at(offset, 9);
        const completed = at(offset, 11);
        const assignment = Number(
          db
            .prepare(
              "INSERT INTO instrument_assignments(patient_id,assigned_by,instrument,instrument_version,status,assigned_at,visible_from,completed_at,comment) VALUES (?,?,'gad7',?,'completed',?,?,?,?)",
            )
            .run(
              pid,
              ids[role],
              instrument.version,
              assigned,
              assigned,
              completed,
              'Вымышленное прохождение для демонстрации',
            ).lastInsertRowid,
        );
        const answers = Object.fromEntries(questions.map((q, i) => [q.id, String(values[i])]));
        const score = values.reduce((sum, value) => sum + value, 0);
        db.prepare(
          "INSERT INTO online_results(assignment_id,patient_id,instrument,instrument_version,answers_json,total_score,band,created_at) VALUES (?,?,'gad7',?,?,?,?,?)",
        ).run(
          assignment,
          pid,
          instrument.version,
          JSON.stringify(answers),
          score,
          bands.find((b) => score >= b.min && score <= b.max).label,
          completed,
        );
      }
      db.prepare(
        "INSERT INTO instrument_assignments(patient_id,assigned_by,instrument,instrument_version,status,assigned_at,visible_from,due_date,comment) VALUES (?,?,'gad7',?,'pending',?,?,?,?)",
      ).run(
        pid,
        ids.psychiatrist,
        instrument.version,
        at(-1),
        at(-1),
        day(5),
        'Повторный опрос перед контрольным приёмом. Демо.',
      );

      let inn = db.prepare("SELECT id FROM inn WHERE name_norm='маритупирдин' AND status='in_catalog'").get();
      if (!inn)
        inn = {
          id: Number(
            db
              .prepare(
                "INSERT INTO inn(name,name_norm,drug_group,rx_only,source,source_date) VALUES ('маритупирдин','маритупирдин','anxiolytic',1,'manual_checked','2026-07-16')",
              )
              .run().lastInsertRowid,
          ),
        };
      let product = db
        .prepare("SELECT id FROM drug_products WHERE inn_id=? AND trade_name_norm='авиандр' AND status='in_catalog'")
        .get(inn.id);
      if (!product)
        product = {
          id: Number(
            db
              .prepare(
                "INSERT INTO drug_products(inn_id,trade_name,trade_name_norm,dosage_form,strength,source,source_date) VALUES (?,'Авиандр','авиандр','таблетки, покрытые пленочной оболочкой','20 мг','manual_checked','2026-07-16')",
              )
              .run(inn.id).lastInsertRowid,
          ),
        };
      for (const [type, entity, term] of [
        ['inn', inn.id, 'маритупирдин'],
        ['product', product.id, 'авиандр'],
      ])
        db.prepare(
          "INSERT OR IGNORE INTO drug_search_terms(entity_type,entity_id,inn_id,term_norm,origin) VALUES (?,?,?,?,'name')",
        ).run(type, entity, inn.id, term);
      const plan = Number(
        db
          .prepare(
            "INSERT INTO plan_versions(patient_id,version,status,author_id,recommendations_enc,visible_from,created_at,published_at) VALUES (?,1,'published',?,?,?,?,?)",
          )
          .run(
            pid,
            ids.psychiatrist,
            'Вымышленный план для демонстрации: Авиандр по согласованному с психиатром назначению. Длительность определяется врачом. Контроль переносимости, самочувствия и вопросов о продолжении терапии.',
            at(-28),
            at(-28),
            at(-28),
          ).lastInsertRowid,
      );
      const itemKey = `journey-maritupirdine-${pid}`;
      const item = Number(
        db
          .prepare(
            "INSERT INTO plan_items(plan_version_id,item_key,inn_id,dose_value,dose_unit,times_json,start_date,duration_text,comment_enc) VALUES (?,?,?,20,'мг',?,?,?,?)",
          )
          .run(
            plan,
            itemKey,
            inn.id,
            JSON.stringify(['утро', 'вечер']),
            day(-27),
            'До пересмотра психиатром на контрольном приёме',
            'Демо: Авиандр, по 1 таблетке 20 мг утром и вечером.',
          ).lastInsertRowid,
      );
      db.prepare('INSERT INTO plan_item_acceptance(patient_id,item_key,accepted_at) VALUES (?,?,?)').run(
        pid,
        itemKey,
        at(-27),
      );
      db.prepare(
        "INSERT INTO purchase_marks(patient_id,item_key,product_id,strength,status,created_at) VALUES (?,?,?,'20 мг','current',?)",
      ).run(pid, itemKey, product.id, at(-27));
      for (const time of ['08:00', '20:00'])
        db.prepare(
          "INSERT INTO reminders(patient_id,created_by,kind,plan_item_id,message,time_hhmm,created_at) VALUES (?,?,'med',?,?,?,?)",
        ).run(pid, pid, item, 'Демо: время приёма по согласованному плану. Отметьте приём или пропуск.', time, at(-27));
      // Only completed past days: today's/future intakes remain unknown.
      for (let offset = -27; offset <= -1; offset += 1) {
        for (const slot of ['утро', 'вечер'])
          db.prepare('INSERT INTO med_log(patient_id,item_key,day,slot,status,logged_at) VALUES (?,?,?,?,?,?)').run(
            pid,
            itemKey,
            day(offset),
            slot,
            offset === -21 && slot === 'вечер' ? 'skipped' : 'taken',
            at(offset, slot === 'утро' ? 6 : 17),
          );
      }
      for (let offset = -41; offset <= -1; offset += 1) {
        if (offset % 6 === 0) continue; // Realistic gaps, never converted to zeros.
        db.prepare(
          'INSERT INTO mood_entries(patient_id,entry_date,mood,sleep,anxiety,note,created_at) VALUES (?,?,?,?,?,?,?)',
        ).run(
          pid,
          day(offset),
          offset < -18 ? 2 : offset % 4 === 0 ? 3 : 4,
          offset < -18 ? 'bad' : 'ok',
          offset < -18 ? 'strong' : 'some',
          offset === -20
            ? 'Демо: сомневаюсь, продолжать ли лечение; написала врачу.'
            : offset === -2
              ? 'Демо: продолжаю план, на следующем приёме обсудим тревогу и сон.'
              : null,
          at(offset, 18),
        );
      }
      for (const [role, offset] of [
        ['psychologist', -42],
        ['psychiatrist', -28],
        ['psychiatrist', -18],
        ['psychiatrist', -7],
        ['psychologist', 3],
        ['psychiatrist', 5],
      ])
        db.prepare(
          'INSERT INTO visits(patient_id,clinician_id,starts_at,format,place,status,visible_from,created_at) VALUES (?,?,?,?,?,?,?,?)',
        ).run(
          pid,
          ids[role],
          at(offset, 12),
          role === 'psychologist' ? 'remote' : 'in_person',
          role === 'psychologist' ? 'Онлайн-консультация · демо' : 'Кабинет 12 · демо',
          offset < 0 ? 'done' : 'scheduled',
          at(-42),
          at(-42),
        );
      db.prepare('INSERT INTO clinician_notes(patient_id,author_id,body,note_date,created_at) VALUES (?,?,?,?,?)').run(
        pid,
        ids.psychologist,
        'ДЕМО, все события вымышлены. Александра, 36 лет, руководитель проектов. Длительная тревога в разных сферах, нарушения сна и концентрации. ГТР-7 и беседа стали основанием рекомендовать консультацию психиатра, а не поставить диагноз по тесту. Психологическое сопровождение продолжается.',
        day(-34),
        at(-34),
      );
      db.prepare('INSERT INTO clinician_notes(patient_id,author_id,body,note_date,created_at) VALUES (?,?,?,?,?)').run(
        pid,
        ids.psychiatrist,
        'ДЕМО, клиническое содержание review-required. На очной консультации в легенде установлено ГТР. Выбран Авиандр (маритупирдин); инструкция 16.07.2026, разделы 4.1–4.2. Через неделю пациентка сомневалась в продолжении и отметила один пропуск. Сообщение и дневник помогли обсудить трудности на контроле; план продолжен по совместному решению. Отметки — самоотчёт, не доказательство приёма; динамика вымышлена и не доказывает эффект препарата.',
        day(-7),
        at(-7),
      );
      if (db.pragma('foreign_key_check').length) throw new Error('Foreign key check failed');
      return { seeded: true, synthetic: true, ids };
    })
    .immediate();
  return result;
}

async function main() {
  if (!process.env.DB_PATH) throw new Error('Set DB_PATH explicitly; no default database is modified');
  const db = new Database(process.env.DB_PATH, { fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    if (process.env.DATA_MODE !== 'synthetic' || process.env.DEMO_MODE !== '1') throw new Error('Synthetic demo only');
    const backup = `${process.env.DB_PATH}.before-journey-${Date.now()}.bak`;
    await db.backup(backup);
    const copy = new Database(backup, { readonly: true });
    try {
      if (copy.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Backup verification failed');
    } finally {
      copy.close();
    }
    console.log(JSON.stringify({ ...seedJourney(db, process.env), backup }));
  } finally {
    db.close();
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { seedJourney };
