'use strict';
// covers: wave 3 F2 (2026-10-22): drug card «Инструкции», full section reader, search, answer sources.
// Хранилище знаний (Postgres) в тестовом мире выключено, поэтому ответы /work/api/drugs/*/instructions|search
// подменяются на уровне браузера по контракту из .agents/tasks/2026-10-22-knowledge-postgres.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useBrowserApp } = require('../lib/acceptance');
const B = require('../lib/browser');
const ctx = useBrowserApp();

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function openDrug(page) {
  await B.open(page, ctx.app, '/work?tab=chat');
  await page.fill(B.tid('msg.wchat.pick.search'), 'амитриптилин');
  await page.locator('[data-type="drug"]').first().click();
}

test('drug card: instructions list, TOC, full section with paging and table, search, sources', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'psy1', B.DESKTOP);
  ctx.track(session.ctx);
  const page = session.page;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const hits = [];
  await page.route('**/work/api/drugs/*/instructions', (r) =>
    json(r, {
      inn: { id: 1, name: 'амитриптилин' },
      documents: [
        {
          id: 'D1',
          label: 'Амитриптилин-АЛСИ',
          trade_name: 'Амитриптилин-АЛСИ',
          manufacturer_hint: 'АЛСИ',
          sections: 3,
          chunks: 9,
        },
      ],
    }),
  );
  await page.route('**/instructions/D1/toc', (r) =>
    json(r, {
      document: { id: 'D1', label: 'Амитриптилин-АЛСИ' },
      items: [
        { id: 'D1:s1', level: 2, title: 'Показания', path: 'Показания', page: 1 },
        { id: 'D1:s2', level: 2, title: 'Побочное действие', path: 'Побочное действие', page: 3 },
        { id: 'D1:s3', level: 3, title: 'Со стороны печени', path: 'Побочное действие / Со стороны печени', page: 3 },
      ],
    }),
  );
  await page.route('**/instructions/D1/sections/**', (r) => {
    const more = new URL(r.request().url()).searchParams.get('cursor');
    json(
      r,
      more
        ? {
            title: 'Побочное действие',
            path: 'Побочное действие',
            text: 'Хвост раздела <b>не html</b>',
            nextCursor: null,
            hasMore: false,
          }
        : {
            title: 'Побочное действие',
            path: 'Побочное действие',
            text: '## Частота\n\n| Орган | Частота |\n|---|---|\n| Печень | редко |\n\n- пункт <img src=x onerror=window.__xss=1>',
            nextCursor: 'c2',
            hasMore: true,
          },
    );
  });
  await page.route('**/work/api/drugs/*/search?*', (r) => {
    hits.push(r.request().url());
    json(r, {
      results: [
        {
          document_id: 'D1',
          label: 'Амитриптилин-АЛСИ',
          section_id: 'D1:s2',
          path: 'Побочное действие',
          page: 3,
          snippet: 'редко <b>печень</b>',
          score: 1,
          match_type: 'lexical',
        },
      ],
      total: 1,
      hasMore: false,
      fallback: null,
    });
  });
  await openDrug(page);
  await B.expectVisible(page, 'msg.drugs.instr.doc');
  // единственная инструкция раскрыта сразу: главы сложены, текст подгружается при раскрытии
  const chapters = page.locator('.drug-doc-body .src-chapter');
  await chapters.first().waitFor();
  assert.equal(await chapters.count(), 2);
  assert.equal(await page.locator('.drug-doc-body .src-chapter[open]').count(), 0, 'главы свёрнуты');
  await chapters.nth(1).locator('summary').click();
  await page.waitForSelector('.drug-doc-body .drug-doc .drug-doc-table');
  assert.equal(await page.locator('.drug-doc-table td').first().textContent(), 'Печень');
  const more = page.locator('.drug-doc-body [data-more]');
  assert.ok(await more.isVisible());
  await more.click();
  await page.waitForFunction(() =>
    document.querySelector('.src-chapter[open] .drug-doc').textContent.includes('Хвост раздела'),
  );
  assert.ok(
    (await page.locator('.src-chapter[open] .drug-doc').textContent()).includes('<b>не html</b>'),
    'текст — как текст',
  );
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.locator('.drug-find').count(), 0, 'поля «искать в инструкции» нет: вопрос задаётся ИИ');
  assert.equal(hits.length, 0, 'поиск по инструкции из карточки не вызывается');

  // источники под ответом ИИ
  await page.route('**/work/api/drugs/threads/*/messages', (r) =>
    json(
      r,
      {
        reply: {
          id: 777,
          text: 'Ответ по инструкции',
          sources: [
            { document_id: 'D1', label: 'Амитриптилин-АЛСИ', section_id: 'D1:s2', path: 'Побочное действие', page: 3 },
          ],
        },
      },
      201,
    ),
  );
  await page.click(B.tid('msg.drugs.ask'));
  await B.expectVisible(page, 'msg.wchat.drug_chip');
  await page.fill(B.tid('msg.wchat.placeholder'), 'Что с печенью?');
  await page.click(B.tid('msg.composer.send'));
  // Источник под ответом — карточка; клик открывает инструкцию целиком по коду документа: глава раздела раскрыта,
  // остальные свёрнуты (изменено 2026-10-26 вместе с карточками источников).
  await page.route('**/work/api/drugs/documents/D1', (r) =>
    json(r, {
      document: { id: 'D1', label: 'Амитриптилин-АЛСИ', trade_name: null },
      items: [
        { id: 'D1:s1', parent_id: null, level: 2, title: 'Показания', path: 'Показания', page: 1 },
        { id: 'D1:s2', parent_id: null, level: 2, title: 'Побочное действие', path: 'Побочное действие', page: 3 },
        {
          id: 'D1:s3',
          parent_id: 'D1:s2',
          level: 3,
          title: 'Со стороны печени',
          path: 'Побочное действие / Со стороны печени',
          page: 3,
        },
      ],
    }),
  );
  await page.route('**/work/api/drugs/documents/D1/sections/**', (r) =>
    json(r, {
      title: 'Побочное действие',
      path: 'Побочное действие',
      text: 'Начало раздела.\n\nПечень: повышение трансаминаз.\n\nКонец раздела.',
      offset: 0,
      total: 70,
      nextCursor: null,
      hasMore: false,
      mark: { start: 17, end: 52 },
    }),
  );
  await B.expectVisible(page, 'msg.wchat.source.card');
  assert.match(await page.locator(B.tid('msg.wchat.source.card')).textContent(), /Амитриптилин-АЛСИ/);
  assert.match(await page.locator(B.tid('msg.wchat.source.card')).textContent(), /стр\. 3/);
  await page.locator(B.tid('msg.wchat.source.card')).click();
  await B.expectVisible(page, 'msg.wchat.source.view');
  await page.locator(B.tid('msg.wchat.source.mark')).waitFor();
  assert.match(await page.locator(B.tid('msg.wchat.source.mark')).textContent(), /повышение трансаминаз/);
  assert.equal(await page.locator('.src-chapter').count(), 2, 'главы второго уровня; подраздел внутри главы');
  assert.equal(await page.locator('.src-chapter[open]').count(), 1);
  assert.equal(
    await page.locator('.src-chapter[open]').getAttribute('data-section'),
    'D1:s2',
    'раскрыта глава с источником',
  );
  assert.deepEqual(errors, []);
});

