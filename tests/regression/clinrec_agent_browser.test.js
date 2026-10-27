'use strict';
// covers: F-32; этап 3 плана агента: источник [n] под ответом психиатра открывает раздел клинической рекомендации в
// правой панели с выделением. Нужен Postgres знаний с клинреками (KNOWLEDGE_TEST_DATABASE_URL или KNOWLEDGE_DATABASE_URL).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');

const URL = process.env.KNOWLEDGE_TEST_DATABASE_URL || process.env.KNOWLEDGE_DATABASE_URL;
const ctx = useBrowserApp({ env: { KNOWLEDGE_DATABASE_URL: URL || '', CLINICIAN_AGENT_MODE: 'tools' } });
const skip = URL ? false : 'нет KNOWLEDGE_DATABASE_URL';
const output = '/tmp/cc-clinrec-agent';

test('карточка и ссылка [n] открывают в правой панели весь клинрек: глава источника раскрыта и подсвечена, остальные свёрнуты', { skip }, async () => {
  fs.mkdirSync(output, { recursive: true });
  const session = await B.contextAs(ctx.browser, ctx.app, 'psy1');
  ctx.track(session.ctx);
  const { page } = session;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await B.open(page, ctx.app, '/work');
  ctx.app.ai.queue(
    { mode: 'tool', name: 'search_clinrec', arguments: { query: 'критерии диагноза ГТР тревога 6 месяцев', clinrec_id: 'gtr_2024' } },
    { mode: 'text', text: 'Тревога не менее 6 месяцев [1]. Это общеизвестно [0]. Рассказать подробнее о критериях?' },
  );
  await page.fill(B.tid('msg.wchat.placeholder'), 'Сколько должна длиться тревога для диагноза ГТР?');
  await page.click(B.tid('msg.composer.send'));
  const cards = page.locator(B.tid('msg.wchat.source.card'));
  await cards.first().waitFor({ timeout: 15000 });
  assert.equal(await cards.count(), 2, 'карточки: знания модели и клинрек');
  assert.equal(await cards.nth(0).getAttribute('data-kind'), 'model', 'знания модели отдельной карточкой другого цвета');
  assert.equal(await cards.nth(1).getAttribute('data-kind'), 'clinrec');
  assert.match(await cards.nth(1).innerText(), /Генерализованное тревожное расстройство/);
  const bg = (i) => cards.nth(i).evaluate((n) => getComputedStyle(n).backgroundColor);
  assert.notEqual(await bg(0), await bg(1), 'цвет знаний модели отличается');

  await cards.nth(1).click();
  const view = page.locator(B.tid('msg.wchat.source.view'));
  await view.waitFor({ timeout: 15000 });
  assert.equal(await view.getAttribute('data-kind'), 'clinrec');
  const mark = page.locator(B.tid('msg.wchat.source.mark'));
  await mark.waitFor({ timeout: 15000 });
  assert.match(await mark.innerText(), /6 месяцев/);
  const chapters = page.locator('.src-chapter');
  assert.ok((await chapters.count()) > 3, 'в панели весь документ, а не один раздел');
  assert.equal(await page.locator('.src-chapter[open]').count(), 1, 'открыта только глава источника');
  assert.equal(await page.locator('.src-chapter[open]').evaluate((n) => n.contains(document.querySelector('[data-testid="msg.wchat.source.mark"]'))), true);
  const inView = await mark.evaluate((n) => {
    const r = n.getBoundingClientRect();
    const box = n.closest('.drug-panel__body').getBoundingClientRect();
    return r.top >= box.top - 1 && r.top < box.bottom;
  });
  assert.equal(inView, true, 'панель прокручена к подсвеченному фрагменту');
  await page.screenshot({ path: `${output}/source_panel.png`, fullPage: false });
  // остальные главы раскрываются
  const closed = page.locator('.src-chapter:not([open])').first();
  await closed.locator('summary').click();
  await page.locator('.src-chapter[open]').nth(1).locator('.cr-text').first().waitFor({ timeout: 15000 });

  // метка [1] в тексте — то же; [0] открывает пояснение «Знания модели»
  await page.locator('button.cite[data-testid="msg.wchat.source.cite"]').nth(0).click();
  await page.locator('[data-testid="msg.wchat.source.view"][data-kind="clinrec"]').waitFor();
  await page.locator('button.cite_model').click();
  await page.locator('[data-testid="msg.wchat.source.view"][data-kind="model"]').waitFor({ timeout: 5000 });
  assert.match(await page.locator('.src-view_model').innerText(), /не на клинических рекомендациях/);
  await page.screenshot({ path: `${output}/model_panel.png`, fullPage: false });
  assert.deepEqual(errors, []);
});

test('после перезагрузки страницы карточки и метки [n] открывают источник', { skip }, async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'psy1');
  ctx.track(session.ctx);
  const { page } = session;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await B.open(page, ctx.app, '/work');
  ctx.app.ai.queue(
    { mode: 'tool', name: 'read_clinrec_section', arguments: { clinrec_id: 'gtr_2024', sections: ['5.1'] } },
    { mode: 'text', text: 'Тревога не менее 6 месяцев [1].' },
  );
  await page.fill(B.tid('msg.wchat.placeholder'), 'Сколько должна длиться тревога для диагноза ГТР?');
  await page.click(B.tid('msg.composer.send'));
  await page.locator(B.tid('msg.wchat.source.card')).first().waitFor({ timeout: 15000 });
  await page.waitForFunction(() => /[?&]thread=\d+/.test(location.search), null, { timeout: 5000 });
  await page.reload();
  const card = page.locator(B.tid('msg.wchat.source.card'));
  await card.last().waitFor({ timeout: 15000 });
  await card.last().click(); // в ленте и прошлый разговор этого треда: нужен источник последнего ответа
  const view = page.locator(B.tid('msg.wchat.source.view'));
  await view.waitFor({ timeout: 15000 });
  assert.equal(await view.getAttribute('data-section'), 'gtr_2024.n.5.1');
  await page.locator('.src-chapter[open] .cr-text', { hasText: '6 месяцев' }).first().waitFor({ timeout: 15000 });
  assert.deepEqual(errors, []);
});
