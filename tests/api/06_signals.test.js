'use strict';

// Сигналы (F-63): психиатр и психолог видят кризис своего пациента; «Взять в работу» — одна
// условная операция, без двойной обработки; «Связались», исход, «Снять с себя», «Отменить»; S-19.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectError, expectOk } = require('../lib/client');
const F = require('../lib/flows');

const ctx = useApp();

async function newCrisis(patientKey, suffix, fresh = false) {
  const p = fresh ? await ctx.fresh(patientKey) : await ctx.as(patientKey);
  expectOk(await p.post('/api/v1/me/messages', { text: `${F.CRISIS_PHRASE} ${suffix}` }));
  const psy = fresh ? await ctx.fresh('psy1') : await ctx.as('psy1');
  const s = await F.crisisSignalFor(psy, ctx.id(patientKey));
  assert.ok(s, 'сигнал виден психиатру');
  return s;
}

async function resolveAll(patientKey) {
  ctx.app.exec(
    `UPDATE crisis_escalations SET status = 'handled', handled_at = '2026-01-01T00:00:00Z' WHERE patient_id = ${Number(ctx.id(patientKey))}`,
  );
}

// covers: T-090, UC-11, UC-13, F-63, F-65, PD-16, R-03, R-04
test('T-090 [W-25] лента сигналов: психиатр видит кризисы и НЯ, психолог — только кризисы своих пациентов, с минимальной цитатой и «пациенту показан 112»', async () => {
  const s = await newCrisis('patA', 'лента');
  const p = await ctx.as('patA');
  expectOk(
    await p.post('/api/v1/me/adverse-events', {
      symptoms: ['nausea'],
      text: 'Синтетика: тошнота',
      severity: 'noticeable',
      related: 'yes',
    }),
  );
  await F.passUndoWindow(ctx.app);
  const psy = await F.signalsOf(await ctx.as('psy1'));
  assert.ok(
    psy.some((x) => x.kind === 'ae'),
    'психиатр видит НЯ',
  );
  const plg = await F.signalsOf(await ctx.as('plg1'));
  assert.ok(
    plg.some((x) => x.id === s.id),
    'психолог видит кризис',
  );
  assert.ok(!plg.some((x) => x.kind === 'ae'), 'психолог НЯ не видит');
  const card = psy.find((x) => x.id === s.id);
  assert.equal(card.shown_112, true);
  assert.equal(card.status, 'new');
  assert.ok(card.due_at, 'срок реакции «по правилам организации»');
  const plg2 = await F.signalsOf(await ctx.as('plg2'));
  assert.ok(!plg2.some((x) => x.id === s.id), 'незакреплённый психолог сигнала не видит');
});

// covers: T-091, UC-11, F-63, PD-16
test('T-091 [W-25] одновременный «Взять в работу» психиатром и психологом: ровно один успех, второму 409 E-SIGNAL-TAKEN с тем, кто взял и когда', async () => {
  await resolveAll('patA');
  const s = await newCrisis('patA', 'гонка');
  const psy = await ctx.fresh('psy1');
  const plg = await ctx.fresh('plg1');
  const [a, b] = await Promise.all([
    psy.post(`/api/v1/signals/${s.id}/take`, {}),
    plg.post(`/api/v1/signals/${s.id}/take`, {}),
  ]);
  const ok = [a, b].filter((r) => r.status === 200);
  const lost = [a, b].filter((r) => r.status !== 200);
  assert.equal(ok.length, 1, 'взял ровно один');
  const e = expectError(lost[0], 409, 'E-SIGNAL-TAKEN');
  assert.ok(
    e.details.taken_by && e.details.taken_by.name && e.details.taken_by.role && e.details.taken_by.at,
    '«В работе у … (роль) с …»',
  );
  const row = ctx.app.query('SELECT status, taken_by FROM crisis_escalations WHERE id = ?', s.id)[0];
  assert.equal(row.status, 'in_work');
  const takes = ctx.app.query(
    "SELECT count(*) n FROM crisis_incident_log WHERE escalation_id = ? AND event_type = 'taken'",
    s.id,
  )[0].n;
  assert.equal(takes, 1, 'в журнале одно событие захвата');
  for (let i = 0; i < 10; i += 1) {
    await resolveAll('patA');
    const s2 = await newCrisis('patA', `гонка ${i}`);
    const rs = await Promise.all([
      psy.post(`/api/v1/signals/${s2.id}/take`, {}),
      plg.post(`/api/v1/signals/${s2.id}/take`, {}),
    ]);
    assert.equal(rs.filter((r) => r.status === 200).length, 1, `повтор ${i}: без двойного захвата`);
  }
});

