'use strict';

// Подготовка боевого режима DATA_MODE=real для тестов вехи В7 (W-56, W-57): сначала в synthetic администратор
// закрывает чек-лист S-59 (14 пунктов), включает второй фактор S-39 и привязывает все назначения к локальной
// модели (local_ok), затем сервер перезапускается с DATA_MODE=real (F-24 проверяет всё при запуске).
// Данные по-прежнему синтетические: «real» здесь — только режим кода.

const assert = require('node:assert/strict');
const net = require('net');
const { startApp } = require('./app');
const { Client, expectOk } = require('./client');
const { PASSWORD, byKey } = require('../fixtures/world');
const { totp, secretFromUri } = require('./totp');
const F = require('./flows');

const PURPOSES = ['patient_assistant', 'clinician_chat', 'document_draft', 'diagnostic_hints', 'ae_extraction', 'order_parse', 'admin_assistant'];

function closedPort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

// Вход администратора при real: первый вход — подключение второго фактора, дальше — код.
async function realAdmin(app, key, secrets) {
  const c = new Client(app.base);
  const r = expectOk(await c.login(byKey(key).email, PASSWORD));
  c.csrf = null;
  if (r.next === 'second_factor') {
    if (!secrets[key]) {
      const s = expectOk(await c.post('/api/v1/me/second-factor/setup', {}));
      secrets[key] = secretFromUri(s.otpauth_uri);
      expectOk(await c.post('/api/v1/me/second-factor/enable', { code: totp(secrets[key]) }));
    } else {
      expectOk(await c.post('/api/v1/auth/login/second-factor', { code: totp(secrets[key]) }, { idem: false }));
    }
  }
  return c;
}

async function startRealApp() {
  const app = await startApp({ env: { DATA_MODE: 'synthetic' } });
  const admin = new Client(app.base);
  expectOk(await admin.login(byKey('admin1').email));
  admin.csrf = null;
  const list = expectOk(await admin.get('/api/v1/admin/real-checklist'));
  for (const item of list.items) {
    if (item.auto) continue;
    expectOk(await admin.put(`/api/v1/admin/real-checklist/${item.key}`, { confirmed_by: 'Синтетический подтверждающий', position: 'тест', date: '2026-10-17', document: `Т13-${item.key}` }));
  }
  expectOk(await F.setSetting(admin, 'auth.admin_second_factor', 'on'));
  const model = expectOk(await admin.post('/api/v1/admin/ai/models', { name: 'Локальная заглушка (тест real)', adapter: 'local_stub', model_id: 'stub-local-real', location: 'our_server', license_url: 'https://example.test/license', law_243_status: 'unknown', enabled: true, supports_tools: true }));
  const bindings = expectOk(await admin.get('/api/v1/admin/ai/bindings')).items;
  for (const p of PURPOSES) {
    const b = bindings.find((x) => x.purpose === p);
    expectOk(await admin.put(`/api/v1/admin/ai/bindings/${p}`, { primary_model_id: model.id, fallback_model_id: null, base_version: b.version, comment: 'real: только local_ok' }));
  }
  const res = await app.restart({ DATA_MODE: 'real', DEMO_MODE: '0', FILE_SCANNER: 'clamd', CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String(await closedPort()), COOKIE_SECURE: '1' });
  assert.equal(res.exited, false, `сервер в real должен запуститься после чек-листа: ${res.log || ''}`);
  return { app, localModelId: model.id, secrets: {} };
}

module.exports = { startRealApp, realAdmin, PURPOSES };
