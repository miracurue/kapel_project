'use strict';
// covers: F-26, F-27, F-16, PD-16, PD-17; «защита от дурака» (решение владелицы 2026-10-27, prompts/guard):
//  - специалист: нецелевое обращение ([[OFFTOPIC]] от модели или пустое первое сообщение) даёт стандартное сообщение,
//    шаблон и статья не создаются, осмысленный короткий запрос идёт как обычно;
//  - пациент: метки [[GAME]]/[[RUDE]] вырезаются из показа и истории, три за 3 часа включают паузу чата на час
//    (проверка на сервере), пауза истекает сама и снимается админом; кризис не блокируется и меток не создаёт.
// ИИ — local_stub: сам он смысл не оценивает, метки приходят из очереди ответов; проверяется обвязка вокруг модели.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const texts = require('../../src/ai/texts');
const { createPlanSpec } = require('../../src/ai/workspace/clinrecPlan');
const guardMarks = require('../../src/ai/guardMarks');

const ctx = useApp();
const say = (text) => ({ mode: 'text', text });
const OFF = 'Извините, кажется, мне нечего сказать. Либо измените тему, либо уточните вопрос.';
const PAUSED = 'Мне кажется, вы меня разыгрываете, я от этого очень устаю. Ровно час я буду отдыхать, потом можем снова пообщаться.';
const HOUR = 60 * 60 * 1000;

const marksOf = (key) => ctx.app.query('SELECT kind FROM patient_chat_marks WHERE patient_id = ? ORDER BY id', ctx.id(key));
const blocksOf = (key) => ctx.app.query('SELECT * FROM patient_chat_blocks WHERE patient_id = ? ORDER BY id', ctx.id(key));
const askClinician = async (who, text) => {
  const c = await ctx.as(who);
  return c.post('/api/v1/ai/clinician/messages', { text, chips: [], new_thread: true });
};
// Сдвиг часов теста с гарантированным возвратом; после сдвига сессии могли истечь — берём свежий вход.
const withClock = async (ms, fn) => {
  await ctx.app.advanceClock(ms);
  try {
    return await fn();
  } finally {
    await ctx.app.advanceClock(-ms);
  }
};
const ask = async (patient, text, extra) => patient.post('/api/v1/ai/patient/messages', { text, ...extra });

test('тексты: сообщение об отказе и подпись паузы дословно как утвердила владелица', () => {
  assert.equal(texts.OFF_TOPIC_REPLY, OFF);
  assert.equal(texts.CHAT_PAUSED, PAUSED);
  const ru = require('../../locales/ru.json');
  assert.equal(ru['msg.chat.troll.paused'], PAUSED);
  assert.equal(ru['err.e-chat-paused'], PAUSED);
});

test('разбор меток: вырезаются любые формы, счёт без повторов, пустота определяется без оценки смысла', () => {
  assert.deepEqual(guardMarks.stripConduct('Давай к делу.\n[[GAME]]'), { text: 'Давай к делу.', marks: ['GAME'] });
  assert.deepEqual(guardMarks.stripConduct('Хорошо. [[ rude ]] Ещё [GAME] [[GAME]]'), { text: 'Хорошо. Ещё', marks: ['RUDE', 'GAME'] });
  assert.equal(guardMarks.pickMark(['GAME', 'RUDE']), 'RUDE');
  assert.equal(guardMarks.pickMark([]), null);
  assert.ok(guardMarks.hasOffTopic('  [[OFFTOPIC]] '));
  assert.ok(!guardMarks.hasOffTopic('нужно уточнить тему'));
  for (const t of ['', ' ', 'ф', '?', '..', ' 1 ']) assert.ok(guardMarks.isTrivial(t), `«${t}» пусто`);
  for (const t of ['БАР', 'ок', 'F32', 'Зелёная трава']) assert.ok(!guardMarks.isTrivial(t), `«${t}» не пусто`);
});

