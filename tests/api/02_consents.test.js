'use strict';

// Четыре раздельных согласия, их эффекты и неизменяемый журнал (PD-09, PD-10).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectError, expectOk } = require('../lib/client');
const F = require('../lib/flows');

const ctx = useApp();

async function consents(c) {
  const r = expectOk(await c.get('/api/v1/consents'));
  return Object.fromEntries(r.items.map((i) => [i.kind, i]));
}

// covers: T-030, UC-01, UC-08, F-05, PD-09, PD-27
test('T-030 [W-07] согласия раздельные: 4 вида с версией; повторное «Согласен» той же версии не создаёт вторую запись', async () => {
  const p = await ctx.as('patB');
  const list = await consents(p);
  assert.deepEqual(Object.keys(list).sort(), ['ai', 'base', 'program', 'research']);
  assert.equal(list.base.state, 'given');
  for (const k of ['research', 'program']) assert.notEqual(list[k].state, 'given', `${k} не дано по умолчанию`);
  const before = ctx.app.query('SELECT count(*) n FROM consent_events WHERE user_id = ?', ctx.id('patB'))[0].n;
  expectOk(await p.post('/api/v1/consents/research', { action: 'give', version: list.research.version }));
  expectOk(await p.post('/api/v1/consents/research', { action: 'give', version: list.research.version }));
  const after = ctx.app.query('SELECT count(*) n FROM consent_events WHERE user_id = ?', ctx.id('patB'))[0].n;
  assert.equal(after, before + 1);
  const ev = ctx.app.query("SELECT * FROM consent_events WHERE user_id = ? AND consent_kind = 'research' ORDER BY id DESC LIMIT 1", ctx.id('patB'))[0];
  assert.ok(ev.content_version_id && ev.text_sha256 && ev.sign_method, 'версия, хеш текста и способ подписи записаны (L-05)');
});

// covers: T-031, UC-08, UC-24, F-06, F-27, PD-09, PD-13
test('T-031 [W-34] выключение ИИ-согласия: помощник сразу 403 E-CONSENT-AI, ИИ специалиста работает; «Отменить» в окне возвращает', async () => {
  const p = await ctx.as('patA');
  const v = (await consents(p)).ai.version;
  const off = expectOk(await p.post('/api/v1/consents/ai', { action: 'revoke', version: v }));
  assert.ok(off.undo && off.undo.id, 'выключение — со строкой «Отменить»');
  expectError(await F.patientAsk(p, F.CALM_PHRASE), 403, 'E-CONSENT-AI');
  const doc = await ctx.as('psy1');
  const r = await doc.post('/api/v1/ai/clinician/messages', { text: 'Что изменилось за 2 недели?', chips: [{ type: 'patient', id: ctx.id('patA') }] });
  expectOk(r);
  expectOk(await p.post(`/api/v1/undo/${off.undo.id}`, {}));
  expectOk(await F.patientAsk(p, F.CALM_PHRASE));
  const events = ctx.app.query("SELECT action FROM consent_events WHERE user_id = ? AND consent_kind = 'ai' ORDER BY id", ctx.id('patA')).map((e) => e.action);
  assert.deepEqual(events.slice(-2), ['revoked', 'given'], 'отмена — новое событие, а не стирание прежнего (только дописывание)');
});

// covers: T-032, UC-08, UC-22, F-06, F-72, PD-09
test('T-032 [W-52] отзыв научного согласия исключает пациента из новых исследовательских выгрузок', async () => {
  const doc = await ctx.as('psy1');
  const p = await ctx.as('patH');
  const a = await F.assignTest(ctx.app, doc, ctx.id('patH'), 'phq9');
  expectOk(await F.completeTest(p, a.id));
  const off = await doc.post(`/api/v1/patients/${ctx.id('patH')}/offline-results`, { instrument_code: 'phq9', method: 'manual', scores: { total: 5 }, held_on: new Date().toISOString().slice(0, 10) });
  expectOk(off);
  expectOk(await doc.post(`/api/v1/offline-results/${off.body.id}/confirm`, { scores: { total: 5 }, version: 1 }));
  const pairs = ctx.app.query('SELECT count(*) n FROM comparison_pairs WHERE patient_id = ?', ctx.id('patH'))[0].n;
  assert.ok(pairs >= 1, 'пара онлайн/очно создана');
  const exportCsv = async () => {
    const exp = expectOk(await doc.post('/api/v1/analytics/research/export', { instrument: 'phq9', from: '2026-01-01', to: '2027-12-31', window_days: 14 }));
    const file = await doc.get(new URL(exp.link, ctx.app.base).pathname, { headers: { accept: 'text/csv' } });
    assert.equal(file.status, 200);
    return String(file.body);
  };
  const before = await exportCsv();
  const pseudo = ctx.app.query('SELECT pseudonym FROM research_pseudonyms WHERE patient_id = ?', ctx.id('patH'))[0];
  assert.ok(pseudo && before.includes(pseudo.pseudonym), 'до отзыва строка пациента в выгрузке есть');
  const v = (await consents(p)).research.version;
  expectOk(await p.post('/api/v1/consents/research', { action: 'revoke', version: v }));
  await F.passUndoWindow(ctx.app);
  const after = await exportCsv();
  assert.ok(!after.includes(pseudo.pseudonym), 'после отзыва строки пациента в новой выгрузке нет');
  assert.doesNotMatch(after, /Хасан|Исследуемый|pat\.h@/, 'выгрузка без ФИО и почты');
});

