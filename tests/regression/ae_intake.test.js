'use strict';
// covers: F-45, F-65, F-66, PD-02, PD-11; опрос о побочном эффекте: запись из чата пациента, личная запись без врача,
// «ничего не принимаю», сводка в историю чата, психолог -> психиатру, психиатр с решением, доступы, правила предложения.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const ctx = useApp();

const BODY = { symptoms: ['nausea'], text: 'Синтетика: тошнота по утрам', started_on: '2026-10-20', severity: 'noticeable', related: 'yes' };
const threadOf = async (client) => expectOk(await F.patientAsk(client, 'Здравствуйте')).thread.id;
const rowOf = (id) => ctx.app.query('SELECT * FROM adverse_events WHERE id=?', [id])[0];
const messages = (threadId) => ctx.app.query('SELECT role,kind,text FROM ai_messages WHERE thread_id=? ORDER BY id', [threadId]);

test('пациент с психиатром: запись из чата уходит психиатру, сводка попадает в тред и в историю модели', async () => {
  const p = await ctx.as('patA');
  const thread_id = await threadOf(p);
  const r = expectOk(await p.post('/api/v1/me/adverse-events', { ...BODY, source: 'ai_chat', thread_id, med: { kind: 'other', name: 'Мелатонин' } }));
  assert.equal(r.ae.attached, true);
  assert.equal(r.ae.status, 'awaiting_visibility');
  assert.equal(r.summary.kind, 'ae_summary');
  assert.match(r.summary.text, /Вы сообщили врачу/);
  assert.match(r.summary.text, /Мелатонин/);
  assert.doesNotMatch(r.summary.text, /по утрам/, 'свободный текст описания в чат не копируется');
  const row = rowOf(r.ae.id);
  assert.equal(row.source, 'ai_chat');
  assert.equal(row.thread_id, thread_id);
  assert.equal(row.reported_by, ctx.id('patA'));
  assert.equal(row.med_text_enc, 'Мелатонин');
  assert.ok(row.psychiatrist_id);
  const stored = messages(thread_id).find((m) => m.kind === 'ae_summary');
  assert.equal(stored.role, 'assistant');
  // в ленте треда и в истории для модели
  const th = expectOk(await p.get(`/api/v1/ai/threads/${thread_id}`));
  assert.ok(th.messages.some((m) => m.kind === 'ae_summary'));
  ctx.app.ai.reset();
  expectOk(await F.patientAsk(p, 'Что я сообщил врачу?', { thread_id }));
  assert.ok(ctx.app.ai.seenText().includes('Вы сообщили врачу'), 'модель знает про заполненную запись');
  await F.passUndoWindow(ctx.app);
  assert.ok((await F.signalsOf(await ctx.as('psy1'), 'kind=ae&status=all')).some((s) => s.id === r.ae.id));
});

test('пациент: чужой тред и неверный med отклоняются, kind none записи не создаёт', async () => {
  const p = await ctx.as('patA');
  const foreign = await threadOf(await ctx.as('patB'));
  const before = ctx.app.query('SELECT count(*) n FROM adverse_events')[0].n;
  expectError(await p.post('/api/v1/me/adverse-events', { ...BODY, source: 'ai_chat', thread_id: foreign }), 404, 'E-NOT-FOUND');
  expectError(await p.post('/api/v1/me/adverse-events', { ...BODY, med: { kind: 'plan_item' } }), 422, 'E-VALIDATION');
  expectError(await p.post('/api/v1/me/adverse-events', { ...BODY, med: { kind: 'plan_item', item_key: 'нет-такого' } }), 422, 'E-VALIDATION');
  expectError(await p.post('/api/v1/me/adverse-events', { ...BODY, med: { kind: 'other' } }), 422, 'E-VALIDATION');
  const thread_id = await threadOf(p);
  const none = expectOk(await p.post('/api/v1/me/adverse-events', { ...BODY, source: 'ai_chat', thread_id, med: { kind: 'none' } }));
  assert.equal(none.not_adverse, true);
  assert.equal(none.ae, undefined);
  assert.equal(ctx.app.query('SELECT count(*) n FROM adverse_events')[0].n, before);
  assert.ok(!messages(thread_id).some((m) => m.kind === 'ae_summary'));
});

