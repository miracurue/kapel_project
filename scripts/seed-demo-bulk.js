#!/usr/bin/env node
'use strict';

/**
 * Объёмный демо-сид (только синтетика, PD-24): больше пациентов у разных специалистов, дневники, переписка,
 * нежелательные явления, визиты, планы лечения и много статей для «Мои статьи» (оба журнала, черновики, публикации,
 * беседы с ИИ). Методики, тесты и результаты тестов НЕ добавляются — по просьбе владельца.
 * Запуск при работающем сервере и после seed-demo-rich.js:
 *   BASE_URL=http://127.0.0.1:3000 DB_PATH=… LOG_HMAC_KEY=… node scripts/seed-demo-bulk.js
 * Повторный запуск безопасен: уже созданные пациенты и статьи пропускаются.
 */

const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { PASSWORD, byKey, insert, hmacHex, nowIso } = require('../tests/fixtures/world');
const { Client } = require('../tests/lib/client');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tdr.sqlite3');
const WAIT_UNDO_MS = 17000; // окно «Отменить»: 10 с на экране + 5 с на сервере

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayOffset = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
// Детерминированный «случайный» ряд: одинаковый сид даёт одинаковые данные.
let seed = 20261020;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];

// Новые пациенты: key, имя, e-mail, специалисты (ключи мира), согласия.
const NEW_PATIENTS = [
  ['patJ', 'Алиса Примерова', 'pat.j', ['psy1'], ['base', 'ai', 'research']],
  ['patK', 'Борис Образцов', 'pat.k', ['psy1', 'plg1'], ['base', 'ai']],
  ['patL', 'Валентина Макетова', 'pat.l', ['psy1'], ['base', 'ai']],
  ['patM', 'Глеб Черновиков', 'pat.m', ['psy2'], ['base', 'ai', 'research']],
  ['patN', 'Дарья Ознакомлева', 'pat.n', ['psy2', 'plg2'], ['base', 'ai']],
  ['patO', 'Егор Показов', 'pat.o', ['psy2'], ['base']],
  ['patP', 'Жанна Пилотова', 'pat.p', ['plg1'], ['base', 'ai']],
  ['patQ', 'Захар Стендов', 'pat.q', ['plg1'], ['base', 'ai']],
  ['patR', 'Ирина Условова', 'pat.r', ['plg2'], ['base', 'ai']],
  ['patS', 'Кирилл Тестовых', 'pat.s', ['plg2', 'psy2'], ['base', 'ai']],
  ['patT', 'Лидия Выдуманова', 'pat.t', ['psy1'], ['base', 'ai']],
  ['patU', 'Максим Демонстров', 'pat.u', ['psy2'], ['base', 'ai']],
  ['patV', 'Нина Синтетикова', 'pat.v', ['psy1', 'plg2'], ['base', 'ai']],
  ['patW', 'Олег Витринов', 'pat.w', ['psy3'], ['base', 'ai']],
].map(([key, name, local, clinicians, consents]) => ({ key, name, email: `${local}@cc.example.test`, clinicians, consents }));

