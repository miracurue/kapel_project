'use strict';
// covers: F-09, F-47; пуши о напоминаниях пациента (Web Push, решение владелицы 2026-10-26) и собственные времена напоминаний:
// подписка только от служб доставки браузеров, нейтральный текст, раз в сутки, тихие часы, личное время приёма и дневника.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const { createPush, TITLE, BODY } = require('../../src/modules/patient/push');
const { dueReminders } = require('../../src/modules/patient/reminders');
const ctx = useApp({ env: { PUSH_MODE: 'dry' } });

const sub = (host = 'fcm.googleapis.com', id = 'abc') => ({
  endpoint: `https://${host}/fcm/send/${id}-endpoint-token`,
  keys: {
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
});
const at = (offsetDays, utcHour) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(utcHour, 0, 0, 0);
  return d;
};

test('подписка: ключ и состояние в настройках; адрес принимается только от служб доставки браузеров', async () => {
  const p = await ctx.as('patB');
  const prefs = expectOk(await p.get('/api/v1/me/prefs'));
  assert.equal(prefs.push.available, true);
  assert.match(prefs.push.public_key, /^[A-Za-z0-9_-]{60,}$/);
  assert.equal(prefs.push.subscribed, false);
  for (const bad of [
    sub('evil.example.com'),
    sub('127.0.0.1'),
    { ...sub(), endpoint: 'http://fcm.googleapis.com/x-endpoint-token-1' },
    { endpoint: 'https://fcm.googleapis.com/x', keys: {} },
  ]) {
    expectError(await p.patch('/api/v1/me/prefs', { push_subscription: bad }), 422, 'E-VALIDATION');
  }
  expectOk(await p.patch('/api/v1/me/prefs', { push_subscription: sub() }));
  assert.equal(expectOk(await p.get('/api/v1/me/prefs')).push.subscribed, true);
  expectOk(await p.patch('/api/v1/me/prefs', { push_subscription: null }));
  assert.equal(expectOk(await p.get('/api/v1/me/prefs')).push.subscribed, false);
});

test('отправка: нейтральный текст, раз в сутки на напоминание, тихие часы, без подписки не шлём', async () => {
  const psy = await ctx.as('psy1');
  const patient = await ctx.as('patA');
  await F.sertralinePrescribedAndAccepted(ctx.app, psy, patient, ctx.id('patA'));
  expectOk(
    await patient.patch('/api/v1/me/prefs', { push_subscription: sub('updates.push.services.mozilla.com', 'patA') }),
  );
  const db = ctx.app.db();
  try {
    const sent = [];
    const fake = {
      sendNotification: async (s, payload) => sent.push(JSON.parse(payload)),
      generateVAPIDKeys: () => ({}),
    };
    let current = at(1, 12);
    const config = {
      pushMode: 'webpush',
      dataDir: ctx.app.dataDir || '/tmp',
      vapidPublicKey: 'pub',
      vapidPrivateKey: 'priv',
      baseUrl: 'http://127.0.0.1',
    };
    const push = createPush({ db, config, now: () => current, webpush: fake });
    assert.equal(await push.deliverDue({ timezone: 'UTC' }), 1);
    assert.equal(sent.length, 1);
    assert.deepEqual({ title: sent[0].title, body: sent[0].body }, { title: TITLE, body: BODY });
    assert.ok(!/сертралин|лекарств|приём/i.test(JSON.stringify(sent[0])), 'в пуше нет сведений о здоровье');
    assert.equal(await push.deliverDue({ timezone: 'UTC' }), 0, 'повторно в тот же день не шлём');
    // тихие часы: ночью не шлём, даже если появилось новое
    current = at(2, 2);
    assert.equal(await push.deliverDue({ timezone: 'UTC' }), 0);
    assert.equal(sent.length, 1);
    // следующий день, утро: утренний приём снова пора
    current = at(2, 12);
    assert.equal(await push.deliverDue({ timezone: 'UTC' }), 1);
    const log = db
      .prepare('SELECT reminder_key, day FROM push_deliveries WHERE patient_id=? ORDER BY id')
      .all(ctx.id('patA'));
    assert.ok(log.some((r) => r.reminder_key === 'med:morning'));
    // подписки нет — не шлём
    db.prepare('DELETE FROM push_subscriptions WHERE user_id=?').run(ctx.id('patA'));
    current = at(3, 12);
    assert.equal(await push.deliverDue({ timezone: 'UTC' }), 0);
  } finally {
    db.close();
  }
});

