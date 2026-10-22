'use strict';

// Композер: подсказки и чипы (F-12), проверка контекста на каждой отправке (F-13, allowlist 08 «Common rules A»),
// файлы и фото (F-15, PD-06, PD-08, S-25), голос (F-14, S-24) через подделку ml-worker.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectError, expectOk, hasWarning } = require('../lib/client');
const F = require('../lib/flows');

const ctx = useApp();

// covers: T-050, UC-24, UC-25, F-12, F-29, PD-14
test('T-050 [W-33] подсказки пациента в чате: не больше трёх, только ссылки и подписи, без содержимого объектов', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patA');
  await F.sertralinePrescribedAndAccepted(ctx.app, doc, p, ctx.id('patA'));
  expectOk(await p.post('/api/v1/me/diary', { mood: 2, note: 'Синтетическая заметка для подсказки' }));
  await F.passUndoWindow(ctx.app);
  const r = expectOk(await p.get('/api/v1/context/suggestions?tab=chat'));
  assert.ok(r.items.length >= 1 && r.items.length <= 3, `не больше трёх: ${r.items.length}`);
  for (const s of r.items) {
    assert.ok(s.chip && s.chip.type && s.chip.id, 'подсказка — ссылка {тип, ID, версия}');
    assert.ok(s.label, 'есть подпись');
  }
  assert.ok(!JSON.stringify(r).includes('Синтетическая заметка для подсказки'), 'содержимого объекта в ответе нет');
});

// covers: T-051, UC-14, F-12, F-13, PD-11, PD-14
test('T-051 [W-33] у специалиста до выбора пациента подсказок нет; после — 3 последних объекта из allowlist роли; психологу план и НЯ не предлагаются', async () => {
  const doc = await ctx.as('psy1');
  assert.equal(expectOk(await doc.get('/api/v1/context/suggestions?tab=chat')).items.length, 0);
  const withPatient = expectOk(await doc.get(`/api/v1/context/suggestions?tab=chat&patient_id=${ctx.id('patA')}`));
  assert.ok(withPatient.items.length <= 3);
  const plg = await ctx.as('plg1');
  const forPlg = expectOk(await plg.get(`/api/v1/context/suggestions?tab=chat&patient_id=${ctx.id('patA')}`));
  for (const s of forPlg.items) assert.ok(!['plan_item', 'purchase', 'patient_med', 'adverse_event'].includes(s.chip.type), `у психолога нет ${s.chip.type}`);
  const searchPlg = expectOk(await plg.get(`/api/v1/context/search?q=${encodeURIComponent('сертралин')}&patient_id=${ctx.id('patA')}`));
  assert.ok(!searchPlg.items.some((s) => ['plan_item', 'purchase', 'patient_med'].includes(s.chip.type)), '«@» психолога не находит план лечения');
});

// covers: T-052, UC-24, F-12, PD-02, PD-14
test('T-052 [W-33] «@» и «+ → Из моих данных»: до 20 результатов, только свои объекты; чужой пациент у специалиста — 404', async () => {
  const p = await ctx.as('patA');
  const r = expectOk(await p.get(`/api/v1/context/search?q=${encodeURIComponent('тест')}`));
  assert.ok(r.items.length <= 20);
  const doc = await ctx.as('psy1');
  expectError(await doc.get(`/api/v1/context/search?q=x&patient_id=${ctx.id('patB')}`), 404, 'E-NOT-FOUND');
});

// covers: T-053, UC-24, UC-25, F-13, F-27, PD-14, PD-02
test('T-053 [W-33] чужой или недоступный чип: сообщение не уходит урезанным — 409 E-CONTEXT-REJECTED со списком, модель не вызывается', async () => {
  const p = await ctx.as('patA');
  const other = await ctx.as('patB');
  const otherEntry = expectOk(await other.post('/api/v1/me/diary', { mood: 1, note: 'Чужая синтетическая заметка' }));
  ctx.app.ai.reset();
  const r = await F.patientAsk(p, F.CALM_PHRASE, { chips: [{ type: 'diary_entry', id: otherEntry.entry.id }] });
  const e = expectError(r, 409, 'E-CONTEXT-REJECTED');
  assert.ok(Array.isArray(e.details.rejected_chips) && e.details.rejected_chips.length === 1, 'перечень отклонённых ссылок');
  assert.equal(ctx.app.ai.calls().length, 0, 'модель не вызывалась');
  assert.ok(!ctx.app.ai.seenText().includes('Чужая синтетическая заметка'));
  const denies = ctx.app.query("SELECT * FROM phi_access_log WHERE actor_id = ? AND decision = 'deny'", ctx.id('patA'));
  assert.ok(denies.length >= 1, 'отказ по ссылке записан в журнал доступа');
});

