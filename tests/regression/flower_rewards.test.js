'use strict';
// covers: цветок и капельки пациента (начисление, лимиты, идемпотентность, полив, права, стирание, выгрузка).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const { PASSWORD } = require('../fixtures/world');
const F = require('../lib/flows');
const { RULES, DAILY_MAX, STEP_PRICE, MAX_STEPS, STAGES } = require('../../src/modules/flower/rules');
const ctx = useApp();
const gain = (res) => Number(res.headers.get('x-flower-gain'));
const give = (pid, action, amount, key, day) =>
  ctx.app.exec(
    `INSERT INTO flower_ledger(patient_id,kind,action,amount,steps,idem_key,source,day,created_at) VALUES (${pid},'earn','${action}',${amount},0,'${key}','test','${day}','${new Date().toISOString()}')`,
  );

test('a new patient starts with an empty seedling and a readable list of sources', async () => {
  const p = await ctx.as('patC');
  const s = expectOk(await p.get('/api/v1/me/flower'));
  assert.equal(s.balance, RULES.start.drops, 'знакомство уже пройдено: единственная награда за старт');
  assert.equal(s.recent.length, 1);
  assert.equal(s.steps, 0);
  assert.equal(s.stage.key, 'sprout');
  assert.equal(s.stage.index, 1);
  assert.equal(s.next.key, 'crown');
  assert.equal(s.next.drops_to_go, STAGES[1].from * STEP_PRICE - s.balance);
  assert.equal(s.can_water, s.balance >= STEP_PRICE);
  assert.deepEqual(s.sources.map((x) => x.action).sort(), Object.keys(RULES).sort());
});

test('diary entry gives drops once per day, a test gives drops once per result', async () => {
  const p = await ctx.as('patA');
  const start = expectOk(await p.get('/api/v1/me/flower')).balance;
  const first = await p.post('/api/v1/me/diary', { mood: 4 });
  expectOk(first);
  assert.equal(gain(first), RULES.diary.drops);
  assert.equal(Number(first.headers.get('x-flower-balance')), start + RULES.diary.drops);
  const second = await p.post('/api/v1/me/diary', { mood: 3 });
  expectOk(second);
  assert.equal(gain(second), 0, 'второй ответ за тот же день капелек не даёт');
  const doc = await ctx.as('psy1');
  const a = await F.assignTest(ctx.app, doc, ctx.id('patA'), 'bai');
  await F.completeTest(p, a.id);
  const state = expectOk(await p.get('/api/v1/me/flower'));
  assert.equal(state.balance, start + RULES.diary.drops + RULES.test.drops);
  const again = expectOk(await p.get('/api/v1/me/flower'));
  assert.equal(again.balance, state.balance, 'повторный просмотр состояния не начисляет');
  assert.ok(state.recent.every((r) => r.amount > 0));
  assert.ok(!JSON.stringify(state).includes('Марина'), 'в ответе нет имён и текстов');
});

test('the daily limit truncates rewards and a capped event does not pay out later', async () => {
  const p = await ctx.as('patB');
  const pid = ctx.id('patB');
  const { day } = expectOk(await p.get('/api/v1/me/flower'));
  const used = expectOk(await p.get('/api/v1/me/flower')).today_drops;
  give(pid, 'plan', DAILY_MAX - 1 - used, 'seed-cap', day);
  const r = await p.post('/api/v1/me/diary', { mood: 2 });
  expectOk(r);
  assert.equal(gain(r), 1, 'остаток дневного предела');
  const total = ctx.app.query(
    "SELECT SUM(amount) n FROM flower_ledger WHERE patient_id=? AND kind='earn' AND day=?",
    pid,
    day,
  )[0].n;
  assert.equal(total, DAILY_MAX);
  const n = await p.post('/api/v1/me/diary', { mood: 5 });
  expectOk(n);
  assert.equal(gain(n), 0);
});

test('watering spends drops, grows steps, is idempotent and never goes negative', async () => {
  const p = await ctx.as('patD');
  const pid = ctx.id('patD');
  const { day } = expectOk(await p.get('/api/v1/me/flower'));
  const base = expectOk(await p.get('/api/v1/me/flower')).balance;
  expectOk(await p.post('/api/v1/me/flower/water', {}));
  expectError(await p.post('/api/v1/me/flower/water', {}), 409, 'E-STATUS');
  give(pid, 'diary', 3, 'seed-1', day);
  give(pid, 'test', 4, 'seed-2', day);
  const before = expectOk(await p.get('/api/v1/me/flower'));
  assert.equal(before.balance, 7 + (base % STEP_PRICE));
  const open = before.balance;
  assert.equal(before.can_water, true);
  expectError(await p.post('/api/v1/me/flower/water', { steps: 0.5 }), 422, 'E-VALIDATION');
  expectError(await p.post('/api/v1/me/flower/water', { steps: 99 }), 422, 'E-VALIDATION');
  const key = 'water-key-1';
  const one = expectOk(await p.post('/api/v1/me/flower/water', { steps: 2 }, { idem: key }));
  assert.deepEqual(one.watered, { steps: 2, drops: 2 * STEP_PRICE });
  assert.equal(one.balance, open - 2 * STEP_PRICE);
  assert.equal(one.steps, 2 + Math.floor(base / STEP_PRICE));
  const replay = expectOk(await p.post('/api/v1/me/flower/water', { steps: 2 }, { idem: key }));
  assert.equal(replay.balance, one.balance, 'повтор с тем же ключом ничего не списывает');
  expectError(await p.post('/api/v1/me/flower/water', { steps: 1 }, { idem: key }), 409, 'E-IDEMPOTENCY-MISMATCH');
  const rest = expectOk(await p.post('/api/v1/me/flower/water', {}));
  assert.equal(rest.balance, open % STEP_PRICE);
  expectError(await p.post('/api/v1/me/flower/water', {}), 409, 'E-STATUS');
  const sum = ctx.app.query('SELECT SUM(amount) a, SUM(steps) s FROM flower_ledger WHERE patient_id=?', pid)[0];
  assert.equal(sum.a, rest.balance);
  assert.equal(sum.s, rest.steps);
  assert.throws(() => ctx.app.exec('UPDATE flower_ledger SET amount=amount+100'), /append-only/);
});

