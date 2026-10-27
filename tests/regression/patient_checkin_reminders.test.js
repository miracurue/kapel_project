'use strict';
// covers: F-27, F-45; check-in в чате пациента и напоминания о лекарствах внутри системы (решение владелицы 2026-10-26):
// модель только предлагает запись в дневник, сохраняет пациент; напоминания строит код по плану и отметкам приёма.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk } = require('../lib/client');
const F = require('../lib/flows');
const { dueReminders } = require('../../src/modules/patient/reminders');
const chatPage = require('../../src/modules/patient/chatPage');
const ru = require('../../locales/ru.json');
const ctx = useApp();

const tool = (name, args = {}) => ({ mode: 'tool', name, arguments: args });
const say = (text) => ({ mode: 'text', text });
const entries = (key) => ctx.app.query('SELECT count(*) n FROM mood_entries WHERE patient_id = ?', ctx.id(key))[0].n;

test('check-in: модель предлагает запись, в дневник она не попадает; сохраняет пациент тем же запросом, что и форма дневника', async () => {
  const p = await ctx.as('patB');
  ctx.app.ai.reset();
  ctx.app.ai.queue(
    tool('propose_diary_entry', { mood: 3, sleep: 'bad', anxiety: 'some', note: 'Плохо спала, на работе нервничала' }),
    say('Предлагаю записать, подтверди кнопкой.'),
  );
  const before = entries('patB');
  const r = expectOk(
    await F.patientAsk(p, 'Помоги заполнить дневник. Спала плохо, настроение так себе, немного тревожно'),
  );
  assert.deepEqual(r.diary_proposal, {
    mood: 3,
    sleep: 'bad',
    anxiety: 'some',
    note: 'Плохо спала, на работе нервничала',
  });
  assert.equal(entries('patB'), before, 'без подтверждения запись не создана');
  const saved = expectOk(await p.post('/api/v1/me/diary', r.diary_proposal));
  assert.ok(saved.entry.id);
  assert.equal(entries('patB'), before + 1);
});

test('check-in: пустое предложение не создаётся; значения вне допустимых отбрасываются', async () => {
  const p = await ctx.as('patB');
  ctx.app.ai.reset();
  ctx.app.ai.queue(tool('propose_diary_entry', { mood: 9, sleep: 'wonderful' }), say('Расскажи, как спалось?'));
  const r = expectOk(await F.patientAsk(p, 'Давай заполним дневник'));
  assert.equal(r.diary_proposal, undefined);
  ctx.app.ai.queue(tool('propose_diary_entry', { mood: 4, sleep: 'wonderful' }), say('Записать?'));
  const r2 = expectOk(await F.patientAsk(p, 'Настроение хорошее'));
  assert.deepEqual(r2.diary_proposal, { mood: 4, sleep: null, anxiety: null, note: null });
});

test('напоминание о лекарстве: приём по плану появляется со времени слота, пропадает после отметки, тесты — отдельной карточкой', async () => {
  const psy = await ctx.as('psy1');
  const patient = await ctx.as('patA');
  await F.sertralinePrescribedAndAccepted(ctx.app, psy, patient, ctx.id('patA'));
  const db = ctx.app.db();
  try {
    const tomorrow = (h) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(h, 0, 0, 0);
      return d;
    };
    const early = dueReminders(db, { patientId: ctx.id('patA'), now: tomorrow(6), timezone: 'UTC' }).filter(
      (r) => r.kind === 'medication',
    );
    assert.equal(early.length, 0, 'до 8:00 утренний приём ещё не напоминается');
    const due = dueReminders(db, { patientId: ctx.id('patA'), now: tomorrow(12), timezone: 'UTC' }).filter(
      (r) => r.kind === 'medication',
    );
    assert.equal(due.length, 1);
    assert.equal(due[0].slot, 'утро');
    assert.equal(due[0].slotKey, 'morning');
    assert.match(due[0].names.join(), /сертралин/i);
    assert.equal(due[0].targets[0].type, 'plan_item');
    // та же отметка, что отправляет кнопка «Принято» в чате
    const today = new Date().toISOString().slice(0, 10);
    expectOk(
      await patient.post('/api/v1/me/med-marks', {
        target: due[0].targets[0],
        day: today,
        slot: due[0].slot,
        status: 'taken',
      }),
    );
    const logged = db.prepare('SELECT status FROM med_log WHERE patient_id=? AND day=?').all(ctx.id('patA'), today);
    assert.equal(logged[0].status, 'taken');
  } finally {
    db.close();
  }
});