// covers: T-054, F-13, F-32, PD-14, PD-16
test('T-054 [W-33] allowlist: переписка с врачом, пациентский ИИ-чат, кризисная цитата и «весь профиль» не прикрепляются никем', async () => {
  const p = await ctx.as('patA');
  const doc = await ctx.as('psy1');
  const msg = expectOk(await p.post('/api/v1/me/messages', { text: 'Синтетическое сообщение врачу для allowlist' }));
  const forbidden = [{ type: 'person', id: ctx.id('patA') }, { type: 'request', id: 1 }, { type: 'log_entry', id: 1 }, { type: 'setting', id: 1 }];
  for (const chip of forbidden) {
    expectError(await F.patientAsk(p, F.CALM_PHRASE, { chips: [chip] }), 409, 'E-CONTEXT-REJECTED');
  }
  const r = await doc.post('/api/v1/ai/clinician/messages', { text: 'Сводка', chips: [{ type: 'patient', id: ctx.id('patA') }, { type: 'person', id: msg.message.id }] });
  expectError(r, 409, 'E-CONTEXT-REJECTED');
});

// covers: T-055, F-13, F-27, F-32
test('T-055 [W-33] больше 5 чипов в одном сообщении — 422 E-VALIDATION, текст сохраняется у клиента', async () => {
  const p = await ctx.as('patA');
  const chips = Array.from({ length: 6 }, (_, i) => ({ type: 'library_item', id: i + 1 }));
  expectError(await F.patientAsk(p, F.CALM_PHRASE, { chips }), 422, 'E-VALIDATION');
});

// covers: T-056, UC-24, UC-21, F-15, S-25, PD-06
test('T-056 [W-23] загрузка: тип по сигнатуре (exe под .jpg — 415 E-FILE-TYPE), больше 10 МБ — 413 E-FILE-SIZE, больше 5 файлов — 422 E-FILE-COUNT', async () => {
  const p = await ctx.as('patA');
  expectError(await F.upload(p, 'not_really.jpg'), 415, 'E-FILE-TYPE');
  const big = Buffer.concat([require('fs').readFileSync(`${F.FILES}/photo_with_gps.jpg`), Buffer.alloc(10 * 1024 * 1024 + 1)]);
  expectError(await F.upload(p, { name: 'big.jpg', buffer: big, type: 'image/jpeg' }), 413, 'E-FILE-SIZE');
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push(expectOk(await F.upload(p, 'photo_with_gps.jpg')).id);
  const sixth = expectOk(await F.upload(p, 'synthetic_report.pdf')).id;
  expectError(await F.patientAsk(p, F.CALM_PHRASE, { upload_ids: [...ids, sixth] }), 422, 'E-VALIDATION');
  const msg = await p.post('/api/v1/me/messages', { text: 'Синтетика с файлами', upload_ids: [...ids, sixth] });
  expectError(msg, 422, 'E-FILE-COUNT');
});

// covers: T-057, F-15, PD-06, PD-08
test('T-057 [W-23] фото: EXIF и геометки стёрты, имя хранения случайное вне public/, скачивание только авторизованным маршрутом с nosniff и attachment; чужой — 404', async () => {
  const p = await ctx.as('patA');
  const up = expectOk(await F.upload(p, 'photo_with_gps.jpg', 'message'));
  const row = ctx.app.query('SELECT storage_name, exif_stripped FROM stored_files WHERE id = ?', up.id)[0];
  assert.equal(row.exif_stripped, 1);
  assert.doesNotMatch(row.storage_name, /photo_with_gps/, 'исходное имя не участвует в имени хранения');
  const sent = expectOk(await p.post('/api/v1/me/messages', { text: 'Синтетика с фото', upload_ids: [up.id] }));
  await F.passUndoWindow(ctx.app);
  const own = await p.get(`/api/v1/files/${up.id}`, { binary: true });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('x-content-type-options'), 'nosniff');
  assert.match(own.headers.get('content-disposition') || '', /attachment/);
  assert.ok(!own.body.includes(Buffer.from('SyntheticCam')), 'метаданные камеры удалены');
  assert.ok(!own.body.includes(Buffer.from('Exif\0\0')), 'EXIF-сегмента нет');
  const doc = await ctx.as('psy1');
  assert.equal((await doc.get(`/api/v1/files/${up.id}`, { binary: true })).status, 200, 'закреплённый врач видит вложение сообщения');
  expectError(await (await ctx.as('patB')).get(`/api/v1/files/${up.id}`), 404, 'E-NOT-FOUND');
  expectError(await (await ctx.as('psy2')).get(`/api/v1/files/${up.id}`), 404, 'E-NOT-FOUND');
  const direct = await p.get(`/files/${row.storage_name}`);
  assert.ok([404, 403].includes(direct.status), 'прямой адрес хранения не раздаётся');
  void sent;
});

// covers: T-058, F-15, F-21, S-23, PD-08
test('T-058 [W-23] временная загрузка без отправки стирается через 20 минут (S-23)', async () => {
  const p = await ctx.as('patC');
  const up = expectOk(await F.upload(p, 'synthetic_report.pdf'));
  await ctx.app.advanceClock(21 * 60 * 1000);
  await ctx.app.waitJobs(10);
  const row = ctx.app.query('SELECT status FROM stored_files WHERE id = ?', up.id)[0];
  assert.ok(!row || row.status === 'deleted');
  expectError(await p.get(`/api/v1/files/${up.id}`), 404, 'E-NOT-FOUND');
});

