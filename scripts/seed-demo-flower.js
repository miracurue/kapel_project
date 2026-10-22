#!/usr/bin/env node
'use strict';

// Демо: цветок и капельки у синтетических пациентов на разных стадиях (Росток, Пышная крона, Цветение, полный рост).
// Только вымышленная история с прошлыми датами; добавочно: у пациента, у которого уже есть журнал цветка, ничего не меняется.
const Database = require('better-sqlite3');
const { PEOPLE } = require('../src/modules/demo/scenario');
const { STEP_PRICE, DAILY_MAX, STAGES, MAX_STEPS } = require('../src/modules/flower/rules');

// steps — сколько шагов роста уже полито, balance — сколько капелек лежит в запасе, today — сколько получено сегодня.
const SHAPES = [
  { name: 'crown', steps: 96, balance: 9, today: 3 },
  { name: 'sprout', steps: 18, balance: 6, today: 0 },
  { name: 'bloom', steps: 262, balance: 4, today: 4 },
  { name: 'new', steps: 0, balance: 0, today: 0 },
  { name: 'sprout-ready', steps: 41, balance: 20, today: 3 },
  { name: 'full', steps: MAX_STEPS, balance: 14, today: 2 },
];
const MIX = ['diary', 'habit', 'med', 'test', 'note', 'ai', 'diary', 'article'];
const DROPS = { diary: 3, habit: 1, med: 1, test: 2, note: 1, ai: 1, article: 1 };

function dayString(date, timeZone = 'Europe/Moscow') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function seedFlower(db, env, now = new Date()) {
  if (env.DATA_MODE !== 'synthetic' || env.DEMO_MODE !== '1')
    throw new Error('Requires DATA_MODE=synthetic and DEMO_MODE=1');
  if (db.prepare('SELECT 1 FROM users WHERE is_demo<>1 LIMIT 1').get())
    throw new Error('Refusing to seed a database containing non-demo accounts');
  const patients = db
    .prepare("SELECT id,email FROM users WHERE role='patient' AND is_demo=1 AND status='active' ORDER BY id")
    .all();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO flower_ledger(patient_id,kind,action,amount,steps,idem_key,source,day,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
  );
  const at = (daysAgo, hour) => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - daysAgo);
    d.setUTCHours(hour, 0, 0, 0);
    return d;
  };
  let seeded = 0;
  db.transaction(() => {
    patients.forEach((patient, index) => {
      if (db.prepare('SELECT 1 FROM flower_state WHERE patient_id=?').get(patient.id)) return;
      const shape = patient.email === PEOPLE.patient.email ? SHAPES[0] : SHAPES[(index + 1) % SHAPES.length];
      const earnedBefore = shape.steps * STEP_PRICE + shape.balance;
      // Копим «прошлые» капельки по дням (до дневного предела), последний день — вчера.
      let left = earnedBefore;
      let daysAgo = 1;
      let n = 0;
      while (left > 0 && daysAgo < 400) {
        let dayTotal = 0;
        while (left > 0 && dayTotal < Math.min(DAILY_MAX, 10)) {
          const action = MIX[n % MIX.length];
          const amount = Math.min(DROPS[action], left, DAILY_MAX - dayTotal);
          insert.run(
            patient.id,
            'earn',
            action,
            amount,
            0,
            `seed:${n}`,
            'seed',
            dayString(at(daysAgo, 9)),
            at(daysAgo, 9).toISOString().replace('.000Z', 'Z'),
          );
          left -= amount;
          dayTotal += amount;
          n += 1;
        }
        daysAgo += 1;
      }
      const first = Math.min(daysAgo, 400);
      // Поливали порциями.
      let remaining = shape.steps;
      let w = 0;
      while (remaining > 0) {
        const chunk = Math.min(remaining, 12 + (w % 4) * 6);
        const when = at(Math.max(0, first - 1 - w * 2), 18);
        insert.run(
          patient.id,
          'spend',
          'water',
          -chunk * STEP_PRICE,
          chunk,
          `water:seed:${w}`,
          'seed',
          dayString(when),
          when.toISOString().replace('.000Z', 'Z'),
        );
        remaining -= chunk;
        w += 1;
      }
      // Сегодняшний дневник, чтобы в «Сегодня +N» было что показать.
      if (shape.today > 0) {
        const today = at(0, now.getUTCHours());
        insert.run(
          patient.id,
          'earn',
          'diary',
          shape.today,
          0,
          `seed:today`,
          'seed',
          dayString(today),
          today.toISOString().replace('.000Z', 'Z'),
        );
      }
      const started = at(Math.min(first, 399), 8).toISOString().replace('.000Z', 'Z');
      db.prepare('INSERT INTO flower_state(patient_id,started_at,synced_at) VALUES (?,?,?)').run(
        patient.id,
        started,
        now.toISOString().replace(/\.\d+Z$/, 'Z'),
      );
      seeded += 1;
    });
  })();
  return { seeded, stages: STAGES.map((s) => s.key) };
}

if (require.main === module) {
  const db = new Database(process.env.DB_PATH);
  db.pragma('foreign_keys = ON');
  try {
    console.log(JSON.stringify(seedFlower(db, process.env)));
  } finally {
    db.close();
  }
}

module.exports = { seedFlower };
