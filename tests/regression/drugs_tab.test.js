'use strict';
// Вкладка «Лекарства» специалиста: поиск, карточка, новый чат при открытии препарата, вопросы ИИ.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const ctx = useApp();

const open = async (c, innId) => {
  const r = await c.post(`/work/api/drugs/${innId}/open`, {}, { idem: false });
  assert.ok([200, 201].includes(r.status), `ожидался 200/201, пришёл ${r.status}`);
  return r.body;
};

test('лекарства: поиск по МНН и торговому названию, фильтр по группе, карточка с торговыми названиями', async () => {
  const psy = await ctx.as('psy1');
  const all = expectOk(await psy.get('/work/api/drugs'));
  assert.ok(all.items.length >= 10, 'без запроса виден весь каталог');
  const byInn = expectOk(await psy.get('/work/api/drugs?q=Сертрал'));
  assert.equal(byInn.items[0].name, 'сертралин');
  const byTrade = expectOk(await psy.get(`/work/api/drugs?q=${encodeURIComponent('золофт')}`));
  assert.ok(
    byTrade.items.some((d) => d.name === 'сертралин'),
    'нашли по торговому названию',
  );
  const groups = expectOk(await psy.get('/work/api/drugs?group=antidepressant'));
  assert.ok(groups.items.every((d) => d.group === 'antidepressant'));
  expectError(await psy.get('/work/api/drugs?group=nope'), 422, 'E-VALIDATION');
  assert.deepEqual(expectOk(await psy.get('/work/api/drugs?q=zzzнетакого')).items, []);
  const card = expectOk(await psy.get(`/work/api/drugs/${byInn.items[0].id}`));
  assert.equal(card.name, 'сертралин');
  assert.ok(card.atc && card.group_label && card.products.length > 0);
  expectError(await psy.get('/work/api/drugs/999999'), 404, 'E-NOT-FOUND');
});

test('лекарства: открытие препарата создаёт новый обычный ИИ-чат даже без вопроса; пустой свежий не плодится', async () => {
  const psy = await ctx.as('psy1');
  const [a, b] = expectOk(await psy.get('/work/api/drugs')).items;
  const first = await open(psy, a.id);
  assert.equal(first.thread.drug_inn_id, a.id);
  assert.equal(first.reused, false);
  assert.equal(first.thread.title.toLowerCase(), a.name.toLowerCase());
  const again = await open(psy, a.id);
  assert.equal(again.thread.id, first.thread.id, 'пустой чат по тому же препарату переиспользуется');
  const other = await open(psy, b.id);
  assert.notEqual(other.thread.id, first.thread.id, 'другой препарат — новый чат');
  const hist = expectOk(await psy.get('/work/api/drugs/threads')).items.map((x) => x.id);
  assert.ok(hist.includes(first.thread.id) && hist.includes(other.thread.id));
  // тред — обычный: виден в общем списке тредов, читается и переименовывается общими путями
  const common = expectOk(await psy.get('/api/v1/ai/threads?purpose=drug_chat')).items.map((x) => x.id);
  assert.ok(common.includes(first.thread.id));
  expectOk(await psy.get(`/api/v1/ai/threads/${first.thread.id}`));
  expectOk(await psy.patch(`/api/v1/ai/threads/${first.thread.id}`, { title: 'Мой чат' }));
});

test('лекарства: вопрос уходит в ИИ с карточкой препарата, ответ сохраняется в чате; чужой чат — 404', async () => {
  const psy = await ctx.as('psy1');
  const [a] = expectOk(await psy.get('/work/api/drugs?q=сертралин')).items;
  const { thread } = await open(psy, a.id);
  ctx.app.ai.reset();
  ctx.app.ai.queue({
    mode: 'text',
    text: 'Справочный ответ: сертралин обычно начинают с 50 мг. Это черновик для проверки.',
  });
  const r = expectOk(
    await psy.post(`/work/api/drugs/threads/${thread.id}/messages`, { text: 'Что с отменой?' }, { idem: false }),
    201,
  );
  assert.match(r.reply.text, /сертралин обычно начинают с 50 мг/, 'название и доза в справочном ответе не вырезаются');
  assert.equal(r.reply.status, 'normal');
  assert.equal(ctx.app.ai.calls().at(-1).purpose, 'clinician_chat');
  assert.match(ctx.app.ai.seenText(), /сертралин/);
  assert.match(ctx.app.ai.seenText(), /Что с отменой\?/);
  const saved = expectOk(await psy.get(`/api/v1/ai/threads/${thread.id}`));
  assert.deepEqual(
    saved.messages.map((m) => m.role),
    ['user', 'assistant'],
  );
  const other = await ctx.as('psy2');
  expectError(
    await other.post(`/work/api/drugs/threads/${thread.id}/messages`, { text: 'привет' }, { idem: false }),
    404,
    'E-NOT-FOUND',
  );
  expectError(await other.get(`/api/v1/ai/threads/${thread.id}`), 404, 'E-NOT-FOUND');
  expectError(
    await psy.post(`/work/api/drugs/threads/${thread.id}/messages`, { text: '  ' }, { idem: false }),
    422,
    'E-VALIDATION',
  );
});

test('лекарства: пациент и гость без доступа, запись без CSRF отклоняется', async () => {
  const patient = await ctx.as('patA');
  expectError(await patient.get('/work/api/drugs'), 403, 'E-ACCESS');
  expectError(await patient.post('/work/api/drugs/1/open', {}, { idem: false }), 403, 'E-ACCESS');
  expectError(await ctx.guest().get('/work/api/drugs'), 401, 'E-SESSION-EXPIRED');
  const psy = await ctx.as('psy1');
  expectError(await psy.post('/work/api/drugs/1/open', {}, { csrf: false, idem: false }), 403, 'E-CSRF');
});

test('лекарства: выбор пациента и лекарства — в общем чате, отдельной вкладки нет', async () => {
  for (const who of ['psy1', 'plg1']) {
    const c = await ctx.as(who);
    const page = await c.get('/work?tab=chat', { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.match(String(page.body), /data-pick-search/);
    assert.match(String(page.body), /data-subject/);
    const more = await c.get('/work?tab=more', { headers: { accept: 'text/html' } });
    assert.doesNotMatch(String(more.body), /tab=drugs/);
    assert.ok(!expectOk(await c.get('/api/v1/me')).tabs.includes('drugs'));
  }
});

test('лекарства: диагноз и императивы в ответе по-прежнему вырезаются, а в обычном чате названия препаратов фильтруются', async () => {
  const psy = await ctx.as('psy1');
  const [a] = expectOk(await psy.get('/work/api/drugs?q=сертралин')).items;
  const { thread } = await open(psy, a.id);
  ctx.app.ai.reset();
  ctx.app.ai.queue({ mode: 'text', text: 'У вас депрессия, принимайте сертралин.' });
  const r = expectOk(
    await psy.post(`/work/api/drugs/threads/${thread.id}/messages`, { text: 'Что делать?' }, { idem: false }),
    201,
  );
  assert.equal(r.reply.status, 'filtered');
  ctx.app.ai.reset();
  ctx.app.ai.queue({ mode: 'text', text: 'Сертралин назначают при депрессии.' });
  const chat = await psy.post('/api/v1/ai/clinician/messages', { text: 'Вопрос без пациента' });
  assert.equal(expectOk(chat, 201).reply.status, 'filtered', 'общий чат специалиста фильтруется как раньше');
});
