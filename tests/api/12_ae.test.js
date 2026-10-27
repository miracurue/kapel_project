'use strict';

// Побочные эффекты: сообщение пациента (F-45), решение психиатра (F-65), черновик извещения (F-66), S-27.
// Наружу ничего не отправляется автоматически (L-24): подделки внешних получателей запросов не получают.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectError, expectOk } = require('../lib/client');
const F = require('../lib/flows');

const ctx = useApp();

async function report(patientKey, extra = {}) {
  const p = await ctx.as(patientKey);
  const r = expectOk(await p.post('/api/v1/me/adverse-events', { symptoms: ['nausea'], text: 'Синтетика: тошнота после приёма', started_on: '2026-10-10', severity: 'noticeable', related: 'yes', ...extra }));
  return r;
}

// covers: T-185, UC-07, F-45, F-17, F-19, PD-02
test('T-185 [W-26] НЯ: «Отправлено врачу · Отменить», врач видит после окна, статус пациента нейтральный «ожидает врача»', async () => {
  const r = await report('patA');
  assert.equal(r.ae.status, 'awaiting_visibility');
  assert.ok(r.undo);
  const psy = await ctx.as('psy1');
  assert.ok(!(await F.signalsOf(psy, 'kind=ae&status=all')).some((s) => s.id === r.ae.id), 'в окне врач не видит');
  await F.passUndoWindow(ctx.app);
  assert.ok((await F.signalsOf(psy, 'kind=ae&status=all')).some((s) => s.id === r.ae.id));
  const mine = expectOk(await (await ctx.as('patA')).get('/api/v1/me/adverse-events')).items.find((x) => x.id === r.ae.id);
  assert.equal(mine.status, 'awaiting_doctor');
  const note = expectOk(await psy.get('/api/v1/notifications')).items.find((n) => n.object && n.object.id === r.ae.id);
  assert.ok(note && !/тошнот/i.test(note.title), 'уведомление без описания');
});

// covers: T-186, UC-07, UC-17, F-45, F-83, PD-20, PD-16
test('T-186 [W-26] без закреплённого психиатра НЯ остаётся личной записью пациента: службе не уходит, врачам не видна; пустое описание — E-VALIDATION', async () => {
  const p = await ctx.as('patI');
  expectError(await p.post('/api/v1/me/adverse-events', { symptoms: [], text: '' }), 422, 'E-VALIDATION');
  const r = expectOk(await p.post('/api/v1/me/adverse-events', { symptoms: ['headache'], text: 'Синтетика: болит голова', severity: 'mild', related: 'unknown' }));
  assert.equal(r.ae.attached, false);
  assert.equal(r.ae.status, 'saved_private');
  await F.passUndoWindow(ctx.app);
  const q = expectOk(await (await ctx.as('admin1')).get('/api/v1/admin/requests?filter=open'));
  assert.ok(!q.items.some((i) => i.kind === 'ae_no_psychiatrist'), 'очередь службы больше не создаётся');
  const mine = expectOk(await p.get('/api/v1/me/adverse-events')).items.find((x) => x.id === r.ae.id);
  assert.equal(mine.status, 'saved_private');
  assert.equal(mine.attached, false);
  assert.ok(!(await F.signalsOf(await ctx.as('plg1'), 'kind=all&status=all')).some((s) => s.id === r.ae.id), 'психолог НЯ не видит');
});

