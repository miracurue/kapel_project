'use strict';

// Клавиатура: «пропустить к содержимому», порядок фокуса (ссылка-пропуск первая), меню на узком экране
// открывается с клавиатуры и закрывается Esc, чат отправляется Enter-ом/Tab-ом, у всех интерактивных
// элементов виден фокус.

async function run({ base, browser, t, L }) {
  const { ctx, page } = await L.login(browser, base, 'p1', L.MOBILE);
  await page.goto(base + '/dashboard');
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => { const a = document.activeElement; return { tag: a.tagName, text: (a.innerText || '').trim(), href: a.getAttribute('href') }; });
  t.check('Tab: первым получает фокус «Перейти к содержимому»', /содержимому/i.test(first.text), first);
  const toggle = page.locator('#nav-toggle');
  t.check('390 px: кнопка меню видна и имеет aria-expanded', (await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) !== null);
  await toggle.focus();
  const state0 = await toggle.getAttribute('aria-expanded');
  await page.keyboard.press('Enter');
  const state1 = await toggle.getAttribute('aria-expanded');
  t.check('меню переключается клавишей Enter', state0 !== state1, { state0, state1 });
  if (state1 === 'true') {
    await page.keyboard.press('Escape');
    t.check('Esc закрывает меню и возвращает фокус на кнопку', (await toggle.getAttribute('aria-expanded')) === 'false' && (await page.evaluate(() => document.activeElement.id)) === 'nav-toggle');
    await page.keyboard.press('Enter');
  }
  const links = await page.$$eval('#sidenav a', (as) => as.length);
  t.check('меню содержит ссылки, доступные по Tab', links >= 8, links);

  // чат: фокус в поле ввода, Enter отправляет
  await page.goto(base + '/chat');
  await page.focus('#ai-input');
  await page.keyboard.type('Как лучше засыпать?');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3500);
  t.check('чат: Enter в поле отправляет сообщение, оно появляется в журнале', /Как лучше засыпать/.test(await page.innerText('#ai-log')));
  // видимый фокус у ссылок/кнопок: outline или box-shadow ненулевые на :focus-visible
  await page.goto(base + '/dashboard');
  let invisible = 0; let checked = 0;
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const a = document.activeElement; if (!a || a === document.body) return null;
      const cs = getComputedStyle(a);
      const ow = parseFloat(cs.outlineWidth) || 0;
      return { vis: (cs.outlineStyle !== 'none' && ow > 0) || (cs.boxShadow && cs.boxShadow !== 'none') || cs.textDecorationLine === 'underline', el: a.tagName + (a.id ? '#' + a.id : '') };
    });
    if (r) { checked++; if (!r.vis) invisible++; }
  }
  t.check('фокус виден на первых 25 элементах (outline/тень/подчёркивание)', checked > 5 && invisible === 0, { checked, invisible });
  await ctx.close();
}

module.exports = { run };
