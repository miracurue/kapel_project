'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shellTop, NAV } = require('../../src/pages');

// covers: W-06 — верхние вкладки должны выходить из карточки, профиля и уведомлений.
for (const [role, base] of [
  ['patient', '/app'],
  ['psychiatrist', '/work'],
  ['psychologist', '/work'],
  ['admin', '/admin'],
  ['host', '/demo'],
]) {
  test(`shell navigation: ${role} tabs point to the role workspace from every page`, () => {
    const html = shellTop({ role, full_name: 'Демо' });
    const nav = NAV[role === 'host' ? 'demo_host' : role];
    for (const [, tab] of nav) {
      assert.ok(html.includes(`href="${base}?tab=${tab}"`), `${role}: ${tab} must leave the current page`);
    }
  });
}
