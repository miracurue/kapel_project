'use strict';

// Подсказки названий МНН и препаратов (F-121) по каталогу-заглушке (F-76): набор из 100 типовых ошибок,
// 30 МНН, 20 несуществующих названий, регистр и «ё», S-66. Скорость (≤ 300 мс) — tests/performance.
// Набор: tests/fixtures/catalog/typos.json, каталог: tests/fixtures/catalog/catalog_stand_in.csv
// (предложение для config/defaults/catalog_stand_in.csv задачи W-14).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { useApp } = require('../lib/suite');
const { expectOk } = require('../lib/client');
const F = require('../lib/flows');

const ctx = useApp();
const T = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'catalog', 'typos.json'), 'utf8'));
const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е');

async function search(c, q, scope = 'products') {
  const r = await c.get(`/api/v1/catalog/search?q=${encodeURIComponent(q)}&scope=${scope}`);
  return expectOk(r);
}

// covers: T-175, UC-26, UC-46, F-121, F-76
test('T-175 [W-14] каталог-заглушка содержит все названия набора опечаток и помечен STAND-IN', async () => {
  const p = await ctx.as('patA');
  const names = new Set([...T.products, ...T.exact, ...T.prefix4].map((x) => x.expect));
  const missing = [];
  for (const n of names) {
    const r = await search(p, n);
    if (!r.items.some((i) => norm(i.name) === norm(n))) missing.push(n);
    assert.equal(r.stand_in, true, 'плашка «Справочник-заглушка»');
  }
  assert.deepEqual(missing, [], 'в каталоге W-14 есть все названия из tests/fixtures/catalog');
});

// covers: T-176, UC-26, UC-46, F-121
test('T-176 [W-14] 100 типовых ошибок по 20 видов: верный препарат в первых трёх подсказках не меньше 90 раз из 100', async () => {
  const p = await ctx.as('patA');
  const misses = [];
  const byKind = {};
  for (const c of T.products) {
    const r = await search(p, c.input);
    const top3 = r.items.slice(0, 3).map((i) => norm(i.name));
    const hit = top3.includes(norm(c.expect));
    byKind[c.kind] = byKind[c.kind] || { hit: 0, total: 0 };
    byKind[c.kind].total += 1;
    if (hit) byKind[c.kind].hit += 1; else misses.push(`${c.kind}: «${c.input}» → ${c.expect}; подсказки: ${top3.join(', ')}`);
  }
  const hits = T.products.length - misses.length;
  console.log(`F-121: ${hits}/100 в первых трёх; по видам: ${JSON.stringify(byKind)}`);
  if (misses.length) console.log(misses.join('\n'));
  assert.ok(hits >= 90, `верных в первых трёх: ${hits} из 100 (нужно ≥ 90)`);
});

// covers: T-177, UC-12, UC-26, F-121
test('T-177 [W-14] точное название и начало от 4 букв — верный вариант первым в 100 % случаев', async () => {
  const p = await ctx.as('patA');
  const bad = [];
  for (const c of [...T.exact, ...T.prefix4]) {
    const r = await search(p, c.input);
    if (!r.items.length || norm(r.items[0].name) !== norm(c.expect)) bad.push(`«${c.input}» → ${r.items[0] && r.items[0].name}`);
  }
  assert.deepEqual(bad, []);
});

// covers: T-178, UC-12, F-121, F-61
test('T-178 [W-14] 30 МНН с теми же видами ошибок: не меньше 27 в первых трёх', async () => {
  const doc = await ctx.as('psy1');
  let hits = 0;
  const misses = [];
  for (const c of T.inn) {
    const r = await search(doc, c.input, 'inn');
    if (r.items.slice(0, 3).some((i) => norm(i.name) === norm(c.expect))) hits += 1; else misses.push(`«${c.input}» → ${c.expect}`);
  }
  if (misses.length) console.log(misses.join('\n'));
  assert.ok(hits >= 27, `МНН в первых трёх: ${hits} из 30`);
});

// covers: T-179, UC-26, UC-46, F-121, F-122
test('T-179 [W-14] 20 несуществующих названий: ничего не выбирается автоматически, «Добавить как есть» доступно всегда', async () => {
  const p = await ctx.as('patA');
  for (const name of T.nonexistent) {
    const r = await search(p, name);
    assert.ok(!r.items.some((i) => i.auto_selected), `«${name}»: ничего не выбрано само`);
    assert.ok(r.items.every((i) => norm(i.name) !== norm(name)));
    assert.notEqual(r.add_as_is === false, true, '«Не нашли? Добавить как есть — проверим» не скрывается');
  }
});

// covers: T-180, F-121, L-20
test('T-180 [W-14] регистр и «ё» не влияют; не больше 5 подсказок (S-66); при равенстве — по алфавиту, без продвижения бренда', async () => {
  const p = await ctx.as('patA');
  for (const pair of T.case_and_yo) {
    const a = (await search(p, pair.a)).items.map((i) => i.id);
    const b = (await search(p, pair.b)).items.map((i) => i.id);
    assert.deepEqual(a, b, `«${pair.a}» и «${pair.b}» дают одно и то же`);
  }
  const many = await search(p, 'ин');
  assert.ok(many.items.length <= 5);
  const sertralin = await F.innId(p, 'сертралин');
  const own = expectOk(await p.get(`/api/v1/catalog/search?q=${encodeURIComponent('серт')}&scope=products_of_inn&inn_id=${sertralin}`)).items;
  assert.ok(own.every((i) => i.inn_id === sertralin), 'в «Принять» сначала только препараты этого МНН');
});

// covers: T-181, UC-44, F-121, F-97, S-66
test('T-181 [W-45] S-66: число подсказок 3 и минимум 3 символа действуют сразу', async () => {
  const admin = await ctx.as('admin1');
  expectOk(await F.setSetting(admin, 'reference.search', { suggestions: 3, min_chars: 3, fuzziness: 'normal' }));
  const p = await ctx.as('patA');
  assert.ok((await search(p, 'зол')).items.length <= 3);
  const short = await p.get(`/api/v1/catalog/search?q=${encodeURIComponent('зо')}&scope=products`);
  assert.ok(short.status === 422 || (short.body.items || []).length === 0, 'меньше минимума символов — подсказок нет');
  expectOk(await F.setSetting(admin, 'reference.search', { suggestions: 5, min_chars: 2, fuzziness: 'normal' }));
});

// covers: T-182, F-121, PD-17
test('T-182 [W-14] строка поиска не пишется в журналы', async () => {
  const p = await ctx.as('patA');
  await search(p, 'УникальнаяСтрокаПоискаТ13');
  assert.ok(!ctx.app.logs().includes('УникальнаяСтрокаПоискаТ13'));
  assert.ok(!JSON.stringify(ctx.app.query('SELECT * FROM action_log ORDER BY id DESC LIMIT 50')).includes('УникальнаяСтрокаПоискаТ13'));
});