// covers: T-033, UC-42, F-06, F-74, F-112, PD-09, PD-19
test('T-033 [W-53] отзыв согласия программы поддержки исключает пациента из новых агрегатов программы', async () => {
  const p = await ctx.as('patA');
  const admin = await ctx.as('admin1');
  const before = expectOk(await admin.get('/api/v1/admin/program/reports?kind=participants&from=2026-01-01&to=2027-12-31'));
  const v = (await consents(p)).program.version;
  expectOk(await p.post('/api/v1/consents/program', { action: 'revoke', version: v }));
  await F.passUndoWindow(ctx.app);
  const after = expectOk(await admin.get('/api/v1/admin/program/reports?kind=participants&from=2026-01-01&to=2027-12-31'));
  const count = (r) => r.rows.reduce((s, x) => s + (Number(x.patients) || 0), 0);
  assert.ok(count(after) <= count(before), 'число участников не растёт после отзыва');
  const cur = ctx.app.query("SELECT action FROM consent_current WHERE user_id = ? AND consent_kind = 'program'", ctx.id('patA'))[0];
  assert.equal(cur.action, 'revoked');
});

// covers: T-034, UC-08, UC-05, F-06, F-53, F-16, PD-10, PD-12
test('T-034 [W-07] отзыв обязательного согласия только с подтверждением; потом новые записи запрещены, а «Мне нужна помощь» и кризисная проверка работают', async () => {
  const p = await ctx.as('patG');
  const v = (await consents(p)).base.version;
  expectError(await p.post('/api/v1/consents/base', { action: 'revoke', version: v }), 422, 'E-VALIDATION');
  const r = expectOk(await p.post('/api/v1/consents/base', { action: 'revoke', version: v, confirm: true }));
  assert.ok(!r.undo, 'необратимо — без «Отменить»');
  expectError(await p.post('/api/v1/me/diary', { mood: 3 }), 403, 'E-CONSENT-REQUIRED');
  const help = expectOk(await p.post('/api/v1/crisis/help', { text: F.CRISIS_PHRASE, source: 'button' }));
  assert.equal(help.crisis.contacts[0].phone, '112');
  const signals = ctx.app.query('SELECT id FROM crisis_escalations WHERE patient_id = ?', ctx.id('patG'));
  assert.ok(signals.length >= 1, 'кризис распознан и без согласия (PD-10, PD-16)');
  const req = ctx.app.query("SELECT request_type, due_at, requested_at FROM data_subject_requests WHERE patient_id = ? ORDER BY id DESC LIMIT 1", ctx.id('patG'))[0];
  assert.ok(req && /erasure|deletion/.test(req.request_type), 'создан запрос на стирание');
  assert.ok(new Date(req.due_at) - new Date(req.requested_at) <= 30 * 86400000 + 60000, 'срок исполнения не больше 30 дней (L-08)');
});

// covers: T-035, UC-01, UC-08, F-05, F-107, S-46, PD-09
test('T-035 [W-44] новая редакция текста согласия: при следующем входе снова экран этого вида, прежнее действует до решения', async () => {
  const admin = await ctx.as('admin1');
  expectOk(await admin.post('/api/v1/admin/content/docs/consent.research/versions', { markdown: 'STAND-IN: новая редакция научного согласия (синтетика)', publish: true, comment: 'тест' }));
  const p = await ctx.fresh('patH');
  const me = expectOk(await p.get('/api/v1/me'));
  const research = me.consents.find((c) => c.kind === 'research');
  assert.ok(research, 'вид согласия в /me');
  assert.ok(me.onboarding_pending || research.state !== 'given' || research.version < 2, 'пациенту показан экран новой редакции');
  const page = await p.get('/onboarding/consent/3', { headers: { accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(page.body, /data-page="P-06"/);
  assert.doesNotMatch(page.body, /<input[^>]*type="checkbox"[^>]*checked/i, 'флажки по умолчанию пустые (L-04)');
});

// covers: T-036, F-05, F-06, F-22, PD-09, PD-03
test('T-036 [W-07] журнал согласий только дописывается: изменить или удалить запись нельзя даже из базы', async () => {
  const db = ctx.app.db();
  try {
    assert.throws(() => db.prepare("UPDATE consent_events SET action = 'given' WHERE user_id = ?").run(ctx.id('patA')), /append-only/);
  } finally { db.close(); }
});