test('планировщик: признак offtopic возвращается без поиска и без обращений к знаниям', async () => {
  const spec = createPlanSpec({
    clinrec: { retrieval: { docs: [{ id: 'x_1', title: 'Рекомендация' }], drugsLoaded: false } },
    embeddingClient: () => null,
    question: 'Зелёная трава',
  });
  const asked = [];
  const out = await spec.execute({
    ask: async (a) => (asked.push(a.key), '{"offtopic":true}'),
    step: () => {},
    progress: () => {},
    history: [],
  });
  assert.deepEqual(out, { offTopic: true });
  assert.deepEqual(asked, ['tools.clinrec_plan']);
});

test('специалист: нецелевой вопрос — стандартное сообщение, слой защиты подключён отдельно; короткий осмысленный идёт как обычно', async () => {
  ctx.app.ai.reset();
  ctx.app.ai.queue(say('[[OFFTOPIC]]'));
  const r = expectOk(await askClinician('psy1', 'Зелёная трава'), 201);
  assert.equal(r.reply.text, OFF);
  assert.ok(!/OFFTOPIC/.test(JSON.stringify(r)), 'метка не показывается');
  const [call] = ctx.app.ai.calls();
  assert.match(call.system, /Защита от нецелевых запросов/);
  assert.match(call.system, /лечение БАР/, 'в слое есть примеры границы');
  const audit = ctx.app.query("SELECT prompt_layers_json FROM ai_audit WHERE purpose = 'clinician_chat' ORDER BY id DESC LIMIT 1")[0];
  assert.ok(JSON.parse(audit.prompt_layers_json).some((l) => l.key === 'guard.scope_clinician'), 'слой записан в журнал версий');

  ctx.app.ai.reset();
  ctx.app.ai.queue(say('Литий — основа терапии БАР [0].'));
  const ok = expectOk(await askClinician('psy1', 'лечение БАР'), 201);
  assert.match(ok.reply.text, /Литий/);
  assert.equal(ctx.app.ai.calls().length, 1);
});

test('специалист: пустое или односимвольное первое сообщение отсекается без вызова модели', async () => {
  ctx.app.ai.reset();
  const r = expectOk(await askClinician('psy1', 'ф'), 201);
  assert.equal(r.reply.text, OFF);
  assert.equal(ctx.app.ai.calls().length, 0, 'модель не вызывалась');
});

test('чат лекарства и чат клинрека: нецелевой вопрос тоже даёт стандартное сообщение', async () => {
  const psy = await ctx.as('psy1');
  const inn = ctx.app.query("SELECT id FROM inn WHERE status = 'in_catalog' ORDER BY id LIMIT 1")[0];
  assert.ok(inn, 'в каталоге есть МНН');
  const th = expectOk(await psy.post(`/work/api/drugs/${inn.id}/open`, {}), 201);
  ctx.app.ai.reset();
  ctx.app.ai.queue(say('[[OFFTOPIC]]'));
  const r = expectOk(await psy.post(`/work/api/drugs/threads/${th.thread.id}/messages`, { text: 'рецепт булочек' }), 201);
  assert.equal(r.reply.text, OFF);
});

test('шаблон по описанию: нецелевой запрос выводится в чате, шаблон не создаётся и не меняется', async () => {
  const psy = await ctx.as('psy1');
  const before = ctx.app.query('SELECT count(*) n FROM tool_templates')[0].n;
  ctx.app.ai.reset();
  ctx.app.ai.queue(say('[[OFFTOPIC]]'));
  const r = expectOk(await psy.post('/work/api/templates/ai', { request: 'шаблон: рецепт булочек' }, { idem: false }));
  assert.equal(r.off_topic, true);
  assert.equal(r.message, OFF);
  assert.equal(r.body, undefined, 'текста шаблона нет');
  assert.equal(ctx.app.query('SELECT count(*) n FROM tool_templates')[0].n, before);
  // обычный запрос работает как раньше
  ctx.app.ai.queue(say('Памятка пациенту.'));
  const okr = expectOk(await psy.post('/work/api/templates/ai', { request: 'памятка пациенту' }, { idem: false }));
  assert.equal(okr.body, 'Памятка пациенту.');
  assert.equal(okr.off_topic, undefined);
  // пустое описание — прежняя валидация, одиночный символ — без модели
  ctx.app.ai.reset();
  const one = expectOk(await psy.post('/work/api/templates/ai', { request: 'ф' }, { idem: false }));
  assert.equal(one.off_topic, true);
  assert.equal(ctx.app.ai.calls().length, 0);
});

