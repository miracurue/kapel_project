'use strict';
// covers: F-32, F-26, PD-17; чат психиатра без пациента, схема «план и исполнение» (этап 10 плана агента, эксперимент 15):
// план -> подвопросы -> проверка полноты -> доискивание -> ответ с [n]; откат на цикл инструментов; пациент и переключатель
// CLINICIAN_AGENT_MODE=tools оставляют прежний цикл; вызовы модели и поиск видны в журнале шагов.
// Нужен запущенный Postgres знаний (KNOWLEDGE_TEST_DATABASE_URL или KNOWLEDGE_DATABASE_URL) с клинреками; только чтение.
// Без эмбеддингов (в окружении сервера теста нет ключа): поиск лексический.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk } = require('../lib/client');
const { startApp } = require('../lib/app');
const { as } = require('../lib/client');
const { createOpenaiCompat } = require('../../src/ai/adapters/openaiCompat');
const { limitedClient, collectQueries, parseJson } = require('../../src/ai/workspace/clinrecPlan');

const URL = process.env.KNOWLEDGE_TEST_DATABASE_URL || process.env.KNOWLEDGE_DATABASE_URL;
const ctx = useApp({ env: { KNOWLEDGE_DATABASE_URL: URL || '' } });
const skip = URL ? false : 'нет KNOWLEDGE_DATABASE_URL';

const QUESTION = 'Сколько должна длиться тревога для диагноза ГТР?';
const PLAN = JSON.stringify({
  sections: [
    {
      point: 'Минимальная длительность симптомов',
      queries: [
        { query: 'критерии диагноза ГТР длительность тревоги 6 месяцев', clinrec_id: 'gtr_2024' },
        { query: 'тревога 6 месяцев', clinrec_id: 'нет_такой_рекомендации' },
      ],
    },
  ],
});
const COVERAGE = JSON.stringify({
  sufficient: false,
  missing: [{ point: 'Исключить другие причины', query: 'дифференциальный диагноз ГТР', clinrec_id: 'gtr_2024' }],
});

const ask = async (who, text, body, ...script) => {
  const c = await ctx.as(who);
  ctx.app.ai.reset();
  ctx.app.ai.queue(...script);
  return expectOk(await c.post('/api/v1/ai/clinician/messages', { text, chips: [], ...body }), 201);
};
const lastRun = () => ctx.app.query('SELECT * FROM ai_agent_runs ORDER BY id DESC LIMIT 1')[0];
const stepsOf = (id) => ctx.app.query('SELECT * FROM ai_agent_steps WHERE run_id = ? ORDER BY n', [id]);
const shape = (steps) => steps.map((s) => `${s.kind}:${s.name || ''}`);

