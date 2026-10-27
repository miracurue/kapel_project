'use strict';
// covers: геймификация цветка (вход, методики раз в день, тест раз в день за тест, тёплые фразы, форма обращения, режимы, расчёт роста).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const { RULES, DAILY_MAX, STEP_PRICE, MAX_STEPS } = require('../../src/modules/flower/rules');
const phrases = require('../../src/modules/flower/phrases');
const ctx = useApp();

test('login gives drops once per day and is reported as fresh', async () => {
  const p = await ctx.as('patD');
  const s = expectOk(await p.get('/api/v1/me/flower'));
  assert.ok(s.fresh.items.some((x) => x.action === 'login' && x.amount === RULES.login.drops));
  assert.ok(s.today_keys.includes(`login:${s.day}`));
  assert.ok('greeting' in s, 'приветствие приходит полем (может быть null ночью или в тихом режиме)');
  const again = expectOk(await p.get('/api/v1/me/flower'));
  assert.equal(again.fresh.gained, 0);
  assert.equal(again.balance, s.balance);
});

test('a technique pays once per day per technique and rejects unknown ones', async () => {
  const p = await ctx.as('patB');
  expectOk(await p.get('/api/v1/me/flower')); // вход и знакомство уже начислены
  const first = expectOk(await p.post('/api/v1/me/flower/technique', { slug: 'breathing-box' }));
  assert.equal(first.gained, RULES.technique.drops);
  assert.ok(first.today_keys.includes(`technique:breathing-box:${first.day}`));
  const repeat = expectOk(await p.post('/api/v1/me/flower/technique', { slug: 'breathing-box' }));
  assert.equal(repeat.gained, 0, 'та же методика в тот же день капелек не даёт');
  assert.equal(repeat.balance, first.balance);
  const other = expectOk(await p.post('/api/v1/me/flower/technique', { slug: 'grounding-54321' }));
  assert.equal(other.gained, RULES.technique.drops);
  assert.equal(other.left.technique, 0, 'дневной предел методик исчерпан, цифры в рисунке нет');
  expectError(await p.post('/api/v1/me/flower/technique', { slug: 'nope' }), 422, 'E-VALIDATION');
  expectError(await p.post('/api/v1/me/flower/technique', {}), 422, 'E-VALIDATION');
  const rows = ctx.app.query('SELECT count(*) n FROM technique_runs WHERE patient_id=?', ctx.id('patB'))[0].n;
  assert.equal(rows, 2);
  const doc = await ctx.as('psy1');
  expectError(await doc.post('/api/v1/me/flower/technique', { slug: 'breathing-box' }), 403, 'E-ACCESS');
});

test('the same test twice in a day pays once, the technique page shows the reward hint only to patients (no «done» button: drops come on finishing)', async () => {
  const p = await ctx.as('patA');
  const doc = await ctx.as('psy1');
  const start = expectOk(await p.get('/api/v1/me/flower')).balance;
  const a = await F.assignTest(ctx.app, doc, ctx.id('patA'), 'bai');
  await F.completeTest(p, a.id);
  const one = expectOk(await p.get('/api/v1/me/flower')).balance;
  assert.equal(one - start, RULES.test.drops);
  const b = await F.assignTest(ctx.app, doc, ctx.id('patA'), 'bai');
  await F.completeTest(p, b.id);
  const two = expectOk(await p.get('/api/v1/me/flower')).balance;
  assert.equal(two, one, 'тот же тест в тот же день капелек не даёт');
  const page = (await p.get('/methods/breathing-box')).body;
  // test-change: кнопка «Я выполнил(а)» убрана по запросу владелицы 2026-10-26, капельки идут за пройденное упражнение
  assert.doesNotMatch(page, /data-technique-done/);
  assert.match(page, /data-technique-app="breathing-box"/);
  assert.match(page, /data-flower-badge="technique"/);
  const doctorPage = (await doc.get('/methods/breathing-box')).body;
  assert.match(doctorPage, /data-technique-app="breathing-box"/);
  assert.doesNotMatch(doctorPage, /data-flower-badge/);
});

