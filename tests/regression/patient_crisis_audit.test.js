'use strict';
// covers: F-16, F-27, F-46, PD-16; аудит кризисных сценариев чата пациента (2026-10-26):
//  путь кода — формулировки с опечатками, «ё/е», регистром и разбивкой по сообщениям доходят до сигнала врачу;
//  путь модели — инструмент raise_crisis_signal и навык crisis_signal делают то же, что код (сигнал, карточка 112, кризисный режим);
//  кризисный режим не сбрасывается: новое сообщение без thread_id и перезагрузка страницы возвращают в тот же тред.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk } = require('../lib/client');
const F = require('../lib/flows');
const crisisGate = require('../../src/ai/crisisGate');
const person = (key, name, email) => ({
  key,
  R: 'R-02',
  role: 'patient',
  name,
  email,
  clinicians: ['psy1'],
  consents: ['base', 'ai'],
});
const ctx = useApp({
  extraPeople: [
    person('patJ', 'Юлия Аудитовая', 'pat.j@cc.example.test'),
    person('patK', 'Кирилл Аудитовый', 'pat.k@cc.example.test'),
    person('patL', 'Лев Аудитовый', 'pat.l@cc.example.test'),
  ],
});

const say = (text) => ({ mode: 'text', text });
const tool = (name, args = {}) => ({ mode: 'tool', name, arguments: args });
const ask = (p, text, threadId) => p.post('/api/v1/ai/patient/messages', { text, thread_id: threadId });
const escalations = (key) =>
  ctx.app.query('SELECT * FROM crisis_escalations WHERE patient_id = ? ORDER BY id', ctx.id(key));
const incidents = (key) =>
  ctx.app.query('SELECT count(*) n FROM crisis_incident_log WHERE patient_id = ?', ctx.id(key))[0].n;

// Формулировки, которые обязаны дать сигнал (review-required: словарь утверждает клинический владелец).
const MUST_TRIGGER = [
  'хочу покончить с собой',
  'Хочу ПОКОНЧИТЬ с собой!!!',
  'не хочу жить',
  'Я готов умереть',
  'готова умереть',
  'покончу с собой сегодня',
  'покончу с собой',
  'покончить с собй',
  'покончить с  собой',
  'покончить с собою',
  'хочу ум3реть',
  'хочу умерть',
  'не хочу больше жить',
  'жить не хочу',
  'мне больше не хочется жить',
  'я не хочу жи ть',
  'хочу себя убить',
  'убью себя',
  'я себя убью',
  'лучше бы я умер',
  'лучше бы мне умереть',
  'хочу сдохнуть',
  'хочу уйти из жизни',
  'хочу свести счёты с жизнью',
  'хочу свести счеты с жизнью',
  'повешусь',
  'вскрою вены',
  'наглотаюсь таблеток',
  'прыгну с окна',
  'не вижу смысла жить',
  'зачем мне жить',
  'жить незачем',
  'суицидальные мысли',
  'думаю о самоубийстве',
  'не хочу просыпаться',
  'Мне плохо, я готов покончить с собой',
  'Всё как обычно, работа, дом. А ещё я больше не хочу жить. Но ладно, пойду спать.',
  'I want to kill myself',
];

// Обычные фразы, которые не должны поднимать сигнал.
const MUST_NOT_TRIGGER = [
  'не хочу шить',
  'умираю со смеху',
  'жить в Москве дорого',
  'хочу спать',
  'когда лекарство начнёт действовать?',
  'мне плохо спится',
  'хочу уехать в отпуск',
  'надо жить полной жизнью, говорит врач',
];

test('словарь кода: формулировки с опечатками, ё/е, регистром и склейкой пробелов дают кризис', () => {
  const missed = MUST_TRIGGER.filter((t) => !crisisGate.screen(t).crisis);
  assert.deepEqual(missed, [], 'пропущенные формулировки');
});

test('словарь кода: обычные фразы кризис не дают', () => {
  const wrong = MUST_NOT_TRIGGER.filter((t) => crisisGate.screen(t).crisis);
  assert.deepEqual(wrong, [], 'ложные срабатывания');
});

test('реальный маршрут чата: каждая формулировка даёт карточку 112, запись сигнала врачу и кризисный тред, модель не вызвана', async () => {
  const p = await ctx.as('patA');
  ctx.app.ai.reset();
  const failed = [];
  let threadId = null;
  let callsAfterFirst = null;
  for (const phrase of MUST_TRIGGER) {
    const before = incidents('patA');
    const r = await ask(p, phrase, threadId);
    if (callsAfterFirst === null) callsAfterFirst = ctx.app.ai.calls().length;
    const body = r.body || {};
    const ok =
      r.status >= 200 &&
      r.status < 300 &&
      body.crisis &&
      body.crisis.contacts[0].phone === '112' &&
      body.crisis_thread &&
      incidents('patA') > before;
    if (!ok) failed.push(phrase);
    if (ok && !threadId) threadId = body.crisis_thread.id;
  }
  assert.deepEqual(failed, [], 'в маршруте потерян сигнал');
  // первая фраза открывает кризисный тред без модели (PD-16); дальше разговор в треде ведёт модель или сценарий
  assert.equal(callsAfterFirst, 0, 'до модели кризисная фраза не доходит (PD-16)');
});

