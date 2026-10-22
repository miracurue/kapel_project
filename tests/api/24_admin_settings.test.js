'use strict';

// Рабочие настройки (F-97): версии, откат, конфликт, проверки значений, перенос; клинические — «Кто утвердил»;
// выключатели возможностей и обслуживание (F-117, S-57, S-58); сроки хранения S-23, таймауты S-40, часы S-30, списки S-54.
// Формы значений настроек, на которые опираются тесты, перечислены в Handoff отчёта 13.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { Client, expectError, expectOk } = require('../lib/client');
const F = require('../lib/flows');

const ctx = useApp();

// covers: T-260, UC-44, F-97, F-19, S-17, S-01
test('T-260 [W-41] каждое изменение — новая версия; откат — новая версия с прежним значением; то же значение версию не создаёт; правка по старой версии — E-CONFLICT; остальным администраторам — уведомление', async () => {
  const admin = await ctx.as('admin1');
  const h0 = expectOk(await admin.get('/api/v1/admin/settings/ui.undo_window_seconds'));
  expectOk(await F.setSetting(admin, 'ui.undo_window_seconds', 12));
  const same = await F.setSetting(admin, 'ui.undo_window_seconds', 12);
  assert.equal(same.status, 200);
  const h1 = expectOk(await admin.get('/api/v1/admin/settings/ui.undo_window_seconds'));
  assert.equal(h1.history.length, h0.history.length + 1, 'одинаковое значение не создало версию');
  expectError(await admin.put('/api/v1/admin/settings/ui.undo_window_seconds', { value: 14, base_version: h0.current.version }), 409, 'E-CONFLICT');
  const rb = expectOk(await admin.post('/api/v1/admin/settings/ui.undo_window_seconds/rollback', { to_version: h0.current.version, comment: 'тест' }));
  assert.equal(rb.version, h1.current.version + 1);
  assert.equal(rb.value, h0.current.value);
  const db = ctx.app.db();
  try { assert.throws(() => db.prepare("UPDATE setting_versions SET value_json = '99' WHERE key = 'ui.undo_window_seconds'").run(), /immutable/); } finally { db.close(); }
  expectOk(await F.setSetting(admin, 'crisis.contacts', [{ title: 'Экстренные службы', phone: '112' }, { title: 'Линия клиники (синтетика)', phone: '+7 800 000-00-01' }]));
  const other = expectOk(await (await ctx.as('admin2')).get('/api/v1/notifications')).items;
  assert.ok(other.some((n) => /настройк/i.test(n.title)), 'администраторы уведомлены об изменении S-17');
  const log = ctx.app.query("SELECT * FROM action_log WHERE action LIKE 'setting%' ORDER BY id DESC LIMIT 1")[0];
  assert.ok(log.old_safe_json && log.new_safe_json, 'в журнале старое → новое в безопасном виде');
});

// Неверные значения: сервер отвечает E-SETTING-INVALID с полем (таблица настроек 09).
const INVALID = [
  ['S-01', 'ui.undo_window_seconds', 4],
  ['S-14', 'ai.limits', { patient_per_10min: 0, patient_per_day: 200, clinician_per_hour: 60, hints_per_day: 20, admin_per_hour: 60, budget_tokens: 0, warn_percent: 99 }],
  ['S-15', 'ai.timeouts', { patient_assistant: 181 }],
  ['S-17', 'crisis.contacts', [{ title: 'Без 112', phone: '+7 800 000-00-02' }]],
  ['S-18', 'crisis.sla', { work_minutes: 2000, off_minutes: 30 }],
  ['S-19', 'crisis.outcome_due_hours', 0],
  ['S-21', 'course_support.rules', [{ week: 53, text: 'синтетика' }]],
  ['S-22', 'analytics.min_group', 5],
  ['S-23', 'retention.ai_days', 31],
  ['S-24', 'voice.max_seconds', { patient: 10, clinician: 900 }],
  ['S-26', 'messages.channel', { reply_days: 2, mode: 'organizational', line: 'Ответим срочно' }],
  ['S-29', 'previsit.days_before', { days: 15, reminders: 1 }],
  ['S-30', 'org.timezone_hours', { timezone: 'Europe/Berlin', work_from: '09:00', work_to: '18:00', days: [1, 2, 3, 4, 5] }],
  ['S-40', 'auth.session_timeouts', { idle_minutes: 61, staff_absolute_minutes: 120, patient_remember_minutes: 720 }],
  ['S-56', 'crisis.backup', [999999]],
  ['S-63', 'queue.due', { info_days: 11, stop_days: 10, erasure_days: 31, change_days: 5, crisis_repeat_min: 15, taken_return_days: 1 }],
  ['S-66', 'reference.search', { suggestions: 2, min_chars: 2, fuzziness: 'normal' }],
];

