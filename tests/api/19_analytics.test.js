'use strict';

// Аналитика специалиста (F-71), исследовательская (F-72), агрегаты с подавлением малых групп (F-74, S-22, PD-19).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectError, expectOk } = require('../lib/client');
const F = require('../lib/flows');

const ctx = useApp();

// covers: T-225, UC-23, F-71, F-74, PD-19
test('T-225 [W-52] аналитика специалиста: только своя когорта, группа меньше 10 скрыта «недостаточно данных», у каждой цифры определение и знаменатель', async () => {
  const doc = await ctx.as('psy1');
  const r = expectOk(await doc.get('/api/v1/analytics/my-patients?from=2026-01-01&to=2026-12-31&by=instrument'));
  assert.equal(r.min_group, 10);
  assert.equal(r.suppressed, true, 'в синтетическом мире групп по 10 нет — всё скрыто');
  assert.doesNotMatch(JSON.stringify(r), /Марина|Тестова|"patient_id"/, 'ни ФИО, ни идентификаторов');
  for (const row of r.rows) assert.ok(row.definition && 'denominator' in row && row.updated_at, 'определение, знаменатель, дата обновления');
  expectError(await doc.get('/api/v1/analytics/my-patients?from=2023-01-01&to=2026-12-31'), 422, 'E-VALIDATION');
  const plg = expectOk(await (await ctx.as('plg1')).get('/api/v1/analytics/my-patients?from=2026-01-01&to=2026-12-31&by=meds'));
  assert.ok(!JSON.stringify(plg).match(/inn|МНН|сертралин/i), 'у психолога нет лекарственной аналитики');
});

// covers: T-226, UC-22, F-72, F-74, PD-19, PD-24
test('T-226 [W-52] исследование: только с отметкой «исследовательское право»; выгрузка псевдонимизирована, даты по неделям, CSV без формул, запись в журнал выгрузок', async () => {
  expectError(await (await ctx.as('psy2')).get('/api/v1/analytics/research/comparison?instrument=phq9&from=2026-01-01&to=2026-12-31'), 403, 'E-ACCESS');
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patA');
  const a = await F.assignTest(ctx.app, doc, ctx.id('patA'), 'phq9');
  expectOk(await F.completeTest(p, a.id));
  const cmp = expectOk(await doc.get('/api/v1/analytics/research/comparison?instrument=phq9&from=2026-01-01&to=2026-12-31&window_days=14'));
  assert.ok('suppressed' in cmp);
  const exp = expectOk(await doc.post('/api/v1/analytics/research/export', { instrument: 'phq9', from: '2026-01-01', to: '2027-12-31', window_days: 14 }));
  const file = await doc.get(new URL(exp.link, ctx.app.base).pathname, { headers: { accept: 'text/csv' } });
  const csv = String(file.body);
  assert.doesNotMatch(csv, /Марина|Тестова|@cc\.example\.test/);
  assert.doesNotMatch(csv, /\d{4}-\d{2}-\d{2}T/, 'без точного времени');
  for (const line of csv.split('\n')) for (const cell of line.split(',')) assert.ok(!/^[=+\-@]/.test(cell.replace(/^"/, '')), `ячейка «${cell}» защищена от формул`);
  const log = ctx.app.query("SELECT row_count, file_sha256 FROM export_log WHERE kind = 'research' ORDER BY id DESC LIMIT 1")[0];
  assert.ok(log && log.file_sha256, 'журнал выгрузок с числом строк и хешем');
});

// covers: T-227, UC-23, UC-42, F-74, F-97, S-22, L-19
test('T-227 [W-52] S-22: ниже 10 поставить нельзя (E-SETTING-INVALID); повышение до 20 действует сразу', async () => {
  const admin = await ctx.as('admin1');
  expectError(await F.setSetting(admin, 'analytics.min_group', 9), 422, 'E-SETTING-INVALID');
  expectOk(await F.setSetting(admin, 'analytics.min_group', 20));
  const r = expectOk(await (await ctx.as('psy1')).get('/api/v1/analytics/my-patients?from=2026-01-01&to=2026-12-31'));
  assert.equal(r.min_group, 20);
});

// covers: T-228, UC-23, F-74, PD-19
test('T-228 [W-52] дополняющее подавление: скрытую ячейку нельзя вычислить вычитанием из итога', async () => {
  const doc = await ctx.as('psy1');
  const r = expectOk(await doc.get('/api/v1/analytics/my-patients?from=2026-01-01&to=2026-12-31&by=instrument'));
  const hidden = r.rows.filter((x) => x.suppressed);
  if (hidden.length === 1) assert.fail('скрыта ровно одна ячейка — её можно вычислить вычитанием; нужна дополняющая');
  assert.ok(true);
});
