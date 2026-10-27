'use strict';
// Библиотека как рабочее место специалиста: свои материалы, публикация под своим именем, картинки, ИИ-черновик,
// статьи по тегам «препарат:…» / «тема:…».
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const F = require('../lib/flows');
const { articlesForInn, cleanTags, parseDraft } = require('../../src/modules/library/authoring');
const ctx = useApp();

const create = (doc, extra = {}) =>
  doc.post(
    '/work/api/library',
    {
      title: 'Тревога и дыхание',
      body_md: '## Дыхание\n\nМедленный выдох.',
      tags: ['Тема:Сон', 'препарат:сертралин'],
      ...extra,
    },
    { idem: false },
  );

test('библиотека: черновик не виден пациенту, публикация — под именем автора, правка живая, снятие скрывает', async () => {
  const doc = await ctx.as('psy1');
  const patient = await ctx.as('patA');
  const made = expectOk(await create(doc), 201);
  assert.equal(made.status, 'draft');
  assert.deepEqual(made.tags, ['тема:сон', 'препарат:сертралин']);
  assert.ok(!expectOk(await patient.get('/api/v1/library')).items.some((i) => i.title === 'Тревога и дыхание'));
  expectOk(await doc.post(`/work/api/library/${made.id}/publish`, {}, { idem: false }));
  const seen = expectOk(await patient.get('/api/v1/library')).items.find((i) => i.id === made.id);
  assert.ok(seen, 'опубликованный виден пациенту');
  assert.ok(seen.author && seen.author_role === 'психиатр');
  expectOk(await doc.put(`/work/api/library/${made.id}`, { title: 'Тревога и дыхание 2' }, { idem: false }));
  assert.equal(expectOk(await patient.get(`/api/v1/library/${made.id}`)).title, 'Тревога и дыхание');
  expectOk(await doc.post(`/work/api/library/${made.id}/publish`, {}, { idem: false }));
  assert.equal(expectOk(await patient.get(`/api/v1/library/${made.id}`)).title, 'Тревога и дыхание 2');
  expectOk(await doc.post(`/work/api/library/${made.id}/unpublish`, {}, { idem: false }));
  expectError(await patient.get(`/api/v1/library/${made.id}`), 404, 'E-NOT-FOUND');
  expectError(await doc.post(`/work/api/library/${made.id}/unpublish`, {}, { idem: false }), 409, 'E-STATUS');
});

test('библиотека: чужой материал недоступен; пациент и гость закрыты; без CSRF — 403; пустой — 422', async () => {
  const doc = await ctx.as('psy1');
  const made = expectOk(await create(doc), 201);
  const other = await ctx.as('plg1');
  expectError(await other.get(`/work/api/library/${made.id}`), 404, 'E-NOT-FOUND');
  expectError(await other.put(`/work/api/library/${made.id}`, { title: 'x' }, { idem: false }), 404, 'E-NOT-FOUND');
  expectError(await other.post(`/work/api/library/${made.id}/publish`, {}, { idem: false }), 404, 'E-NOT-FOUND');
  expectError(await (await ctx.as('patA')).get('/work/api/library'), 403, 'E-ACCESS');
  expectError(await ctx.guest().get('/work/api/library'), 401, 'E-SESSION-EXPIRED');
  expectError(await doc.post('/work/api/library', { title: 'a' }, { csrf: false, idem: false }), 403, 'E-CSRF');
  const empty = expectOk(await doc.post('/work/api/library', { title: '' }, { idem: false }), 201);
  expectError(await doc.post(`/work/api/library/${empty.id}/publish`, {}, { idem: false }), 422, 'E-VALIDATION');
  const mine = expectOk(await doc.get('/work/api/library')).mine;
  assert.ok(mine.some((m) => m.id === made.id));
  assert.ok(!expectOk(await other.get('/work/api/library')).mine.some((m) => m.id === made.id));
});

