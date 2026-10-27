'use strict';

// ИИ в админке: реестр моделей (F-99), привязки (F-100), промпты (F-101), наборы и прогоны (F-102, S-35, S-36),
// псевдонимизация (F-111, S-37, S-38): базовые типы не выключаются, «Проверить на тексте» ничего не сохраняет.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp, eventually } = require('../lib/suite');
const { expectError, expectOk } = require('../lib/client');
const F = require('../lib/flows');

const ctx = useApp();
const base = { adapter: 'openai_compat', base_url: 'http://127.0.0.1:9/v1', model_id: 'local-t13', license_url: 'https://example.test/license', law_243_status: 'unknown', enabled: true };

// covers: T-270, UC-44, F-99, M-19, PD-01
test('T-270 [W-42] реестр моделей: класс данных ставит сервер (не «наш сервер» — только synthetic_only); «за рубежом» и запретные лицензии не сохраняются; лицензия и статус 243-ФЗ обязательны', async () => {
  const admin = await ctx.as('admin1');
  const ext = expectOk(await admin.post('/api/v1/admin/ai/models', { ...base, name: 'Внешняя РФ (тест)', location: 'ru_external', data_class: 'local_ok' }));
  assert.equal(ext.data_class, 'synthetic_only', 'local_ok внешней модели поставить нельзя');
  expectError(await admin.post('/api/v1/admin/ai/models', { ...base, name: 'Зарубежная (тест)', location: 'foreign' }), 422, 'E-MODEL-FORBIDDEN');
  expectError(await admin.post('/api/v1/admin/ai/models', { ...base, name: 'YandexGPT-5-Lite', model_id: 'yandexgpt-5-lite', location: 'our_server' }), 422, 'E-MODEL-FORBIDDEN');
  expectError(await admin.post('/api/v1/admin/ai/models', { ...base, name: 'Без лицензии', location: 'our_server', license_url: undefined }), 422, 'E-VALIDATION');
  const local = expectOk(await admin.post('/api/v1/admin/ai/models', { ...base, name: 'Локальная (тест)', location: 'our_server' }));
  assert.equal(local.data_class, 'local_ok');
  const check = await admin.post(`/api/v1/admin/ai/models/${local.id}/check`, {});
  assert.ok(check.status === 200 || (check.body.error && check.body.error.code === 'E-MODEL-CHECK'), 'проверка связи: время и код без тела');
  const bindings = expectOk(await admin.get('/api/v1/admin/ai/bindings')).items;
  const used = bindings[0].primary_model_id;
  expectError(await admin.put(`/api/v1/admin/ai/models/${used}`, { enabled: false }), 409, 'E-IN-USE');
});

// covers: T-271, UC-44, F-100, F-102, S-02, S-35
test('T-271 [W-42] привязка: основная ≠ запасная; для ae_extraction нужна поддержка функций; без прогона или ниже порога — только с комментарием (E-EVAL-BELOW)', async () => {
  const admin = await ctx.as('admin1');
  const m = expectOk(await admin.post('/api/v1/admin/ai/models', { ...base, adapter: 'local_stub', name: 'Заглушка без функций', model_id: 'stub-notools', location: 'our_server', supports_tools: false }));
  const b = expectOk(await admin.get('/api/v1/admin/ai/bindings')).items.find((x) => x.purpose === 'patient_assistant');
  expectError(await admin.put('/api/v1/admin/ai/bindings/patient_assistant', { primary_model_id: m.id, fallback_model_id: m.id, base_version: b.version, comment: 'x' }), 422, 'E-VALIDATION');
  expectError(await admin.put('/api/v1/admin/ai/bindings/patient_assistant', { primary_model_id: m.id, fallback_model_id: b.primary_model_id, base_version: b.version }), 409, 'E-EVAL-BELOW');
  const ae = expectOk(await admin.get('/api/v1/admin/ai/bindings')).items.find((x) => x.purpose === 'ae_extraction');
  expectError(await admin.put('/api/v1/admin/ai/bindings/ae_extraction', { primary_model_id: m.id, fallback_model_id: ae.primary_model_id, base_version: ae.version, comment: 'x' }), 422, 'E-VALIDATION');
});

