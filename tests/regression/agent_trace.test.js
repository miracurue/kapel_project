'use strict';
// covers: PD-17 (исключение 2026-10-25), F-13; журнал шагов ИИ-агента: один запуск на ответ специалисту, шаги модели и
// инструментов, защита от повторного вызова, просмотр и скачивание только администратором, без текстов в боевом режиме.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk } = require('../lib/client');
const { createAgentTrace, purgeExpiredRuns } = require('../../src/ai/agentTrace');
const ctx = useApp();

const ask = async (...script) => {
  const doc = await ctx.as('psy1');
  ctx.app.ai.reset();
  ctx.app.ai.queue(...script);
  return expectOk(
    await doc.post('/api/v1/ai/clinician/messages', {
      patient_id: ctx.id('patA'),
      text: 'Что в дневнике за две недели?',
      chips: [{ type: 'patient', id: ctx.id('patA') }],
    }),
  );
};

const lastRun = () => ctx.app.query('SELECT * FROM ai_agent_runs ORDER BY id DESC LIMIT 1')[0];
const stepsOf = (id) => ctx.app.query('SELECT * FROM ai_agent_steps WHERE run_id = ? ORDER BY n', [id]);

test('ответ специалисту записан запуском с шагами модели и инструмента', async () => {
  const r = await ask(
    { mode: 'tool', name: 'get_diary', arguments: { days: 14 } },
    { mode: 'text', text: 'Черновик: настроение снижено, нужна проверка врачом.' },
  );
  const run = lastRun();
  assert.equal(run.status, 'ok');
  assert.equal(run.purpose, 'clinician_chat');
  assert.equal(run.steps, 2, 'два вызова модели');
  assert.equal(run.tool_calls, 1);
  assert.equal(run.stop_reason, 'answer');
  assert.equal(run.texts_stored, 1, 'синтетический режим: тексты хранятся');
  assert.match(run.question_text, /дневнике/);
  assert.equal(run.answer_text, r.reply.text);
  assert.ok(run.message_id, 'запуск привязан к сообщению ответа');
  assert.ok(Date.parse(run.expires_at) - Date.parse(run.created_at) >= 29 * 86400000, 'срок хранения около 30 дней');
  const steps = stepsOf(run.id);
  assert.deepEqual(
    steps.map((s) => s.kind),
    ['model', 'tool', 'model'],
  );
  assert.equal(steps[1].name, 'get_diary');
  assert.deepEqual(JSON.parse(steps[1].args_json), { days: 14 });
  assert.ok(steps[1].result_chars > 0);
  assert.ok(!String(steps[1].result_text).includes('Марина'), 'в результатах инструмента метки, а не имя');
  assert.ok(
    !JSON.stringify(ctx.app.query('SELECT * FROM ai_audit ORDER BY id DESC LIMIT 1')).includes('дневнике'),
    'ai_audit без текстов',
  );
});

test('повторный вызов того же инструмента с теми же аргументами не выполняется второй раз', async () => {
  await ask(
    { mode: 'tool', name: 'get_overview', arguments: {} },
    { mode: 'tool', name: 'get_overview', arguments: {} },
    { mode: 'text', text: 'Готово, черновик для проверки.' },
  );
  const steps = stepsOf(lastRun().id).filter((s) => s.kind === 'tool');
  assert.deepEqual(
    steps.map((s) => s.status),
    ['ok', 'repeat'],
  );
  const calls = ctx.app.ai.calls();
  const toolMsgs = calls[2].messages.filter((m) => m.role === 'tool');
  assert.match(toolMsgs[toolMsgs.length - 1].content, /уже/i, 'модель получила подсказку вместо повторного чтения');
});

test('журнал агента видит и скачивает только администратор; просмотр пишется в журнал действий', async () => {
  const doc = await ctx.as('psy1');
  assert.equal((await doc.get('/admin/api/agent/runs')).status, 403);
  assert.equal((await ctx.guest().get('/admin/api/agent/runs')).status, 401);
  const admin = await ctx.as('admin1');
  const list = expectOk(await admin.get('/admin/api/agent/runs'));
  assert.ok(list.total >= 2);
  const id = list.items[0].id;
  assert.equal(list.items[0].question_text, undefined, 'в списке текстов нет');
  const one = expectOk(await admin.get(`/admin/api/agent/runs/${id}`));
  assert.ok(Array.isArray(one.steps_list) && one.steps_list.length >= 2);
  assert.ok(one.patient_no === null || !/Марина/.test(one.patient_no));
  const file = await admin.get(`/admin/api/agent/runs/${id}/download`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /attachment/);
  const all = await admin.get('/admin/api/agent/download?from=2000-01-01');
  assert.equal(all.status, 200);
  assert.equal(all.body.schema, 'agent-trace/1');
  assert.equal((await admin.get('/admin/api/agent/runs?status=nope')).status, 422);
  const logged = ctx.app.query("SELECT action FROM action_log WHERE action LIKE 'agent.trace.%'").map((r) => r.action);
  assert.ok(logged.includes('agent.trace.view') && logged.includes('agent.trace.export'));
});