test('карточки напоминаний в разметке чата: кнопки с ключами локали, без напоминаний блока нет', () => {
  const t = (key, fallback) => ru[key] || fallback || key;
  const withCards = chatPage.render({
    t,
    reminders: [
      {
        kind: 'medication',
        slot: 'morning',
        day: '2026-10-27',
        names: ['сертралин'],
        targets: [{ type: 'plan_item', id: 1 }],
      },
      { kind: 'test', names: ['PHQ-9'] },
    ],
  });
  for (const key of [
    'msg.reminder.title',
    'msg.reminder.med.taken',
    'msg.reminder.med.later',
    'msg.reminder.test.open',
    'msg.chat.checkin.idea',
  ])
    assert.ok(withCards.includes(`data-testid="${key}"`), key);
  assert.ok(withCards.includes('сертралин'));
  assert.ok(!chatPage.render({ t, reminders: [] }).includes('msg.reminder.title'));
});

test('вопрос о форме обращения: пока не отвечен — карточка в чате и значок на вкладке «Чат» на любой странице; ответ снимает оба', async () => {
  const p = await ctx.as('patC');
  const html = (r) => String(r.body);
  const diary = await p.get('/app?tab=diary');
  assert.equal(diary.status, 200);
  const count = (r) =>
    Number((html(r).match(/data-testid="msg\.reminder\.badge"[^>]*>(\d+)</) || [])[1] || 0);
  assert.ok(count(diary) >= 1, 'значок виден и вне чата');
  const chat = await p.get('/app?tab=chat');
  assert.match(html(chat), /data-testid="msg\.reminder\.profile\.f"/);
  assert.match(html(chat), /data-testid="msg\.reminder\.profile\.n"/);
  const patched = expectOk(await p.patch('/api/v1/me/prefs', { address_form: 'f' }));
  assert.ok(patched.ok);
  const after = await p.get('/app?tab=chat');
  assert.doesNotMatch(html(after), /msg\.reminder\.profile\.f/);
  assert.equal(
    count(after),
    count(diary) - 1,
    'значок уменьшился на один (число зависит от времени суток: вечером добавляется дневник)',
  );
});

test('форма обращения доходит до помощника: выбранный род попадает в сведения о собеседнике, «нейтрально» — тоже ответ', async () => {
  const p = await ctx.as('patC');
  ctx.app.ai.reset();
  expectOk(await F.patientAsk(p, 'Расскажи про дневник'));
  const system = String(ctx.app.ai.calls()[0].system);
  assert.match(system, /пол: женский/);
  const q = await ctx.as('patD');
  expectOk(await q.patch('/api/v1/me/prefs', { address_form: 'n' }));
  assert.equal(ctx.app.query('SELECT address_form_set s FROM user_prefs WHERE user_id = ?', ctx.id('patD'))[0].s, 1);
  ctx.app.ai.reset();
  expectOk(await F.patientAsk(q, 'Расскажи про дневник'));
  assert.match(String(ctx.app.ai.calls()[0].system), /пол: не указан/);
});

test('вечернее напоминание о дневнике: с 19:00, пока за сегодня ничего нет; запись снимает его', () => {
  const db = ctx.app.db();
  try {
    const at = (h) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + 2);
      d.setUTCHours(h, 0, 0, 0);
      return d;
    };
    const diary = (h) =>
      dueReminders(db, { patientId: ctx.id('patD'), now: at(h), timezone: 'UTC' }).filter((r) => r.kind === 'diary');
    assert.equal(diary(18).length, 0, 'до 19:00 не напоминаем');
    assert.equal(diary(20).length, 1);
    const day = at(20).toISOString().slice(0, 10);
    assert.equal(diary(20)[0].day, day);
    db.prepare('INSERT INTO mood_entries(patient_id,entry_date,mood,created_at) VALUES (?,?,?,?)').run(
      ctx.id('patD'),
      day,
      3,
      new Date().toISOString(),
    );
    assert.equal(diary(20).length, 0, 'запись за день снимает напоминание');
  } finally {
    db.close();
  }
});

test('карточка дневника в разметке чата: кнопка запускает check-in через подсказку, есть ссылка на дневник', () => {
  const t = (key, fallback) => ru[key] || fallback || key;
  const html = chatPage.render({ t, reminders: [{ kind: 'diary', day: '2026-10-27' }] });
  assert.ok(html.includes('data-testid="msg.reminder.diary.help"'));
  assert.ok(html.includes(`data-idea="${ru['msg.chat.checkin.idea']}"`));
  assert.ok(html.includes('href="/app?tab=diary"'));
});

