'use strict';

// covers: маршрутизация (минимальная): код второго специалиста, вопрос пациенту, связь, срезы «данных другого
// специалиста», канал сообщений, QR; отрицательные: чужой пациент, снятая связь, завершённое закрепление, роль без права.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { Client, expectError, expectOk } = require('../lib/client');

const ctx = useApp();
const PASS = 'Brand-New-Pass-1';
const q = (sql, ...args) => ctx.app.query(sql, ...args);

async function newPatient(email) {
  const g = new Client(ctx.app.base);
  await g.ensureCsrf();
  const r = expectOk(await g.post('/api/v1/auth/register', { email, password: PASS, consents: ['base'] }));
  g.csrf = r.csrf;
  return { g, id: q('SELECT id FROM users WHERE email=?', email)[0].id };
}
async function invite(key) {
  return expectOk(await (await ctx.as(key)).post('/api/v1/invites', {}));
}
async function setup(email) {
  const p = await newPatient(email);
  expectOk(await p.g.post('/api/v1/me/care-link', { invite_code: (await invite('psy1')).code }));
  const second = expectOk(await p.g.post('/api/v1/me/care-link', { invite_code: (await invite('plg1')).code }));
  return { ...p, second };
}

test('код приглашения отдаёт ссылку и QR (SVG), регистрация подставляет код', async () => {
  const inv = await invite('plg1');
  assert.match(inv.link, /\/register\?code=CC-/);
  assert.ok(inv.qr_svg.startsWith('<svg'), 'QR как SVG');
  const page = await new Client(ctx.app.base).get(`/register?code=${inv.code}`);
  assert.equal(page.status, 200);
});

test('второй специалист по коду: вопрос пациенту, связь, уведомления обоим, закрепления целы', async () => {
  const { g, id, second } = await setup('rt1@cc.example.test');
  assert.equal(second.choose, true);
  const view = expectOk(await g.get('/api/v1/me/care-links'));
  assert.equal(view.specialists.length, 2);
  assert.equal(view.prompts.length, 1);
  assert.deepEqual(
    view.prompts[0].options.map((o) => o.id),
    [ctx.id('psy1')],
  );
  const done = expectOk(
    await g.post('/api/v1/me/care-links/answer', { prompt_id: view.prompts[0].id, clinician_ids: [ctx.id('psy1')] }),
  );
  assert.equal(done.linked, 1);
  assert.equal(done.prompts.length, 0);
  assert.equal(done.links.length, 1);
  assert.equal(q('SELECT count(*) n FROM care_assignments WHERE patient_id=? AND ended_at IS NULL', id)[0].n, 2);
  const n = q("SELECT recipient_id,title FROM notifications WHERE event_key LIKE 'carelink:%' AND patient_id=?", id);
  assert.equal(n.length, 2);
  assert.ok(
    n.every((x) => !x.title.includes('rt1')),
    'в заголовке нет данных пациента',
  );
  // тот же специалист повторно — конфликт; повторный ответ — 404
  expectError(await g.post('/api/v1/me/care-link', { invite_code: (await invite('plg1')).code }), 409, 'E-CONFLICT');
  expectError(
    await g.post('/api/v1/me/care-links/answer', { prompt_id: view.prompts[0].id, clinician_ids: [] }),
    404,
    'E-NOT-FOUND',
  );
});

test('«ни с кем» закрывает вопрос без связи; чужого специалиста выбрать нельзя', async () => {
  const { g } = await setup('rt2@cc.example.test');
  const view = expectOk(await g.get('/api/v1/me/care-links'));
  expectError(
    await g.post('/api/v1/me/care-links/answer', { prompt_id: view.prompts[0].id, clinician_ids: [ctx.id('psy2')] }),
    422,
    'E-VALIDATION',
  );
  const done = expectOk(
    await g.post('/api/v1/me/care-links/answer', { prompt_id: view.prompts[0].id, clinician_ids: [] }),
  );
  assert.equal(done.linked, 0);
  assert.equal(done.prompts.length, 0);
  const plg = await ctx.as('plg1');
  const pid = q(
    'SELECT patient_id FROM care_assignments WHERE clinician_id=? ORDER BY id DESC LIMIT 1',
    ctx.id('plg1'),
  )[0].patient_id;
  expectError(await plg.get(`/api/v1/patients/${pid}/colleagues`), 404, 'E-NOT-FOUND');
});

