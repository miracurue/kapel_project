'use strict';

// Повторяющиеся сценарии через API (как их проходит пользователь). Каждая функция возвращает
// созданный объект и сама проверяет успех, чтобы тесты читались как сценарий.

const assert = require('node:assert/strict');
const { expectOk } = require('./client');

// Синтетические фразы. Кризисная — из детерминированных правил кода (src/riskClassifier.js, M-14).
const CRISIS_PHRASE = 'Сегодня совсем тяжело, нет смысла жить дальше.';
const CALM_PHRASE = 'Когда лекарство начнёт действовать?';
const AE_PHRASE = 'тошнит после таблетки уже третий день';
const UNDO_PASS_MS = 16000; // окно «Отменить» S-01: 10 с на экране + 5 с на сервере

const fs = require('fs');
const path = require('path');
const FILES = path.join(__dirname, '..', 'fixtures', 'files');

// Загрузка файла (F-15). name — файл из tests/fixtures/files или { name, buffer, type }.
async function upload(client, file, purpose = 'chat') {
  const form = new FormData();
  const f = typeof file === 'string' ? { name: file, buffer: fs.readFileSync(path.join(FILES, file)) } : file;
  const type = f.type || ({ jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf', webm: 'audio/webm', csv: 'text/csv', txt: 'text/plain' }[f.name.split('.').pop()] || 'application/octet-stream');
  form.append('file', new Blob([f.buffer], { type }), f.name);
  form.append('purpose', purpose);
  return client.raw('POST', '/api/v1/uploads', undefined, { form });
}

async function stt(client, { purpose = 'chat', durationS = 5, file = 'voice_short.webm' } = {}) {
  const form = new FormData();
  form.append('audio', new Blob([fs.readFileSync(path.join(FILES, file))], { type: 'audio/webm' }), file);
  form.append('purpose', purpose);
  form.append('duration_s', String(durationS));
  return client.raw('POST', '/api/v1/stt', undefined, { form, idem: false });
}

// Новая версия настройки S- (F-97). В synthetic клиническим нужно «Кто утвердил» — передаётся всегда.
async function setSetting(admin, key, value, extra = {}) {
  const cur = expectOk(await admin.get(`/api/v1/admin/settings/${encodeURIComponent(key)}`));
  const r = await admin.put(`/api/v1/admin/settings/${encodeURIComponent(key)}`, {
    value, base_version: cur.current.version, comment: 'тест этапа 13',
    approved_by: 'Синтетический КО, клинический ответственный, 17.10.2026', ...extra,
  });
  return r;
}

async function passUndoWindow(app) {
  await app.advanceClock(UNDO_PASS_MS);
}

async function patientAsk(patient, text, extra = {}) {
  const r = await patient.post('/api/v1/ai/patient/messages', { text, ...extra });
  return r;
}

async function signalsOf(clinician, query = 'kind=all&status=all') {
  const r = await clinician.get(`/api/v1/signals?${query}`);
  expectOk(r);
  return r.body.items;
}

async function crisisSignalFor(clinician, patientId) {
  const items = await signalsOf(clinician, 'kind=crisis&status=all');
  return items.find((s) => s.patient && s.patient.id === patientId);
}

async function instrumentQuestions(patient, assignmentId) {
  const r = await patient.get(`/api/v1/me/assignments/${assignmentId}`);
  expectOk(r);
  return r.body.questions;
}

// Назначить методику; после окна «Отменить» пациент её видит.
async function assignTest(app, clinician, patientId, code = 'gad7', extra = {}) {
  const r = await clinician.post(`/api/v1/patients/${patientId}/assignments`, { instrument_code: code, ...extra });
  expectOk(r);
  await passUndoWindow(app);
  return r.body.items[0];
}

// Пройти методику: answerFor(question) → значение; по умолчанию — первый вариант / минимум.
async function completeTest(patient, assignmentId, answerFor = null) {
  const qs = await instrumentQuestions(patient, assignmentId);
  for (const q of qs) {
    let value = answerFor ? answerFor(q) : undefined;
    if (value === undefined) {
      if (q.type === 'multi') value = [q.options[0].value];
      else if (q.options && q.options.length) value = q.options[0].value;
      else if (q.type === 'number' || q.type === 'scale') value = q.min ?? 0;
      else if (q.type === 'date') value = '2026-10-01';
      else if (q.type === 'yes_no') value = 'no';
      else value = 'синтетический ответ';
    }
    expectOk(await patient.put(`/api/v1/me/assignments/${assignmentId}/answers/${encodeURIComponent(q.id)}`, { value }));
  }
  const r = await patient.post(`/api/v1/me/assignments/${assignmentId}/submit`, {});
  return r;
}

// План по МНН: черновик → «Отправить пациенту» → после окна пациент видит.
async function publishPlan(app, psychiatrist, patientId, items) {
  const cur = expectOk(await psychiatrist.get(`/api/v1/patients/${patientId}/plan`));
  const base = (cur.draft && cur.draft.version) || (cur.published && cur.published.version) || 1;
  const d = await psychiatrist.put(`/api/v1/patients/${patientId}/plan/draft`, { version: base, items });
  expectOk(d);
  const p = await psychiatrist.post(`/api/v1/patients/${patientId}/plan/publish`, { version: d.body.version || base });
  expectOk(p);
  await passUndoWindow(app);
  return p.body;
}

async function innId(client, name) {
  const r = await client.get(`/api/v1/catalog/search?q=${encodeURIComponent(name)}&scope=inn`);
  expectOk(r);
  const hit = r.body.items.find((i) => i.kind === 'inn' && i.name.toLowerCase() === name.toLowerCase());
  assert.ok(hit, `МНН ${name} есть в каталоге-заглушке`);
  return hit.id;
}

async function productOf(client, innIdValue, tradeName) {
  const r = await client.get(`/api/v1/catalog/search?q=${encodeURIComponent(tradeName)}&scope=products_of_inn&inn_id=${innIdValue}`);
  expectOk(r);
  const hit = r.body.items.find((i) => i.kind === 'product' && i.name.toLowerCase().startsWith(tradeName.toLowerCase()));
  assert.ok(hit, `препарат ${tradeName} есть в каталоге`);
  return hit;
}

// Сертралин 50 мг утром опубликован пациенту и принят с «Золофт».
async function sertralinePrescribedAndAccepted(app, psychiatrist, patient, patientId) {
  const inn = await innId(psychiatrist, 'сертралин');
  await publishPlan(app, psychiatrist, patientId, [{ inn_id: inn, dose: 50, unit: 'мг', times: ['утро'], comment: 'во время завтрака' }]);
  const meds = expectOk(await patient.get('/api/v1/me/meds'));
  const item = meds.plan_items.find((i) => i.inn_id === inn);
  assert.ok(item, 'пациент видит пункт плана');
  const product = await productOf(patient, inn, 'Золофт');
  const acc = await patient.post(`/api/v1/me/plan-items/${encodeURIComponent(item.item_key)}/accept`, { product_id: product.id });
  expectOk(acc);
  return { inn, item, product };
}

module.exports = {
  CRISIS_PHRASE, CALM_PHRASE, AE_PHRASE, UNDO_PASS_MS,
  FILES, upload, stt, setSetting, passUndoWindow, patientAsk, signalsOf, crisisSignalFor, instrumentQuestions,
  assignTest, completeTest, publishPlan, innId, productOf, sertralinePrescribedAndAccepted,
};
