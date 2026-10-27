'use strict';
// covers: Т-2, Т-3 (аудит H4): окно приглашений у специалиста («+ Пригласить») и у администратора (вкладка «Люди»).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const ctx = useBrowserApp();
const shots = process.env.SHOTS_DIR || '/tmp/cc-invites';
const PHONE = { viewport: { width: 375, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function visit(key, url, profile) {
  fs.mkdirSync(shots, { recursive: true });
  const session = await B.contextAs(ctx.browser, ctx.app, key, profile);
  ctx.track(session.ctx);
  const errors = [];
  session.page.on('pageerror', (e) => errors.push(e.message));
  await B.open(session.page, ctx.app, url);
  return { page: session.page, errors };
}

test('специалист: создать код, увидеть один раз, список со статусом, отозвать', async () => {
  const { page, errors } = await visit('psy1', '/work?tab=patients');
  await page.locator('[data-invite-root] .invite-open').click();
  await page.locator('dialog.invite-dlg[open]').waitFor();
  await page.locator('.invite-dlg .btn.primary').click();
  await page.locator('.invite-dlg .invite-code').filter({ hasText: 'CC-' }).waitFor();
  const code = await page.locator('.invite-dlg .invite-code').innerText();
  assert.match(code, /^CC-[0-9A-F]{10}$/);
  await page.locator('.invite-dlg .invite-row').first().waitFor();
  assert.match(await page.locator('.invite-dlg .invite-row .invite-badge').first().innerText(), /Ждёт пациента/);
  await page.screenshot({ path: `${shots}/psy_light.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${shots}/psy_dark.png` });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'Отозвать код' }).first().click();
  await page.locator('.invite-badge--revoked').first().waitFor();
  assert.equal(ctx.app.query("SELECT status FROM invite_codes ORDER BY id DESC LIMIT 1")[0].status, 'revoked');
  // Код не остаётся на экране после закрытия окна.
  await page.locator('.invite-dlg .acts .btn').first().click();
  await page.locator('[data-invite-root] .invite-open').click();
  assert.equal(await page.locator('.invite-dlg .invite-code').innerText(), '');
  assert.deepEqual(errors, []);
});

test('специалист на телефоне: окно помещается по ширине', async () => {
  const { page } = await visit('psy1', '/work?tab=patients', PHONE);
  await page.locator('[data-invite-root] .invite-open').click();
  await page.locator('.invite-dlg .btn.primary').click();
  await page.locator('.invite-dlg .invite-code').filter({ hasText: 'CC-' }).waitFor();
  await page.screenshot({ path: `${shots}/psy_phone.png` });
  const box = await page.locator('dialog.invite-dlg').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 375);
});

test('администратор: приглашение для специалиста и отзыв', async () => {
  const { page, errors } = await visit('admin1', '/admin?tab=people');
  await page.locator('[data-invites]').click();
  await page.locator('[data-inv-make]').click();
  await page.locator('[data-inv-code]').filter({ hasText: 'CC-' }).waitFor();
  const code = await page.locator('[data-inv-code]').innerText();
  assert.match(code, /^CC-/);
  await page.locator('[data-inv-list] .invite-row').first().waitFor();
  await page.screenshot({ path: `${shots}/admin_light.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${shots}/admin_dark.png` });
  await page.locator('[data-inv-revoke]').first().click();
  await page.locator('.invite-badge--revoked').first().waitFor();
  assert.ok(!(await page.locator('[data-inv-list]').innerText()).includes(code));
  assert.deepEqual(errors, []);
});

test('кнопка «Пригласить» стоит рядом с «Журналом» у психиатра и психолога; в чате и списке пациентов её нет', async () => {
  for (const who of ['psy1', 'plg1'])
    for (const url of ['/work?tab=chat', '/work?tab=patients']) {
      const { page } = await visit(who, url);
      const btn = page.locator('.shell-actions [data-invite-root] .invite-open');
      await btn.waitFor();
      assert.ok(await btn.isVisible(), `${who} ${url}`);
      assert.equal(await page.locator('.journal-btn').count(), 1);
      assert.equal(await page.locator('.side [data-invite-root], .plist [data-invite-root]').count(), 0);
      await page.screenshot({ path: `${shots}/${who}_${url.split('=')[1]}.png` });
    }
});

test('история чатов: крестик удаляет беседу, открытая — открывает новый пустой чат', async () => {
  const doc = await ctx.api('psy1');
  const made = [];
  for (const text of ['Первый вопрос', 'Второй вопрос']) {
    const r = await doc.post('/api/v1/ai/clinician/messages', { text, chips: [], new_thread: true });
    made.push(r.body.thread.id);
  }
  const { page } = await visit('psy1', `/work?tab=chat&thread=${made[1]}`);
  const rows = page.locator('[data-threads] .th-row');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 2);
  await rows.first().hover();
  await page.screenshot({ path: `${shots}/psy_threads.png` });
  await rows.nth(1).locator('.th-del').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-threads] .th-row').length === 1);
  assert.ok(ctx.app.query('SELECT hidden_at FROM ai_threads WHERE id=?', made[0])[0].hidden_at || ctx.app.query('SELECT hidden_at FROM ai_threads WHERE id=?', made[1])[0].hidden_at);
  // Удаляем открытую беседу — страница переходит на пустой чат.
  await page.locator('[data-threads] .th-row .th-del').first().click();
  await page.waitForURL(/\/work\?tab=chat$/);
  assert.equal(await page.locator('[data-threads] .th-row').count(), 0);
});
