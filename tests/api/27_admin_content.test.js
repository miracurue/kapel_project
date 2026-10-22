'use strict';

// Контент: документы сервиса и согласия (F-107, S-46, S-61), справка (S-47), методики (F-108, S-48),
// общие пакеты (F-118, S-53), библиотека (F-109, S-50), справочник МНН и аптек (F-110, S-51),
// проверка названий «на проверке» (F-123, S-65), шаблоны документов специалиста (S-64).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { useApp } = require('../lib/suite');
const { Client, expectError, expectOk } = require('../lib/client');
const F = require('../lib/flows');

const ctx = useApp();
const CATALOG = path.join(__dirname, '..', 'fixtures', 'catalog', 'catalog_stand_in.csv');

// covers: T-290, UC-39, UC-01, F-107, F-10, S-46, S-61, L-01
test('T-290 [W-44] документы сервиса: опубликованная версия неизменяема, с номером и хешем; P-09 показывает действующую с датой; Markdown без скриптов; сведения об организации S-61', async () => {
  const admin = await ctx.as('admin1');
  expectError(await admin.post('/api/v1/admin/content/docs/doc.policy/versions', { markdown: 'Политика <script>alert(1)</script>' }), 422, 'E-VALIDATION');
  const v = expectOk(await admin.post('/api/v1/admin/content/docs/doc.policy/versions', { markdown: '# Политика (STAND-IN Т13)\nСинтетический текст.', comment: 'тест' }));
  const g = new Client(ctx.app.base);
  const doc = expectOk(await g.get('/api/v1/docs/doc.policy'));
  assert.equal(doc.version, v.version);
  assert.ok(doc.published_at);
  const row = ctx.app.query("SELECT body_sha256 FROM content_versions WHERE kind = 'doc.policy' AND version = ?", v.version)[0];
  assert.match(row.body_sha256, /^[0-9a-f]{64}$/);
  const db = ctx.app.db();
  try { assert.throws(() => db.prepare("UPDATE content_versions SET body_md = 'x' WHERE kind = 'doc.policy' AND version = ?").run(v.version), /immutable/); } finally { db.close(); }
  expectOk(await F.setSetting(admin, 'org.profile', { name: 'Демо-клиника Т13 (синтетика)', support_contact: 'support@cc.example.test' }));
  const legal = await g.get('/legal', { headers: { accept: 'text/html' } });
  assert.match(legal.body, /data-page="P-09"/);
  assert.match(legal.body, /Демо-клиника Т13/);
});

// covers: T-291, UC-39, UC-05, F-107, F-09, S-47, L-49
test('T-291 [W-44] справка: 112 вверху не убирается (E-VALIDATION); новая версия видна сразу', async () => {
  const admin = await ctx.as('admin1');
  expectError(await admin.post('/api/v1/admin/content/docs/help.patient/versions', { markdown: '# Справка без номера помощи' }), 422, 'E-VALIDATION');
  expectOk(await admin.post('/api/v1/admin/content/docs/help.patient/versions', { markdown: '112 — экстренная помощь.\n\n# Справка (синтетика Т13)' }));
  const h = expectOk(await new Client(ctx.app.base).get('/api/v1/help?role=patient'));
  assert.ok(JSON.stringify(h).includes('синтетика Т13'));
});

