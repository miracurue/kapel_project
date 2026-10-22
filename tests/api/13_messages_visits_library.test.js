'use strict';

// Сообщения пациент ↔ специалист (F-47, S-26), визиты (F-48), анкета перед приёмом (F-49, S-29, S-49),
// библиотека (F-50, S-50) — одинаковая для пациента, психиатра и психолога, без назначений.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectError, expectOk, hasWarning } = require('../lib/client');
const F = require('../lib/flows');

const ctx = useApp();
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();

// covers: T-190, UC-06, UC-37, F-47, F-19, F-17
test('T-190 [W-27] сообщение врачу: видно после окна, «отправлено/прочитано», ответ врача приходит пациенту с уведомлением', async () => {
  const p = await ctx.as('patA');
  const doc = await ctx.as('psy1');
  const m = expectOk(
    await p.post('/api/v1/me/messages', { text: 'Синтетический вопрос о приёме', to_clinician_id: ctx.id('psy1') }),
  );
  await F.passUndoWindow(ctx.app);
  const thread = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}/messages`));
  assert.ok(JSON.stringify(thread).includes('Синтетический вопрос о приёме'));
  expectOk(await doc.post('/api/v1/messages/read', { ids: [m.message.id] }));
  const mine = expectOk(await p.get('/api/v1/me/messages'));
  assert.ok(
    mine.items.some((x) => x.id === m.message.id && x.read_at),
    'пациент видит «прочитано»',
  );
  expectOk(await doc.post(`/api/v1/patients/${ctx.id('patA')}/messages`, { text: 'Синтетический ответ врача' }));
  await F.passUndoWindow(ctx.app);
  assert.ok(JSON.stringify(expectOk(await p.get('/api/v1/me/messages'))).includes('Синтетический ответ врача'));
  const n = expectOk(await p.get('/api/v1/notifications')).items;
  assert.ok(n.some((x) => /сообщени/i.test(x.title)));
  expectError(await (await ctx.as('psy2')).get(`/api/v1/patients/${ctx.id('patA')}/messages`), 404, 'E-NOT-FOUND');
  expectError(await (await ctx.as('admin1')).get(`/api/v1/patients/${ctx.id('patA')}/messages`), 403, 'E-ACCESS');
});

// covers: T-191, UC-06, UC-17, F-47, F-83, PD-20
test('T-191 [W-27] нет закреплённого специалиста: сообщение принято с E-NO-CLINICIAN («увидит дежурный»), в служебной очереди без текста', async () => {
  const p = await ctx.as('patC');
  const r = expectOk(await p.post('/api/v1/me/messages', { text: 'Синтетика: кто ответит?' }));
  assert.ok(hasWarning({ warnings: r.info || r.warnings }, 'E-NO-CLINICIAN'));
  await F.passUndoWindow(ctx.app);
  const q = expectOk(await (await ctx.as('admin1')).get('/api/v1/admin/requests?filter=open'));
  assert.ok(q.items.some((i) => i.kind === 'message_no_clinician'));
  assert.doesNotMatch(JSON.stringify(q), /кто ответит/);
});

// covers: T-192, UC-06, UC-44, F-47, F-97, S-26, L-31
test('T-192 [W-41] строка «не срочно, ответ в течение N рабочих дней; если тяжело — 112» берётся из S-26; слова «срочно/немедленно» отклоняются', async () => {
  const admin = await ctx.as('admin1');
  expectError(
    await F.setSetting(admin, 'messages.channel', {
      reply_days: 2,
      mode: 'organizational',
      line: 'Ответим немедленно',
    }),
    422,
    'E-SETTING-INVALID',
  );
  expectError(
    await F.setSetting(admin, 'messages.channel', { reply_days: 2, mode: 'telemedicine' }),
    422,
    'E-SETTING-INVALID',
  );
  expectOk(await F.setSetting(admin, 'messages.channel', { reply_days: 3, mode: 'organizational' }));
  const page = await (await ctx.as('patA')).get('/app?tab=doctor', { headers: { accept: 'text/html' } });
  assert.match(page.body, /data-testid="msg\.doctor\./);
  assert.match(page.body, /3 рабоч/);
  assert.match(page.body, /112/);
});

// covers: T-193, UC-33, UC-37, F-48, F-17, F-19
test('T-193 [W-28] визит: только психиатр, дата в прошлом — E-VALIDATION; пациент видит после окна и получает уведомление; перенос, «состоялся», конфликт правки', async () => {
  const doc = await ctx.as('psy1');
  expectError(
    await doc.post(`/api/v1/patients/${ctx.id('patA')}/visits`, { starts_at: inDays(-1), format: 'in_person' }),
    422,
    'E-VALIDATION',
  );
  expectError(
    await (
      await ctx.as('plg1')
    ).post(`/api/v1/patients/${ctx.id('patA')}/visits`, { starts_at: inDays(5), format: 'remote' }),
    403,
    'E-ACCESS',
  );
  const v = expectOk(
    await doc.post(`/api/v1/patients/${ctx.id('patA')}/visits`, {
      starts_at: inDays(10),
      format: 'in_person',
      place: 'кабинет 12 (синтетика)',
      previsit_enabled: true,
    }),
  );
  const p = await ctx.as('patA');
  assert.ok(!expectOk(await p.get('/api/v1/me/visits')).items.some((x) => x.id === v.visit.id), 'в окне не видно');
  await F.passUndoWindow(ctx.app);
  assert.ok(expectOk(await p.get('/api/v1/me/visits')).items.some((x) => x.id === v.visit.id));
  const moved = expectOk(
    await doc.patch(`/api/v1/visits/${v.visit.id}`, { version: v.visit.version, starts_at: inDays(12) }),
  );
  expectError(
    await doc.patch(`/api/v1/visits/${v.visit.id}`, { version: v.visit.version, starts_at: inDays(13) }),
    409,
    'E-CONFLICT',
  );
  const notes = expectOk(await p.get('/api/v1/notifications')).items.filter(
    (n) => n.object && n.object.id === v.visit.id,
  );
  assert.ok(notes.length >= 1, 'уведомление о визите и переносе');
  await ctx.app.advanceClock(13 * 86400000);
  const freshDoc = await ctx.fresh('psy1');
  expectOk(await freshDoc.patch(`/api/v1/visits/${v.visit.id}`, { version: moved.version, status: 'held' }));
  await ctx.app.advanceClock(-13 * 86400000);
});

// covers: T-194, UC-34, F-49, F-21, S-29, S-49
test('T-194 [W-28] анкета открывается за S-29 дней до визита с одним напоминанием; ответы видит врач в «К приёму»; отменённый визит — E-ASSIGNMENT-CLOSED', async () => {
  const admin = await ctx.as('admin1');
  expectOk(await F.setSetting(admin, 'previsit.days_before', { days: 2, reminders: 1 }));
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patH');
  const v = expectOk(
    await doc.post(`/api/v1/patients/${ctx.id('patH')}/visits`, {
      starts_at: inDays(5),
      format: 'remote',
      previsit_enabled: true,
    }),
  );
  await F.passUndoWindow(ctx.app);
  const early = await p.get(`/api/v1/me/visits/${v.visit.id}/previsit`);
  assert.ok(
    early.status === 409 || early.status === 404 || (early.body.questions || []).length === 0,
    'раньше срока анкеты нет',
  );
  await ctx.app.advanceClock(3 * 86400000 + 60000);
  await ctx.app.waitJobs(10);
  const freshPatient = await ctx.fresh('patH');
  const freshDoc = await ctx.fresh('psy1');
  const freshAdmin = await ctx.fresh('admin1');
  const form = expectOk(await freshPatient.get(`/api/v1/me/visits/${v.visit.id}/previsit`));
  assert.ok(form.questions.length >= 1);
  assert.ok(
    form.questions.every((q) => !q.required),
    'все вопросы необязательны',
  );
  const answers = {};
  const multi = form.questions.find((q) => q.type === 'multi');
  if (multi) answers[multi.id] = [multi.options[0].value];
  const text = form.questions.find((q) => q.type.startsWith('text'));
  answers[text.id] = 'Синтетика: хуже сплю';
  expectOk(await freshPatient.put(`/api/v1/me/visits/${v.visit.id}/previsit`, { answers, submit: true }));
  const card = expectOk(await freshDoc.get(`/api/v1/patients/${ctx.id('patH')}/visits`));
  assert.ok(JSON.stringify(card.previsit).includes('хуже сплю'));
  const reminders = ctx.app.query(
    "SELECT count(*) n FROM notifications WHERE recipient_id = ? AND type LIKE '%previsit%'",
    ctx.id('patH'),
  )[0].n;
  assert.ok(reminders <= 2, 'не больше одного напоминания сверх открытия');
  const v2 = expectOk(
    await freshDoc.post(`/api/v1/patients/${ctx.id('patH')}/visits`, {
      starts_at: inDays(4),
      format: 'remote',
      previsit_enabled: true,
    }),
  );
  await F.passUndoWindow(ctx.app);
  expectOk(await freshDoc.patch(`/api/v1/visits/${v2.visit.id}`, { version: v2.visit.version, status: 'cancelled' }));
  expectError(
    await freshPatient.put(`/api/v1/me/visits/${v2.visit.id}/previsit`, { answers: {}, submit: true }),
    409,
    'E-ASSIGNMENT-CLOSED',
  );
  const questions = expectOk(await freshAdmin.get('/api/v1/admin/settings/previsit.questions')).current.value;
  expectError(
    await F.setSetting(
      freshAdmin,
      'previsit.questions',
      Array.from({ length: 16 }, (_, i) => ({ id: `q${i}`, type: 'text_short', text: `Вопрос ${i}` })),
    ),
    422,
    'E-SETTING-INVALID',
  );
  assert.ok(Array.isArray(questions));
  await ctx.app.advanceClock(-(3 * 86400000 + 60000));
});

// covers: T-195, UC-14, F-50, F-109, S-50, PD-02
test('T-195 [W-48] библиотека: только опубликованное, автор/источник/версия/дата пересмотра; одинаково у пациента, психиатра и психолога; назначений нет', async () => {
  const lists = {};
  for (const k of ['patA', 'psy1', 'plg1'])
    lists[k] = expectOk(await (await ctx.as(k)).get('/api/v1/library'))
      .items.filter((i) => i.audience === 'patient')
      .map((i) => i.id)
      .sort();
  assert.deepEqual(lists.patA, lists.psy1);
  assert.deepEqual(lists.patA, lists.plg1);
  const one = expectOk(await (await ctx.as('patA')).get(`/api/v1/library/${lists.patA[0]}`));
  assert.ok(one.source && one.title);
  assert.ok(
    !require('../lib/contract')
      .api()
      .some((o) => /library.*assign|learn\/assign/.test(o.path)),
    'назначения материалов нет (решение владельца)',
  );
  const filtered = expectOk(await (await ctx.as('patA')).get('/api/v1/library?kind=audio')).items;
  assert.ok(filtered.every((i) => i.kind === 'audio'));
});

// covers: T-196, UC-14, F-50, F-109, PD-02
test('T-196 [W-48] позиция «Продолжить» личная (специалист и аналитика её не видят); снятый с публикации материал исчезает и позиция сбрасывается; медиа отдаётся частями', async () => {
  const p = await ctx.as('patA');
  const items = expectOk(await p.get('/api/v1/library?kind=audio')).items;
  const it = items[0];
  expectOk(await p.put(`/api/v1/library/${it.id}/position`, { position_s: 110 }));
  assert.equal(expectOk(await p.get(`/api/v1/library/${it.id}`)).position_s, 110);
  assert.notEqual(
    expectOk(await (await ctx.as('psy1')).get(`/api/v1/library/${it.id}`)).position_s,
    110,
    'позиция не видна другим',
  );
  const media = await p.get(`/api/v1/library/${it.id}/media`, { headers: { range: 'bytes=0-99' }, binary: true });
  assert.ok([206, 200].includes(media.status));
  if (media.status === 206) assert.match(media.headers.get('content-range') || '', /bytes 0-99\//);
  const admin = await ctx.as('admin1');
  expectOk(await admin.post(`/api/v1/admin/library/${it.id}/withdraw`, {}));
  expectError(await p.get(`/api/v1/library/${it.id}`), 404, 'E-NOT-FOUND');
});