test('библиотека: картинка прикрепляется к материалу, обложка видна пациенту только после публикации', async () => {
  const doc = await ctx.as('psy1');
  const patient = await ctx.as('patA');
  const made = expectOk(await create(doc), 201);
  const up = expectOk(await F.upload(doc, 'photo_with_gps.jpg'), 201);
  const img = expectOk(
    await doc.post(`/work/api/library/${made.id}/image`, { upload_id: up.id }, { idem: false }),
    201,
  );
  assert.match(img.url, /^\/library\/img\/\d+$/);
  expectOk(await doc.put(`/work/api/library/${made.id}`, { cover_file_id: img.file_id }, { idem: false }));
  assert.equal((await doc.get(img.url, { binary: true })).status, 200, 'автор видит картинку черновика');
  expectError(await patient.get(img.url), 404, 'E-NOT-FOUND');
  expectOk(await doc.post(`/work/api/library/${made.id}/publish`, {}, { idem: false }));
  assert.equal((await patient.get(img.url, { binary: true })).status, 200);
  assert.equal(expectOk(await patient.get(`/api/v1/library/${made.id}`)).cover_url, img.url);
  expectError(
    await (await ctx.as('plg1')).put(`/work/api/library/${made.id}`, { cover_file_id: img.file_id }, { idem: false }),
    404,
    'E-NOT-FOUND',
  );
  expectError(
    await doc.put(`/work/api/library/${made.id}`, { cover_file_id: 987654 }, { idem: false }),
    422,
    'E-VALIDATION',
  );
});

test('библиотека: ИИ по основным мыслям возвращает заголовок, теги и текст; пустые мысли — 422', async () => {
  const doc = await ctx.as('psy1');
  const r = await doc.post(
    '/work/api/library/ai',
    { thoughts: 'Дыхание помогает при тревоге. Практиковать пару минут в день.' },
    { idem: false },
  );
  expectOk(r);
  assert.ok(r.body.title && r.body.body_md && r.body.ai_assisted === true);
  expectError(await doc.post('/work/api/library/ai', { thoughts: '  ' }, { idem: false }), 422, 'E-VALIDATION');
});

test('библиотека: примеры статей подбираются по тегам препарата и темы', async () => {
  const Database = require('better-sqlite3');
  const db = new Database(ctx.app.dbPath, { readonly: true });
  try {
    const r = articlesForInn(db, 'Сертралин');
    assert.ok(r.specific.length >= 1 && r.specific[0].title.toLowerCase().includes('сертралин'));
    assert.ok(r.general.some((a) => a.tags.includes('тема:пропустил-приём')));
    assert.equal(articlesForInn(db, 'неизвестное').specific.length, 0);
  } finally {
    db.close();
  }
  assert.deepEqual(cleanTags([' Тема:Сон ', 'ТЕМА:сон', '', '<b>', 'ёж']), ['тема:сон', 'еж']);
  const d = parseDraft('ЗАГОЛОВОК: Т\nКРАТКО: К\nТЕГИ: тема:сон, препарат:сертралин\n---\nТекст статьи', '');
  assert.deepEqual(
    [d.title, d.summary, d.tags, d.body_md],
    ['Т', 'К', ['тема:сон', 'препарат:сертралин'], 'Текст статьи'],
  );
});

test('библиотека: «чего не хватает» отдаёт только счётчики по препаратам', async () => {
  const r = expectOk(await (await ctx.as('psy1')).get('/work/api/library/gaps'));
  assert.ok(Array.isArray(r.gaps));
  for (const g of r.gaps) assert.deepEqual(Object.keys(g).sort(), ['inn', 'patients']);
});

