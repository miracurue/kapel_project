'use strict';
// covers: F-32, PD-17; источники ответа психиатра: метки [n] сопоставляются только с источниками, которые модель
// действительно получила; [0] — «Знания модели»; выдуманные метки убираются из текста; источники сохраняются с адресом
// фрагмента и возвращаются при открытии треда; номера прошлых ответов не попадают в историю для модели.
// Нужен запущенный Postgres знаний (KNOWLEDGE_TEST_DATABASE_URL или KNOWLEDGE_DATABASE_URL) с клинреками; только чтение.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk } = require('../lib/client');
const { createKnowledgeService } = require('../../src/modules/knowledge/service');
const { createClinrecTools } = require('../../src/ai/workspace/clinrecTools');
const { combineTools } = require('../../src/ai/workspace/toolsets');
const S = require('../../src/ai/workspace/sources');
const { buildExcerpts } = require('../../src/modules/drugs/instructions');

const URL = process.env.KNOWLEDGE_TEST_DATABASE_URL || process.env.KNOWLEDGE_DATABASE_URL;
const ctx = useApp({ env: { KNOWLEDGE_DATABASE_URL: URL || '', CLINICIAN_AGENT_MODE: 'tools' } });
const skip = URL ? false : 'нет KNOWLEDGE_DATABASE_URL';

const READ = { mode: 'tool', name: 'read_clinrec_section', arguments: { clinrec_id: 'gtr_2024', sections: ['5.1'] } };
const SEARCH = {
  mode: 'tool',
  name: 'search_clinrec',
  arguments: { query: 'критерии диагноза ГТР тревога 6 месяцев', clinrec_id: 'gtr_2024' },
};

const ask = async (text, body, ...script) => {
  const c = await ctx.as('psy1');
  ctx.app.ai.reset();
  ctx.app.ai.queue(...script);
  return expectOk(await c.post('/api/v1/ai/clinician/messages', { text, chips: [], ...body }), 201);
};

// ---------- разбор меток (без базы знаний) ----------

test('метки: [n], [n, m] и [0] разбираются, неизвестные номера убираются, остальное не трогается', () => {
  assert.deepEqual([...S.citedNumbers('а [1] б [2, 3] в [0]; [x] [1234] [4;5]')].sort(), [0, 1, 2, 3, 4, 5]);
  const known = new Set([1, 2]);
  assert.equal(
    S.stripUnknown('Факт [1]. Выдумка [7]. Оба [2, 9]. Свои знания [0].', known),
    'Факт [1]. Выдумка. Оба [2]. Свои знания [0].',
  );
  assert.equal(S.stripUnknown('Только [8, 9] выдумка', known), 'Только выдумка');
  assert.equal(S.stripUnknown('[1] без изменений', known), '[1] без изменений');
  assert.equal(S.stripMarkers('Не менее 6 месяцев [1][2]. Ещё [3, 4].'), 'Не менее 6 месяцев. Ещё.');
  const shown = [
    { n: 1, label: 'А' },
    { n: 2, label: 'Б' },
  ];
  assert.deepEqual(
    S.sourcesFor('текст [2]', shown).map((s) => s.n),
    [2],
    'карточка только у процитированного',
  );
  const withModel = S.sourcesFor('текст [2] и знание [0]', shown);
  assert.deepEqual(
    withModel.map((s) => s.n),
    [0, 2],
    '«Знания модели» идут первой карточкой',
  );
  assert.equal(withModel[0].model_knowledge, true);
  assert.equal(withModel[0].label, 'Знания модели');
  assert.deepEqual(S.sourcesFor('без ссылок', shown), []);
});

test('набор инструментов: убираются метки с номерами, которых нет ни в одном наборе', () => {
  const a = { definitions: [], execute: () => '', shownNumbers: () => [1], cited: () => [] };
  const b = { definitions: [], execute: () => '', shownNumbers: () => [2], cited: () => [] };
  const tools = combineTools(a, b);
  assert.equal(tools.sanitize('Факт [1], статья [2], выдумка [3]'), 'Факт [1], статья [2], выдумка');
  const patientOnly = combineTools({ definitions: [], execute: () => '' }, { definitions: [], execute: () => '' });
  assert.equal(patientOnly.sanitize('текст [5]'), 'текст [5]', 'без нумерованных источников текст не меняется');
});