const PATIENT_TEXTS = [
  'Здравствуйте! Подскажите, можно ли переносить приём, если у меня рабочая поездка?',
  'Плохо засыпаю последние несколько дней, просыпаюсь в четыре утра. Это связано с лечением?',
  'Хочу уточнить, как правильно вести дневник — записывать каждый день или только когда есть изменения?',
  'Спасибо за приём. Дома стало спокойнее, но по вечерам иногда возвращается тревога.',
  'Не получилось дозвониться в регистратуру. Напишите, пожалуйста, когда ближайшее свободное время.',
  'Утром бывает лёгкая тошнота, к обеду проходит. Стоит ли беспокоиться?',
  'Поняла рекомендации по режиму дня, стараюсь ложиться вовремя. Пока получается через раз.',
  'Можно ли заниматься спортом в период лечения? Хочу вернуться в зал.',
  'Забыл вчера вечером принять назначенное, что делать в такой ситуации?',
  'Подскажите, где посмотреть результаты прошлого визита и рекомендации?',
];
const CLINICIAN_TEXTS = [
  'Добрый день! Да, перенести можно, напишите удобную дату — подберём время.',
  'Спасибо, что написали. Давайте обсудим это на ближайшем приёме; пока продолжайте вести дневник.',
  'Хорошо, что вы замечаете изменения. Записывайте в дневник каждый день, даже коротко.',
  'Рада, что стало спокойнее. Отметьте в дневнике, в какие вечера тревога сильнее, — разберём вместе.',
  'Ближайшее свободное время — на этой неделе во второй половине дня. Подтвердите, подходит ли.',
  'Если станет хуже или появятся новые симптомы, напишите в тот же день.',
  'Режим дня — важная часть. Небольшие шаги в этом тоже считаются, не огорчайтесь.',
  'Лёгкая физическая нагрузка обычно полезна. Подробности обсудим на приёме.',
];
const DIARY_NOTES = [
  'Спокойный день, много ходил пешком.',
  'Тревожно с утра, к вечеру отпустило.',
  'Плохо спал, голова тяжёлая.',
  'Встретилась с подругой, настроение лучше.',
  'Работа выматывает, но справляюсь.',
  'Сделала дыхательное упражнение, помогло.',
  'Выходной, отдыхал дома.',
];

