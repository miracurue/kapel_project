'use strict';
// covers: F-13, F-32, F-80, PD-14; ИИ специалиста получает данные закреплённого пациента инструментами (tool use):
// цикл «модель просит — сервер отдаёт», видимость дневника на каждом чтении, роль, псевдонимизация, журнал доступа.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const ctx = useApp();
const CANARY = 'ЗАМЕТКАКАНАРЕЙКА';

function prefs(scores, notes) {
  const db = ctx.app.db();
  try {
    db.prepare('UPDATE user_prefs SET share_diary_scores=?, share_diary_notes=? WHERE user_id=?').run(scores, notes, ctx.id('patA'));
  } finally {
    db.close();
  }
}

function seedDiary() {
  const db = ctx.app.db();
  try {
    db.prepare('INSERT INTO mood_entries(patient_id,entry_date,mood,sleep,anxiety,note,created_at) VALUES (?,?,?,?,?,?,?)').run(
      ctx.id('patA'),
      new Date().toISOString().slice(0, 10),
      2,
      'bad',
      'strong',
      CANARY,
      new Date().toISOString(),
    );
  } finally {
    db.close();
  }
}

const ask = async (who, tool, args = {}) => {
  const doc = await ctx.as(who);
  ctx.app.ai.reset();
  ctx.app.ai.queue({ mode: 'tool', name: tool, arguments: args }, { mode: 'text', text: 'Готово, черновик для проверки.' });
  const r = expectOk(
    await doc.post('/api/v1/ai/clinician/messages', {
      patient_id: ctx.id('patA'),
      text: 'Что в дневнике?',
      chips: [{ type: 'patient', id: ctx.id('patA') }],
    }),
  );
  return { r, calls: ctx.app.ai.calls() };
};

test('закреплённый пациент: модель получает описание инструментов, а не данные; дневник приходит по запросу модели', async () => {
  seedDiary();
  prefs(1, 1);
  const { r, calls } = await ask('psy1', 'get_diary', { days: 14 });
  assert.equal(r.reply.text, 'Готово, черновик для проверки.');
  assert.equal(calls.length, 2, 'вызов инструмента и финальный ответ');
  assert.ok(calls[0].tools.some((t) => t.name === 'get_diary'), 'инструменты предложены');
  assert.ok(!JSON.stringify(calls[0].messages).includes(CANARY), 'в первом запросе данных дневника нет');
  const toolMsg = calls[1].messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg.name, 'get_diary');
  assert.ok(toolMsg.content.includes(CANARY) && toolMsg.content.includes('настроение 2/5'), 'данные вернулись как результат инструмента');
  assert.ok(!ctx.app.ai.seenText().includes('Марина'), 'имени пациента модель не видит');
  const logged = ctx.app.query("SELECT count(*) n FROM phi_access_log WHERE section='ai.tool' AND object_type='get_diary'")[0].n;
  assert.ok(logged >= 1, 'обращение записано в журнал доступа');
});

test('инструмент дневника уважает выбор пациента: без разрешения нет оценок и заметок', async () => {
  seedDiary();
  prefs(0, 0);
  const { calls } = await ask('psy1', 'get_diary');
  const out = calls[1].messages.find((m) => m.role === 'tool').content;
  assert.ok(!out.includes(CANARY) && !out.includes('настроение'), 'скрытое не передаётся модели');
  assert.match(out, /не делится/);
  prefs(1, 1);
});

test('правила работы с инструментами лежат в версионируемом системном промпте, а не в тексте запроса', async () => {
  const { calls } = await ask('psy1', 'get_overview');
  assert.match(calls[0].system, /Работа с данными пациента/);
  assert.match(calls[0].system, /get_overview/);
  const sent = JSON.stringify(calls[0].messages);
  assert.ok(!sent.includes('Не придумывай данные'), 'инструкция не дублируется в сообщении врача');
  assert.match(sent, /Доступные инструменты по закреплённому пациенту: get_overview/);
  const v = ctx.app.query(
    "SELECT prompt_key FROM prompt_versions WHERE prompt_key IN ('role.psychiatrist','tools.common','task.clinician_chat') AND status='active' ORDER BY prompt_key",
  );
  assert.deepEqual(v.map((x) => x.prompt_key), ['role.psychiatrist', 'task.clinician_chat', 'tools.common']);
});

test('психолог не получает план лечения и нежелательные явления; чужой инструмент — «такого нет»', async () => {
  const { calls } = await ask('plg1', 'get_plan');
  const names = calls[0].tools.map((t) => t.name);
  assert.ok(!names.includes('get_plan') && !names.includes('get_adverse_events'));
  assert.ok(names.includes('get_diary') && names.includes('get_results') && names.includes('get_overview'));
  assert.match(calls[1].messages.find((m) => m.role === 'tool').content, /Такого инструмента нет/);
});

test('сводка и результаты отвечают без ошибок; лимит обращений не даёт зациклиться', async () => {
  for (const tool of ['get_overview', 'get_results', 'get_plan', 'get_visits', 'get_adverse_events']) {
    const { r } = await ask('psy1', tool);
    assert.equal(r.reply.text, 'Готово, черновик для проверки.', tool);
  }
  const doc = await ctx.as('psy1');
  ctx.app.ai.reset();
  ctx.app.ai.setDefault({ mode: 'tool', name: 'get_overview', arguments: {} });
  const r = await doc.post('/api/v1/ai/clinician/messages', {
    patient_id: ctx.id('patA'),
    text: 'Сводка',
    chips: [{ type: 'patient', id: ctx.id('patA') }],
  });
  expectError(r, 502, 'E-AI-EMPTY');
  // 6 вызовов на модель (5 с инструментами + 1 без); пустой итог запускает запасную модель — ещё столько же, не больше.
  assert.ok(ctx.app.ai.calls().length <= 12, 'цикл конечен');
});

test('ответ врачу по данным пациента называет препараты, дозы и диагнозы; пост-фильтр для чата специалиста снят', async () => {
  const doc = await ctx.as('psy1');
  const post = () =>
    doc.post('/api/v1/ai/clinician/messages', {
      patient_id: ctx.id('patA'),
      text: 'Что назначено?',
      chips: [{ type: 'patient', id: ctx.id('patA') }],
    });
  ctx.app.ai.reset();
  ctx.app.ai.queue({ mode: 'tool', name: 'get_plan', arguments: {} }, { mode: 'text', text: 'По плану: сертралин 50 мг утром.' });
  const ok = expectOk(await post());
  assert.equal(ok.reply.status, 'normal');
  assert.match(ok.reply.text, /сертралин 50 мг/);
  ctx.app.ai.reset();
  ctx.app.ai.queue({ mode: 'tool', name: 'get_plan', arguments: {} }, { mode: 'text', text: 'У вас депрессивное расстройство, вы больны.' });
  const dx = expectOk(await post());
  assert.equal(dx.reply.status, 'normal', 'диагноз врачу не скрывается пост-фильтром');
  assert.match(dx.reply.text, /депрессивное расстройство/);
  assert.match(dx.reply.text, /вы больны/);
});
