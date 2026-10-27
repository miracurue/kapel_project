'use strict';

// Специалист: список пациентов (F-57), карточка (F-58), завершение наблюдения и архив (F-69),
// замещение (F-70, F-87), закрепления и повторное подключение (F-93, F-94), приглашения (F-73).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectError, expectOk } = require('../lib/client');
const F = require('../lib/flows');

const ctx = useApp({
  extraPeople: [
    { key: 'patL', R: 'R-02', role: 'patient', name: 'Лев Архивируемый', email: 'pat.l@cc.example.test', clinicians: ['psy1'], consents: ['base', 'ai'] },
  ],
});
const day = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

// covers: T-210, UC-09, F-57, F-11, PD-02, PD-03
test('T-210 [W-17] список: только закреплённые, цветная точка со всеми причинами, открытый кризис первым; чужой не находится; страница по 50', async () => {
  const p = await ctx.as('patA');
  expectOk(await p.post('/api/v1/me/messages', { text: F.CRISIS_PHRASE }));
  const doc = await ctx.as('psy1');
  const list = expectOk(await doc.get('/api/v1/patients'));
  const ids = list.items.map((x) => x.id);
  assert.ok(ids.includes(ctx.id('patA')) && !ids.includes(ctx.id('patB')), 'только закреплённые');
  assert.equal(list.items[0].id, ctx.id('patA'), 'открытый кризис — первым');
  assert.equal(list.items[0].dot, 'red');
  assert.ok(list.items[0].dot_reasons.length >= 1, 'причины «почему»');
  for (const x of list.items) assert.ok(['red', 'yellow', 'green', 'grey'].includes(x.dot));
  const found = expectOk(await doc.get(`/api/v1/patients?q=${encodeURIComponent('Пробный')}`));
  assert.equal(found.items.length, 0, 'чужой пациент поиском не находится');
  const arch = expectOk(await doc.get('/api/v1/patients?filter=archive')).items.map((x) => x.id);
  assert.ok(arch.includes(ctx.id('patD')), 'архивный — в фильтре «Архив»');
  assert.ok(!ids.includes(ctx.id('patD')), 'и не в рабочем списке');
  const empty = expectOk(await (await ctx.as('plg2')).get('/api/v1/patients'));
  assert.equal(empty.items.length, 0, 'пустое состояние «За вами пока не закреплены пациенты»');
});

// covers: T-211, UC-09, UC-20, F-58, F-22, PD-02, PD-03, PD-11
test('T-211 [W-17] карточка: вкладки обзор·лечение·тесты·дневник·сообщения·документы; у психолога «Лечение» — 403; открепление во время просмотра — следующий запрос 404', async () => {
  const doc = await ctx.as('psy1');
  for (const tab of ['overview', 'treatment', 'tests', 'diary', 'messages', 'docs']) {
    const r = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}?tab=${tab}`));
    assert.equal(r.tab, tab);
  }
  const plg = await ctx.as('plg1');
  expectError(await plg.get(`/api/v1/patients/${ctx.id('patA')}?tab=treatment`), 403, 'E-ACCESS');
  const ov = expectOk(await plg.get(`/api/v1/patients/${ctx.id('patA')}?tab=overview`));
  assert.equal(ov.overview.adverse_events, null, 'у психолога нет строки НЯ');
  assert.equal(ov.overview.patient_meds, null, 'и лекарств');
  assert.doesNotMatch(JSON.stringify(ov), /сертралин|побочн/i, 'ни названий препаратов, ни слов о побочных эффектах');
  const admin = await ctx.as('admin1');
  expectOk(await admin.post('/api/v1/admin/care-assignments', { patient_id: ctx.id('patI'), clinician_id: ctx.id('plg1'), action: 'unassign' }));
  await F.passUndoWindow(ctx.app);
  expectError(await plg.get(`/api/v1/patients/${ctx.id('patI')}?tab=overview`), 404, 'E-NOT-FOUND');
  expectOk(await admin.post('/api/v1/admin/care-assignments', { patient_id: ctx.id('patI'), clinician_id: ctx.id('plg1'), action: 'assign' }));
});

// covers: T-212, UC-35, F-69, F-16, F-41, F-48, F-19, PD-11
test('T-212 [W-51] завершение наблюдения: только с подтверждением; при открытом кризисе — E-CRISIS-OPEN; после — назначения отменены, напоминания стоп, визиты отменены, кабинет только для чтения, 112 работает', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patL');
  expectOk(await p.post('/api/v1/me/messages', { text: F.CRISIS_PHRASE }));
  expectError(await doc.post(`/api/v1/patients/${ctx.id('patL')}/archive`, { reason: 'course_done', confirm: true }), 409, 'E-CRISIS-OPEN');
  ctx.app.exec(`UPDATE crisis_escalations SET status = 'handled' WHERE patient_id = ${Number(ctx.id('patL'))}`);
  const a = await F.assignTest(ctx.app, doc, ctx.id('patL'), 'gad7');
  const v = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patL')}/visits`, { starts_at: new Date(Date.now() + 9 * 86400000).toISOString(), format: 'remote' }));
  await F.passUndoWindow(ctx.app);
  expectError(await doc.post(`/api/v1/patients/${ctx.id('patL')}/archive`, { reason: 'course_done' }), 422, 'E-VALIDATION');
  expectOk(await doc.post(`/api/v1/patients/${ctx.id('patL')}/archive`, { reason: 'course_done', confirm: true }));
  assert.equal(ctx.app.query('SELECT status FROM instrument_assignments WHERE id = ?', a.id)[0].status, 'cancelled');
  assert.equal(ctx.app.query('SELECT status FROM visits WHERE id = ?', v.visit.id)[0].status, 'cancelled');
  assert.equal(ctx.app.query('SELECT count(*) n FROM reminders WHERE patient_id = ? AND active = 1', ctx.id('patL'))[0].n, 0);
  expectError(await p.post('/api/v1/me/diary', { mood: 3 }), 409, 'E-ARCHIVED');
  expectOk(await p.get('/api/v1/me/diary'));
  const help = expectOk(await p.post('/api/v1/crisis/help', { text: F.CRISIS_PHRASE, source: 'button' }));
  assert.ok(help.crisis, '«Мне нужна помощь · 112» работает в архиве');
  assert.ok(!expectOk(await doc.get('/api/v1/patients')).items.some((x) => x.id === ctx.id('patL')));
  expectError(await doc.post(`/api/v1/patients/${ctx.id('patL')}/archive`, { reason: 'course_done', confirm: true }), 409, 'E-ARCHIVED');
});