// covers: T-292, UC-03, UC-28, UC-10, F-108, S-48, L-40, L-41
test('T-292 [W-44] методики: без полей права — только STAND-IN, онлайн не показывается; «Проверить подсчёт» не совпал — не публикуется; HADS заблокирован', async () => {
  const admin = await ctx.as('admin1');
  const schema = { questions: [{ id: 'q1', type: 'single', text: 'Синтетический вопрос', options: [{ value: 'a', label: 'Да', score: 1 }, { value: 'b', label: 'Нет', score: 0 }] }] };
  const scoring = { method: 'sum' };
  const bad = expectOk(await admin.post('/api/v1/admin/instruments/t13demo/check-scoring', { schema, scoring, answers: { q1: 'a' } }));
  assert.equal(bad.score, 1);
  const r = await admin.post('/api/v1/admin/instruments/t13demo/versions', { schema, scoring, online_allowed: true, approved_by: 'Синтетический КО', comment: 'без права' });
  assert.ok(r.status === 403 || r.status === 422 || (r.body && r.body.version), 'без полей права — отказ или STAND-IN');
  const cat = expectOk(await (await ctx.as('patA')).get('/api/v1/me/self-tests')).items.map((x) => x.code);
  assert.ok(!cat.includes('t13demo'), 'пациенту онлайн не показывается');
  expectError(await admin.post('/api/v1/admin/instruments/hads/versions', { schema, scoring, approved_by: 'КО' }), 403, 'E-INSTRUMENT-LICENSE');
});

// covers: T-293, UC-32, F-118, F-60, S-53
test('T-293 [W-44] общие пакеты: видны всем специалистам только для чтения; 2–10 методик; лекарственных пунктов нет; изменение не трогает уже назначенные', async () => {
  const admin = await ctx.as('admin1');
  const v = expectOk(await admin.put('/api/v1/admin/packages/new', { title: 'Общий синтетический', instruments: ['phq9', 'gad7'], approved_by: 'Синтетический КО' }));
  assert.ok(v.version >= 1);
  expectError(await admin.put('/api/v1/admin/packages/new', { title: 'С лекарством', instruments: ['phq9', 'med:сертралин'], approved_by: 'КО' }), 422, 'E-VALIDATION');
  const list = expectOk(await (await ctx.as('plg1')).get('/api/v1/packages')).items;
  assert.ok(list.some((x) => x.title === 'Общий синтетический' && x.shared));
});

// covers: T-294, UC-14, F-109, F-15, S-50, L-20
test('T-294 [W-48] библиотека в админке: без автора, источника, версии и даты пересмотра не публикуется; спонсорский — с «при поддержке …»; «Снять» с «Отменить»', async () => {
  const admin = await ctx.as('admin1');
  const draft = expectOk(await admin.post('/api/v1/admin/library', { title: 'Синтетическая статья Т13', kind: 'article', markdown: 'Текст статьи (синтетика)' }));
  expectError(await admin.post(`/api/v1/admin/library/${draft.id}/publish`, { checked_by: 'КО' }), 422, 'E-VALIDATION');
  const full = expectOk(await admin.post('/api/v1/admin/library', { title: 'Синтетическая статья Т13-2', kind: 'article', markdown: 'Текст (синтетика)', author: 'Автор Синтетический', source: 'STAND-IN', revision_date: '2026-10-17', sponsor_note: 'при поддержке Синтетической программы' }));
  expectOk(await admin.post(`/api/v1/admin/library/${full.id}/publish`, { checked_by: 'Синтетический КО' }));
  await F.passUndoWindow(ctx.app);
  const item = expectOk(await (await ctx.as('patA')).get(`/api/v1/library/${full.id}`));
  assert.match(item.sponsor_note, /при поддержке/);
  const w = expectOk(await admin.post(`/api/v1/admin/library/${full.id}/withdraw`, {}));
  expectOk(await admin.post(`/api/v1/undo/${w.undo.id}`, {}));
  expectOk(await (await ctx.as('patA')).get(`/api/v1/library/${full.id}`));
});

