'use strict';
// Каталог промптов ИИ в кабинете администратора (F-101): слои роль/инструменты/навык/задача, версии, сравнение,
// включение и откат; шаблоны документов собираются из роли пользователя и задачи `task.document_template`.
// covers: F-101, F-26, S-08, S-09, M-16
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lineDiff } = require('../../src/modules/admin/prompts/service');
const { createRegistry } = require('../../src/ai/registry');
const { createGateway } = require('../../src/ai/gateway');
const catalog = require('../../src/ai/promptCatalog');
const skillSchemas = require('../../src/ai/skills');
const hintsSchema = require('../../src/ai/workspace/hintsSchema');
const ctx = useApp();

const KEY = 'task.document_template';
const base = `/api/v1/admin/ai/prompts/${KEY}`;
const REQUEST = 'выписка из стационара';

async function generate() {
  const psy = await ctx.as('psy1');
  ctx.app.ai.reset();
  expectOk(await psy.post('/work/api/templates/ai', { request: REQUEST }, { idem: false }));
  const call = ctx.app.ai.calls().at(-1);
  assert.ok(call, 'вызов модели записан');
  return call;
}

test('промпт шаблонов: начальная версия v1 действует, инструкция отделена от запроса врача', async () => {
  const admin = await ctx.as('admin1');
  const { items } = expectOk(await admin.get(`${base}/versions`));
  assert.equal(items.length, 1);
  assert.equal(items[0].version, 1);
  assert.equal(items[0].active, true);
  assert.match(items[0].text, /ШАБЛОН/);

  const call = await generate();
  assert.equal(call.purpose, 'document_draft');
  assert.equal(call.prompt_key, KEY);
  assert.equal(call.prompt_version, 1);
  assert.ok(call.system.includes(catalog.parseBody(items[0].text).text), 'в system ушёл текст активной версии задачи');
  assert.match(call.system, /помощник психиатра/, 'перед задачей стоит роль пользователя');
  assert.ok(call.system.indexOf('помощник психиатра') < call.system.indexOf('ШАБЛОН'), 'сначала роль, потом задача');
  assert.doesNotMatch(call.system, /Работа с данными пациента/, 'правила инструментов только там, где есть инструменты');
  assert.equal(call.messages.at(-1).content, REQUEST, 'в сообщении пользователя только запрос врача, без инструкции');
});

test('новая версия создаётся черновиком и не меняет ответы, пока её не включили', async () => {
  const admin = await ctx.as('admin1');
  const v1 = expectOk(await admin.get(`${base}/versions`)).items[0];
  const text = `${v1.text}\nМАРКЕР-ВЕРСИИ-2`;
  const v2 = expectOk(await admin.post(`${base}/versions`, { text, comment: 'проверка' }), 201);
  assert.equal(v2.version, 2);
  assert.equal(v2.status, 'draft');
  assert.equal(v2.active, false);
  assert.equal(v2.comment, 'проверка');

  assert.equal((await generate()).prompt_version, 1, 'пока черновик — действует v1');

  // тот же текст — не новая версия; пустой и слишком длинный — ошибка проверки
  expectError(await admin.post(`${base}/versions`, { text }), 409, 'E-CONFLICT');
  expectError(await admin.post(`${base}/versions`, { text: '   ' }), 422, 'E-VALIDATION');
  expectError(await admin.post(`${base}/versions`, { text: 'x'.repeat(20001) }), 422, 'E-VALIDATION');
});

test('сравнение версий построчно', async () => {
  const admin = await ctx.as('admin1');
  const d = expectOk(await admin.get(`${base}/diff?from=1&to=2`));
  assert.equal(d.from, 1);
  assert.equal(d.to, 2);
  assert.deepEqual(d.lines.filter((l) => l.op === 'add').map((l) => l.text), ['МАРКЕР-ВЕРСИИ-2']);
  assert.ok(!d.lines.some((l) => l.op === 'del'));
  expectError(await admin.get(`${base}/diff?from=1&to=99`), 404, 'E-NOT-FOUND');
  assert.deepEqual(lineDiff('a\nb', 'a\nc').map((l) => l.op), ['same', 'del', 'add']);
});

