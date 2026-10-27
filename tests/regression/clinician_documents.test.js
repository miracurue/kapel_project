'use strict';
// Документы специалиста по пациенту: извещение о нежелательной реакции (шаблон b-roszdravnadzor).
// covers: F-66, PD-02; доступы, «Готово» неизменяемо, конфликт версий, автозаполнение, исправленная версия.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const ctx = useApp();

const KEY = 'b-roszdravnadzor';
const q = (sql, ...args) => ctx.app.query(sql, ...args);
let plan = null;

// Запись о НЯ «вероятна» у patA на препарат из плана; возвращает id записи.
async function relatedAe() {
  const psy = await ctx.as('psy1');
  if (!plan) {
    const p = await ctx.as('patA');
    const sertraline = await F.innId(psy, 'сертралин');
    const other = await F.innId(psy, 'эсциталопрам');
    await F.publishPlan(ctx.app, psy, ctx.id('patA'), [
      { inn_id: sertraline, dose: 50, unit: 'мг', times: ['утро'] },
      { inn_id: other, dose: 10, unit: 'мг', times: ['вечер'] },
    ]);
    plan = expectOk(await p.get('/api/v1/me/meds')).plan_items;
    const product = await F.productOf(p, sertraline, 'Золофт');
    expectOk(
      await p.post(`/api/v1/me/plan-items/${encodeURIComponent(plan[0].item_key)}/accept`, { product_id: product.id }),
    );
  }
  const item = plan[0];
  const r = expectOk(
    await psy.post(`/api/v1/patients/${ctx.id('patA')}/adverse-events`, {
      text: 'Синтетика: тремор рук',
      severity: 'severe',
      started_on: '2026-10-19',
      symptoms: ['dizzy'],
      decision: 'probable',
      med: { kind: 'plan_item', item_key: item.item_key },
    }),
  );
  return r.ae.id;
}
const create = async (client, body) =>
  client.post('/work/api/documents', { template_key: KEY, patient_id: ctx.id('patA'), ...body });
const complete = (fields) => ({
  ...fields,
  patient_code: fields.patient_code || 'П-1',
  suspect_drugs:
    fields.suspect_drugs && fields.suspect_drugs.length ? fields.suspect_drugs : [{ trade_name: 'Препарат' }],
  description: fields.description || 'Описание',
  region: 'Москва',
  contact: fields.contact || 'a@b.test',
});

test('шаблон извещения есть у психиатра с типом form, у психолога его нет', async () => {
  const psy = expectOk(await (await ctx.as('psy1')).get('/work/api/templates'));
  const tpl = psy.builtin.find((t) => t.id === KEY);
  assert.equal(tpl.kind, 'form');
  assert.ok(psy.builtin.filter((t) => t.id !== KEY).every((t) => t.kind === 'text'));
  const plg = expectOk(await (await ctx.as('plg1')).get('/work/api/templates'));
  assert.ok(!plg.builtin.some((t) => t.id === KEY));
});

test('доступы: психолог, пациент, гость — отказ; чужой пациент и без закрепления — 404; CSRF обязателен', async () => {
  expectError(await (await ctx.as('plg1')).get('/work/api/documents'), 403, 'E-ACCESS');
  expectError(await create(await ctx.as('plg1'), {}), 403, 'E-ACCESS');
  expectError(await (await ctx.as('patA')).get('/work/api/documents'), 403, 'E-ACCESS');
  expectError(await ctx.guest().get('/work/api/documents'), 401, 'E-SESSION-EXPIRED');
  const psy = await ctx.as('psy1');
  expectError(await create(psy, { patient_id: ctx.id('patB') }), 404, 'E-NOT-FOUND');
  expectError(await create(psy, { patient_id: ctx.id('patC') }), 404, 'E-NOT-FOUND');
  expectError(
    await psy.post('/work/api/documents', { template_key: KEY, patient_id: ctx.id('patA') }, { csrf: false }),
    403,
    'E-CSRF',
  );
  expectError(await create(psy, { template_key: 'нет-такого' }), 422, 'E-VALIDATION');
  expectError(await create(psy, { patient_id: 'x' }), 422, 'E-VALIDATION');
});