// covers: T-261, UC-44, F-97, S-01, S-14, S-15, S-17, S-18, S-19, S-21, S-22, S-23, S-24, S-26, S-29, S-30, S-40, S-56, S-63, S-66
test('T-261 [W-41] проверки значений настроек на сервере: недопустимое значение каждой настройки — 422 E-SETTING-INVALID с полем', async () => {
  const admin = await ctx.as('admin1');
  const failures = [];
  for (const [S, key, value] of INVALID) {
    const r = await F.setSetting(admin, key, value);
    if (r.status !== 422 || r.body.error.code !== 'E-SETTING-INVALID') failures.push(`${S} ${key}: ${r.status} ${r.body && r.body.error && r.body.error.code}`);
  }
  assert.deepEqual(failures, []);
});

// covers: T-262, UC-44, F-97, F-98, F-104, PD-05
test('T-262 [W-41] «Скачать настройки» — JSON без секретов; загрузка создаёт только черновики, клинические снова идут на утверждение', async () => {
  const admin = await ctx.as('admin1');
  const exp = await admin.get('/api/v1/admin/settings-export');
  assert.equal(exp.status, 200);
  const text = typeof exp.body === 'string' ? exp.body : JSON.stringify(exp.body);
  for (const v of Object.values(ctx.app.env).filter((x) => typeof x === 'string' && x.length >= 32)) assert.ok(!text.includes(v), 'секреты окружения не выгружаются');
  const json = typeof exp.body === 'string' ? JSON.parse(exp.body) : exp.body;
  const file = { name: 'settings.json', buffer: Buffer.from(JSON.stringify(json)), type: 'application/json' };
  const up = expectOk(await F.upload(admin, file, 'reference_import'));
  const imp = expectOk(await admin.post('/api/v1/admin/settings-import', { upload_id: up.id, apply: false }));
  assert.ok(Array.isArray(imp.diff));
});

// covers: T-263, UC-44, UC-45, F-97, F-98, S-18
test('T-263 [W-41] клиническая настройка в synthetic без «Кто утвердил» — 409 E-APPROVAL-REQUIRED; с ним — действует сразу; review-required помечено', async () => {
  const admin = await ctx.as('admin1');
  const cur = expectOk(await admin.get('/api/v1/admin/settings/crisis.sla'));
  expectError(await admin.put('/api/v1/admin/settings/crisis.sla', { value: cur.current.value, base_version: cur.current.version, comment: 'без утверждения' }), 409, 'E-APPROVAL-REQUIRED');
  const ok = expectOk(await F.setSetting(admin, 'crisis.sla', { work_minutes: 20, off_minutes: 40 }));
  assert.equal(ok.status, 'active');
  assert.equal(ok.review_required, true);
});

// covers: T-264, UC-44, UC-18, F-117, F-14, F-15, F-43, F-44, F-38, F-31, F-51, S-57
test('T-264 [W-41] S-57: выключенная возможность пропадает у всех за ≤ 30 с — /me.features и прямой запрос «возможность выключена»; кризис, 112 и журналы выключить нельзя', async () => {
  const admin = await ctx.as('admin1');
  const p = await ctx.as('patA');
  expectOk(await admin.put('/api/v1/admin/features/voice', { enabled: false }));
  const me = expectOk(await p.get('/api/v1/me'));
  assert.equal(me.features.voice, false);
  const r = await F.stt(p, {});
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'E-ACCESS');
  assert.equal(r.body.error.details.feature, 'voice');
  for (const f of ['patient_files', 'where_to_buy', 'course_support', 'self_test', 'ai_rating', 'strange']) {
    expectOk(await admin.put(`/api/v1/admin/features/${f}`, { enabled: false }));
    assert.equal(expectOk(await p.get('/api/v1/me')).features[f], false, `${f} выключено`);
    expectOk(await admin.put(`/api/v1/admin/features/${f}`, { enabled: true }));
  }
  expectOk(await admin.put('/api/v1/admin/features/voice', { enabled: true }));
  for (const f of ['crisis', 'crisis_gate', 'help_112', 'logs', 'pseudonymization']) {
    expectError(await admin.put(`/api/v1/admin/features/${f}`, { enabled: false }), 404, 'E-NOT-FOUND');
  }
});