test('срезы: психиатр видит тесты психолога, психолог — назначения психиатра; пациент и чужие — нет', async () => {
  const { g, id } = await setup('rt3@cc.example.test');
  const view = expectOk(await g.get('/api/v1/me/care-links'));
  expectOk(
    await g.post('/api/v1/me/care-links/answer', { prompt_id: view.prompts[0].id, clinician_ids: [ctx.id('psy1')] }),
  );
  const inn = q('SELECT id,name FROM inn LIMIT 1')[0];
  ctx.app.exec(
    `INSERT INTO offline_results(patient_id,entered_by,instrument,total_score,band,test_date,status) VALUES (${id},${ctx.id('plg1')},'phq9',11,'moderate','2026-10-20','saved');
     INSERT INTO plan_versions(patient_id,version,status,author_id,published_at) VALUES (${id},1,'published',${ctx.id('psy1')},'2026-10-21T10:00:00Z');
     INSERT INTO plan_items(plan_version_id,item_key,inn_id,dose_value,dose_unit) VALUES (last_insert_rowid(),'k1',${inn.id},10,'mg');`,
  );
  const psy = await ctx.as('psy1');
  const forPsy = expectOk(await psy.get(`/api/v1/patients/${id}/colleagues`)).items;
  assert.equal(forPsy.length, 1);
  assert.equal(forPsy[0].colleague.id, ctx.id('plg1'));
  assert.equal(forPsy[0].shared.tests.length, 1);
  assert.equal(forPsy[0].shared.tests[0].instrument, 'phq9');
  assert.equal(forPsy[0].shared.meds, undefined);
  const plg = await ctx.as('plg1');
  const forPlg = expectOk(await plg.get(`/api/v1/patients/${id}/colleagues`)).items;
  assert.equal(forPlg[0].shared.meds[0].inn_name, inn.name);
  assert.equal(forPlg[0].shared.tests, undefined);
  assert.ok(
    q("SELECT 1 FROM phi_access_log WHERE actor_id=? AND patient_id=? AND section='colleague.meds'", ctx.id('plg1'), id)
      .length,
  );
  // отрицательные: пациент, чужой специалист, не связанный закреплённый, админ
  expectError(await g.get(`/api/v1/patients/${id}/colleagues`), 403, 'E-ACCESS');
  expectError(await (await ctx.as('psy2')).get(`/api/v1/patients/${id}/colleagues`), 404, 'E-NOT-FOUND');
  expectError(await (await ctx.as('admin1')).get(`/api/v1/patients/${id}/colleagues`), 403, 'E-ACCESS');
});

test('канал сообщений: только связанным; пациент не читает; чужой пациент — 404', async () => {
  const { g, id } = await setup('rt4@cc.example.test');
  const view = expectOk(await g.get('/api/v1/me/care-links'));
  const link = expectOk(
    await g.post('/api/v1/me/care-links/answer', { prompt_id: view.prompts[0].id, clinician_ids: [ctx.id('psy1')] }),
  ).links[0].id;
  const psy = await ctx.as('psy1');
  expectError(
    await psy.post(`/api/v1/patients/${id}/colleagues/${link}/messages`, { text: '  ' }),
    422,
    'E-VALIDATION',
  );
  expectOk(await psy.post(`/api/v1/patients/${id}/colleagues/${link}/messages`, { text: 'Добрый день, коллега' }));
  const plg = await ctx.as('plg1');
  const seen = expectOk(await plg.get(`/api/v1/patients/${id}/colleagues`)).items[0].messages;
  assert.deepEqual(
    seen.map((m) => [m.body, m.mine]),
    [['Добрый день, коллега', false]],
  );
  assert.ok(
    q("SELECT 1 FROM notifications WHERE recipient_id=? AND event_key LIKE 'carelinkmsg:%'", ctx.id('plg1')).length,
  );
  expectError(
    await (await ctx.as('psy2')).post(`/api/v1/patients/${id}/colleagues/${link}/messages`, { text: 'x' }),
    404,
    'E-NOT-FOUND',
  );
  expectError(await g.post(`/api/v1/patients/${id}/colleagues/${link}/messages`, { text: 'x' }), 403, 'E-ACCESS');
});

test('снятие связи пациентом и завершённое закрепление закрывают доступ', async () => {
  const { g, id } = await setup('rt5@cc.example.test');
  const view = expectOk(await g.get('/api/v1/me/care-links'));
  const link = expectOk(
    await g.post('/api/v1/me/care-links/answer', { prompt_id: view.prompts[0].id, clinician_ids: [ctx.id('psy1')] }),
  ).links[0].id;
  const psy = await ctx.as('psy1');
  const plg = await ctx.as('plg1');
  expectOk(await psy.get(`/api/v1/patients/${id}/colleagues`));
  // закрепление психолога завершено — связь не работает ни для кого
  ctx.app.exec(
    `UPDATE care_assignments SET ended_at='2026-10-27T00:00:00Z' WHERE patient_id=${id} AND clinician_id=${ctx.id('plg1')}`,
  );
  expectError(await psy.get(`/api/v1/patients/${id}/colleagues`), 404, 'E-NOT-FOUND');
  expectError(await plg.get(`/api/v1/patients/${id}/colleagues`), 404, 'E-NOT-FOUND');
  ctx.app.exec(`UPDATE care_assignments SET ended_at=NULL WHERE patient_id=${id} AND clinician_id=${ctx.id('plg1')}`);
  expectOk(await psy.get(`/api/v1/patients/${id}/colleagues`));
  // «только сигнал» не даёт чужого среза
  ctx.app.exec(
    `UPDATE care_assignments SET end_reason='signal_only' WHERE patient_id=${id} AND clinician_id=${ctx.id('plg1')}`,
  );
  expectError(await plg.get(`/api/v1/patients/${id}/colleagues`), 404, 'E-NOT-FOUND');
  ctx.app.exec(`UPDATE care_assignments SET end_reason=NULL WHERE patient_id=${id} AND clinician_id=${ctx.id('plg1')}`);
  // чужая связь пациент снять не может, свою — может
  const other = await newPatient('rt6@cc.example.test');
  expectError(await other.g.post(`/api/v1/me/care-links/${link}/end`, {}), 404, 'E-NOT-FOUND');
  expectOk(await g.post(`/api/v1/me/care-links/${link}/end`, {}));
  expectError(await psy.get(`/api/v1/patients/${id}/colleagues`), 404, 'E-NOT-FOUND');
  expectError(await psy.post(`/api/v1/patients/${id}/colleagues/${link}/messages`, { text: 'x' }), 404, 'E-NOT-FOUND');
});
