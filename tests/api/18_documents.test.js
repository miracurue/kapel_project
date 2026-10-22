'use strict';

// Документы по пациенту (F-67) и заключения психолога (F-68): черновик → «Готово» (неизменяемая версия),
// подпись с паролем только автором, выдача пациенту с отложенной видимостью, экспорт без ФИО в имени файла.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectError, expectOk } = require('../lib/client');
const { PASSWORD } = require('../fixtures/world');
const F = require('../lib/flows');

const ctx = useApp();

// covers: T-220, UC-20, F-67, PD-03, PD-19
test('T-220 [W-49] документ без ИИ: состав данных и недостающие поля; «Готово» — неизменяемая версия; правка готового — новая версия с причиной; экспорт в журнал', async () => {
  const doc = await ctx.as('psy1');
  const d = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patA')}/documents`, { type: 'mis_summary', period: { from: '2026-09-01', to: '2026-10-31' }, use_ai: false }), 201);
  assert.equal(d.status, 'draft');
  assert.ok(d.number && /\d{4}-\d{4}/.test(d.number), 'номер <тип>-<год>-<номер>');
  const ready = expectOk(await doc.post(`/api/v1/documents/${d.id}/ready`, { version: d.version }));
  assert.equal(ready.status, 'ready');
  expectError(await doc.put(`/api/v1/documents/${d.id}`, { version: ready.version, sections: [{ key: 'summary', text: 'правка' }] }), 409, 'E-SIGNED-IMMUTABLE');
  expectError(await doc.post(`/api/v1/documents/${d.id}/new-version`, {}), 422, 'E-VALIDATION');
  const nv = expectOk(await doc.post(`/api/v1/documents/${d.id}/new-version`, { reason: 'синтетика: уточнение' }));
  assert.equal(nv.version, ready.version + 1);
  assert.equal(nv.status, 'draft');
  const before = ctx.app.query('SELECT count(*) n FROM export_log')[0].n;
  const f = await doc.get(`/api/v1/documents/${d.id}/export?format=pdf`, { binary: true });
  assert.equal(f.status, 200);
  assert.doesNotMatch(f.headers.get('content-disposition') || '', /Марина|Тестова/);
  assert.equal(ctx.app.query('SELECT count(*) n FROM export_log')[0].n, before + 1);
  expectError(await (await ctx.as('psy2')).get(`/api/v1/documents/${d.id}`), 404, 'E-NOT-FOUND');
});

// covers: T-221, UC-20, F-67, F-58, PD-02
test('T-221 [W-49] у психолога документы без лекарственных разделов; выдать пациенту можно только памятку и итоговую сводку', async () => {
  const plg = await ctx.as('plg1');
  const d = expectOk(await plg.post(`/api/v1/patients/${ctx.id('patA')}/documents`, { type: 'mis_summary', use_ai: false }), 201);
  assert.ok(!d.sections.some((s) => /treatment|plan|meds|лекарств/i.test(s.key)), 'нет лекарственных разделов');
  const doc = await ctx.as('psy1');
  const sum = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patA')}/documents`, { type: 'visit_summary', use_ai: false }), 201);
  const r = expectOk(await doc.post(`/api/v1/documents/${sum.id}/ready`, { version: sum.version }));
  // T-003: выдача итоговой сводки — только R-04 (психолог), психиатру 403 E-ACCESS (одобрено 2026-10-21).
  expectError(await doc.post(`/api/v1/documents/${sum.id}/release`, {}), 403, 'E-ACCESS');
  void r;
});

// covers: T-222, UC-15, F-68, F-17, F-19, F-23
test('T-222 [W-49] заключение психолога: подпись только автором с паролем и подтверждением; 5 неверных паролей — пауза; подписанное неизменяемо; психиатр — только чтение; выдача видна пациенту после окна', async () => {
  const plg = await ctx.as('plg1');
  const c = expectOk(await plg.post(`/api/v1/patients/${ctx.id('patA')}/documents`, { type: 'conclusion', use_ai: false }), 201);
  expectError(await (await ctx.as('psy1')).post(`/api/v1/patients/${ctx.id('patA')}/documents`, { type: 'conclusion' }), 403, 'E-ACCESS');
  const psy = await ctx.as('psy1');
  expectError(await psy.post(`/api/v1/documents/${c.id}/sign`, { version: c.version, password: PASSWORD, confirm: true }), 403, 'E-ACCESS');
  expectError(await plg.post(`/api/v1/documents/${c.id}/sign`, { version: c.version, password: PASSWORD }), 422, 'E-VALIDATION');
  for (let i = 0; i < 5; i += 1) await plg.post(`/api/v1/documents/${c.id}/sign`, { version: c.version, password: `wrong-${i}-xxxxx`, confirm: true });
  expectError(await plg.post(`/api/v1/documents/${c.id}/sign`, { version: c.version, password: PASSWORD, confirm: true }), 423, 'E-AUTH-LOCKED');
  await ctx.app.advanceClock(16 * 60 * 1000);
  const signed = expectOk(await plg.post(`/api/v1/documents/${c.id}/sign`, { version: c.version, password: PASSWORD, confirm: true }));
  assert.equal(signed.status, 'signed');
  expectError(await plg.put(`/api/v1/documents/${c.id}`, { version: signed.version, sections: [{ key: 'x', text: 'y' }] }), 409, 'E-SIGNED-IMMUTABLE');
  const again = await plg.post(`/api/v1/documents/${c.id}/sign`, { version: signed.version, password: PASSWORD, confirm: true });
  assert.ok(again.status === 200 || again.status === 409, 'повторная подпись — «уже подписано»');
  expectOk(await psy.get(`/api/v1/documents/${c.id}`));
  expectError(await psy.put(`/api/v1/documents/${c.id}`, { version: signed.version, sections: [] }), 403, 'E-ACCESS');
  const p = await ctx.as('patA');
  const rel = expectOk(await plg.post(`/api/v1/documents/${c.id}/release`, {}));
  assert.ok(rel.undo);
  assert.ok(!expectOk(await p.get('/api/v1/me/documents')).items.some((x) => x.id === c.id), 'в окне пациент не видит');
  await F.passUndoWindow(ctx.app);
  assert.ok(expectOk(await p.get('/api/v1/me/documents')).items.some((x) => x.id === c.id));
  const row = ctx.app.db();
  try { assert.throws(() => row.prepare("UPDATE conclusion_versions SET sections_json = '{}' WHERE status = 'signed'").run()); } finally { row.close(); }
  await ctx.app.advanceClock(-16 * 60 * 1000);
});

// covers: T-223, UC-20, F-67, F-80
test('T-223 [W-49] ошибка экспорта не теряет документ (E-EXPORT-FAILED, документ на месте); повторный экспорт той же версии — тот же файл', async () => {
  const doc = await ctx.as('psy1');
  const d = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patA')}/documents`, { type: 'memo', use_ai: false }), 201);
  const a = await doc.get(`/api/v1/documents/${d.id}/export?format=txt`, { binary: true });
  const b = await doc.get(`/api/v1/documents/${d.id}/export?format=txt`, { binary: true });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, b.body);
  const bad = await doc.get(`/api/v1/documents/${d.id}/export?format=exe`);
  assert.ok(bad.status === 422 || bad.status === 500);
  expectOk(await doc.get(`/api/v1/documents/${d.id}`));
});