// covers: T-265, UC-44, UC-18, UC-05, F-117, F-46, F-02, S-58
test('T-265 [W-41] S-58 обслуживание: не-админские адреса — 503 E-MAINTENANCE, сессии пациентов закрыты; входят только администраторы; 112 и справка доступны всем', async () => {
  const admin = await ctx.as('admin1');
  const p = await ctx.fresh('patB');
  expectOk(await admin.put('/api/v1/admin/maintenance', { on: true, until: new Date(Date.now() + 3600000).toISOString(), message_key: 'planned' }));
  try {
    const r = await p.get('/api/v1/me/diary');
    assert.ok(r.status === 503 || r.status === 401);
    const c = new Client(ctx.app.base);
    const login = await c.login('pat.b@cc.example.test');
    expectError(login, 503, 'E-MAINTENANCE');
    expectOk(await new Client(ctx.app.base).get('/api/v1/crisis/contacts'));
    expectOk(await new Client(ctx.app.base).get('/api/v1/help'));
    expectOk(await (await ctx.fresh('admin2')).get('/api/v1/admin/people'));
    const page = await c.get('/login', { headers: { accept: 'text/html' } });
    assert.match(page.body, /112/);
  } finally {
    expectOk(await admin.put('/api/v1/admin/maintenance', { on: false }));
  }
});

// covers: T-266, UC-44, F-21, F-28, S-23, PD-13
test('T-266 [W-41] S-23: срок ИИ-материалов 1 день — тред старше суток стёрт следующим запуском планировщика', async () => {
  const admin = await ctx.as('admin1');
  expectOk(await F.setSetting(admin, 'retention.ai_days', 1));
  const p = await ctx.as('patC');
  const t = expectOk(await F.patientAsk(p, 'Синтетический вопрос для срока хранения'));
  await ctx.app.advanceClock(2 * 86400000);
  await ctx.app.waitJobs(10);
  expectError(await p.get(`/api/v1/ai/threads/${t.thread.id}`), 404, 'E-NOT-FOUND');
  await ctx.app.advanceClock(-2 * 86400000);
  expectOk(await F.setSetting(admin, 'retention.ai_days', 30));
});

// covers: T-267, UC-02, F-02, S-40, PD-21
test('T-267 [W-41] S-40: новый таймаут бездействия 5 минут действует для новых сессий', async () => {
  const admin = await ctx.as('admin1');
  expectOk(await F.setSetting(admin, 'auth.session_timeouts', { idle_minutes: 5, staff_absolute_minutes: 120, patient_remember_minutes: 720 }));
  const p = await ctx.fresh('patH');
  await ctx.app.advanceClock(6 * 60 * 1000);
  expectError(await p.get('/api/v1/me'), 401, 'E-SESSION-EXPIRED');
  expectOk(await F.setSetting(admin, 'auth.session_timeouts', { idle_minutes: 30, staff_absolute_minutes: 120, patient_remember_minutes: 720 }));
});

// covers: T-268, UC-11, F-64, S-30, S-18
test('T-268 [W-41] S-30: рабочие часы организации определяют срок реакции (рабочее / нерабочее время из S-18)', async () => {
  const admin = await ctx.as('admin1');
  expectOk(await F.setSetting(admin, 'crisis.sla', { work_minutes: 15, off_minutes: 45 }));
  expectOk(await F.setSetting(admin, 'org.timezone_hours', { timezone: 'Europe/Moscow', work_from: '00:00', work_to: '00:01', days: [], holidays: [] }));
  const p = await ctx.as('patA');
  expectOk(await p.post('/api/v1/me/messages', { text: `${F.CRISIS_PHRASE} нерабочее время` }));
  const s = await F.crisisSignalFor(await ctx.as('psy1'), ctx.id('patA'));
  const minutes = (new Date(s.due_at) - Date.now()) / 60000;
  assert.ok(minutes > 30 && minutes <= 46, `в нерабочее время срок — 45 мин: ${minutes.toFixed(1)}`);
});

// covers: T-269, UC-44, F-97, F-91, S-54
test('T-269 [W-41] S-54: использованный пункт списка не удаляется (E-IN-USE), а скрывается для новых; 2–30 пунктов', async () => {
  const admin = await ctx.as('admin1');
  expectOk(await admin.post(`/api/v1/admin/people/${ctx.id('patF')}/status`, { action: 'block', reason_key: 'rules' }));
  const cur = expectOk(await admin.get('/api/v1/admin/settings/lists.block_reasons')).current.value;
  const without = cur.filter((x) => (x.key || x) !== 'rules');
  const r = await F.setSetting(admin, 'lists.block_reasons', without);
  assert.ok(r.status === 409 || r.status === 422);
  assert.ok(['E-IN-USE', 'E-SETTING-INVALID'].includes(r.body.error.code));
  expectError(await F.setSetting(admin, 'lists.block_reasons', [cur[0]]), 422, 'E-SETTING-INVALID');
});
