'use strict';
// covers: F-32, PD-17; агент психиатра по клиническим рекомендациям (этап 2 плана агента): в чате без пациента модель
// получает каталог и инструменты поиска, оглавления и чтения раздела; ссылки [n] превращаются в источники с разделом.
// Нужен запущенный Postgres знаний (KNOWLEDGE_TEST_DATABASE_URL или KNOWLEDGE_DATABASE_URL) с клинреками; только чтение.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk } = require('../lib/client');

const URL = process.env.KNOWLEDGE_TEST_DATABASE_URL || process.env.KNOWLEDGE_DATABASE_URL;
const ctx = useApp({ env: { KNOWLEDGE_DATABASE_URL: URL || '', CLINICIAN_AGENT_MODE: 'tools' } });
const skip = URL ? false : 'нет KNOWLEDGE_DATABASE_URL';

const ask = async (who, text, ...script) => {
  const c = await ctx.as(who);
  ctx.app.ai.reset();
  ctx.app.ai.queue(...script);
  return expectOk(await c.post('/api/v1/ai/clinician/messages', { text, chips: [] }), 201);
};

test(
  'психиатр без пациента: поиск, оглавление, чтение раздела; источники по ссылкам [n] с разделом',
  { skip },
  async () => {
    const body = await ask(
      'psy1',
      'Сколько должна длиться тревога для диагноза ГТР?',
      {
        mode: 'tool',
        name: 'search_clinrec',
        arguments: { query: 'критерии диагноза ГТР тревога 6 месяцев', clinrec_id: 'gtr_2024' },
      },
      { mode: 'tool', name: 'get_clinrec_outline', arguments: { clinrec_id: 'gtr_2024' } },
      { mode: 'tool', name: 'read_clinrec_section', arguments: { clinrec_id: 'gtr_2024', sections: ['5.1'] } },
      { mode: 'text', text: 'ОТВЕТ' },
    );
    const calls = ctx.app.ai.calls();
    assert.equal(calls.length, 4);
    const names = (calls[0].tools || []).map((t) => t.name);
    assert.deepEqual(names.slice(0, 3), ['search_clinrec', 'get_clinrec_outline', 'read_clinrec_section']);
    assert.match(calls[0].system, /Работа с клиническими рекомендациями/, 'правила агента по клинрекам');
    assert.doesNotMatch(calls[0].system, /Работа с данными пациента/, 'правил инструментов пациента нет');
    assert.match(
      calls[0].messages.at(-1).content,
      /gtr_2024 — Генерализованное тревожное расстройство/,
      'каталог в запросе',
    );
    const toolText = (i) => calls[i].messages.filter((m) => m.role === 'tool').at(-1).content;
    assert.match(toolText(1), /^Найдено/);
    assert.match(toolText(1), /\[1\] /);
    assert.match(toolText(2), /5\.1 Критерии диагноза/, 'оглавление с номерами разделов');
    assert.match(toolText(3), /6 месяцев/, 'раздел прочитан целиком');
    const read = /\[(\d+)\] Генерализованное тревожное расстройство, раздел 5\.1/.exec(toolText(3));
    assert.ok(read, 'у прочитанного раздела есть номер источника');
    assert.equal(body.reply.text, 'ОТВЕТ');
    assert.equal(body.sources, undefined, 'без ссылок [n] в ответе источников нет');

    const cited = await ask(
      'psy1',
      'Сколько должна длиться тревога для диагноза ГТР?',
      { mode: 'tool', name: 'read_clinrec_section', arguments: { clinrec_id: 'gtr_2024', sections: ['5.1'] } },
      { mode: 'text', text: 'Не менее 6 месяцев [1]. Выдуманная ссылка [42]. Рассказать подробнее о критериях?' },
    );
    assert.equal(cited.sources.length, 1, 'несуществующий номер [42] отброшен');
    const s = cited.sources[0];
    assert.equal(s.clinrec, true);
    assert.equal(s.document_id, 'gtr_2024');
    assert.equal(s.section_id, 'gtr_2024.n.5.1');
    assert.equal(s.section_no, '5.1');
    assert.match(s.path, /Критерии диагноза/);

    const run = ctx.app.query('SELECT * FROM ai_agent_runs ORDER BY id DESC LIMIT 1')[0];
    const steps = ctx.app.query('SELECT kind, name, status FROM ai_agent_steps WHERE run_id = ? ORDER BY n', run.id);
    assert.deepEqual(
      steps.map((x) => `${x.kind}:${x.name || ''}`),
      ['model:read_clinrec_section', 'tool:read_clinrec_section', 'model:'],
    );
    const log = ctx.app.query("SELECT count(*) n FROM action_log WHERE action = 'knowledge.clinrec_tool'")[0].n;
    assert.ok(log >= 2, 'обращение к знаниям записано (без содержимого)');
  },
);

test('ошибки аргументов возвращаются модели текстом, а не падением', { skip }, async () => {
  await ask(
    'psy1',
    'Что в разделе?',
    { mode: 'tool', name: 'get_clinrec_outline', arguments: { clinrec_id: 'nope' } },
    { mode: 'tool', name: 'read_clinrec_section', arguments: { clinrec_id: 'gtr_2024', sections: ['6'] } },
    { mode: 'text', text: 'Готово.' },
  );
  const calls = ctx.app.ai.calls();
  const tool = (i) => calls[i].messages.filter((m) => m.role === 'tool').at(-1).content;
  assert.match(tool(1), /Нет такой рекомендации/);
  assert.match(tool(2), /Слишком много текста[\s\S]*6\.2 /, 'большой раздел — оглавление вместо текста');
});

test('психолог не получает инструментов по клинрекам', { skip }, async () => {
  await ask('plg1', 'Что такое ГТР?', { mode: 'text', text: 'Ответ.' });
  const call = ctx.app.ai.calls()[0];
  assert.ok(!(call.tools || []).some((t) => t.name === 'search_clinrec'));
});

test(
  'психиатр с закреплённым пациентом: инструменты данных пациента и знаний вместе, оба слоя правил',
  { skip },
  async () => {
    const c = await ctx.as('psy1');
    ctx.app.ai.reset();
    ctx.app.ai.queue(
      { mode: 'tool', name: 'get_overview', arguments: {} },
      {
        mode: 'tool',
        name: 'search_clinrec',
        arguments: { query: 'терапия первой линии ГТР', clinrec_id: 'gtr_2024' },
      },
      { mode: 'text', text: 'Черновик для проверки [1].' },
    );
    const body = expectOk(
      await c.post('/api/v1/ai/clinician/messages', {
        patient_id: ctx.id('patA'),
        text: 'Что рекомендации говорят о первой линии для этого пациента?',
        chips: [{ type: 'patient', id: ctx.id('patA') }],
      }),
      201,
    );
    const calls = ctx.app.ai.calls();
    const names = (calls[0].tools || []).map((t) => t.name);
    assert.ok(names.includes('get_overview') && names.includes('search_clinrec'));
    assert.match(calls[0].system, /Работа с данными пациента/);
    assert.match(calls[0].system, /Работа с клиническими рекомендациями/);
    assert.equal(body.sources.length, 1);
    assert.equal(body.sources[0].clinrec, true);
    assert.ok(!ctx.app.ai.seenText().includes('Марина'), 'имени пациента модель не видит');
  },
);
