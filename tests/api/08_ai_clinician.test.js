'use strict';

// ИИ специалиста: чат с выбранным закреплённым пациентом (F-32), черновик документа (F-33), гипотезы (F-34),
// разбор фразы врача (F-35); псевдонимизация и подстановка (F-80); открепление (PD-11); назначения S-03…S-07.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectError, expectOk, hasWarning } = require('../lib/client');
const F = require('../lib/flows');

const ctx = useApp();

// covers: T-130, UC-14, F-32, F-13, F-80, PD-14, PD-15
test('T-130 [W-35] чат специалиста: без чипов объектов модель знает только #PERSON-1#; ответ показан с подставленным именем; пометка ИИ', async () => {
  const doc = await ctx.as('psy1');
  ctx.app.ai.reset();
  ctx.app.ai.queue({ mode: 'text', text: 'По #PERSON-1# данных не прикреплено. Это черновик для проверки.' });
  const r = expectOk(await doc.post('/api/v1/ai/clinician/messages', { patient_id: ctx.id('patA'), text: 'Что изменилось за 2 недели?', chips: [{ type: 'patient', id: ctx.id('patA') }] }));
  const seen = ctx.app.ai.seenText();
  assert.ok(seen.includes('#PERSON-1#'));
  assert.ok(!seen.includes('Марина') && !seen.includes('Тестова') && !seen.includes(`"id":${ctx.id('patA')}`), 'ни имени, ни ID пациента в запросе');
  assert.ok(r.reply.text.includes('Марина Тестова'), 'врачу с доступом показано настоящее имя');
  assert.equal(r.reply.ai_generated, true);
  assert.equal(ctx.app.ai.calls().at(-1).purpose, 'clinician_chat');
});

// covers: T-131, UC-14, F-32, F-13, F-11, PD-02, PD-11
test('T-131 [W-35] чип незакреплённого пациента — отказ без вызова модели; ИИ-согласие пациента для ИИ специалиста не нужно', async () => {
  const doc = await ctx.as('psy1');
  ctx.app.ai.reset();
  const r = await doc.post('/api/v1/ai/clinician/messages', { patient_id: ctx.id('patB'), text: 'Сводка', chips: [{ type: 'patient', id: ctx.id('patB') }] });
  assert.ok([404, 409].includes(r.status));
  assert.ok(['E-NOT-FOUND', 'E-CONTEXT-REJECTED'].includes(r.body.error.code));
  assert.equal(ctx.app.ai.calls().length, 0);
  expectOk(await doc.post('/api/v1/ai/clinician/messages', { patient_id: ctx.id('patG'), text: 'Сводка по пациенту без ИИ-согласия', chips: [{ type: 'patient', id: ctx.id('patG') }] }));
});

// covers: T-132, UC-14, F-32, F-13, PD-14, PD-16
test('T-132 [W-35] прикреплённый результат теста уходит в модель после псевдонимизации; пациентский ИИ-чат и сообщения не прикрепляются никем', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patA');
  const a = await F.assignTest(ctx.app, doc, ctx.id('patA'), 'gad7');
  const res = expectOk(await F.completeTest(p, a.id));
  const chat = expectOk(await F.patientAsk(p, 'Синтетический личный вопрос помощнику'));
  ctx.app.ai.reset();
  expectOk(await doc.post('/api/v1/ai/clinician/messages', { patient_id: ctx.id('patA'), text: 'Прокомментируй результат', chips: [{ type: 'patient', id: ctx.id('patA') }, { type: 'result', id: res.id }] }));
  assert.ok(ctx.app.ai.seenText().includes(String(res.score)) || /gad|тревог/i.test(ctx.app.ai.seenText()), 'данные результата переданы');
  assert.ok(!ctx.app.ai.seenText().includes('Синтетический личный вопрос помощнику'), 'пациентский ИИ-чат не уходит специалисту');
  void chat;
});

// covers: T-133, UC-14, F-28, F-32, F-93, PD-11
test('T-133 [W-35] после открепления старый тред специалиста по пациенту недоступен (404), значения не раскрываются', async () => {
  const doc = await ctx.as('psy1');
  const r = expectOk(await doc.post('/api/v1/ai/clinician/messages', { patient_id: ctx.id('patH'), text: 'Сводка по Хасану', chips: [{ type: 'patient', id: ctx.id('patH') }] }));
  ctx.app.exec(`UPDATE care_assignments SET ended_at = '2026-10-17T00:00:00Z', end_reason = 'admin' WHERE patient_id = ${Number(ctx.id('patH'))} AND clinician_id = ${Number(ctx.id('psy1'))} AND ended_at IS NULL`);
  expectError(await doc.get(`/api/v1/ai/threads/${r.thread.id}`), 404, 'E-NOT-FOUND');
  expectError(await doc.get(`/api/v1/ai/threads/${r.thread.id}/export?format=txt`), 404, 'E-NOT-FOUND');
  ctx.app.exec(`UPDATE care_assignments SET ended_at = NULL, end_reason = NULL WHERE patient_id = ${Number(ctx.id('patH'))} AND clinician_id = ${Number(ctx.id('psy1'))}`);
});

