'use strict';

// Доступность: axe на каждом экране каждой роли (десктоп 1280 и 390 px) — нет serious/critical.
// E2E_A11Y_VERBOSE=1 — печатать подробности нарушений (id, узлы).

async function run({ base, browser, t, L }) {
  const verbose = process.env.E2E_A11Y_VERBOSE;
  for (const role of Object.keys(L.ROLE_ACCOUNTS)) {
    const urls = await L.screensFor(browser, base, role);
    t.info(`${role}: экранов ${urls.length}`);
    for (const [pname, profile] of [['desktop', L.DESKTOP], ['390', L.MOBILE]]) {
      const { ctx, page } = await L.login(browser, base, L.ROLE_ACCOUNTS[role], profile);
      const bad = [];
      for (const u of urls) {
        await page.goto(base + u, { waitUntil: 'load' });
        const v = await L.axeViolations(page);
        if (v.length) bad.push({ url: u, v });
      }
      await ctx.close();
      const summary = {};
      for (const b of bad) for (const v of b.v) (summary[v.id] = summary[v.id] || []).push(b.url);
      t.check(`axe ${role} ${pname}: нет serious/critical на ${urls.length} экранах`, !bad.length,
        Object.entries(summary).map(([id, us]) => `${id}: ${us.length} экр. (${us.slice(0, 3).join(', ')})`).join('; '));
      if (verbose) for (const b of bad) for (const v of b.v) console.log('    ', b.url, v.id, v.impact, JSON.stringify(v.nodes.slice(0, 2)));
    }
  }
}

module.exports = { run };
