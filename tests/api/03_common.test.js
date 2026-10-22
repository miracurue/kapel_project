'use strict';

// Общие механизмы: ключ повтора (F-18), «Отменить» (F-17, S-01), уведомления (F-19),
// журнал доступа (F-22) с отказом при сбое, страницы ошибок (F-25), лимиты (F-23).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectError, expectOk } = require('../lib/client');
const F = require('../lib/flows');

const ctx = useApp();
const CLINICAL_WORDS = /кризис|суицид|смысла жить|диагноз|депресс|сертралин|побочн|тошнит|балл/i;

// covers: T-040, UC-18, F-18, PD-17
test('T-040 [W-09] повтор с тем же Idempotency-Key возвращает первый итог без второй записи; другой текст с тем же ключом — 409 E-IDEMPOTENCY-MISMATCH', async () => {
  const p = await ctx.as('patB');
  const key = 'aaaaaaaa-0000-4000-8000-000000000001';
  const first = expectOk(await p.post('/api/v1/me/diary', { mood: 4, sleep: 'ok' }, { idem: key }));
  const second = expectOk(await p.post('/api/v1/me/diary', { mood: 4, sleep: 'ok' }, { idem: key }));
  assert.equal(second.entry.id, first.entry.id);
  const n = ctx.app.query('SELECT count(*) n FROM mood_entries WHERE patient_id = ?', ctx.id('patB'))[0].n;
  assert.equal(n, 1, 'двойное нажатие — одна запись');
  expectError(await p.post('/api/v1/me/diary', { mood: 2 }, { idem: key }), 409, 'E-IDEMPOTENCY-MISMATCH');
  const stored = ctx.app.query('SELECT * FROM idempotency_keys WHERE user_id = ?', ctx.id('patB'));
  assert.ok(stored.length >= 1);
  assert.ok(!JSON.stringify(stored).includes('sleep'), 'в таблице ключей только итог без содержимого записи (PD-17)');
});

// covers: T-041, UC-06, UC-18, F-17, F-47, S-01
test('T-041 [W-09] отложенная видимость: сообщение врачу не видно 10 с; «Отменить» в окне — никто не увидел; после окна — 410 E-UNDO-EXPIRED', async () => {
  const p = await ctx.as('patA');
  const doc = await ctx.as('psy1');
  const sent = expectOk(await p.post('/api/v1/me/messages', { text: 'Синтетический вопрос врачу №1' }));
  assert.ok(sent.undo && sent.undo.id && sent.undo.expires_at);
  const seen = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}/messages`));
  assert.ok(!JSON.stringify(seen).includes('Синтетический вопрос врачу №1'), 'в окне врач сообщения не видит');
  expectOk(await p.post(`/api/v1/undo/${sent.undo.id}`, {}));
  await F.passUndoWindow(ctx.app);
  const after = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}/messages`));
  assert.ok(!JSON.stringify(after).includes('Синтетический вопрос врачу №1'), 'отменённое никто не увидел');
  const notes = expectOk(await doc.get('/api/v1/notifications'));
  assert.ok(!notes.items.some((n) => n.object && n.object.id === sent.message.id), 'уведомления об отменённом нет');
  const late = expectOk(await p.post('/api/v1/me/messages', { text: 'Синтетический вопрос врачу №2' }));
  await F.passUndoWindow(ctx.app);
  expectError(await p.post(`/api/v1/undo/${late.undo.id}`, {}), 410, 'E-UNDO-EXPIRED');
});

// covers: T-042, F-17, PD-02
test('T-042 [W-09] «Отменить» может только автор и один раз: чужой ключ — 404, повтор отмены — тот же ответ', async () => {
  const p = await ctx.as('patA');
  const other = await ctx.as('patB');
  const r = expectOk(await p.post('/api/v1/me/diary', { mood: 3 }));
  expectError(await other.post(`/api/v1/undo/${r.undo.id}`, {}), 404, 'E-NOT-FOUND');
  expectOk(await p.post(`/api/v1/undo/${r.undo.id}`, {}));
  const again = await p.post(`/api/v1/undo/${r.undo.id}`, {});
  assert.equal(again.status, 200, 'повторная отмена отменённого — тот же итог «Отменено»');
  const visible = expectOk(await p.get('/api/v1/me/diary')).items || [];
  assert.ok(!visible.some((e) => e.id === r.entry.id), 'мягко стёртое исчезло из выборок сразу');
});

// covers: T-043, F-17, S-01, F-97
test('T-043 [W-41] окно «Отменить» берётся из S-01: после смены на 20 с срок отмены новых действий — 20 с (+5 с сервера)', async () => {
  const admin = await ctx.as('admin1');
  const cur = expectOk(await admin.get('/api/v1/admin/settings/ui.undo_window_seconds'));
  expectOk(await admin.put('/api/v1/admin/settings/ui.undo_window_seconds', { value: 20, base_version: cur.current.version, comment: 'тест' }));
  const p = await ctx.as('patC');
  const r = expectOk(await p.post('/api/v1/me/diary', { mood: 2 }));
  const windowMs = new Date(r.undo.expires_at) - Date.now();
  assert.ok(windowMs > 15000 && windowMs <= 21000 + 2000, `окно ≈20 с, а не 10 с: ${windowMs}`);
  await ctx.app.advanceClock(18000);
  expectOk(await p.post(`/api/v1/undo/${r.undo.id}`, {}));
});