// covers: T-092, UC-11, F-63, F-19
test('T-092 [W-25] второй специалист видит «в работе у …» в ленте и уведомлении; кнопка захвата для него неактивна (повтор — тот же ответ)', async () => {
  await resolveAll('patA');
  const s = await newCrisis('patA', 'видимость');
  const psy = await ctx.as('psy1');
  const plg = await ctx.fresh('plg1');
  expectOk(await psy.post(`/api/v1/signals/${s.id}/take`, {}));
  const seen = (await F.signalsOf(plg)).find((x) => x.id === s.id);
  assert.equal(seen.status, 'in_work');
  assert.ok(seen.taken_by && seen.taken_by.name);
  const note = expectOk(await plg.get('/api/v1/notifications')).items.find((n) => n.object && n.object.id === s.id);
  assert.ok(note && /в работе/i.test(`${note.title} ${note.caption || ''}`), 'подпись уведомления «в работе у …»');
  expectError(await plg.post(`/api/v1/signals/${s.id}/take`, {}), 409, 'E-SIGNAL-TAKEN');
  const again = expectOk(await psy.post(`/api/v1/signals/${s.id}/take`, {}));
  assert.equal(again.signal.status, 'in_work', 'повтор тем же пользователем — тот же итог');
});

// covers: T-093, UC-11, F-63, F-17
test('T-093 [W-25] «Связались» из «нового» берёт и обрабатывает одной операцией; повтор — тот же итог; обработанный — E-SIGNAL-HANDLED для другого', async () => {
  await resolveAll('patA');
  const s = await newCrisis('patA', 'связались');
  const plg = await ctx.as('plg1');
  const r = expectOk(await plg.post(`/api/v1/signals/${s.id}/contacted`, {}));
  assert.equal(r.signal.status, 'handled');
  expectOk(await plg.post(`/api/v1/signals/${s.id}/contacted`, {}));
  const psy = await ctx.as('psy1');
  expectError(await psy.post(`/api/v1/signals/${s.id}/take`, {}), 409, 'E-SIGNAL-HANDLED');
});

// covers: T-094, UC-11, F-63
test('T-094 [W-25] исход записывает только взявший; «Снять с себя» требует заметку и возвращает в «новый» с повторным уведомлением всех', async () => {
  await resolveAll('patA');
  const s = await newCrisis('patA', 'исход');
  const psy = await ctx.as('psy1');
  const plg = await ctx.as('plg1');
  expectOk(await psy.post(`/api/v1/signals/${s.id}/take`, {}));
  expectError(await plg.post(`/api/v1/signals/${s.id}/outcome`, { outcome: 'contacted_safe' }), 409, 'E-SIGNAL-TAKEN');
  expectError(await psy.post(`/api/v1/signals/${s.id}/release`, { note: '' }), 422, 'E-VALIDATION');
  const before = ctx.app.query('SELECT count(*) n FROM notifications WHERE object_id = ?', s.id)[0].n;
  const rel = expectOk(await psy.post(`/api/v1/signals/${s.id}/release`, { note: 'Синтетика: передаю коллеге' }));
  assert.equal(rel.signal.status, 'new');
  await F.passUndoWindow(ctx.app);
  const after = ctx.app.query(
    'SELECT count(*) n FROM notifications WHERE object_id = ? AND visible_from IS NOT NULL',
    s.id,
  )[0].n;
  assert.ok(after >= before, 'получатели уведомлены заново');
  expectOk(await plg.post(`/api/v1/signals/${s.id}/take`, {}));
  const out = expectOk(
    await plg.post(`/api/v1/signals/${s.id}/outcome`, { outcome: 'contacted_safe', note: 'Синтетика: связались' }),
  );
  assert.equal(out.signal.status, 'handled');
});

