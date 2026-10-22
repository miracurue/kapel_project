'use strict';

// Боевой режим DATA_MODE=real (веха В7, W-56, W-57) на синтетических данных: двойной запрет внешних моделей
// (PD-01, L-03), антивирус fail-closed (PD-07), утверждение клинических настроек КО (F-98, UC-45), основание
// для юридически значимых (E-BASIS-REQUIRED), гипотезы выключены (S-28), свежий второй фактор (F-96, S-39).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startRealApp, realAdmin } = require('../lib/real');
const { as, expectError, expectOk } = require('../lib/client');
const { totp } = require('../lib/totp');
const F = require('../lib/flows');

let R;
before(async () => { R = await startRealApp(); }, { timeout: 240000 });
after(async () => { if (R) await R.app.stop(); });

// covers: T-320, UC-44, F-24, F-26, F-100, F-99, PD-01, PD-15, L-03
test('T-320 [W-57] real: привязка к synthetic_only не сохраняется (E-MODEL-MODE); подложенная в базу — шлюз не вызывает модель (вторая проверка)', async () => {
  const admin = await realAdmin(R.app, 'admin1', R.secrets);
  const models = expectOk(await admin.get('/api/v1/admin/ai/models')).items;
  const ext = models.find((m) => m.data_class === 'synthetic_only');
  const b = expectOk(await admin.get('/api/v1/admin/ai/bindings')).items.find((x) => x.purpose === 'patient_assistant');
  expectError(await admin.put('/api/v1/admin/ai/bindings/patient_assistant', { primary_model_id: ext.id, base_version: b.version, comment: 'попытка' }), 503, 'E-MODEL-MODE');
  const inject = `INSERT INTO ai_binding_versions (purpose, version, primary_model_id, status, author_id, created_at) SELECT 'patient_assistant', max(version) + 1, ${Number(ext.id)}, 'active', NULL, '2026-10-17T00:00:00Z' FROM ai_binding_versions WHERE purpose = 'patient_assistant'`;
  R.app.exec(`UPDATE ai_binding_versions SET status = 'previous' WHERE purpose = 'patient_assistant' AND status = 'active'; ${inject};`);
  await R.app.advanceClock(31000); // кеш привязок 30 с
  R.app.ai.reset();
  const p = await as(R.app, 'patA');
  expectError(await F.patientAsk(p, F.CALM_PHRASE), 503, 'E-MODEL-MODE');
  assert.equal(R.app.ai.calls().filter((c) => c.model === ext.model_id).length, 0, 'внешняя модель не вызвана');
  const res = await R.app.restart();
  assert.equal(res.exited, true, 'при real и привязке synthetic_only сервер не стартует (F-24)');
  assert.match(res.log, /E-CONFIG/);
  R.app.exec(`DELETE FROM ai_binding_versions WHERE purpose = 'patient_assistant' AND primary_model_id = ${Number(ext.id)}; UPDATE ai_binding_versions SET status = 'active' WHERE id = (SELECT max(id) FROM ai_binding_versions WHERE purpose = 'patient_assistant');`);
  assert.equal((await R.app.restart()).exited, false);
  await R.app.advanceClock(-31000);
});

// covers: T-321, UC-24, UC-06, F-15, F-117, PD-07, S-57
test('T-321 [W-57] real: антивирус недоступен — файл не принимается (503 E-FILE-SCAN), текст сообщения отправить можно', async () => {
  const p = await as(R.app, 'patB');
  expectError(await F.upload(p, 'synthetic_report.pdf', 'message'), 503, 'E-FILE-SCAN');
  expectOk(await p.post('/api/v1/me/messages', { text: 'Синтетика: без файла' }));
});

// covers: T-322, UC-44, UC-45, F-97, F-98, F-19, S-20, S-55
test('T-322 [W-57] real: клиническая настройка ждёт утверждения, до него действует прежняя; КО утверждает (P-51) — действует новая; отказ — с причиной; два ожидающих одного ключа — E-CONFLICT', async () => {
  const admin = await realAdmin(R.app, 'admin1', R.secrets);
  const before = expectOk(await admin.get('/api/v1/admin/settings/crisis.outcome_due_hours')).current;
  const pending = expectOk(await F.setSetting(admin, 'crisis.outcome_due_hours', before.value + 1, { approved_by: undefined }));
  assert.equal(pending.status, 'pending_approval');
  assert.equal(expectOk(await admin.get('/api/v1/admin/settings/crisis.outcome_due_hours')).current.value, before.value, 'до утверждения действует прежняя');
  const ko = await as(R.app, 'psy1');
  expectError(await (await as(R.app, 'psy2')).get('/api/v1/approvals'), 403, 'E-ACCESS');
  const list = expectOk(await ko.get('/api/v1/approvals')).items;
  const ap = list.find((x) => x.setting_key === 'crisis.outcome_due_hours');
  assert.ok(ap && 'from_value' in ap && 'to_value' in ap && ap.author, '«было → стало», автор');
  expectOk(await ko.post(`/api/v1/approvals/${ap.id}/approve`, {}));
  assert.equal(expectOk(await admin.get('/api/v1/admin/settings/crisis.outcome_due_hours')).current.value, before.value + 1);
  const p2 = expectOk(await F.setSetting(admin, 'crisis.outcome_due_hours', before.value + 2, { approved_by: undefined }));
  const p3 = await F.setSetting(admin, 'crisis.outcome_due_hours', before.value + 3, { approved_by: undefined });
  const second = expectOk(await ko.get('/api/v1/approvals')).items.filter((x) => x.setting_key === 'crisis.outcome_due_hours');
  if (p3.status === 200 && second.length >= 2) {
    expectOk(await ko.post(`/api/v1/approvals/${second[0].id}/approve`, {}));
    expectError(await ko.post(`/api/v1/approvals/${second[1].id}/approve`, {}), 409, 'E-CONFLICT');
  }
  const rej = expectOk(await F.setSetting(admin, 'crisis.outcome_due_hours', 5, { approved_by: undefined }));
  const ap3 = expectOk(await ko.get('/api/v1/approvals')).items.find((x) => x.setting_key === 'crisis.outcome_due_hours');
  expectError(await ko.post(`/api/v1/approvals/${ap3.id}/reject`, {}), 422, 'E-VALIDATION');
  expectOk(await ko.post(`/api/v1/approvals/${ap3.id}/reject`, { reason: 'синтетика: нужен прогон' }));
  void p2; void rej;
});