test('выдержки инструкций: с нумерацией метка «[n] документ · раздел», источник несёт номер и адрес фрагмента', () => {
  const rows = [
    {
      document_id: 'D1',
      section_id: 'D1-S2',
      chunk_id: 'D1-c1',
      label: 'Золофт',
      path: 'Побочные реакции',
      page: 3,
      text: 'Сертралин может вызывать нарушения сна и бессонницу, головную боль и ещё многое другое. '.repeat(4),
    },
    {
      document_id: 'D1',
      section_id: 'D1-S1',
      chunk_id: 'D1-c2',
      label: 'Золофт',
      path: 'Показания',
      page: 1,
      text: 'Сертралин показан при депрессии и тревоге и других состояниях, описанных в инструкции. '.repeat(4),
    },
  ];
  let next = 10;
  const registered = [];
  const { block, sources } = buildExcerpts(rows, { register: (r) => (registered.push(r.chunk_id), ++next) });
  assert.deepEqual(registered, ['D1-c1', 'D1-c2']);
  assert.deepEqual(
    sources.map((s) => s.n),
    [11, 12],
  );
  assert.equal(sources[0].chunk_id, 'D1-c1');
  assert.equal(sources[0].drug, true);
  assert.match(block, /\[11\] Золофт · Побочные реакции · стр\. 3\n/);
  assert.match(block, /номера источника в квадратных скобках/);
  // без нумерации прежний формат: ни n, ни chunk_id в источнике
  const plain = buildExcerpts(rows);
  assert.deepEqual(Object.keys(plain.sources[0]).sort(), ['document_id', 'label', 'page', 'path', 'section_id']);
});

// ---------- источники в ответе (с базой знаний) ----------