test('автозаполнение из карточки, плана и записи о НЯ; неизвестное остаётся пустым', async () => {
  const psy = await ctx.as('psy1');
  const aeId = await relatedAe();
  const made = expectOk(await create(psy, { ae_id: aeId }), 201).document;
  assert.equal(made.status, 'draft');
  assert.equal(made.version, 1);
  assert.equal(made.kind, 'form');
  assert.equal(made.ae_id, aeId);
  const f = made.fields;
  const user = q('SELECT service_no,sex,age_band FROM users WHERE id=?', ctx.id('patA'))[0];
  assert.equal(f.patient_code, user.service_no);
  assert.equal(f.sex, user.sex === 'f' || user.sex === 'm' ? user.sex : '');
  assert.equal(f.report_type, 'primary');
  assert.equal(f.reaction_started_on, '2026-10-19');
  assert.match(f.description, /тремор рук/);
  assert.match(f.description, /Головокружение/);
  assert.ok(f.suspect_drugs.length === 1 && f.suspect_drugs[0].trade_name, 'подозреваемый препарат из плана');
  assert.ok(f.other_drugs.length <= 5 && !f.other_drugs.some((d) => d.trade_name === f.suspect_drugs[0].trade_name));
  assert.equal(f.reporter_name, 'Анна Синтетикова');
  assert.equal(f.contact, 'psy1@cc.example.test');
  assert.equal(f.report_date, new Date().toISOString().slice(0, 10));
  assert.ok(!f.region && !f.weight_kg && !f.reporter_position, 'не выдумываем регион, вес, должность');
  assert.ok(!f.suspect_drugs[0].batch, 'серия не выдумывается');
  assert.ok(made.missing.includes('region'));
  assert.equal(made.complete, false);
  // без записи о НЯ: препараты плана — «прочие», подозреваемых нет
  const bare = expectOk(await create(psy, {}), 201).document;
  assert.equal(bare.ae_id, null);
  assert.deepEqual(bare.fields.suspect_drugs, []);
  assert.equal(bare.fields.description, '');
  // поля в базе зашифрованы
  const raw = q('SELECT fields_enc FROM clinician_documents WHERE id=?', made.id)[0].fields_enc;
  assert.match(raw, /^v1:/);
  assert.ok(!raw.includes('тремор'));
});

test('запись о НЯ: только своего пациента и только «связь вероятна»', async () => {
  const psy = await ctx.as('psy1');
  const other = expectOk(
    await (
      await ctx.as('psy2')
    ).post(`/api/v1/patients/${ctx.id('patB')}/adverse-events`, {
      text: 'Синтетика',
      severity: 'mild',
      decision: 'probable',
      med: { kind: 'other', name: 'Х' },
    }),
  ).ae.id;
  expectError(await create(psy, { ae_id: other }), 404, 'E-NOT-FOUND');
  const unrelated = expectOk(
    await psy.post(`/api/v1/patients/${ctx.id('patA')}/adverse-events`, {
      text: 'Синтетика',
      severity: 'mild',
      decision: 'unrelated',
      med: { kind: 'other', name: 'Y' },
    }),
  ).ae.id;
  expectError(await create(psy, { ae_id: unrelated }), 409, 'E-STATUS');
});

test('черновик: сохранение, конфликт версий; чужой врач видит 404', async () => {
  const psy = await ctx.as('psy1');
  const d = expectOk(await create(psy, {}), 201).document;
  const saved = expectOk(
    await psy.put(`/work/api/documents/${d.id}`, { version: 1, fields: { ...d.fields, region: 'Москва' } }),
  ).document;
  assert.equal(saved.version, 2);
  assert.equal(saved.fields.region, 'Москва');
  expectError(await psy.put(`/work/api/documents/${d.id}`, { version: 1, fields: saved.fields }), 409, 'E-CONFLICT');
  expectError(await psy.put(`/work/api/documents/${d.id}`, { version: 2 }), 422, 'E-VALIDATION');
  expectError(
    await psy.put(`/work/api/documents/${d.id}`, { version: 2, fields: saved.fields }, { csrf: false }),
    403,
    'E-CSRF',
  );
  const psy2 = await ctx.as('psy2');
  expectError(await psy2.get(`/work/api/documents/${d.id}`), 404, 'E-NOT-FOUND');
  expectError(await psy2.put(`/work/api/documents/${d.id}`, { version: 2, fields: {} }), 404, 'E-NOT-FOUND');
  expectError(await psy2.post(`/work/api/documents/${d.id}/ready`, {}), 404, 'E-NOT-FOUND');
  expectError(await psy2.del(`/work/api/documents/${d.id}`), 404, 'E-NOT-FOUND');
  expectError(await psy2.get(`/work/api/documents/${d.id}/file?format=docx`), 404, 'E-NOT-FOUND');
  assert.ok(
    !expectOk(await psy2.get('/work/api/documents')).patients.some((p) => p.documents.some((x) => x.id === d.id)),
  );
  expectOk(await psy.del(`/work/api/documents/${d.id}`));
  expectError(await psy.get(`/work/api/documents/${d.id}`), 404, 'E-NOT-FOUND');
});

