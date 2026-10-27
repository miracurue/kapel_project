'use strict';
// covers: «Сохранить как документ» (вкладка «Шаблоны и документы»): подставленный текст шаблона → готовый документ пациента.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const ctx = useApp();
const q = (sql, ...args) => ctx.app.query(sql, ...args);

test('документ из шаблона: создаётся готовым, виден в списке, название «шаблон — пациент, дата», шаблон не затронут', async () => {
  const psy = await ctx.as('psy1');
  const tpl = expectOk(
    await psy.post('/work/api/templates', { title: 'Памятка', body: 'Пациент: [ФИО]' }, { idem: false }),
    201,
  );
  const made = expectOk(
    await psy.post('/work/api/documents/from-text', {
      patient_id: ctx.id('patA'),
      title: 'Памятка',
      body: 'Пациент: Иванов',
    }),
    201,
  ).document;
  assert.equal(made.kind, 'text');
  assert.equal(made.status, 'ready');
  assert.equal(made.body, 'Пациент: Иванов');
  assert.match(made.title, /^Памятка — .+, \d{2}\.\d{2}\.\d{4}$/);
  const listed = expectOk(await psy.get('/work/api/documents')).patients.flatMap((p) => p.documents);
  assert.ok(listed.some((d) => d.id === made.id && d.kind === 'text'));
  assert.equal(expectOk(await psy.get(`/work/api/documents/${made.id}`)).document.body, 'Пациент: Иванов');
  assert.equal(expectOk(await psy.get('/work/api/templates')).own.find((t) => t.id === tpl.id).body, 'Пациент: [ФИО]');
  assert.ok(
    !String(q('SELECT fields_enc FROM clinician_documents WHERE id=?', made.id)[0].fields_enc).includes('Иванов'),
    'в базе зашифровано',
  );
  assert.ok(
    q(
      "SELECT 1 FROM phi_access_log WHERE actor_id=? AND patient_id=? AND section='export'",
      ctx.id('psy1'),
      ctx.id('patA'),
    ).length,
  );
  // готовый не правится, исправленной версии и файла у текстового документа нет
  expectError(
    await psy.put(`/work/api/documents/${made.id}`, { version: 1, fields: {} }, { idem: false }),
    409,
    'E-SIGNED-IMMUTABLE',
  );
  expectError(await psy.post(`/work/api/documents/${made.id}/revise`, {}), 409, 'E-STATUS');
});

test('документ из шаблона: повтор с тем же ключом не дублирует; доступы и проверки', async () => {
  const psy = await ctx.as('psy1');
  const key = 'idem-from-text-1';
  const send = () =>
    psy.post('/work/api/documents/from-text', { patient_id: ctx.id('patA'), title: 'Т', body: 'Текст' }, { idem: key });
  const a = expectOk(await send(), 201).document;
  const b = expectOk(await send(), 201).document;
  assert.equal(a.id, b.id);
  expectError(
    await psy.post('/work/api/documents/from-text', { patient_id: ctx.id('patB'), title: 'Т', body: 'x' }),
    404,
    'E-NOT-FOUND',
  );
  expectError(
    await psy.post('/work/api/documents/from-text', { patient_id: ctx.id('patA'), title: 'Т', body: '  ' }),
    422,
    'E-VALIDATION',
  );
  expectError(
    await psy.post('/work/api/documents/from-text', { patient_id: ctx.id('patA'), title: '', body: 'x' }),
    422,
    'E-VALIDATION',
  );
  expectError(
    await psy.post(
      '/work/api/documents/from-text',
      { patient_id: ctx.id('patA'), title: 'Т', body: 'x' },
      { csrf: false },
    ),
    403,
    'E-CSRF',
  );
  expectError(
    await (
      await ctx.as('plg1')
    ).post('/work/api/documents/from-text', { patient_id: ctx.id('patA'), title: 'Т', body: 'x' }),
    403,
    'E-ACCESS',
  );
  expectError(await ctx.guest().post('/work/api/documents/from-text', {}), 401, 'E-SESSION-EXPIRED');
});