test(
  'ответ: карточка у процитированного, у источника адрес фрагмента и цитата, [0] — «Знания модели», выдумка убрана',
  { skip },
  async () => {
    const body = await ask('Сколько должна длиться тревога для диагноза ГТР?', {}, SEARCH, {
      mode: 'text',
      text: 'Не менее 6 месяцев [1]. Это общеизвестно [0]. Выдумка [42]. Рассказать подробнее?',
    });
    assert.equal(body.reply.text, 'Не менее 6 месяцев [1]. Это общеизвестно [0]. Выдумка. Рассказать подробнее?');
    assert.deepEqual(
      body.sources.map((s) => s.n),
      [0, 1],
    );
    const [model, doc] = body.sources;
    assert.equal(model.kind, 'model');
    assert.equal(model.model_knowledge, true);
    assert.equal(doc.kind, 'clinrec');
    assert.equal(doc.clinrec, true);
    assert.equal(doc.document_id, 'gtr_2024');
    assert.match(doc.section_id, /^gtr_2024\.n\./);
    assert.ok(doc.chunk_id, 'поиск указал фрагмент, его подсветит правая панель');
    assert.ok(doc.snippet && doc.snippet.length <= 261, 'цитата для карточки короткая');
    assert.ok(!/[#*`|]/.test(doc.snippet), 'цитата без разметки Markdown');
    assert.equal(doc.key, undefined, 'служебный ключ не уходит клиенту');

    // сохранённые источники возвращаются при открытии треда (после перезагрузки страницы карточки и [n] остаются живыми)
    const c = await ctx.as('psy1');
    const thread = expectOk(await c.get(`/api/v1/ai/threads/${body.thread.id}`));
    const reply = thread.messages.find((m) => m.id === body.reply.id);
    assert.deepEqual(reply.sources, body.sources);
    assert.equal(reply.text, body.reply.text);
    const user = thread.messages.find((m) => m.role === 'user');
    assert.equal(user.sources, undefined);
  },
);

test('метка на источник, найденный, но не показанный модели, карточки не создаёт', { skip }, async () => {
  const knowledge = createKnowledgeService({ env: { KNOWLEDGE_DATABASE_URL: URL } });
  try {
    let counter = 0;
    const tools = await createClinrecTools({ knowledge, nextNo: () => ++counter });
    const found = await tools.retrieval.searchClinrec({
      query: 'критерии диагноза ГТР тревога 6 месяцев',
      clinrecId: 'gtr_2024',
      limit: 3,
      client: null,
    });
    assert.ok(found.length >= 1);
    const n = found[0].n;
    // поиск схемы «план и исполнение» номер выдал, но фрагмент в запрос ответа не вошёл
    assert.deepEqual(tools.cited(`ответ [${n}]`), []);
    assert.equal(tools.sanitize(`ответ [${n}]`), 'ответ');
    assert.deepEqual(tools.sources(), []);
    tools.markShown([n]);
    assert.deepEqual(
      tools.cited(`ответ [${n}]`).map((s) => s.n),
      [n],
    );
    assert.equal(tools.sanitize(`ответ [${n}]`), `ответ [${n}]`);
    // несколько фрагментов одного раздела — один номер, источник хранит адрес первого найденного фрагмента
    const again = await tools.retrieval.searchClinrec({
      query: 'критерии диагноза ГТР тревога 6 месяцев',
      clinrecId: 'gtr_2024',
      limit: 3,
      client: null,
    });
    assert.equal(again[0].n, n, 'тот же раздел — тот же номер');
    const src = tools.cited(`[${n}]`)[0];
    assert.ok(src.chunk_id);
  } finally {
    await knowledge.close();
  }
});

test('номера прошлых ответов не попадают в историю беседы для модели', { skip }, async () => {
  const first = await ask('Сколько должна длиться тревога для диагноза ГТР?', {}, READ, {
    mode: 'text',
    text: 'Не менее 6 месяцев [1]. Рассказать подробнее?',
  });
  assert.equal(first.sources.length, 1);
  const second = await ask(
    'А что с дифференциальной диагностикой?',
    { thread_id: first.thread.id },
    { mode: 'text', text: 'Это отдельный вопрос [1].' },
  );
  const call = ctx.app.ai.calls()[0];
  const assistant = call.messages.filter((m) => m.role === 'assistant');
  assert.ok(assistant.length >= 1, 'прошлый ответ в истории есть');
  assert.ok(
    assistant.every((m) => !/\[\d+\]/.test(m.content)),
    'метки [n] прошлого ответа убраны',
  );
  assert.match(assistant[0].content, /Не менее 6 месяцев/);
  assert.equal(
    second.reply.text,
    'Это отдельный вопрос.',
    'в новом ответе [1] не стало источником: модель инструментов не вызывала',
  );
  assert.equal(second.sources, undefined);
});

// ---------- документ целиком и адрес фрагмента ----------

test(
  'клинрек: глава источника для ?section=, фрагмент подсвечивается по ?chunk=, чужой фрагмент игнорируется',
  { skip },
  async () => {
    const body = await ask('Сколько должна длиться тревога для диагноза ГТР?', {}, SEARCH, {
      mode: 'text',
      text: 'Ответ [1].',
    });
    const src = body.sources[0];
    const c = await ctx.as('psy1');
    const doc = expectOk(await c.get(`/work/api/clinrecs/gtr_2024?section=${encodeURIComponent(src.section_id)}`));
    assert.ok(doc.focus, 'есть глава источника');
    assert.equal(doc.focus.section_id, src.section_id);
    assert.ok(
      doc.sections.some((s) => s.id === doc.focus.top_id && s.level === 2),
      'глава есть в оглавлении',
    );
    assert.equal(expectOk(await c.get('/work/api/clinrecs/gtr_2024')).focus, undefined, 'без ?section= фокуса нет');

    const base = `/work/api/clinrecs/gtr_2024/sections/${encodeURIComponent(doc.focus.top_id)}`;
    const sec = expectOk(await c.get(`${base}?chunk=${encodeURIComponent(src.chunk_id)}`));
    assert.ok(sec.mark, 'фрагмент найден в главе');
    assert.ok(sec.mark.end > sec.mark.start);
    assert.ok(sec.text.length >= sec.mark.end, 'страница доходит до конца подсвеченного фрагмента');
    assert.ok(Array.isArray(sec.parts) && sec.parts.length);
    assert.equal(expectOk(await c.get(base)).mark, undefined);
    assert.equal(
      expectOk(await c.get(`${base}?chunk=нет-такого`)).mark,
      undefined,
      'неизвестный фрагмент: подсветки нет, раздел отдаётся',
    );
  },
);

test('обороты про ход поиска вырезаются целыми предложениями; ответ, состоящий только из них, не пустеет', () => {
  assert.equal(
    S.stripMeta('Не удалось найти информацию. Дозы 50 мг [1]. В предоставленных фрагментах нет данных о беременности.'),
    'Дозы 50 мг [1].',
  );
  assert.equal(S.stripMeta('В материалах этого нет.'), 'В материалах этого нет.');
  const n = S.createNumbering();
  assert.equal(n.add('a', { label: 'А' }), 1);
  assert.equal(n.add('a', { label: 'А' }), 1, 'тот же ключ — тот же номер');
  const done = n.finish('Факт [1]. Выдумка [5]. Знания [0].');
  assert.equal(done.text, 'Факт [1]. Выдумка. Знания [0].');
  assert.deepEqual(done.sources.map((x) => x.n), [0, 1]);
});

test('привязка уровней: УУР/УДД у препарата, которого нет в тексте источника, — предупреждение; препарат есть — нет', () => {
  const texts = { 1: 'Вальпроат и карбамазепин рекомендуются (УУР С).', 2: 'Литий рекомендуется.' };
  const check = (text) =>
    S.attributionWarnings(text, {
      innsIn: (sentence) => ['литий', 'вальпроат'].filter((d) => sentence.toLowerCase().includes(d.slice(0, 5))),
      textOf: (n) => texts[n],
    });
  assert.deepEqual(check('Литий показан (УУР С, УДД 2) [1].'), [{ n: 1, drug: 'литий' }]);
  assert.deepEqual(check('Литий показан (УУР С) [2].'), []);
  assert.deepEqual(check('Литий показан [1].'), [], 'без уровня доказательности проверки нет');
  assert.deepEqual(check('Литий (УУР С) — знания [0].'), [], '[0] не проверяется');
});

test('предупреждение о привязке уровня пишется в журнал шагов, ответ не меняется', { skip }, async () => {
  const name = ctx.app.query("SELECT name FROM inn WHERE status='in_catalog' LIMIT 1")[0].name;
  const text = `${name} показан (УУР C, УДД 2) [1].`;
  const body = await ask('Что по тактике?', {}, READ, { mode: 'text', text });
  assert.equal(body.reply.text, text, 'ответ не менялся');
  const step = ctx.app.query("SELECT result_text FROM ai_agent_steps WHERE name='attribution_warning' ORDER BY id DESC LIMIT 1")[0];
  assert.ok(step && step.result_text.includes('[1]') && step.result_text.includes(name));
});
