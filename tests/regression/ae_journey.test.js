'use strict';
// covers: F-30, F-32, F-45, F-65, F-66, PD-02, PD-11, UC-03; сквозной путь опроса о побочном эффекте на HTTP-уровне
// (заглушка ИИ): пациент -> карточка -> сводка в чате -> «Сигналы» -> решение -> черновик извещения; психолог -> психиатр;
// пациент без психиатра (личная запись); психиатр сам; доступы и приватность. Живая модель не вызывается.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const ctx = useApp();

const BODY = {
  symptoms: ['nausea'],
  text: 'Синтетика: тошнит по утрам после таблетки',
  started_on: '2026-10-20',
  severity: 'noticeable',
  related: 'yes',
};
const rowOf = (id) => ctx.app.query('SELECT * FROM adverse_events WHERE id=?', [id])[0];
const countAe = () => ctx.app.query('SELECT count(*) n FROM adverse_events')[0].n;
const toolNames = (call) => (call.tools || []).map((t) => t.name);

test('пациент -> карточка -> сводка -> «Сигналы» -> решение «вероятна» -> черновик извещения', async () => {
  const patient = await ctx.as('patA');
  const psy = await ctx.as('psy1');
  const { item } = await F.sertralinePrescribedAndAccepted(ctx.app, psy, patient, ctx.id('patA'));

  // 1. слово из словаря: карточка сразу, без подзапроса
  ctx.app.ai.reset();
  const first = expectOk(await F.patientAsk(patient, 'После таблетки меня тошнит по утрам'));
  assert.ok(first.ae_suggestion, 'ae_suggestion по слову из словаря');
  assert.ok(first.ae_suggestion.prefill.symptoms.includes('nausea'));
  const thread_id = first.thread.id;

  // 2. отправка записи с thread_id, один Idempotency-Key: повтор не создаёт вторую запись
  const before = countAe();
  const idem = 'journey-ae-1';
  const payload = { ...BODY, source: 'ai_chat', thread_id, med: { kind: 'plan_item', item_key: item.item_key } };
  const r = expectOk(await patient.post('/api/v1/me/adverse-events', payload, { idem }));
  assert.equal(r.ae.attached, true);
  assert.equal(r.ae.status, 'awaiting_visibility');
  const again = await patient.post('/api/v1/me/adverse-events', payload, { idem });
  assert.equal(again.status, 201, 'повтор с тем же ключом отдаёт тот же ответ');
  assert.equal(again.body.ae.id, r.ae.id);
  assert.equal(countAe(), before + 1, 'вторая запись не создана');
  assert.equal(
    ctx.app.query("SELECT count(*) n FROM ai_messages WHERE thread_id=? AND kind='ae_summary'", [thread_id])[0].n,
    1,
    'сводка записана один раз',
  );

  // 3. сводка в истории чата и в следующем запросе к модели; свободного текста жалобы в ней нет
  assert.match(r.summary.text, /Вы сообщили врачу/);
  assert.doesNotMatch(r.summary.text, /по утрам после таблетки/);
  const th = expectOk(await patient.get(`/api/v1/ai/threads/${thread_id}`));
  assert.ok(th.messages.some((m) => m.kind === 'ae_summary'));
  ctx.app.ai.reset();
  expectOk(await F.patientAsk(patient, 'Что я уже сообщил врачу?', { thread_id }));
  assert.ok(ctx.app.ai.seenText().includes('Вы сообщили врачу'), 'следующий ответ модели видит сводку');

  // 4. до конца окна отмены психиатр записи не видит; потом - в «Сигналах»
  assert.ok(!(await F.signalsOf(psy, 'kind=ae&status=all')).some((s) => s.id === r.ae.id));
  await F.passUndoWindow(ctx.app);
  assert.ok((await F.signalsOf(psy, 'kind=ae&status=all')).some((s) => s.id === r.ae.id));

  // 5. решение «вероятна» -> черновик извещения содержит препарат и симптомы
  expectOk(
    await psy.post(`/api/v1/adverse-events/${r.ae.id}/decision`, { decision: 'probable', serious: false, version: 1 }),
  );
  const notice = expectOk(await psy.get(`/api/v1/adverse-events/${r.ae.id}/notice`)).fields;
  assert.match(`${notice.trade_name} ${notice.inn}`, /сертралин|золофт/i);
  assert.match(notice.description, /Симптомы: Тошнота/);
  assert.equal(notice.onset_date, '2026-10-20');
});

