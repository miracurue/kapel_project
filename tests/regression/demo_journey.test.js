'use strict';

// covers: F-78, PD-24 — a coherent fictional journey and unchanged server access rules.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../lib/app');
const { Client, expectOk, expectError } = require('../lib/client');
const { seedJourney } = require('../../scripts/seed-demo-journey');
const { PEOPLE } = require('../../src/modules/demo/scenario');

test('fictional journey: additive, atomic, idempotent, correct demo identities and role boundaries', async () => {
  const app = await startApp({ demo: true, seed: true });
  try {
    const db = app.db();
    let seeded;
    try {
      const oldPatient = db.prepare('SELECT * FROM users WHERE id=?').get(app.ids.patA);
      assert.throws(() => seedJourney(db, { ...app.env, DATA_MODE: 'real' }), /Requires/);
      seeded = seedJourney(db, app.env);
      assert.equal(seeded.seeded, true);
      assert.deepEqual(seedJourney(db, app.env), { skipped: true });
      assert.deepEqual(db.prepare('SELECT * FROM users WHERE id=?').get(app.ids.patA), oldPatient);
      const pid = seeded.ids.patient;
      assert.equal(
        db.prepare('SELECT count(*) n FROM care_assignments WHERE patient_id=? AND ended_at IS NULL').get(pid).n,
        2,
      );
      const results = db.prepare('SELECT * FROM online_results WHERE patient_id=? ORDER BY created_at').all(pid);
      assert.deepEqual(
        results.map((r) => r.total_score),
        [16, 8],
      );
      for (const r of results)
        assert.equal(
          Object.values(JSON.parse(r.answers_json)).reduce((sum, v) => sum + Number(v), 0),
          r.total_score,
        );
      const events = db.prepare('SELECT * FROM med_log WHERE patient_id=?').all(pid);
      assert.equal(events.length, 54);
      assert.equal(events.filter((e) => e.status === 'skipped').length, 1);
      assert.ok(events.every((e) => e.day < new Date().toISOString().slice(0, 10)));
      const firstPsych = db
        .prepare('SELECT started_at FROM care_assignments WHERE patient_id=? AND clinician_id=?')
        .get(pid, seeded.ids.psychologist).started_at;
      const firstDoc = db
        .prepare('SELECT started_at FROM care_assignments WHERE patient_id=? AND clinician_id=?')
        .get(pid, seeded.ids.psychiatrist).started_at;
      assert.ok(firstPsych < results[0].created_at && results[0].created_at < firstDoc);
      assert.equal(
        db
          .prepare("SELECT count(*) n FROM consent_events WHERE user_id=? AND consent_kind IN ('research','program')")
          .get(pid).n,
        0,
      );
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    } finally {
      db.close();
    }
    const clients = {};
    for (const role of ['patient', 'psychologist', 'psychiatrist']) {
      const c = new Client(app.base);
      const login = expectOk(await c.post('/api/v1/demo/login-as', { role }, { idem: false }));
      c.csrf = null;
      assert.equal(login.user.id, seeded.ids[role]);
      assert.equal(login.user.display_name, PEOPLE[role].name);
      clients[role] = c;
    }
    const pid = seeded.ids.patient;
    const messages = expectOk(await clients.patient.get('/api/v1/me/messages'));
    assert.equal(messages.recipients.length, 2);
    assert.match(JSON.stringify(messages), /психиатру/);
    const meds = expectOk(await clients.patient.get('/api/v1/me/meds'));
    assert.match(JSON.stringify(meds), /Авиандр/);
    assert.equal(meds.plan_items[0].dose, 20);
    const flower = expectOk(await clients.patient.get('/api/v1/me/flower'));
    assert.equal(flower.steps, 0);
    assert.equal(flower.stage.key, 'sprout');
    assert.ok(flower.balance >= 1000);
    assert.equal(flower.can_water, true);
    const water = expectOk(await clients.patient.post('/api/v1/me/flower/water', {}));
    assert.equal(water.steps, 20);
    assert.equal(water.balance, flower.balance - 40);
    const afterWater = app.db();
    try {
      seedJourney(afterWater, app.env);
    } finally {
      afterWater.close();
    }
    const same = expectOk(await clients.patient.get('/api/v1/me/flower'));
    assert.equal(same.steps, water.steps);
    assert.equal(same.balance, water.balance);
    expectOk(await clients.psychiatrist.get(`/api/v1/patients/${pid}?tab=treatment`));
    expectOk(await clients.psychologist.get(`/api/v1/patients/${pid}?tab=tests`));
    expectError(await clients.psychologist.get(`/api/v1/patients/${pid}/plan`), 403, 'E-ACCESS');
    const other = new Client(app.base);
    expectOk(await other.login('psy2@cc.example.test'));
    expectError(await other.get(`/api/v1/patients/${pid}/plan`), 404, 'E-NOT-FOUND');
  } finally {
    await app.stop();
  }
});