test('отозванная подписка (410 от службы) удаляется', async () => {
  const p = await ctx.as('patC');
  expectOk(await p.patch('/api/v1/me/prefs', { push_subscription: sub('fcm.googleapis.com', 'patC') }));
  const db = ctx.app.db();
  try {
    const gone = createPush({
      db,
      config: { pushMode: 'webpush', dataDir: '/tmp', vapidPublicKey: 'p', vapidPrivateKey: 'q', baseUrl: 'http://x' },
      now: () => at(1, 21),
      webpush: {
        sendNotification: async () => {
          throw Object.assign(new Error('gone'), { statusCode: 410 });
        },
      },
    });
    await gone.deliverDue({ timezone: 'UTC' }); // вечером дневник за завтра пуст — есть что отправлять
    assert.equal(db.prepare('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id=?').get(ctx.id('patC')).n, 0);
  } finally {
    db.close();
  }
});

test('своё время дневника: «выключено» молчит, своё время раньше 19:00 срабатывает', () => {
  const db = ctx.app.db();
  try {
    const patient = ctx.id('patD');
    const state = (reminder) =>
      db
        .prepare(
          'INSERT INTO diary_workspaces(patient_id,revision,state_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(patient_id) DO UPDATE SET state_json=excluded.state_json',
        )
        .run(patient, 1, JSON.stringify({ reminder }), new Date().toISOString());
    const diary = (hour) =>
      dueReminders(db, { patientId: patient, now: at(5, hour), timezone: 'UTC' }).filter((r) => r.kind === 'diary')
        .length;
    state({ frequency: 'daily', time: '17:30' });
    assert.equal(diary(17), 0);
    assert.equal(diary(18), 1, 'время 17:30 — в 18:00 пора');
    state({ frequency: 'off', time: '17:30' });
    assert.equal(diary(20), 0, 'напоминание выключено');
    state({ frequency: 'paused', time: '17:30' });
    assert.equal(diary(20), 0);
  } finally {
    db.close();
  }
});

test('своё время приёма: время из личных напоминаний, выключатель и день недели; чужие значения не подмешиваются', () => {
  const db = ctx.app.db();
  try {
    const patient = ctx.id('patA');
    const rows = db.prepare("SELECT id, time_hhmm FROM reminders WHERE patient_id=? AND kind='med'").all(patient);
    assert.ok(rows.length >= 1, 'принятый пункт плана создал напоминание');
    assert.equal(rows[0].time_hhmm, '08:00', 'слово «утро» превращается в 08:00, а не в 09:00 для всех слотов');
    const meds = (hour, minute = 0) => {
      const d = at(6, hour);
      d.setUTCMinutes(minute);
      return dueReminders(db, { patientId: patient, now: d, timezone: 'UTC' }).filter((r) => r.kind === 'medication')
        .length;
    };
    assert.equal(meds(7, 30), 0);
    db.prepare('UPDATE reminders SET time_hhmm=? WHERE id=?').run('07:15', rows[0].id);
    assert.equal(meds(7, 30), 1, 'своё время 07:15 раньше слота по умолчанию');
    db.prepare('UPDATE reminders SET active=0 WHERE id=?').run(rows[0].id);
    assert.equal(meds(12), 0, 'выключено пациентом — молчим');
    db.prepare('UPDATE reminders SET active=1, days_mask=0 WHERE id=?').run(rows[0].id);
    assert.equal(meds(12), 0, 'в этот день недели не напоминать');
  } finally {
    db.close();
  }
});

test('время напоминания можно поменять в аккаунте; список показывает название препарата', async () => {
  const p = await ctx.as('patA');
  const list = expectOk(await p.get('/api/v1/me/reminders')).items;
  assert.ok(list.some((r) => /сертралин/i.test(r.name || '')));
  const id = list[0].id;
  expectError(await p.put(`/api/v1/me/reminders/${id}`, { time: '25:99', enabled: true }), 422, 'E-VALIDATION');
  expectOk(await p.put(`/api/v1/me/reminders/${id}`, { time: '07:45', enabled: true }));
  assert.equal(expectOk(await p.get('/api/v1/me/reminders')).items.find((r) => r.id === id).time_hhmm, '07:45');
  expectOk(await p.put(`/api/v1/me/reminders/${id}`, { enabled: false }));
  assert.equal(
    expectOk(await p.get('/api/v1/me/reminders')).items.find((r) => r.id === id).time_hhmm,
    '07:45',
    'время сохраняется при переключении',
  );
});
