'use strict';
// Привязка моделей GigaChat по назначению при запуске с ключом (registry.ensureBindingsForEnv):
// помощник пациента — GigaChat-2-Max (запасная 2-Pro), шаблоны документов — GigaChat-3-Ultra.
// covers: F-26, F-27, M-19, S-02
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../lib/app');
const { as, expectOk } = require('../lib/client');
const { startFakeGigaChat } = require('../lib/fakes/gigachat');
const F = require('../lib/flows');

let app;
let giga;
before(async () => {
  giga = await startFakeGigaChat();
  app = await startApp({
    env: { GIGACHAT_OAUTH_URL: giga.oauthUrl, GIGACHAT_API_URL: giga.apiUrl, GIGACHAT_AUTH_KEY: 'fake-auth-key', GIGACHAT_SCOPE: 'GIGACHAT_API_PERS' },
  });
}, { timeout: 180000 });
after(async () => {
  if (app) await app.stop();
  if (giga) await giga.close();
});

test('помощник пациента идёт на GigaChat-2-Max, шаблон документа — на GigaChat-3-Ultra', async () => {
  const p = await as(app, 'patA');
  const before = giga.completions().length;
  expectOk(await F.patientAsk(p, 'Когда подействует лекарство?'));
  const psy = await as(app, 'psy1');
  expectOk(await psy.post('/work/api/templates/ai', { request: 'выписка из стационара' }, { idem: false }));
  const models = giga.completions().slice(before).map((r) => JSON.parse(r.body).model);
  assert.deepEqual(models, ['GigaChat-2-Max', 'GigaChat-3-Ultra']);
});

test('ручная привязка (комментарий «Ручная настройка») переживает перезапуск с ключом GigaChat', async () => {
  const db = app.db();
  const stub = db.prepare("SELECT id FROM ai_models WHERE adapter='local_stub' AND title LIKE '%основная%'").get();
  const pro = db.prepare("SELECT id FROM ai_models WHERE adapter='gigachat_api' AND model_ident='GigaChat-2-Pro'").get();
  const cur = db.prepare("SELECT id, version FROM ai_binding_versions WHERE purpose='clinician_chat' AND status='active'").get();
  db.prepare("UPDATE ai_binding_versions SET status='previous' WHERE id=?").run(cur.id);
  db.prepare("INSERT INTO ai_binding_versions(purpose,version,primary_model_id,fallback_model_id,status,comment) VALUES ('clinician_chat',?,?,?,'active','Ручная настройка: проверка')").run(cur.version + 1, stub.id, pro.id);
  db.close();
  const r = await app.restart();
  assert.equal(r.exited, false);
  const after = app.db();
  const row = after.prepare("SELECT version, comment, primary_model_id FROM ai_binding_versions WHERE purpose='clinician_chat' AND status='active'").get();
  after.close();
  assert.equal(row.version, cur.version + 1);
  assert.ok(row.comment.startsWith('Ручная настройка'));
  assert.equal(row.primary_model_id, stub.id);
});
