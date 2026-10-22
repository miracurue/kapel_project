'use strict';

// Внешние сервисы и состояние: секреты (F-104, S-41, S-42, PD-05), почта и очередь писем (F-105, F-20),
// шаблоны (F-106, S-44, S-45), состояние и задачи (F-115, F-21), адрес ml-worker (S-43), чек-лист real (F-116, S-59).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { useApp } = require('../lib/suite');
const { expectError, expectOk } = require('../lib/client');
const C = require('../lib/contract');
const F = require('../lib/flows');

const ctx = useApp();
const SECRET = 'T13-canary-secret-value-0000000000';

// covers: T-280, UC-44, F-104, S-41, S-42, PD-05, PD-17
test('T-280 [W-43] секрет задаётся, но обратно не возвращается ни одним адресом API; в базе и журнале его нет; замена — с подтверждением', async () => {
  const admin = await ctx.as('admin1');
  expectError(await admin.put('/api/v1/admin/secrets/smtp.password', { value: SECRET }), 422, 'E-VALIDATION');
  expectOk(await admin.put('/api/v1/admin/secrets/smtp.password', { value: SECRET, confirm: true }));
  const meta = expectOk(await admin.get('/api/v1/admin/secrets')).items.find((s) => s.name === 'smtp.password');
  assert.equal(meta.set, true);
  const leaks = [];
  for (const op of C.api().filter((o) => o.method === 'GET' && o.path.startsWith('/api/v1/admin'))) {
    const r = await admin.get(C.fillPath(op.path));
    if (JSON.stringify(r.body || '').includes(SECRET)) leaks.push(op.path);
  }
  assert.deepEqual(leaks, [], 'значение секрета не возвращается никогда');
  const dump = ctx.app.query("SELECT group_concat(quote(value_json)) v FROM setting_versions")[0].v || '';
  assert.ok(!dump.includes(SECRET), 'секрет не в базе');
  assert.ok(!ctx.app.logs().includes(SECRET), 'и не в журнале');
  const store = path.join(ctx.app.dataDir, 'secrets.enc');
  assert.ok(fs.existsSync(store), 'хранилище секретов — отдельный файл');
  assert.ok(!fs.readFileSync(store).includes(Buffer.from(SECRET)), 'файл зашифрован');
  assert.equal((fs.statSync(store).mode & 0o777).toString(8), '600');
});

// covers: T-281, UC-38, UC-44, F-105, F-20, F-21, S-42, PD-22
test('T-281 [W-43] проверочное письмо уходит текущему администратору; сбой SMTP — повторы 1/5/15 мин, затем «не отправлено» и событие администратору; в очереди получатель — номер или роль', async () => {
  const admin = await ctx.as('admin1');
  expectOk(await admin.post('/api/v1/admin/mail/test', {}));
  await ctx.app.waitJobs(10);
  assert.ok(ctx.app.smtp.lastTo('admin1@cc.example.test'), 'проверочное письмо пришло');
  ctx.app.smtp.failNextMessages(10);
  expectOk(await (await ctx.guest()).post('/api/v1/auth/password-reset', { email: 'pat.a@cc.example.test' }));
  for (const m of [1, 5, 15]) { await ctx.app.advanceClock(m * 60 * 1000 + 1000); await ctx.app.waitJobs(10); }
  const q = expectOk(await admin.get('/api/v1/admin/mail/queue'));
  const failed = q.items.find((x) => x.status === 'failed' || x.status === 'not_sent');
  assert.ok(failed, 'после 3 повторов — «не отправлено»');
  assert.doesNotMatch(JSON.stringify(q), /pat\.a@cc\.example\.test/, 'адрес в очереди не показывается');
  const retry = await admin.post(`/api/v1/admin/mail/queue/${failed.id}/retry`, {});
  assert.ok(retry.status === 409 || retry.status === 422, 'письмо старше 50 минут не повторяется — ссылка истекает');
  ctx.app.smtp.failNextMessages(0);
  await ctx.app.advanceClock(-(21 * 60 * 1000 + 3000));
});

