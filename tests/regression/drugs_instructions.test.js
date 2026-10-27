'use strict';
// covers: F1 волны 3 — знания о лекарствах в приложении: инструкции по МНН, оглавление, разделы, поиск,
// выдержки в чатах (sources), доступ, деградация, /readyz.
// Нужен pgvector-инстанс: KNOWLEDGE_TEST_DATABASE_URL. Тест создаёт СВОЮ временную БД ks_app_*, применяет миграции,
// грузит синтетические данные и удаляет БД; основную базу и клинреки не трогает. Эмбеддинги — фейковый клиент
// (KNOWLEDGE_EMBEDDING_STUB, только при NODE_ENV=test), сеть не используется.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { startApp } = require('../lib/app');
const { as, guest } = require('../lib/client');
const { expectOk, expectError } = require('../lib/client');
const { createPool, toVectorLiteral } = require('../../src/modules/knowledge/pg');
const { migrate } = require('../../src/modules/knowledge/migrate');
const { normalizeText } = require('../../src/modules/knowledge/rrf');
const { isDrugQuestion, buildExcerpts } = require('../../src/modules/drugs/instructions');
const { publicReferenceTerm } = require('../../src/modules/knowledge/service');

const url = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const skip = url ? false : 'KNOWLEDGE_TEST_DATABASE_URL не задан: нужен Postgres с pgvector';
const DIM = 2560;
const MODEL = 'fake-model';

// ---------- синтетические векторы ----------
function vec(axis, seed = 1) {
  let s = seed >>> 0;
  const v = Array.from({ length: DIM }, () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 4294967296 - 0.5) * 0.002;
  });
  v[axis] += 1;
  return v;
}
const lit = (axis, seed) => toVectorLiteral(vec(axis, seed));

const LONG = 'Подробное описание фармакологических свойств. '.repeat(560); // ~25 тыс. символов
const MD1 = `# Показания\nСертралин показан при депрессии.\n# Побочные реакции\nНарушения сна, головная боль.\n# Длинный раздел\n${LONG}\n`;
const MD2 = '# Показания\nАмитриптилин применяют при депрессии.\n# Побочные реакции\nСонливость, бессонница.\n';
const off = (md, s) => md.indexOf(s);

let admin;
let dbName;
let dbUrl;
let kpool;
let tmp;
const apps = [];

async function loadKnowledge() {
  const q = (sql, p) => kpool.query(sql, p);
  const doc = (id, label, inn, md) =>
    q(
      'INSERT INTO med.documents (id, drug_label, inn, trade_name, source_file, sha256, markdown) VALUES ($1,$2,$3,NULL,$4,$5,$6)',
      [id, label, inn, `${id}.md`, `sha-${id}`, md],
    );
  await doc('D1', 'Золофт', 'сертралин', MD1);
  await doc('D2', 'Амитриптилин Никомед', 'амитриптилин', MD2);
  await doc('D3', 'Серлифт', 'сертралин', 'Серлифт. Нарушения сна наблюдались.\n');
  await doc('D4', 'Кетамин', 'кетамин', 'Кетамин. Нарушения сна не описаны.\n');
  for (const [inn, id] of [
    ['сертралин', 'D1'],
    ['сертралин', 'D3'],
    ['амитриптилин', 'D2'],
    ['кетамин', 'D4'],
  ])
    await q('INSERT INTO med.drug_map VALUES ($1,$2)', [inn, id]);
  const sec = (id, d, parent, level, ord, title, start, end, page) =>
    q(
      `INSERT INTO med.sections (id, document_id, parent_id, level, ord, title, path, start_char, end_char, start_line, page)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,1,$9)`,
      [id, d, parent, level, ord, title, start, end, page],
    );
  await sec('D1-S1', 'D1', null, 1, 1, 'Показания', 0, off(MD1, '# Побочные'), '1');
  await sec('D1-S2', 'D1', null, 1, 2, 'Побочные реакции', off(MD1, '# Побочные'), off(MD1, '# Длинный'), '3');
  await sec('D1-S3', 'D1', null, 1, 3, 'Длинный раздел', off(MD1, '# Длинный'), MD1.length, '5');
  await sec('D2-S2', 'D2', null, 1, 1, 'Побочные реакции', off(MD2, '# Побочные'), MD2.length, '2');
  await sec('D3-S1', 'D3', null, 1, 1, 'Серлифт', 0, 40, null);
  await sec('D4-S1', 'D4', null, 1, 1, 'Кетамин', 0, 20, '1');
  await sec('D1-S2a', 'D1', 'D1-S2', 2, 4, 'Частота', off(MD1, '# Побочные'), off(MD1, '# Длинный'), '4');
  await q("UPDATE med.sections SET path = 'Побочные реакции / Частота' WHERE id = 'D1-S2a'");
  const chunk = (id, d, section, ord, text, axis) =>
    q(
      `INSERT INTO med.chunks (id, document_id, section_id, section_ids, ord, text, content_hash, start_char, end_char, embedding, embedding_model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9::halfvec,$10)`,
      [id, d, section, [section], ord, text, `h-${id}`, text.length, lit(axis, ord), MODEL],
    );
  await chunk('D1-c1', 'D1', 'D1-S2', 1, 'Сертралин может вызывать нарушения сна и бессонницу.', 1);
  await chunk('D1-c2', 'D1', 'D1-S1', 2, 'Сертралин показан при депрессии и тревоге.', 2);
  await chunk('D1-c3', 'D1', 'D1-S2a', 3, '## Частота\n| **Очень часто** | `редкость` |\n- тошнота', 5);
  await chunk('D2-c1', 'D2', 'D2-S2', 1, 'Амитриптилин вызывает сонливость и нарушения сна.', 1);
  await chunk('D3-c1', 'D3', 'D3-S1', 1, 'Серлифт: нарушения сна наблюдались.', 1);
  await chunk('D4-c1', 'D4', 'D4-S1', 1, 'Кетамин: нарушения сна не описаны.', 1);
}

