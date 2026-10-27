'use strict';
// covers: F-16, F-27, F-46, PD-16; кризисный режим чата пациента (.agents/tasks/2026-10-26-patient-crisis-mode.md):
// первый ход по сценарию без модели, затем ИИ с оценкой для врача; оценка сигнал не отменяет, а тяжёлая его поднимает;
// при сбое модели, без согласия на ИИ и при срабатывании фильтра разговор идёт по сценарию.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk } = require('../lib/client');
const F = require('../lib/flows');
const crisisMode = require('../../src/ai/crisisMode');
const ctx = useApp();

const assess = (over = {}) => ({
  mode: 'tool',
  name: 'assess_crisis',
  arguments: {
    level: 'passive_ideation',
    safe_now: 'unknown',
    alone: 'yes',
    means: 'unknown',
    confidence: 'medium',
    note: 'Говорит, что устал жить, плана не называет.',
    ...over,
  },
});
const say = (text) => ({ mode: 'text', text });
const ask = (p, text, threadId) => p.post('/api/v1/ai/patient/messages', { text, thread_id: threadId });
const escalationOf = (key) =>
  ctx.app.query('SELECT * FROM crisis_escalations WHERE patient_id = ? ORDER BY id DESC LIMIT 1', ctx.id(key))[0];

async function startCrisis(key) {
  const p = await ctx.as(key);
  ctx.app.ai.reset();
  const r = expectOk(await F.patientAsk(p, F.CRISIS_PHRASE));
  return { p, r };
}

test('первая кризисная фраза: карточка 112, тред режима crisis и сценарное сообщение, модель не вызвана', async () => {
  const { r } = await startCrisis('patA');
  assert.ok(r.crisis, 'карточка 112');
  assert.equal(r.crisis.contacts[0].phone, '112');
  assert.equal(r.reply.status, 'crisis');
  assert.match(r.reply.text, /ты сейчас в безопасности/);
  assert.equal(r.reply.ai_generated, false, 'первое сообщение — сценарий, не модель');
  assert.equal(r.crisis_thread.status, 'new');
  assert.equal(ctx.app.ai.calls().length, 0, 'модель не вызывалась (PD-16)');
  const esc = escalationOf('patA');
  const th = ctx.app.query('SELECT * FROM ai_threads WHERE id = ?', r.crisis_thread.id)[0];
  assert.equal(th.mode, 'crisis');
  assert.equal(th.crisis_escalation_id, esc.id);
  assert.equal(
    ctx.app.query('SELECT count(*) n FROM ai_messages WHERE thread_id = ?', th.id)[0].n,
    2,
    'фраза пациента и сценарное сообщение',
  );
});

test('ход разговора: ответ модели после оценки; оценка видна врачу, сигнал не закрыт и уровень не понижен', async () => {
  const { p, r } = await startCrisis('patB');
  const before = escalationOf('patB');
  ctx.app.ai.queue(
    assess({ level: 'accidental', confidence: 'low', note: 'Пациент пишет, что нажал случайно.' }),
    say('Спасибо, что ответил. Я рядом. Как ты сейчас?'),
  );
  const turn = expectOk(await ask(p, 'Это вышло случайно', r.crisis_thread.id));
  assert.equal(turn.reply.text, 'Спасибо, что ответил. Я рядом. Как ты сейчас?');
  assert.equal(turn.reply.ai_generated, true);
  assert.equal(ctx.app.ai.calls().length, 2, 'вызов с инструментом и ответ после него');
  assert.deepEqual(
    ctx.app.ai.calls()[0].tools.map((t) => t.name),
    ['assess_crisis'],
  );
  const after = escalationOf('patB');
  assert.equal(after.status, 'new', 'ИИ сигнал не закрывает');
  assert.equal(after.tier, before.tier, 'и уровень не понижает');
  const doc = await ctx.as('psy2');
  const card = await F.crisisSignalFor(doc, ctx.id('patB'));
  assert.equal(card.ai_assessment.level, 'accidental');
  assert.match(card.ai_assessment.note, /нажал случайно/);
  assert.ok(card.quote, 'цитата по-прежнему на карточке');
  assert.equal(card.status, 'new');
});

