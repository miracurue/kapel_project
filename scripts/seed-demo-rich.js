#!/usr/bin/env node
'use strict';

/**
 * Насыщенный демо-сид для показа (только синтетика, PD-24): люди «мира» + данные через публичный API,
 * как их создавали бы пользователи (дневник, тесты, сообщения, сигнал, НЯ, визит, план, документ).
 * Запуск при работающем сервере: BASE_URL=http://127.0.0.1:3000 DB_PATH=… LOG_HMAC_KEY=… node scripts/seed-demo-rich.js
 * Люди и пароль — tests/fixtures/world.js (вход «Войти как» выбирает именно их).
 */

const path = require('path');
const Database = require('better-sqlite3');
const { loadWorld, byKey } = require('../tests/fixtures/world');
const { Client } = require('../tests/lib/client');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tdr.sqlite3');
const WAIT_UNDO_MS = 17000; // окно «Отменить» S-01: 10 с на экране + 5 с на сервере

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayOffset = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function as(key) {
  const c = new Client(BASE, key);
  const r = await c.login(byKey(key).email);
  if (r.status !== 200) throw new Error(`вход ${key}: ${r.status} ${JSON.stringify(r.body)}`);
  return c;
}

async function step(label, fn) {
  try {
    const out = await fn();
    console.log('ok  ', label);
    return out;
  } catch (e) {
    console.log('FAIL', label, String(e.message || e).slice(0, 200));
    return null;
  }
}

