'use strict';

// covers: F-58, F-11; owner-approved patient overview (2026-10-21).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const Database = require('better-sqlite3');
const { useBrowserApp } = require('../lib/acceptance');
const { expectOk, expectError } = require('../lib/client');
const B = require('../lib/browser');
const F = require('../lib/flows');
const { buildOverview } = require('../../src/modules/patients/overview');
const output = '/tmp/cc-patient-overview';
const ctx = useBrowserApp({
  beforeStart(file, ids) {
    const db = new Database(file);
    const current = new Date().toISOString();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
    const date = (delta) => new Date(Date.parse(`${today}T12:00:00Z`) + delta * 86400000).toISOString().slice(0, 10);
    db.prepare('UPDATE users SET created_at=? WHERE id=?').run(`${date(-40)}T12:00:00Z`, ids.patA);
    const crisis = db.prepare(
      "INSERT INTO crisis_escalations(patient_id,source,tier,status,created_at) VALUES (?,'message',2,?,?)",
    );
    for (let i = 0; i < 60; i++) {
      const row = crisis.run(ids.patA, i === 0 ? 'in_work' : i < 3 ? 'new' : 'handled', current);
      if (i === 0)
        db.prepare('UPDATE crisis_escalations SET taken_by=?,taken_at=? WHERE id=?').run(
          ids.psy1,
          current,
          Number(row.lastInsertRowid),
        );
      if (i === 0)
        for (const event of ['created', 'appended', 'appended'])
          db.prepare(
            'INSERT INTO crisis_incident_log(escalation_id,patient_id,event_type,created_at) VALUES (?,?,?,?)',
          ).run(Number(row.lastInsertRowid), ids.patA, event, current);
    }
    crisis.run(ids.patB, 'new', current);
    for (const [offset, status] of [
      [4, 'scheduled'],
      [-1, 'scheduled'],
      [1, 'cancelled'],
      [2, 'scheduled'],
    ])
      db.prepare(
        "INSERT INTO visits(patient_id,clinician_id,starts_at,format,place,status,created_at,updated_at) VALUES (?,?,?,'remote',?, ?,?,?)",
      ).run(ids.patA, ids.psy1, `${date(offset)}T12:00:00Z`, `Синтетический приём ${offset}`, status, current, current);
    for (const [status, doc, visible] of [
      ['submitted', ids.psy1, current],
      ['related_likely', ids.psy1, current],
      ['submitted', ids.psy1, `${date(3)}T00:00:00Z`],
      ['cancelled', ids.psy1, current],
      ['draft', ids.psy1, current],
      ['submitted', ids.psy2, current],
    ])
      db.prepare(
        'INSERT INTO adverse_events(patient_id,psychiatrist_id,status,description_enc,visible_from,created_at) VALUES (?,?,?,?,?,?)',
      ).run(ids.patA, doc, status, 'Синтетическая жалоба <script>не выполнять</script>', visible, current);
    for (const [offset, mood, sleep, anxiety] of [
      [-13, 2, 'bad', 'strong'],
      [-3, 3, 'ok', 'some'],
      [-1, 4, 'good', 'none'],
    ])
      db.prepare(
        'INSERT INTO mood_entries(patient_id,entry_date,mood,sleep,anxiety,note,created_at) VALUES (?,?,?,?,?,?,?)',
      ).run(ids.patA, date(offset), mood, sleep, anxiety, 'PRIVATE-NOTE-CANARY', current);
    // Latest record for the day wins, hidden records and old dates stay out.
    db.prepare('INSERT INTO mood_entries(patient_id,entry_date,mood,created_at) VALUES (?,?,5,?)').run(
      ids.patA,
      date(-1),
      current,
    );
    db.prepare('INSERT INTO mood_entries(patient_id,entry_date,mood,created_at) VALUES (?,?,1,?)').run(
      ids.patA,
      date(-20),
      current,
    );
    db.close();
  },
});

