#!/usr/bin/env node
'use strict';

// Визуальная фиксация В3: только синтетическая временная БД тестового запуска.
const fs = require('fs');
const path = require('path');
const { startApp } = require('../tests/lib/app');
const B = require('../tests/lib/browser');
const { as, expectOk } = require('../tests/lib/client');
const F = require('../tests/lib/flows');

const OUT = path.join(__dirname, '..', '.agents', 'web-developer', 'files', '14-build', 'В3');
const views = [
  ['patient-chat', 'patA', '/app'],
  ['patient-ae', 'patA', '/app?tab=meds&flow=ae'],
  ['patient-visits', 'patA', '/app?tab=visits'],
  ['patient-doctor', 'patA', '/app?tab=doctor'],
  ['clinician-signals', 'psy1', '/work?tab=signals'],
];

(async () => {
  const app = await startApp();
  const browser = await B.launch();
  const cardViews = [
    ['clinician-messages', 'psy1', `/work/patients/${app.ids.patA}?ptab=messages`],
    ['clinician-previsit', 'psy1', `/work/patients/${app.ids.patA}?ptab=treatment`],
  ];
  fs.mkdirSync(OUT, { recursive: true });
  try {
    const patient = await as(app, 'patA');
    const doctor = await as(app, 'psy1');
    expectOk(await patient.post('/api/v1/me/messages', { text: F.CRISIS_PHRASE }));
    const ae = expectOk(
      await patient.post('/api/v1/me/adverse-events', {
        symptoms: ['nausea'],
        text: 'Синтетика: тошнота',
        severity: 'noticeable',
        related: 'yes',
      }),
    );
    expectOk(
      await doctor.post(`/api/v1/patients/${app.ids.patA}/visits`, {
        starts_at: new Date(Date.now() + 2 * 86400000).toISOString(),
        format: 'in_person',
        previsit_enabled: true,
      }),
    );
    await F.passUndoWindow(app);
    for (const [name, who, url] of [...views, ...cardViews]) {
      for (const [suffix, profile] of [
        ['desktop', { viewport: { width: 1440, height: 1000 } }],
        ['phone', B.PHONE],
      ]) {
        const session = await B.contextAs(browser, app, who, profile);
        const page = session.page;
        await B.open(page, app, url);
        const ready = {
          'patient-chat': 'msg.composer.send',
          'patient-ae': 'msg.ae.card.send',
          'patient-visits': 'msg.visits.fill',
          'patient-doctor': 'msg.composer.attach',
          'clinician-signals': 'msg.signals.quote',
          'clinician-messages': 'msg.v3.messages.reply',
          'clinician-previsit': 'msg.v3.previsit.summary',
        };
        await B.expectVisible(page, ready[name]);
        const capture = async (state) => {
          await page.evaluate(() => document.fonts.ready);
          const dimensions = await page.evaluate(() => ({
            width: document.documentElement.clientWidth,
            content: document.documentElement.scrollWidth,
          }));
          if (dimensions.content > dimensions.width)
            throw new Error(`${state}-${suffix}: horizontal overflow ${JSON.stringify(dimensions)}`);
          await page.screenshot({ path: path.join(OUT, `${state}-${suffix}.png`), fullPage: true });
        };
        await capture(name);
        if (name === 'patient-visits') {
          await page.click(B.tid('msg.visits.fill'));
          await B.expectVisible(page, 'msg.previsit.title');
          await capture('patient-previsit');
        }
        if (name === 'patient-doctor') {
          await page.click(B.tid('msg.composer.attach'));
          await page.locator('#v3-photo').setInputFiles(`${F.FILES}/synthetic_report.pdf`);
          await B.expectVisible(page, 'msg.composer.file.remove');
          await page.fill(B.tid('msg.doctor.placeholder'), 'Синтетический вопрос перед визитом');
          await capture('patient-attachment');
        }
        if (name === 'clinician-signals') {
          const crisis = page.locator('[data-signal^="crisis-"]').first();
          if (await crisis.locator(B.tid('msg.signals.take')).count())
            await crisis.locator(B.tid('msg.signals.take')).click();
          await crisis.locator('[data-outcome]').waitFor();
          await capture('clinician-outcome');
          await page.click(B.tid('msg.signals.filter.ae'));
          const aeCard = page.locator(`[data-signal="ae-${ae.ae.id}"]`);
          if (await aeCard.locator(B.tid('msg.signals.ae.likely')).count())
            await aeCard.locator(B.tid('msg.signals.ae.likely')).click();
          await aeCard.locator(B.tid('msg.signals.notice.open')).click();
          await aeCard.locator('[data-notice]').waitFor();
          await capture('clinician-notice');
        }
        if (name === 'clinician-previsit') {
          await page.fill(B.tid('msg.card.placeholder.treatment'), 'Визит через неделю');
          await page.click(B.tid('msg.composer.send'));
          await page.locator('[data-visit-date]').waitFor();
          await capture('clinician-visit-draft');
        }
        await session.ctx.close();
      }
    }
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`Скриншоты В3: ${OUT}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