test('библиотека: у специалиста вкладка — рабочее место, старый адрес перенаправляет; пациенту /work закрыт', async () => {
  const doc = await ctx.as('psy1');
  const page = await doc.get('/work?tab=library', { headers: { accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(String(page.body), /data-work-library/);
  const old = await doc.get('/account/library', { headers: { accept: 'text/html' } });
  assert.equal(old.status, 302);
  assert.match(old.headers.get('location'), /\/work\?tab=library/);
  assert.notEqual(
    (await (await ctx.as('patA')).get('/work?tab=library', { headers: { accept: 'text/html' } })).status,
    200,
  );
});

test('лекарства: статьи по препарату и прежние назначения — только пациенту', async () => {
  const patient = await ctx.as('patA');
  const r = expectOk(await patient.get(`/app/api/med-articles?inn=${encodeURIComponent('сертралин')}`));
  assert.ok(r.specific.length >= 1 && r.specific.every((a) => a.tags.includes('препарат:сертралин')));
  assert.ok(r.general.length >= 1);
  expectError(await patient.get('/app/api/med-articles'), 422, 'E-VALIDATION');
  expectError(await (await ctx.as('psy1')).get('/app/api/med-articles?inn=x'), 403, 'E-ACCESS');
  expectError(await ctx.guest().get('/app/api/meds/history'), 401, 'E-SESSION-EXPIRED');
  assert.ok(Array.isArray(expectOk(await patient.get('/app/api/meds/history')).items));
});

// ---- «Мои статьи»: две аудитории, промпты каталога, правка выделенного фрагмента ----

test('мои статьи: аудитория сохраняется, по умолчанию «для пациентов»; смена у опубликованной — 409', async () => {
  const doc = await ctx.as('psy1');
  const def = expectOk(await create(doc, { title: 'По умолчанию' }), 201);
  assert.equal(def.audience, 'patient');
  const made = expectOk(await create(doc, { title: 'Для коллег', audience: 'specialist' }), 201);
  assert.equal(made.audience, 'specialist');
  expectError(await create(doc, { audience: 'everyone' }), 422, 'E-VALIDATION');
  const list = expectOk(await doc.get('/work/api/library')).mine;
  assert.equal(list.find((m) => m.id === made.id).audience, 'specialist');
  expectOk(await doc.put(`/work/api/library/${made.id}`, { audience: 'patient' }, { idem: false }));
  expectOk(await doc.put(`/work/api/library/${made.id}`, { audience: 'specialist' }, { idem: false }));
  expectOk(await doc.post(`/work/api/library/${made.id}/publish`, {}, { idem: false }));
  expectError(await doc.put(`/work/api/library/${made.id}`, { audience: 'patient' }, { idem: false }), 409, 'E-STATUS');
  assert.equal(expectOk(await doc.get(`/work/api/library/${made.id}`)).audience, 'specialist');
});

test('мои статьи: журнал для специалистов пациенту не виден ни списком, ни поиском, ни по id, ни в карточке лекарства', async () => {
  const doc = await ctx.as('psy1');
  const colleague = await ctx.as('psy2').catch(() => null);
  const patient = await ctx.as('patA');
  const title = 'Закрытая статья коллегам';
  const made = expectOk(
    await create(doc, { title, audience: 'specialist', tags: ['тема:сон', 'препарат:сертралин'] }),
    201,
  );
  expectOk(await doc.post(`/work/api/library/${made.id}/publish`, {}, { idem: false }));

  assert.ok(!expectOk(await patient.get('/api/v1/library')).items.some((i) => i.id === made.id));
  assert.ok(!expectOk(await patient.get(`/api/v1/library?q=${encodeURIComponent('Закрытая')}`)).items.length);
  expectError(await patient.get(`/api/v1/library/${made.id}`), 404, 'E-NOT-FOUND');
  expectError(await patient.put(`/api/v1/library/${made.id}/position`, { position_s: 1 }), 404, 'E-NOT-FOUND');
  const arts = expectOk(await patient.get(`/app/api/med-articles?inn=${encodeURIComponent('сертралин')}`));
  assert.ok(
    ![...arts.specific, ...arts.general].some((a) => a.id === made.id),
    'карточка лекарства не берёт статью для специалистов',
  );

  // Специалист видит статью в общем каталоге с пометкой аудитории.
  const seen = expectOk(await doc.get('/api/v1/library')).items.find((i) => i.id === made.id);
  assert.ok(seen && seen.audience === 'specialist');
  if (colleague)
    assert.equal(
      expectOk(await colleague.get('/work/api/library')).others,
      undefined,
      'статей коллег в «Моих статьях» нет',
    );

  // После снятия с публикации и возврата в журнал пациентов статья становится видна.
  expectOk(await doc.post(`/work/api/library/${made.id}/unpublish`, {}, { idem: false }));
  expectOk(await doc.put(`/work/api/library/${made.id}`, { audience: 'patient' }, { idem: false }));
  expectOk(await doc.post(`/work/api/library/${made.id}/publish`, {}, { idem: false }));
  assert.ok(expectOk(await patient.get('/api/v1/library')).items.some((i) => i.id === made.id));
});

test('мои статьи: генерация идёт по промпту аудитории, инструкция отдельно от мыслей автора', async () => {
  const doc = await ctx.as('psy1');
  const thoughts = 'Дыхание помогает при тревоге. Практиковать пару минут в день.';
  for (const [audience, key] of [
    ['patient', 'task.article_patient'],
    ['specialist', 'task.article_specialist'],
  ]) {
    ctx.app.ai.reset();
    const r = await doc.post('/work/api/library/ai', { thoughts, audience }, { idem: false });
    expectOk(r);
    assert.equal(r.body.audience, audience);
    const call = ctx.app.ai.calls().at(-1);
    assert.equal(call.purpose, 'document_draft');
    assert.equal(call.prompt_key, key);
    assert.ok(call.system.length > 200, 'в system ушёл текст активной версии промпта');
    assert.equal(call.messages.at(-1).content, thoughts, 'в сообщении только мысли автора');
  }
  assert.match(
    expectOk(await (await ctx.as('admin1')).get('/api/v1/admin/ai/prompts/task.article_patient/versions')).items[0]
      .text,
    /3–4 коротких абзаца/,
  );
  expectError(
    await doc.post('/work/api/library/ai', { thoughts, audience: 'x' }, { idem: false }),
    422,
    'E-VALIDATION',
  );
});

test('мои статьи: правка выделенного — права, валидация, задача task.article_rewrite, поля отдельно от инструкции', async () => {
  const doc = await ctx.as('psy1');
  const url = '/work/api/library/ai/rewrite';
  expectError(await (await ctx.as('patA')).post(url, { fragment: 'x' }, { idem: false }), 403, 'E-ACCESS');
  expectError(await ctx.guest().post(url, { fragment: 'x' }, { idem: false }), 401, 'E-SESSION-EXPIRED');
  expectError(await doc.post(url, { fragment: '  ' }, { idem: false }), 422, 'E-VALIDATION');
  expectError(await doc.post(url, { fragment: 'x', audience: 'all' }, { idem: false }), 422, 'E-VALIDATION');

  ctx.app.ai.reset();
  const r = await doc.post(
    url,
    {
      audience: 'patient',
      fragment: 'Селективные ингибиторы обратного захвата серотонина.',
      instruction: 'Объясни проще',
      context_before: 'Начало статьи. ',
      context_after: ' Конец статьи.',
    },
    { idem: false },
  );
  expectOk(r);
  assert.ok(r.body.text && r.body.ai_assisted === true);
  const call = ctx.app.ai.calls().at(-1);
  assert.equal(call.prompt_key, 'task.article_rewrite');
  const msg = call.messages.at(-1).content;
  assert.match(msg, /АУДИТОРИЯ: пациенты/);
  assert.match(msg, /ЗАДАНИЕ: Объясни проще/);
  assert.match(msg, /ПЕРЕД ФРАГМЕНТОМ: Начало статьи\./);
  assert.match(msg, /ФРАГМЕНТ: Селективные ингибиторы/);
  assert.ok(!msg.includes(call.system.slice(-80)), 'инструкция не смешана с данными автора');
});

test('мои статьи: названия препаратов допустимы в черновике и правке обеих аудиторий', async () => {
  const doc = await ctx.as('psy1');
  const thoughts = 'Хочу написать статью про побочные эффекты при приеме триттико в первую неделю приема.';
  const body = 'Триттико — антидепрессант. Обсудим нежелательные реакции в первую неделю [источник — уточнить автору].';
  for (const audience of ['specialist', 'patient']) {
    ctx.app.ai.reset();
    ctx.app.ai.queue({
      mode: 'text',
      text: `ЗАГОЛОВОК: Первая неделя\nКРАТКО: Нежелательные реакции\nТЕГИ: тема:лекарства\n---\n${body}`,
    });
    const draft = expectOk(await doc.post('/work/api/library/ai', { thoughts, audience }, { idem: false }));
    assert.equal(draft.title, 'Первая неделя');
    assert.equal(draft.body_md, body);
    assert.equal(ctx.app.ai.calls().length, 1);
    ctx.app.ai.queue({ mode: 'text', text: body });
    const rewrite = expectOk(
      await doc.post('/work/api/library/ai/rewrite', { fragment: body, audience }, { idem: false }),
    );
    assert.equal(rewrite.text, body);
  }
});

test('мои статьи: заблокированный ответ не становится статьёй, правкой или историей', async () => {
  const doc = await ctx.as('psy1');
  const made = expectOk(await create(doc), 201);
  for (const text of ['У вас депрессия.', 'Принимайте сертралин.', 'Сертралин 50 мг.', 'Обещаю, всё будет хорошо.']) {
    ctx.app.ai.reset();
    ctx.app.ai.queue({ mode: 'text', text });
    const draft = await doc.post(
      '/work/api/library/ai',
      { thoughts: 'Напиши статью', audience: 'specialist', item_id: made.id },
      { idem: false },
    );
    expectError(draft, 502, 'E-AI-UNAVAILABLE');
    assert.equal(draft.body.title, undefined);
    assert.equal(draft.body.body_md, undefined);
    ctx.app.ai.queue({ mode: 'text', text });
    const rewrite = await doc.post(
      '/work/api/library/ai/rewrite',
      { fragment: 'Исходный текст', audience: 'specialist' },
      { idem: false },
    );
    expectError(rewrite, 502, 'E-AI-UNAVAILABLE');
    assert.equal(rewrite.body.text, undefined);
  }
  const failures = expectOk(await doc.get(`/work/api/library/${made.id}/chat`)).messages;
  assert.equal(failures.length, 4);
  assert.ok(failures.every((m) => m.role === 'user' && m.status === 'error'));
  assert.equal(expectOk(await doc.get(`/work/api/library/${made.id}`)).body_md, '## Дыхание\n\nМедленный выдох.');
});

test('мои статьи: беседа с ИИ привязана к статье — вся история и текущий текст уходят модели, чужая статья закрыта', async () => {
  const doc = await ctx.as('psy1');
  const made = expectOk(await create(doc, { title: 'Беседа', body_md: 'Первый абзац статьи.' }), 201);
  ctx.app.ai.reset();
  const first = await doc.post(
    '/work/api/library/ai',
    {
      thoughts: 'Напиши про дыхание',
      audience: 'patient',
      item_id: made.id,
      current: { title: 'Беседа', body_md: 'Первый абзац статьи.' },
    },
    { idem: false },
  );
  expectOk(first);
  let call = ctx.app.ai.calls().at(-1);
  assert.equal(call.messages.length, 1, 'истории ещё нет');
  assert.match(call.messages[0].content, /ТЕКУЩИЙ ТЕКСТ СТАТЬИ[\s\S]*Первый абзац статьи\./);
  assert.match(call.messages[0].content, /СООБЩЕНИЕ АВТОРА: Напиши про дыхание/);

  ctx.app.ai.reset();
  expectOk(
    await doc.post(
      '/work/api/library/ai',
      {
        thoughts: 'Сделай короче',
        audience: 'patient',
        item_id: made.id,
        current: { title: 'Беседа', body_md: 'Новый текст.' },
      },
      { idem: false },
    ),
  );
  call = ctx.app.ai.calls().at(-1);
  assert.deepEqual(
    call.messages.map((m) => m.role),
    ['user', 'assistant', 'user'],
    'прежняя беседа + новая реплика',
  );
  assert.equal(call.messages[0].content, 'Напиши про дыхание');
  assert.match(call.messages[2].content, /СООБЩЕНИЕ АВТОРА: Сделай короче/);

  const chat = expectOk(await doc.get(`/work/api/library/${made.id}/chat`)).messages;
  assert.deepEqual(
    chat.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant'],
  );
  assert.equal(chat[0].text, 'Напиши про дыхание');
  assert.equal(chat[1].text, '', 'текст ответа ИИ в ленту не отдаётся — он в статье');

  const other = await ctx.as('psy2').catch(() => null);
  if (other) {
    expectError(await other.get(`/work/api/library/${made.id}/chat`), 404, 'E-NOT-FOUND');
    expectError(
      await other.post('/work/api/library/ai', { thoughts: 'x', item_id: made.id }, { idem: false }),
      404,
      'E-NOT-FOUND',
    );
  }
  expectError(await (await ctx.as('patA')).get(`/work/api/library/${made.id}/chat`), 403, 'E-ACCESS');
});

test('article editor: title, body, tags and new draft image stay private until explicit publication update', async () => {
  const doc = await ctx.as('psy1'),
    patient = await ctx.as('patA');
  const made = expectOk(await create(doc), 201);
  expectOk(await doc.post(`/work/api/library/${made.id}/publish`, {}, { idem: false }));
  const up = expectOk(await F.upload(doc, 'photo_with_gps.jpg'), 201);
  const img = expectOk(
    await doc.post(`/work/api/library/${made.id}/image`, { upload_id: up.id }, { idem: false }),
    201,
  );
  const saved = expectOk(
    await doc.put(
      `/work/api/library/${made.id}`,
      {
        title: 'Черновой заголовок',
        body_md: `Новый текст\n${img.markdown}`,
        cover_file_id: img.file_id,
        tags: ['тема:новая'],
      },
      { idem: false },
    ),
  );
  assert.equal(saved.has_unpublished_changes, true);
  let publicView = expectOk(await patient.get(`/api/v1/library/${made.id}`));
  assert.equal(publicView.title, made.title);
  assert.equal(publicView.body_md, made.body_md);
  assert.deepEqual(publicView.tags, made.tags);
  expectError(await patient.get(img.url), 404, 'E-NOT-FOUND');
  assert.equal((await doc.get(img.url, { binary: true })).status, 200);
  expectOk(await doc.post(`/work/api/library/${made.id}/publish`, {}, { idem: false }));
  publicView = expectOk(await patient.get(`/api/v1/library/${made.id}`));
  assert.equal(publicView.title, 'Черновой заголовок');
  assert.deepEqual(publicView.tags, ['тема:новая']);
  assert.equal((await patient.get(img.url, { binary: true })).status, 200);
  assert.equal(expectOk(await doc.get(`/work/api/library/${made.id}`)).has_unpublished_changes, false);
});

test('article editor: administrator changes public version without consuming author draft, keeps author current when no draft exists', async () => {
  const doc = await ctx.as('psy1'),
    admin = await ctx.as('admin1'),
    patient = await ctx.as('patA');
  const made = expectOk(await create(doc), 201);
  expectOk(await doc.post(`/work/api/library/${made.id}/publish`, {}, { idem: false }));
  expectOk(await admin.put(`/admin/api/journal/${made.id}`, { title: 'Админский заголовок' }, { idem: false }));
  assert.equal(expectOk(await doc.get(`/work/api/library/${made.id}`)).title, 'Админский заголовок');
  expectOk(
    await doc.put(
      `/work/api/library/${made.id}`,
      { body_md: 'Личный черновик', tags: ['тема:черновик'] },
      { idem: false },
    ),
  );
  expectOk(await admin.put(`/admin/api/journal/${made.id}`, { title: 'Публичная коррекция' }, { idem: false }));
  assert.equal(expectOk(await patient.get(`/api/v1/library/${made.id}`)).body_md, made.body_md);
  const own = expectOk(await doc.get(`/work/api/library/${made.id}`));
  assert.equal(own.body_md, 'Личный черновик');
  assert.deepEqual(own.tags, ['тема:черновик']);
  assert.equal(own.has_unpublished_changes, true);
  assert.equal(expectOk(await admin.get(`/admin/api/journal/${made.id}`)).title, 'Публичная коррекция');
});