test('статья по мыслям и правка фрагмента: нецелевой запрос не меняет статью, попытка не сохраняется', async () => {
  const doc = await ctx.as('psy1');
  ctx.app.ai.reset();
  ctx.app.ai.queue(say('[[OFFTOPIC]]'));
  const draft = expectOk(await doc.post('/work/api/library/ai', { thoughts: 'Зелёная трава' }, { idem: false }));
  assert.equal(draft.off_topic, true);
  assert.equal(draft.message, OFF);
  assert.equal(draft.body_md, undefined);

  const made = expectOk(await doc.post('/work/api/library', { title: 'Черновик', body_md: 'Текст', audience: 'patient' }, { idem: false }), 201);
  const itemId = made.id;
  const versionsBefore = ctx.app.query('SELECT count(*) n FROM library_versions WHERE item_id = ?', itemId)[0].n;
  ctx.app.ai.queue(say('[[OFFTOPIC]]'));
  const withItem = expectOk(await doc.post('/work/api/library/ai', { thoughts: 'рецепт булочек', item_id: itemId }, { idem: false }));
  assert.equal(withItem.off_topic, true);
  assert.equal(ctx.app.query('SELECT count(*) n FROM library_versions WHERE item_id = ?', itemId)[0].n, versionsBefore, 'версия не создана');
  assert.equal(ctx.app.query('SELECT count(*) n FROM library_chat WHERE item_id = ?', itemId)[0].n, 0, 'попытка в беседе не осталась');

  ctx.app.ai.queue(say('[[OFFTOPIC]]'));
  const rw = expectOk(await doc.post('/work/api/library/ai/rewrite', { fragment: 'Зелёная трава', instruction: '' }, { idem: false }));
  assert.equal(rw.off_topic, true);
  assert.equal(rw.text, undefined);
});

test('пациент: метка вырезается из ответа, из истории и из следующего запроса, но остаётся событием', async () => {
  const p = await ctx.as('patA');
  ctx.app.ai.reset();
  ctx.app.ai.queue(say('Я здесь не для споров. Расскажешь, как ты сейчас?\n[[GAME]]'));
  const r = expectOk(await ask(p, 'Слабо меня разозлить? Спорим, ты не умеешь шутить'), 201);
  assert.equal(r.reply.text, 'Я здесь не для споров. Расскажешь, как ты сейчас?');
  assert.ok(!/GAME/.test(JSON.stringify(r)));
  const [call] = ctx.app.ai.calls();
  assert.match(call.system, /Поведение в беседе/);
  assert.match(call.system, /\[\[GAME\]\]/, 'модель знает о метках');
  const stored = ctx.app.query("SELECT text FROM ai_messages WHERE thread_id = ? AND role = 'assistant'", r.thread.id);
  assert.ok(stored.every((m) => !/GAME/.test(m.text)), 'в базе метки нет');
  assert.deepEqual(marksOf('patA'), [{ kind: 'GAME' }]);
  assert.equal(ctx.app.query("SELECT count(*) n FROM action_log WHERE action = 'chat.conduct_mark' AND target_user_id = ?", ctx.id('patA'))[0].n, 1, 'событие в журнале');
  const logRow = ctx.app.query("SELECT new_safe_json FROM action_log WHERE action = 'chat.conduct_mark' ORDER BY id DESC LIMIT 1")[0];
  assert.deepEqual(JSON.parse(logRow.new_safe_json), { kind: 'GAME' }, 'в журнале только вид метки, без текста');
  const layers = ctx.app.query("SELECT prompt_layers_json FROM ai_audit WHERE purpose = 'patient_assistant' ORDER BY id DESC LIMIT 1")[0];
  assert.ok(JSON.parse(layers.prompt_layers_json).some((l) => l.key === 'guard.patient_conduct'));
  assert.equal(blocksOf('patA').length, 0, 'одна метка паузу не включает');
});