async function as(email) {
  const c = new Client(BASE, email);
  const r = await c.login(email);
  if (r.status !== 200) throw new Error(`вход ${email}: ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
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

// ---------- пациенты (напрямую в базу, как делает загрузчик мира) ----------

function createPatients(db, ids) {
  const hash = bcrypt.hashSync(PASSWORD, 4);
  const created = [];
  let n = 500;
  db.transaction(() => {
    for (const p of NEW_PATIENTS) {
      n += 1;
      const have = db.prepare('SELECT id FROM users WHERE email=?').get(p.email);
      if (have) {
        ids[p.key] = have.id;
        continue;
      }
      ids[p.key] = insert(db, 'users', {
        service_no: `Д-${String(n).padStart(5, '0')}`,
        email: p.email,
        email_hmac: hmacHex(process.env.LOG_HMAC_KEY, p.email),
        password_hash: hash,
        role: 'patient',
        full_name: p.name,
        status: 'active',
        is_demo: 1,
        password_changed_at: nowIso(-86400000),
        created_at: nowIso(-30 * 86400000),
      });
      insert(db, 'user_prefs', { user_id: ids[p.key], onboarding_done_at: nowIso(-86400000) });
      for (const kind of p.consents) {
        const v = db
          .prepare("SELECT id, body_sha256 FROM content_versions WHERE kind=? AND status='published' ORDER BY version DESC LIMIT 1")
          .get(`consent.${kind}`);
        if (!v) continue;
        insert(db, 'consent_events', {
          user_id: ids[p.key],
          consent_kind: kind,
          action: 'given',
          content_version_id: v.id,
          text_sha256: v.body_sha256,
          sign_method: 'demo_click',
          created_at: nowIso(-20 * 86400000),
        });
      }
      const episode = insert(db, 'care_episodes', {
        patient_id: ids[p.key],
        started_at: nowIso(-20 * 86400000),
        opened_by: ids.admin1,
      });
      for (const c of p.clinicians) {
        insert(db, 'care_assignments', {
          patient_id: ids[p.key],
          clinician_id: ids[c],
          episode_id: episode,
          started_at: nowIso(-20 * 86400000),
          created_by: ids.admin1,
        });
      }
      created.push(p);
    }
  })();
  return created;
}

// ---------- статьи ----------

const PATIENT_TOPICS = [
  ['Как справляться с тревогой по вечерам', 'Простые шаги, которые помогают вечером успокоиться.', ['тема:сон', 'тема:тревога']],
  ['Первые недели лечения: чего ждать', 'Что обычно беспокоит в начале и когда написать врачу.', ['тема:первые-недели']],
  ['Если вы пропустили приём лекарства', 'Спокойный порядок действий и когда обратиться к врачу.', ['тема:пропустил-приём']],
  ['Дыхание, которое помогает успокоиться', 'Короткое упражнение на две минуты.', ['тема:тревога', 'тема:практика']],
  ['Как вести дневник настроения', 'Зачем нужны короткие записи и как их делать.', ['тема:дневник']],
  ['Сон и режим дня', 'Небольшие привычки, которые делают ночь спокойнее.', ['тема:сон']],
  ['Что делать, если стало хуже', 'Когда писать врачу сразу и куда звонить в экстренной ситуации.', ['тема:кризис']],
  ['Физическая активность при подавленном настроении', 'Почему помогает даже короткая прогулка.', ['тема:практика']],
  ['Как говорить с близкими о своём состоянии', 'Несколько мягких формулировок для трудного разговора.', ['тема:близкие']],
  ['Лекарство не помогает сразу — это нормально', 'Почему эффект появляется постепенно.', ['тема:первые-недели', 'тема:лечение']],
  ['Тошнота в начале приёма: что обсудить с врачом', 'Что можно отметить в дневнике и как рассказать о нестерпимом.', ['тема:побочные']],
  ['Как подготовиться к приёму', 'Список вопросов и заметок, которые стоит принести.', ['тема:приём']],
];
const SPECIALIST_TOPICS = [
  ['Тревожные расстройства: что полезно знать коллегам из смежных областей', 'Краткий обзор понятным языком.', ['тема:практика', 'тема:тревога']],
  ['Динамика баллов шкал: как читать, а не пересчитывать', 'О чём говорит изменение суммы между визитами.', ['тема:практика']],
  ['Мотивационная беседа в первые недели терапии', 'Практические приёмы и частые ошибки.', ['тема:коммуникация']],
  ['Дневник самонаблюдения как инструмент приёма', 'Как использовать записи пациента на консультации.', ['тема:дневник']],
  ['Совместное наблюдение психиатра и психолога', 'Как разделить зоны ответственности без дублирования.', ['тема:организация']],
  ['Сигналы ухудшения между приёмами', 'Какие признаки стоит обсуждать с пациентом заранее.', ['тема:кризис']],
  ['Как объяснять пациенту отсроченный эффект терапии', 'Формулировки, которые снижают тревогу ожидания.', ['тема:коммуникация']],
  ['Нежелательные явления: что фиксировать в карточке', 'Минимальный набор сведений для переноса в МИС.', ['тема:побочные']],
];
const PARAGRAPHS = [
  'Это учебный текст для демонстрации. Он написан синтетически и не содержит клинических рекомендаций.',
  'Короткие и регулярные шаги работают лучше редких больших усилий. Начните с одного небольшого действия в день.',
  'Если что-то беспокоит или состояние ухудшилось, напишите специалисту — это нормальная часть лечения.',
  'Замечайте изменения и записывайте их: так на приёме проще увидеть общую картину.',
  'Не нужно справляться в одиночку. Близкие и специалисты рядом, чтобы помочь.',
  'Подробности лучше обсуждать лично: у каждого человека своя ситуация.',
];

function articleBody(title, patient) {
  const paras = [];
  const n = patient ? 3 + Math.floor(rnd() * 2) : 4 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i += 1) paras.push(pick(PARAGRAPHS));
  const head = patient ? '' : `## ${title}\n\n`;
  const tail = patient
    ? '\n\nЕсли стало совсем тяжело, звоните 112.'
    : '\n\n### Практический вывод\n\nСтатья синтетическая; вывод для работы вносит автор.';
  return head + paras.join('\n\n') + tail;
}

async function seedArticles(authors, db, ids) {
  const have = db.prepare('SELECT count(*) n FROM library_items WHERE owner_user_id IN (?,?,?,?)').get(ids.psy1, ids.psy2, ids.plg1, ids.plg2).n;
  if (have >= 12) return console.log('статей уже достаточно — пропускаю');
  const plan = [];
  for (const [i, t] of PATIENT_TOPICS.entries()) plan.push({ t, audience: 'patient', author: authors[i % authors.length] });
  for (const [i, t] of SPECIALIST_TOPICS.entries()) plan.push({ t, audience: 'specialist', author: authors[(i + 1) % authors.length] });
  // Второй круг однотипных статей по частым темам — чтобы списки были длинными.
  for (const [i, t] of PATIENT_TOPICS.slice(0, 6).entries())
    plan.push({ t: [`${t[0]} (часть 2)`, t[1], t[2]], audience: 'patient', author: authors[(i + 2) % authors.length] });
  const made = [];
  for (const [i, item] of plan.entries()) {
    const [title, summary, tags] = item.t;
    const body = articleBody(title, item.audience === 'patient');
    const r = await step(`статья «${title}» (${item.author.label}, ${item.audience})`, async () => {
      const a = must(
        await item.author.client.post(
          '/work/api/library',
          { title, summary, body_md: body, tags, audience: item.audience, ai_assisted: i % 3 === 0 },
          { idem: false },
        ),
      );
      // Публикуем примерно 60%, ещё несколько снимаем с публикации — остальное остаётся черновиками.
      const mode = i % 5;
      if (mode === 0 || mode === 1 || mode === 2) must(await item.author.client.post(`/work/api/library/${a.id}/publish`, {}, { idem: false }));
      if (mode === 2 && i % 2 === 0) must(await item.author.client.post(`/work/api/library/${a.id}/unpublish`, {}, { idem: false }));
      return a;
    });
    if (r) made.push({ id: r.id, title, author: item.author });
  }
  // Беседы с ИИ по нескольким статьям (в базу напрямую: настоящая модель для сида не вызывается).
  const chat = db.prepare('INSERT INTO library_chat(item_id,role,text,created_at) VALUES (?,?,?,?)');
  const asks = [
    'Напиши короткую статью про вечернюю тревогу простыми словами',
    'Сделай мягче и добавь про режим сна',
    'Сократи до трёх абзацев',
    'Добавь в конец, когда стоит обратиться к врачу',
  ];
  for (const m of made.slice(0, 8)) {
    for (const a of asks.slice(0, 2 + (m.id % 3))) {
      chat.run(m.id, 'user', a, nowIso(-3600000));
      chat.run(m.id, 'assistant', `ЗАГОЛОВОК: ${m.title}\n---\nТекст статьи.`, nowIso(-3500000));
    }
  }
  console.log('ok   беседы с ИИ по статьям');
}

// ---------- основной ход ----------

(async () => {
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');
  const ids = Object.fromEntries(db.prepare('SELECT email, id FROM users').all().map((r) => [r.email, r.id]));
  const idOf = (key) => ids[byKey(key).email];
  for (const key of ['admin1', 'psy1', 'psy2', 'psy3', 'plg1', 'plg2']) ids[key] = idOf(key);
  const created = createPatients(db, ids);
  console.log(`пациентов добавлено: ${created.length}`);

  const clients = {};
  for (const key of ['psy1', 'psy2', 'plg1', 'plg2']) clients[key] = await as(byKey(key).email);
  const authors = ['psy1', 'psy2', 'plg1', 'plg2'].map((key) => ({ client: clients[key], label: key }));

  await seedArticles(authors, db, ids);

  const mine = created.length ? created : [];
  const pClients = {};
  for (const p of mine) pClients[p.key] = await step(`вход ${p.key}`, () => as(p.email));

  // Дневники: у каждого от 8 до 21 дня, тренд случайно вверх, вниз или ровно.
  const SLEEP = ['bad', 'ok', 'good'];
  const ANX = ['none', 'some', 'strong'];
  for (const p of mine) {
    const c = pClients[p.key];
    if (!c) continue;
    const days = 8 + Math.floor(rnd() * 14);
    const trend = pick([-1, 0, 1]);
    await step(`дневник ${p.key} (${days} дн.)`, async () => {
      for (let i = 0; i < days; i += 1) {
        const base = 3 + trend * ((i / days) * 1.6 - 0.8);
        const mood = Math.max(1, Math.min(5, Math.round(base + (rnd() - 0.5) * 2)));
        const sleep = SLEEP[Math.max(0, Math.min(2, Math.round((mood - 1) / 2 + (rnd() - 0.5))))];
        const anxiety = ANX[Math.max(0, Math.min(2, Math.round((5 - mood) / 2 + (rnd() - 0.5))))];
        await c.post('/api/v1/me/diary', {
          day: dayOffset(days - 1 - i),
          mood,
          sleep,
          anxiety,
          ...(rnd() < 0.3 ? { note: pick(DIARY_NOTES) } : {}),
        });
      }
    });
  }

  // Переписка: 2–3 сообщения пациента, затем ответы специалистов (после окна «Отменить»).
  const sent = [];
  for (const p of mine) {
    const c = pClients[p.key];
    if (!c) continue;
    const to = idOf(p.clinicians[0]);
    const count = 2 + Math.floor(rnd() * 2);
    for (let i = 0; i < count; i += 1) {
      const text = PATIENT_TEXTS[(sent.length + i) % PATIENT_TEXTS.length];
      const ok = await step(`сообщение ${p.key} → ${p.clinicians[0]}`, () => c.post('/api/v1/me/messages', { text, to_clinician_id: to }).then(must));
      if (ok) sent.push({ patient: p, to: p.clinicians[0] });
    }
  }

  // Нежелательные явления и визиты у части пациентов.
  for (const [i, p] of mine.entries()) {
    const c = pClients[p.key];
    if (c && i % 4 === 0)
      await step(`НЯ ${p.key}`, () =>
        c
          .post('/api/v1/me/adverse-events', {
            symptoms: [pick(['nausea', 'dizziness', 'insomnia'])],
            text: 'Появилось на этой неделе, мешает не сильно.',
            started_on: dayOffset(2 + (i % 4)),
            severity: pick(['mild', 'noticeable']),
            related: pick(['yes', 'unknown']),
          })
          .then(must),
      );
    const doc = clients[p.clinicians[0]];
    if (doc && i % 2 === 0)
      await step(`визит ${p.key}`, () =>
        doc
          .post(`/api/v1/patients/${ids[p.key]}/visits`, {
            starts_at: new Date(Date.now() + (2 + i) * 86400000).toISOString(),
            format: i % 3 === 0 ? 'online' : 'in_person',
            place: i % 3 === 0 ? undefined : `кабинет ${10 + i}`,
            previsit_enabled: i % 4 === 0,
          })
          .then(must),
      );
  }

  // Планы лечения по МНН у части пациентов психиатров.
  const psyPatients = mine.filter((p) => ['psy1', 'psy2'].includes(p.clinicians[0]));
  for (const [i, p] of psyPatients.slice(0, 5).entries()) {
    const doc = clients[p.clinicians[0]];
    const name = ['сертралин', 'эсциталопрам', 'сертралин', 'миртазапин', 'эсциталопрам'][i];
    await step(`план лечения ${p.key} (${name})`, async () => {
      const found = must(await doc.get(`/api/v1/catalog/search?q=${encodeURIComponent(name)}&scope=inn`));
      const inn = (found.items || []).find((x) => x.kind === 'inn' && x.name.toLowerCase() === name);
      if (!inn) throw new Error(`нет МНН ${name} в каталоге`);
      const cur = must(await doc.get(`/api/v1/patients/${ids[p.key]}/plan`));
      const base = (cur.draft && cur.draft.version) || (cur.published && cur.published.version) || 1;
      const d = must(
        await doc.put(`/api/v1/patients/${ids[p.key]}/plan/draft`, {
          version: base,
          items: [{ inn_id: inn.id, dose: 10 * (i + 1), unit: 'мг', times: ['утро'] }],
        }),
      );
      return doc.post(`/api/v1/patients/${ids[p.key]}/plan/publish`, { version: d.version || base }).then(must);
    });
  }

  // Ответы специалистов — после окна «Отменить» сообщений пациентов.
  await sleep(WAIT_UNDO_MS);
  let r = 0;
  for (const m of sent.filter((_, i) => i % 3 !== 2)) {
    const doc = clients[m.to];
    if (!doc) continue;
    await step(`ответ ${m.to} → ${m.patient.key}`, () =>
      doc.post(`/api/v1/patients/${ids[m.patient.key]}/messages`, { text: CLINICIAN_TEXTS[r++ % CLINICIAN_TEXTS.length] }).then(must),
    );
  }
  db.close();
  console.log('готово (методики и тесты не добавлялись)');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
