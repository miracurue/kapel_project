'use strict';
// Раздел «Шаблоны»: личные шаблоны текстов врача, подстановка данных пациента, кнопка «ИИ».
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const ctx = useApp();

test('шаблоны: врач создаёт, правит и удаляет свой шаблон; чужой недоступен (404)', async () => {
  const psy = await ctx.as('psy1');
  const made = expectOk(
    await psy.post('/work/api/templates', { title: 'Запись приёма', body: 'Пациент: [ФИО]' }, { idem: false }),
    201,
  );
  assert.equal(made.title, 'Запись приёма');
  let list = expectOk(await psy.get('/work/api/templates'));
  assert.ok(list.own.some((t) => t.id === made.id));
  assert.ok(list.builtin.length > 0, 'заготовки роли есть');
  expectOk(await psy.put(`/work/api/templates/${made.id}`, { title: 'Приём', body: 'Текст' }, { idem: false }));
  const other = await ctx.as('plg1');
  assert.ok(!expectOk(await other.get('/work/api/templates')).own.some((t) => t.id === made.id));
  expectError(
    await other.put(`/work/api/templates/${made.id}`, { title: 'x', body: 'y' }, { idem: false }),
    404,
    'E-NOT-FOUND',
  );
  expectError(await other.del(`/work/api/templates/${made.id}`, undefined, { idem: false }), 404, 'E-NOT-FOUND');
  expectOk(await psy.del(`/work/api/templates/${made.id}`, undefined, { idem: false }));
  list = expectOk(await psy.get('/work/api/templates'));
  assert.ok(!list.own.some((t) => t.id === made.id));
});

test('шаблоны: пациент и гость не имеют доступа, запись без CSRF отклоняется, пустой текст — 422', async () => {
  const patient = await ctx.as('patA');
  expectError(await patient.get('/work/api/templates'), 403, 'E-ACCESS');
  expectError(await ctx.guest().get('/work/api/templates'), 401, 'E-SESSION-EXPIRED');
  const psy = await ctx.as('psy1');
  expectError(
    await psy.post('/work/api/templates', { title: 'a', body: 'b' }, { csrf: false, idem: false }),
    403,
    'E-CSRF',
  );
  expectError(await psy.post('/work/api/templates', { title: 'a', body: '  ' }, { idem: false }), 422, 'E-VALIDATION');
});

test('шаблоны: данные подставляются только для закреплённого пациента', async () => {
  const psy = await ctx.as('psy1');
  const filled = expectOk(await psy.get(`/work/api/templates/patient/${ctx.id('patA')}`));
  assert.ok(filled['ФИО'] && filled['дата'] && 'результаты тестов' in filled);
  expectError(await psy.get(`/work/api/templates/patient/${ctx.id('psy1')}`), 404, 'E-NOT-FOUND');
});

test('шаблоны: кнопка «ИИ» возвращает текст шаблона по описанию', async () => {
  const psy = await ctx.as('psy1');
  const r = await psy.post(
    '/work/api/templates/ai',
    { request: 'памятка пациенту после первого приёма' },
    { idem: false },
  );
  expectOk(r);
  assert.ok(typeof r.body.body === 'string' && r.body.body.length > 0);
  expectError(await psy.post('/work/api/templates/ai', { request: '' }, { idem: false }), 422, 'E-VALIDATION');
});

test('страница «Шаблоны» открывается и содержит список шаблонов и кнопку ИИ', async () => {
  const psy = await ctx.as('psy1');
  const page = await psy.get('/work?tab=docs', { headers: { accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(String(page.body), /data-tpl-ai/);
  assert.match(String(page.body), /data-tpl-new/);
});

test('вкладка «Шаблоны и документы»: у психиатра переключатель и форма извещения, у психолога только шаблоны', async () => {
  const psy = await (await ctx.as('psy1')).get('/work?tab=docs', { headers: { accept: 'text/html' } });
  assert.match(String(psy.body), /data-doc-seg/);
  assert.match(String(psy.body), /data-doc-fill/);
  assert.match(String(psy.body), /Шаблоны и документы/);
  assert.doesNotMatch(String(psy.body), /Заготовк|Мои шаблоны|PDF/);
  const plg = await (await ctx.as('plg1')).get('/work?tab=docs', { headers: { accept: 'text/html' } });
  assert.doesNotMatch(String(plg.body), /data-doc-seg|data-doc-fill|work_documents/);
});

test('шаблоны: история сохраняется с собственным шаблоном, чужая правка истории — 404', async () => {
  const psy = await ctx.as('psy1');
  const messages = [
    { role: 'user', text: 'Сократи шаблон', status: 'done' },
    { role: 'assistant', text: 'Готово', status: 'done' },
  ];
  const item = expectOk(
    await psy.post('/work/api/templates', { title: 'История', body: 'Текст', messages }, { idem: false }),
    201,
  );
  assert.deepEqual(item.messages, messages);
  const other = await ctx.as('plg1');
  expectError(
    await other.put(`/work/api/templates/${item.id}`, { title: 'Чужой', body: 'Текст', messages: [] }, { idem: false }),
    404,
    'E-NOT-FOUND',
  );
  const kept = expectOk(
    await psy.put(`/work/api/templates/${item.id}`, { title: 'Новый', body: 'Правка' }, { idem: false }),
  );
  assert.deepEqual(kept.messages, messages, 'ручная правка без messages сохраняет историю');
});

test('шаблоны: постфильтр не возвращает отказ как сгенерированный документ', async () => {
  const psy = await ctx.as('psy1');
  ctx.app.ai.queue({ mode: 'text', text: 'У вас депрессия.' });
  expectError(
    await psy.post('/work/api/templates/ai', { request: 'Сделай шаблон' }, { idem: false }),
    502,
    'E-AI-EMPTY',
  );
});

test('шаблоны: заключение ЭПИ (Приложение Г21 клинреков) есть у психолога по умолчанию, у психиатра нет', async () => {
  const plg = expectOk(await (await ctx.as('plg1')).get('/work/api/templates'));
  const epi = plg.builtin.find((t) => t.id === 'b-epi');
  assert.ok(epi, 'у психолога есть b-epi');
  assert.match(epi.body, /Внимание:[^\n]*\n.*Память:/s);
  const psy = expectOk(await (await ctx.as('psy1')).get('/work/api/templates'));
  assert.ok(!psy.builtin.some((t) => t.id === 'b-epi'));
});
