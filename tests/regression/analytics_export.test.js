'use strict';
// Выгрузка аналитики в CSV: формат для Excel, защита от формул, малые группы, права и журнал.
// Источник: BUILD_RULES §4, §6, §8; docs/openapi.yaml (GET /api/v1/analytics/export); src/modules/analytics/export_*.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectError } = require('../lib/client');
const { cell, toCsv, diaryRows, insightsRows } = require('../../src/modules/analytics/export_csv');
const { suppressCells } = require('../../src/modules/analytics/interpret');

const ctx = useApp();
const URL = '/api/v1/analytics/export';

// ---- чистые функции
test('CSV: ячейки с формулами экранируются, числа с запятой, разделитель «;» и кавычки', () => {
  for (const evil of ['=1+1', '+1', '-1', '@SUM(A1)', '\tтаб', '\rвозврат'])
    assert.ok(cell(evil).replace(/^"/, '').startsWith("'"), `экранирована: ${JSON.stringify(evil)}`);
  assert.equal(cell(-1.5), '-1,5', 'число не экранируется');
  assert.equal(cell(null), '');
  assert.equal(cell('а;б'), '"а;б"');
  assert.equal(cell('ей "да"'), '"ей ""да"""');
  assert.equal(cell('обычный'), 'обычный');
});

test('CSV: BOM, CRLF, русские заголовки колонок', () => {
  const text = toCsv([
    ['a', 'b'],
    ['c;d', 1.5],
  ]);
  assert.ok(text.startsWith('﻿a;b\r\n'));
  assert.ok(text.endsWith('"c;d";1,5\r\n'));
});

test('строки дневника: скрытая группа даёт пустые значения и примечание, видимая — число', () => {
  const report = {
    min_group: 10,
    rows: [
      { label: 'Ведут дневник', value: 62.5, unit: '%', n_patients: 12, suppressed: false },
      { label: 'Настроение', value: null, unit: 'из 5', n_patients: null, suppressed: true },
    ],
    mood_bands: [{ label: 'Низкое', n_patients: null, suppressed: true }],
    weekly: [{ week: '2026-10-05', mood_mean: 3.2, n_patients: 11, suppressed: false }],
  };
  const rows = diaryRows(report);
  assert.deepEqual(rows[0].slice(2, 6), [62.5, '%', 12, '']);
  assert.equal(rows[1][2], null);
  assert.match(rows[1][5], /меньше 10/);
  assert.match(rows[2][5], /меньше 10/);
  assert.equal(rows[3][2], 3.2);
});

test('строки отчёта по диагнозу: нет секции (у психолога лекарства) — не ошибка; скрытое пусто', () => {
  const rows = insightsRows({
    sections: [
      { key: 'who', title: 'Кто они', n_patients: null, dynamics: [{ month: '2026-09', n_patients: 4 }] },
      { key: 'cost', title: 'Какова цена', n_reporters: 3, complaints: [{ label: '=cmd', n_patients: 2 }] },
    ],
  });
  assert.equal(rows[0][2], null);
  assert.match(rows[0][5], /скрыто/);
  assert.equal(rows[1][2], 4);
  assert.equal(rows.length, 4);
  assert.ok(typeof suppressCells === 'function');
});

// ---- API
test('API: специалисты и администратор получают CSV с BOM, заголовками и именем с датой', async () => {
  for (const who of ['psy1', 'plg1', 'admin1']) {
    const c = await ctx.as(who);
    const res = await c.get(`${URL}?section=diary`, { binary: true });
    assert.equal(res.status, 200, who);
    assert.deepEqual([...res.body.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    res.body = res.body.toString('utf8');
    assert.match(res.headers.get('content-type'), /^text\/csv; charset=utf-8/);
    assert.match(
      res.headers.get('content-disposition'),
      /^attachment; filename="clinical-compass-analytics-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    assert.ok(res.body.startsWith('\ufeff# Clinical Compass'), 'строка-заголовок');
    assert.match(res.body, /Раздел;Показатель;Значение;Единица;Число людей;Примечание\r\n/);
    assert.doesNotMatch(res.body, /patient_id|subject_code|@/);
  }
});

test('API: в маленькой группе значения скрыты, как на экране; период и диагноз проверяются', async () => {
  const c = await ctx.as('psy1');
  const res = await c.get(`${URL}?section=all`);
  assert.equal(res.status, 200);
  assert.match(res.body, /скрыто: в группе меньше 10 человек/);
  expectError(await c.get(`${URL}?section=other`), 422, 'E-VALIDATION');
  expectError(await c.get(`${URL}?from=2020-01-01&to=2026-12-31`), 422, 'E-VALIDATION');
  expectError(await c.get(`${URL}?from=2026-02-31`), 422, 'E-VALIDATION');
  expectError(await c.get(`${URL}?dx=nope`), 422, 'E-VALIDATION');
});

test('API: выгрузка пишется в журнал без содержимого', async () => {
  const c = await ctx.as('psy1');
  const before = ctx.app.query("SELECT COUNT(*) n FROM action_log WHERE action='analytics.export'")[0].n;
  assert.equal((await c.get(`${URL}?section=diary`)).status, 200);
  const rows = ctx.app.query(
    "SELECT actor_id,actor_role,new_safe_json FROM action_log WHERE action='analytics.export' ORDER BY id DESC",
  );
  assert.equal(rows.length, before + 1);
  assert.equal(rows[0].actor_id, ctx.id('psy1'));
  const detail = JSON.parse(rows[0].new_safe_json);
  assert.equal(detail.section, 'diary');
  assert.deepEqual(Object.keys(detail).sort(), ['dx', 'from', 'rows', 'section', 'to']);

  const a = await ctx.as('admin1');
  const exports = ctx.app.query("SELECT COUNT(*) n FROM export_log WHERE kind='program'")[0].n;
  assert.equal((await a.get(`${URL}?section=insights`)).status, 200);
  assert.equal(ctx.app.query("SELECT COUNT(*) n FROM export_log WHERE kind='program'")[0].n, exports + 1);
});

test('API: пациент и без входа получают отказ, журнал не пополняется', async () => {
  const before = ctx.app.query("SELECT COUNT(*) n FROM action_log WHERE action='analytics.export'")[0].n;
  expectError(await (await ctx.as('patA')).get(`${URL}?section=diary`), 403, 'E-ACCESS');
  const anon = await ctx.fresh('patA');
  await anon.raw('POST', '/api/v1/auth/logout', {}).catch(() => null);
  const res = await anon.get(URL);
  assert.ok([401, 403].includes(res.status));
  assert.equal(ctx.app.query("SELECT COUNT(*) n FROM action_log WHERE action='analytics.export'")[0].n, before);
});