test('тяжёлая оценка поднимает сигнал до уровня 3, уведомляет врача и добавляет «звони 112» из кода', async () => {
  const { p, r } = await startCrisis('patH');
  assert.equal(escalationOf('patH').tier, 2);
  ctx.app.ai.queue(
    assess({
      level: 'plan_or_intent',
      safe_now: 'no',
      means: 'yes',
      confidence: 'high',
      note: 'Назвал способ и срок.',
    }),
    say('Я здесь, давай побудем вместе.'),
  );
  const turn = expectOk(await ask(p, 'У меня есть таблетки, сегодня вечером', r.crisis_thread.id));
  assert.match(turn.reply.text, /Я здесь, давай побудем вместе\./);
  assert.ok(turn.reply.text.includes(crisisMode.URGENT_LINE), 'прямое «звони 112» добавляет код');
  const esc = escalationOf('patH');
  assert.equal(esc.tier, 3);
  const note = ctx.app.query('SELECT count(*) n FROM notifications WHERE event_key LIKE ?', `crisis_ai:${esc.id}:%`)[0]
    .n;
  assert.ok(note >= 1, 'врач уведомлён о повышении');
  assert.equal(
    note,
    ctx.app.query(
      'SELECT count(*) n FROM care_assignments WHERE patient_id = ? AND ended_at IS NULL',
      ctx.id('patH'),
    )[0].n,
  );
});

test('сбой модели и пустой ответ: разговор продолжается по сценарию, оценка не теряет сигнал', async () => {
  const { p, r } = await startCrisis('patC');
  ctx.app.ai.queue({ mode: 'error' }, { mode: 'error' });
  const t1 = expectOk(await ask(p, 'Не знаю', r.crisis_thread.id));
  assert.equal(t1.reply.ai_generated, false);
  assert.match(t1.reply.text, /звони 112/);
  ctx.app.ai.queue({ mode: 'empty' }, { mode: 'empty' });
  const t2 = expectOk(await ask(p, 'Не знаю', r.crisis_thread.id));
  assert.equal(t2.reply.ai_generated, false, 'пустой ответ модели заменён сценарием');
  assert.notEqual(t1.reply.text, t2.reply.text, 'сценарные шаги идут по очереди');
  assert.equal(escalationOf('patC').status, 'new');
});

test('без согласия на ИИ разговор идёт по сценарию, модель не вызывается', async () => {
  const p = await ctx.as('patG');
  ctx.app.ai.reset();
  const r = expectOk(await F.patientAsk(p, F.CRISIS_PHRASE));
  assert.ok(r.crisis_thread);
  const t = expectOk(await ask(p, 'Не знаю', r.crisis_thread.id));
  assert.equal(t.reply.ai_generated, false);
  assert.equal(ctx.app.ai.calls().length, 0);
});

test('кнопка «Поговорить сейчас»: сигнал, обращение и открытый разговор; статус сигнала виден пациенту', async () => {
  const p = await ctx.as('patI');
  const r = expectOk(await p.post('/api/v1/crisis/help', { source: 'button', text: '' }));
  assert.equal(r.crisis.contacts[0].phone, '112');
  assert.ok(r.crisis_chat.thread_id, 'тред открыт');
  assert.match(r.crisis_chat.message.text, /ты сейчас в безопасности/);
  const got = expectOk(await p.get(`/api/v1/ai/threads/${r.crisis_chat.thread_id}`));
  assert.equal(got.thread.mode, 'crisis');
  assert.equal(got.thread.crisis.status, 'new');
  const doc = await ctx.as('plg1');
  const sig = await F.crisisSignalFor(doc, ctx.id('patI'));
  expectOk(await doc.post(`/api/v1/signals/${sig.id}/take`, { version: sig.version }));
  const seen = expectOk(await p.get(`/api/v1/ai/threads/${r.crisis_chat.thread_id}`));
  assert.equal(seen.thread.crisis.status, 'in_work', 'пациент видит, что врач взял сигнал');
  assert.equal(seen.messages.length, 1);
});

test('чужой кризисный тред недоступен; пока сигнал открыт, режим держится, после обработки врачом обычный тред не становится кризисным', async () => {
  const a = await ctx.as('patA');
  const b = await ctx.as('patB');
  const th = ctx.app.query("SELECT id FROM ai_threads WHERE mode = 'crisis' AND owner_user_id = ?", ctx.id('patA'))[0]
    .id;
  // у patB свой открытый кризисный разговор: чужой номер треда игнорируется, ответ уходит только в его собственный тред
  const foreign = await ask(b, 'Привет', th);
  assert.ok(foreign.status === 404 || (foreign.body.thread && foreign.body.thread.id !== th), 'чужой тред недоступен');
  ctx.app.ai.reset();
  // сигнал открыт: даже спокойная фраза без thread_id остаётся в кризисном разговоре (аудит 2026-10-26)
  const held = expectOk(await F.patientAsk(a, F.CALM_PHRASE));
  assert.equal(held.thread.id, th);
  assert.ok(held.crisis_thread);
  const db = ctx.app.db();
  try {
    db.prepare("UPDATE crisis_escalations SET status='handled' WHERE patient_id=?").run(ctx.id('patA'));
  } finally {
    db.close();
  }
  ctx.app.ai.reset();
  const calm = expectOk(await F.patientAsk(a, F.CALM_PHRASE));
  assert.equal(ctx.app.query('SELECT mode FROM ai_threads WHERE id = ?', calm.thread.id)[0].mode, null);
});