test('сигнал в середине разговора о другом: тред обычный, потом кризисная фраза — сигнал и кризисный режим', async () => {
  const p = await ctx.as('patB');
  ctx.app.ai.reset();
  ctx.app.ai.queue(say('Лекарство обычно действует не сразу. Спроси врача.'));
  const first = expectOk(await ask(p, F.CALM_PHRASE));
  assert.ok(!first.crisis);
  const r = expectOk(await ask(p, 'знаешь, я больше не хочу жить', first.thread.id));
  assert.ok(r.crisis, 'карточка 112');
  assert.ok(r.crisis_thread, 'кризисный тред');
  assert.equal(escalations('patB').length, 1);
  assert.equal(ctx.app.query('SELECT mode FROM ai_threads WHERE id = ?', r.crisis_thread.id)[0].mode, 'crisis');
});

test('сигнал, сказанный двумя сообщениями подряд («не хочу» / «жить»), не теряется', async () => {
  const p = await ctx.as('patH');
  ctx.app.ai.reset();
  ctx.app.ai.queue(say('Я слушаю. Что случилось?'));
  const a = expectOk(await ask(p, 'Мне так плохо, я просто не хочу'));
  assert.ok(!a.crisis);
  const b = expectOk(await ask(p, 'больше жить', a.thread.id));
  assert.ok(b.crisis, 'склейка двух сообщений распознана');
  assert.equal(escalations('patH').length, 1);
});

test('режим не сбрасывается: сообщение без thread_id и после «перезагрузки» уходит в тот же кризисный тред', async () => {
  const p = await ctx.as('patI');
  ctx.app.ai.reset();
  const r = expectOk(await F.patientAsk(p, 'хочу покончить с собой'));
  const id = r.crisis_thread.id;
  ctx.app.ai.queue(
    tool('assess_crisis', {
      level: 'active_ideation',
      safe_now: 'unknown',
      confidence: 'medium',
      note: 'Говорит о суициде.',
    }),
    say('Я рядом. Ты сейчас в безопасности?'),
  );
  const next = expectOk(await F.patientAsk(p, 'да нормально все'));
  assert.equal(next.thread.id, id, 'тот же тред');
  assert.ok(next.crisis_thread, 'кризисный режим сохранён');
  assert.equal(next.reply.text, 'Я рядом. Ты сейчас в безопасности?');
  const list = expectOk(await p.get('/api/v1/ai/threads?purpose=patient_assistant')).items;
  const crisis = list.find((t) => t.id === id);
  assert.equal(crisis.mode, 'crisis');
  assert.ok(['new', 'in_work'].includes(crisis.crisis.status), 'по списку страница находит активный кризисный тред');
});

test('путь модели: навык и инструмент raise_crisis_signal дают сигнал, карточку 112 и кризисный режим', async () => {
  const q = await ctx.as('patC');
  ctx.app.ai.reset();
  ctx.app.ai.queue(
    tool('raise_crisis_signal', { reason: 'Говорит, что всё бессмысленно и не хочет продолжать.' }),
    say('Обычный ответ модели, который пациенту показывать не нужно.'),
  );
  const r = expectOk(await F.patientAsk(q, 'всё бессмысленно, я больше не могу так, лучше бы всё закончилось'));
  const first = ctx.app.ai.calls()[0];
  assert.ok(
    first.tools.some((t) => t.name === 'raise_crisis_signal'),
    'инструмент передан модели',
  );
  assert.ok(
    first.tools.some((t) => t.name === 'use_skill'),
    'навык crisis_signal доступен',
  );
  assert.match(first.system, /crisis_signal/, 'навык описан в промпте');
  assert.ok(r.crisis, 'карточка 112');
  assert.equal(r.crisis.contacts[0].phone, '112');
  assert.ok(r.crisis_thread, 'кризисный режим');
  assert.equal(r.reply.status, 'crisis');
  assert.match(r.reply.text, /ты сейчас в безопасности/);
  assert.equal(escalations('patC').length, 1, 'сигнал создан');
  const th = ctx.app.query('SELECT * FROM ai_threads WHERE id = ?', r.crisis_thread.id)[0];
  assert.equal(th.mode, 'crisis');
  assert.equal(th.crisis_escalation_id, escalations('patC')[0].id);
});