test('overview: complete counts, appended occurrences, privacy, daily facts and earliest future visit', async () => {
  const doctor = await ctx.api('psy1');
  const res = expectOk(await doctor.get(`/api/v1/patients/${ctx.app.ids.patA}?tab=overview`));
  const o = res.overview;
  assert.equal(o.days_in_system, 40);
  assert.deepEqual(o.crisis, { total: 60, new: 2, in_work: 1, handled: 57, occurrences: 62, active: 3 });
  assert.match(o.next_visit.place, /приём 2$/);
  assert.equal(o.adverse_events.total, 2);
  assert.equal(o.adverse_events.pending, 1);
  assert.equal(o.diary.days.length, 3);
  assert.equal(o.diary.days.at(-1).mood, 5);
  assert.equal(o.diary.days.at(-1).sleep_score, undefined);
  assert.doesNotMatch(JSON.stringify(res), /PRIVATE-NOTE-CANARY/);
  assert.ok(
    ctx.app.query(
      "SELECT 1 FROM phi_access_log WHERE actor_id=? AND patient_id=? AND section='overview'",
      ctx.app.ids.psy1,
      ctx.app.ids.patA,
    ).length,
  );
  const db = ctx.app.db();
  try {
    const boundary = buildOverview(
      db,
      ctx.app.ids.patA,
      { id: ctx.app.ids.psy1, role: 'psychiatrist' },
      '2026-10-21T22:00:00Z',
      'Asia/Vladivostok',
    );
    assert.equal(boundary.today, '2026-10-22');
    assert.equal(boundary.diary.from, '2026-10-09');
  } finally {
    db.close();
  }
});

test('overview: access denied to another doctor, patient, admin and removed assignment; psychologist gets no therapy or AE', async () => {
  const pid = ctx.app.ids.patA;
  const other = await ctx.api('psy2');
  expectError(await other.get(`/api/v1/patients/${pid}?tab=overview`), 404, 'E-NOT-FOUND');
  for (const role of ['patA', 'admin1']) {
    const c = await ctx.api(role);
    expectError(await c.get(`/api/v1/patients/${pid}?tab=overview`), 403, 'E-ACCESS');
  }
  const psych = await ctx.api('plg1');
  const o = expectOk(await psych.get(`/api/v1/patients/${pid}?tab=overview`)).overview;
  assert.equal(o.patient_meds, null);
  assert.equal(o.adverse_events, null);
  ctx.app.exec(
    `UPDATE care_assignments SET ended_at='2026-10-21T00:00:00Z' WHERE patient_id=${pid} AND clinician_id=${ctx.app.ids.plg1}`,
  );
  expectError(await psych.get(`/api/v1/patients/${pid}?tab=overview`), 404, 'E-NOT-FOUND');
});

test('overview browser: readable metrics, sparse charts, treatment source, desktop/mobile and empty/error states', async () => {
  fs.mkdirSync(output, { recursive: true });
  const doctor = await ctx.api('psy1');
  const inn = await F.innId(doctor, 'сертралин');
  await F.publishPlan(ctx.app, doctor, ctx.app.ids.patA, [{ inn_id: inn, dose: 75, unit: 'мг', times: ['утро'] }]);
  const { ctx: browserContext, page } = await B.contextAs(ctx.browser, ctx.app, 'psy1', {
    viewport: { width: 1440, height: 1000 },
  });
  ctx.track(browserContext);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await B.open(page, ctx.app, `/work/patients/${ctx.app.ids.patA}`);
  await page.locator(B.tid('msg.overview.crisis')).waitFor();
  const root = page.locator('.patient-overview');
  assert.match(await root.textContent(), /62/);
  assert.match(await page.locator(B.tid('msg.overview.visit')).textContent(), /приём 2/);
  assert.match(await page.locator(B.tid('msg.overview.meds')).textContent(), /сертралин/i);
  assert.match(await page.locator(B.tid('msg.overview.meds')).textContent(), /75/);
  assert.match(await page.locator(B.tid('msg.overview.meds')).textContent(), /ещё не подтвердил/);
  assert.equal(await root.locator('script').count(), 0);
  assert.equal(await root.locator('svg').count(), 3);
  assert.equal(await root.locator('.ov-mood .ov-point').count(), 3);
  assert.equal(await root.locator('.ov-mood .ov-line').count(), 0, 'missing days do not get a connecting line');
  assert.match(await root.textContent(), /Дней с оценкой: 3 из 14/);
  await root.locator('summary').click();
  assert.equal(await root.locator('tbody tr').count(), 3);
  await root.locator('summary').click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await B.noHorizontalOverflow(page));
    await page.evaluate(() => {
      document.querySelector('.pcard .scroll').scrollTop = 0;
    });
    await page.screenshot({ path: `${output}/overview-${width}.png` });
    await page.locator('[data-testid="msg.overview.dynamics"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}/dynamics-${width}.png` });
    await page.locator('[data-testid="msg.overview.meds"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}/medications-${width}.png` });
  }
  const a11y = await B.axeViolations(page);
  assert.deepEqual(a11y, []);
  await B.open(page, ctx.app, `/work/patients/${ctx.app.ids.patH}`);
  await page.locator(B.tid('msg.overview.crisis')).waitFor();
  assert.match(await root.textContent(), /Необработанных сигналов нет/);
  assert.match(await root.textContent(), /Не запланирован/);
  assert.equal(await root.locator('svg').count(), 0);
  assert.equal(await root.locator('.ov-chart-empty').count(), 3);
  await page.evaluate(() => {
    document.querySelector('.pcard .scroll').scrollTop = 0;
  });
  await page.screenshot({ path: `${output}/empty-390.png` });
  await page.route('**/api/v1/patients/*?tab=overview', (route) => route.fulfill({ status: 500, body: '{}' }));
  await page.reload();
  await page.locator(B.tid('msg.overview.retry')).waitFor();
  assert.match(await root.textContent(), /Не удалось загрузить/);
  assert.doesNotMatch(await root.textContent(), /Необработанных сигналов нет/);
  await page.unroute('**/api/v1/patients/*?tab=overview');
  await page.locator(B.tid('msg.overview.retry')).click();
  await page.locator(B.tid('msg.overview.crisis')).waitFor();
  assert.deepEqual(errors, []);
});