// covers: T-213, UC-35, UC-16, F-94, F-73, F-69, PD-11
test('T-213 [W-39] повторное подключение архивного: новый эпизод, история видна по новому закреплению; «надгробие» подключить нельзя', async () => {
  const admin = await ctx.as('admin1');
  expectOk(await admin.post(`/api/v1/admin/people/${ctx.id('patD')}/reconnect`, { clinician_ids: [ctx.id('psy2')] }));
  await F.passUndoWindow(ctx.app);
  const eps = ctx.app.query('SELECT ended_at FROM care_episodes WHERE patient_id = ? ORDER BY id', ctx.id('patD'));
  assert.equal(eps.length, 2);
  assert.equal(eps[1].ended_at, null, 'новый активный эпизод');
  expectOk(await (await ctx.as('psy2')).get(`/api/v1/patients/${ctx.id('patD')}?tab=overview`));
  ctx.app.exec(`UPDATE users SET status = 'tombstone', email = NULL, full_name = NULL, password_hash = NULL WHERE id = ${Number(ctx.id('patE'))}`);
  expectError(await admin.post(`/api/v1/admin/people/${ctx.id('patE')}/reconnect`, { clinician_ids: [ctx.id('psy2')] }), 409, 'E-STATUS');
});

// covers: T-214, UC-36, F-70, F-87, F-21, F-47, PD-11
test('T-214 [W-40] замещение: врач предлагает, администратор подтверждает; замещающий видит пациентов и сигналы только в период; после — доступ пропадает; пересечение — E-VALIDATION', async () => {
  const doc = await ctx.as('psy2');
  expectError(await doc.post('/api/v1/me/substitutions', { substitute_id: ctx.id('plg2'), from: day(1), to: day(5), all_patients: true }), 422, 'E-VALIDATION');
  expectError(await doc.post('/api/v1/me/substitutions', { substitute_id: ctx.id('psy3'), from: day(-5), to: day(-1), all_patients: true }), 422, 'E-VALIDATION');
  const s = expectOk(await doc.post('/api/v1/me/substitutions', { substitute_id: ctx.id('psy3'), from: day(0), to: day(3), all_patients: true }));
  const sub = await ctx.as('psy3');
  expectError(await sub.get(`/api/v1/patients/${ctx.id('patB')}?tab=overview`), 404, 'E-NOT-FOUND');
  const admin = await ctx.as('admin1');
  expectOk(await admin.post(`/api/v1/admin/substitutions/${s.id}/confirm`, {}));
  await F.passUndoWindow(ctx.app);
  expectOk(await sub.get(`/api/v1/patients/${ctx.id('patB')}?tab=overview`));
  const pb = await ctx.as('patB');
  const page = await pb.get('/app?tab=doctor', { headers: { accept: 'text/html' } });
  assert.match(page.body, /Вера Резервная|в отпуске/i, 'пациент видит «… в отпуске до …, вас ведёт …»');
  expectOk(await pb.post('/api/v1/me/messages', { text: F.CRISIS_PHRASE }));
  assert.ok(await F.crisisSignalFor(sub, ctx.id('patB')), 'замещающий получает сигналы');
  assert.ok(await F.crisisSignalFor(doc, ctx.id('patB')), 'и основной тоже');
  expectError(await doc.post('/api/v1/me/substitutions', { substitute_id: ctx.id('psy3'), from: day(1), to: day(2), all_patients: true }), 422, 'E-VALIDATION');
  await ctx.app.advanceClock(5 * 86400000);
  await ctx.app.waitJobs(10);
  expectError(await sub.get(`/api/v1/patients/${ctx.id('patB')}?tab=overview`), 404, 'E-NOT-FOUND');
  await ctx.app.advanceClock(-5 * 86400000);
});

// covers: T-215, UC-16, UC-01, F-73, F-23, S-23
test('T-215 [W-07] приглашения специалиста: код виден один раз, в списке — только статус и срок; отзыв сразу; не больше 30 в час', async () => {
  const doc = await ctx.as('plg1');
  const inv = expectOk(await doc.post('/api/v1/invites', {}));
  const list = expectOk(await doc.get('/api/v1/invites')).items.find((x) => x.id === inv.id);
  assert.ok(!list.code || list.code.length < inv.code.length, 'в списке код не показывается целиком');
  assert.ok(new Date(list.expires_at) - Date.now() <= 7 * 86400000 + 60000, 'срок 7 дней (S-23)');
  expectOk(await doc.post(`/api/v1/invites/${inv.id}/revoke`, {}));
  assert.equal(expectOk(await doc.get('/api/v1/invites')).items.find((x) => x.id === inv.id).status, 'revoked');
  let last;
  for (let i = 0; i < 30; i += 1) last = await doc.post('/api/v1/invites', {});
  expectError(last.status === 429 ? last : await doc.post('/api/v1/invites', {}), 429, 'E-RATE-LIMIT');
});