// Фейковый клиент эмбеддингов (модуль для сервера): журнал вызовов и переключатель отказа — в файлах.
function writeStub(dir) {
  const file = path.join(dir, 'embed-stub.js');
  fs.writeFileSync(
    file,
    `'use strict';
const fs = require('node:fs');
const DIM = ${DIM};
const dir = ${JSON.stringify(dir)};
function vec(axis) {
  const v = Array.from({ length: DIM }, () => 0);
  v[axis] = 1;
  return v;
}
module.exports = {
  model: ${JSON.stringify(MODEL)},
  async embed(texts) {
    fs.appendFileSync(dir + '/embed-calls.jsonl', JSON.stringify(texts) + '\\n');
    if (fs.existsSync(dir + '/embed-fail')) throw Object.assign(new Error('down'), { code: 'transport' });
    return { model: ${JSON.stringify(MODEL)}, vectors: texts.map((t) => vec(/сна|сон|бессонн/.test(t) ? 1 : 100)) };
  },
};
`,
  );
  return file;
}
const embedCalls = () => {
  try {
    return fs
      .readFileSync(path.join(tmp, 'embed-calls.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

let main; // знания работают
let off1; // знания не настроены
let broken; // настроены, но недоступны
let psy;

before(
  async () => {
    if (skip) return;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-drugs-ins-'));
    admin = new Pool({ connectionString: url, max: 1 });
    dbName = `ks_app_${process.pid}_${Date.now() % 100000}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(url);
    u.pathname = `/${dbName}`;
    dbUrl = u.toString();
    kpool = createPool({ connectionString: dbUrl, max: 3 });
    await migrate(kpool);
    await loadKnowledge();
    const stub = writeStub(tmp);
    main = await startApp({
      env: { KNOWLEDGE_DATABASE_URL: dbUrl, KNOWLEDGE_EMBEDDING_STUB: stub, KNOWLEDGE_EMBED_COOLDOWN_MS: '50', CLINICIAN_AGENT_MODE: 'tools' },
    });
    apps.push(main);
    off1 = await startApp({});
    apps.push(off1);
    const bad = new URL(url);
    bad.port = '1'; // закрытый порт
    bad.pathname = `/${dbName}`;
    broken = await startApp({
      env: { KNOWLEDGE_DATABASE_URL: bad.toString(), KNOWLEDGE_DB_CONNECT_TIMEOUT_MS: '500' },
    });
    apps.push(broken);
    psy = await as(main, 'psy1');
  },
  { timeout: 240000 },
);

after(async () => {
  for (const a of apps) await a.stop().catch(() => {});
  if (kpool) await kpool.end().catch(() => {});
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const innId = async (c, name) => {
  const r = expectOk(await c.get(`/work/api/drugs?q=${encodeURIComponent(name)}`));
  const hit = r.items.find((x) => x.name === name);
  assert.ok(hit, `в каталоге теста нет ${name}`);
  return hit.id;
};

// ---------- чистые функции ----------
test('классификатор: вопросы о лекарствах и посторонние', () => {
  const terms = ['сертралин', 'золофт', 'амитриптилин', 'вальпроевая кислота'];
  for (const q of [
    'Какие побочные эффекты у амитриптилина?',
    'как отменять сертралином при беременности',
    'можно ли золофт с алкоголем',
    'максимальная доза 200 мг в сутки',
    'взаимодействие с ингибиторами МАО',
    'вальпроевая кислота при беременности',
    'расскажи про противопоказания',
  ])
    assert.equal(isDrugQuestion(q, terms), true, q);
  for (const q of [
    'Как лучше организовать приём в пятницу?',
    'Составь план беседы',
    'привет',
    'напомни, что я записывал вчера про тревогу',
    'дозвониться до коллеги',
  ])
    assert.equal(isDrugQuestion(q, terms), false, q);
});

test('очистка поисковой строки: ключи псевдонимизации, длинные числа и управляющие символы не уходят наружу', () => {
  assert.equal(publicReferenceTerm('побочные #PERSON-1#\u0000 у  +79991234567 сертралина'), 'побочные у сертралина');
  assert.ok(publicReferenceTerm('а'.repeat(500)).length <= 200);
});

test('выдержки: не более 5 штук и 6000 символов, метки [документ · раздел · стр.]', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    document_id: `D${i}`,
    label: `Док ${i}`,
    section_id: `S${i}`,
    path: 'Раздел / Подраздел',
    page: i % 2 ? '4' : null,
    text: 'слово '.repeat(900),
  }));
  const { block, sources } = buildExcerpts(rows);
  assert.ok(sources.length <= 5 && sources.length >= 1);
  assert.ok(block.length <= 6000 + 700, `блок ${block.length}`);
  assert.match(block, /\[Док 0 · Раздел \/ Подраздел\]/);
  assert.match(block, /\[Док 1 · Раздел \/ Подраздел · стр\. 4\]/);
  assert.deepEqual(Object.keys(sources[0]).sort(), ['document_id', 'label', 'page', 'path', 'section_id']);
});

// ---------- HTTP: инструкции, оглавление, разделы ----------
test('инструкции по МНН: документы, оглавление, раздел с постраничным чтением', { skip }, async () => {
  const sert = await innId(psy, 'сертралин');
  const list = expectOk(await psy.get(`/work/api/drugs/${sert}/instructions`));
  assert.equal(list.inn.name, 'сертралин');
  assert.deepEqual(list.documents.map((d) => d.id).sort(), ['D1', 'D3']);
  const d1 = list.documents.find((d) => d.id === 'D1');
  assert.equal(d1.label, 'Золофт');
  assert.equal(d1.sections, 4);
  assert.equal(d1.chunks, 3);
  assert.ok('trade_name' in d1 && 'manufacturer_hint' in d1);

  const toc = expectOk(await psy.get(`/work/api/drugs/${sert}/instructions/D1/toc`));
  assert.deepEqual(toc.document, { id: 'D1', label: 'Золофт' });
  assert.deepEqual(
    toc.items.map((i) => [i.id, i.level, i.title, i.page]),
    [
      ['D1-S1', 1, 'Показания', 1],
      ['D1-S2', 1, 'Побочные реакции', 3],
      ['D1-S3', 1, 'Длинный раздел', 5],
      ['D1-S2a', 2, 'Частота', 4],
    ],
  );

  // длинный раздел читается страницами без усечения
  let cursor = null;
  let text = '';
  let pages = 0;
  do {
    const q = cursor === null ? '' : `?cursor=${cursor}`;
    const r = expectOk(await psy.get(`/work/api/drugs/${sert}/instructions/D1/sections/D1-S3${q}`));
    assert.equal(r.title, 'Длинный раздел');
    text += r.text;
    pages += 1;
    assert.equal(r.hasMore, r.nextCursor !== null);
    cursor = r.nextCursor;
  } while (cursor !== null && pages < 10);
  assert.ok(pages >= 2, 'раздел длиннее одной страницы');
  assert.equal(text, MD1.slice(off(MD1, '# Длинный')));
});

test('границы: чужой документ, чужой раздел, неизвестный препарат — 404; плохой cursor — 422', { skip }, async () => {
  const sert = await innId(psy, 'сертралин');
  expectError(await psy.get(`/work/api/drugs/${sert}/instructions/D2/toc`), 404, 'E-NOT-FOUND'); // амитриптилин
  expectError(await psy.get(`/work/api/drugs/${sert}/instructions/D2/sections/D2-S2`), 404, 'E-NOT-FOUND');
  expectError(await psy.get(`/work/api/drugs/${sert}/instructions/D1/sections/D2-S2`), 404, 'E-NOT-FOUND');
  expectError(await psy.get(`/work/api/drugs/${sert}/instructions/NOPE/toc`), 404, 'E-NOT-FOUND');
  expectError(await psy.get('/work/api/drugs/999999/instructions'), 404, 'E-NOT-FOUND');
  expectError(await psy.get(`/work/api/drugs/${sert}/instructions/D1/sections/D1-S3?cursor=-1`), 422, 'E-VALIDATION');
  expectError(await psy.get(`/work/api/drugs/${sert}/instructions/D1/sections/D1-S3?cursor=abc`), 422, 'E-VALIDATION');
  // препарат без инструкций — пустой список
  const other = expectOk(await psy.get('/work/api/drugs')).items.find(
    (d) => !['сертралин', 'амитриптилин'].includes(d.name),
  );
  const none = expectOk(await psy.get(`/work/api/drugs/${other.id}/instructions`));
  assert.deepEqual(none.documents, []);
});

test('доступ: пациент 403, гость 401, психолог допущен', { skip }, async () => {
  const patient = await as(main, 'patA');
  const sert = await innId(psy, 'сертралин');
  for (const p of [
    `/work/api/drugs/${sert}/instructions`,
    `/work/api/drugs/${sert}/instructions/D1/toc`,
    `/work/api/drugs/${sert}/instructions/D1/sections/D1-S1`,
    `/work/api/drugs/${sert}/search?q=сон`,
    '/work/api/drugs/knowledge/search?q=сон',
  ]) {
    expectError(await patient.get(p), 403, 'E-ACCESS');
    expectError(await guest(main).get(p), 401, 'E-SESSION-EXPIRED');
  }
  const plg = await as(main, 'plg1');
  expectOk(await plg.get(`/work/api/drugs/${sert}/instructions`));
});

// ---------- инструкция по коду документа (источник ответа ИИ открывает её целиком) ----------
test('инструкция по коду: оглавление с родителями, раздел с подсветкой найденного фрагмента, чужой фрагмент не подсвечивается', { skip }, async () => {
  const toc = expectOk(await psy.get('/work/api/drugs/documents/D1'));
  assert.equal(toc.document.id, 'D1');
  assert.equal(toc.document.label, 'Золофт');
  const sub = toc.items.find((x) => x.id === 'D1-S2a');
  assert.equal(sub.parent_id, 'D1-S2', 'по родителям клиент находит главу раздела-источника');
  assert.ok(toc.items.every((x) => 'level' in x && 'title' in x && 'page' in x));

  const sec = expectOk(await psy.get('/work/api/drugs/documents/D1/sections/D1-S1?chunk=D1-c2'));
  assert.ok(sec.text.startsWith('# Показания'));
  assert.deepEqual(sec.mark, { start: 0, end: 'Сертралин показан при депрессии и тревоге.'.length });
  assert.equal(sec.offset, 0);
  assert.equal(expectOk(await psy.get('/work/api/drugs/documents/D1/sections/D1-S1')).mark, undefined);
  // фрагмент другого документа в этом разделе не подсвечивается
  assert.equal(expectOk(await psy.get('/work/api/drugs/documents/D1/sections/D1-S1?chunk=D2-c1')).mark, undefined);
  // длинный раздел постранично, как и в маршрутах по МНН
  const long = expectOk(await psy.get('/work/api/drugs/documents/D1/sections/D1-S3'));
  assert.equal(long.hasMore, true);
  assert.ok(expectOk(await psy.get(`/work/api/drugs/documents/D1/sections/D1-S3?cursor=${long.nextCursor}`)).offset > 0);

  expectError(await psy.get('/work/api/drugs/documents/NOPE'), 404, 'E-NOT-FOUND');
  expectError(await psy.get('/work/api/drugs/documents/D1/sections/NOPE'), 404, 'E-NOT-FOUND');
  expectError(await psy.get('/work/api/drugs/documents/D1/sections/D1-S1?cursor=-1'), 422, 'E-VALIDATION');
  expectError(await (await as(main, 'patA')).get('/work/api/drugs/documents/D1'), 403, 'E-ACCESS');
  expectError(await guest(main).get('/work/api/drugs/documents/D1'), 401, 'E-SESSION-EXPIRED');
});

// ---------- поиск ----------
test('поиск по препарату: только его документы, формат, страница и путь раздела', { skip }, async () => {
  const sert = await innId(psy, 'сертралин');
  const r = expectOk(await psy.get(`/work/api/drugs/${sert}/search?q=${encodeURIComponent('нарушения сна')}`));
  assert.ok(r.results.length >= 2);
  assert.ok(
    r.results.every((x) => ['D1', 'D3'].includes(x.document_id)),
    'чужие документы не попали',
  );
  assert.equal(r.fallback, null);
  assert.equal(typeof r.total, 'number');
  assert.equal(r.hasMore, false);
  const first = r.results.find((x) => x.document_id === 'D1');
  assert.deepEqual(Object.keys(first).sort(), [
    'document_id',
    'label',
    'match_type',
    'page',
    'path',
    'score',
    'section_id',
    'snippet',
  ]);
  assert.equal(first.path, 'Побочные реакции');
  assert.equal(first.page, 3);
  assert.ok(r.results.every((x) => x.page === null || typeof x.page === 'number'));
  // section_id из результата принимает маршрут раздела
  expectOk(await psy.get(`/work/api/drugs/${sert}/instructions/${first.document_id}/sections/${first.section_id}`));
  assert.equal(first.match_type, 'hybrid');
  assert.ok(first.snippet.length <= 401);
});

test('поиск: path — путь раздела, сниппет без Markdown', { skip }, async () => {
  const sert = await innId(psy, 'сертралин');
  const r = expectOk(await psy.get(`/work/api/drugs/${sert}/search?q=${encodeURIComponent('тошнота')}`));
  const hit = r.results.find((x) => x.section_id === 'D1-S2a');
  assert.ok(hit);
  assert.equal(hit.path, 'Побочные реакции / Частота');
  assert.equal(hit.page, 4);
  assert.doesNotMatch(hit.snippet, /[*#|`]/);
  assert.match(hit.snippet, /Очень часто/);
});

test('общий поиск: весь корпус, в результатах inn', { skip }, async () => {
  const r = expectOk(
    await psy.get(`/work/api/drugs/knowledge/search?q=${encodeURIComponent('нарушения сна')}&limit=20`),
  );
  const docs = new Set(r.results.map((x) => x.document_id));
  assert.ok(['D1', 'D2', 'D3', 'D4'].every((d) => docs.has(d)));
  assert.ok(r.results.every((x) => x.inn && typeof x.inn === 'object' && x.inn.name));
  const ami = await innId(psy, 'амитриптилин');
  assert.deepEqual(r.results.find((x) => x.document_id === 'D2').inn, { id: ami, name: 'амитриптилин' });
  assert.deepEqual(r.results.find((x) => x.document_id === 'D4').inn, { id: null, name: 'кетамин' });
});

test('поиск: валидация q, limit, offset и частота', { skip }, async () => {
  const sert = await innId(psy, 'сертралин');
  const bad = [
    `/work/api/drugs/${sert}/search`,
    `/work/api/drugs/${sert}/search?q=a`,
    `/work/api/drugs/${sert}/search?q=${'я'.repeat(201)}`,
    `/work/api/drugs/${sert}/search?q=сон&limit=21`,
    `/work/api/drugs/${sert}/search?q=сон&limit=0`,
    `/work/api/drugs/${sert}/search?q=сон&offset=-1`,
    '/work/api/drugs/knowledge/search?q=%20%20',
  ];
  for (const p of bad) expectError(await psy.get(p), 422, 'E-VALIDATION');
  expectOk(await psy.get(`/work/api/drugs/${sert}/search?q=${'я'.repeat(200)}`));
  expectError(await psy.get('/work/api/drugs/999999/search?q=сон'), 404, 'E-NOT-FOUND');
  const limited = await as(main, 'psy2');
  let last;
  for (let i = 0; i < 45; i += 1) {
    last = await limited.get(`/work/api/drugs/${sert}/search?q=${encodeURIComponent('сон')}`);
    if (last.status === 429) break;
  }
  expectError(last, 429, 'E-RATE-LIMIT');
});

test('поиск: во внешний эмбеддинг уходит только q, в журнале нет текста запроса', { skip }, async () => {
  const sert = await innId(psy, 'сертралин');
  const secret = 'уникальнаяфразазапроса';
  const before = embedCalls().length;
  expectOk(await psy.get(`/work/api/drugs/${sert}/search?q=${encodeURIComponent(secret + ' сна')}`));
  const added = embedCalls().slice(before);
  assert.equal(added.length, 1);
  assert.deepEqual(added[0], [normalizeText(secret + ' сна')]);
  const rows = main.query("SELECT action,target_type,target_id FROM action_log WHERE action LIKE 'knowledge.%'");
  assert.ok(rows.length >= 1);
  assert.ok(!JSON.stringify(main.query('SELECT * FROM action_log')).includes(secret));
});

test('деградация: эмбеддинги недоступны — lexical с fallback, поиск не падает', { skip }, async () => {
  const sert = await innId(psy, 'сертралин');
  fs.writeFileSync(path.join(tmp, 'embed-fail'), '1');
  try {
    // новая строка запроса: кэш вектора не должен скрыть отказ
    const r = expectOk(await psy.get(`/work/api/drugs/${sert}/search?q=${encodeURIComponent('бессонницу сна новое')}`));
    assert.equal(r.fallback, 'lexical');
    assert.ok(r.results.length >= 1);
    assert.ok(r.results.every((x) => x.match_type === 'lexical'));
  } finally {
    fs.rmSync(path.join(tmp, 'embed-fail'), { force: true });
  }
});

// ---------- чаты ----------
test('чат препарата: выдержки только из документов МНН треда, sources, метки в промпте', { skip }, async () => {
  const sert = await innId(psy, 'сертралин');
  const opened = (await psy.post(`/work/api/drugs/${sert}/open`, {}, { idem: false })).body;
  main.ai.reset();
  main.ai.queue({
    mode: 'text',
    text: 'Нарушения сна описаны [1][2][3]. Из общих знаний [0]. Выдумка [9]. Не удалось найти иное. Черновик для проверки.',
  });
  const r = expectOk(
    await psy.post(
      `/work/api/drugs/threads/${opened.thread.id}/messages`,
      { text: 'Какие нарушения сна бывают?' },
      { idem: false },
    ),
    201,
  );
  assert.ok(r.sources.length >= 2 && r.sources.length <= 6);
  assert.ok(
    r.sources.every((s) => s.model_knowledge || ['D1', 'D3'].includes(s.document_id)),
    'область — только сертралин',
  );
  assert.equal(r.sources[0].model_knowledge, true, '[0] — «Знания модели»');
  const d1 = r.sources.find((s) => s.document_id === 'D1');
  assert.deepEqual(
    { ...d1, n: undefined, chunk_id: undefined, snippet: undefined, inn_id: undefined },
    {
      n: undefined,
      kind: 'drug',
      drug: true,
      document_id: 'D1',
      label: 'Золофт',
      section_id: 'D1-S2',
      chunk_id: undefined,
      snippet: undefined,
      inn_id: undefined,
      path: 'Побочные реакции',
      page: 3,
    },
  );
  assert.ok(d1.chunk_id && d1.snippet && Number.isInteger(d1.n));
  assert.ok(!/\[9\]|Не удалось найти/.test(r.reply.text), 'выдуманная метка и оборот про поиск убраны');
  assert.equal(r.reply.status, 'normal');
  assert.deepEqual(r.reply.sources, r.sources, 'sources и в reply, и на верхнем уровне');
  const seen = main.ai.seenText();
  assert.match(seen, /выдержки из инструкций/);
  assert.match(seen, /Золофт · Побочные реакции · стр\. 3/);
  assert.doesNotMatch(seen, /Амитриптилин вызывает сонливость/, 'документы другого МНН в промпт не попали');
  assert.doesNotMatch(seen, /Кетамин: нарушения/);
  const audit = main.query("SELECT action,target_type FROM action_log WHERE action='knowledge.retrieve'");
  assert.ok(audit.length >= 1);
});

test('чат препарата: знания недоступны — прежнее поведение (карточка каталога), чат отвечает', { skip }, async () => {
  const c = await as(broken, 'psy1');
  const inn = expectOk(await c.get('/work/api/drugs?q=сертралин')).items[0];
  const opened = (await c.post(`/work/api/drugs/${inn.id}/open`, {}, { idem: false })).body;
  broken.ai.reset();
  broken.ai.queue({ mode: 'text', text: 'Справочный ответ по карточке. Черновик для проверки.' });
  const r = expectOk(
    await c.post(
      `/work/api/drugs/threads/${opened.thread.id}/messages`,
      { text: 'Что с нарушениями сна?' },
      { idem: false },
    ),
    201,
  );
  assert.deepEqual(r.sources, []);
  assert.equal(r.knowledge.mode, 'off');
  assert.match(broken.ai.seenText(), /справочник препарата/);
  assert.doesNotMatch(broken.ai.seenText(), /выдержки из инструкций/);
});

test('общий чат: вопрос о лекарствах получает поиск по корпусу, посторонний вопрос — нет', { skip }, async () => {
  main.ai.reset();
  // Выдержки получают номера [n] общей нумерации ответа; карточка источника — только у тех, на которые ответ сослался
  // (изменено вместе с источниками по номерам, 2026-10-26: раньше показывались все найденные выдержки).
  main.ai.queue({ mode: 'text', text: 'Сонливость и нарушения сна [1][2][3][4][5][9]. Черновик для проверки.' });
  let calls = embedCalls().length;
  const drug = expectOk(
    await psy.post('/api/v1/ai/clinician/messages', { text: 'Какие побочные эффекты амитриптилина: нарушения сна?' }),
    201,
  );
  assert.ok(Array.isArray(drug.sources) && drug.sources.length >= 1);
  assert.ok(drug.sources.some((s) => s.document_id === 'D2'));
  assert.ok(drug.sources.every((s) => Number.isInteger(s.n) && s.drug === true && s.chunk_id), 'у источника есть номер и адрес фрагмента');
  assert.ok(!drug.reply.text.includes('[9]'), 'метка без источника убрана из текста');
  assert.deepEqual(drug.reply.sources, drug.sources);
  assert.equal(drug.reply.status, 'normal', 'справочный режим вывода: название и доза не вырезаются');
  assert.match(main.ai.seenText(), /выдержки из инструкций/);
  assert.equal(embedCalls().length, calls + 1);

  main.ai.reset();
  calls = embedCalls().length;
  const other = expectOk(
    await psy.post('/api/v1/ai/clinician/messages', { text: 'Как лучше организовать приём в пятницу?' }),
    201,
  );
  assert.equal(other.sources, undefined);
  assert.doesNotMatch(main.ai.seenText(), /выдержки из инструкций/);
  assert.equal(embedCalls().length, calls, 'для не-лекарственного вопроса внешний вызов не делается');
});

test('агент психиатра: инструмент поиска по инструкциям, ссылка [n] — источник с разделом', { skip }, async () => {
  main.ai.reset();
  main.ai.queue(
    { mode: 'tool', name: 'search_drug_instructions', arguments: { query: 'нарушения сна', inn: 'амитриптилин' } },
    { mode: 'text', text: 'Сонливость и нарушения сна [1]. Рассказать подробнее?' },
  );
  const r = expectOk(await psy.post('/api/v1/ai/clinician/messages', { text: 'Расскажи про сон' }), 201);
  const calls = main.ai.calls();
  const names = (calls[0].tools || []).map((t) => t.name);
  assert.ok(names.includes('search_drug_instructions'));
  assert.ok(!names.includes('search_clinrec'), 'клинреков в базе нет — их инструментов тоже');
  const tool = calls[1].messages.filter((m) => m.role === 'tool').at(-1).content;
  assert.match(tool, /\[1\] Инструкция: Амитриптилин Никомед/);
  assert.doesNotMatch(tool, /Золофт/, 'область задана МНН');
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0].document_id, 'D2');
  assert.equal(r.sources[0].section_id, 'D2-S2');
  assert.equal(r.sources[0].n, 1);
  assert.ok('inn_id' in r.sources[0]);
});

