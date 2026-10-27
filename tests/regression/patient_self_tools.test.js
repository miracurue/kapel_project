'use strict';
// covers: F-27, F-80, PD-14; чат пациента читает данные САМОГО пациента и журнал инструментами (tool use):
// id пациента задаёт сервер, баллы тестов модели не отдаются, дозы не отдаются, журнал только для пациентов, доступ пишется в журнал.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk } = require('../lib/client');
const F = require('../lib/flows');
const ctx = useApp();
const CANARY = 'ЗАМЕТКАСВОЯ';

const tool = (name, args = {}) => ({ mode: 'tool', name, arguments: args });
const say = (text) => ({ mode: 'text', text });
const ask = async (key, text, ...queue) => {
  const p = await ctx.as(key);
  ctx.app.ai.reset();
  ctx.app.ai.queue(...queue);
  const r = expectOk(await F.patientAsk(p, text));
  return { r, calls: ctx.app.ai.calls() };
};
const toolText = (calls) => (calls[1].messages.find((m) => m.role === 'tool') || {}).content || '';

test('дневник: модель получает записи пациента по запросу, в первом запросе данных нет; запись в журнале доступа', async () => {
  const db = ctx.app.db();
  try {
    db.prepare(
      'INSERT INTO mood_entries(patient_id,entry_date,mood,sleep,anxiety,note,created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(ctx.id('patA'), new Date().toISOString().slice(0, 10), 2, 'bad', 'strong', CANARY, new Date().toISOString());
  } finally {
    db.close();
  }
  const { r, calls } = await ask(
    'patA',
    'Как у меня с дневником?',
    tool('get_my_diary', { days: 7 }),
    say('Вижу записи. Расскажешь, как прошёл день?'),
  );
  assert.equal(r.reply.text, 'Вижу записи. Расскажешь, как прошёл день?');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].tools.some((t) => t.name === 'get_my_diary'));
  assert.ok(!JSON.stringify(calls[0].messages).includes(CANARY), 'данные не приложены к первому запросу');
  const content = toolText(calls);
  assert.match(content, /Запись за сегодня .*: есть/);
  assert.match(content, /настроение 2\/5/);
  assert.match(content, new RegExp(CANARY));
  const log = ctx.app.query(
    "SELECT basis FROM phi_access_log WHERE section='ai.tool' AND patient_id=? AND actor_id=?",
    ctx.id('patA'),
    ctx.id('patA'),
  );
  assert.ok(log.length >= 1);
  assert.equal(log[0].basis, 'self');
});

test('тесты: модель видит факт прохождения и дату, но не баллы и уровни', async () => {
  const db = ctx.app.db();
  try {
    db.prepare(
      'INSERT INTO online_results(patient_id,instrument,instrument_version,answers_json,total_score,band,risk_flag,self_initiated,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(ctx.id('patA'), 'phq9', 1, '[]', 17, 'умеренно-тяжёлая', 0, 1, new Date().toISOString());
  } finally {
    db.close();
  }
  const { calls } = await ask('patA', 'Какие тесты я проходил?', tool('get_my_tests'), say('Ты проходил тесты.'));
  const content = toolText(calls);
  assert.match(content, /Пройдены: .*\d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(content, /17|умеренно-тяжёлая/);
  assert.match(content, /Баллы и уровни пациенту не показываются/);
});

test('журнал: поиск возвращает только статьи для пациентов, ответ содержит ссылки на найденные статьи', async () => {
  const db = ctx.app.db();
  let item;
  try {
    item = db
      .prepare(
        "SELECT li.id, lv.title FROM library_items li JOIN library_versions lv ON lv.item_id=li.id AND lv.version=li.current_version WHERE li.media='read' AND li.status='published' AND li.audience='patient' LIMIT 1",
      )
      .get();
    db.prepare('SELECT 1').get();
  } finally {
    db.close();
  }
  assert.ok(item, 'в журнале есть статья для пациентов');
  const word = item.title.split(/\s+/).find((w) => w.length > 4) || item.title;
  const { r, calls } = await ask(
    'patA',
    'Есть что почитать?',
    tool('search_journal', { query: word }),
    say('Посмотри статью, она может помочь.'),
  );
  assert.match(toolText(calls), new RegExp(`№${item.id} `));
  assert.ok(Array.isArray(r.articles) && r.articles.some((a) => a.id === item.id && a.url === `/journal/${item.id}`));
});

test('журнал: статья для специалистов пациенту недоступна, пустой запрос ничего не находит', async () => {
  const db = ctx.app.db();
  let spec;
  try {
    spec = db.prepare("SELECT id FROM library_items WHERE media='read' AND audience='specialist' LIMIT 1").get();
  } finally {
    db.close();
  }
  const { calls } = await ask(
    'patA',
    'Открой статью',
    tool('read_journal_article', { id: spec ? spec.id : 999999 }),
    say('Такой статьи нет.'),
  );
  assert.match(toolText(calls), /Такой статьи для пациентов нет/);
  const second = await ask('patA', 'Найди', tool('search_journal', { query: '??' }), say('Ничего.'));
  assert.match(toolText(second.calls), /ничего не нашлось/);
});

test('лекарства: список по плану и отметки приёма без доз; без согласия на ИИ инструменты не вызываются', async () => {
  const { calls } = await ask(
    'patA',
    'Что мне сегодня принять?',
    tool('get_my_medications', { days: 2 }),
    say('Посмотри в плане.'),
  );
  const content = toolText(calls);
  assert.match(content, /\(сегодня\)/);
  assert.doesNotMatch(content, /\d\s*мг/i);
  const g = await ctx.as('patG');
  ctx.app.ai.reset();
  const r = await F.patientAsk(g, 'Что с дневником?');
  assert.equal(r.status, 403);
  assert.equal(ctx.app.ai.calls().length, 0);
});