test('drug card: no instructions is stated explicitly; empty chat has no extra search field', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'psy1', B.DESKTOP);
  ctx.track(session.ctx);
  const page = session.page;
  await page.route('**/work/api/drugs/*/instructions', (r) =>
    json(r, { inn: { id: 1, name: 'амитриптилин' }, documents: [] }),
  );
  await B.open(page, ctx.app, '/work?tab=chat');
  assert.equal(await page.locator('[data-global-find]').count(), 0, 'пустого общего поля поиска в ленте нет');
  assert.equal(await page.locator(B.tid('msg.wchat.pick_patient')).count(), 0, 'строк про выбор пациента нет');
  await page.fill(B.tid('msg.wchat.pick.search'), 'амитриптилин');
  await page.locator('[data-type="drug"]').first().click();
  assert.ok(await B.noHorizontalOverflow(page));
  await B.expectVisible(page, 'msg.drugs.instr.none');
  assert.equal(await page.locator('.drug-find').count(), 0, 'без инструкций нет пустого поиска');
});

test('поиск чата: без ввода списка нет, подсказки — выпадающий список под полем (клинрек + лекарство), панель тянется, чип отличается от подсказок', async () => {
  const session = await B.contextAs(ctx.browser, ctx.app, 'psy1', B.DESKTOP);
  ctx.track(session.ctx);
  const page = session.page;
  await page.route('**/work/api/clinrecs?*', (r) =>
    json(r, { items: [{ id: 'CR1', title: 'Депрессивный эпизод', version: '2023' }] }),
  );
  await page.route('**/work/api/clinrecs/CR1', (r) =>
    json(r, {
      id: 'CR1',
      title: 'Депрессивный эпизод',
      version: '2023',
      pdf: true,
      sections: [{ id: 'S1', level: 2, title: 'Лечение' }],
    }),
  );
  await page.route('**/work/api/clinrecs/CR1/sections/S1', (r) =>
    json(r, {
      title: 'Лечение',
      text: '## Схемы\n\n**Первая линия** — СИОЗС\\*\n\n1. Сертралин\n  - 50 мг\n2. Эсциталопрам\n\n| Препарат | Доза | | |\n| --- | --- | --- | --- |\n| Сертралин | 50 мг | | |\n\n![](https://files.example.test/x.png)',
      nextCursor: null,
      hasMore: false,
      total: 20,
    }),
  );
  await B.open(page, ctx.app, '/work?tab=chat');
  const search = page.locator(B.tid('msg.wchat.pick.search'));
  await search.focus();
  assert.equal(await page.locator('[data-pick-results]').isHidden(), true, 'на фокусе списка нет');
  assert.equal(await page.locator('[data-type="patient"]').count(), 0, 'пациентов в поиске нет');
  await search.fill('деп');
  await page.locator('[data-pick-results] [data-type="clinrec"]').first().waitFor();
  const sBox = await search.boundingBox();
  const lBox = await page.locator('[data-pick-results]').boundingBox();
  assert.ok(lBox.y >= sBox.y + sBox.height - 1, 'список под полем');
  await page.locator('[data-pick-results] [data-type="clinrec"]').first().click();
  await page.locator('[data-drug-panel]').waitFor();
  assert.match(await page.locator('[data-drug-panel-body]').textContent(), /Лечение/);
  assert.equal(await page.locator(B.tid('msg.wchat.clinrec.pdf')).getAttribute('target'), '_blank');
  await page.locator('.clinrec-section summary').click();
  await page.locator('.cr-text table').waitFor();
  const shown = await page.locator('.clinrec-section .cr-text').textContent();
  assert.ok(!shown.includes('**') && !shown.includes('##') && !shown.includes('| ---'), 'служебных символов нет');
  assert.equal(await page.locator('.cr-text ol > li').count(), 2);
  assert.equal(await page.locator('.cr-text ol > li > ul > li').count(), 1, 'вложенный список');
  assert.equal(await page.locator('.cr-text th').count(), 2, 'пустые столбцы таблицы убраны');
  assert.equal(await page.locator('.cr-text img').count(), 0, 'внешние картинки не грузятся');
  // клинрек прикрепляется чипом, вопрос уходит на /work/api/clinrecs/:id/messages
  let asked = null;
  await page.route('**/work/api/clinrecs/CR1/messages', (r) => {
    asked = JSON.parse(r.request().postData() || '{}');
    json(
      r,
      {
        thread: { id: 7 },
        reply: { id: 1, role: 'assistant', text: 'Ответ по рекомендации', sources: [] },
        sources: [],
      },
      201,
    );
  });
  await page.click(B.tid('msg.drugs.ask'));
  await B.expectVisible(page, 'msg.wchat.clinrec_chip');
  await page.fill(B.tid('msg.wchat.placeholder'), 'Первая линия?');
  await page.click(B.tid('msg.composer.send'));
  await page.getByText('Ответ по рекомендации').waitFor();
  assert.equal(asked.text, 'Первая линия?');
  await page.locator(`${B.tid('msg.wchat.clinrec_chip')} ${B.tid('msg.composer.chip.remove')}`).click();
  // растягивание панели
  const panel = page.locator('[data-drug-panel]');
  const before = (await panel.boundingBox()).width;
  const handle = await page.locator('[data-panel-resizer]').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 200);
  await page.mouse.down();
  await page.mouse.move(handle.x - 120, handle.y + 200, { steps: 5 });
  await page.mouse.up();
  assert.ok((await panel.boundingBox()).width > before + 60, 'панель стала шире');
  // препарат: чип контекста и подсказки различимы, ссылки «Все материалы» нет
  await search.fill('амитриптилин');
  await page.locator('[data-type="drug"]').first().click();
  assert.equal(await page.getByText('Все материалы библиотеки').count(), 0);
  await page.click(B.tid('msg.drugs.ask'));
  await B.expectVisible(page, 'msg.wchat.drug_chip');
  assert.equal(await page.locator('[data-chips-label]').isVisible(), true, 'подпись «Контекст» у чипа');
  assert.equal(await page.locator('.chat-sugg.is-drug').count(), 1, 'подсказки оформлены отдельно');
});