test('психолог фиксирует запись -> психиатр получает уведомление и решает; психолог не видит план и НЯ в запросах к модели', async () => {
  const plg = await ctx.as('plg1');
  const psy = await ctx.as('psy1');
  const patientId = ctx.id('patA');
  ctx.app.ai.reset();
  const chat = expectOk(
    await plg.post('/api/v1/ai/clinician/messages', {
      patient_id: patientId,
      text: 'Пациент говорит, что тошнит после таблеток',
    }),
  );
  assert.deepEqual(chat.ae_offer, { prefill: {}, mode: 'to_psychiatrist' }, 'психологу предлагают передать психиатру');
  const names = toolNames(ctx.app.ai.calls()[0]);
  assert.ok(
    !names.includes('get_plan') && !names.includes('get_adverse_events'),
    'психологу инструменты плана и НЯ не предлагаются',
  );
  const r = expectOk(
    await plg.post(`/api/v1/patients/${patientId}/adverse-events`, {
      text: 'Синтетика: со слов пациента, сухость во рту',
      severity: 'mild',
      med: { name: 'таблетка от тревоги' },
      source: 'ai_chat',
      thread_id: chat.thread.id,
    }),
  );
  assert.equal(r.ae.status, 'awaiting_doctor');
  assert.equal(rowOf(r.ae.id).reported_by, ctx.id('plg1'));
  assert.ok(expectOk(await psy.get('/api/v1/notifications')).items.some((n) => n.object && n.object.id === r.ae.id));
  expectOk(await psy.post(`/api/v1/adverse-events/${r.ae.id}/decision`, { decision: 'insufficient', version: 1 }));
  assert.equal(rowOf(r.ae.id).status, 'insufficient');

  // модель психолога, даже вызвав инструмент плана или НЯ, получает отказ; состав плана в запросах не появляется
  ctx.app.ai.reset();
  ctx.app.ai.queue(
    { mode: 'tool', name: 'get_plan', arguments: {} },
    { mode: 'tool', name: 'get_adverse_events', arguments: {} },
    { mode: 'text', text: 'Данных по этой теме у меня нет.' },
  );
  expectOk(
    await plg.post('/api/v1/ai/clinician/messages', {
      patient_id: patientId,
      text: 'Какие препараты назначены и были ли побочные эффекты?',
    }),
  );
  const seen = ctx.app.ai.seenText();
  assert.doesNotMatch(seen, /сертралин|золофт|sertraline|сухость во рту|тошнота по утрам/i);
  assert.match(seen, /Такого инструмента нет/);
});

test('пациент без психиатра: запись личная, ни психиатру, ни службе; сводка честная', async () => {
  const patient = await ctx.as('patI');
  const asked = expectOk(await F.patientAsk(patient, 'У меня тошнит и кружится голова'));
  assert.ok(asked.ae_suggestion);
  const r = expectOk(
    await patient.post('/api/v1/me/adverse-events', {
      ...BODY,
      source: 'ai_chat',
      thread_id: asked.thread.id,
      med: { kind: 'other', name: 'Валерьянка' },
    }),
  );
  assert.equal(r.ae.attached, false);
  assert.equal(r.ae.status, 'saved_private');
  assert.match(r.summary.text, /не прикреплены к врачу/);
  assert.equal(ctx.app.query("SELECT count(*) n FROM service_queue WHERE kind='ae_no_psychiatrist'")[0].n, 0);
  assert.equal(
    ctx.app.query('SELECT count(*) n FROM service_queue WHERE patient_id=?', [ctx.id('patI')])[0].n,
    0,
    'службе ничего не ушло',
  );
  assert.equal(
    ctx.app.query("SELECT count(*) n FROM notifications WHERE object_id=? AND object_type='adverse_event'", [
      r.ae.id,
    ])[0].n,
    0,
    'уведомлений нет',
  );
  await F.passUndoWindow(ctx.app);
  for (const who of ['psy1', 'psy2', 'plg1', 'plg2']) {
    assert.ok(!(await F.signalsOf(await ctx.as(who))).some((s) => s.id === r.ae.id), `${who}: в сигналах нет`);
  }
  // аналитика: личная запись без передачи врачу не учитывается
  assert.equal(
    ctx.app.query("SELECT count(*) n FROM analytics_source_events WHERE metric='adverse_event' AND source_id=?", [
      String(r.ae.id),
    ])[0].n,
    0,
    'analytics_source_events',
  );
  assert.equal(
    ctx.app.query('SELECT count(*) n FROM insights_adverse WHERE report_ref=?', [r.ae.id])[0].n,
    0,
    'insights_adverse',
  );
});