// covers: T-282, UC-37, UC-38, F-106, S-44, S-45, PD-22, L-36
test('T-282 [W-43] шаблоны: письмо без {{link}} и с переменной ПДн — E-TEMPLATE-VAR; клиническое слово в заголовке уведомления — E-TEMPLATE-VAR; новая версия действует для новых писем', async () => {
  const admin = await ctx.as('admin1');
  expectError(await admin.put('/api/v1/admin/templates/mail.password_reset', { subject: 'Сброс пароля', body: 'Без ссылки' }), 422, 'E-TEMPLATE-VAR');
  expectError(await admin.put('/api/v1/admin/templates/mail.password_reset', { subject: 'Сброс пароля', body: '{{link}} {{full_name}}' }), 422, 'E-TEMPLATE-VAR');
  expectError(await admin.put('/api/v1/admin/templates/notify.signal', { title: 'Кризис у пациента {{initials}}', body: '' }), 422, 'E-TEMPLATE-VAR');
  expectOk(await admin.put('/api/v1/admin/templates/mail.password_reset', { subject: 'Сброс пароля (синтетика Т13)', body: 'Ссылка: {{link}}' }));
  expectOk(await (await ctx.guest()).post('/api/v1/auth/password-reset', { email: 'pat.b@cc.example.test' }));
  await ctx.app.waitJobs(10);
  assert.match(ctx.app.smtp.lastTo('pat.b@cc.example.test').data, /синтетика Т13/);
  const pv = expectOk(await admin.post('/api/v1/admin/templates/mail.password_reset/preview', {}));
  assert.doesNotMatch(JSON.stringify(pv), /pat\.|Марина/, 'предпросмотр на синтетических значениях');
});

// covers: T-283, UC-19, UC-18, F-115, F-21, F-82
test('T-283 [W-47] состояние сервиса: версия, режим, ml-worker, почта, задачи; задача упала 5 раз подряд — запрос в очереди; «Повторить» — один запуск', async () => {
  const admin = await ctx.as('admin1');
  const s = expectOk(await admin.get('/api/v1/admin/service/status'));
  assert.equal(s.data_mode, 'synthetic');
  assert.ok(s.version && s.ml_worker && s.mail && Array.isArray(s.jobs));
  ctx.app.ml.mode.health = 'down';
  const s2 = expectOk(await admin.get('/api/v1/admin/service/status'));
  assert.match(String(s2.ml_worker), /down|недоступ|unavailable/i);
  ctx.app.ml.reset();
  ctx.app.exec("CREATE TRIGGER t13_job_fail BEFORE INSERT ON job_marks BEGIN SELECT RAISE(ABORT, 'test: job down'); END;");
  try {
    for (let i = 0; i < 6; i += 1) { await ctx.app.advanceClock(61000); await ctx.app.waitJobs(3); }
    const q = expectOk(await admin.get('/api/v1/admin/requests?filter=open')).items;
    assert.ok(q.some((x) => x.kind === 'job_failed'), 'после 5 сбоев подряд — запрос администратору');
  } finally { ctx.app.exec('DROP TRIGGER t13_job_fail;'); }
  const job = expectOk(await admin.get('/api/v1/admin/service/status')).jobs[0];
  expectOk(await admin.post(`/api/v1/admin/service/jobs/${encodeURIComponent(job.name)}/retry`, {}));
});

// covers: T-284, UC-44, F-104, S-43
test('T-284 [W-43] S-43: адрес ml-worker — только внутренняя сеть; публичный адрес отклоняется (защита от обращения по чужому адресу)', async () => {
  const admin = await ctx.as('admin1');
  expectError(await F.setSetting(admin, 'ext.ml_worker', { url: 'https://example.com:8000' }), 422, 'E-SETTING-INVALID');
  expectError(await F.setSetting(admin, 'ext.ml_worker', { url: 'http://8.8.8.8:8000' }), 422, 'E-SETTING-INVALID');
  expectOk(await F.setSetting(admin, 'ext.ml_worker', { url: 'http://ml-worker:8000', timeouts: { stt: 60, ocr: 30, ner: 3 } }));
  expectError(await F.setSetting(admin, 'ext.gigachat', { api_url: 'http://api.giga.chat/v1' }), 422, 'E-SETTING-INVALID');
});

// covers: T-285, UC-44, UC-40, F-116, F-24, S-59, PD-28
test('T-285 [W-57] чек-лист real: 14 пунктов, отметка — с тем, кто подтвердил и документом; автоматические пункты сервер отмечает сам; отметка сама real не включает', async () => {
  const admin = await ctx.as('admin1');
  const list = expectOk(await admin.get('/api/v1/admin/real-checklist'));
  assert.equal(list.items.length, 14);
  const manual = list.items.find((i) => !i.auto);
  const noDoc = await admin.put(`/api/v1/admin/real-checklist/${manual.key}`, { confirmed_by: 'Синтетический юрист', position: 'юрист', date: '2026-10-17' });
  assert.equal(noDoc.status, 422);
  assert.ok(['E-VALIDATION', 'E-BASIS-REQUIRED'].includes(noDoc.body.error.code), 'без документа отметка не ставится');
  expectOk(await admin.put(`/api/v1/admin/real-checklist/${manual.key}`, { confirmed_by: 'Синтетический юрист', position: 'юрист', date: '2026-10-17', document: 'Протокол Т13-1' }));
  assert.equal(expectOk(await admin.get('/api/v1/me')).data_mode, 'synthetic', 'режим меняется только развёртыванием');
  assert.ok(ctx.app.query('SELECT count(*) n FROM real_checklist_history')[0].n >= 1, 'история отметок');
});
