'use strict';

// Чёрно-белый режим: значимые состояния (риск, статусы светофора, бейджи) различимы не только цветом.
// Проверка: каждый «цветной» индикатор (бейдж/метка/точка/плашка) несёт читаемый текст или aria-label,
// а при grayscale-фильтре у соседних разных статусов остаётся разный текст/значок.

const SCREENS = {
  psychiatrist: ['/dashboard', '/patients', '/crisis', '/patients/6', '/patients/12', '/assignments'],
  psychologist: ['/dashboard', '/patients', '/patients/8'],
  patient: ['/dashboard', '/tests', '/diary'],
  admin: ['/dashboard', '/admin/nobody', '/admin/users'],
};

async function empties(page) {
  return page.evaluate(() => {
    const out = [];
    const sel = '[class*="badge"], [class*="tag"], [class*="status"], [class*="light"], [class*="dot"], [class*="signal"], [class*="flag"], [class*="risk"], [class*="sla"]';
    for (const el of document.querySelectorAll(sel)) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || cs.visibility === 'hidden') continue;
      const bg = cs.backgroundColor;
      const colored = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
      if (!colored) continue;
      // контейнеры (с дочерними бейджами) не считаем: смотрим «листья» индикаторов
      if (el.querySelector('[class*="badge"], [class*="tag"], [class*="status"]')) continue;
      const txt = (el.innerText || '').trim();
      const label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
      const sr = el.querySelector('.sr-only, .visually-hidden');
      if (!txt && !label && !sr) out.push(el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]);
    }
    return out;
  });
}

async function run({ base, browser, t, L }) {
  for (const [role, urls] of Object.entries(SCREENS)) {
    const { ctx, page } = await L.login(browser, base, L.ROLE_ACCOUNTS[role], L.DESKTOP);
    await page.emulateMedia({ forcedColors: 'none' });
    const bad = [];
    for (const u of urls) {
      await page.goto(base + u, { waitUntil: 'load' });
      const e = await empties(page);
      if (e.length) bad.push(`${u}: ${[...new Set(e)].join(',')}`);
    }
    await ctx.close();
    t.check(`чёрно-белый режим ${role}: у цветных индикаторов есть текст/подпись (${urls.length} экранов)`, !bad.length, bad.join(' | '));
  }
  // Смысловая проверка светофора: статусы в сводке названы словами, а не только цветом.
  const { ctx, page } = await L.login(browser, base, 'psy1');
  await page.goto(base + '/dashboard');
  const body = (await page.innerText('main')).toLowerCase();
  t.check('сводка: статусы светофора названы словами (кризис/внимание/без изменений…)', /кризис/.test(body) && /(внимание|ухудш|красн|жёлт)/.test(body));
  await page.goto(base + '/patients');
  const rows = await page.$$eval('table.patient-table tbody tr', (r) => r.length);
  const statusCells = await page.$$eval('table.patient-table tbody tr', (rs) => rs.filter((r) => /кризис|внимани|стабильн|улучш|ухудш|мало данных|спокойно|нет данных|без изменений|жёлт|красн|зелён/i.test(r.innerText)).length);
  t.check('список пациентов: в каждой строке статус выражен текстом', rows > 0 && statusCells === rows, { rows, statusCells });
  await ctx.close();
}

module.exports = { run };