test('приватность личной записи: психиатр, прикреплённый позже, не получает её ни решением, ни инструментом ИИ, ни чипом', async () => {
  const id = ctx.app.query(
    "SELECT id FROM adverse_events WHERE patient_id=? AND status='service_queue' ORDER BY id DESC",
    [ctx.id('patI')],
  )[0].id;
  const db = ctx.app.db();
  try {
    db.prepare('INSERT INTO care_assignments(patient_id,clinician_id,started_at) VALUES (?,?,?)').run(
      ctx.id('patI'),
      ctx.id('psy2'),
      '2026-10-01T00:00:00Z',
    );
  } finally {
    db.close();
  }
  const doc = await ctx.as('psy2');
  expectError(await doc.post(`/api/v1/adverse-events/${id}/decision`, { decision: 'probable', version: 1 }), 404);
  expectError(await doc.get(`/api/v1/adverse-events/${id}/notice`), 409, 'E-STATUS');
  ctx.app.ai.reset();
  ctx.app.ai.queue({ mode: 'tool', name: 'get_adverse_events', arguments: {} }, { mode: 'text', text: 'Готово.' });
  expectOk(
    await doc.post('/api/v1/ai/clinician/messages', {
      patient_id: ctx.id('patI'),
      text: 'Есть ли жалобы на побочные эффекты?',
    }),
  );
  assert.match(ctx.app.ai.seenText(), /Нежелательных явлений за этот период нет/, 'инструмент личной записи не отдаёт');
  // чип записи: ни подсказка, ни разрешение чипа личную запись не раскрывают
  const hints = JSON.stringify([
    expectOk(await doc.get(`/api/v1/context/suggestions?patient_id=${ctx.id('patI')}`)),
    expectOk(await doc.get(`/api/v1/context/search?patient_id=${ctx.id('patI')}&q=`)),
  ]);
  assert.doesNotMatch(hints, new RegExp(`"id":${id}[,}]`));
  const chat = await doc.post('/api/v1/ai/clinician/messages', {
    patient_id: ctx.id('patI'),
    text: 'Что в этой записи?',
    chips: [{ type: 'adverse_event', id }],
  });
  if (chat.status === 200 || chat.status === 201)
    assert.doesNotMatch(ctx.app.ai.seenText(), /noticeable|заметная/i, 'чип личной записи не раскрыт модели');
});

test('психиатр сам: запись сразу с решением; пациент получает уведомление; доступы закрыты', async () => {
  const psy = await ctx.as('psy1');
  const path = `/api/v1/patients/${ctx.id('patA')}/adverse-events`;
  const payload = {
    text: 'Синтетика: тремор рук',
    severity: 'severe',
    started_on: '2026-10-19',
    symptoms: ['dizzy'],
    decision: 'probable',
    serious: true,
    med: { kind: 'other', name: 'Свободный препарат' },
  };
  const r = expectOk(await psy.post(path, payload, { idem: 'journey-clin-1' }));
  const count = countAe();
  const replay = await psy.post(path, payload, { idem: 'journey-clin-1' });
  assert.equal(replay.body.ae && replay.body.ae.id, r.ae.id, 'повтор с тем же ключом отдаёт ту же запись');
  assert.equal(countAe(), count, 'повтор вторую запись не создаёт');
  assert.equal(r.ae.status, 'related_likely');
  assert.equal(r.notice_available, true);
  const row = rowOf(r.ae.id);
  assert.deepEqual(
    [row.decision_by, row.reported_by, row.psychiatrist_id],
    [ctx.id('psy1'), ctx.id('psy1'), ctx.id('psy1')],
  );
  const note = expectOk(await (await ctx.as('patA')).get('/api/v1/notifications')).items.find(
    (n) => n.object && n.object.id === r.ae.id,
  );
  assert.ok(note, 'пациент уведомлён');
  const fields = expectOk(await psy.get(`/api/v1/adverse-events/${r.ae.id}/notice`)).fields;
  assert.equal(fields.trade_name, 'Свободный препарат');

  // доступы
  const body = { text: 'Синтетика', severity: 'mild', decision: 'insufficient' };
  const before = countAe();
  expectError(await psy.post(`/api/v1/patients/${ctx.id('patB')}/adverse-events`, body), 404, 'E-NOT-FOUND');
  expectError(await (await ctx.as('patA')).post(path, body), 403, 'E-ACCESS');
  expectError(await (await ctx.as('admin1')).post(path, body), 403, 'E-ACCESS');
  expectError(
    await (
      await ctx.as('plg1')
    ).post(`/api/v1/patients/${ctx.id('patB')}/adverse-events`, { ...body, decision: undefined }),
    404,
    'E-NOT-FOUND',
  );
  expectError(await (await ctx.as('admin1')).get(`${path}/offer`), 403, 'E-ACCESS');
  // без CSRF и без Idempotency-Key запись не создаётся
  expectError(await psy.post(path, { ...body }, { csrf: false }), 403);
  const noIdem = await psy.post(path, { ...body }, { idem: false });
  assert.ok(noIdem.status >= 400, `без Idempotency-Key: ${noIdem.status}`);
  assert.equal(countAe(), before, 'отклонённые запросы записей не создали');
});