test('путь модели: навык вызван без инструмента — сервер всё равно поднимает сигнал', async () => {
  const p = await ctx.as('patJ');
  ctx.app.ai.reset();
  ctx.app.ai.queue(tool('use_skill', { name: 'crisis_signal', input: 'не вижу выхода' }), say('Я рядом.'));
  const r = expectOk(await ask(p, 'ничего не имеет смысла, дальше никак'));
  assert.ok(r.crisis && r.crisis_thread, 'сигнал и кризисный режим по флагу навыка');
  assert.equal(escalations('patJ').length, 1);
  assert.equal(r.crisis_thread.adopted, true, 'обычный тред стал кризисным, история сохранена');
  const th = ctx.app.query('SELECT mode FROM ai_threads WHERE id = ?', r.thread.id)[0];
  assert.equal(th.mode, 'crisis');
  // следующее сообщение без thread_id остаётся в кризисном треде; модель получила только assess_crisis
  ctx.app.ai.queue(
    tool('assess_crisis', {
      level: 'distress_no_risk',
      safe_now: 'unknown',
      confidence: 'low',
      note: 'Тяжело, о смерти не говорит.',
    }),
    say('Расскажи, где ты сейчас?'),
  );
  const next = expectOk(await F.patientAsk(p, 'не знаю'));
  assert.equal(next.thread.id, r.thread.id);
  assert.deepEqual(
    ctx.app.ai
      .calls()
      .at(-2)
      .tools.map((t) => t.name),
    ['assess_crisis'],
  );
});

test('кризисный ход: служебные метки [0] из ответа модели убираются, первое сообщение спрашивает о случайности и безопасности', async () => {
  const p = await ctx.as('patK');
  ctx.app.ai.reset();
  const r = expectOk(await F.patientAsk(p, 'хочу покончить с собой'));
  assert.match(r.reply.text, /случайно/);
  assert.match(r.reply.text, /в безопасности\?/);
  ctx.app.ai.queue(say('Я рядом [0]. Что сейчас происходит? [1, 2]'));
  const t = expectOk(await ask(p, 'не знаю', r.crisis_thread.id));
  assert.ok(t.reply.text.startsWith('Я рядом. Что сейчас происходит?'));
  assert.doesNotMatch(t.reply.text, /\[\d/);
});

test('кризисный ход: заглушка провайдера заменяется сценарием, вопрос о случайности дописывается, «112» не повторяется', async () => {
  const p = await ctx.as('patL');
  ctx.app.ai.reset();
  const r = expectOk(await F.patientAsk(p, 'жить не хочу'));
  const id = r.crisis_thread.id;
  ctx.app.ai.queue(
    say(
      'Генеративные языковые модели могут создавать некорректные ответы. Ответы на чувствительные темы временно ограничены.',
    ),
  );
  const t1 = expectOk(await ask(p, 'не знаю', id));
  assert.equal(t1.reply.ai_generated, false, 'заглушка не показана, ответ по сценарию');
  assert.doesNotMatch(t1.reply.text, /языковые модели/);
  ctx.app.ai.queue(say('Я рядом. Если станет опаснее, позвони 112.'));
  const t2 = expectOk(await ask(p, 'тяжело', id));
  assert.match(t2.reply.text, /\?$/, 'вопроса в ответе не было: дописан один');
  assert.match(t2.reply.text, /Ты сейчас в безопасности\?$/, 'о случайности уже спрашивали (сценарий)');
  assert.equal((t2.reply.text.match(/\?/g) || []).length, 1);
  ctx.app.ai.queue(say('Я с тобой. Позвони 112, если опасно. Расскажи, что ты видишь вокруг?'));
  const t3 = expectOk(await ask(p, 'ничего', id));
  assert.doesNotMatch(t3.reply.text, /112/, 'номер недавно звучал, повтор убран');
  assert.equal(
    (t3.reply.text.match(/\?/g) || []).length,
    1,
    'после двух ответов и при наличии вопроса ничего не дописывается',
  );
  ctx.app.ai.queue(
    tool('assess_crisis', { level: 'accidental', safe_now: 'yes', confidence: 'high', note: 'Сказал, что случайно.' }),
    say('Хорошо, что так. Как ты сейчас?'),
  );
  const t4 = expectOk(await ask(p, 'это вышло случайно', id));
  assert.equal(t4.reply.text, 'Хорошо, что так. Как ты сейчас?', 'после «случайно» вопрос не дописывается');
});

test('кризисный ход: строка «Позвони 112» не дублируется, если модель уже назвала номер', async () => {
  const p = await ctx.as('patK');
  const th = ctx.app.query("SELECT id FROM ai_threads WHERE mode='crisis' AND owner_user_id=?", ctx.id('patK'))[0].id;
  ctx.app.ai.queue(
    tool('assess_crisis', { level: 'plan_or_intent', safe_now: 'no', confidence: 'high', note: 'Есть план.' }),
    say('Позвони, пожалуйста, на 112 сейчас, я остаюсь с тобой. Кто рядом?'),
  );
  const t = expectOk(await ask(p, 'у меня есть таблетки', th));
  assert.doesNotMatch(t.reply.text, /Мне важна твоя безопасность прямо сейчас/);
});