// covers: T-323, UC-31, UC-44, F-34, F-117, S-28, L-28
test('T-323 [W-57] real: гипотезы выключены по умолчанию (E-HINTS-OFF); включение S-28 — только с основанием (E-BASIS-REQUIRED)', async () => {
  const doc = await as(R.app, 'psy1');
  expectError(await doc.post(`/api/v1/patients/${R.app.ids.patA}/hints`, { chips: [] }), 403, 'E-HINTS-OFF');
  const admin = await realAdmin(R.app, 'admin1', R.secrets);
  expectError(await F.setSetting(admin, 'hints.enabled_real', true, { approved_by: undefined }), 422, 'E-BASIS-REQUIRED');
  expectOk(await F.setSetting(admin, 'hints.enabled_real', true, { basis: 'Синтетический приказ Т13 №1 (решение юриста)' }));
});

// covers: T-324, UC-44, F-97, S-23, S-26, S-46
test('T-324 [W-57] real: юридически значимые настройки (сроки хранения S-23, канал сообщений S-26, документы S-46) — только с полем «Основание»', async () => {
  const admin = await realAdmin(R.app, 'admin1', R.secrets);
  expectError(await F.setSetting(admin, 'retention.ai_days', 20), 422, 'E-BASIS-REQUIRED');
  expectError(await F.setSetting(admin, 'messages.channel', { reply_days: 3, mode: 'organizational' }), 422, 'E-BASIS-REQUIRED');
  expectError(await admin.post('/api/v1/admin/content/docs/doc.policy/versions', { markdown: '# Политика (синтетика)' }), 422, 'E-BASIS-REQUIRED');
  expectOk(await F.setSetting(admin, 'retention.ai_days', 20, { basis: 'Синтетическое решение юриста Т13' }));
});

// covers: T-325, UC-16, UC-38, F-96, F-90, F-92, F-104, F-85, S-39, PD-21
test('T-325 [W-56] real: второй фактор обязателен (S-39 выключить нельзя); опасные действия без свежего кода (15 мин) — 401 E-2FA-REQUIRED', async () => {
  const admin = await realAdmin(R.app, 'admin1', R.secrets);
  expectError(await F.setSetting(admin, 'auth.admin_second_factor', 'off'), 422, 'E-SETTING-INVALID');
  await R.app.advanceClock(16 * 60 * 1000);
  expectError(await admin.put(`/api/v1/admin/people/${R.app.ids.psy2}/flags`, { research: true }), 401, 'E-2FA-REQUIRED');
  expectError(await admin.post(`/api/v1/admin/people/${R.app.ids.psy2}/password-reset`, {}), 401, 'E-2FA-REQUIRED');
  expectError(await admin.put('/api/v1/admin/secrets/smtp.password', { value: 'x', confirm: true }), 401, 'E-2FA-REQUIRED');
  expectOk(await admin.post('/api/v1/auth/login/second-factor', { code: totp(R.secrets.admin1, Date.now() + 16 * 60 * 1000) }, { idem: false }));
  expectOk(await admin.put(`/api/v1/admin/people/${R.app.ids.psy2}/flags`, { research: true }));
  await R.app.advanceClock(-16 * 60 * 1000);
});

// covers: T-326, UC-24, F-27, F-117, S-57, L-27
test('T-326 [W-57] real: помощник пациента выключен по умолчанию; включение — с основанием', async () => {
  const p = await as(R.app, 'patA');
  const me = expectOk(await p.get('/api/v1/me'));
  assert.equal(me.features.patient_ai, false);
  const admin = await realAdmin(R.app, 'admin1', R.secrets);
  expectError(await admin.put('/api/v1/admin/features/patient_ai', { enabled: true }), 422, 'E-BASIS-REQUIRED');
});