test('пациент без психиатра (только психолог): запись личная, службе и врачам не уходит, сводка в чате честная', async () => {
  const p = await ctx.as('patI');
  const thread_id = await threadOf(p);
  const r = expectOk(await p.post('/api/v1/me/adverse-events', { ...BODY, source: 'ai_chat', thread_id, med: { kind: 'other', name: 'Валерьянка' } }));
  assert.equal(r.ae.attached, false);
  assert.equal(r.ae.status, 'saved_private');
  assert.match(r.summary.text, /не прикреплены к врачу/);
  assert.match(r.summary.text, /расскажите ему о симптомах на следующей встрече/);
  assert.equal(ctx.app.query("SELECT count(*) n FROM service_queue WHERE kind='ae_no_psychiatrist'")[0].n, 0);
  assert.equal(rowOf(r.ae.id).psychiatrist_id, null);
  await F.passUndoWindow(ctx.app);
  const mine = expectOk(await p.get('/api/v1/me/adverse-events')).items.find((x) => x.id === r.ae.id);
  assert.deepEqual([mine.status, mine.attached], ['saved_private', false]);
  for (const who of ['psy1', 'psy2', 'plg1']) {
    assert.ok(!(await F.signalsOf(await ctx.as(who), 'kind=all&status=all')).some((s) => s.id === r.ae.id), `${who} записи не видит`);
  }
  // и решение по такой записи принять нельзя, даже зная номер
  const psy = await ctx.as('psy1');
  expectError(await psy.post(`/api/v1/adverse-events/${r.ae.id}/decision`, { decision: 'probable' }), 404);
});

test('правила предложения: пациент всегда; психиатр и психолог только при действующем препарате; психолог ещё и при психиатре', async () => {
  const psy = await ctx.as('psy1');
  const plg = await ctx.as('plg1');
  const offer = async (c, key) => expectOk(await c.get(`/api/v1/patients/${ctx.id(key)}/adverse-events/offer`));
  assert.deepEqual(await offer(psy, 'patA'), { offer: false, can_report: true, mode: 'decision' });
  assert.deepEqual(await offer(plg, 'patA'), { offer: false, can_report: true, mode: 'to_psychiatrist' });
  await F.sertralinePrescribedAndAccepted(ctx.app, psy, await ctx.as('patA'), ctx.id('patA'));
  assert.equal((await offer(psy, 'patA')).offer, true);
  assert.equal((await offer(plg, 'patA')).offer, true);
  // у patI нет психиатра: психологу не предлагаем и записать нельзя
  assert.deepEqual(await offer(plg, 'patI'), { offer: false, can_report: false, mode: 'to_psychiatrist' });
  // состав плана психологу не раскрывается
  assert.doesNotMatch(JSON.stringify(await offer(plg, 'patA')), /сертралин|50/i);
  expectError(await (await ctx.as('patA')).get(`/api/v1/patients/${ctx.id('patA')}/adverse-events/offer`), 403, 'E-ACCESS');
  expectError(await psy.get(`/api/v1/patients/${ctx.id('patB')}/adverse-events/offer`), 404, 'E-NOT-FOUND');
});

test('психолог: запись уходит психиатру пациента ожидающей; без психиатра 409; плана не касается', async () => {
  const plg = await ctx.as('plg1');
  const thread = expectOk(await plg.post('/api/v1/ai/clinician/messages', { patient_id: ctx.id('patA'), text: 'Здравствуйте' })).thread.id;
  const body = { text: 'Синтетика: жалуется на сухость во рту', severity: 'mild', started_on: '2026-10-21', med: { name: 'сертралин, со слов пациента' }, source: 'ai_chat', thread_id: thread };
  expectError(await plg.post(`/api/v1/patients/${ctx.id('patA')}/adverse-events`, { ...body, med: { item_key: 'x' } }), 422, 'E-VALIDATION');
  expectError(await plg.post(`/api/v1/patients/${ctx.id('patA')}/adverse-events`, { ...body, decision: 'probable' }), 422, 'E-VALIDATION');
  expectError(await plg.post(`/api/v1/patients/${ctx.id('patA')}/adverse-events`, { ...body, thread_id: 999999 }), 404, 'E-NOT-FOUND');
  const r = expectOk(await plg.post(`/api/v1/patients/${ctx.id('patA')}/adverse-events`, body));
  assert.equal(r.ae.status, 'awaiting_doctor');
  assert.equal(r.notice_available, false);
  assert.equal(r.summary.kind, 'ae_summary');
  const row = rowOf(r.ae.id);
  assert.equal(row.reported_by, ctx.id('plg1'));
  assert.equal(row.psychiatrist_id, ctx.id('psy1'));
  assert.equal(row.med_text_enc, 'сертралин, со слов пациента');
  assert.equal(row.item_key, null);
  const psy = await ctx.as('psy1');
  assert.ok((await F.signalsOf(psy, 'kind=ae&status=all')).some((s) => s.id === r.ae.id));
  const note = expectOk(await psy.get('/api/v1/notifications')).items.find((n) => n.object && n.object.id === r.ae.id);
  assert.ok(note, 'психиатру ушло уведомление');
  assert.ok(!(await F.signalsOf(plg, 'kind=all&status=all')).some((s) => s.id === r.ae.id), 'психолог НЯ в сигналах не видит');
  expectError(await plg.post(`/api/v1/patients/${ctx.id('patI')}/adverse-events`, { text: 'Синтетика', severity: 'mild', med: { name: 'x' } }), 409, 'E-NO-PSYCHIATRIST');
});