test('«Готово»: нужны обязательные поля; после — неизменяемо (API и база); удалить нельзя', async () => {
  const psy = await ctx.as('psy1');
  const d = expectOk(await create(psy, {}), 201).document;
  const r = await psy.post(`/work/api/documents/${d.id}/ready`, { version: 1 });
  expectError(r, 422, 'E-VALIDATION');
  assert.ok(r.body.error.missing.includes('region'));
  assert.ok(r.body.error.fields.every((x) => x.key.startsWith('msg.doc.field.')));
  assert.equal(q('SELECT status FROM clinician_documents WHERE id=?', d.id)[0].status, 'draft');
  expectError(await psy.post(`/work/api/documents/${d.id}/ready`, { version: 7 }), 409, 'E-CONFLICT');
  const saved = expectOk(
    await psy.put(`/work/api/documents/${d.id}`, { version: 1, fields: complete(d.fields) }),
  ).document;
  const done = expectOk(await psy.post(`/work/api/documents/${d.id}/ready`, { version: saved.version })).document;
  assert.equal(done.status, 'ready');
  assert.equal(done.complete, true);
  expectError(
    await psy.put(`/work/api/documents/${d.id}`, { version: done.version, fields: done.fields }),
    409,
    'E-SIGNED-IMMUTABLE',
  );
  expectError(await psy.post(`/work/api/documents/${d.id}/ready`, {}), 409, 'E-SIGNED-IMMUTABLE');
  expectError(await psy.del(`/work/api/documents/${d.id}`), 409, 'E-SIGNED-IMMUTABLE');
  assert.throws(
    () => ctx.app.exec(`UPDATE clinician_documents SET fields_enc='x' WHERE id=${Number(d.id)}`),
    /immutable/,
  );
});

test('исправленная версия: новый черновик на основе готового, прежний остаётся; повтор возвращает тот же черновик', async () => {
  const psy = await ctx.as('psy1');
  const d = expectOk(await create(psy, {}), 201).document;
  expectError(await psy.post(`/work/api/documents/${d.id}/revise`, {}), 409, 'E-STATUS');
  const saved = expectOk(
    await psy.put(`/work/api/documents/${d.id}`, { version: 1, fields: complete(d.fields) }),
  ).document;
  const ready = expectOk(await psy.post(`/work/api/documents/${d.id}/ready`, { version: saved.version })).document;
  const rev = expectOk(await psy.post(`/work/api/documents/${d.id}/revise`, {}), 201).document;
  assert.notEqual(rev.id, d.id);
  assert.equal(rev.status, 'draft');
  assert.equal(rev.version, 1);
  assert.equal(rev.supersedes_id, d.id);
  assert.equal(rev.fields.report_type, 'additional');
  assert.equal(rev.fields.previous_report_date, ready.updated_at.slice(0, 10));
  assert.equal(rev.fields.region, 'Москва', 'остальные поля перенесены');
  const again = expectOk(await psy.post(`/work/api/documents/${d.id}/revise`, {}, { idem: crypto_uuid() }));
  assert.equal(again.document.id, rev.id);
  const old = expectOk(await psy.get(`/work/api/documents/${d.id}`)).document;
  assert.equal(old.status, 'ready');
  assert.equal(old.fields.report_type, 'primary', 'готовое не изменилось');
  assert.equal(old.superseded_by, rev.id);
  const group = expectOk(await psy.get(`/work/api/documents?patient_id=${ctx.id('patA')}`)).patients[0];
  assert.equal(group.id, ctx.id('patA'));
  assert.deepEqual(
    group.documents
      .filter((x) => [d.id, rev.id].includes(x.id))
      .map((x) => x.status)
      .sort(),
    ['draft', 'ready'],
  );
  assert.equal(group.documents.find((x) => x.id === d.id).title, 'Извещение о нежелательной реакции (Росздравнадзор)');
});
function crypto_uuid() {
  return require('crypto').randomUUID();
}

