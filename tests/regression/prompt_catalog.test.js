'use strict';
// Каталог промптов ИИ в кабинете администратора (F-101) и генерация шаблонов документов по активному промпту
// `document_draft.template`: версии, сравнение, включение и откат; врач получает ответ по включённой версии.
// covers: F-101, F-26, S-08, S-09, M-16
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const { lineDiff } = require('../../src/modules/admin/prompts/service');
const ctx = useApp();

const KEY = 'document_draft.template';
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
  assert.equal(call.system, items[0].text, 'в system ушёл текст активной версии');
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
    () => ctx.app.exec("UPDATE prompt_versions SET body = 'подмена' WHERE prompt_key = 'document_draft.template' AND version = 1"),
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
  assert.match(String(page.body), /data-prompt-keys="[^"]*document_draft\.template/);
});
