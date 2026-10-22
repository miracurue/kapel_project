'use strict';

// Адаптер gigachat_api шлюза ИИ (M-19, S-41) против подделки GigaChat: токен OAuth с кешем,
// закреплённое имя модели, в запросе только ключи F-80; бюджет и предупреждение 80 % (F-103, S-14).
// Подделка подключается переменными GIGACHAT_OAUTH_URL / GIGACHAT_API_URL (только NODE_ENV=test).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../lib/app');
const { as, expectError, expectOk } = require('../lib/client');
const { startFakeGigaChat } = require('../lib/fakes/gigachat');
const F = require('../lib/flows');

let app;
let giga;
before(async () => {
  giga = await startFakeGigaChat();
  app = await startApp({ env: { GIGACHAT_OAUTH_URL: giga.oauthUrl, GIGACHAT_API_URL: giga.apiUrl, GIGACHAT_AUTH_KEY: 'fake-auth-key-t13', GIGACHAT_SCOPE: 'GIGACHAT_API_PERS' } });
}, { timeout: 180000 });
after(async () => { if (app) await app.stop(); if (giga) await giga.close(); });

// covers: T-125, UC-24, F-26, F-80, F-99, S-02, S-41, M-19, PD-15
test('T-125 [W-30] gigachat_api: один токен OAuth на серию вызовов, модель GigaChat-2-Max по привязке S-02, в теле запроса только ключи', async () => {
  const p = await as(app, 'patA');
  expectOk(await F.patientAsk(p, 'Меня зовут Марина Тестова, телефон +7 912 000-12-34. Когда подействует лекарство?'));
  expectOk(await F.patientAsk(p, 'Ещё вопрос про сон'));
  assert.equal(giga.tokensIssued(), 1, 'токен OAuth кешируется');
  const calls = giga.completions();
  assert.equal(calls.length, 2);
  const body = JSON.parse(calls[0].body);
  assert.equal(body.model, 'GigaChat-2-Max', 'точное имя версии модели (стандарты §5)');
  assert.match(calls[0].headers.authorization, /^Bearer fake-token-/);
  assert.ok(!calls[0].body.includes('Марина') && !calls[0].body.includes('000-12-34'), 'наружу ушли только ключи #ТИП-N#');
  assert.match(calls[0].body, /#PERSON-1#/);
});

// covers: T-126, F-26, F-99, S-03, M-19
test('T-126 [W-30] сбой основной модели GigaChat → одна попытка запасной (GigaChat-2-Pro), затем E-AI-UNAVAILABLE', async () => {
  const p = await as(app, 'patB');
  giga.behaviour.fail = true;
  const before = giga.completions().length;
  expectError(await F.patientAsk(p, 'Синтетический вопрос при сбое'), 503, 'E-AI-UNAVAILABLE');
  const tried = giga.completions().slice(before).map((r) => JSON.parse(r.body).model);
  assert.deepEqual(tried, ['GigaChat-2-Max', 'GigaChat-2-Pro']);
  giga.behaviour.fail = false;
});

// covers: T-127, UC-44, F-103, F-23, F-82, S-14
test('T-127 [W-42] месячный бюджет S-14: на 80 % — уведомление администраторам и запрос в очереди, на 100 % — E-AI-LIMIT', async () => {
  const admin = await as(app, 'admin1');
  expectOk(await F.setSetting(admin, 'ai.limits', { patient_per_10min: 100, patient_per_day: 1000, clinician_per_hour: 60, hints_per_day: 20, admin_per_hour: 60, budget_tokens: 100, warn_percent: 80 }));
  const usage0 = expectOk(await admin.get('/api/v1/admin/ai/usage'));
  assert.ok(usage0, 'расход виден по назначениям');
  const p = await as(app, 'patC');
  let last;
  for (let i = 0; i < 6; i += 1) last = await F.patientAsk(p, `Вопрос бюджета ${i}`);
  await app.waitJobs(10);
  const queue = expectOk(await admin.get('/api/v1/admin/requests?filter=open')).items;
  assert.ok(queue.some((q) => q.kind === 'ai_budget'), 'запрос «бюджет ИИ 80 %» в очереди');
  const notes = expectOk(await admin.get('/api/v1/notifications')).items;
  assert.ok(notes.some((n) => /бюджет|лимит/i.test(n.title)), 'уведомление администратору');
  expectError(last, 429, 'E-AI-LIMIT');
});

// covers: T-128, UC-44, F-99, F-104, S-41, PD-05
test('T-128 [W-42] «Проверить» модель: синтетический запрос, время и код ответа без тела; ключ GigaChat задан окружением и не показывается', async () => {
  const admin = await as(app, 'admin1');
  const models = expectOk(await admin.get('/api/v1/admin/ai/models')).items;
  const max = models.find((m) => m.model_id === 'GigaChat-2-Max');
  assert.equal(max.data_class, 'synthetic_only', 'внешняя модель — только синтетика');
  const check = expectOk(await admin.post(`/api/v1/admin/ai/models/${max.id}/check`, {}));
  assert.ok(typeof check.ms === 'number' || typeof check.duration_ms === 'number' || check.ok !== undefined);
  assert.ok(!JSON.stringify(check).includes('Синтетический ответ GigaChat'), 'тело ответа не показывается');
  const secrets = expectOk(await admin.get('/api/v1/admin/secrets'));
  const s = secrets.items.find((x) => /gigachat/.test(x.name));
  assert.equal(s.source, 'env', 'задан в окружении сервера — меняется развёртыванием');
  assert.ok(!JSON.stringify(secrets).includes('fake-auth-key-t13'));
});