test('в боевом режиме тексты не пишутся; просроченные запуски стираются вместе с шагами', () => {
  const db = ctx.app.db();
  try {
    const tr = createAgentTrace({ db, config: { dataMode: 'real' } });
    assert.equal(tr.withTexts, false);
    const run = tr.start({
      user: { id: ctx.id('psy1'), role: 'psychiatrist' },
      purpose: 'clinician_chat',
      promptKey: 'role.psychiatrist.chat',
      question: 'СЕКРЕТНЫЙВОПРОС',
    });
    run.step({ kind: 'tool', name: 'get_diary', args: { days: 3 }, result: 'СЕКРЕТНЫЙРЕЗУЛЬТАТ' });
    run.finish({ status: 'ok', answer: 'СЕКРЕТНЫЙОТВЕТ' });
    const row = db.prepare('SELECT * FROM ai_agent_runs WHERE id=?').get(run.id);
    const step = db.prepare('SELECT * FROM ai_agent_steps WHERE run_id=?').get(run.id);
    assert.equal(row.texts_stored, 0);
    assert.ok(!JSON.stringify([row, step]).includes('СЕКРЕТН'), 'ни вопроса, ни ответа, ни результата');
    assert.equal(step.result_chars, 'СЕКРЕТНЫЙРЕЗУЛЬТАТ'.length, 'размер результата остаётся');
    const far = new Date(Date.now() + 40 * 86400000).toISOString();
    assert.ok(purgeExpiredRuns(db, far).agent_runs >= 1);
    assert.equal(
      db.prepare('SELECT count(*) n FROM ai_agent_steps WHERE run_id=?').get(run.id).n,
      0,
      'шаги стёрты каскадом',
    );
  } finally {
    db.close();
  }
});

test('сбой модели записывается с причиной, а не только статусом', async () => {
  await ask({ mode: 'error' }, { mode: 'text', text: 'Ответила запасная модель.' });
  const steps = stepsOf(lastRun().id).filter((s) => s.kind === 'model');
  assert.equal(steps[0].status, 'error');
  assert.match(steps[0].error_text, /запрошенная ошибка/, 'причина сбоя сохранена');
  assert.equal(steps[1].error_text, null, 'у удавшегося вызова причины нет');
});

test('запасная модель продолжает с найденного основной, а не начинает инструменты заново', async () => {
  await ask(
    { mode: 'tool', name: 'get_overview', arguments: {} },
    { mode: 'error' },
    { mode: 'text', text: 'Продолжила запасная.' },
  );
  const calls = ctx.app.ai.calls();
  const last = calls[calls.length - 1];
  const tools = last.messages.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 1, 'результат инструмента основной модели передан запасной');
  assert.equal(tools[0].name, 'get_overview');
  assert.equal(lastRun().status, 'fallback');
});

test('прерванный ответ: следующий запрос в треде повторяет уже сделанные вызовы и даёт их модели', async () => {
  const doc = await ctx.as('psy1');
  ctx.app.ai.reset();
  // Первый запрос: основная модель вызвала инструмент и упала, запасная тоже упала — ответа нет.
  ctx.app.ai.queue({ mode: 'tool', name: 'get_overview', arguments: {} }, { mode: 'error' }, { mode: 'error' });
  const failed = await doc.post('/api/v1/ai/clinician/messages', {
    patient_id: ctx.id('patA'),
    text: 'Сводка по пациенту?',
    chips: [{ type: 'patient', id: ctx.id('patA') }],
  });
  assert.ok(failed.status >= 500, 'первый запрос не получил ответа');
  const broken = lastRun();
  assert.ok(['error', 'timeout'].includes(broken.status));
  const saved = ctx.app.query('SELECT tool, args_json FROM ai_agent_calls WHERE run_id = ?', [broken.id]);
  assert.deepEqual(saved.map((r) => r.tool), ['get_overview'], 'вызов инструмента сохранён без результата');

  ctx.app.ai.reset();
  ctx.app.ai.queue({ mode: 'text', text: 'Сводка получена.' });
  const retry = expectOk(
    await doc.post('/api/v1/ai/clinician/messages', {
      thread_id: broken.thread_id,
      patient_id: ctx.id('patA'),
      text: 'Сводка по пациенту?',
      chips: [{ type: 'patient', id: ctx.id('patA') }],
    }),
  );
  assert.equal(retry.reply.text, 'Сводка получена.');
  const calls = ctx.app.ai.calls();
  assert.equal(calls.length, 1, 'модель вызвана один раз: поиск повторять не пришлось');
  const tools = calls[0].messages.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 1, 'модель сразу получила результат прерванного вызова');
  assert.equal(tools[0].name, 'get_overview');
  const resumed = stepsOf(lastRun().id).filter((s) => s.kind === 'tool');
  assert.equal(resumed.length, 1);
  assert.match(resumed[0].reason_text, /возобновление/);
});