// covers: T-095, UC-11, F-63, F-17, PD-16
test('T-095 [W-25] «Отменить» захвата в окне возвращает «новый»; в журнале инцидентов оба события (только дописывание)', async () => {
  await resolveAll('patA');
  const s = await newCrisis('patA', 'отмена');
  const psy = await ctx.as('psy1');
  const r = expectOk(await psy.post(`/api/v1/signals/${s.id}/take`, {}));
  expectOk(await psy.post(`/api/v1/undo/${r.undo.id}`, {}));
  assert.equal(ctx.app.query('SELECT status FROM crisis_escalations WHERE id = ?', s.id)[0].status, 'new');
  const ev = ctx.app
    .query('SELECT event_type FROM crisis_incident_log WHERE escalation_id = ? ORDER BY id', s.id)
    .map((x) => x.event_type);
  assert.ok(ev.includes('taken') && ev.includes('undo'));
  const db = ctx.app.db();
  try {
    assert.throws(
      () => db.prepare('UPDATE crisis_incident_log SET event_type = ? WHERE escalation_id = ?').run('created', s.id),
      /append-only/,
    );
  } finally {
    db.close();
  }
});

// covers: T-096, UC-11, F-63, F-11, PD-02, PD-20
test('T-096 [W-25] незакреплённый специалист — 404 на сигнал; администратор — 403 и нет «отметить обработанным»', async () => {
  await resolveAll('patA');
  const s = await newCrisis('patA', 'права');
  expectError(await (await ctx.as('psy2')).post(`/api/v1/signals/${s.id}/take`, {}), 404, 'E-NOT-FOUND');
  expectError(await (await ctx.as('plg2')).post(`/api/v1/signals/${s.id}/contacted`, {}), 404, 'E-NOT-FOUND');
  expectError(await (await ctx.as('admin1')).post(`/api/v1/signals/${s.id}/contacted`, {}), 403, 'E-ACCESS');
});

// covers: T-097, UC-11, F-63, F-21, S-19
test('T-097 [W-25] исход не записан за S-19 часов — напоминание взявшему', async () => {
  await resolveAll('patA');
  const s = await newCrisis('patA', 'напоминание');
  const psy = await ctx.as('psy1');
  expectOk(await psy.post(`/api/v1/signals/${s.id}/take`, {}));
  const admin = await ctx.as('admin1');
  expectOk(await F.setSetting(admin, 'crisis.outcome_due_hours', 2));
  await ctx.app.advanceClock(2 * 3600 * 1000 + 60000);
  await ctx.app.waitJobs(10);
  const n = ctx.app.query(
    'SELECT count(*) n FROM notifications WHERE recipient_id = ? AND object_id = ? AND type LIKE ?',
    ctx.id('psy1'),
    s.id,
    '%outcome%',
  )[0].n;
  assert.ok(n >= 1, 'взявшему напомнили записать исход');
});

// covers: T-098, UC-11, UC-16, F-63, F-93, F-21, PD-11
test('T-098 [W-25] взявшего открепили — сигнал сам возвращается в «новый» и уведомляет остальных', async () => {
  await resolveAll('patA');
  const s = await newCrisis('patA', 'открепили', true);
  const plg = await ctx.fresh('plg1');
  expectOk(await plg.post(`/api/v1/signals/${s.id}/take`, {}));
  ctx.app.exec(
    `UPDATE care_assignments SET ended_at = '2026-10-17T00:00:00Z', end_reason = 'admin' WHERE patient_id = ${Number(ctx.id('patA'))} AND clinician_id = ${Number(ctx.id('plg1'))} AND ended_at IS NULL`,
  );
  await ctx.app.waitJobs(10);
  assert.equal(ctx.app.query('SELECT status FROM crisis_escalations WHERE id = ?', s.id)[0].status, 'new');
  expectError(await plg.get(`/api/v1/patients/${ctx.id('patA')}`), 404, 'E-NOT-FOUND');
});