test('чужой пациент: тред другого пользователя и чужой пациент дают 404, психолог чужого пациента тоже', async () => {
  const other = await ctx.as('patB');
  const foreign = expectOk(await F.patientAsk(other, 'Здравствуйте')).thread.id;
  const before = countAe();
  expectError(
    await (await ctx.as('patA')).post('/api/v1/me/adverse-events', { ...BODY, source: 'ai_chat', thread_id: foreign }),
    404,
    'E-NOT-FOUND',
  );
  // тред врача по другому пациенту не годится как источник записи
  const psy = await ctx.as('psy1');
  const t = expectOk(
    await psy.post('/api/v1/ai/clinician/messages', { patient_id: ctx.id('patA'), text: 'Здравствуйте' }),
  ).thread.id;
  expectError(
    await psy.post(`/api/v1/patients/${ctx.id('patC')}/adverse-events`, {
      text: 'Синтетика',
      severity: 'mild',
      decision: 'insufficient',
      thread_id: t,
    }),
    404,
    'E-NOT-FOUND',
  );
  assert.equal(countAe(), before);
});

test('инструмент ИИ психиатра не показывает запись пациента, пока идёт окно отмены', async () => {
  const patient = await ctx.as('patA');
  const psy = await ctx.as('psy1');
  const r = expectOk(
    await patient.post('/api/v1/me/adverse-events', { ...BODY, text: 'Синтетика: окно отмены', symptoms: ['dizzy'] }),
  );
  const askTool = async () => {
    ctx.app.ai.reset();
    ctx.app.ai.queue(
      { mode: 'tool', name: 'get_adverse_events', arguments: { days: 7 } },
      { mode: 'text', text: 'Готово.' },
    );
    expectOk(
      await psy.post('/api/v1/ai/clinician/messages', {
        patient_id: ctx.id('patA'),
        text: 'Что с побочными эффектами за неделю?',
      }),
    );
    return ctx.app.ai.seenText();
  };
  const during = await askTool();
  assert.doesNotMatch(during, /ждёт врача|отправлено/, 'пока пациент может отменить запись, инструмент её не отдаёт');
  await F.passUndoWindow(ctx.app);
  assert.match(await askTool(), /тяжесть заметная/, 'после окна отмены запись видна');
});

test('кодов симптомов только коды: свободные слова в сводку и модель не попадают, не массив - 422; кризис в названии препарата виден', async () => {
  const patient = await ctx.as('patB');
  const thread_id = expectOk(await F.patientAsk(patient, 'Здравствуйте')).thread.id;
  const before = countAe();
  expectError(await patient.post('/api/v1/me/adverse-events', { ...BODY, symptoms: 'nausea' }), 422, 'E-VALIDATION');
  expectError(await patient.post('/api/v1/me/adverse-events', { ...BODY, symptoms: { a: 1 } }), 422, 'E-VALIDATION');
  assert.equal(countAe(), before);
  const r = expectOk(
    await patient.post('/api/v1/me/adverse-events', {
      ...BODY,
      symptoms: ['nausea', 'звоните 8 900 123-45-67', { x: 1 }],
      source: 'ai_chat',
      thread_id,
      med: { kind: 'other', name: 'Мелатонин' },
    }),
  );
  assert.deepEqual(JSON.parse(rowOf(r.ae.id).complaint_codes_json), ['nausea']);
  assert.doesNotMatch(r.summary.text, /8 900|звоните/);
  // кризисная фраза в свободном названии препарата не теряется
  const crisis = expectOk(
    await patient.post('/api/v1/me/adverse-events', { ...BODY, med: { kind: 'other', name: F.CRISIS_PHRASE } }),
  );
  assert.ok(crisis.crisis, 'карточка 112 показана');
});