test('включение v2 действует сразу, откат на v1 возвращает прежний текст', async () => {
  const admin = await ctx.as('admin1');
  const on = expectOk(await admin.post(`${base}/versions/2/activate`, {}));
  assert.equal(on.active, true);
  let list = expectOk(await admin.get(`${base}/versions`)).items;
  assert.equal(list.find((v) => v.version === 1).status, 'previous');
  assert.equal(list.filter((v) => v.active).length, 1, 'активна ровно одна версия');

  const call = await generate();
  assert.equal(call.prompt_version, 2);
  assert.match(call.system, /МАРКЕР-ВЕРСИИ-2/);
  const audit = ctx.app.query("SELECT prompt_version FROM ai_audit WHERE purpose='document_draft' ORDER BY id DESC LIMIT 1");
  assert.equal(audit[0].prompt_version, 2, 'в журнале ИИ записана версия промпта');

  expectError(await admin.post(`${base}/versions/2/activate`, {}), 409, 'E-CONFLICT');
  expectError(await admin.post(`${base}/versions/9/activate`, {}), 404, 'E-NOT-FOUND');

  expectOk(await admin.post(`${base}/versions/1/activate`, {}));
  list = expectOk(await admin.get(`${base}/versions`)).items;
  assert.equal(list.find((v) => v.version === 1).active, true);
  assert.equal(list.find((v) => v.version === 2).status, 'previous');
  const back = await generate();
  assert.equal(back.prompt_version, 1);
  assert.doesNotMatch(back.system, /МАРКЕР-ВЕРСИИ-2/);
});

test('текст версии неизменяем, а в журнал действий текст не попадает', async () => {
  assert.throws(
    () => ctx.app.exec("UPDATE prompt_versions SET body = 'подмена' WHERE prompt_key = 'task.document_template' AND version = 1"),
    /immutable/,
  );
  const rows = ctx.app.query("SELECT action, new_safe_json FROM action_log WHERE action LIKE 'prompt.version.%' ORDER BY id");
  assert.deepEqual(rows.map((r) => r.action), ['prompt.version.create', 'prompt.version.activate', 'prompt.version.activate']);
  for (const r of rows) assert.doesNotMatch(r.new_safe_json, /МАРКЕР|ШАБЛОН/);
});

test('доступ: только администратор; чужие роли и гость — отказ, неизвестный ключ — 404', async () => {
  const psy = await ctx.as('psy1');
  const admin = await ctx.as('admin1');
  expectError(await psy.get(`${base}/versions`), 403, 'E-ACCESS');
  expectError(await psy.post(`${base}/versions`, { text: 'x' }), 403, 'E-ACCESS');
  expectError(await psy.post(`${base}/versions/1/activate`, {}), 403, 'E-ACCESS');
  expectError(await (await ctx.guest()).get(`${base}/versions`), 401, 'E-SESSION-EXPIRED');
  expectError(await admin.post(`${base}/versions`, { text: 'x' }, { csrf: false }), 403, 'E-CSRF');
  expectError(await admin.get('/api/v1/admin/ai/prompts/nope/versions'), 404, 'E-NOT-FOUND');
});

