'use strict';
// Журнал: две аудитории, лайки, ранжирование, подгрузка страницами, управление из админки.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const ctx = useApp();

async function publish(doc, title, audience, tags = ['тема:сон']) {
  const made = expectOk(
    await doc.post('/work/api/library', { title, body_md: `## ${title}\n\nТекст.`, tags, audience }, { idem: false }),
    201,
  );
  expectOk(await doc.post(`/work/api/library/${made.id}/publish`, {}, { idem: false }));
  return made.id;
}
const page = async (client, path) => (await client.get(path)).body;

test('журнал: пациент видит только журнал для пациентов, специалист — оба', async () => {
  const doc = await ctx.as('psy1');
  const patient = await ctx.as('patA');
  const forPatients = await publish(doc, 'Журнал-пациентам', 'patient', ['тема:аудитория']);
  const forSpecs = await publish(doc, 'Журнал-коллегам', 'specialist', ['тема:аудитория']);
  const q = '&topic=' + encodeURIComponent('аудитория');
  const html = String(await page(patient, '/journal?aud=patient' + q));
  assert.match(html, /Журнал-пациентам/);
  assert.doesNotMatch(String(await page(patient, '/journal?aud=specialist' + q)), /Журнал-коллегам/); // чужая аудитория → своя лента
  assert.doesNotMatch(html, /Журнал-коллегам/);
  assert.equal((await patient.get(`/journal/${forSpecs}`)).status, 404);
  assert.equal((await patient.get(`/journal/${forPatients}`)).status, 200);
  expectError(await patient.get('/journal/feed?aud=specialist'), 403, 'E-ACCESS');
  assert.match(String(await page(doc, '/journal?aud=specialist' + q)), /Журнал-коллегам/);
  assert.match(String(await page(doc, '/journal?aud=patient' + q)), /Журнал-пациентам/);
  assert.equal((await (await ctx.as('admin1')).get('/journal')).status, 404);
});

test('журнал: лайк ставится один раз, снимается, чужой аудитории недоступен; без CSRF нельзя', async () => {
  const doc = await ctx.as('psy1');
  const patient = await ctx.as('patA');
  const id = await publish(doc, 'Лайк-статья', 'patient');
  const put = (c, liked, opts = {}) => c.put(`/journal/api/${id}/like`, { liked }, { idem: false, ...opts });
  assert.deepEqual(expectOk(await put(patient, true)), { liked: true, likes: 1 });
  assert.deepEqual(expectOk(await put(patient, true)), { liked: true, likes: 1 });
  assert.deepEqual(expectOk(await put(await ctx.as('patB'), true)), { liked: true, likes: 2 });
  assert.deepEqual(expectOk(await put(patient, false)), { liked: false, likes: 1 });
  expectError(await put(patient, true, { csrf: false }), 403, 'E-CSRF');
  expectError(await put(patient, 'да'), 422, 'E-VALIDATION');
  const spec = await publish(doc, 'Лайк-коллегам', 'specialist');
  expectError(await patient.put(`/journal/api/${spec}/like`, { liked: true }, { idem: false }), 404, 'E-NOT-FOUND');
  expectError(await ctx.guest().put(`/journal/api/${id}/like`, { liked: true }, { idem: false }), 401, 'E-SESSION-EXPIRED');
});

test('журнал: ранжирование — понравившаяся статья выше равной по возрасту; лента подгружается страницами', async () => {
  const doc = await ctx.as('psy1');
  const patient = await ctx.as('patA');
  const ids = [];
  for (let i = 0; i < 8; i += 1) ids.push(await publish(doc, `Лента ${i}`, 'patient', ['тема:лента']));
  expectOk(await patient.put(`/journal/api/${ids[0]}/like`, { liked: true }, { idem: false }));
  expectOk(await (await ctx.as('patB')).put(`/journal/api/${ids[0]}/like`, { liked: true }, { idem: false }));
  const first = String(await page(patient, '/journal?aud=patient&topic=' + encodeURIComponent('лента')));
  const order = [...first.matchAll(/class="j-card[^"]*" data-id="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(order[0], ids[0]);
  assert.equal(order.length, 6);
  const next = expectOk(await patient.get('/journal/feed?aud=patient&page=2&topic=' + encodeURIComponent('лента')));
  assert.equal(next.has_more, false);
  assert.equal([...next.html.matchAll(/data-id="(\d+)"/g)].length, 2);
});

test('журнал: админ правит, снимает, публикует и удаляет статью; остальные роли не могут', async () => {
  const doc = await ctx.as('psy1');
  const admin = await ctx.as('admin1');
  const id = await publish(doc, 'Админ-статья', 'patient');
  const list = expectOk(await admin.get('/admin/api/journal')).items;
  assert.ok(list.some((x) => x.id === id));
  const edited = expectOk(
    await admin.put(`/admin/api/journal/${id}`, { title: 'Исправлено', audience: 'specialist', tags: ['Тема:Новая'] }, { idem: false }),
  );
  assert.equal(edited.title, 'Исправлено');
  assert.equal(edited.audience, 'specialist');
  assert.deepEqual(edited.tags, ['тема:новая']);
  assert.match(String(await page(doc, `/journal/${id}`)), /Исправлено/);
  expectError(await admin.put(`/admin/api/journal/${id}`, { title: ' ' }, { idem: false }), 422, 'E-VALIDATION');
  expectOk(await admin.post(`/admin/api/journal/${id}/unpublish`, {}, { idem: false }));
  assert.equal((await doc.get(`/journal/${id}`)).status, 404);
  expectOk(await admin.post(`/admin/api/journal/${id}/publish`, {}, { idem: false }));
  assert.equal((await doc.get(`/journal/${id}`)).status, 200);
  expectError(await doc.get('/admin/api/journal'), 403, 'E-ACCESS');
  expectError(await (await ctx.as('patA')).del(`/admin/api/journal/${id}`, undefined, { idem: false }), 403, 'E-ACCESS');
  expectError(await admin.del(`/admin/api/journal/${id}`, undefined, { idem: false, csrf: false }), 403, 'E-CSRF');
  expectOk(await admin.del(`/admin/api/journal/${id}`, undefined, { idem: false }));
  assert.equal((await doc.get(`/journal/${id}`)).status, 404);
  expectError(await admin.del(`/admin/api/journal/${id}`, undefined, { idem: false }), 404, 'E-NOT-FOUND');
});