test('план, поиск, проверка полноты, доискивание и ответ: источники по [n], журнал шагов', { skip }, async () => {
  const body = await ask(
    'psy1',
    QUESTION,
    {},
    { mode: 'text', text: `Вот план:\n${PLAN}` },
    { mode: 'text', text: COVERAGE },
    { mode: 'text', text: 'Не менее 6 месяцев [1]. Выдуманная ссылка [99]. Рассказать подробнее о критериях?' },
  );
  const calls = ctx.app.ai.calls();
  assert.equal(calls.length, 3, 'план, проверка полноты, ответ: три вызова модели');
  assert.equal(calls[0].prompt_key, 'tools.clinrec_plan');
  assert.equal(calls[0].tools, null, 'планировщику инструменты не даются');
  assert.match(calls[0].system, /планировщик поиска/);
  assert.match(calls[0].messages.at(-1).content, /gtr_2024 — Генерализованное тревожное расстройство/, 'каталог');
  assert.ok(calls[0].messages.at(-1).content.includes(QUESTION));
  assert.equal(calls[1].prompt_key, 'tools.clinrec_coverage');
  assert.match(calls[1].messages.at(-1).content, /=== НАЙДЕННЫЕ ФРАГМЕНТЫ ===[\s\S]*\[1\] /, 'фрагменты в проверке');
  const answer = calls[2];
  assert.equal(answer.prompt_key, 'task.clinician_chat');
  assert.equal(answer.tools, null, 'ответ без инструментов');
  assert.match(answer.system, /Работа с найденными фрагментами/);
  assert.doesNotMatch(answer.system, /к лекарствам через инструменты/, 'правил вызова нет');
  assert.doesNotMatch(answer.system, /планировщик поиска/, 'служебные промпты в ответ не попадают');
  const last = answer.messages.at(-1).content;
  assert.match(last, new RegExp(`Сообщение врача: ${QUESTION}`));
  assert.match(last, /Найденные фрагменты[\s\S]*\[1\] Генерализованное тревожное расстройство \(gtr_2024\)/);
  assert.match(last, /Минимальная длительность симптомов/, 'пункты плана — подсказка ответу');

  assert.equal(body.reply.text.startsWith('Не менее 6 месяцев [1]'), true);
  assert.equal(body.sources.length, 1, 'выдуманный [99] отброшен');
  assert.equal(body.sources[0].clinrec, true);
  assert.equal(body.sources[0].document_id, 'gtr_2024');
  assert.match(body.sources[0].section_id, /^gtr_2024\.n\./, 'раздел открывается в правой панели');
  assert.ok(body.sources[0].section_no);

  const run = lastRun();
  assert.equal(run.status, 'ok');
  assert.equal(run.stop_reason, 'answer');
  const steps = stepsOf(run.id);
  assert.deepEqual(
    shape(steps).sort(),
    [
      'model:plan',
      'tool:search_clinrec', // подвопрос в gtr_2024
      'tool:search_clinrec', // подвопрос по всему корпусу (неизвестный код рекомендации отброшен)
      'tool:search_clinrec', // доискивание
      'model:coverage',
      'note:plan_execute',
      'model:',
    ].sort(),
  );
  const tools = steps.filter((s) => s.kind === 'tool');
  assert.ok(tools.some((s) => /подвопрос/.test(s.reason_text)));
  assert.ok(tools.some((s) => /доискивание/.test(s.reason_text)));
  assert.ok(tools.every((s) => s.result_chars > 0 && s.duration_ms !== null));
  assert.equal(steps.find((s) => s.name === 'plan').status, 'ok');
  assert.match(steps.find((s) => s.name === 'plan').result_text, /sections/);
  const audit = ctx.app.query("SELECT * FROM ai_audit WHERE purpose = 'clinician_chat' ORDER BY id DESC LIMIT 1")[0];
  assert.equal(audit.status, 'ok');
  assert.ok(
    JSON.parse(audit.prompt_layers_json).some((l) => l.key === 'tools.clinrec_plan'),
    'слои плана в аудите',
  );
  const log = ctx.app.query("SELECT count(*) n FROM action_log WHERE action = 'knowledge.clinrec_tool'")[0].n;
  assert.ok(log >= 1, 'обращение к знаниям записано без содержимого');
});

test('проверка полноты не удалась: идём с найденным, ответ приходит', { skip }, async () => {
  const body = await ask(
    'psy1',
    QUESTION,
    {},
    { mode: 'text', text: PLAN },
    { mode: 'error' },
    { mode: 'text', text: 'Ответ по найденному [1].' },
  );
  assert.equal(body.reply.text, 'Ответ по найденному [1].');
  assert.equal(ctx.app.ai.calls().length, 3);
  const steps = stepsOf(lastRun().id);
  const tools = steps.filter((s) => s.kind === 'tool');
  assert.equal(tools.length, 2, 'только подвопросы плана');
  assert.ok(
    tools.every((s) => /подвопрос/.test(s.reason_text)),
    'доискивания нет',
  );
  assert.equal(steps.find((s) => s.name === 'coverage').status, 'error');
  assert.ok(steps.some((s) => s.name === 'plan_execute'));
});