function must(res) {
  if (res.status >= 300) throw new Error(`${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
  return res.body;
}

async function assign(doc, patientId, code) {
  return must(await doc.post(`/api/v1/patients/${patientId}/assignments`, { instrument_code: code })).items[0];
}

async function complete(patient, assignmentId, pick, allowRisk = false) {
  const q = must(await patient.get(`/api/v1/me/assignments/${assignmentId}`)).questions;
  for (const [index, item] of q.entries()) {
    const opts = item.options || [];
    const safe = !allowRisk && q.length === 9 && index === 8; // пункт 9 PHQ-9 даёт сигнал безопасности — только у Хасана
    const value =
      safe && item.options
        ? item.options[0].value
        : item.type === 'multi'
          ? [opts[0].value]
          : opts.length
            ? opts[Math.min(pick(item, index), opts.length - 1)].value
            : (item.min ?? 0);
    must(await patient.put(`/api/v1/me/assignments/${assignmentId}/answers/${encodeURIComponent(item.id)}`, { value }));
  }
  return must(await patient.post(`/api/v1/me/assignments/${assignmentId}/submit`, {}));
}

(async () => {
  const env = { LOG_HMAC_KEY: process.env.LOG_HMAC_KEY };
  const probe = new Database(DB_PATH);
  const have = probe.prepare("SELECT 1 FROM users WHERE email='psy1@cc.example.test'").get();
  probe.close();
  const ids = have
    ? Object.fromEntries(
        (() => {
          const d = new Database(DB_PATH);
          const rows = d.prepare('SELECT id,email FROM users').all();
          d.close();
          return rows.map((r) => [r.email, r.id]);
        })(),
      )
    : loadWorld(DB_PATH, env);
  const id = (key) => (have ? ids[byKey(key).email] : ids[key]);
  if (have) console.log('мир уже загружен — только дополняю данные');

  const psy1 = await as('psy1');
  const psy2 = await as('psy2');
  const plg1 = await as('plg1');
  const patA = await as('patA');
  const patB = await as('patB');
  const patH = await as('patH');

  // Дневник: A улучшается, B ухудшается, H — смешанная картина.
  const diary = async (client, series, notes = {}) => {
    for (let i = 0; i < series.length; i += 1) {
      const day = dayOffset(series.length - 1 - i);
      const [mood, sleep, anxiety] = series[i];
      await client.post('/api/v1/me/diary', { day, mood, sleep, anxiety, ...(notes[i] ? { note: notes[i] } : {}) });
    }
  };
  await step('дневник Марины (улучшение)', () =>
    diary(
      patA,
      [
        [2, 'bad', 'strong'],
        [2, 'bad', 'strong'],
        [3, 'ok', 'some'],
        [2, 'bad', 'some'],
        [3, 'ok', 'some'],
        [3, 'ok', 'some'],
        [4, 'ok', 'some'],
        [3, 'good', 'none'],
        [4, 'good', 'none'],
        [4, 'ok', 'none'],
        [5, 'good', 'none'],
        [4, 'good', 'none'],
      ],
      { 0: 'Утром медленно просыпаюсь.', 6: 'Выходные прошли спокойно, гуляла.', 11: 'Лучше, чем месяц назад.' },
    ),
  );
  await step('дневник Олега (ухудшение)', () =>
    diary(
      patB,
      [
        [4, 'good', 'none'],
        [4, 'ok', 'none'],
        [3, 'ok', 'some'],
        [3, 'bad', 'some'],
        [3, 'bad', 'some'],
        [2, 'bad', 'strong'],
        [2, 'bad', 'strong'],
        [2, 'bad', 'strong'],
      ],
      { 7: 'Почти не спал, тревога с утра.' },
    ),
  );
  await step('дневник Хасана (смешанный)', () =>
    diary(patH, [
      [3, 'ok', 'some'],
      [4, 'ok', 'none'],
      [2, 'bad', 'strong'],
      [3, 'ok', 'some'],
      [4, 'good', 'none'],
      [2, 'bad', 'some'],
      [3, 'ok', 'some'],
    ]),
  );

  // Тесты: три раунда PHQ-9 / GAD-7 (балл снижается у Марины, растёт у Олега), результаты затем разносятся по датам.
  const rounds = [
    { pickA: () => 2, pickB: () => 0, pickH: () => 1, age: 28 },
    { pickA: () => 1, pickB: () => 1, pickH: () => 1, age: 14 },
    { pickA: (q, i) => (i % 3 === 0 ? 1 : 0), pickB: () => 2, pickH: (q, i) => (i % 2 ? 2 : 1), age: 2 },
  ];
  const stamped = [];
  for (const [n, r] of rounds.entries()) {
    const jobs = [];
    for (const [doc, pat, patKey, pick] of [
      [psy1, patA, 'patA', r.pickA],
      [psy2, patB, 'patB', r.pickB],
      [psy1, patH, 'patH', r.pickH],
    ]) {
      for (const code of ['gad7']) {
        const a = await step(`назначение ${code} → ${patKey}, раунд ${n + 1}`, () => assign(doc, id(patKey), code));
        if (a) jobs.push({ pat, a, pick, patKey, age: r.age });
      }
    }
    await sleep(WAIT_UNDO_MS);
    for (const j of jobs) {
      const res = await step(`прохождение ${j.a.instrument_code || ''} ${j.patKey}`, () =>
        complete(j.pat, j.a.id, j.pick, j.patKey === 'patH'),
      );
      if (res) stamped.push({ assignment: j.a.id, age: j.age });
    }
  }
  {
    const d = new Database(DB_PATH);
    for (const s of stamped) {
      const at = new Date(Date.now() - s.age * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      d.prepare('UPDATE online_results SET created_at=? WHERE assignment_id=?').run(at, s.assignment);
      d.prepare('UPDATE instrument_assignments SET completed_at=?, assigned_at=? WHERE id=?').run(at, at, s.assignment);
    }
    d.close();
    console.log('ok   даты результатов разнесены');
  }

  await step('самостоятельный тест Хасана', async () => {
    const st = must(await patH.post('/api/v1/me/self-tests', { instrument_code: 'gad7' }));
    await sleep(500);
    return complete(patH, st.id, () => 1);
  });

  // Сообщения.
  await step('сообщение Марины врачу', () =>
    patA
      .post('/api/v1/me/messages', {
        text: 'Здравствуйте! Подташнивает после таблетки по утрам, это нормально?',
        to_clinician_id: id('psy1'),
      })
      .then(must),
  );
  await step('сигнал безопасности (Хасан)', () =>
    patH.post('/api/v1/me/messages', { text: 'Сегодня совсем тяжело, нет смысла жить дальше.' }).then(must),
  );
  await step('нежелательное явление (Марина)', () =>
    patA
      .post('/api/v1/me/adverse-events', {
        symptoms: ['nausea'],
        text: 'Тошнота после утреннего приёма, третий день.',
        started_on: dayOffset(3),
        severity: 'noticeable',
        related: 'yes',
      })
      .then(must),
  );

  // Визит и анкета перед приёмом.
  await step('визит Марины', () =>
    psy1
      .post(`/api/v1/patients/${id('patA')}/visits`, {
        starts_at: new Date(Date.now() + 5 * 86400000).toISOString(),
        format: 'in_person',
        place: 'кабинет 12',
        previsit_enabled: true,
      })
      .then(must),
  );

  // План лечения по МНН (STAND-IN каталог) и очный результат.
  await step('план лечения Марины', async () => {
    const found = must(await psy1.get(`/api/v1/catalog/search?q=${encodeURIComponent('сертралин')}&scope=inn`));
    const inn = (found.items || []).find((i) => i.kind === 'inn' && i.name.toLowerCase() === 'сертралин');
    if (!inn) throw new Error('нет МНН в каталоге');
    const cur = must(await psy1.get(`/api/v1/patients/${id('patA')}/plan`));
    const base = (cur.draft && cur.draft.version) || (cur.published && cur.published.version) || 1;
    const d = must(
      await psy1.put(`/api/v1/patients/${id('patA')}/plan/draft`, {
        version: base,
        items: [{ inn_id: inn.id, dose: 50, unit: 'мг', times: ['утро'] }],
      }),
    );
    return psy1.post(`/api/v1/patients/${id('patA')}/plan/publish`, { version: d.version || base }).then(must);
  });
  await step('очный результат Марины', async () => {
    const draft = must(
      await psy1.post(`/api/v1/patients/${id('patA')}/offline-results`, {
        instrument_code: 'gad7',
        method: 'manual',
        scores: { total: 9 },
      }),
    );
    return psy1
      .post(`/api/v1/offline-results/${draft.id}/confirm`, { scores: { total: 9, item9: 0 }, version: 1 })
      .then(must);
  });

  // Документ (из данных) и чат с ИИ.
  await sleep(WAIT_UNDO_MS);
  await step('документ «Сводка к приёму»', () =>
    psy1
      .post(`/api/v1/patients/${id('patA')}/documents`, { type: 'visit_summary', use_ai: false, chips: [], period: {} })
      .then(must),
  );
  await step('чат пациента с ИИ', () =>
    patA.post('/api/v1/ai/patient/messages', { text: 'Плохо сплю, что делать?' }).then(must),
  );
  await step('чат специалиста с ИИ', () =>
    psy1
      .post('/api/v1/ai/clinician/messages', {
        text: 'Что изменилось за 2 недели?',
        patient_id: id('patA'),
        chips: [{ type: 'patient', id: id('patA') }],
      })
      .then(must),
  );
  // Служебная очередь администратора: кризис у пациента без специалиста, просьба о смене врача.
  await step('кризис без специалиста (пациент без врача)', async () => {
    const patC = await as('patC');
    return patC.post('/api/v1/me/messages', { text: 'Сегодня совсем тяжело, нет смысла жить дальше.' }).then(must);
  });
  await step('просьба сменить специалиста (Олег)', async () => {
    const patB = await as('patB');
    const who = must(await patB.get('/api/v1/me/messages')).recipients[0];
    return patB.post('/api/v1/me/clinician-change', { clinician_id: who.id, reason: 'хочу попробовать другого специалиста' }).then(must);
  });
  {
    // Фикстурные пациенты «удаляемая» и «заблокированный» на демо-списке специалиста не нужны.
    const d = new Database(DB_PATH);
    d.prepare(
      "UPDATE care_assignments SET ended_at=datetime('now'), end_reason='archive' WHERE ended_at IS NULL AND patient_id IN (?,?)",
    ).run(id('patE'), id('patF'));
    d.close();
  }
  void plg1;
  console.log('готово');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