const addVisit = (patient, doctor, hoursAhead, extra = {}) => {
  const db = ctx.app.db();
  try {
    const starts = new Date(Date.now() + hoursAhead * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const id = Number(
      db
        .prepare(
          "INSERT INTO visits(patient_id,clinician_id,starts_at,format,place,prepare_enc,previsit_enabled,status,visible_from,created_at) VALUES (?,?,?,?,?,?,?,'scheduled',NULL,?)",
        )
        .run(
          ctx.id(patient),
          ctx.id(doctor),
          starts,
          extra.format || 'in_person',
          extra.place || null,
          extra.prepare || null,
          extra.previsit ? 1 : 0,
          starts,
        ).lastInsertRowid,
    );
    if (extra.previsit)
      db.prepare("INSERT INTO previsit_forms(patient_id,visit_id,requested_by,status) VALUES (?,?,?,'open')").run(
        ctx.id(patient),
        id,
        ctx.id(doctor),
      );
    return id;
  } finally {
    db.close();
  }
};
const toolMessage = (calls) => (calls[1].messages.find((m) => m.role === 'tool') || {}).content || '';

test('подготовка к визиту: инструменты отдают визит и факты периода без баллов; список предлагается, врачу уходит по кнопке', async () => {
  addVisit('patA', 'psy1', 30, { place: 'кабинет 12', prepare: 'паспорт и список лекарств', previsit: true });
  const p = await ctx.as('patA');
  ctx.app.ai.reset();
  ctx.app.ai.queue(tool('get_my_visits'), say('Визит скоро. С чего начнём?'));
  expectOk(await F.patientAsk(p, 'Хочу подготовиться к визиту'));
  const visits = toolMessage(ctx.app.ai.calls());
  assert.match(visits, /Визит \d{2}\.\d{2}\.\d{4} в \d{2}:\d{2}, очно, место: кабинет 12/);
  assert.match(visits, /Врач просил подготовить: паспорт и список лекарств/);
  assert.match(visits, /Анкета перед визитом: ещё не заполнена/);
  ctx.app.ai.reset();
  ctx.app.ai.queue(tool('get_visit_prep'), say('Вот что вижу за период.'));
  expectOk(await F.patientAsk(p, 'Что было с прошлого визита?'));
  const prep = toolMessage(ctx.app.ai.calls());
  assert.match(prep, /Период: с /);
  assert.match(prep, /Дневник: /);
  assert.match(prep, /Приём лекарств: /);
  assert.match(prep, /Тесты|Пройденные тесты/);
  assert.doesNotMatch(prep, /умеренно-тяжёлая|\b17\b/, 'баллы и уровни не отдаются');
  ctx.app.ai.reset();
  ctx.app.ai.queue(
    tool('propose_visit_note', { questions: ['Можно ли пить кофе?', ' '], to_tell: ['Сон стал хуже'] }),
    say('Собрала список.'),
  );
  const count = () => ctx.app.query('SELECT count(*) n FROM care_messages WHERE patient_id = ?', ctx.id('patA'))[0].n;
  const before = count();
  const r = expectOk(await F.patientAsk(p, 'Вопросы: кофе. Расскажу про сон'));
  assert.equal(
    r.visit_note_proposal.text,
    'К визиту.\nВопросы:\n1. Можно ли пить кофе?\nХочу рассказать:\n- Сон стал хуже',
  );
  assert.equal(count(), before, 'модель сама ничего не отправила');
  expectOk(await p.post('/api/v1/me/messages', { text: r.visit_note_proposal.text }));
  assert.equal(count(), before + 1);
  ctx.app.ai.reset();
  ctx.app.ai.queue(tool('propose_visit_note', { questions: [] }), say('Что хочешь спросить?'));
  assert.equal(expectOk(await F.patientAsk(p, 'Подготовь список')).visit_note_proposal, undefined);
});

test('напоминание о визите: за 72 часа и ближе; дальше не напоминаем; карточка ведёт в чат с готовой подсказкой', () => {
  addVisit('patD', 'psy1', 100);
  const db = ctx.app.db();
  try {
    const visit = (patient) =>
      dueReminders(db, { patientId: ctx.id(patient), now: new Date(), timezone: 'UTC' }).filter(
        (r) => r.kind === 'visit',
      );
    assert.equal(visit('patD').length, 0, 'визит через 100 часов');
    addVisit('patD', 'psy1', 40, { format: 'remote' });
    const near = visit('patD');
    assert.equal(near.length, 1);
    assert.equal(near[0].format, 'remote');
    assert.match(near[0].when, /^\d{2}\.\d{2} в \d{2}:\d{2}$/);
  } finally {
    db.close();
  }
  const t = (key, fallback) => ru[key] || fallback || key;
  const html = chatPage.render({ t, reminders: [{ kind: 'visit', id: 1, when: '28.10 в 15:00', format: 'remote' }] });
  assert.ok(html.includes('data-testid="msg.reminder.visit.prepare"'));
  assert.ok(html.includes(`data-idea="${ru['msg.chat.visit_prep.idea']}"`));
  assert.ok(html.includes('28.10 в 15:00, дистанционно'));
});
