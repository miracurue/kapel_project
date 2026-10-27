'use strict';
// covers: F-13, PD-17; этап 7 плана агента: история чата специалиста подгоняется под окно модели
// (ai_models.params_json.context_tokens), ранние сообщения сжимаются навыком skill.history_summary.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk } = require('../lib/client');
const ctxBudget = require('../../src/ai/contextBudget');
const ctx = useApp();

const LONG = 'Синтетическое обсуждение схемы терапии и критериев оценки. '.repeat(12); // ≈ 700 знаков

test('размер окна берётся из параметров модели, история делится на свежую и раннюю', () => {
  assert.equal(ctxBudget.contextTokensOf({ params_json: '{"context_tokens": 128000}' }), 128000);
  assert.equal(ctxBudget.contextTokensOf({ params_json: '{}' }), ctxBudget.DEFAULT_CONTEXT_TOKENS);
  assert.equal(ctxBudget.contextTokensOf({ params_json: 'не json' }), ctxBudget.DEFAULT_CONTEXT_TOKENS);
  assert.equal(ctxBudget.contextTokensOf({ params_json: { context_tokens: 8000 } }), 8000);
  const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `${i} ${LONG}` }));
  const small = ctxBudget.splitHistory(history, 1000);
  assert.equal(small.recent.length, 4, 'не меньше четырёх свежих');
  assert.equal(small.older.length, 26);
  assert.equal(small.recent[0].text.split(' ')[0], '26', 'свежие — последние');
  const big = ctxBudget.splitHistory(history, 1e6);
  assert.equal(big.older.length, 0);
});

test('длинная беседа: ранние сообщения сжаты навыком, свежие идут как есть, шаг записан в журнал агента', async () => {
  const psy = await ctx.as('psy1');
  ctx.app.ai.reset();
  ctx.app.ai.queue({ mode: 'text', text: 'Первый ответ.' });
  const first = expectOk(await psy.post('/api/v1/ai/clinician/messages', { text: 'Начнём обсуждение.' }), 201);
  const threadId = first.thread.id;
  const db = ctx.app.db();
  try {
    const ins = db.prepare(
      "INSERT INTO ai_messages(thread_id,role,text,kind,ai_generated,created_at) VALUES (?,?,?,'normal',?,?)",
    );
    for (let i = 0; i < 30; i += 1)
      ins.run(threadId, i % 2 ? 'assistant' : 'user', `Сообщение ${i}. ${LONG}`, i % 2, new Date().toISOString());
    const model = db
      .prepare(
        "SELECT m.id FROM ai_binding_versions b JOIN ai_models m ON m.id = b.primary_model_id WHERE b.purpose='clinician_chat' AND b.status='active'",
      )
      .get();
    db.prepare('UPDATE ai_models SET params_json = ? WHERE id = ?').run('{"context_tokens": 4000}', model.id);
  } finally {
    db.close();
  }
  await ctx.app.advanceClock(31000); // кеш привязок 30 с

  ctx.app.ai.reset();
  ctx.app.ai.queue(
    { mode: 'text', text: 'КРАТКОЕ-СОДЕРЖАНИЕ ранней беседы' },
    { mode: 'text', text: 'Ответ с учётом истории.' },
  );
  const r = expectOk(await psy.post('/api/v1/ai/clinician/messages', { text: 'Продолжим.' }), 201);
  assert.equal(r.reply.text, 'Ответ с учётом истории.');
  const calls = ctx.app.ai.calls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].prompt_key, 'skill.history_summary');
  assert.match(calls[0].messages.at(-1).content, /Специалист: Начнём обсуждение/);
  assert.match(calls[1].system, /КРАТКОЕ-СОДЕРЖАНИЕ ранней беседы/);
  assert.ok(calls[1].messages.length < 20, 'в запрос ушли только свежие сообщения');
  assert.match(calls[1].messages.at(-2).content, /Сообщение 29/);
  const run = ctx.app.query('SELECT id FROM ai_agent_runs ORDER BY id DESC LIMIT 1')[0];
  const note = ctx.app.query("SELECT * FROM ai_agent_steps WHERE run_id = ? AND kind = 'note'", run.id)[0];
  assert.equal(note.name, 'history_summary');
  assert.equal(note.status, 'ok');
  assert.match(note.result_text, /Окно модели 4000/);

  ctx.app.ai.reset();
  ctx.app.ai.queue({ mode: 'text', text: 'Ответ по кэшу.' });
  expectOk(await psy.post('/api/v1/ai/clinician/messages', { text: 'Коротко.' }), 201);
  const cachedCalls = ctx.app.ai.calls();
  assert.equal(cachedCalls.length, 1, 'ранняя часть не изменилась — краткое содержание из памяти, без вызова');
  assert.match(cachedCalls[0].system, /КРАТКОЕ-СОДЕРЖАНИЕ ранней беседы/);

  const db2 = ctx.app.db();
  try {
    const ins = db2.prepare(
      "INSERT INTO ai_messages(thread_id,role,text,kind,ai_generated,created_at) VALUES (?,?,?,'normal',?,?)",
    );
    for (let i = 0; i < 6; i += 1)
      ins.run(threadId, i % 2 ? 'assistant' : 'user', `Новое ${i}. ${LONG}`, i % 2, new Date().toISOString());
  } finally {
    db2.close();
  }
  ctx.app.ai.reset();
  // основная и запасная модель навыка сжатия падают (F-26: один запасной вызов), ответ всё равно приходит
  ctx.app.ai.queue({ mode: 'error' }, { mode: 'error' }, { mode: 'text', text: 'Ответ без сжатия.' });
  const r2 = expectOk(await psy.post('/api/v1/ai/clinician/messages', { text: 'Ещё вопрос.' }), 201);
  assert.equal(r2.reply.text, 'Ответ без сжатия.', 'сбой сжатия не ломает ответ');
  assert.doesNotMatch(ctx.app.ai.calls().at(-1).system, /Краткое содержание более ранней части/);
  const run2 = ctx.app.query('SELECT id FROM ai_agent_runs ORDER BY id DESC LIMIT 1')[0];
  const note2 = ctx.app.query("SELECT status FROM ai_agent_steps WHERE run_id = ? AND kind = 'note'", run2.id)[0];
  assert.equal(note2.status, 'error');
});