test('Idempotency-Key: тот же ключ и тело возвращают прежний документ, другое тело — 409', async () => {
  const psy = await ctx.as('psy1');
  const key = crypto_uuid();
  const before = q('SELECT count(*) n FROM clinician_documents')[0].n;
  const a = await psy.post('/work/api/documents', { template_key: KEY, patient_id: ctx.id('patA') }, { idem: key });
  const b = await psy.post('/work/api/documents', { template_key: KEY, patient_id: ctx.id('patA') }, { idem: key });
  assert.equal(expectOk(a, 201).document.id, expectOk(b, 201).document.id);
  assert.equal(q('SELECT count(*) n FROM clinician_documents')[0].n, before + 1);
  expectError(
    await psy.post('/work/api/documents', { template_key: KEY, patient_id: ctx.id('patG') }, { idem: key }),
    409,
    'E-IDEMPOTENCY-MISMATCH',
  );
});

test('скачивание: docx и пустой бланк; выгрузка пишется в журнал, имя файла без ФИО; формат проверяется', async () => {
  const psy = await ctx.as('psy1');
  const d = expectOk(await create(psy, {}), 201).document;
  const before = q("SELECT count(*) n FROM export_log WHERE kind='ae_notice'")[0].n;
  const r = await psy.get(`/work/api/documents/${d.id}/file?format=docx`, { binary: true });
  assert.equal(r.status, 200);
  assert.ok(r.body.length > 0);
  assert.match(r.headers.get('content-disposition'), new RegExp(`notice-${d.id}\\.docx`));
  assert.doesNotMatch(r.headers.get('content-disposition'), /Тестова/);
  expectError(await psy.get(`/work/api/documents/${d.id}/file?format=pdf`), 422, 'E-VALIDATION');
  expectError(await psy.get('/work/api/documents/blank?format=pdf'), 422, 'E-VALIDATION');
  const blank = await psy.get('/work/api/documents/blank?format=docx', { binary: true });
  assert.equal(blank.status, 200);
  assert.match(blank.headers.get('content-disposition'), /notice-blank\.docx/);
  assert.equal(q("SELECT count(*) n FROM export_log WHERE kind='ae_notice'")[0].n, before + 2);
  expectError(await psy.get(`/work/api/documents/${d.id}/file?format=txt`), 422, 'E-VALIDATION');
  expectError(await (await ctx.as('plg1')).get('/work/api/documents/blank?format=docx'), 403, 'E-ACCESS');
});

test('открепили пациента — документ недоступен (404) и скрыт из списка', async () => {
  const psy = await ctx.as('psy1');
  const d = expectOk(await create(psy, { patient_id: ctx.id('patG') }), 201).document;
  ctx.app.exec(
    `UPDATE care_assignments SET ended_at='2026-10-01T00:00:00Z' WHERE patient_id=${ctx.id('patG')} AND clinician_id=${ctx.id('psy1')}`,
  );
  expectError(await psy.get(`/work/api/documents/${d.id}`), 404, 'E-NOT-FOUND');
  assert.ok(!expectOk(await psy.get('/work/api/documents')).patients.some((p) => p.id === ctx.id('patG')));
});

test('«Сигналы»: у записи о НЯ есть ключи перехода к документу', async () => {
  const psy = await ctx.as('psy1');
  const aeId = await relatedAe();
  const sig = () => psy.get('/api/v1/signals?kind=ae&status=all');
  let item = expectOk(await sig()).items.find((x) => x.id === aeId);
  assert.deepEqual(item.notice_document, {
    available: true,
    template_key: KEY,
    patient_id: ctx.id('patA'),
    ae_id: aeId,
    document_id: null,
    document_status: null,
  });
  const d = expectOk(await create(psy, { ae_id: aeId }), 201).document;
  item = expectOk(await sig()).items.find((x) => x.id === aeId);
  assert.equal(item.notice_document.document_id, d.id);
  assert.equal(item.notice_document.document_status, 'draft');
});