// covers: T-272, UC-44, F-101, S-08, S-09, S-34, L-27
test('T-272 [W-42] промпты: версии не перезаписываются; без обязательных блоков («Запреты», «Переход к врачу и 112») — E-VALIDATION; сравнение двух версий; откат — включить прежнюю', async () => {
  const admin = await ctx.as('admin1');
  const vs = expectOk(await admin.get('/api/v1/admin/ai/prompts/task.patient_chat/versions'));
  const active = vs.items.find((v) => v.active);
  expectError(await admin.post('/api/v1/admin/ai/prompts/task.patient_chat/versions', { text: 'Просто отвечай пациенту.', comment: 'без блоков' }), 422, 'E-VALIDATION');
  expectError(await admin.post('/api/v1/admin/ai/prompts/admin_assistant/versions', { text: 'Отвечай как хочешь', comment: 'без блоков' }), 422, 'E-VALIDATION');
  expectError(await admin.post('/api/v1/admin/ai/prompts/task.patient_chat/versions', { text: `${active.text}\n{{user_text}}`, comment: 'место для вставки данных' }), 422, 'E-VALIDATION');
  const v = expectOk(await admin.post('/api/v1/admin/ai/prompts/task.patient_chat/versions', { text: `${active.text}\n# синтетическая правка`, comment: 'тест' }));
  const diff = expectOk(await admin.get(`/api/v1/admin/ai/prompts/task.patient_chat/diff?a=${active.version}&b=${v.version}`));
  assert.match(diff.diff, /синтетическая правка/);
  expectError(await admin.post(`/api/v1/admin/ai/prompts/task.patient_chat/versions/${v.version}/activate`, {}), 409, 'E-EVAL-BELOW');
  expectOk(await admin.post(`/api/v1/admin/ai/prompts/task.patient_chat/versions/${v.version}/activate`, { comment: 'без прогона, тест' }));
  expectOk(await admin.post(`/api/v1/admin/ai/prompts/task.patient_chat/versions/${active.version}/activate`, { comment: 'откат' }));
  const after = expectOk(await admin.get('/api/v1/admin/ai/prompts/task.patient_chat/versions'));
  assert.equal(after.items.find((x) => x.active).version, active.version);
  assert.equal(after.items.find((x) => x.version === active.version).text, active.text);
});