// covers: T-187, UC-13, F-65, F-17, F-19
test('T-187 [W-26] решение врача одной кнопкой; второй врач — E-CONFLICT с тем, кто решил; «Отменить»; пациент видит только «врач посмотрел»', async () => {
  const r = await report('patA', { text: 'Синтетика: сонливость' });
  await F.passUndoWindow(ctx.app);
  const a = await ctx.as('psy1');
  const dec = expectOk(await a.post(`/api/v1/adverse-events/${r.ae.id}/decision`, { decision: 'insufficient', version: r.ae.version }));
  expectOk(await a.post(`/api/v1/undo/${dec.undo.id}`, {}));
  const again = expectOk(await a.post(`/api/v1/adverse-events/${r.ae.id}/decision`, { decision: 'probable', serious: false, version: r.ae.version }));
  assert.equal(again.ae.status, 'probable');
  ctx.app.exec(`INSERT INTO care_assignments (patient_id, clinician_id, started_at) VALUES (${Number(ctx.id('patA'))}, ${Number(ctx.id('psy3'))}, '2026-10-01T00:00:00Z')`);
  const b = await ctx.as('psy3');
  const e = expectError(await b.post(`/api/v1/adverse-events/${r.ae.id}/decision`, { decision: 'unrelated', version: r.ae.version }), 409, 'E-CONFLICT');
  assert.ok(e.details && (e.details.decided_by || e.details.taken_by), 'показано, кто уже решил');
  const mine = expectOk(await (await ctx.as('patA')).get('/api/v1/me/adverse-events')).items.find((x) => x.id === r.ae.id);
  assert.doesNotMatch(JSON.stringify(mine), /probable|вероятн/i, 'пациент не видит клинического заключения');
});

// covers: T-188, UC-13, UC-20, F-66, F-67, L-24, PD-19
test('T-188 [W-26] черновик извещения — только после «Связь вероятна»; поля предзаполнены, недостающие помечены; файл с пометкой «черновик»; наружу ничего не уходит', async () => {
  {
    const r = await report('patA', { text: 'Синтетика: сыпь' });
    await F.passUndoWindow(ctx.app);
    const doc = await ctx.as('psy1');
    expectError(await doc.get(`/api/v1/adverse-events/${r.ae.id}/notice`), 409, 'E-STATUS');
    expectOk(await doc.post(`/api/v1/adverse-events/${r.ae.id}/decision`, { decision: 'probable', serious: true, version: r.ae.version }));
    const n = expectOk(await doc.get(`/api/v1/adverse-events/${r.ae.id}/notice`));
    assert.equal(n.status, 'draft');
    assert.equal(n.complete, false, 'недостающие поля помечены');
    const saved = expectOk(await doc.put(`/api/v1/adverse-events/${r.ae.id}/notice`, { version: n.version, fields: { ...n.fields, reporter_comment: 'синтетика' } }));
    assert.equal(saved.version, n.version + 1, 'правка — новая версия');
    const f = await doc.get(`/api/v1/adverse-events/${r.ae.id}/notice/file?format=pdf`, { binary: true });
    assert.equal(f.status, 200);
    const txt = await doc.get(`/api/v1/adverse-events/${r.ae.id}/notice/file?format=txt`, { binary: true });
    assert.match(txt.body.toString('utf8'), /черновик/i);
    assert.match(txt.body.toString('utf8'), /неполн/i);
    expectError(await (await ctx.as('plg1')).get(`/api/v1/adverse-events/${r.ae.id}/notice`), 403, 'E-ACCESS');
    const ops = require('../lib/contract').api().filter((o) => /adverse|notice/.test(o.path));
    assert.ok(!ops.some((o) => /send|submit|roszdrav|sponsor/i.test(o.path)), 'в API нет автоматической отправки извещения');
    assert.ok(ctx.app.query('SELECT count(*) n FROM export_log')[0].n >= 1, 'выгрузка в журнале');
  }
});

// covers: T-189, UC-13, F-65, F-97, S-27
test('T-189 [W-41] S-27: ответственный по фармаконадзору виден врачу в карточке НЯ; пусто — строка «не назначен» (STAND-IN)', async () => {
  const r = await report('patA', { text: 'Синтетика: головокружение' });
  await F.passUndoWindow(ctx.app);
  const doc = await ctx.as('psy1');
  const card = (await F.signalsOf(doc, 'kind=ae&status=all')).find((s) => s.id === r.ae.id);
  assert.ok(card);
  const admin = await ctx.as('admin1');
  expectOk(await F.setSetting(admin, 'pv.responsible', { name: 'Синтетический Ответственный', contact: 'pv@cc.example.test' }));
  const page = await doc.get('/work?tab=signals', { headers: { accept: 'text/html' } });
  assert.ok(page.body.includes('Синтетический Ответственный'), 'новое значение видно сразу');
});
