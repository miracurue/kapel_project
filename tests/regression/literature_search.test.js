'use strict';
// covers: F-32, PD-14; этап 8 плана агента: поиск научных статей (Europe PMC) у психиатра — только без закреплённого
// пациента, только если включён, наружу уходит очищенный запрос. Europe PMC подменён локальным сервером.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { useApp } = require('../lib/suite');
const { expectOk } = require('../lib/client');

const seen = [];
const server = http.createServer((req, res) => {
  seen.push(req.url);
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      resultList: {
        result: [
          {
            id: '111',
            source: 'MED',
            pmid: '111',
            doi: '10.1000/test.1',
            title: 'Pregabalin for generalized anxiety disorder: a <i>meta-analysis</i>',
            authorString: 'Synthetic A, Synthetic B',
            journalTitle: 'Synthetic Journal',
            pubYear: '2023',
            abstractText: 'Synthetic abstract: pregabalin reduced HAM-A scores versus placebo.',
          },
          { id: '222', source: 'MED', pmid: '222', title: 'Second synthetic study', pubYear: '2021' },
        ],
      },
    }),
  );
});
const opts = { env: { LITERATURE_SEARCH: 'europepmc' } };
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  opts.env.LITERATURE_API_BASE = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const ctx = useApp(opts);

const ask = async (body, ...script) => {
  const c = await ctx.as('psy1');
  ctx.app.ai.reset();
  ctx.app.ai.queue(...script);
  return expectOk(await c.post('/api/v1/ai/clinician/messages', body), 201);
};

test('психиатр без пациента: статьи по запросу модели, ссылки [n] — источники со ссылкой на статью', async () => {
  const r = await ask(
    { text: 'Есть ли метаанализы по прегабалину при ГТР?' },
    {
      mode: 'tool',
      name: 'search_literature',
      arguments: { query: 'generalized anxiety disorder pregabalin #PERSON-1# 89161234567', from_year: 2020 },
    },
    { mode: 'text', text: 'Метаанализ 2023 года [1]. Данные требуют проверки врачом.' },
  );
  const calls = ctx.app.ai.calls();
  assert.ok((calls[0].tools || []).some((t) => t.name === 'search_literature'));
  assert.match(calls[0].system, /Поиск научных статей/);
  const q = new URL(seen.at(-1), 'http://x').searchParams.get('query');
  assert.match(q, /generalized anxiety disorder pregabalin/);
  assert.doesNotMatch(q, /PERSON|8916/, 'метки и длинные числа не уходят наружу');
  assert.match(q, /PUB_YEAR:\[2020 TO 3000\]/);
  const tool = calls[1].messages.filter((m) => m.role === 'tool').at(-1).content;
  assert.match(tool, /\[1\] Pregabalin for generalized anxiety disorder: a meta-analysis/);
  assert.match(tool, /Synthetic abstract/);
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0].literature, true);
  assert.equal(r.sources[0].url, 'https://doi.org/10.1000/test.1');
  const log = ctx.app.query("SELECT count(*) n FROM action_log WHERE action = 'literature.search'")[0].n;
  assert.equal(log, 1);
});

test('с закреплённым пациентом поиска статей нет', async () => {
  await ask(
    { patient_id: ctx.id('patA'), text: 'Что известно?', chips: [{ type: 'patient', id: ctx.id('patA') }] },
    { mode: 'text', text: 'Ответ.' },
  );
  const call = ctx.app.ai.calls()[0];
  assert.ok(!(call.tools || []).some((t) => t.name === 'search_literature'));
});