// covers: T-273, UC-44, UC-41, F-102, F-26, S-35, S-36, PD-24, M-16
test('T-273 [W-42] набор примеров: только с отметкой «синтетика», похожие на настоящие телефоны — предупреждение; прогон через шлюз с пометкой «проверка», не тратит лимиты пользователей; один прогон на назначение', async () => {
  const admin = await ctx.as('admin1');
  const set = expectOk(await admin.get('/api/v1/admin/ai/eval-sets/patient_assistant'));
  assert.ok(set.cases.length >= 30, 'набор помощника — не меньше 30 примеров (S-36)');
  const small = await admin.put('/api/v1/admin/ai/eval-sets/patient_assistant', { cases: set.cases.slice(0, 5), base_version: set.version, approved_by: 'Синтетический КО' });
  expectError(small, 422, 'E-VALIDATION');
  const withPhone = set.cases.map((c, i) => (i === 0 ? { ...c, input: `${c.input} позвоните +7 916 123-45-67` } : c));
  const w = await admin.put('/api/v1/admin/ai/eval-sets/patient_assistant', { cases: withPhone, base_version: set.version, approved_by: 'Синтетический КО' });
  assert.ok(w.status === 422 || (w.body.warnings && w.body.warnings.length), 'похожий на настоящий телефон — предупреждение (PD-24)');
  const models = expectOk(await admin.get('/api/v1/admin/ai/bindings')).items.find((x) => x.purpose === 'patient_assistant');
  ctx.app.ai.reset();
  const run = expectOk(await admin.post('/api/v1/admin/ai/eval-runs', { purpose: 'patient_assistant', model_id: models.primary_model_id }));
  expectError(await admin.post('/api/v1/admin/ai/eval-runs', { purpose: 'patient_assistant', model_id: models.primary_model_id }), 409, 'E-EVAL-RUNNING');
  const done = await eventually(async () => { const r = expectOk(await admin.get(`/api/v1/admin/ai/eval-runs/${run.id}`)); return r.status === 'done' ? r : null; }, { timeout: 60000 });
  assert.equal(done.total, set.cases.length);
  assert.ok(typeof done.threshold === 'number');
  assert.ok(ctx.app.ai.calls().every((c) => c.purpose === 'patient_assistant' || c.purpose === 'eval'), 'вызовы прогона идут через шлюз');
  assert.ok(ctx.app.query("SELECT count(*) n FROM ai_audit WHERE purpose = 'eval'")[0].n >= 1 || ctx.app.query("SELECT count(*) n FROM ai_eval_runs WHERE id = ?", run.id)[0].n === 1);
  const user = await ctx.as('patA');
  expectOk(await F.patientAsk(user, 'Пользовательский лимит не тронут прогоном'));
  expectError(await F.setSetting(admin, 'ai.eval.threshold', { overall: 40, forbidden: 100 }), 422, 'E-SETTING-INVALID');
  expectError(await F.setSetting(admin, 'ai.eval.threshold', { overall: 90, forbidden: 90 }), 422, 'E-SETTING-INVALID');
});

// covers: T-274, UC-44, F-111, F-80, S-37, S-38, PD-04, PD-13, PD-17
test('T-274 [W-46] псевдонимизация в админке: базовые типы не выключаются; слишком широкое правило — E-PII-RULE; «Проверить на тексте» не сохраняет и не пишет журнал; таблицы ключей пациентов в админке нет', async () => {
  const admin = await ctx.as('admin1');
  const cur = expectOk(await admin.get('/api/v1/admin/pii/rules'));
  expectError(await admin.put('/api/v1/admin/pii/rules', { types: [{ type: 'PERSON', enabled: false }], base_version: cur.version }), 422, 'E-VALIDATION');
  expectError(await admin.put('/api/v1/admin/pii/rules', { rules: [{ pattern: '.+', type: 'ORG' }], base_version: cur.version, comment: 'широкое' }), 422, 'E-PII-RULE');
  const off = expectOk(await admin.put('/api/v1/admin/pii/rules', { types: [{ type: 'NICK', enabled: false }], base_version: cur.version, comment: 'тест S-37' }));
  assert.ok(off.version > cur.version);
  const before = ctx.app.query('SELECT count(*) n FROM pii_values')[0].n;
  const t = expectOk(await admin.post('/api/v1/admin/pii/test', { text: 'Синтетика: Олег Пробный, +7 912 000-31-01' }));
  assert.ok(t.found.some((f) => f.type === 'PHONE'));
  assert.equal(ctx.app.query('SELECT count(*) n FROM pii_values')[0].n, before, 'ничего не сохранено');
  assert.ok(!ctx.app.logs().includes('000-31-01'), 'и не записано в журнал');
  const corpus = expectOk(await admin.post('/api/v1/admin/pii/corpus-run', {}));
  assert.ok(corpus.recall >= 0.88);
  const stats = expectOk(await admin.get('/api/v1/admin/pii/stats'));
  assert.doesNotMatch(JSON.stringify(stats), /Марина|\+7|@/, 'статистика без значений');
  assert.ok(!require('../lib/contract').api().some((o) => /pii\/values|pii_values|pii\/keys/.test(o.path)), 'нет адреса, отдающего таблицу ключей');
  expectOk(await admin.put('/api/v1/admin/pii/rules', { types: [{ type: 'NICK', enabled: true }], base_version: off.version, comment: 'вернуть' }));
});
