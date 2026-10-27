'use strict';
// covers: маршрутизация (минимальная): карточка выбора у пациента, снятие связи в «Мои данные», блок «Данные другого
// специалиста» и канал сообщений в карточке пациента у психиатра и психолога.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const ctx = useBrowserApp();
const shots = process.env.SHOTS_DIR || '/tmp/cc-carelinks';

async function visit(key, url, profile) {
  fs.mkdirSync(shots, { recursive: true });
  const session = await B.contextAs(ctx.browser, ctx.app, key, profile);
  ctx.track(session.ctx);
  const errors = [];
  session.page.on('pageerror', (e) => errors.push(e.message));
  await B.open(session.page, ctx.app, url);
  return { page: session.page, errors };
}

test('пациент выбирает, с кем соединить нового; специалисты видят срез и переписываются; пациент рвёт связь', async () => {
  const pid = ctx.app.ids.patA;
  const plg = ctx.app.ids.plg1;
  ctx.app.exec(
    `INSERT OR IGNORE INTO care_assignments(patient_id,clinician_id,started_at,created_by) VALUES (${pid},${plg},'2026-10-20T10:00:00Z',${plg});
     INSERT INTO care_link_prompts(patient_id,new_clinician_id) VALUES (${pid},${plg});
     INSERT INTO offline_results(patient_id,entered_by,instrument,total_score,band,test_date,status) VALUES (${pid},${plg},'phq9',9,'mild','2026-10-20','saved');`,
  );
  const patient = await visit('patA', '/account');
  await patient.page.locator('.carelink-prompt').waitFor();
  await patient.page.screenshot({ path: `${shots}/patient_prompt.png` });
  await patient.page.locator('.carelink-prompt button[data-id]').first().click();
  await patient.page.locator('[data-testid="msg.carelinks.prompt.done"]').click();
  await patient.page.locator('.carelink-prompt').waitFor({ state: 'detached' });
  assert.equal(ctx.app.query('SELECT count(*) n FROM care_links WHERE patient_id=? AND ended_at IS NULL', pid)[0].n, 1);
  assert.deepEqual(patient.errors, []);

  const doc = await visit('psy1', `/work/patients/${pid}`);
  const block = doc.page.locator('[data-colleague] .colleague-block');
  await block.waitFor();
  assert.match(await block.innerText(), /phq9/);
  await block.locator('input[name="text"]').fill('Коллега, как динамика?');
  await block.locator('button[type="submit"]').click();
  await doc.page.locator('.colleague-msg.mine').waitFor();
  await doc.page.screenshot({ path: `${shots}/psychiatrist_card.png` });
  assert.deepEqual(doc.errors, []);

  const psychologist = await visit('plg1', `/work/patients/${pid}`);
  const block2 = psychologist.page.locator('[data-colleague] .colleague-block');
  await block2.waitFor();
  assert.match(await block2.innerText(), /Коллега, как динамика\?/);
  assert.deepEqual(psychologist.errors, []);

  const data = await visit('patA', '/account/data');
  await data.page.locator('[data-carelinks-data] [data-testid="msg.carelinks.data.end"]').click();
  await data.page
    .locator('[data-carelinks-data] [data-testid="msg.carelinks.data.end"]')
    .waitFor({ state: 'detached' });
  assert.equal(ctx.app.query('SELECT count(*) n FROM care_links WHERE patient_id=? AND ended_at IS NULL', pid)[0].n, 0);
});