test('общий чат с пациентом: выдержки не подмешиваются, внешний эмбеддинг не вызывается', { skip }, async () => {
  const patId = main.ids.patA;
  const calls = embedCalls().length;
  main.ai.reset();
  const doctor = await as(main, 'psy1');
  const res = await doctor.post('/api/v1/ai/clinician/messages', {
    patient_id: patId,
    text: 'Какие побочные эффекты амитриптилина?',
    chips: [{ type: 'patient', id: patId }],
  });
  if (res.status === 201 || res.status === 200) {
    assert.equal(res.body.sources, undefined);
    assert.doesNotMatch(main.ai.seenText(), /выдержки из инструкций/);
  }
  assert.equal(embedCalls().length, calls);
});

// ---------- /readyz и выключенные знания ----------
test(
  '/readyz: знания работают — ok с числами; не настроены — disabled, не краснеет; недоступны — down, ready',
  { skip },
  async () => {
    const ok = await guest(main).get('/readyz');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'ready');
    assert.equal(ok.body.knowledge.status, 'ok');
    assert.equal(ok.body.knowledge.documents, 4);
    assert.equal(ok.body.knowledge.vectors, 6);

    const disabled = await guest(off1).get('/readyz');
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.status, 'ready');
    assert.deepEqual(disabled.body.knowledge, { configured: false, status: 'disabled' });

    const down = await guest(broken).get('/readyz');
    assert.equal(down.status, 200);
    assert.equal(down.body.status, 'ready');
    assert.equal(down.body.knowledge.status, 'down');
    assert.equal(JSON.stringify(down.body).includes('127.0.0.1'), false);
  },
);