test(
  'план не разобран, пуст или вызов модели упал: откат на цикл инструментов, ответ не пропадает',
  { skip },
  async () => {
    for (const plan of [
      { mode: 'text', text: 'не знаю, что искать' },
      { mode: 'text', text: '{"sections":[]}' },
      { mode: 'error' },
    ]) {
      const body = await ask(
        'psy1',
        QUESTION,
        {},
        plan,
        { mode: 'tool', name: 'search_clinrec', arguments: { query: 'критерии диагноза ГТР', clinrec_id: 'gtr_2024' } },
        { mode: 'text', text: 'Ответ циклом [1].' },
      );
      const calls = ctx.app.ai.calls();
      assert.equal(calls.length, 3, JSON.stringify(plan));
      assert.equal(calls[0].prompt_key, 'tools.clinrec_plan');
      assert.ok(
        (calls[1].tools || []).some((t) => t.name === 'search_clinrec'),
        'дальше — инструменты',
      );
      assert.equal(calls[1].prompt_key, 'task.clinician_chat');
      assert.match(calls[1].system, /к лекарствам через инструменты/);
      assert.doesNotMatch(calls[1].system, /Работа с найденными фрагментами/);
      assert.match(calls[1].messages.at(-1).content, /gtr_2024 — Генерализованное тревожное расстройство/, 'каталог');
      assert.equal(body.reply.text, 'Ответ циклом [1].');
      assert.equal(body.sources.length, 1);
      const steps = stepsOf(lastRun().id);
      assert.ok(steps.some((s) => s.name === 'plan_fallback' && s.status === 'error'));
      assert.ok(steps.some((s) => s.kind === 'tool' && s.name === 'search_clinrec'));
    }
  },
);

test('с закреплённым пациентом остаётся прежний цикл инструментов, плана нет', { skip }, async () => {
  const body = await ask(
    'psy1',
    'Что рекомендации говорят о первой линии для этого пациента?',
    { patient_id: ctx.id('patA'), chips: [{ type: 'patient', id: ctx.id('patA') }] },
    { mode: 'tool', name: 'search_clinrec', arguments: { query: 'терапия первой линии ГТР', clinrec_id: 'gtr_2024' } },
    { mode: 'text', text: 'Черновик [1].' },
  );
  const calls = ctx.app.ai.calls();
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every((c) => c.prompt_key === 'task.clinician_chat'),
    'планировщика не было',
  );
  assert.ok((calls[0].tools || []).some((t) => t.name === 'get_overview'));
  assert.equal(body.sources.length, 1);
  assert.ok(!stepsOf(lastRun().id).some((s) => s.name === 'plan'));
});

test('CLINICIAN_AGENT_MODE=tools возвращает прежний цикл', { skip }, async () => {
  const app = await startApp({ env: { KNOWLEDGE_DATABASE_URL: URL || '', CLINICIAN_AGENT_MODE: 'tools' } });
  try {
    const c = await as(app, 'psy1');
    app.ai.reset();
    app.ai.queue(
      { mode: 'tool', name: 'search_clinrec', arguments: { query: 'критерии диагноза ГТР', clinrec_id: 'gtr_2024' } },
      { mode: 'text', text: 'Ответ циклом [1].' },
    );
    const body = expectOk(await c.post('/api/v1/ai/clinician/messages', { text: QUESTION, chips: [] }), 201);
    const calls = app.ai.calls();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].prompt_key, 'task.clinician_chat');
    assert.ok((calls[0].tools || []).some((t) => t.name === 'search_clinrec'));
    assert.equal(body.sources.length, 1);
  } finally {
    await app.stop();
  }
});

test('психолог не попадает в схему плана', { skip }, async () => {
  await ask('plg1', 'Что такое ГТР?', {}, { mode: 'text', text: 'Ответ.' });
  const calls = ctx.app.ai.calls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt_key, 'task.clinician_chat');
});

// ---- без базы знаний ----