// covers: T-044, UC-37, UC-10, F-19, F-59, PD-22, S-45
test('T-044 [W-09] уведомления: назначенный тест → у пациента значок «1» и ссылка; заголовок без клинических слов; «прочитать все»', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patA');
  const before = expectOk(await p.get('/api/v1/notifications/count')).unread;
  const a = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patA')}/assignments`, { instrument_code: 'phq9' }));
  assert.equal(expectOk(await p.get('/api/v1/notifications/count')).unread, before, 'в окне «Отменить» уведомления нет (visible_from)');
  await F.passUndoWindow(ctx.app);
  const cnt = expectOk(await p.get('/api/v1/notifications/count')).unread;
  assert.equal(cnt, before + 1);
  const list = expectOk(await p.get('/api/v1/notifications'));
  const n = list.items.find((x) => x.object && x.object.id === a.items[0].id);
  assert.ok(n, 'уведомление ведёт на объект');
  assert.doesNotMatch(n.title, CLINICAL_WORDS, 'заголовок нейтральный (PD-22)');
  expectOk(await p.post('/api/v1/notifications/read', { all: true }));
  assert.equal(expectOk(await p.get('/api/v1/notifications/count')).unread, 0);
  const dup = ctx.app.query('SELECT count(*) n FROM notifications WHERE recipient_id = ? AND object_id = ?', ctx.id('patA'), a.items[0].id)[0].n;
  assert.equal(dup, 1, 'одно событие — одно уведомление на получателя');
});

// covers: T-045, F-19, F-21, S-23, PD-13
test('T-045 [W-08] уведомления хранятся 90 дней (S-23) и потом стираются планировщиком', async () => {
  const p = await ctx.as('patA');
  const total = expectOk(await p.get('/api/v1/notifications')).total;
  assert.ok(total >= 1);
  await ctx.app.advanceClock(91 * 86400000);
  await ctx.app.waitJobs(10);
  assert.equal(ctx.app.query('SELECT count(*) n FROM notifications WHERE recipient_id = ?', ctx.id('patA'))[0].n, 0);
  await ctx.app.advanceClock(-91 * 86400000);
});

// covers: T-046, UC-18, UC-09, F-25, F-11, PD-02
test('T-046 [W-06] чужая и несуществующая карточка выглядят одинаково: тот же статус и тот же текст P-28, без подробностей', async () => {
  const doc = await ctx.as('psy1');
  const foreign = await doc.get(`/work/patients/${ctx.id('patB')}`, { headers: { accept: 'text/html' } });
  const missing = await doc.get('/work/patients/999999', { headers: { accept: 'text/html' } });
  assert.equal(foreign.status, missing.status);
  assert.equal(foreign.status, 404);
  const strip = (h) => h.replace(/data-request-id="[^"]*"|\b[0-9a-f]{8,}\b/gi, '');
  assert.equal(strip(foreign.body), strip(missing.body), 'страницы неотличимы');
  assert.match(foreign.body, /data-page="P-28"/);
  assert.ok(!foreign.body.includes(require('../fixtures/world').byKey('patB').name), 'имя чужого пациента не раскрывается');
});

// covers: T-047, UC-08, F-22, F-58, PD-03, PD-17
test('T-047 [W-05] открытие карточки и вкладки пишет phi_access_log (allow) без ФИО и текста; повтор за минуту — одна строка; чужое — deny', async () => {
  const doc = await ctx.fresh('psy1');
  const start = ctx.app.query('SELECT max(id) m FROM phi_access_log')[0].m || 0;
  expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}?tab=overview`));
  expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}?tab=overview`));
  expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}?tab=diary`));
  await doc.get(`/api/v1/patients/${ctx.id('patB')}?tab=overview`);
  const rows = ctx.app.query('SELECT * FROM phi_access_log WHERE id > ? ORDER BY id', start);
  const allowOverview = rows.filter((r) => r.patient_id === ctx.id('patA') && r.decision === 'allow' && /overview/.test(r.section));
  assert.equal(allowOverview.length, 1, 'дедупликация 1 мин для того же пользователя и сессии');
  assert.ok(rows.some((r) => r.patient_id === ctx.id('patA') && /diary/.test(r.section)), 'каждая вкладка пишется');
  assert.ok(rows.some((r) => r.patient_id === ctx.id('patB') && r.decision === 'deny'), 'отказ пишется как deny');
  assert.doesNotMatch(JSON.stringify(rows), /Марина|Тестова|pat\.a@/, 'в журнале нет ФИО и почты');
});

// covers: T-048, F-22, F-11, PD-03
test('T-048 [W-05] если запись в журнал доступа не удалась — клинические данные не отдаются (fail-closed, E-INTERNAL)', async () => {
  const doc = await ctx.fresh('psy1');
  ctx.app.exec("CREATE TRIGGER t13_phi_fail BEFORE INSERT ON phi_access_log BEGIN SELECT RAISE(ABORT, 'test: log down'); END;");
  try {
    const r = await doc.get(`/api/v1/patients/${ctx.id('patA')}?tab=diary`);
    expectError(r, 500, 'E-INTERNAL');
    assert.ok(!JSON.stringify(r.body).includes('mood'), 'данных в ответе нет');
  } finally {
    ctx.app.exec('DROP TRIGGER t13_phi_fail;');
  }
});

// covers: T-049, F-23, UC-18
test('T-049 [W-04] превышение частоты: 429 E-RATE-LIMIT с details.retry_after_s, введённое не теряется (ключ ошибки для «подождите N»)', async () => {
  const p = await ctx.as('patC');
  let last;
  for (let i = 0; i < 31; i += 1) last = await p.post('/api/v1/me/messages', { text: `Синтетическое сообщение ${i}` });
  const e = expectError(last, 429, 'E-RATE-LIMIT');
  assert.ok(e.details && e.details.retry_after_s > 0);
});
