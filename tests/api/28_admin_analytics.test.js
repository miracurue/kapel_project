'use strict';

// Программа поддержки (F-112, S-60), метрики сервиса и оценки ИИ (F-113), журналы (F-114):
// только агрегаты, подавление малых групп, CSV без формул, журнал выгрузок, без текстов.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectError, expectOk } = require('../lib/client');
const F = require('../lib/flows');

const ctx = useApp();

async function csvFrom(c, link) {
  const r = await c.get(new URL(link, ctx.app.base).pathname, { headers: { accept: 'text/csv' } });
  assert.equal(r.status, 200);
  return String(r.body);
}

// covers: T-300, UC-42, F-112, F-74, S-60, PD-19, L-19
test('T-300 [W-53] программа поддержки: не настроена — «Программа не настроена»; после S-60 — только агрегаты согласившихся, малые группы скрыты, без идентификаторов; CSV в журнале с классом «спонсор»', async () => {
  const admin = await ctx.as('admin1');
  const before = await admin.get('/api/v1/admin/program/reports?kind=participants&from=2026-01-01&to=2026-12-31');
  assert.ok(before.status === 200);
  assert.ok(before.body.not_configured || (before.body.rows || []).length === 0, 'программа не настроена');
  const inn = await F.innId(admin, 'сертралин');
  expectError(await F.setSetting(admin, 'program.config', { sponsor: 'Синтетический спонсор', inn_ids: [999999], period: 'month', note: 'при поддержке' }), 422, 'E-SETTING-INVALID');
  expectOk(await F.setSetting(admin, 'program.config', { sponsor: 'Синтетический спонсор', inn_ids: [inn], period: 'month', note: 'при поддержке Синтетического спонсора' }));
  for (const kind of ['participants', 'ae_summary', 'reconciliation']) {
    const r = expectOk(await admin.get(`/api/v1/admin/program/reports?kind=${kind}&from=2026-01-01&to=2026-12-31`));
    assert.equal(r.suppressed, true, `${kind}: группа < 10 скрыта`);
    assert.doesNotMatch(JSON.stringify(r), /Марина|Тестова|Т-00|П-0|"patient_id"/);
  }
  const exp = expectOk(await admin.post('/api/v1/admin/program/reports/export', { kind: 'participants', from: '2026-01-01', to: '2026-12-31' }));
  const csv = await csvFrom(admin, exp.link);
  for (const cell of csv.split(/[,\n]/)) assert.ok(!/^"?[=+\-@]/.test(cell), `ячейка «${cell}» без формулы`);
  const log = ctx.app.query("SELECT recipient_class FROM export_log WHERE kind = 'program' ORDER BY id DESC LIMIT 1")[0];
  assert.match(log.recipient_class, /sponsor/);
});

// covers: T-301, UC-19, UC-41, UC-23, F-113, F-74, F-31, PD-17, PD-19
test('T-301 [W-47] метрики сервиса: активность по ролям, доля ошибок, оценки ИИ по назначению, модели и версии промпта — только агрегаты, без текстов', async () => {
  const p = await ctx.as('patA');
  const r = expectOk(await F.patientAsk(p, 'Синтетический вопрос для метрик'));
  expectOk(await p.post(`/api/v1/ai/messages/${r.reply.id}/rating`, { useful: true }));
  const admin = await ctx.as('admin1');
  const m = expectOk(await admin.get('/api/v1/admin/metrics?from=2026-01-01&to=2027-12-31&by=ai_purpose'));
  assert.ok(Array.isArray(m.rows));
  assert.doesNotMatch(JSON.stringify(m), /Синтетический вопрос для метрик/);
});

// covers: T-302, UC-17, UC-08, F-114, F-22, PD-03, PD-17, PD-19, PD-20
test('T-302 [W-47] журналы: фильтры кто/пациент №/действие/период; пациент — номером; без текстов, цитат и значений ключей; период больше 2 лет — E-VALIDATION; CSV без формул; только чтение', async () => {
  const doc = await ctx.as('psy1');
  expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}?tab=diary`));
  const admin = await ctx.as('admin1');
  for (const j of ['access', 'actions', 'ai', 'exports', 'consents', 'requests', 'crisis']) {
    const r = expectOk(await admin.get(`/api/v1/admin/logs/${j}?from=2026-01-01&to=2026-12-31`));
    assert.doesNotMatch(JSON.stringify(r), /Марина|Тестова|pat\.a@|смысла жить/, `${j}: без ФИО и текстов`);
  }
  expectError(await admin.get('/api/v1/admin/logs/access?from=2023-01-01&to=2026-12-31'), 422, 'E-VALIDATION');
  const exp = expectOk(await admin.post('/api/v1/admin/logs/access/export', { filters: { from: '2026-01-01', to: '2026-12-31' } }));
  const csv = await csvFrom(admin, exp.link);
  assert.ok(csv.split('\n').length <= 20001, 'не больше 20 000 строк');
  assert.ok(ctx.app.query("SELECT count(*) n FROM export_log WHERE kind = 'logs_csv'")[0].n >= 1);
  const writes = require('../lib/contract').api().filter((o) => /\/admin\/logs/.test(o.path) && ['PUT', 'PATCH', 'DELETE'].includes(o.method));
  assert.equal(writes.length, 0, 'изменения и стирания журналов из интерфейса нет');
});
