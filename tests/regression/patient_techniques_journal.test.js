'use strict';
// covers: F-27 — ИИ-помощник пациента: инструмент методик самопомощи с карточкой-ссылкой и поиск статьи об Авиандре в журнале.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk } = require('../lib/client');
const F = require('../lib/flows');
const journalStore = require('../../src/modules/journal/store');
const catalog = require('../../src/modules/techniques/catalog');
const ctx = useApp();

const tool = (name, args = {}) => ({ mode: 'tool', name, arguments: args });
const names = (call) => (call.tools || []).map((t) => t.name);

test('методики: каждая в каталоге описана для ИИ (когда подходит, чего остерегаться)', () => {
  assert.ok(catalog.TECHNIQUES.length >= 4);
  for (const x of catalog.TECHNIQUES) {
    assert.ok(x.suits && x.caution, `${x.slug}: нет suits/caution`);
    assert.ok(catalog.bySlug(x.slug));
  }
});

test('тревога: модель смотрит список методик и предлагает одну — в ответе карточка со ссылкой', async () => {
  const p = await ctx.as('patA');
  ctx.app.ai.reset();
  ctx.app.ai.queue(tool('list_techniques'), tool('offer_technique', { slug: 'grounding-54321' }), {
    mode: 'text',
    text: 'Мне жаль, что так тревожно. Можно попробовать упражнение, оно займёт пару минут.',
  });
  const r = expectOk(await F.patientAsk(p, 'Меня накрывает тревога, сердце колотится'));
  assert.deepEqual(r.technique, {
    slug: 'grounding-54321',
    title: 'Заземление 5-4-3-2-1',
    minutes: '5 мин',
    url: '/methods/grounding-54321',
  });
  const calls = ctx.app.ai.calls();
  assert.ok(names(calls[0]).includes('list_techniques') && names(calls[0]).includes('offer_technique'));
  // модель получила описание методик с показаниями
  assert.match(JSON.stringify(calls[1].messages), /grounding-54321[\s\S]*Подходит/);
  // страница по ссылке открывается
  assert.equal((await p.get(r.technique.url)).status, 200);
});

test('методики: сервер подбирает методику при жалобе, карточка по факту; неверный код модели её не отменяет', async () => {
  const p = await ctx.fresh('patB');
  ctx.app.ai.reset();
  ctx.app.ai.queue(tool('offer_technique', { slug: 'нет-такой' }), { mode: 'text', text: 'Давай поговорим.' });
  const bad = expectOk(await F.patientAsk(p, 'Мне тревожно'));
  assert.equal(bad.technique.slug, 'grounding-54321');
  assert.match(JSON.stringify(ctx.app.ai.calls()[0].messages), /Подсказка сервера[\s\S]*Заземление 5-4-3-2-1/);
  // в том же диалоге второй раз не подсказывается
  ctx.app.ai.reset();
  ctx.app.ai.setDefault({ mode: 'text', text: 'Я рядом.' });
  const again = expectOk(await F.patientAsk(p, 'Всё равно тревожно', { thread_id: bad.thread.id }));
  assert.equal(again.technique, undefined);
  assert.doesNotMatch(JSON.stringify(ctx.app.ai.calls()[0].messages), /Подсказка сервера/);
});

test('методики: выбор по жалобе (сон, сердце, напряжение); вопросы без жалобы и «выговориться» без подсказки', async () => {
  const pre = require('../../src/ai/patientPreretrieval');
  const slug = (text) => pre.pickTechnique({ text })?.slug || null;
  assert.equal(slug('Не могу уснуть, всё время тревожно'), 'breathing-478');
  assert.equal(slug('Не могу уснуть, тревожно, давит сердце'), 'pmr', 'при жалобе на сердце без задержек дыхания');
  assert.equal(slug('Плечи зажаты, тревожно'), 'pmr');
  assert.equal(slug('Накрыла паника'), 'grounding-54321');
  assert.equal(slug('Когда мой следующий визит?'), null);
  assert.equal(slug('Мне тревожно, хочу просто выговориться'), null);
  assert.equal(slug('Тревожно после таблетки, можно ли принимать'), null, 'вопрос о приёме — по теме, без методики');
  assert.equal(pre.pickTechnique({ text: 'Мне тревожно', alreadyOffered: true }), null);
});

test('обещание «карточку приложил» без карточки убирается из ответа', async () => {
  const p = await ctx.fresh('patC');
  ctx.app.ai.reset();
  ctx.app.ai.setDefault({ mode: 'text', text: 'Хорошо, что написала. Я приложил карточку ниже. Береги себя.' });
  const r = expectOk(await F.patientAsk(p, 'Сегодня был длинный день'));
  assert.doesNotMatch(r.reply.text, /карточк/);
  assert.match(r.reply.text, /Береги себя/);
});

