'use strict';

// Дневник (F-39): хотя бы одно значение, «Отменить», правка только за сегодня, видимость заметок врачу (F-51);
// напоминания (F-41) в поясе пациента (S-30); без обязательного согласия записи закрыты (PD-10).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectError, expectOk } = require('../lib/client');
const F = require('../lib/flows');

const ctx = useApp();

// covers: T-155, UC-04, F-39, F-17, F-18
test('T-155 [W-21] запись дневника: пустая — подсказка; с одним значением — «Запись сохранена · Отменить»; правка и удаление — только сегодняшней', async () => {
  const p = await ctx.as('patA');
  const empty = expectError(await p.post('/api/v1/me/diary', {}), 422, 'E-VALIDATION');
  assert.ok(empty.fields.some((f) => f.key === 'err.e-validation.diary_empty'));
  const r = expectOk(await p.post('/api/v1/me/diary', { mood: 4, triggers: ['work', 'sleep'], trigger_other: 'синтетика' }));
  assert.ok(r.undo);
  expectOk(await p.patch(`/api/v1/me/diary/${r.entry.id}`, { mood: 3 }));
  const old = expectOk(await p.post('/api/v1/me/diary', { day: '2026-01-05', mood: 2 }));
  await F.passUndoWindow(ctx.app);
  expectError(await p.patch(`/api/v1/me/diary/${old.entry.id}`, { mood: 5 }), 409, 'E-EDIT-WINDOW');
  const del = expectOk(await p.del(`/api/v1/me/diary/${r.entry.id}`));
  assert.ok(del.undo, 'удаление — мягкое с «Отменить»');
  expectOk(await p.post(`/api/v1/undo/${del.undo.id}`, {}));
  assert.ok(expectOk(await p.get('/api/v1/me/diary?period=2w')).items.some((e) => e.id === r.entry.id));
});

// covers: T-156, UC-04, UC-08, F-39, F-51, F-58, PD-02
test('T-156 [W-21] врачу видны числа и приём, текст заметки — только после «открыть заметки врачу»; выключение действует со следующего запроса', async () => {
  const p = await ctx.as('patA');
  expectOk(await p.post('/api/v1/me/diary', { mood: 2, note: 'Синтетическая личная заметка Т13' }));
  await F.passUndoWindow(ctx.app);
  const doc = await ctx.as('psy1');
  const hidden = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}?tab=diary`));
  assert.ok(JSON.stringify(hidden).includes('"mood"'), 'числа видны');
  assert.ok(!JSON.stringify(hidden).includes('Синтетическая личная заметка Т13'), 'текст заметки закрыт по умолчанию');
  const on = expectOk(await p.patch('/api/v1/me/prefs', { diary_notes_visible: true }));
  assert.ok(on.undo, '«Заметки открыты врачу · Отменить»');
  const shown = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}?tab=diary`));
  assert.ok(JSON.stringify(shown).includes('Синтетическая личная заметка Т13'));
  expectOk(await p.patch('/api/v1/me/prefs', { diary_notes_visible: false }));
  assert.ok(!JSON.stringify(expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}?tab=diary`))).includes('Синтетическая личная заметка Т13'));
});

// covers: T-157, UC-30, UC-04, F-39, F-30, F-16
test('T-157 [W-21] заметка «тошнит после таблетки» → предложение оформить НЯ; кризисная — сначала кризис', async () => {
  const p = await ctx.as('patH');
  const r = expectOk(await p.post('/api/v1/me/diary', { mood: 3, note: F.AE_PHRASE }));
  assert.ok(r.ae_suggestion, 'предложение под записью');
  const c = expectOk(await p.post('/api/v1/me/diary', { mood: 1, note: `${F.CRISIS_PHRASE} и ${F.AE_PHRASE}` }));
  assert.ok(c.crisis, 'кризис раньше всего');
});

// covers: T-158, UC-04, UC-26, F-41, F-19, F-21, S-30
test('T-158 [W-19] напоминание о приёме приходит в сервисе в поясе пациента один раз; выключение — сразу', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patA');
  await F.sertralinePrescribedAndAccepted(ctx.app, doc, p, ctx.id('patA'));
  const rem = expectOk(await p.get('/api/v1/me/reminders')).items;
  assert.ok(rem.length >= 1, 'напоминание создано из схемы принятого назначения');
  expectOk(await p.patch('/api/v1/me/prefs', { timezone: 'Asia/Yekaterinburg' }));
  const now = new Date(Date.now() + 120000);
  const hhmm = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Yekaterinburg', hour: '2-digit', minute: '2-digit' }).format(now);
  expectOk(await p.put(`/api/v1/me/reminders/${rem[0].id}`, { time: hhmm, days: [1, 2, 3, 4, 5, 6, 7], enabled: true }));
  await ctx.app.advanceClock(3 * 60 * 1000);
  await ctx.app.waitJobs(10);
  const count = () => ctx.app.query("SELECT count(*) n FROM notifications WHERE recipient_id = ? AND type LIKE '%remind%'", ctx.id('patA'))[0].n;
  const n1 = count();
  assert.ok(n1 >= 1, 'напоминание пришло в нужное местное время');
  await ctx.app.waitJobs(10);
  assert.equal(count(), n1, 'одно уведомление на время напоминания');
  expectOk(await p.put(`/api/v1/me/reminders/${rem[0].id}`, { time: hhmm, days: [1, 2, 3, 4, 5, 6, 7], enabled: false }));
  await ctx.app.advanceClock(86400000);
  await ctx.app.waitJobs(10);
  assert.equal(count(), n1, 'выключенное не приходит');
  await ctx.app.advanceClock(-86400000);
});

// covers: T-159, UC-08, F-39, F-06, PD-10
test('T-159 [W-21] после отзыва обязательного согласия новая запись дневника не создаётся (403 E-CONSENT-REQUIRED: запрос на стирание, ограничение обработки W-50); кризисная заметка всё равно распознаётся', async () => {
  const p = await ctx.as('patG');
  const v = expectOk(await p.get('/api/v1/consents')).items.find((x) => x.kind === 'base').version;
  expectOk(await p.post('/api/v1/consents/base', { action: 'revoke', version: v, confirm: true }));
  const before = ctx.app.query('SELECT count(*) n FROM crisis_escalations WHERE patient_id = ?', ctx.id('patG'))[0].n;
  // Одобрено 2026-10-21: отзыв создаёт запрос на стирание, ограничение обработки (W-50) действует раньше проверки согласия.
  // Решение владельца 2026-10-25: причина отказа для пациента — «нужно согласие». Обычная запись не создаётся.
  const calm = await p.post('/api/v1/me/diary', { mood: 3, note: F.CALM_PHRASE });
  assert.equal(calm.status, 403);
  assert.equal(calm.body.error.code, 'E-CONSENT-REQUIRED');
  // Кризисная заметка не теряется: запись не сохраняется, но карточка 112 показана и сигнал создан.
  const r = await p.post('/api/v1/me/diary', { mood: 1, note: F.CRISIS_PHRASE });
  assert.equal(r.status, 200);
  assert.ok(r.body.crisis, 'карточка кризисной помощи');
  assert.equal(r.body.saved, false);
  assert.ok(ctx.app.query('SELECT count(*) n FROM crisis_escalations WHERE patient_id = ?', ctx.id('patG'))[0].n > before, 'кризисный детектор сработал');
});