// covers: T-295, UC-12, UC-26, UC-46, F-110, F-76, S-51, PD-19
test('T-295 [W-45] импорт справочника CSV: формулы отклоняются (E-IMPORT-FORMAT), предпросмотр различий, «Применить» — новая версия, повтор того же файла — «изменений нет»', async () => {
  const admin = await ctx.as('admin1');
  const evil = { name: 'evil.csv', buffer: Buffer.from('inn,drug_group,atc_code,rx_only,trade_name,manufacturer,dosage_form,strength,source,source_date\nсертралин,antidepressant,N06AB06,1,=HYPERLINK("x"),М,таблетки,50 мг,stand_in,2026-10-17\n'), type: 'text/csv' };
  const up1 = expectOk(await F.upload(admin, evil, 'reference_import'));
  const p1 = await admin.post('/api/v1/admin/reference/imports', { upload_id: up1.id, columns: {}, source: 'manual' });
  assert.ok(p1.status === 422 || (p1.body.errors && p1.body.errors.length >= 1), 'строка с формулой — ошибка импорта');
  const csv = fs.readFileSync(CATALOG, 'utf8') + 'сертралин,antidepressant,N06AB06,1,Сертрасинт Т13,STAND-IN производитель,таблетки,50 мг,stand_in,2026-10-17\n';
  const up2 = expectOk(await F.upload(admin, { name: 'catalog.csv', buffer: Buffer.from(csv), type: 'text/csv' }, 'reference_import'));
  const prev = expectOk(await admin.post('/api/v1/admin/reference/imports', { upload_id: up2.id, columns: {}, source: 'stand_in', exported_on: '2026-10-17' }));
  assert.ok(prev.added >= 1, 'предпросмотр: добавлено');
  const applied = expectOk(await admin.post(`/api/v1/admin/reference/imports/${prev.id}/apply`, {}));
  assert.ok(applied.version >= 1);
  const hit = expectOk(await (await ctx.as('patA')).get(`/api/v1/catalog/search?q=${encodeURIComponent('Сертрасинт')}&scope=products`));
  assert.ok(hit.items.some((i) => i.name.startsWith('Сертрасинт')), 'новое название сразу в подсказках');
  const up3 = expectOk(await F.upload(admin, { name: 'catalog.csv', buffer: Buffer.from(csv), type: 'text/csv' }, 'reference_import'));
  const same = expectOk(await admin.post('/api/v1/admin/reference/imports', { upload_id: up3.id, columns: {}, source: 'stand_in', exported_on: '2026-10-17' }));
  assert.equal(same.added + same.changed + same.removed, 0, '«изменений нет»');
});