test('журнал: статья про Авиандр есть и находится по вопросам пациентов', () => {
  const db = ctx.app.db();
  try {
    const journal = journalStore.create(db, () => Date.now());
    const patient = { id: 0, role: 'patient' };
    for (const q of [
      'можно запивать Авиандр молоком',
      'пропустила таблетку Авиандра',
      'авиандр побочные эффекты',
      'принимать авиандр до или после еды',
    ]) {
      const found = journal.search(patient, q, 3);
      assert.ok(found.length, q);
      assert.match(found[0].title, /Авиандр/, `первая статья по «${q}»`);
    }
    const item = journal.search(patient, 'Авиандр', 1)[0];
    const full = journal.article(patient, item.id);
    assert.equal(full.audience, 'patient');
    for (const part of ['за 30 минут до еды', 'пропустили', 'не отменяйте', '112', 'молок'])
      assert.ok(full.body_md.includes(part), `в статье нет «${part}»`);
    assert.doesNotMatch(full.body_md, /\d+\s*мг/, 'без доз');
  } finally {
    db.close();
  }
});

test('вопрос про Авиандр: модель ищет в журнале, под ответом кнопка-ссылка на статью', async () => {
  const p = await ctx.as('patA');
  ctx.app.ai.reset();
  ctx.app.ai.queue(tool('search_journal', { query: 'Авиандр молоко' }), {
    mode: 'text',
    text: 'В журнале есть статья о приёме Авиандра, там про это написано.',
  });
  const r = expectOk(await F.patientAsk(p, 'Можно запивать Авиандр молоком?'));
  assert.ok(Array.isArray(r.articles) && r.articles.length >= 1);
  assert.match(r.articles[0].title, /Авиандр/);
  assert.match(r.articles[0].url, /^\/journal\/\d+$/);
  assert.equal((await p.get(r.articles[0].url)).status, 200);
});

test('вопрос про Авиандр без вызова инструмента: сервер подкладывает статью и возвращает ссылку', async () => {
  const p = await ctx.fresh('patD');
  for (const q of ['Можно запивать Авиандр молоком?', 'Пропустила таблетку Авиандра, что делать?']) {
    ctx.app.ai.reset();
    ctx.app.ai.setDefault({ mode: 'text', text: 'Ответ по статье.' });
    const r = expectOk(await F.patientAsk(p, q));
    assert.ok(r.articles?.length, `ссылка на статью: ${q}`);
    assert.match(r.articles[0].title, /Авиандр/);
    const sent = JSON.stringify(ctx.app.ai.calls()[0].messages);
    assert.match(sent, /Материал журнала по теме вопроса/);
    assert.match(sent, /за 30 минут до еды/);
    assert.equal(r.technique, undefined);
  }
  ctx.app.ai.reset();
  ctx.app.ai.setDefault({ mode: 'text', text: 'Это запись про настроение.' });
  const other = expectOk(await F.patientAsk(p, 'Что такое дневник настроения?'));
  assert.equal(other.articles, undefined, 'без вопроса о лекарстве статья не подкладывается');
  assert.doesNotMatch(JSON.stringify(ctx.app.ai.calls()[0].messages), /Материал журнала по теме вопроса/);
});

test('сидирование журнала обновляет текст внесённой статьи, пока её не правил администратор', () => {
  const P = require('../../src/platform');
  const { ensureJournalSeed } = require('../../src/modules/journal/seed');
  const db = ctx.app.db();
  try {
    const row = db.prepare("SELECT id FROM library_items WHERE slug='journal-patient-aviandr'").get();
    const body = () =>
      db.prepare('SELECT body_md FROM library_versions WHERE item_id=? AND version=1').get(row.id).body_md;
    const fresh = body();
    db.prepare("UPDATE library_versions SET body_md='старый текст' WHERE item_id=? AND version=1").run(row.id);
    assert.ok(ensureJournalSeed(db, P, new Date()) >= 1);
    assert.equal(body(), fresh, 'текст из articles.js восстановлен');
    assert.equal(ensureJournalSeed(db, P, new Date()), 0, 'повторный запуск ничего не меняет');
    // админ правил статью (версия 2): сидирование её не трогает
    db.prepare("UPDATE library_versions SET body_md='правка админа' WHERE item_id=? AND version=1").run(row.id);
    db.prepare('UPDATE library_items SET current_version=2 WHERE id=?').run(row.id);
    ensureJournalSeed(db, P, new Date());
    assert.equal(body(), 'правка админа');
    db.prepare('UPDATE library_items SET current_version=1 WHERE id=?').run(row.id);
    db.prepare('UPDATE library_versions SET body_md=? WHERE item_id=? AND version=1').run(fresh, row.id);
  } finally {
    db.close();
  }
});
