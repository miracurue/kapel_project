'use strict';
// Печать: пустой бланк теста для специалиста и тихая кнопка печати в статье журнала.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const ctx = useApp();

test('бланк теста: специалист получает пустой бланк без баллов, пациенту и гостю — нет, неизвестный тест — 404', async () => {
  const doc = await ctx.as('psy1');
  const r = await doc.get('/print/test/gad7');
  assert.equal(r.status, 200);
  assert.match(r.body, /class="box"/);
  assert.doesNotMatch(r.body, /score|балл:/i, 'в бланке нет ключа и баллов');
  assert.equal((await doc.get('/print/test/net-takogo')).status, 404);
  assert.equal((await (await ctx.as('patA')).get('/print/test/gad7')).status, 404);
  assert.equal((await ctx.guest().get('/print/test/gad7')).status, 302);
});

test('статья журнала: у читателя есть тихая кнопка печати', async () => {
  const page = (await (await ctx.as('patA')).get('/journal')).body;
  const id = /\/journal\/(\d+)/.exec(page)?.[1];
  assert.ok(id, 'в ленте есть статья');
  const art = await (await ctx.as('patA')).get(`/journal/${id}`);
  assert.equal(art.status, 200);
  assert.match(art.body, /data-print-article/);
});