test('full growth stops watering but keeps the balance', async () => {
  const p = await ctx.as('patG');
  const pid = ctx.id('patG');
  const { day } = expectOk(await p.get('/api/v1/me/flower'));
  const at = new Date().toISOString();
  ctx.app.exec(
    `INSERT INTO flower_ledger(patient_id,kind,action,amount,steps,idem_key,source,day,created_at) VALUES (${pid},'earn','diary',10,0,'seed-full','t','${day}','${at}'),(${pid},'spend','water',-${MAX_STEPS * STEP_PRICE},${MAX_STEPS},'water:seed','','${day}','${at}')`,
  );
  const s = expectOk(await p.get('/api/v1/me/flower'));
  assert.equal(s.full, true);
  assert.equal(s.stage.key, 'bloom');
  assert.equal(s.next, null);
  assert.equal(s.can_water, false);
  const err = expectError(await p.post('/api/v1/me/flower/water', {}), 409, 'E-STATUS');
  assert.equal(err.reason, 'full');
});

test('only the patient sees the flower, and only their own', async () => {
  const guest = await ctx.guest();
  assert.equal((await guest.get('/api/v1/me/flower')).status, 401);
  for (const who of ['psy1', 'plg1', 'admin1']) {
    const c = await ctx.as(who);
    expectError(await c.get('/api/v1/me/flower'), 403, 'E-ACCESS');
    expectError(await c.post('/api/v1/me/flower/water', {}), 403, 'E-ACCESS');
  }
  const a = expectOk(await (await ctx.as('patA')).get('/api/v1/me/flower'));
  const c = expectOk(await (await ctx.as('patC')).get('/api/v1/me/flower'));
  assert.notEqual(a.balance, c.balance);
});

test('analytics view has no patient id, and erasure removes the flower', async () => {
  const p = await ctx.as('patH');
  const pid = ctx.id('patH');
  expectOk(await p.post('/api/v1/me/diary', { mood: 3 }));
  assert.ok(ctx.app.query('SELECT count(*) n FROM flower_ledger WHERE patient_id=?', pid)[0].n > 0);
  assert.ok(ctx.app.query('SELECT count(*) n FROM analytics_flower_events')[0].n > 0);
  const cols = ctx.app.query('PRAGMA table_info(analytics_flower_events)').map((c) => c.name);
  assert.ok(!cols.includes('patient_id'), 'представление для аналитики без идентификатора');
  expectOk(await p.post('/api/v1/me/deletion-request', { password: PASSWORD, confirm: true }));
  const admin = await ctx.as('admin1');
  const q = expectOk(await admin.get('/api/v1/admin/requests?filter=open')).items.find((i) => i.kind === 'erasure');
  expectOk(
    await admin.post(`/api/v1/admin/requests/${q.id}/execute-erasure`, {
      confirm_service_no: q.patient_no,
      confirm: true,
    }),
  );
  assert.equal(ctx.app.query('SELECT count(*) n FROM flower_ledger WHERE patient_id=?', pid)[0].n, 0);
  assert.equal(ctx.app.query('SELECT count(*) n FROM flower_state WHERE patient_id=?', pid)[0].n, 0);
});

test('questions to the assistant, notes and old diary days follow their own caps and rules', async () => {
  const p = await ctx.as('patI');
  const pid = ctx.id('patI');
  const base = expectOk(await p.get('/api/v1/me/flower')).balance;
  const at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  ctx.app.exec(`INSERT INTO ai_threads(owner_user_id,role,patient_id) VALUES (${pid},'patient',${pid})`);
  const thread = ctx.app.query('SELECT id FROM ai_threads WHERE owner_user_id=?', pid)[0].id;
  for (let i = 0; i < 4; i += 1)
    ctx.app.exec(
      `INSERT INTO ai_messages(thread_id,role,text,created_at) VALUES (${thread},'user','вопрос ${i}','${at}')`,
    );
  ctx.app.exec(
    `INSERT INTO ai_messages(thread_id,role,text,kind,created_at) VALUES (${thread},'user','кризис','crisis','${at}')`,
  );
  const r = await p.post('/api/v1/me/diary', { day: '2026-01-05', mood: 2 });
  expectOk(r);
  const after = expectOk(await p.get('/api/v1/me/flower'));
  assert.equal(after.balance - base, RULES.ai.dailyCap, 'вопросов засчитано не больше дневного предела');
  const kinds = ctx.app.query(
    "SELECT action,COUNT(*) n FROM flower_ledger WHERE patient_id=? AND idem_key LIKE 'ai:%' GROUP BY action",
    pid,
  );
  assert.equal(kinds[0].n, 4, 'лишние вопросы закрыты нулевой записью, чтобы не выплатиться завтра');
  assert.equal(
    ctx.app.query("SELECT COUNT(*) n FROM flower_ledger WHERE patient_id=? AND idem_key LIKE 'diary:2026%'", pid)[0].n,
    0,
    'запись задним числом капелек не даёт',
  );
});