test('warm messages: one per kind per day, 10 minute gap, modes and crisis silence', async () => {
  const p = await ctx.as('patG');
  const first = expectOk(await p.post('/api/v1/me/flower/message', { action: 'diary' }));
  assert.ok(first.message?.text, 'первое окошко за день показывается');
  assert.ok(first.message.key.startsWith('diary.'));
  const quick = expectOk(await p.post('/api/v1/me/flower/message', { action: 'habit' }));
  assert.equal(quick.message, null, 'не чаще одного окошка за 10 минут');
  const sameKind = expectOk(await p.post('/api/v1/me/flower/message', { action: 'diary' }));
  assert.equal(sameKind.message, null);
  expectError(await p.post('/api/v1/me/flower/message', { action: 'zzz' }), 422, 'E-VALIDATION');
  const doc = await ctx.as('psy1');
  expectError(await doc.post('/api/v1/me/flower/message', { action: 'diary' }), 403, 'E-ACCESS');
});

test('quiet and off modes, address form and crisis silence', async () => {
  const q = await ctx.as('patH');
  expectOk(await q.patch('/api/v1/me/prefs', { praise_mode: 'quiet' }));
  assert.equal(expectOk(await q.post('/api/v1/me/flower/message', { action: 'diary' })).message, null);
  const prefs = expectOk(await q.get('/api/v1/me/prefs'));
  assert.equal(prefs.praise_mode, 'quiet');
  assert.equal(prefs.address_form, 'n');
  expectOk(await q.patch('/api/v1/me/prefs', { address_form: 'f', praise_mode: 'normal' }));
  assert.equal(expectOk(await q.get('/api/v1/me/prefs')).address_form, 'f');
  expectError(await q.patch('/api/v1/me/prefs', { address_form: 'x' }), 422, 'E-VALIDATION');
  // Тревожный результат за последние минуты: окошек нет.
  const pid = ctx.id('patH');
  ctx.app.exec(
    `INSERT INTO online_results(patient_id,instrument,answers_json,total_score,risk_flag,created_at) VALUES (${pid},'phq9','[]',20,1,'${new Date().toISOString()}')`,
  );
  assert.equal(expectOk(await q.post('/api/v1/me/flower/message', { action: 'diary' })).message, null);
});

test('phrase bank: neutral forms never use gendered praise, praise exists in both forms, every action has support', () => {
  const GENDERED = /молодец|умница|умный|умная/i;
  for (const action of phrases.ACTIONS) {
    const bank = phrases.BANK[action];
    assert.ok(bank.length >= 3, `${action}: мало фраз`);
    assert.equal(new Set(bank.map((x) => x.id)).size, bank.length, `${action}: повтор номеров`);
    for (const x of bank) {
      const n = phrases.textFor(x, 'n');
      assert.ok(n && !GENDERED.test(n), `${action}.${x.id}: нейтральная форма с родом`);
      if (x.tone === 'praise') {
        assert.match(phrases.textFor(x, 'f'), /умница/);
        assert.match(phrases.textFor(x, 'm'), /молодец/);
      }
    }
  }
  const total = phrases.ACTIONS.flatMap((a) => phrases.BANK[a]);
  const praise = total.filter((x) => x.tone === 'praise').length;
  assert.ok(praise / total.length < 0.15, 'оценочных фраз («молодец/умница») меньше 15%');
  for (const action of ['diary', 'test', 'med', 'ai', 'note', 'article', 'visit']) {
    assert.ok(
      !phrases.BANK[action].some((x) => x.tone === 'praise'),
      `${action}: нет оценочных фраз за запись и результат`,
    );
  }
});

test('growth arithmetic: a regular patient fills the flower in about three weeks, a maxed one never faster than two', () => {
  const usual =
    RULES.login.drops + RULES.diary.drops + 2 * RULES.habit.drops + 2 * RULES.med.drops + RULES.technique.drops;
  assert.ok(usual >= 30 && usual <= 40, `обычный день ${usual}`);
  const total = MAX_STEPS * STEP_PRICE;
  const days = Math.ceil(total / (usual + 5));
  assert.ok(days >= 18 && days <= 24, `регулярный пользователь: ${days} дней`);
  assert.ok(total / DAILY_MAX >= 14, 'даже максимум каждый день — не быстрее двух недель');
});
