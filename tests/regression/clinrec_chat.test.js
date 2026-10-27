'use strict';
// Вопрос ИИ по клинической рекомендации: выдержки только из выбранного документа, тред — обычный чат специалиста.
// Нужен запущенный Postgres знаний (KNOWLEDGE_TEST_DATABASE_URL или KNOWLEDGE_DATABASE_URL); читает, ничего не пишет.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');

const URL = process.env.KNOWLEDGE_TEST_DATABASE_URL || process.env.KNOWLEDGE_DATABASE_URL;
const ctx = useApp({ env: { KNOWLEDGE_DATABASE_URL: URL || '', CLINICIAN_AGENT_MODE: 'tools' } });
const skip = URL ? false : 'нет KNOWLEDGE_DATABASE_URL';

test('клинрек: поиск, карточка, вопрос с выдержками и продолжение того же треда', { skip }, async () => {
  const psy = await ctx.as('psy1');
  const found = expectOk(await psy.get(`/work/api/clinrecs?q=${encodeURIComponent('депресс')}`));
  assert.ok(found.items.length >= 1);
  const id = found.items[0].id;
  const card = expectOk(await psy.get(`/work/api/clinrecs/${id}`));
  assert.ok(card.title && card.sections.length > 0);
  const sec = card.sections.find((x) => x.level === 2);
  const part = expectOk(await psy.get(`/work/api/clinrecs/${id}/sections/${encodeURIComponent(sec.id)}`));
  assert.ok(part.text.length > 50 && typeof part.hasMore === 'boolean');
  expectError(await psy.get(`/work/api/clinrecs/${id}/sections/nope`), 404, 'E-NOT-FOUND');
  expectError(await psy.get(`/work/api/clinrecs/${id}/sections/${sec.id}?cursor=-1`), 422, 'E-VALIDATION');
  const noPdf = await psy.get('/work/api/clinrecs/cogn_2024/pdf');
  assert.equal(noPdf.status, 404, 'у документа без файла PDF нет');
  const pdf = await psy.get(`/work/api/clinrecs/${id}/pdf`);
  assert.equal(pdf.status, card.pdf ? 200 : 404);
  ctx.app.ai.reset();
  ctx.app.ai.queue({ mode: 'text', text: 'Первая линия описана [1]. Из знаний [0]. Выдумка [42]. В предоставленных фрагментах иного нет.' });
  const first = await psy.post(`/work/api/clinrecs/${id}/messages`, { text: 'Какова первая линия терапии?' }, { idem: false });
  assert.equal(first.status, 201);
  const real = first.body.sources.filter((s) => !s.model_knowledge);
  assert.ok(real.length === 1 && real[0].n === 1 && real[0].clinrec && real[0].document_id === id && real[0].chunk_id);
  assert.equal(first.body.sources[0].model_knowledge, true);
  assert.equal(first.body.reply.text, 'Первая линия описана [1]. Из знаний [0]. Выдумка.', 'метка [42] и оборот про фрагменты убраны');
  const second = await psy.post(
    `/work/api/clinrecs/${id}/messages`,
    { text: 'А длительность?', thread_id: first.body.thread.id },
    { idem: false },
  );
  assert.equal(second.body.thread.id, first.body.thread.id);
  expectError(await psy.post('/work/api/clinrecs/nope/messages', { text: 'x?' }, { idem: false }), 404, 'E-NOT-FOUND');
  expectError(
    await psy.post(`/work/api/clinrecs/${id}/messages`, { text: 'y?', thread_id: 999999 }, { idem: false }),
    404,
    'E-NOT-FOUND',
  );
  expectError(await psy.post(`/work/api/clinrecs/${id}/messages`, { text: 'y?' }, { csrf: false, idem: false }), 403, 'E-CSRF');
  expectError(
    await (await ctx.as('patA')).post(`/work/api/clinrecs/${id}/messages`, { text: 'y?' }, { idem: false }),
    403,
    'E-ACCESS',
  );
});
