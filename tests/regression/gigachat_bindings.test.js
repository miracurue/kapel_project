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
