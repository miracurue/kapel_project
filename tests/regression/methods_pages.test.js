'use strict';
// Методики самопомощи: открыты пациенту и специалистам без назначения; упражнение рисуется на самой странице (без рамки).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { TECHNIQUES } = require('../../src/modules/techniques/catalog');
const ctx = useApp();

test('вкладка «Методики»: пациент и специалист видят все карточки без назначения', async () => {
  for (const [who, url] of [
    ['patA', '/app?tab=tests'],
    ['psy1', '/work?tab=tools'],
  ]) {
    const page = (await (await ctx.as(who)).get(url)).body;
    for (const x of TECHNIQUES) assert.ok(page.includes(`href="/methods/${x.slug}"`), `${who}: карточка ${x.slug}`);
  }
});

test('страница методики: упражнение на странице без iframe, у неизвестной — 404, гостю — вход', async () => {
  const patient = await ctx.as('patA');
  for (const x of TECHNIQUES) {
    const r = await patient.get(`/methods/${x.slug}`);
    assert.equal(r.status, 200);
    // test-change: рамка с отдельной html-страницей заменена упражнением на странице (владелица, 2026-10-26)
    assert.doesNotMatch(r.body, /<iframe/);
    assert.ok(r.body.includes(`data-technique-app="${x.slug}"`));
    assert.ok(r.body.includes('/techniques.js') && r.body.includes('/techniques.css'));
  }
  assert.equal((await (await ctx.as('psy1')).get(`/methods/${TECHNIQUES[0].slug}`)).status, 200);
  assert.equal((await patient.get('/methods/net-takoj')).status, 404);
  assert.equal((await ctx.guest().get(`/methods/${TECHNIQUES[0].slug}`)).status, 302);
});

test('старых отдельных страниц методик больше нет', async () => {
  const r = await (await ctx.as('patA')).get(`/techniques/${TECHNIQUES[0].slug}.html`);
  assert.equal(r.status, 404);
});