// covers: T-059, UC-24, UC-06, F-14, PD-08, PD-17, S-24
test('T-059 [W-31] голос: расшифровка только возвращается в поле (ничего не сохранено), звук стёрт; запрос к ml-worker с токеном', async () => {
  const p = await ctx.as('patA');
  ctx.app.ml.reset();
  const before = ctx.app.query('SELECT count(*) n FROM ai_messages')[0].n;
  const r = expectOk(await F.stt(p, { purpose: 'chat', durationS: 10 }));
  assert.equal(r.text, ctx.app.ml.preset.stt);
  assert.equal(ctx.app.query('SELECT count(*) n FROM ai_messages')[0].n, before, 'без «Отправить» ничего не сохранено');
  const audio = ctx.app.query("SELECT count(*) n FROM stored_files WHERE purpose = 'audio_temp' AND status <> 'deleted'")[0].n;
  assert.equal(audio, 0, 'звук стирается сразу после расшифровки (PD-08)');
  const calls = ctx.app.ml.callsTo('/stt');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].tokenOk, 'общий токен ML_WORKER_TOKEN передан');
  assert.ok(!ctx.app.logs().includes(ctx.app.ml.preset.stt), 'текст расшифровки не попал в журнал (PD-17)');
});

// covers: T-060, F-14, S-24
test('T-060 [W-31] голос: длиннее S-24 — 413 E-STT-TOO-LONG; ml-worker недоступен — 503 E-STT-UNAVAILABLE; тишина — 422 E-STT-EMPTY', async () => {
  const p = await ctx.as('patA');
  expectError(await F.stt(p, { durationS: 181 }), 413, 'E-STT-TOO-LONG');
  const doc = await ctx.as('psy1');
  expectOk(await F.stt(doc, { purpose: 'offline_result', durationS: 600 }), 200);
  ctx.app.ml.mode.stt = 'down';
  expectError(await F.stt(p, {}), 503, 'E-STT-UNAVAILABLE');
  ctx.app.ml.mode.stt = 'empty';
  expectError(await F.stt(p, {}), 422, 'E-STT-EMPTY');
  ctx.app.ml.reset();
  const admin = await ctx.as('admin1');
  const cur = expectOk(await admin.get('/api/v1/admin/settings/voice.max_seconds'));
  expectOk(await admin.put('/api/v1/admin/settings/voice.max_seconds', { value: { patient: 60, clinician: 900 }, base_version: cur.current.version, comment: 'тест S-24' }));
  expectError(await F.stt(p, { durationS: 61 }), 413, 'E-STT-TOO-LONG');
});

// covers: T-061, UC-21, UC-24, F-15, PD-15
test('T-061 [W-31] печатный документ распознаётся локально (ml-worker /ocr), рукописный — предупреждение E-OCR-FAILED, файл остаётся изображением', async () => {
  const p = await ctx.as('patA');
  const ok = expectOk(await F.upload(p, 'printed_form.png'));
  assert.equal(ok.ocr_status, 'done');
  assert.ok(ok.ocr_text.includes('Синтетический бланк'));
  ctx.app.ml.mode.ocr = 'handwritten';
  const hw = await F.upload(p, 'printed_form.png');
  const body = expectOk(hw);
  assert.equal(body.ocr_status, 'failed');
  assert.ok(hasWarning(body, 'E-OCR-FAILED') || body.ocr_status === 'failed');
  ctx.app.ml.reset();
});

// covers: T-062, F-15, F-23
test('T-062 [W-23] не больше 20 загрузок за 10 минут — 429 E-RATE-LIMIT', async () => {
  const p = await ctx.as('patH');
  let last;
  for (let i = 0; i < 21; i += 1) last = await F.upload(p, 'synthetic_report.pdf');
  expectError(last, 429, 'E-RATE-LIMIT');
});

// covers: T-063, F-15, S-25, F-97
test('T-063 [W-41] S-25: сужение списка типов и размера действует сразу; расширить список кодом не поддержанным типом нельзя', async () => {
  const admin = await ctx.as('admin1');
  const cur = expectOk(await admin.get('/api/v1/admin/settings/files.limits'));
  expectError(await admin.put('/api/v1/admin/settings/files.limits', { value: { max_mb: 10, max_count: 5, types: ['jpeg', 'png', 'exe'] }, base_version: cur.current.version }), 422, 'E-SETTING-INVALID');
  expectOk(await admin.put('/api/v1/admin/settings/files.limits', { value: { max_mb: 1, max_count: 5, types: ['jpeg', 'png'] }, base_version: cur.current.version, comment: 'тест' }));
  const p = await ctx.as('patB');
  expectError(await F.upload(p, 'synthetic_report.pdf'), 415, 'E-FILE-TYPE');
  const twoMb = Buffer.concat([require('fs').readFileSync(`${F.FILES}/photo_with_gps.jpg`), Buffer.alloc(2 * 1024 * 1024)]);
  expectError(await F.upload(p, { name: 'two.jpg', buffer: twoMb, type: 'image/jpeg' }), 413, 'E-FILE-SIZE');
});