test('адаптер openai_compat передаёт reasoning только на OpenRouter', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    };
  };
  try {
    const adapter = createOpenaiCompat();
    const payload = {
      system: 's',
      messages: [{ role: 'user', content: 'q' }],
      reasoning: { enabled: false },
      temperature: 0,
      max_tokens: 100,
    };
    await adapter.call({ model: { api_base: 'https://openrouter.ai/api/v1', model_ident: 'm' }, payload });
    await adapter.call({ model: { api_base: 'http://127.0.0.1:8080/v1', model_ident: 'm' }, payload });
    await adapter.call({
      model: { api_base: 'https://openrouter.ai/api/v1', model_ident: 'm' },
      payload: { system: 's', messages: [{ role: 'user', content: 'q' }] },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(sent[0].body.reasoning, { enabled: false });
  assert.equal(sent[0].body.temperature, 0);
  assert.equal(sent[0].body.max_tokens, 100);
  assert.equal(sent[1].body.reasoning, undefined, 'не-OpenRouter: поле не посылаем');
  assert.equal(sent[2].body.reasoning, undefined, 'ответ без служебных параметров: поле не посылаем');
  assert.equal(sent[2].body.temperature, undefined);
  assert.equal(sent[0].body.chat_template_kwargs, undefined, 'OpenRouter: свой параметр шаблона не нужен');
  assert.deepEqual(sent[1].body.chat_template_kwargs, { enable_thinking: false }, 'свой сервер: рассуждение выключено');
  assert.equal(sent[2].body.chat_template_kwargs, undefined);
});

test('разбор плана: JSON из текста, неизвестные коды и лишние запросы отбрасываются', () => {
  assert.equal(parseJson('мусор'), null);
  assert.deepEqual(parseJson('Вот: {"a":1} конец'), { a: 1 });
  assert.equal(parseJson('[1,2]'), null);
  const known = new Set(['gtr_2024']);
  const plan = {
    sections: [
      {
        point: 'п1',
        queries: [
          { query: 'тревога 6 месяцев', clinrec_id: 'gtr_2024' },
          { query: 'Тревога 6 месяцев', clinrec_id: 'gtr_2024' }, // повтор
          { query: 'сертралин дозы', source: 'drug', inn: 'сертралин', clinrec_id: 'gtr_2024' },
          { query: 'x' }, // слишком короткий
          { query: 'чужой код', clinrec_id: 'nope' },
        ],
      },
      { point: 'п2', queries: Array.from({ length: 10 }, (_, i) => ({ query: `запрос ${i}` })) },
    ],
  };
  const withDrugs = collectQueries(plan, known, true);
  assert.equal(withDrugs.length, 6, 'не больше шести запросов');
  assert.equal(withDrugs[0].doc, 'gtr_2024');
  assert.deepEqual(
    [withDrugs[1].drug, withDrugs[1].inn, withDrugs[1].doc],
    [true, 'сертралин', null],
    'инструкции: код рекомендации не нужен',
  );
  assert.equal(withDrugs[2].doc, null, 'неизвестный код отброшен, поиск по всему корпусу');
  const noDrugs = collectQueries(plan, known, false);
  assert.equal(noDrugs[1].drug, false, 'корпуса инструкций нет: source=drug игнорируется');
  assert.equal(collectQueries({ sections: 'нет' }, known, true).length, 0);
});

test('векторизация в схеме плана: не больше двух запросов одновременно, один текст — один запрос', async () => {
  let active = 0;
  let peak = 0;
  const seen = [];
  const base = {
    model: 'm',
    async embed(texts) {
      seen.push(...texts);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      return { model: 'm', vectors: texts.map((t) => [t.length]) };
    },
  };
  const client = limitedClient(base);
  const out = await Promise.all(['а', 'бб', 'ввв', 'гггг', 'а', 'бб'].map((t) => client.embed([t])));
  assert.deepEqual(
    out.map((o) => o.vectors[0][0]),
    [1, 2, 3, 4, 1, 2],
  );
  assert.equal(peak, 2);
  assert.equal(seen.length, 4, 'повторы взяты из кэша');
  let fail = true;
  const flaky = limitedClient({
    model: 'm',
    async embed(texts) {
      if (fail) throw new Error('429');
      return { model: 'm', vectors: texts.map(() => [1]) };
    },
  });
  await assert.rejects(flaky.embed(['а']));
  fail = false;
  assert.deepEqual((await flaky.embed(['а'])).vectors, [[1]], 'сбой не кэшируется');
  assert.equal(limitedClient(null), null);
});