test('знания не настроены или недоступны: пути работают без падения', { skip }, async () => {
  for (const app of [off1, broken]) {
    const c = await as(app, 'psy1');
    const inn = expectOk(await c.get('/work/api/drugs?q=сертралин')).items[0];
    assert.deepEqual(expectOk(await c.get(`/work/api/drugs/${inn.id}/instructions`)).documents, []);
    const s = expectOk(await c.get(`/work/api/drugs/${inn.id}/search?q=${encodeURIComponent('нарушения сна')}`));
    assert.deepEqual(s, { results: [], total: 0, hasMore: false, fallback: 'unavailable' });
    // не настроено — документов нет (404); настроено, но недоступно — 503
    if (app === off1) expectError(await c.get(`/work/api/drugs/${inn.id}/instructions/D1/toc`), 404, 'E-NOT-FOUND');
    else expectError(await c.get(`/work/api/drugs/${inn.id}/instructions/D1/toc`), 503, 'E-AI-UNAVAILABLE');
    expectOk(await c.get('/work/api/drugs/knowledge/search?q=сон'));
  }
});

test('препарат назван, а его инструкции в базе нет: выдержки чужих препаратов не подкладываются и источниками не становятся', { skip }, async () => {
  const noDoc = main.query("SELECT name FROM inn WHERE status='in_catalog' AND name_norm NOT IN ('сертралин','амитриптилин','кетамин') LIMIT 1")[0];
  assert.ok(noDoc, 'в каталоге есть МНН без инструкции');
  const { namedWithoutInstructions } = require('../../src/modules/drugs/instructions');
  const knowledge = require('../../src/modules/knowledge/service').createKnowledgeService({ env: { KNOWLEDGE_DATABASE_URL: dbUrl } });
  try {
    const db = { prepare: (sql) => ({ all: () => main.query(sql) }) };
    assert.equal(await namedWithoutInstructions({ db, knowledge, text: `${noDoc.name}: дозы и беременность, нарушения сна` }), true);
    assert.equal(await namedWithoutInstructions({ db, knowledge, text: 'сертралин: нарушения сна' }), false, 'у сертралина инструкция есть');
    assert.equal(await namedWithoutInstructions({ db, knowledge, text: 'нарушения сна' }), false, 'препарат не назван');
  } finally {
    await knowledge.close();
  }
  main.ai.reset();
  main.ai.queue({ mode: 'text', text: 'Из общих знаний [0]. В материалах этого нет, не удалось найти.' });
  const r = expectOk(
    await psy.post('/api/v1/ai/clinician/messages', { text: `${noDoc.name}: побочные эффекты и нарушения сна?` }),
    201,
  );
  assert.ok(!/выдержки из инструкций/.test(main.ai.seenText()), 'чужие инструкции в запрос не попали');
  assert.deepEqual(r.sources.map((s) => s.n), [0], 'только «Знания модели»');
  assert.ok(!/материалах|не удалось/.test(r.reply.text), 'обороты про поиск убраны');
});

test('остановка сервера закрывает пул: процесс завершается по SIGTERM', { skip }, async () => {
  const child = main.child;
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  child.kill('SIGTERM');
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
  assert.equal(code, 0);
});
