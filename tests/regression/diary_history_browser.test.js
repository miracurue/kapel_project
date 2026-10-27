'use strict';
// covers: F-39 historical note visibility and bounded workspace persistence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const { expectOk, expectError } = require('../lib/client');
const ctx = useBrowserApp();
test('old note sharing survives bounded save, historical doctor preview, unshare and reload', async () => {
  const api = await ctx.api('patA');
  const w = expectOk(await api.get('/api/v1/me/diary-workspace?window=90'));
  const pid = ctx.app.ids.patA;
  const old = new Date(Date.parse(w.today) - 120 * 86400000).toISOString().slice(0, 10);
  ctx.app.exec(
    `INSERT INTO diary_day_notes(patient_id,note_id,day,text,shared) VALUES (${pid},'old-sharing','${old}','OLD_NOTE_SHARING_CANARY',1)`,
  );
  const session = await B.contextAs(ctx.browser, ctx.app, 'patA', { viewport: { width: 1440, height: 1000 } });
  ctx.track(session.ctx);
  const page = session.page;
  async function oldMonth() {
    const count =
      (Number(w.today.slice(0, 4)) - Number(old.slice(0, 4))) * 12 +
      Number(w.today.slice(5, 7)) -
      Number(old.slice(5, 7));
    for (let i = 0; i < count; i += 1) {
      const load = page.waitForResponse((r) => r.url().includes('/diary-workspace?from=') && r.status() === 200);
      await page.click('#previous-month');
      if (i >= 2) await load;
      else load.catch(() => {});
    }
  }
  await B.open(page, ctx.app, '/app?tab=diary');
  // История — секция той же страницы, без отдельных вкладок.
  await oldMonth();
  const index = 13 - 120;
  await page.click(`[data-open-day="${index}"]`);
  assert.match(await page.locator('#drawer-content').textContent(), /OLD_NOTE_SHARING_CANARY/);
  await page.keyboard.press('Escape');
  await page.click('[data-mode="doctor"]');
  await page.click(`[data-open-day="${index}"]`);
  assert.match(await page.locator('#drawer-content').textContent(), /OLD_NOTE_SHARING_CANARY/);
  await page.keyboard.press('Escape');
  await page.click('[data-mode="patient"]');
  await page.click(`[data-open-day="${index}"]`);
  await page.uncheck('[data-note-share="old-sharing"]');
  await page.waitForFunction(() => document.querySelector('[data-diary-save-status]')?.dataset.state === 'saved');
  assert.equal(
    ctx.app.query('SELECT shared FROM diary_day_notes WHERE patient_id=? AND note_id=?', pid, 'old-sharing')[0].shared,
    0,
  );
  await page.keyboard.press('Escape');
  await page.click('[data-mode="doctor"]');
  await page.click(`[data-open-day="${index}"]`);
  assert.doesNotMatch(await page.locator('#drawer-content').textContent(), /OLD_NOTE_SHARING_CANARY/);
  await page.reload();
  await oldMonth();
  await page.click(`[data-open-day="${index}"]`);
  assert.equal(await page.isChecked('[data-note-share="old-sharing"]'), false);
  const doc = await ctx.api('psy1');
  assert.ok(
    !JSON.stringify(expectOk(await doc.get(`/api/v1/patients/${pid}/diary-workspace`))).includes(
      'OLD_NOTE_SHARING_CANARY',
    ),
  );
  const latest = expectOk(await api.get('/api/v1/me/diary-workspace?window=90'));
  expectError(
    await api.put('/api/v1/me/diary-workspace', {
      revision: latest.revision,
      state: latest.state,
      window: latest.window,
      noteSharing: [{ id: 'foreign-note', shared: true }],
    }),
    422,
    'E-VALIDATION',
  );
});