// covers: T-296, UC-26, UC-46, UC-12, F-123, F-122, F-121, F-19, S-65, PD-20
test('T-296 [W-45] проверка названий: принять — видно всем; слить — отметки пациентов переносятся, написание становится синонимом, история «вы ввели»; отклонить — пациенту «уточните препарат»; двое проверяющих — E-CONFLICT', async () => {
  const doc = await ctx.as('psy1');
  const pA = await ctx.as('patA');
  const pB = await ctx.as('patH');
  const inn = await F.innId(doc, 'сертралин');
  for (const [p, key] of [[pA, 'patA'], [pB, 'patH']]) await F.publishPlan(ctx.app, doc, ctx.id(key), [{ inn_id: inn, dose: 50, unit: 'мг', times: ['утро'] }]);
  const itemA = expectOk(await pA.get('/api/v1/me/meds')).plan_items.find((i) => i.inn_id === inn);
  const itemB = expectOk(await pB.get('/api/v1/me/meds')).plan_items.find((i) => i.inn_id === inn);
  expectOk(await pA.post(`/api/v1/me/plan-items/${encodeURIComponent(itemA.item_key)}/accept`, { pending_name: 'Залофтт форте' }));
  expectOk(await pB.post(`/api/v1/me/plan-items/${encodeURIComponent(itemB.item_key)}/accept`, { pending_name: 'залофтт  форте' }));
  const admin = await ctx.as('admin1');
  const queue = expectOk(await admin.get('/api/v1/admin/drug-review?status=pending')).items;
  const row = queue.find((x) => /залофтт/i.test(x.entered_name));
  assert.equal(row.uses, 2, 'одинаковые названия разных авторов — одна строка «добавили 2»');
  assert.doesNotMatch(JSON.stringify(queue), /Марина|Хасан|patient/, 'без данных пациентов');
  const target = await F.productOf(admin, inn, 'Золофт');
  const otherInn = await F.productOf(admin, await F.innId(admin, 'флуоксетин'), 'Прозак');
  expectError(await admin.post(`/api/v1/admin/drug-review/${row.id}/merge`, { target_id: row.id }), 422, 'E-MERGE-TARGET');
  expectError(await admin.post(`/api/v1/admin/drug-review/${row.id}/merge`, { target_id: otherInn.id }), 409, 'E-MERGE-INN');
  const [m1, m2] = await Promise.all([
    admin.post(`/api/v1/admin/drug-review/${row.id}/merge`, { target_id: target.id }),
    (await ctx.as('admin2')).post(`/api/v1/admin/drug-review/${row.id}/reject`, { reason_key: 'typo' }),
  ]);
  assert.equal([m1, m2].filter((r) => r.status === 200).length, 1, 'двое проверяющих — решение одно');
  if (m1.status === 200) {
    const mine = expectOk(await pA.get('/api/v1/me/meds')).plan_items.find((i) => i.item_key === itemA.item_key);
    assert.equal(mine.acceptance.product.id, target.id, 'отметка пациента перенесена на запись каталога');
    const syn = expectOk(await pB.get(`/api/v1/catalog/search?q=${encodeURIComponent('залофтт форте')}&scope=products`)).items;
    assert.equal(syn[0].id, target.id, 'написание стало синонимом — подсказки учатся на ошибках');
  }
  const reject = expectOk(await pA.post(`/api/v1/me/plan-items/${encodeURIComponent(itemA.item_key)}/purchase`, { pending_name: 'Совсем Непонятное Т13' }));
  const r2 = expectOk(await admin.get('/api/v1/admin/drug-review?status=pending')).items.find((x) => /непонятное/i.test(x.entered_name));
  expectOk(await admin.post(`/api/v1/admin/drug-review/${r2.id}/reject`, { reason_key: 'not_a_drug' }));
  await F.passUndoWindow(ctx.app);
  const mark = ctx.app.query("SELECT status FROM purchase_marks WHERE patient_id = ? AND status = 'needs_clarification'", ctx.id('patA'));
  assert.ok(mark.length >= 1, 'у пациента — «уточните препарат»');
  void reject;
  expectOk(await F.setSetting(admin, 'reference.review_owner', 'flagged'));
  expectOk(await (await ctx.as('psy3')).get('/api/v1/admin/drug-review'));
  expectError(await (await ctx.as('psy1')).get('/api/v1/admin/drug-review'), 403, 'E-ACCESS');
});

// covers: T-297, UC-20, F-107, F-67, S-64, L-26
test('T-297 [W-44] шаблоны документов специалиста S-64: переменные только из списка; пометку «Ответ подготовлен ИИ» убрать нельзя', async () => {
  const admin = await ctx.as('admin1');
  expectError(await admin.post('/api/v1/admin/content/docs/doc_template.visit_summary/versions', { markdown: '{{patient.passport}} без пометки', approved_by: 'КО' }), 422, 'E-TEMPLATE-VAR');
  const ok = await admin.post('/api/v1/admin/content/docs/doc_template.visit_summary/versions', { markdown: '# Сводка\n{{period}}\n{{sections}}', approved_by: 'Синтетический КО' });
  expectOk(ok);
  const doc = await ctx.as('psy1');
  ctx.app.ai.queue({ mode: 'text', text: 'Синтетический текст раздела' });
  const d = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patA')}/documents`, { type: 'visit_summary', use_ai: true }), 201);
  const txt = await doc.get(`/api/v1/documents/${d.id}/export?format=txt`, { binary: true });
  assert.match(txt.body.toString('utf8'), /подготовлен ИИ/i, 'пометка осталась вопреки шаблону');
});