test('пациент: три метки за 3 часа включают паузу на час; сервер не пускает сообщение, кризис проходит; через час пауза истекает сама', async () => {
  const p = await ctx.as('patB');
  ctx.app.ai.reset();
  ctx.app.ai.queue(say('Давай к делу.\n[[GAME]]'), say('Мне хочется вежливого разговора.\n[[RUDE]]'), say('Вернёмся к теме.\n[[GAME]]'));
  expectOk(await ask(p, 'ну давай поспорим'), 201);
  expectOk(await ask(p, 'ты тупая'), 201);
  const third = expectOk(await ask(p, 'а слабо ответить грубо?'), 201);
  assert.ok(third.chat_paused && third.chat_paused.blocked_until, 'ответ сообщает о паузе');
  assert.deepEqual(marksOf('patB').map((m) => m.kind), ['GAME', 'RUDE', 'GAME'], 'метки любой комбинации');
  const [block] = blocksOf('patB');
  assert.equal(new Date(block.blocked_until) - new Date(block.started_at), HOUR, 'ровно час');

  // сервер отказывает без вызова модели
  ctx.app.ai.reset();
  const denied = await ask(p, 'привет, как дела?');
  expectError(denied, 429, 'E-CHAT-PAUSED');
  assert.equal(denied.body.error.details.blocked_until, block.blocked_until);
  assert.equal(ctx.app.ai.calls().length, 0);

  // страница чата: поле неактивно с дословной подписью, экстренная помощь на месте
  const page = String((await p.get('/app?tab=chat&new=1', { headers: { accept: 'text/html' } })).body);
  assert.match(page, /Мне кажется, вы меня разыгрываете, я от этого очень устаю\. Ровно час я буду отдыхать, потом можем снова пообщаться\./);
  assert.match(page, /<textarea[^>]*msg\.chat\.placeholder[^>]*disabled/);
  assert.match(page, /tel:112/);

  // кризис не блокируется даже в паузе: карточка 112, тред кризиса, меток не прибавилось
  const crisis = expectOk(await F.patientAsk(p, F.CRISIS_PHRASE));
  assert.ok(crisis.crisis && crisis.crisis_thread, 'кризисная фраза обработана');
  const inCrisis = await ask(p, 'мне очень тяжело', { thread_id: crisis.crisis_thread.id });
  assert.ok([200, 201].includes(inCrisis.status), 'в кризисном треде разговор идёт и при паузе');
  assert.equal(marksOf('patB').length, 3);

  // через час пауза снимается сама
  await withClock(HOUR + 60 * 1000, async () => {
    const fresh = await ctx.fresh('patB');
    ctx.app.ai.queue(say('Здравствуй! Как ты?'));
    const after = await ask(fresh, 'привет');
    assert.ok([200, 201].includes(after.status), `после часа сообщение принято, статус ${after.status}`);
  });
});

test('пациент: две метки, пауза в 3 часа и ещё одна — паузы нет (скользящее окно)', async () => {
  const p = await ctx.as('patC');
  ctx.app.ai.reset();
  ctx.app.ai.queue(say('Ок.\n[[GAME]]'), say('Ок.\n[[RUDE]]'));
  expectOk(await ask(p, 'слабо?'), 201);
  expectOk(await ask(p, 'дура'), 201);
  await withClock(3 * HOUR + 60 * 1000, async () => {
    const fresh = await ctx.fresh('patC');
    ctx.app.ai.queue(say('Ок.\n[[GAME]]'));
    const r = expectOk(await ask(fresh, 'а ну-ка докажи'), 201);
    assert.equal(r.chat_paused, undefined, 'старые метки вышли из окна');
    assert.equal(blocksOf('patC').length, 0);
  });
});