test('психиатр: запись сразу с решением, «вероятна» открывает черновик извещения с данными опроса', async () => {
  const psy = await ctx.as('psy1');
  const path = `/api/v1/patients/${ctx.id('patA')}/adverse-events`;
  const base = { text: 'Синтетика: тремор рук', severity: 'severe', started_on: '2026-10-19', symptoms: ['dizzy'] };
  expectError(await psy.post(path, base), 422, 'E-VALIDATION');
  expectError(await psy.post(path, { ...base, decision: 'probable', med: { kind: 'none' } }), 422, 'E-VALIDATION');
  const item = expectOk(await (await ctx.as('patA')).get('/api/v1/me/meds')).plan_items[0];
  const thread = expectOk(await psy.post('/api/v1/ai/clinician/messages', { patient_id: ctx.id('patA'), text: 'Здравствуйте' })).thread.id;
  const r = expectOk(await psy.post(path, { ...base, decision: 'probable', serious: true, source: 'ai_chat', thread_id: thread, med: { kind: 'plan_item', item_key: item.item_key } }));
  assert.equal(r.ae.status, 'related_likely');
  assert.equal(r.notice_available, true);
  assert.match(r.summary.text, /Оценка врача: связь вероятна/);
  const row = rowOf(r.ae.id);
  assert.deepEqual([row.decision_by, row.reported_by, row.serious, row.source], [ctx.id('psy1'), ctx.id('psy1'), 1, 'ai_chat']);
  const notice = expectOk(await psy.get(`/api/v1/adverse-events/${r.ae.id}/notice`));
  assert.equal(notice.fields.onset_date, '2026-10-19');
  assert.match(notice.fields.description, /тремор рук/);
  assert.match(notice.fields.trade_name, /./);
  const other = expectOk(await psy.post(path, { ...base, decision: 'unrelated', med: { kind: 'other', name: 'Свободный препарат' } }));
  assert.equal(other.ae.status, 'not_related');
  assert.equal(other.notice_available, false);
  const free = expectOk(await psy.post(path, { ...base, decision: 'probable', med: { kind: 'other', name: 'Свободный препарат' } }));
  const fields = expectOk(await psy.get(`/api/v1/adverse-events/${free.ae.id}/notice`)).fields;
  assert.equal(fields.trade_name, 'Свободный препарат');
  assert.match(fields.description, /Симптомы: Головокружение/);
});

test('доступы: чужой пациент 404, пациент и админ не вызывают врачебный эндпоинт', async () => {
  const body = { text: 'Синтетика', severity: 'mild', decision: 'insufficient' };
  const before = ctx.app.query('SELECT count(*) n FROM adverse_events')[0].n;
  expectError(await (await ctx.as('psy1')).post(`/api/v1/patients/${ctx.id('patB')}/adverse-events`, body), 404, 'E-NOT-FOUND');
  expectError(await (await ctx.as('plg1')).post(`/api/v1/patients/${ctx.id('patB')}/adverse-events`, body), 404, 'E-NOT-FOUND');
  expectError(await (await ctx.as('patA')).post(`/api/v1/patients/${ctx.id('patA')}/adverse-events`, body), 403, 'E-ACCESS');
  expectError(await (await ctx.as('admin1')).post(`/api/v1/patients/${ctx.id('patA')}/adverse-events`, body), 403, 'E-ACCESS');
  assert.equal(ctx.app.query('SELECT count(*) n FROM adverse_events')[0].n, before);
});
