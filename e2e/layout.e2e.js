'use strict';

// Мобильная вёрстка 360 и 390 px: нет горизонтального переполнения на всех экранах всех ролей
// (список экранов — обход ссылок от /dashboard, включая страницы волн 1–2).

async function run({ base, browser, t, L }) {
  for (const role of Object.keys(L.ROLE_ACCOUNTS)) {
    const urls = await L.screensFor(browser, base, role);
    for (const [pname, profile] of [['360', L.NARROW], ['390', L.MOBILE]]) {
      const { ctx, page } = await L.login(browser, base, L.ROLE_ACCOUNTS[role], profile);
      const bad = [];
      for (const u of urls) {
        await page.goto(base + u, { waitUntil: 'load' });
        const o = await L.overflow(page);
        if (o.scrollWidth > o.innerWidth) bad.push(`${u} (${o.scrollWidth}>${o.innerWidth}; ${o.bad.join(',')})`);
      }
      await ctx.close();
      t.check(`без переполнения ${role} ${pname}: ${urls.length} экранов`, !bad.length, bad.slice(0, 6).join(' | '));
    }
  }
}

module.exports = { run };