test('пациент: в кризисном разговоре метки не ставятся и не считаются', async () => {
  const { p, r } = await (async () => {
    const pat = await ctx.as('patH');
    ctx.app.ai.reset();
    return { p: pat, r: expectOk(await F.patientAsk(pat, F.CRISIS_PHRASE)) };
  })();
  ctx.app.ai.queue(
    { mode: 'tool', name: 'assess_crisis', arguments: { level: 'passive_ideation', safe_now: 'unknown', alone: 'yes', means: 'unknown', confidence: 'medium', note: 'Устал жить.' } },
    say('Я рядом. Расскажи, что сейчас происходит.\n[[GAME]]'),
  );
  const turn = await ask(p, 'мне тяжело', { thread_id: r.crisis_thread.id });
  assert.ok([200, 201].includes(turn.status), `ход кризисного разговора принят, статус ${turn.status}`);
  for (const call of ctx.app.ai.calls()) assert.doesNotMatch(call.system, /Поведение в беседе/, 'кризисный режим слоя не получает');
  assert.equal(marksOf('patH').length, 0, 'метки в кризисе не считаются');
});

test('админ: статус виден в списке и карточке без содержимого чатов, снимается вручную; специалист не может', async () => {
  const pid = ctx.id('patC');
  const until = new Date(Date.now() + 2 * 24 * HOUR).toISOString();
  ctx.app.exec(`INSERT INTO patient_chat_blocks(patient_id, started_at, blocked_until) VALUES (${pid}, '${new Date().toISOString()}', '${until}')`);
  const admin = await ctx.as('admin1');
  const list = expectOk(await admin.get('/api/v1/admin/people?filter=patients'));
  const row = list.items.find((x) => x.id === pid);
  assert.ok(row && row.chat_troll && row.chat_troll.until, 'в списке виден срок');
  assert.ok(!/(text|message|thread)/i.test(JSON.stringify(row)), 'содержимого чатов нет');
  const card = expectOk(await admin.get(`/api/v1/admin/people/${pid}`));
  assert.ok(card.chat_troll && card.chat_troll.until);

  // пока пауза действует, сообщение не принимается
  const p = await ctx.as('patC');
  expectError(await ask(p, 'привет'), 429, 'E-CHAT-PAUSED');

  expectError(await (await ctx.as('psy1')).post(`/api/v1/admin/people/${pid}/chat-troll/clear`, {}), 403, 'E-ACCESS');
  expectError(await admin.post(`/api/v1/admin/people/${ctx.id('psy1')}/chat-troll/clear`, {}), 404, 'E-NOT-FOUND');
  const cleared = expectOk(await admin.post(`/api/v1/admin/people/${pid}/chat-troll/clear`, {}));
  assert.equal(cleared.cleared, true);
  assert.equal(expectOk(await admin.get(`/api/v1/admin/people/${pid}`)).chat_troll, null);
  assert.ok(ctx.app.query("SELECT 1 FROM admin_action_log WHERE action = 'chat_troll_clear' AND target_user_id = ?", pid).length >= 1, 'снятие в журнале');

  ctx.app.ai.reset();
  ctx.app.ai.queue(say('Здравствуй!'));
  const again = await ask(p, 'привет');
  assert.ok([200, 201].includes(again.status), 'после снятия отправка работает');
});

test('пациент: совсем посторонняя просьба не даёт метки и не включает паузу (слой лишь регламентирует ответ)', async () => {
  const p = await ctx.as('patI');
  ctx.app.ai.reset();
  ctx.app.ai.queue(say('Рецептами я не занимаюсь, но могу поговорить о том, что тебя беспокоит. Как ты сегодня?'));
  const r = expectOk(await ask(p, 'дай рецепт борща'), 201);
  assert.match(r.reply.text, /Как ты сегодня/);
  assert.equal(marksOf('patI').length, 0);
  assert.match(ctx.app.ai.calls()[0].system, /сырники/, 'в слое есть пример границы «сырники»');
});
