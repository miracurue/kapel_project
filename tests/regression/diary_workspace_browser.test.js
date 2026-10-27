'use strict';
// covers: owner-approved unified diary integration, persistence and real backend (2026-10-21);
// one-tap marks on «Сегодня» without dialogs (2026-10-25).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const { expectOk } = require('../lib/client');
const ctx = useBrowserApp();
const output = '/tmp/cc-diary-workspace';

test('unified diary: wellbeing, sleep, private notes, habits, reload and mobile', async () => {
  fs.mkdirSync(output, { recursive: true });
  const s = await B.contextAs(ctx.browser, ctx.app, 'patB', { viewport: { width: 1440, height: 1000 } });
  ctx.track(s.ctx);
  const p = s.page;
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await B.open(p, ctx.app, '/app?tab=diary');
  await p.locator('[data-state="mood"][data-state-value="4"]').click();
  await p.locator('[data-state="anxiety"][data-state-value="0"]').click();
  // Сон отмечается прямо в строке: первое «+» ставит 7 часов, второе — 7,5; качество — одной кнопкой.
  await p.click('[data-sleep-step="1"]');
  await p.click('[data-sleep-step="1"]');
  await p.locator('[data-state="quality"][data-state-value="3"]').click();
  await p.fill('#day-note', 'Личная синтетическая заметка browser-diary');
  await p.click('#note-form button[type=submit]');
  await p.click('#add');
  await p.fill('#habit-name', 'Чтение синтетика');
  await p.selectOption('#habit-type', 'count');
  await p.click('#habit-form button[type=submit]');
  const card = p.locator('#cards article').filter({ hasText: 'Чтение синтетика' });
  await card.waitFor();
  await card.locator('[data-quick-step="1"]').click();
  await p.waitForTimeout(700);
  const api = await ctx.api('patB');
  await p.waitForFunction(() => document.querySelector('[data-diary-save-status]')?.dataset.state !== 'saving');
  await p.waitForTimeout(500);
  let state = expectOk(await api.get('/api/v1/me/diary-workspace'));
  assert.equal(state.state.wellbeings[state.today].mood, 4);
  assert.equal(state.state.wellbeings[state.today].anxiety, 0);
  assert.equal(state.state.wellbeings[state.today].sleepHours, 7.5);
  assert.equal(state.state.wellbeings[state.today].sleepQuality, 3);
  assert.ok(state.state.dayNotes.some((n) => n.text.includes('browser-diary') && !n.shared));
  const h = state.state.habits.find((h) => h.name === 'Чтение синтетика');
  assert.ok(h);
  assert.deepEqual(state.state.entries[h.id][state.today], [1]);
  await p.reload();
  await p.locator('#cards article').filter({ hasText: 'Чтение синтетика' }).waitFor();
  assert.equal(await p.locator('[data-state="mood"][data-state-value="4"]').getAttribute('aria-checked'), 'true');
  assert.match(await p.locator('#recent-notes').textContent(), /browser-diary/);
  await p.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  // На широком экране цветок открыт справа; перед проверкой телефона закрываем его крестиком.
  await p.click('#flower-panel [data-flower-close]');
  await p.setViewportSize({ width: 390, height: 844 });
  assert.ok(await B.noHorizontalOverflow(p));
  assert.ok(await p.locator('.diary-workspace').evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
  assert.ok(await p.locator('.diary-main').evaluate((el) => el.getBoundingClientRect().right <= innerWidth + 1));
  await p.screenshot({ path: `${output}/mobile.png`, fullPage: true });
  await p.locator('#month-calendar [data-open-day="13"]').click();
  assert.ok(await p.locator('#day-drawer').evaluate((el) => el.open));
  assert.ok(
    await p.locator('#day-drawer').evaluate((el) => Math.abs(el.getBoundingClientRect().width - innerWidth) < 2),
  );
  await p.screenshot({ path: `${output}/mobile-day.png` });
  assert.deepEqual(errors, []);
});
