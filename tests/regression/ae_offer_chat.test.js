'use strict';
// covers: F-30, F-32, F-45, PD-02; предложение оформить побочное действие в чате: слово из словаря - карточка сразу,
// иначе модель сама вызывает навык ae_offer*, не чаще раза в 12 часов, врач и психолог только по правилам сервера.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk } = require('../lib/client');
const F = require('../lib/flows');
const ctx = useApp();

const VAGUE = 'Мне как-то нехорошо после новой таблетки';
const toolNames = (call) => (call.tools || []).map((t) => t.name);
// Навык crisis_signal есть у чата пациента всегда; «предложен навык» здесь — любой навык, кроме него.
const skillOffered = (call) => {
  const def = (call.tools || []).find((t) => t.name === 'use_skill');
  return Boolean(def && def.parameters.properties.name.enum.some((n) => n !== 'crisis_signal'));
};
const useSkill = (name) => ({ mode: 'tool', name: 'use_skill', arguments: { name, input: 'сообщение' } });
const OFFER_TEXT = 'Возможно, это побочное действие. Хотите рассказать подробнее?';

function ageOffers(hours) {
  const db = ctx.app.db();
  try {
    const at = new Date(Date.now() - hours * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
    db.prepare('UPDATE ai_messages SET created_at=? WHERE flags_json LIKE \'%"ae_offer":true%\'').run(at);
  } finally {
    db.close();
  }
}
const markedOffers = () =>
  ctx.app.query('SELECT count(*) n FROM ai_messages WHERE flags_json LIKE \'%"ae_offer":true%\'')[0].n;

test('пациент: слово из словаря - карточка сразу, навык и подзапрос модели не нужны', async () => {
  const p = await ctx.as('patA');
  ctx.app.ai.reset();
  const r = expectOk(await F.patientAsk(p, 'У меня тошнит после таблеток'));
  assert.ok(r.ae_suggestion, 'карточка по словарю');
  assert.equal(r.ae_offer, undefined);
  const calls = ctx.app.ai.calls();
  assert.equal(calls.length, 1);
  assert.ok(!skillOffered(calls[0]), 'навык ae_offer при совпадении словаря не предлагается');
  assert.equal(markedOffers(), 0);
});

test('пациент: слов нет, модель вызвала навык - в ответе ae_offer вместе с текстом модели', async () => {
  const p = await ctx.as('patA');
  ctx.app.ai.reset();
  ctx.app.ai.queue(useSkill('ae_offer'), { mode: 'text', text: OFFER_TEXT });
  const r = expectOk(await F.patientAsk(p, VAGUE));
  assert.deepEqual(r.ae_offer, { prefill: {} });
  assert.equal(r.ae_suggestion, undefined);
  assert.equal(r.reply.text, OFFER_TEXT);
  const calls = ctx.app.ai.calls();
  assert.equal(calls.length, 2, 'основной вызов и ответ после навыка; подзапроса навыка нет');
  assert.ok(skillOffered(calls[0]));
  assert.match(JSON.stringify(calls[1].messages), /Инструкция навыка ae_offer/);
  assert.equal(markedOffers(), 1, 'предложение зафиксировано после ответа');
});

test('пациент: повторно в течение 12 часов не предлагается (другой тред), через 12 часов снова', async () => {
  const p = await ctx.as('patA');
  ctx.app.ai.reset();
  const r = expectOk(await F.patientAsk(p, VAGUE));
  assert.equal(r.ae_offer, undefined);
  assert.ok(!skillOffered(ctx.app.ai.calls()[0]), 'навык не передан модели');
  ageOffers(13);
  ctx.app.ai.reset();
  ctx.app.ai.queue(useSkill('ae_offer'), { mode: 'text', text: OFFER_TEXT });
  assert.ok(expectOk(await F.patientAsk(p, VAGUE)).ae_offer, 'через 13 часов можно снова');
});

test('пациент: запись НЯ из чата тоже гасит предложение на 12 часов', async () => {
  const p = await ctx.as('patB');
  const thread_id = expectOk(await F.patientAsk(p, 'Здравствуйте')).thread.id;
  expectOk(
    await p.post('/api/v1/me/adverse-events', {
      symptoms: ['nausea'],
      text: 'Синтетика',
      severity: 'mild',
      related: 'yes',
      source: 'ai_chat',
      thread_id,
      med: { kind: 'other', name: 'Мелатонин' },
    }),
  );
  ctx.app.ai.reset();
  ctx.app.ai.queue(useSkill('ae_offer'), { mode: 'text', text: OFFER_TEXT });
  const r = expectOk(await F.patientAsk(p, VAGUE));
  assert.equal(r.ae_offer, undefined);
  assert.ok(!skillOffered(ctx.app.ai.calls()[0]));
});

test('пациент: модель навык не вызвала - поля нет, предложение не фиксируется', async () => {
  const p = await ctx.as('patC');
  ctx.app.ai.reset();
  const before = markedOffers();
  const r = expectOk(await F.patientAsk(p, VAGUE));
  assert.ok(skillOffered(ctx.app.ai.calls()[0]), 'навык предложен');
  assert.equal(r.ae_offer, undefined);
  assert.equal(markedOffers(), before);
});

test('кризис по-прежнему первый: модель не вызывается, предложения нет', async () => {
  const p = await ctx.as('patA');
  ctx.app.ai.reset();
  const r = expectOk(await F.patientAsk(p, F.CRISIS_PHRASE));
  assert.ok(r.crisis);
  assert.equal(r.ae_offer, undefined);
  assert.equal(ctx.app.ai.calls().length, 0);
  // Кризисный режим остаётся, пока врач не обработает сигнал; остальные проверки идут как после обработки.
  const db = ctx.app.db();
  try {
    db.prepare("UPDATE crisis_escalations SET status='handled' WHERE patient_id=?").run(ctx.id('patA'));
  } finally {
    db.close();
  }
});

const ask = async (who, patient, text) => {
  const doc = await ctx.as(who);
  return expectOk(
    await doc.post('/api/v1/ai/clinician/messages', {
      patient_id: ctx.id(patient),
      text,
      chips: [{ type: 'patient', id: ctx.id(patient) }],
    }),
  );
};

test('специалист: без действующего препарата в плане предложений нет ни по словарю, ни по модели', async () => {
  for (const who of ['psy1', 'plg1']) {
    ctx.app.ai.reset();
    const r = await ask(who, 'patA', 'Пациент жалуется, что тошнит после таблеток');
    assert.equal(r.ae_offer, undefined, who);
    assert.ok(!skillOffered(ctx.app.ai.calls()[0]), `${who}: навыков в запросе нет`);
  }
});

test('психиатр: слово - ae_offer mode decision сразу; без слова - через навык; повтор не предлагается', async () => {
  const psy = await ctx.as('psy1');
  await F.sertralinePrescribedAndAccepted(ctx.app, psy, await ctx.as('patA'), ctx.id('patA'));
  ctx.app.ai.reset();
  let r = await ask('psy1', 'patA', 'Пациент жалуется, что тошнит после таблеток');
  assert.deepEqual(r.ae_offer, { prefill: {}, mode: 'decision' });
  assert.ok(!skillOffered(ctx.app.ai.calls()[0]), 'при слове из словаря навык не нужен');
  // сразу повторять нельзя
  ctx.app.ai.reset();
  r = await ask('psy1', 'patA', 'Опять тошнит у пациента');
  assert.equal(r.ae_offer, undefined);
  assert.ok(!skillOffered(ctx.app.ai.calls()[0]));
  ageOffers(13);
  // без слова: инструменты и навык вместе в одном запросе, вызов навыка не ломает цикл инструментов
  ctx.app.ai.reset();
  ctx.app.ai.queue({ mode: 'tool', name: 'get_overview', arguments: {} }, useSkill('ae_offer_clinician'), {
    mode: 'text',
    text: 'Отмечу: возможна реакция, запись можно оформить кнопкой ниже.',
  });
  r = await ask('psy1', 'patA', 'Пациент говорит, что после приёма дрожат руки');
  assert.deepEqual(r.ae_offer, { prefill: {}, mode: 'decision' });
  assert.match(r.reply.text, /возможна реакция/);
  const calls = ctx.app.ai.calls();
  assert.equal(calls.length, 3);
  assert.ok(toolNames(calls[0]).includes('get_overview') && skillOffered(calls[0]));
  assert.match(JSON.stringify(calls[2].messages), /Инструкция навыка ae_offer_clinician/);
  // модель навык не вызвала - поля нет
  ageOffers(13);
  ctx.app.ai.reset();
  assert.equal((await ask('psy1', 'patA', 'Пациент говорит, что после приёма дрожат руки')).ae_offer, undefined);
});

test('психолог: предложение только с психиатром и препаратом, mode to_psychiatrist, плана не видит', async () => {
  ctx.app.ai.reset();
  let r = await ask('plg1', 'patA', 'Пациент говорит, что тошнит после таблеток');
  assert.deepEqual(r.ae_offer, { prefill: {}, mode: 'to_psychiatrist' });
  ageOffers(13);
  ctx.app.ai.reset();
  ctx.app.ai.queue(useSkill('ae_offer_psychologist'), {
    mode: 'text',
    text: 'Сказанное пациентом можно передать психиатру кнопкой ниже.',
  });
  r = await ask('plg1', 'patA', 'Пациент рассказал, что дрожат руки после приёма');
  assert.deepEqual(r.ae_offer, { prefill: {}, mode: 'to_psychiatrist' });
  const seen = ctx.app.ai.seenText();
  assert.doesNotMatch(seen, /сертралин|золофт|Sertraline/i, 'состав плана психологу и его модели не раскрывается');
  assert.doesNotMatch(seen, /ae_offer_clinician/, 'навык психиатра психологу не предлагается');
  // у patI нет психиатра: система молчит
  ctx.app.ai.reset();
  r = await ask('plg1', 'patI', 'Пациент говорит, что тошнит после таблеток');
  assert.equal(r.ae_offer, undefined);
  assert.ok(!skillOffered(ctx.app.ai.calls()[0]));
});

test('каталог: новые навыки видны в админке', async () => {
  const admin = await ctx.as('admin1');
  const body = expectOk(await admin.get('/api/v1/admin/ai/prompts'));
  const keys = JSON.stringify(body);
  assert.match(keys, /skill\.ae_offer_clinician/);
  assert.match(keys, /skill\.ae_offer_psychologist/);
});

// ---- Пакет H: сведения о собеседнике, подсказка формы без тяжести и связи ----
function setSex(email, sex) {
  const db = ctx.app.db();
  try {
    db.prepare('UPDATE users SET sex=? WHERE email=?').run(sex, email);
  } finally {
    db.close();
  }
}
const FACTS_RE = /Сведения о собеседнике:\n((?:- .*\n?)+)/;
const factsOf = (system) => (FACTS_RE.exec(system) || [])[1] || '';

test('сведения о собеседнике: пациент - пол и признак психиатра, имени нет, блок после роли и до правил инструментов', async () => {
  const email = 'pata@cc.example.test';
  const row = ctx.app.query('SELECT email, full_name FROM users WHERE id=?', ctx.id('patA'))[0];
  const p = await ctx.as('patA');
  for (const [sex, word] of [['f', 'женский'], ['m', 'мужской'], ['na', 'не указан'], [null, 'не указан']]) {
    setSex(row.email, sex);
    ctx.app.ai.reset();
    expectOk(await F.patientAsk(p, 'Расскажи, как принимать лекарство'));
    const system = ctx.app.ai.calls()[0].system;
    const facts = factsOf(system);
    assert.ok(facts.includes(`пол: ${word}`), `пол ${sex}`);
    assert.match(facts, /закреплённый психиатр: есть/);
    assert.ok(!facts.includes(row.full_name) && !facts.includes(row.email), 'в блоке нет имени и почты');
    assert.ok(system.indexOf('Сведения о собеседнике') > system.indexOf('ИИ-помощник пациента'));
    assert.ok(system.indexOf('Сведения о собеседнике') < system.indexOf('Доступные навыки'));
  }
  void email;
  ctx.app.ai.reset();
  expectOk(await F.patientAsk(await ctx.as('patI'), 'Расскажи, как принимать лекарство'));
  assert.match(factsOf(ctx.app.ai.calls()[0].system), /закреплённого психиатра нет — не обещай/);
  const sys = ctx.app.ai.calls()[0].system;
  assert.match(sys, /на «ты»/, 'роль пациента v2');
});

test('сведения о собеседнике: психиатр и психолог - только пол, и только если он известен', async () => {
  const psy = ctx.app.query('SELECT email FROM users WHERE id=?', ctx.id('psy1'))[0].email;
  setSex(psy, 'm');
  ctx.app.ai.reset();
  await ask('psy1', 'patA', 'Покажи обзор пациента');
  assert.equal(factsOf(ctx.app.ai.calls()[0].system).trim(), '- пол: мужской');
  setSex(psy, 'na');
  ctx.app.ai.reset();
  await ask('psy1', 'patA', 'Покажи обзор пациента');
  assert.doesNotMatch(ctx.app.ai.calls()[0].system, /Сведения о собеседнике/);
  const plg = ctx.app.query('SELECT email FROM users WHERE id=?', ctx.id('plg1'))[0].email;
  setSex(plg, 'f');
  ctx.app.ai.reset();
  await ask('plg1', 'patA', 'Покажи обзор пациента');
  assert.equal(factsOf(ctx.app.ai.calls()[0].system).trim(), '- пол: женский');
  setSex(psy, null);
  setSex(plg, null);
});

test('сведения о собеседнике: у навыка-функции роли и блока нет; версии слоёв в журнале не меняются', async () => {
  const p = await ctx.as('patA');
  ageOffers(13);
  ctx.app.ai.reset();
  ctx.app.ai.queue({ mode: 'text', text: 'Понимаю.' }, { mode: 'tool', name: 'report_adverse_event', arguments: { symptoms: ['dizziness'] } });
  expectOk(await F.patientAsk(p, 'Синтетика: началась диарея с утра'));
  const sub = ctx.app.ai.calls().find((c) => /Ты извлекаешь из текста/.test(c.system || ''));
  assert.ok(sub, 'подзапрос навыка');
  assert.doesNotMatch(sub.system, /Сведения о собеседнике/);
  const layers = JSON.parse(ctx.app.query("SELECT prompt_layers_json FROM ai_audit WHERE purpose='patient_assistant' ORDER BY id DESC LIMIT 1")[0].prompt_layers_json);
  assert.ok(layers.every((l) => Object.keys(l).sort().join() === 'key,version'));
});

test('подсказка формы: в prefill только симптомы и препарат, без тяжести и связи (ae_suggestion и ae_offer)', async () => {
  const p = await ctx.as('patA');
  const viaDict = expectOk(await F.patientAsk(p, F.AE_PHRASE));
  assert.deepEqual(Object.keys(viaDict.ae_suggestion.prefill).sort(), ['med', 'symptoms']);
  ctx.app.ai.reset();
  ctx.app.ai.queue(
    { mode: 'text', text: 'Понимаю.' },
    { mode: 'tool', name: 'report_adverse_event', arguments: { symptoms: ['dizziness'], severity: 3, related: 'likely', med: 'сертралин' } },
  );
  const viaModel = expectOk(await F.patientAsk(p, 'Синтетика: началась диарея, третий день'));
  assert.ok(viaModel.ae_suggestion);
  assert.deepEqual(Object.keys(viaModel.ae_suggestion.prefill).sort(), ['med', 'symptoms'], 'тяжесть и связь из модели не берутся');
  ageOffers(13);
  ctx.app.ai.reset();
  ctx.app.ai.queue(useSkill('ae_offer'), { mode: 'text', text: OFFER_TEXT });
  const offer = expectOk(await F.patientAsk(p, VAGUE));
  assert.ok(offer.ae_offer);
  assert.equal('severity' in offer.ae_offer.prefill, false);
  assert.equal('related' in offer.ae_offer.prefill, false);
});