test('страница «Настройки → Промпт» открывается администратором и несёт список ключей', async () => {
  const admin = await ctx.as('admin1');
  const page = await admin.get('/admin?tab=settings&s=prompt', { headers: { accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(String(page.body), /data-prompt-keys="[^"]*task\.document_template/);
});

test('каталог для админки: четыре слоя с описаниями, у каждого промпта название, описание и место применения', async () => {
  const admin = await ctx.as('admin1');
  const { categories } = expectOk(await admin.get('/api/v1/admin/ai/prompts'));
  assert.deepEqual(categories.map((c) => c.id), ['role', 'tools', 'skill', 'task', 'guard']);
  for (const c of categories) {
    assert.ok(c.title && c.description.length > 20, `слой ${c.id} описан`);
    assert.ok(c.items.length > 0);
    for (const it of c.items) {
      assert.ok(it.title && it.description && it.where, `${it.key}: название, описание, где применяется`);
      assert.ok(it.active_version >= 1, `${it.key}: есть действующая версия`);
    }
  }
  const roles = categories.find((c) => c.id === 'role').items.map((i) => i.key);
  assert.deepEqual(roles, ['role.patient', 'role.psychiatrist', 'role.psychologist']);
  expectError(await (await ctx.as('psy1')).get('/api/v1/admin/ai/prompts'), 403, 'E-ACCESS');
});

test('итоговый промпт для админки: роль, правила инструментов и задача в нужном порядке', async () => {
  const admin = await ctx.as('admin1');
  const q = (extra) => `/api/v1/admin/ai/prompts/compose?task=task.patient_chat${extra}`;
  const withRole = expectOk(await admin.get(q('&role=patient&tools=1')));
  assert.deepEqual(withRole.layers.map((l) => l.key), ['role.patient', 'tools.common', 'task.patient_chat', 'guard.patient_conduct']);
  assert.ok(withRole.system.indexOf('ИИ-помощник пациента') < withRole.system.indexOf('Работа с данными пациента'));
  assert.ok(withRole.system.indexOf('Работа с данными пациента') < withRole.system.indexOf('Задача: ты общаешься с пациентом'));
  assert.doesNotMatch(withRole.system, /<!--/, 'пометки для людей в инструкцию не попадают');
  const noRole = expectOk(await admin.get(q('')));
  assert.deepEqual(noRole.layers.map((l) => l.key), ['task.patient_chat']);
  const skill = expectOk(await admin.get('/api/v1/admin/ai/prompts/compose?task=skill.ae_extraction&role=patient'));
  assert.deepEqual(skill.layers.map((l) => l.key), ['skill.ae_extraction'], 'у навыка роли нет');
  expectError(await admin.get('/api/v1/admin/ai/prompts/compose?task=role.patient'), 404, 'E-NOT-FOUND');
});

test('роли: психиатр и психолог получают разные системные промпты, в журнале ИИ — версии всех слоёв', async () => {
  const plg = await ctx.as('plg1');
  ctx.app.ai.reset();
  expectOk(await plg.post('/work/api/templates/ai', { request: REQUEST }, { idem: false }));
  const call = ctx.app.ai.calls().at(-1);
  assert.match(call.system, /помощник психолога/);
  assert.doesNotMatch(call.system, /помощник психиатра/);
  const row = ctx.app.query("SELECT prompt_layers_json FROM ai_audit WHERE purpose='document_draft' ORDER BY id DESC LIMIT 1")[0];
  const layers = JSON.parse(row.prompt_layers_json);
  assert.deepEqual(layers.map((l) => l.key), ['role.psychologist', 'task.document_template', 'guard.scope_clinician']);
  assert.ok(layers.every((l) => l.version >= 1));
});

test('версия роли действует на все её задачи; откат возвращает прежний текст', async () => {
  const admin = await ctx.as('admin1');
  const roleBase = '/api/v1/admin/ai/prompts/role.psychiatrist';
  const v1 = expectOk(await admin.get(`${roleBase}/versions`)).items[0];
  const v2 = expectOk(await admin.post(`${roleBase}/versions`, { text: `${v1.text}\nМАРКЕР-РОЛИ-2`, comment: 'проверка слоя' }), 201);
  expectOk(await admin.post(`${roleBase}/versions/${v2.version}/activate`, {}));
  assert.match((await generate()).system, /МАРКЕР-РОЛИ-2/);
  expectOk(await admin.post(`${roleBase}/versions/1/activate`, {}));
  assert.doesNotMatch((await generate()).system, /МАРКЕР-РОЛИ-2/);
});

function inProcessGateway() {
  const db = ctx.app.db();
  const config = { dataMode: 'synthetic' };
  const now = () => new Date();
  const registry = createRegistry({ db, config, now });
  const gateway = createGateway({ db, config, now, registry, pii: {}, settings: () => ({ value: null, version: 1 }) });
  const user = { id: ctx.app.query("SELECT id FROM users WHERE email='psy1@cc.example.test'")[0].id, role: 'psychiatrist' };
  return { db, gateway, user };
}

test('навыки: модель видит список навыков и вызывает use_skill; навык идёт отдельным запросом без роли', async () => {
  const { db, gateway, user } = inProcessGateway();
  Object.assign(process.env, ctx.app.ai.env());
  try {
    ctx.app.ai.reset();
    ctx.app.ai.queue(
      { mode: 'tool', name: 'use_skill', arguments: { name: 'ae_extraction', input: 'после таблетки дрожат руки' } },
      { mode: 'tool', name: 'report_adverse_event', arguments: { symptoms: ['дрожь в руках'], severity: 1, related: 'possible', med: 'не знаю' } },
      { mode: 'text', text: 'Пациент описывает дрожь в руках после приёма; оценку связи с препаратом даст врач.' },
    );
    const out = await gateway.run({
      purpose: 'clinician_chat',
      user,
      text: 'Пациент пишет: после таблетки дрожат руки',
      skills: ['skill.ae_extraction'],
    });
    assert.match(out.text, /дрожь в руках/);
    const calls = ctx.app.ai.calls();
    assert.equal(calls.length, 3);
    assert.match(calls[0].system, /Доступные навыки/);
    assert.match(calls[0].system, /- ae_extraction: Извлекает из текста признаки/);
    assert.ok(calls[0].tools.some((t) => t.name === 'use_skill'));
    assert.equal(calls[1].prompt_key, 'skill.ae_extraction');
    assert.deepEqual(calls[1].tools.map((t) => t.name), ['report_adverse_event'], 'подзапрос навыка несёт схему его функции');
    assert.doesNotMatch(calls[1].system, /помощник психиатра/, 'у навыка роли нет');
    assert.equal(calls[1].messages.at(-1).content, 'после таблетки дрожат руки');
    assert.match(JSON.stringify(calls[2].messages), /дрожь в руках/, 'результат навыка вернулся в диалог');
    const kinds = db.prepare("SELECT purpose FROM ai_audit ORDER BY id DESC LIMIT 2").all().map((r) => r.purpose);
    assert.deepEqual(kinds.sort(), ['ae_extraction', 'clinician_chat']);
  } finally {
    db.close();
  }
});

test('навыки: у каждого навыка в каталоге задан режим; function-навыки имеют схему, instructions — нет', () => {
  const skills = catalog.ENTRIES.filter((e) => catalog.categoryOf(e.key) === 'skill');
  assert.deepEqual(skills.map((e) => `${e.key}:${e.mode}`).sort(), [
    'skill.ae_extraction:function',
    'skill.ae_offer:instructions',
    'skill.ae_offer_clinician:instructions',
    'skill.ae_offer_psychologist:instructions',
    'skill.crisis_signal:instructions',
    'skill.diagnostic_hints:function',
    'skill.history_summary:instructions',
    'skill.order_parse:function',
  ]);
  for (const e of skills) {
    assert.equal(catalog.skillMode(e.key), e.mode);
    const fn = skillSchemas.functionOf(e.key);
    if (e.mode === 'function') {
      assert.ok(fn && fn.name && fn.description && fn.parameters.type === 'object', `${e.key}: есть схема функции`);
    } else {
      assert.equal(fn, null, `${e.key}: у инструкции схемы нет`);
      // сжатие истории вызывает код шлюза, а не модель: флага ответа у него нет
      if (e.key === 'skill.crisis_signal') assert.equal(e.flag, 'crisis_signal');
      else if (e.key !== 'skill.history_summary') assert.equal(e.flag, 'ae_offer');
    }
  }
  assert.equal(catalog.skillMode('task.patient_chat'), null);
});

test('схемы функций согласованы с кодом, который читает результат', () => {
  const ae = skillSchemas.functionOf('ae_extraction');
  assert.equal(ae.name, 'report_adverse_event');
  assert.deepEqual(Object.keys(ae.parameters.properties).sort(), ['med', 'related', 'severity', 'symptoms']);
  assert.deepEqual(ae.parameters.properties.severity.enum, [1, 2, 3]);
  assert.deepEqual(ae.parameters.properties.related.enum, ['likely', 'possible', 'unlikely', 'unknown']);
  const op = skillSchemas.functionOf('skill.order_parse');
  assert.equal(op.name, 'order_parse');
  assert.deepEqual(Object.keys(op.parameters.properties).sort(), ['date', 'dose', 'inn_name', 'times', 'unit']);
  const hints = skillSchemas.functionOf('diagnostic_hints');
  assert.equal(hints.name, 'diagnostic_hints');
  const item = hints.parameters.properties.hypotheses.items;
  assert.deepEqual(Object.keys(item.properties).sort(), ['against', 'for', 'missing', 'questions', 'somatic', 'sources', 'text']);
  // словарь ссылок схемы совпадает со словарём проверки ответа
  const types = item.properties.for.items.properties.type.enum;
  assert.deepEqual([...types].sort(), [...hintsSchema.REF_TYPES].sort());
  assert.ok(hintsSchema.validate({ hypotheses: [{ text: 'Гипотеза', for: [{ type: types[0], id: 1 }] }] }).ok);
  for (const name of ['ae_extraction', 'order_parse', 'diagnostic_hints']) {
    JSON.stringify(skillSchemas.functionOf(name)); // схема — обычный JSON
  }
});

test('прямой вызов навыка: в модель уходит схема функции, аргументы приходят объектом', async () => {
  const { db, gateway, user } = inProcessGateway();
  Object.assign(process.env, ctx.app.ai.env());
  try {
    for (const [purpose, fnName] of [['ae_extraction', 'report_adverse_event'], ['order_parse', 'order_parse'], ['diagnostic_hints', 'diagnostic_hints']]) {
      ctx.app.ai.reset();
      ctx.app.ai.queue({ mode: 'tool', name: fnName, arguments: { symptoms: ['дрожь'] } });
      const out = await gateway.run({ purpose, user, text: 'после таблетки дрожат руки' });
      const call = ctx.app.ai.calls().at(-1);
      assert.deepEqual(call.tools.map((t) => t.name), [fnName], `${purpose}: функция навыка в запросе`);
      assert.equal(call.tools[0].parameters.type, 'object');
      assert.equal(out.tool.name, fnName);
      assert.deepEqual(out.tool.arguments, { symptoms: ['дрожь'] });
    }
    // строковые аргументы (OpenAI-совместимые модели) приводятся к объекту
    ctx.app.ai.reset();
    ctx.app.ai.queue({ mode: 'tool', name: 'report_adverse_event', arguments: '{"symptoms":["тошнота"],"severity":2}' });
    const raw = await gateway.run({ purpose: 'ae_extraction', user, text: 'тошнит после таблетки' });
    assert.deepEqual(raw.tool.arguments, { symptoms: ['тошнота'], severity: 2 });
    assert.deepEqual(raw.flags, []);
    // обычная задача без навыка функций не получает
    ctx.app.ai.reset();
    await gateway.run({ purpose: 'clinician_chat', user, text: 'Привет' });
    assert.equal(ctx.app.ai.calls().at(-1).tools, null);
  } finally {
    db.close();
  }
});

test('навык в режиме instructions: use_skill возвращает тело в диалог и ставит флаг ответа без подзапроса', async () => {
  const { db, gateway, user } = inProcessGateway();
  Object.assign(process.env, ctx.app.ai.env());
  try {
    ctx.app.ai.reset();
    ctx.app.ai.queue(
      { mode: 'tool', name: 'use_skill', arguments: { name: 'ae_offer', input: 'после таблетки дрожат руки' } },
      { mode: 'text', text: 'Возможно, это побочное действие. Хотите рассказать подробнее?' },
    );
    const out = await gateway.run({
      purpose: 'clinician_chat',
      user,
      text: 'Пациент: после таблетки дрожат руки',
      skills: ['skill.ae_offer', 'skill.ae_extraction'],
    });
    assert.deepEqual(out.flags, ['ae_offer']);
    const calls = ctx.app.ai.calls();
    assert.equal(calls.length, 2, 'подзапроса к модели нет: тело навыка вернулось в диалог');
    assert.match(calls[0].system, /- ae_offer: Если в реплике пациента похоже на побочное действие/);
    const back = JSON.stringify(calls[1].messages);
    assert.match(back, /Инструкция навыка ae_offer/);
    assert.match(back, /не повторяй предложение/i);
    assert.doesNotMatch(back, /review-required/, 'пометки для людей не попадают в диалог');
    assert.equal(db.prepare('SELECT purpose FROM ai_audit ORDER BY id DESC LIMIT 1').get().purpose, 'clinician_chat', 'подзапроса навыка в журнале нет');
    // без вызова навыка флагов нет
    ctx.app.ai.reset();
    const plain = await gateway.run({ purpose: 'clinician_chat', user, text: 'Привет', skills: ['skill.ae_offer'] });
    assert.deepEqual(plain.flags, []);
  } finally {
    db.close();
  }
});

test('описания инструментов берутся из каталога, а общие правила инструментов добавляются только при инструментах', async () => {
  const { db, gateway, user } = inProcessGateway();
  Object.assign(process.env, ctx.app.ai.env());
  try {
    ctx.app.ai.reset();
    const tools = {
      definitions: [{ name: 'get_overview', description: 'Описание из кода', parameters: { type: 'object', properties: {} } }],
      execute: async () => 'нет данных',
    };
    await gateway.run({ purpose: 'clinician_chat', user, text: 'Дай обзор', tools });
    const call = ctx.app.ai.calls().at(-1);
    assert.match(call.system, /Работа с данными пациента через инструменты/);
    assert.match(call.tools[0].description, /^Краткая сводка по пациенту/, 'описание — из слоя «Инструменты», не из кода');
    const row = db.prepare("SELECT prompt_layers_json FROM ai_audit ORDER BY id DESC LIMIT 1").get();
    assert.deepEqual(JSON.parse(row.prompt_layers_json).map((l) => l.key), ['role.psychiatrist', 'tools.common', 'task.clinician_chat', 'guard.scope_clinician', 'tools.get_overview']);
  } finally {
    db.close();
  }
});

test('обновление промптов из файлов: нетронутая действующая версия заменяется следующей, ручные правки и откаты сохраняются', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-'));
  const key = 'task.patient_chat';
  const base = path.join(dir, 'task', 'patient_chat');
  fs.mkdirSync(base, { recursive: true });
  const db = ctx.app.db();
  try {
    const original = db.prepare('SELECT body FROM prompt_versions WHERE prompt_key=? AND version=1').get(key).body;
    fs.writeFileSync(path.join(base, 'v001.md'), original);
    fs.writeFileSync(path.join(base, 'v002.md'), `${original}\nВТОРАЯ-ВЕРСИЯ`);
    const registry = createRegistry({ db, config: { dataMode: 'real' }, now: () => new Date(), promptsDir: dir });
    const cleanup = () => {
      db.prepare('DELETE FROM prompt_versions WHERE prompt_key=? AND version>1').run(key);
      db.prepare("UPDATE prompt_versions SET status='active' WHERE prompt_key=? AND version=1").run(key);
    };
    registry.bootstrap();
    assert.equal(registry.activePrompt(key).version, 2);
    registry.bootstrap();
    assert.equal(db.prepare('SELECT count(*) n FROM prompt_versions WHERE prompt_key=?').get(key).n, 2, 'повторный запуск ничего не меняет');
    // ручной откат на v1 не отменяется
    db.prepare("UPDATE prompt_versions SET status='previous' WHERE prompt_key=? AND version=2").run(key);
    db.prepare("UPDATE prompt_versions SET status='active' WHERE prompt_key=? AND version=1").run(key);
    registry.bootstrap();
    assert.equal(registry.activePrompt(key).version, 1);
    cleanup();
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('роль пациента v2: обращение на «ты», формы рода по сведениям о собеседнике; навыки ae v2', async () => {
  const admin = await ctx.as('admin1');
  const role = expectOk(await admin.get('/api/v1/admin/ai/prompts/role.patient/versions')).items;
  const active = role.find((v) => v.status === 'active');
  assert.equal(active.version, 2);
  assert.match(active.text, /на «ты»/);
  assert.match(active.text, /Сведения о собеседнике/);
  for (const key of ['skill.ae_offer', 'skill.ae_extraction']) {
    const items = expectOk(await admin.get(`/api/v1/admin/ai/prompts/${key}/versions`)).items;
    assert.equal(items.find((v) => v.status === 'active').version, key === 'skill.ae_offer' ? 3 : 2, key);
  }
  const offer = expectOk(await admin.get('/api/v1/admin/ai/prompts/skill.ae_offer/versions')).items.find((v) => v.version === 3);
  assert.match(offer.text, /три вопроса|трёх вопросов/);
  assert.match(offer.text, /психиатра нет/);
  assert.match(offer.text, /Обращение только на «ты»/);
  assert.match(offer.text, /Да, расскажу подробнее/);
  assert.match(offer.text, /Образец/);
});