// covers: T-134, UC-14, UC-20, F-33, F-67, F-80, PD-15, S-04, S-10
test('T-134 [W-35] черновик документа от ИИ: разделы со ссылками на записи, «нет данных» вместо выдумки, пометка ИИ; экспорт DOCX/PDF/TXT с настоящими значениями', async () => {
  const doc = await ctx.as('psy1');
  ctx.app.ai.queue({ mode: 'text', text: 'Пациент #PERSON-1# отмечает улучшение сна. Неизвестная метка #PHONE-77#.' });
  const d = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patA')}/documents`, { type: 'visit_summary', period: { from: '2026-10-01', to: '2026-10-31' }, use_ai: true }));
  assert.equal(d.status, 'draft');
  assert.equal(d.ai_generated, true);
  assert.ok(d.unknown_keys >= 1, 'неизвестные метки посчитаны');
  assert.equal(ctx.app.ai.calls().at(-1).purpose, 'document_draft');
  for (const format of ['txt', 'docx', 'pdf']) {
    const f = await doc.get(`/api/v1/documents/${d.id}/export?format=${format}`, { binary: true });
    assert.equal(f.status, 200, `экспорт ${format}`);
    const disp = f.headers.get('content-disposition') || '';
    assert.doesNotMatch(disp, /Марина|Тестова/i, 'имя файла без ФИО');
    if (format === 'txt') {
      const text = f.body.toString('utf8');
      assert.ok(text.includes('Марина Тестова'), 'в файле подставлено имя');
      assert.ok(!text.includes('#PERSON-1#'), 'в файле нет ключей пациента');
      assert.match(text, /\[#PHONE-77#/, 'неизвестная метка — в квадратных скобках с пометкой');
      assert.match(text, /подготовлен ИИ/i, 'пометка ИИ сохраняется в экспорте (L-26)');
    }
  }
  const row = ctx.app.query('SELECT * FROM patient_document_versions WHERE document_id = ? ORDER BY id DESC LIMIT 1', d.id)[0];
  assert.ok(!JSON.stringify(row).includes('Марина'), 'в базе ИИ-текст хранится с ключами');
  const log = ctx.app.query('SELECT count(*) n FROM export_log')[0].n;
  assert.ok(log >= 3, 'каждый экспорт — в журнал выгрузок');
});

// covers: T-135, UC-20, F-33, F-26
test('T-135 [W-35] ИИ не ответил (таймаут) — черновик всё равно создаётся из данных без связного текста, с предупреждением', async () => {
  const doc = await ctx.as('psy1');
  ctx.app.ai.queue({ mode: 'timeout' }, { mode: 'timeout' });
  const r = await doc.post(`/api/v1/patients/${ctx.id('patA')}/documents`, { type: 'dynamics', period: { from: '2026-10-01', to: '2026-10-31' }, use_ai: true });
  const d = expectOk(r, 201);
  assert.ok(hasWarning(d, 'E-AI-TIMEOUT') || hasWarning(d, 'E-AI-UNAVAILABLE'), '«Текст ИИ не получен, данные подставлены»');
});

// covers: T-136, UC-31, F-34, F-26, S-05, S-11
test('T-136 [W-35] гипотезы: проверка схемы, ссылки вне контекста вырезаны, пометка «на экспертной проверке»; психологу 403; выключатель — E-HINTS-OFF', async () => {
  const doc = await ctx.as('psy1');
  ctx.app.ai.queue({ mode: 'tool', name: 'diagnostic_hints', arguments: { hypotheses: [{ text: 'Синтетическая гипотеза А', for: [{ type: 'result', id: 999999 }], against: [], missing: ['сон'], somatic: [], questions: [], sources: ['STAND-IN'] }] } });
  const h = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patA')}/hints`, { chips: [{ type: 'patient', id: ctx.id('patA') }] }));
  assert.equal(h.ai_generated, true);
  assert.ok(!JSON.stringify(h).includes('999999'), 'ссылка на объект вне контекста вырезана');
  ctx.app.ai.queue({ mode: 'text', text: 'не json' });
  expectError(await doc.post(`/api/v1/patients/${ctx.id('patA')}/hints`, { chips: [] }), 502, 'E-AI-SCHEMA');
  expectError(await (await ctx.as('plg1')).post(`/api/v1/patients/${ctx.id('patA')}/hints`, { chips: [] }), 403, 'E-ACCESS');
  expectOk(await doc.patch('/api/v1/me/prefs', { hints_enabled: false }));
  expectError(await doc.post(`/api/v1/patients/${ctx.id('patA')}/hints`, { chips: [] }), 403, 'E-HINTS-OFF');
  expectOk(await doc.patch('/api/v1/me/prefs', { hints_enabled: true }));
  const marks = expectOk(await doc.patch(`/api/v1/hints/${h.id}`, { marks: [{ index: 0, mark: 'rejected' }] }));
  assert.ok(marks.ok);
  const card = expectOk(await doc.get(`/api/v1/patients/${ctx.id('patA')}?tab=overview`));
  assert.ok(!JSON.stringify(card).includes('Синтетическая гипотеза А'), 'в карточку автоматически ничего не пишется');
});

// covers: T-137, UC-10, UC-12, UC-33, F-35, F-121, F-76, S-07, S-13
test('T-137 [W-18] разбор фразы врача правилами: МНН, доза, время, срок; торговое имя → МНН с подсказкой; визит; у психолога нет лекарств', async () => {
  const doc = await ctx.as('psy1');
  const plan = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patA')}/parse`, { target: 'plan_item', phrase: 'сертралин 75 мг утром, 4 недели' }));
  assert.equal(plan.draft.inn_name.toLowerCase(), 'сертралин');
  assert.equal(plan.draft.dose, 75);
  assert.equal(plan.draft.unit, 'мг');
  assert.deepEqual(plan.draft.times, ['утро']);
  const brand = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patA')}/parse`, { target: 'plan_item', phrase: 'золофт 50 мг на ночь' }));
  assert.equal(brand.draft.inn_name.toLowerCase(), 'сертралин', 'торговое наименование заменено своим МНН');
  assert.ok(!('product_id' in brand.draft) && !('trade_name' in brand.draft), 'врач торговое наименование не назначает');
  const visit = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patA')}/parse`, { target: 'visit', phrase: 'визит 24.12 14:30 очно' }));
  assert.equal(visit.draft.format, 'in_person');
  const incomplete = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patA')}/parse`, { target: 'plan_item', phrase: 'сертралин утром' }));
  assert.ok(incomplete.missing.includes('dose'), 'пустое поле подсвечено, доза не подставлена сервисом');
  const plg = await ctx.as('plg1');
  expectError(await plg.post(`/api/v1/patients/${ctx.id('patA')}/parse`, { target: 'plan_item', phrase: 'сертралин 50 мг' }), 403, 'E-ACCESS');
});

// covers: T-138, F-35, F-26, S-07
test('T-138 [W-36] модель order_parse дополняет правила; при таймауте — черновик из правил; ответ модели проверяется (МНН из справочника, дата не в прошлом)', async () => {
  const doc = await ctx.as('psy1');
  ctx.app.ai.queue({ mode: 'tool', name: 'order_parse', arguments: { inn_name: 'несуществующинмаб', dose: 50, unit: 'мг', times: ['утро'] } });
  const bad = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patA')}/parse`, { target: 'plan_item', phrase: 'то же самое, что и в прошлый раз, но утром' }));
  assert.ok(!bad.draft.inn_id, 'МНН, которого нет в справочнике, не принят из ответа модели');
  // ответ модели с корректными полями принимается: разбираются аргументы функции order_parse, а не весь результат шлюза
  ctx.app.ai.queue({ mode: 'tool', name: 'order_parse', arguments: { dose: 50, unit: 'мг', times: ['утро'] } });
  const good = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patA')}/parse`, { target: 'plan_item', phrase: 'сертралин как обычно' }));
  assert.equal(good.draft.dose, 50);
  assert.deepEqual(good.draft.times, ['утро']);
  assert.deepEqual(good.missing, []);
  assert.deepEqual(ctx.app.ai.calls().at(-1).tools.map((t) => t.name), ['order_parse'], 'в модель ушла схема функции');
  ctx.app.ai.queue({ mode: 'timeout' });
  const t0 = Date.now();
  const slow = expectOk(await doc.post(`/api/v1/patients/${ctx.id('patA')}/parse`, { target: 'plan_item', phrase: 'сертралин как обычно' }));
  assert.ok(Date.now() - t0 < 15000, 'таймаут 10 с');
  assert.equal(slow.draft.inn_name.toLowerCase(), 'сертралин', 'черновик из правил');
});

// covers: T-139, UC-44, F-100, F-26, S-03, S-04, S-05, S-06, S-07, S-09, S-10, S-11, S-12, S-13, M-19
test('T-139 [W-42] привязки и промпты каждого назначения: смена модели S-03…S-07 и версии промпта S-09…S-13 видна в следующем вызове', async () => {
  const admin = await ctx.as('admin1');
  const m = expectOk(await admin.post('/api/v1/admin/ai/models', { name: 'Заглушка В (тест)', adapter: 'local_stub', model_id: 'stub-c-t13', location: 'our_server', license_url: 'https://example.test/license', law_243_status: 'unknown', enabled: true, params: { timeout_s: 30 }, supports_tools: true }));
  const bindings = expectOk(await admin.get('/api/v1/admin/ai/bindings')).items;
  const purposes = ['clinician_chat', 'document_draft', 'diagnostic_hints', 'ae_extraction', 'order_parse'];
  for (const purpose of purposes) {
    const b = bindings.find((x) => x.purpose === purpose);
    expectOk(await admin.put(`/api/v1/admin/ai/bindings/${purpose}`, { primary_model_id: m.id, fallback_model_id: b.primary_model_id, base_version: b.version, comment: 'тест' }));
    const key = purpose === 'document_draft' ? 'document_draft.visit_summary' : purpose;
    const vs = expectOk(await admin.get(`/api/v1/admin/ai/prompts/${key}/versions`));
    const active = vs.items.find((v) => v.active);
    const nv = expectOk(await admin.post(`/api/v1/admin/ai/prompts/${key}/versions`, { text: `${active.text}\nМАРКЕР-${purpose}`, comment: 'тест' }));
    expectOk(await admin.post(`/api/v1/admin/ai/prompts/${key}/versions/${nv.version}/activate`, { comment: 'тест без прогона' }));
  }
  const doc = await ctx.as('psy1');
  ctx.app.ai.reset();
  ctx.app.ai.setDefault({ mode: 'text', text: 'Синтетика' });
  await doc.post('/api/v1/ai/clinician/messages', { patient_id: ctx.id('patA'), text: 'Сводка', chips: [{ type: 'patient', id: ctx.id('patA') }] });
  await doc.post(`/api/v1/patients/${ctx.id('patA')}/documents`, { type: 'visit_summary', use_ai: true });
  await doc.post(`/api/v1/patients/${ctx.id('patA')}/hints`, { chips: [] });
  await doc.post(`/api/v1/patients/${ctx.id('patA')}/parse`, { target: 'plan_item', phrase: 'то, что обсуждали' });
  await (await ctx.as('patA')).post('/api/v1/ai/patient/messages', { text: 'Кружится голова, синтетика' });
  for (const purpose of ['clinician_chat', 'document_draft', 'diagnostic_hints', 'order_parse']) {
    const c = ctx.app.ai.callsFor(purpose).at(-1);
    assert.ok(c, `вызов ${purpose}`);
    assert.equal(c.model, 'stub-c-t13', `${purpose}: новая модель`);
    assert.ok(c.system.includes(`МАРКЕР-${purpose}`), `${purpose}: новая версия промпта`);
  }
});

// covers: F-32
test('чат специалиста без пациента: new_thread открывает новый тред, thread_id дописывает в указанный, чужой/неподходящий thread_id игнорируется', async () => {
  const doc = await ctx.as('psy1');
  ctx.app.ai.reset();
  ctx.app.ai.setDefault({ mode: 'text', text: 'Синтетика' });
  const first = expectOk(await doc.post('/api/v1/ai/clinician/messages', { text: 'Первый вопрос без пациента', chips: [] }));
  const second = expectOk(await doc.post('/api/v1/ai/clinician/messages', { text: 'Второй вопрос', chips: [], new_thread: true }));
  assert.notEqual(second.thread.id, first.thread.id, 'new_thread создаёт новый тред');
  const back = expectOk(await doc.post('/api/v1/ai/clinician/messages', { text: 'Вернёмся к первому', chips: [], thread_id: first.thread.id }));
  assert.equal(back.thread.id, first.thread.id, 'thread_id дописывает в указанный тред');
  const plain = expectOk(await doc.post('/api/v1/ai/clinician/messages', { text: 'Без указаний', chips: [] }));
  assert.equal(plain.thread.id, second.thread.id, 'без указаний — последний тред, как раньше');
  const other = expectOk(await doc.post('/api/v1/ai/clinician/messages', { patient_id: ctx.id('patA'), text: 'Про пациента', chips: [{ type: 'patient', id: ctx.id('patA') }], thread_id: first.thread.id }));
  assert.notEqual(other.thread.id, first.thread.id, 'тред без пациента не подменяет тред пациента');
});