test('overview: accepted product, patient dose, own medicine, changed plan and expired medicine stay distinct', async () => {
  const p = await ctx.api('patA');
  const doctor = await ctx.api('psy1');
  const inn = await F.innId(p, 'сертралин');
  const product = await F.productOf(p, inn, 'Золофт');
  const item = expectOk(await p.get('/api/v1/me/meds')).plan_items.find((i) => i.inn_id === inn);
  expectOk(
    await p.post(`/api/v1/me/plan-items/${item.item_key}/accept`, {
      product_id: product.id,
      dose: 50,
      dose_unit: 'мг',
    }),
  );
  const atarax = await F.productOf(p, await F.innId(p, 'гидроксизин'), 'Атаракс');
  const own = expectOk(
    await p.post('/api/v1/me/patient-meds', { product_id: atarax.id, dose: 25, unit: 'мг', times: ['на ночь'] }),
  );
  await F.passUndoWindow(ctx.app);
  const session = await B.contextAs(ctx.browser, ctx.app, 'psy1', B.PHONE);
  ctx.track(session.ctx);
  const page = session.page;
  const meds = page.locator(B.tid('msg.overview.meds'));
  await B.open(page, ctx.app, `/work/patients/${ctx.app.ids.patA}`);
  await meds.waitFor();
  assert.match(await meds.textContent(), /Пациент подтвердил назначение/);
  assert.match(await meds.textContent(), /Пациент выбрал: Золофт/);
  assert.match(await meds.textContent(), /Пациент указал свою дозу: 50 мг/);
  assert.match(await meds.textContent(), /Пациент добавил самостоятельно/);
  assert.match(await meds.textContent(), /Атаракс/);
  await F.publishPlan(ctx.app, doctor, ctx.app.ids.patA, [{ inn_id: inn, dose: 100, unit: 'мг', times: ['утро'] }]);
  await page.reload();
  await meds.waitFor();
  assert.match(await meds.textContent(), /Назначение изменено/);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await F.publishPlan(ctx.app, doctor, ctx.app.ids.patA, [
    { inn_id: inn, dose: 100, unit: 'мг', times: ['утро'], until: yesterday },
  ]);
  ctx.app.exec(`UPDATE patient_meds SET status='ended' WHERE id=${own.med.id}`);
  const summary = expectOk(await doctor.get(`/api/v1/patients/${ctx.app.ids.patA}?tab=overview`));
  assert.deepEqual(summary.overview.patient_meds, []);
  await page.reload();
  await meds.waitFor();
  assert.match(await meds.textContent(), /Текущих назначений в системе нет/);
  assert.doesNotMatch(await meds.textContent(), /сертралин|Атаракс/i);
  await page.route('**/api/v1/patients/*/plan', (route) => route.fulfill({ status: 500, body: '{}' }));
  await page.reload();
  await meds.waitFor();
  assert.match(await meds.textContent(), /Не удалось загрузить назначения/);
  assert.doesNotMatch(await meds.textContent(), /Текущих назначений в системе нет/);
});
