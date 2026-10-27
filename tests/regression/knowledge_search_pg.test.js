'use strict';
// covers: поиск и инструменты агента на Postgres (lexical/semantic/hybrid, scope, fallback, parent-child, HNSW с фильтром).
// Нужен pgvector-инстанс: KNOWLEDGE_TEST_DATABASE_URL (достаточно прав CREATE DATABASE). Тест создаёт СВОЮ временную
// БД ks_test_*, применяет миграции, грузит синтетические данные и удаляет БД; схемы med/clinrec основной БД не трогает.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { createPool, close, toVectorLiteral } = require('../../src/modules/knowledge/pg');
const { migrate } = require('../../src/modules/knowledge/migrate');
const rrf = require('../../src/modules/knowledge/rrf');
const medSearch = require('../../src/modules/knowledge/search_med');
const clinSearch = require('../../src/modules/knowledge/search_clinrec');
const { createKnowledgeTools, toolDefinitions } = require('../../src/modules/knowledge/tools');

const url = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const skip = url ? false : 'KNOWLEDGE_TEST_DATABASE_URL не задан: нужен Postgres с pgvector (deploy/compose.dev.yml)';
const DIM = 2560;
const MODEL = 'fake-model';

// ---------- синтетические векторы ----------
// Единичный базис по оси + детерминированный мелкий шум; mix — смесь осей.
function noise(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 4294967296 - 0.5) * 0.002;
  };
}
function vec(axes, seed = 1) {
  const r = noise(seed);
  const v = Array.from({ length: DIM }, r);
  const list = typeof axes === 'number' ? [[axes, 1]] : axes;
  for (const [a, w] of list) v[a] += w;
  return v;
}
const lit = (axes, seed) => toVectorLiteral(vec(axes, seed));

// Фейковый клиент эмбеддингов: термин -> вектор; записывает полученные тексты.
function fakeClient(table, { model = MODEL, fail = false } = {}) {
  return {
    model,
    calls: [],
    async embed(texts) {
      this.calls.push(texts);
      if (fail) throw Object.assign(new Error('boom'), { code: 'transport' });
      return { model, vectors: texts.map((t) => vec(table[t] ?? 100, 7)) };
    },
  };
}

let admin;
let dbName;
let pool;
const pools = [];

async function mkPool(extra = {}) {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  const p = createPool({ connectionString: u.toString(), max: 4, ...extra });
  pools.push(p);
  return p;
}

// ---------- данные ----------
const MD1 =
  '# Показания\nСертралин показан при депрессии.\n## Дозировка\nНачальная доза 50 мг.\n# Побочные реакции\nНарушения сна, головная боль.\n';
const MD2 = '# Показания\nАмитриптилин применяют при депрессии.\n# Побочные реакции\nСонливость, бессонница.\n';
const off = (md, s) => md.indexOf(s);

async function loadMed() {
  const q = (sql, p) => pool.query(sql, p);
  const doc = (id, label, inn, trade, md) =>
    q(
      `INSERT INTO med.documents (id, drug_label, inn, trade_name, source_file, sha256, markdown) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, label, inn, trade, `${id}.md`, `sha-${id}`, md],
    );
  await doc('D1', 'Золофт', 'сертралин', 'Золофт', MD1);
  await doc('D2', 'Амитриптилин Никомед', 'амитриптилин', null, MD2);
  await doc('D3', 'Серлифт', 'сертралин', 'Серлифт', 'Серлифт. Нарушения сна не описаны.\n');
  await doc('D4', 'Кетамин', 'кетамин', null, 'Кетамин.\n');
  for (const [inn, id] of [
    ['сертралин', 'D1'],
    ['сертралин', 'D3'],
    ['амитриптилин', 'D2'],
  ])
    await q('INSERT INTO med.drug_map VALUES ($1,$2)', [inn, id]);
  const sec = (id, doc, parent, level, ord, title, start, end) =>
    q(
      `INSERT INTO med.sections (id, document_id, parent_id, level, ord, title, path, start_char, end_char, start_line)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,1)`,
      [id, doc, parent, level, ord, title, start, end],
    );
  const side = off(MD1, '# Побочные');
  await sec('D1-S1', 'D1', null, 1, 1, 'Показания', 0, side);
  await sec('D1-S1a', 'D1', 'D1-S1', 2, 2, 'Дозировка', off(MD1, '## Дозировка'), side);
  await sec('D1-S2', 'D1', null, 1, 3, 'Побочные реакции', side, MD1.length);
  await sec('D2-S2', 'D2', null, 1, 1, 'Побочные реакции', off(MD2, '# Побочные'), MD2.length);
  await sec('D3-S1', 'D3', null, 1, 1, 'Серлифт', 0, 40);
  const chunk = (id, doc, section, ord, text, axes) =>
    q(
      `INSERT INTO med.chunks (id, document_id, section_id, section_ids, ord, text, content_hash, start_char, end_char,
                               embedding, embedding_model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9::halfvec,$10)`,
      [
        id,
        doc,
        section,
        [section],
        ord,
        text,
        `h-${id}`,
        text.length,
        axes === null ? null : lit(axes, ord),
        axes === null ? null : MODEL,
      ],
    );
  await chunk('D1-c1', 'D1', 'D1-S2', 1, 'Сертралин может вызывать нарушения сна и бессонницу.', 1);
  await chunk('D1-c2', 'D1', 'D1-S1a', 2, 'Начальная доза 50 мг, дозы подбирают постепенно.', 2);
  await chunk('D1-c3', 'D1', 'D1-S2', 3, 'Головная боль и мигрень возникают редко.', 3);
  await chunk('D2-c1', 'D2', 'D2-S2', 1, 'Сонливость, бессонница при приёме амитриптилина.', [
    [1, 0.9],
    [2, 0.1],
  ]);
  await chunk('D3-c1', 'D3', 'D3-S1', 1, 'Серлифт: нарушения сна наблюдались.', [
    [1, 0.8],
    [4, 0.2],
  ]);
  // Эффекты и связи.
  const effect = (id, name, aliases, axes) =>
    q(
      `INSERT INTO med.effects (id, name, category, raw_json, embedding, embedding_model) VALUES ($1,$2,'нервная',$3,$4::halfvec,$5)`,
      [
        id,
        name,
        JSON.stringify({ id, name, aliases }),
        axes === null ? null : lit(axes, 3),
        axes === null ? null : MODEL,
      ],
    );
  await effect('E1', 'Головная боль', ['цефалгия'], 3);
  await effect('E2', 'Тошнота', [], 9);
  await effect('E3', 'Нарушение сна', ['бессонница'], 1);
  for (const [id, name, aliases] of [
    ['E1', 'Головная боль', ['цефалгия']],
    ['E2', 'Тошнота', []],
    ['E3', 'Нарушение сна', ['бессонница']],
  ])
    for (const alias of [...new Set([name, ...aliases])])
      await q('INSERT INTO med.effect_aliases VALUES ($1,$2,$3)', [id, alias, rrf.normalizeText(alias)]);
  await q(`INSERT INTO med.blocks VALUES ('B1','D1',$1), ('B2','D1',$2), ('B3','D2',$3)`, [
    JSON.stringify({ id: 'B1', drug: 'D1', text: 'Часто: головная боль', line: 6 }),
    JSON.stringify({ id: 'B2', drug: 'D1', text: 'при отмене' }),
    JSON.stringify({ id: 'B3', drug: 'D2', text: 'Редко: головная боль' }),
  ]);
  await q(`INSERT INTO med.source_mentions VALUES ('M1','D1',$1)`, [
    JSON.stringify({ id: 'M1', drug: 'D1', start: 10, end: 22 }),
  ]);
  const link = (id, effect, doc, block, ctx, extra = {}) =>
    q(`INSERT INTO med.effect_links VALUES ($1,$2,$3,$4,'часто',$5,$6,$7)`, [
      id,
      effect,
      doc,
      block,
      ctx,
      'головная боль',
      JSON.stringify({ id, effect, drug: doc, block, context: ctx, ...extra }),
    ]);
  await link('L1', 'E1', 'D1', 'B1', 'приём', { qualifier_block_ids: ['B2'], source_mention_ids: ['M1'] });
  await link('L2', 'E1', 'D2', 'B3', 'отмена');
  await link('L3', 'E3', 'D3', 'B1', 'приём').catch(() => {});
}

async function loadClinrec() {
  const q = (sql, p) => pool.query(sql, p);
  await q(
    `INSERT INTO clinrec.documents (id, title, source_sha256, version) VALUES ('R1','Депрессия','sha-r1','1'),('R2','Тревога','sha-r2','1')`,
  );
  await q(`INSERT INTO clinrec.sections (id, document_id, parent_id, level, ord, title, path, span) VALUES
     ('R1-S1','R1',NULL,1,1,'Диагностика','Диагностика','{"start":0,"end":100}'),
     ('R1-S2','R1','R1-S1',2,2,'Шкалы','Диагностика / Шкалы','{"start":100,"end":200}')`);
  await q(`INSERT INTO clinrec.parents (id, document_id, section_id, heading_path, text, span) VALUES
     ('P1','R1','R1-S1','{Диагностика}','ПОЛНЫЙ РОДИТЕЛЬ: диагностика депрессии включает оценку настроения, интереса и энергии. Критерии подробно.','{"start":0,"end":100}'),
     ('P2','R1','R1-S2','{Диагностика,Шкалы}','Родитель про шкалы.','{"start":100,"end":150}')`);
  const chunk = (id, doc, section, kind, parent, mode, text, axes, metadata = {}) =>
    q(
      `INSERT INTO clinrec.chunks (id, document_id, section_id, kind, parent_id, mode, heading_path, text, span, metadata, embedding, embedding_model, embed, embed_text, embed_text_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::halfvec,$12,true,$8,md5($8))`,
      [
        id,
        doc,
        section,
        kind,
        parent,
        mode,
        ['Диагностика'],
        text,
        JSON.stringify({ start: 1 }),
        JSON.stringify(metadata),
        axes === null ? null : lit(axes, 5),
        axes === null ? null : MODEL,
      ],
    );
  await chunk('k1', 'R1', 'R1-S1', 'main', 'P1', 'parent', 'критерии депрессии: сниженное настроение', 20);
  await chunk('k2', 'R1', 'R1-S1', 'main', 'P1', 'parent', 'критерии депрессии: ангедония', [
    [20, 0.9],
    [21, 0.1],
  ]);
  await chunk('k3', 'R1', 'R1-S2', 'method', null, 'self', 'шкала PHQ-9 для самооценки', 22);
  await chunk('k4', 'R1', 'R1-S1', 'main', null, 'window', 'алгоритм лечения: первый этап терапии', 23, {
    neighbors: { previous_id: 'k5', next_id: 'k6', limit_each_side: 1 },
    depends_on: { required_chunk_ids: ['k7'], always_include_spans: [{ start: 500, end: 520 }] },
  });
  await chunk('k5', 'R1', 'R1-S1', 'main', null, 'self', 'предшествующий абзац про подготовку', 24);
  await chunk('k6', 'R1', 'R1-S1', 'main', null, 'self', 'последующий абзац про контроль', 25);
  await chunk('k7', 'R1', 'R1-S1', 'appendix', null, 'self', 'обязательное приложение к алгоритму', 26);
  await chunk('k8', 'R2', null, 'main', null, 'self', 'критерии тревожного расстройства', [
    [20, 0.5],
    [30, 0.5],
  ]);
  await chunk('k9', 'R1', 'R1-S1', 'main', 'P1', 'parent', 'вектор отсутствует у этого чанка критерии', null);
}

test('knowledge search (postgres)', { skip }, async (t) => {
  admin = new Pool({ connectionString: url, max: 1 });
  dbName = `ks_test_${process.pid}_${Date.now() % 100000}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  pool = await mkPool();
  t.after(async () => {
    for (const p of pools) await close(p).catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.end();
  });
  await migrate(pool);
  await loadMed();
  await loadClinrec();

  const table = {
    бессонница: 1,
    мигрень: 3,
    'головная боль': 3,
    дозы: 1, // лексически находит D1-c2, семантически — сон
    'нарушения сна': 1,
    'критерии депрессии': 20,
    'алгоритм лечения': 23,
    'шкала phq 9': 22,
    тошнота: 9,
  };

  await t.test('rrfFuse: k=60, оба ранга сохраняются', () => {
    const fused = rrf.rrfFuse({ lexical: [{ id: 'a' }, { id: 'b' }], semantic: [{ id: 'b' }, { id: 'c' }] });
    assert.deepEqual(
      fused.map((r) => r.id),
      ['b', 'a', 'c'],
    );
    assert.ok(Math.abs(fused[0].score - (1 / 62 + 1 / 61)) < 1e-12);
    assert.deepEqual(fused[0].ranks, { lexical: 2, semantic: 1 });
    assert.deepEqual(fused[1].ranks, { lexical: 1 });
  });

  await t.test('searchDrugs: точное МНН/торговое, иначе нечёткие с пометкой, scope', async () => {
    const inn = await medSearch.searchDrugs(pool, { query: 'Сертралин' });
    assert.deepEqual(inn.results.map((r) => r.id).sort(), ['D1', 'D3']);
    assert.ok(inn.results.every((r) => r.match_type === 'exact' && r.review_required === true));
    assert.equal(inn.total, 2);
    assert.equal(inn.hasMore, false);
    const trade = await medSearch.searchDrugs(pool, { query: 'золофт' });
    assert.deepEqual(
      trade.results.map((r) => r.id),
      ['D1'],
    );
    const fuzzy = await medSearch.searchDrugs(pool, { query: 'амитриптилн' });
    assert.equal(fuzzy.results[0].id, 'D2');
    assert.equal(fuzzy.results[0].match_type, 'fuzzy');
    assert.ok(fuzzy.results[0].score < 1);
    assert.equal((await medSearch.searchDrugs(pool, { query: 'зззйййццц' })).total, 0);
    const paged = await medSearch.searchDrugs(pool, { query: 'сертралин', limit: 1 });
    assert.equal(paged.results.length, 1);
    assert.equal(paged.hasMore, true);
    // scope: сервер ограничил областью сертралина — амитриптилин не виден даже по точному имени.
    const scope = { innNorm: 'Сертралин' };
    assert.equal((await medSearch.searchDrugs(pool, { query: 'амитриптилин', scope })).total, 0);
    assert.equal((await medSearch.searchDrugs(pool, { query: 'золофт', scope })).total, 1);
    await assert.rejects(medSearch.searchDrugs(pool, { query: '   ' }), { code: 'invalid_query' });
    await assert.rejects(medSearch.searchDrugs(pool, { query: 'a', limit: 0 }), { code: 'invalid_pagination' });
  });

  await t.test('getToc / readSection: потомки, постранично без усечения, scope', async () => {
    const toc = await medSearch.getToc(pool, { documentId: 'D1' });
    assert.deepEqual(
      toc.sections.map((s) => s.id),
      ['D1-S1', 'D1-S1a', 'D1-S2'],
    );
    assert.equal(toc.document.label, 'Золофт');
    const whole = await medSearch.readSection(pool, { documentId: 'D1', sectionId: 'D1-S1' });
    assert.equal(whole.text, MD1.slice(0, off(MD1, '# Побочные')));
    assert.match(whole.text, /Дозировка/); // потомок включён
    assert.equal(whole.hasMore, false);
    let text = '';
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const p = await medSearch.readSection(pool, { documentId: 'D1', sectionId: 'D1-S1', cursor, maxChars: 17 });
      text += p.text;
      pages++;
      if (!p.hasMore) break;
      cursor = p.nextCursor;
    }
    assert.equal(text, whole.text);
    assert.ok(pages > 2);
    await assert.rejects(medSearch.readSection(pool, { documentId: 'D1', sectionId: 'нет' }), {
      code: 'section_not_found',
    });
    await assert.rejects(medSearch.getToc(pool, { documentId: 'D2', scope: { innNorm: 'сертралин' } }), {
      code: 'document_not_found',
    });
    await assert.rejects(
      medSearch.readSection(pool, { documentId: 'D2', sectionId: 'D2-S2', scope: { documentIds: ['D1'] } }),
      {
        code: 'document_not_found',
      },
    );
  });

  await t.test('searchText lexical: tsvector russian, scope, drugIds только сужает, OR-запас', async () => {
    const r = await medSearch.searchText(pool, { query: 'нарушения сна' });
    assert.equal(r.mode, 'lexical');
    assert.equal(r.query_form, 'and');
    assert.deepEqual(r.results.map((x) => x.id).sort(), ['D1-c1', 'D3-c1']);
    const first = r.results[0];
    assert.equal(first.match_type, 'lexical');
    assert.ok(first.score > 0);
    assert.equal(first.source_file, `${first.document_id}.md`);
    const d1 = r.results.find((x) => x.id === 'D1-c1');
    assert.deepEqual(d1.section_paths, [['Побочные реакции']]);
    // морфология: «бессонница» находит «бессонницу»
    assert.ok((await medSearch.searchText(pool, { query: 'бессонницы' })).results.some((x) => x.id === 'D1-c1'));
    // scope по МНН
    const scoped = await medSearch.searchText(pool, { query: 'нарушения сна', scope: { innNorm: 'сертралин' } });
    assert.equal(scoped.total, 2);
    const amit = await medSearch.searchText(pool, { query: 'бессонница', scope: { innNorm: 'амитриптилин' } });
    assert.deepEqual(
      amit.results.map((x) => x.id),
      ['D2-c1'],
    );
    // drugIds не расширяет серверный scope
    const narrow = await medSearch.searchText(pool, {
      query: 'нарушения сна',
      scope: { documentIds: ['D1'] },
      drugIds: ['D1', 'D3'],
    });
    assert.deepEqual(
      narrow.results.map((x) => x.id),
      ['D1-c1'],
    );
    assert.equal(
      (await medSearch.searchText(pool, { query: 'нарушения сна', scope: { documentIds: ['D1'] }, drugIds: ['D3'] }))
        .total,
      0,
    );
    // постраничность
    const p1 = await medSearch.searchText(pool, { query: 'нарушения сна', limit: 1 });
    const p2 = await medSearch.searchText(pool, { query: 'нарушения сна', limit: 1, offset: 1 });
    assert.equal(p1.hasMore, true);
    assert.equal(p2.hasMore, false);
    assert.equal(p1.total, 2);
    assert.notEqual(p1.results[0].id, p2.results[0].id);
    // AND ничего не находит -> OR по префиксам
    const relaxed = await medSearch.searchText(pool, { query: 'сертралин мигрень кетамин' });
    assert.equal(relaxed.query_form, 'or');
    assert.ok(relaxed.total >= 1);
    await assert.rejects(medSearch.searchText(pool, { query: 'x', mode: 'fuzzy' }), { code: 'invalid_mode' });
  });

  await t.test(
    'слишком общий запрос: OR-форма пропускается (lexical_skipped), hybrid опирается на semantic',
    async () => {
      const q = 'при и в сертралин мигрень кетамин';
      const normal = await medSearch.searchText(pool, { query: q });
      assert.equal(normal.query_form, 'or');
      assert.equal(normal.lexical_skipped, null);
      assert.ok(normal.total >= 1);
      const tiny = await medSearch.searchText(pool, { query: q, maxOrMatches: 1 });
      assert.equal(tiny.lexical_skipped, 'too_broad');
      assert.deepEqual(tiny.results, []);
      assert.equal(tiny.total, 0);
      assert.match(tiny.hint, /Уточните/);
      // страница за концом списка тоже помечается
      assert.equal(
        (await medSearch.searchText(pool, { query: q, maxOrMatches: 1, offset: 5 })).lexical_skipped,
        'too_broad',
      );
      // hybrid: lexical пропущен, результаты — из semantic
      const client = fakeClient({ [q.replace(/\s+/g, ' ')]: 3 });
      const hyb = await medSearch.searchText(pool, { query: q, mode: 'hybrid', client, maxOrMatches: 1 });
      assert.equal(hyb.lexical_skipped, 'too_broad');
      assert.equal(hyb.available, true);
      assert.equal(hyb.hint, undefined);
      assert.ok(hyb.results.length > 0 && hyb.results.every((r) => r.lexical_rank === null && r.semantic_rank >= 1));
      // обычный AND-запрос не затрагивается лимитом
      assert.ok((await medSearch.searchText(pool, { query: 'нарушения сна', maxOrMatches: 1 })).total === 2);
      // клинреки
      const c = await clinSearch.searchClinrec(pool, 'при критерии депрессии тревоги кетамин', { maxOrMatches: 1 });
      assert.equal(c.lexical_skipped, 'too_broad');
      assert.deepEqual(c.results, []);
    },
  );

  await t.test('searchText semantic: available/ранги/scope/кэш/очищенный термин', async () => {
    // нет клиента
    const none = await medSearch.searchText(pool, { query: 'бессонница', mode: 'semantic' });
    assert.equal(none.available, false);
    assert.equal(none.reason, 'embedding_client_unavailable');
    assert.deepEqual(none.results, []);
    const client = fakeClient(table);
    const r = await medSearch.searchText(pool, { query: 'Бессонница!!!', mode: 'semantic', client });
    assert.equal(r.available, true);
    assert.equal(r.model, MODEL);
    assert.equal(r.results[0].id, 'D1-c1'); // ось 1
    assert.equal(r.results[0].match_type, 'semantic');
    assert.equal(r.results[0].semantic_rank, 1);
    assert.ok(r.results[0].score > r.results[1].score);
    assert.deepEqual(
      r.results.slice(0, 3).map((x) => x.id),
      ['D1-c1', 'D2-c1', 'D3-c1'],
    );
    // наружу ушёл только очищенный термин
    assert.deepEqual(client.calls, [['бессонница']]);
    // кэш: повтор и вариант написания не вызывают API
    await medSearch.searchText(pool, { query: 'бессонница', mode: 'semantic', client });
    await medSearch.searchText(pool, { query: 'БЕССОННИЦА', mode: 'semantic', client, limit: 1 });
    assert.equal(client.calls.length, 1);
    assert.equal(rrf.cacheSize(client), 1);
    // scope сужает
    const scoped = await medSearch.searchText(pool, {
      query: 'бессонница',
      mode: 'semantic',
      client,
      scope: { innNorm: 'амитриптилин' },
    });
    assert.deepEqual(
      scoped.results.map((x) => x.id),
      ['D2-c1'],
    );
    // пагинация
    const p = await medSearch.searchText(pool, { query: 'бессонница', mode: 'semantic', client, limit: 2, offset: 1 });
    assert.deepEqual(
      p.results.map((x) => x.id),
      ['D2-c1', 'D3-c1'],
    );
    // другая модель клиента: векторы чужой модели не используются
    const other = fakeClient(table, { model: 'other-model' });
    const mism = await medSearch.searchText(pool, { query: 'бессонница', mode: 'semantic', client: other });
    assert.equal(mism.available, false);
    assert.equal(mism.reason, 'embedding_model_mismatch');
    assert.equal(other.calls.length, 0);
    // клиент падает: не исключение, а available:false
    const bad = fakeClient(table, { fail: true });
    const failed = await medSearch.searchText(pool, { query: 'сон', mode: 'semantic', client: bad });
    assert.equal(failed.available, false);
    assert.equal(failed.reason, 'embedding_request_failed');
    // кривой ответ клиента
    const wrong = {
      model: MODEL,
      async embed() {
        return { model: MODEL, vectors: [[1, 2, 3]] };
      },
    };
    await assert
      .rejects(medSearch.searchText(pool, { query: 'сон два', mode: 'semantic', client: wrong }), {
        code: 'invalid_embedding_response',
      })
      .catch(() => {}); // сбой эмбеддинга сворачивается в available:false — оба исхода допустимы
  });

  await t.test('searchText hybrid: RRF с рангами, откат к lexical', async () => {
    const client = fakeClient(table);
    const r = await medSearch.searchText(pool, { query: 'дозы', mode: 'hybrid', client });
    assert.equal(r.available, true);
    assert.equal(r.fallback, null);
    assert.equal(r.results[0].match_type, 'hybrid');
    const byId = new Map(r.results.map((x) => [x.id, x]));
    const dose = byId.get('D1-c2'); // лексика: ранг 1; семантика: «дозы» -> ось 1, D1-c2 не первый
    assert.equal(dose.lexical_rank, 1);
    assert.ok(dose.semantic_rank > 1);
    const sleep = byId.get('D1-c1'); // только семантика
    assert.equal(sleep.lexical_rank, null);
    assert.equal(sleep.semantic_rank, 1);
    // RRF-оценка совпадает с формулой k=60
    assert.ok(Math.abs(dose.score - (1 / 61 + 1 / (60 + dose.semantic_rank))) < 1e-12);
    assert.ok(Math.abs(sleep.score - 1 / 61) < 1e-12);
    assert.deepEqual(
      r.results.map((x) => x.score),
      [...r.results.map((x) => x.score)].sort((a, b) => b - a),
    );
    // без клиента
    const fb = await medSearch.searchText(pool, { query: 'нарушения сна', mode: 'hybrid' });
    assert.equal(fb.fallback, 'lexical');
    assert.equal(fb.available, true);
    assert.equal(fb.reason, 'embedding_client_unavailable');
    assert.deepEqual(fb.results.map((x) => x.id).sort(), ['D1-c1', 'D3-c1']);
    assert.ok(fb.results.every((x) => x.match_type === 'lexical'));
    // сбой клиента -> тоже lexical
    const bad = await medSearch.searchText(pool, {
      query: 'нарушения сна',
      mode: 'hybrid',
      client: fakeClient(table, { fail: true }),
    });
    assert.equal(bad.fallback, 'lexical');
    assert.equal(bad.reason, 'embedding_request_failed');
    // scope в hybrid
    const sc = await medSearch.searchText(pool, {
      query: 'дозы',
      mode: 'hybrid',
      client,
      scope: { documentIds: ['D2'] },
    });
    assert.ok(sc.results.every((x) => x.document_id === 'D2'));
  });

  await t.test('неполный индекс: semantic unavailable, hybrid -> lexical', async () => {
    // Область, где у всех чанков вектор есть, готова; область с чанком без вектора — нет.
    const client = fakeClient(table);
    const before = await medSearch.searchText(pool, {
      query: 'бессонница',
      mode: 'semantic',
      client,
      scope: { documentIds: ['D1'] },
    });
    assert.equal(before.available, true); // результат статуса попал в кэш
    await pool.query(`UPDATE med.chunks SET embedding = NULL, embedding_model = NULL WHERE id = 'D1-c3'`);
    try {
      const stale = await medSearch.searchText(pool, {
        query: 'бессонница',
        mode: 'semantic',
        client,
        scope: { documentIds: ['D1'] },
      });
      assert.equal(stale.available, true, 'статус эмбеддингов кэшируется на короткий TTL');
      rrf.clearEmbeddingStatusCache(); // как после импорта/embed в этом процессе
      const sem = await medSearch.searchText(pool, {
        query: 'бессонница',
        mode: 'semantic',
        client,
        scope: { documentIds: ['D1'] },
      });
      assert.equal(sem.available, false);
      assert.equal(sem.reason, 'embedding_index_incomplete');
      assert.equal(client.calls.length, 1); // только вызов до порчи индекса: при неполном индексе API не вызывается
      const hyb = await medSearch.searchText(pool, {
        query: 'нарушения сна',
        mode: 'hybrid',
        client,
        scope: { documentIds: ['D1'] },
      });
      assert.equal(hyb.fallback, 'lexical');
      assert.equal(hyb.results[0].id, 'D1-c1');
      // другая область полна
      assert.equal(
        (
          await medSearch.searchText(pool, {
            query: 'бессонница',
            mode: 'semantic',
            client,
            scope: { documentIds: ['D2'] },
          })
        ).available,
        true,
      );
    } finally {
      await pool.query(`UPDATE med.chunks SET embedding = $1::halfvec, embedding_model = $2 WHERE id = 'D1-c3'`, [
        lit(3, 3),
        MODEL,
      ]);
    }
  });

  await t.test('searchAdverseEffects: confirmed vs candidates, evidence, scope, context', async () => {
    const client = fakeClient(table);
    const exact = await medSearch.searchAdverseEffects(pool, { query: 'головная боль' });
    assert.deepEqual(
      exact.confirmed.results.map((e) => e.effect_id),
      ['E1'],
    );
    assert.equal(exact.confirmed.results[0].match_type, 'exact');
    assert.deepEqual(exact.confirmed_drug_ids.sort(), ['D1', 'D2']);
    const docs = exact.confirmed.results[0].drugs;
    assert.deepEqual(
      docs.map((d) => d.document_id),
      ['D1', 'D2'],
    );
    const ev = docs[0].evidence[0];
    assert.equal(ev.occurrence_id, 'L1');
    assert.deepEqual(ev.source, { file: 'D1.md', sha256: 'sha-D1' });
    assert.equal(ev.block.id, 'B1');
    assert.equal(ev.qualifier_blocks[0].id, 'B2');
    assert.equal(ev.source_mentions[0].start, 10);
    // alias
    const alias = await medSearch.searchAdverseEffects(pool, { query: 'Цефалгия' });
    assert.equal(alias.confirmed.results[0].match_type, 'alias');
    // «мигрень» не подтверждается через «головную боль»
    const mig = await medSearch.searchAdverseEffects(pool, { query: 'мигрень' });
    assert.equal(mig.confirmed.total, 0);
    assert.equal(mig.candidates.total, 0);
    assert.deepEqual(mig.semantic, { available: false, reason: 'semantic_not_requested' });
    const migSem = await medSearch.searchAdverseEffects(pool, { query: 'мигрень', semantic: true, client });
    assert.equal(migSem.confirmed.total, 0);
    assert.equal(migSem.candidates.results[0].effect_id, 'E1');
    assert.equal(migSem.candidates.results[0].match_type, 'semantic');
    assert.ok(migSem.candidates.results[0].semantic_score > 0.9);
    assert.equal(migSem.semantic.available, true);
    assert.equal(migSem.candidates.results[0].drugs.length, 2);
    // нечёткое (опечатка) — кандидат, не подтверждение
    const typo = await medSearch.searchAdverseEffects(pool, { query: 'тошнота', includeCandidates: true });
    assert.equal(typo.confirmed.total, 0); // E2 без связей: вне корпуса связей
    const fuzzy = await medSearch.searchAdverseEffects(pool, { query: 'головная бол' });
    assert.equal(fuzzy.confirmed.total, 0);
    assert.equal(fuzzy.candidates.results[0].match_type, 'fuzzy');
    assert.equal(
      (await medSearch.searchAdverseEffects(pool, { query: 'головная бол', includeCandidates: false })).candidates
        .total,
      0,
    );
    // scope и context
    const sc = await medSearch.searchAdverseEffects(pool, {
      query: 'головная боль',
      scope: { innNorm: 'амитриптилин' },
    });
    assert.deepEqual(sc.confirmed_drug_ids, ['D2']);
    assert.equal(sc.confirmed.results[0].drugs.length, 1);
    const ctx = await medSearch.searchAdverseEffects(pool, { query: 'головная боль', context: 'Отмена' });
    assert.deepEqual(ctx.confirmed_drug_ids, ['D2']);
    assert.equal(
      (await medSearch.searchAdverseEffects(pool, { query: 'головная боль', scope: { documentIds: ['D4'] } })).confirmed
        .total,
      0,
    );
    // semantic без клиента -> available:false, без ошибки
    const nc = await medSearch.searchAdverseEffects(pool, { query: 'мигрень', semantic: true });
    assert.equal(nc.semantic.available, false);
    assert.equal(nc.semantic.reason, 'embedding_client_unavailable');
  });

  await t.test('searchClinrec: self / parent (слияние) / window + required', async () => {
    // parent: два ребёнка одного родителя -> один результат с полным родителем
    const p = await clinSearch.searchClinrec(pool, 'критерии депрессии', { documentIds: ['R1'] });
    const parentHit = p.results.find((r) => r.expansion === 'parent');
    assert.ok(parentHit);
    assert.match(parentHit.context, /^ПОЛНЫЙ РОДИТЕЛЬ/);
    assert.equal(parentHit.parent_id, 'P1');
    assert.deepEqual(parentHit.matched_chunks.map((m) => m.chunk_id).sort(), ['k1', 'k2']);
    assert.equal(parentHit.document.title, 'Депрессия');
    assert.deepEqual(parentHit.heading_path, ['Диагностика']);
    assert.deepEqual(parentHit.span, { start: 0, end: 100 });
    assert.equal(p.results.filter((r) => r.expansion === 'parent').length, 1);
    assert.equal(p.source, 'clinrec');
    // self
    const s = await clinSearch.searchClinrec(pool, 'PHQ-9 самооценки', {});
    assert.equal(s.results[0].expansion, 'self');
    assert.equal(s.results[0].context, 'шкала PHQ-9 для самооценки');
    assert.equal(s.results[0].kind, 'method');
    // window: сосед до/после + required, порядок previous, match, next, required
    const w = await clinSearch.searchClinrec(pool, 'алгоритм лечения', {});
    const win = w.results[0];
    assert.equal(win.expansion, 'window');
    assert.deepEqual(
      win.parts.map((x) => [x.chunk_id, x.relation]),
      [
        ['k5', 'previous'],
        ['k4', 'match'],
        ['k6', 'next'],
        ['k7', 'required'],
      ],
    );
    assert.match(win.context, /подготовку[\s\S]*первый этап[\s\S]*контроль[\s\S]*приложение/);
    assert.deepEqual(win.always_include_spans, [{ start: 500, end: 520 }]);
    // expand:false отдаёт только чанк
    const raw = await clinSearch.searchClinrec(pool, 'критерии депрессии', { expand: false, documentIds: ['R1'] });
    assert.ok(raw.results.every((r) => r.expansion === 'none'));
    // kinds и documentIds, scope сервера
    const kinds = await clinSearch.searchClinrec(pool, 'абзац приложение алгоритму', { kinds: ['appendix'] });
    assert.deepEqual(
      kinds.results.map((r) => r.matched_chunks[0].chunk_id),
      ['k7'],
    );
    const onlyR2 = await clinSearch.searchClinrec(pool, 'критерии', { documentIds: ['R2'] });
    assert.deepEqual(
      onlyR2.results.map((r) => r.document.id),
      ['R2'],
    );
    const server = await clinSearch.searchClinrec(pool, 'критерии', {
      documentIds: ['R1', 'R2'],
      scope: { documentIds: ['R2'] },
    });
    assert.deepEqual(
      server.results.map((r) => r.document.id),
      ['R2'],
    );
    assert.equal(
      (await clinSearch.searchClinrec(pool, 'критерии', { documentIds: ['R1'], scope: { documentIds: ['R2'] } })).total,
      0,
    );
    await assert.rejects(clinSearch.searchClinrec(pool, 'x', { kinds: ['bogus'] }), { code: 'invalid_kinds' });
  });

  await t.test('searchClinrec semantic/hybrid + разворачивание после ранжирования', async () => {
    const client = fakeClient(table);
    const sem = await clinSearch.searchClinrec(pool, 'критерии депрессии', { mode: 'semantic', client });
    assert.equal(sem.available, false); // k9 без вектора: индекс неполный
    assert.equal(sem.reason, 'embedding_index_incomplete');
    const scoped = await clinSearch.searchClinrec(pool, 'критерии депрессии', {
      mode: 'semantic',
      client,
      kinds: ['method', 'appendix'],
    });
    assert.equal(scoped.available, true);
    await pool.query(`UPDATE clinrec.chunks SET embedding = $1::halfvec, embedding_model = $2 WHERE id = 'k9'`, [
      lit(40, 9),
      MODEL,
    ]);
    rrf.clearEmbeddingStatusCache();
    const full = await clinSearch.searchClinrec(pool, 'критерии депрессии', { mode: 'semantic', client });
    assert.equal(full.available, true);
    assert.equal(full.results[0].expansion, 'parent'); // k1/k2 на оси 20 -> родитель P1
    assert.deepEqual(full.results[0].matched_chunks.map((m) => m.chunk_id).slice(0, 2), ['k1', 'k2']);
    assert.equal(full.results[0].matched_chunks[0].semantic_rank, 1);
    const hyb = await clinSearch.searchClinrec(pool, 'критерии депрессии', { mode: 'hybrid', client });
    assert.equal(hyb.fallback, null);
    assert.equal(hyb.results[0].match_type, 'hybrid');
    const mc = hyb.results[0].matched_chunks[0];
    assert.ok(mc.lexical_rank >= 1 && mc.semantic_rank >= 1);
    const nofb = await clinSearch.searchClinrec(pool, 'критерии депрессии', { mode: 'hybrid' });
    assert.equal(nofb.fallback, 'lexical');
    assert.equal(nofb.results[0].match_type, 'lexical');
  });

  await t.test('getClinrecSection: поддерево, постранично; parentId; scope', async () => {
    const full = await clinSearch.getClinrecSection(pool, { documentId: 'R1', sectionId: 'R1-S1', maxChars: 100000 });
    assert.match(full.text, /ПОЛНЫЙ РОДИТЕЛЬ/);
    assert.match(full.text, /Родитель про шкалы/);
    assert.match(full.text, /шкала PHQ-9/); // самостоятельный чанк подраздела
    assert.ok(full.text.indexOf('ПОЛНЫЙ') < full.text.indexOf('Родитель про шкалы'));
    assert.equal(full.hasMore, false);
    let text = '';
    let cursor = 0;
    for (;;) {
      const p = await clinSearch.getClinrecSection(pool, {
        documentId: 'R1',
        sectionId: 'R1-S1',
        cursor,
        maxChars: 23,
      });
      text += p.text;
      if (!p.hasMore) break;
      cursor = p.nextCursor;
    }
    assert.equal(text, full.text);
    const one = await clinSearch.getClinrecSection(pool, { documentId: 'R1', parentId: 'P2' });
    assert.equal(one.text, 'Родитель про шкалы.');
    await assert.rejects(clinSearch.getClinrecSection(pool, { documentId: 'R1', sectionId: 'nope' }), {
      code: 'section_not_found',
    });
    await assert.rejects(
      clinSearch.getClinrecSection(pool, { documentId: 'R1', sectionId: 'R1-S1', scope: { documentIds: ['R2'] } }),
      {
        code: 'document_not_found',
      },
    );
  });

  await t.test('HNSW + фильтр с малой долей строк: iterative scan не теряет результаты', async () => {
    // 2400 фоновых фрагментов в 40 документах: ось (d*7+i)%50, т.е. вектора каждого документа разбросаны по 50
    // кластерам. Запрос — ось 3. Фильтр по одному документу (2.5% строк): HNSW с ef_search=40 даёт ~48 ближайших
    // чужих строк, в нужном документе остаётся 1–2. Плюс 30 «изолированных» фрагментов TARGET (ось 60) —
    // худший случай для графа HNSW.
    await pool.query('DROP INDEX med.chunks_embedding');
    const rowVec = (axis) =>
      `(SELECT ('[' || string_agg(CASE WHEN g = ${axis} THEN '1' ELSE round(((hashtext(i::text || ':' || g::text)::float8 / 2147483648.0) * 0.001)::numeric, 6)::text END, ',' ORDER BY g) || ']')::halfvec FROM generate_series(0, ${DIM - 1}) g)`;
    await pool.query(
      `INSERT INTO med.documents (id, drug_label, inn, source_file, sha256, markdown)
       SELECT 'BIG' || d, 'Большой ' || d, 'большой', 'big' || d || '.md', 'x', 'x' FROM generate_series(1, 40) d`,
    );
    await pool.query(
      `INSERT INTO med.documents (id, drug_label, inn, source_file, sha256, markdown) VALUES ('TARGET','Цель','цель','t.md','x','x')`,
    );
    await pool.query(`INSERT INTO med.sections (id, document_id, level, ord, title, path, start_char, end_char, start_line)
       SELECT 'S-' || id, id, 1, 1, 't', 't', 0, 1, 1 FROM med.documents WHERE id LIKE 'BIG%' OR id = 'TARGET'`);
    await pool.query(
      `INSERT INTO med.chunks (id, document_id, section_id, ord, text, content_hash, start_char, end_char, embedding, embedding_model)
       SELECT 'bc' || d || '_' || i, 'BIG' || d, 'S-BIG' || d, i, 'фон ' || d || ' ' || i, 'h', 0, 1, ${rowVec('((d * 7 + i) % 50)')}, '${MODEL}'
       FROM generate_series(1, 40) d, generate_series(1, 60) i`,
    );
    await pool.query(
      `INSERT INTO med.chunks (id, document_id, section_id, ord, text, content_hash, start_char, end_char, embedding, embedding_model)
       SELECT 'tc' || i, 'TARGET', 'S-TARGET', i, 'цель ' || i, 'h', 0, 1, ${rowVec(60)}, '${MODEL}'
       FROM generate_series(1, 30) i`,
    );
    await pool.query(`CREATE INDEX chunks_embedding ON med.chunks USING hnsw (embedding halfvec_cosine_ops)`);
    await pool.query('ANALYZE med.chunks');
    const forced = await mkPool({ options: '-c enable_sort=off -c enable_seqscan=off -c enable_bitmapscan=off' });
    const client = fakeClient({ фон: 3, цель: 60 });
    const query = lit(3, 7);
    const scope = { documentIds: ['BIG7'] };

    // 1. Контроль: сырой HNSW без итеративного скана теряет результаты, с ним — нет (тот же запрос и фильтр).
    const c = await forced.connect();
    try {
      await c.query('BEGIN');
      const sql = `SELECT id FROM med.chunks WHERE embedding IS NOT NULL AND embedding_model = $2 AND document_id = ANY($3::text[])
                   ORDER BY embedding <=> $1::halfvec LIMIT 20`;
      await c.query('SET LOCAL hnsw.iterative_scan = off');
      await c.query('SET LOCAL hnsw.ef_search = 40');
      const raw = await c.query(sql, [query, MODEL, ['BIG7']]);
      const plan = (await c.query(`EXPLAIN ${sql}`, [query, MODEL, ['BIG7']])).rows
        .map((r) => r['QUERY PLAN'])
        .join('\n');
      assert.match(plan, /chunks_embedding/, 'контрольный запрос должен идти через HNSW');
      assert.ok(raw.rows.length < 20, `без iterative_scan ожидалась потеря строк, получено ${raw.rows.length}`);
      await c.query('SET LOCAL hnsw.iterative_scan = relaxed_order');
      await c.query('SET LOCAL hnsw.max_scan_tuples = 300000');
      assert.equal((await c.query(sql, [query, MODEL, ['BIG7']])).rows.length, 20);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }

    // 2. Наша функция при том же планировщике: полный ответ через итеративный HNSW.
    const r = await medSearch.searchText(forced, { query: 'фон', mode: 'semantic', client, limit: 20, scope });
    assert.equal(r.available, true);
    assert.equal(r.results.length, 20);
    assert.ok(r.results.every((x) => x.document_id === 'BIG7'));
    assert.equal(r.vector_scan, 'hnsw-iterative');
    assert.equal(r.hasMore, true);
    const b = await medSearch.searchText(forced, {
      query: 'фон',
      mode: 'semantic',
      client,
      limit: 20,
      offset: 20,
      scope,
    });
    assert.equal(b.results.length, 20);
    assert.equal(new Set([...r.results, ...b.results].map((x) => x.id)).size, 40);
    // 3. Запасной путь (pgvector < 0.8 — итеративного скана нет): точный проход возвращает то же самое множество.
    const old = {
      query: (sql, p) =>
        /extversion/.test(sql) ? Promise.resolve({ rows: [{ extversion: '0.7.4' }] }) : forced.query(sql, p),
      connect: () => forced.connect(),
    };
    const fb = await medSearch.searchText(old, { query: 'фон', mode: 'semantic', client, limit: 20, scope });
    assert.equal(fb.results.length, 20);
    assert.equal(fb.vector_scan, 'exact');
    assert.ok(fb.results.every((x) => x.document_id === 'BIG7'));
    const overlap = fb.results.filter((x) => r.results.some((y) => y.id === x.id)).length;
    assert.ok(overlap >= 19, `итеративный HNSW совпал с точным на ${overlap}/20`);
    // 4. Обычный планировщик (btree по document_id) — тот же результат, что и точный.
    const plain = await medSearch.searchText(pool, { query: 'фон', mode: 'semantic', client, limit: 20, scope });
    assert.deepEqual(
      plain.results.map((x) => x.id),
      fb.results.map((x) => x.id),
    );
    // 5. Изолированный кластер (худший случай для графа): всё равно все 20/30 строк области, при необходимости
    //    через точный запасной проход.
    const iso = await medSearch.searchText(forced, {
      query: 'цель',
      mode: 'semantic',
      client,
      limit: 30,
      scope: { documentIds: ['TARGET'] },
    });
    assert.equal(iso.results.length, 30);
    assert.ok(iso.results.every((x) => x.document_id === 'TARGET'));
    assert.ok(['hnsw-iterative', 'exact'].includes(iso.vector_scan));
    // 5b. Тот же изолированный кластер, но запрос далеко от него (ось 3): итеративный скан может его не достичь —
    //     запасной точный проход обязан вернуть все 30 строк области.
    const far = await medSearch.searchText(forced, {
      query: 'фон',
      mode: 'semantic',
      client,
      limit: 30,
      scope: { documentIds: ['TARGET'] },
    });
    assert.equal(far.results.length, 30);
    assert.ok(far.results.every((x) => x.document_id === 'TARGET'));
    t.diagnostic(`far scan=${far.vector_scan}`);
    // 6. hybrid с областью.
    const h = await medSearch.searchText(forced, {
      query: 'цель',
      mode: 'hybrid',
      client,
      limit: 10,
      scope: { documentIds: ['TARGET'] },
    });
    assert.ok(h.results.length === 10 && h.results.every((x) => x.document_id === 'TARGET'));
    // 7. Клинреки: тот же код для clinrec.chunks (проверка фильтров уже выше); здесь — область без векторов даёт available:true/пусто.
    const empty = await medSearch.searchText(forced, {
      query: 'фон',
      mode: 'semantic',
      client,
      scope: { documentIds: [] },
    });
    assert.equal(empty.total, 0);
    t.diagnostic(`iso scan=${iso.vector_scan}`);
  });

  await t.test('инструменты: схемы без scope, валидация, контракт SQLite, лимит ответа', async () => {
    const tools = createKnowledgeTools({ pool, embeddingClient: fakeClient(table), scope: { innNorm: 'сертралин' } });
    assert.equal(tools.definitions, toolDefinitions);
    const names = tools.definitions.map((d) => d.name);
    for (const n of [
      'searchDrugs',
      'getToc',
      'readSection',
      'searchText',
      'searchAdverseEffects',
      'status',
      'searchClinrec',
      'getClinrecSection',
    ])
      assert.ok(names.includes(n), n);
    for (const d of tools.definitions) {
      assert.equal(d.inputSchema.additionalProperties, false);
      assert.ok(!('scope' in d.inputSchema.properties), `${d.name}: scope не должен быть в схеме для модели`);
      assert.ok(!JSON.stringify(d).includes('innNorm'));
    }
    // scope в аргументах отвергается
    await assert.rejects(tools.dispatch('searchText', { publicReferenceTerm: 'сон', scope: { innNorm: 'кетамин' } }), {
      code: 'invalid_tool_arguments',
    });
    await assert.rejects(tools.dispatch('nope', {}), { code: 'unknown_tool' });
    await assert.rejects(tools.dispatch('searchText', {}), { code: 'invalid_tool_arguments' });
    await assert.rejects(tools.dispatch('searchText', { publicReferenceTerm: 'x', mode: 'bad' }), {
      code: 'invalid_tool_arguments',
    });
    // сервер ограничил область сертралином
    const amit = await tools.dispatch('searchDrugs', { publicReferenceTerm: 'амитриптилин' });
    assert.equal(amit.total, 0);
    assert.equal(amit.source, 'medication_instructions');
    const sleep = await tools.dispatch('searchText', { publicReferenceTerm: 'бессонница', mode: 'hybrid' });
    assert.ok(sleep.results.every((x) => ['D1', 'D3'].includes(x.document_id)));
    await assert.rejects(tools.dispatch('getToc', { documentId: 'D2' }), { code: 'document_not_found' });
    const wide = await tools.dispatch('searchText', { publicReferenceTerm: 'нарушения сна', drugIds: ['D2', 'D1'] });
    assert.deepEqual(
      wide.results.map((x) => x.document_id),
      ['D1'],
    );
    // методы-обёртки
    assert.equal((await tools.searchDrugs({ publicReferenceTerm: 'золофт' })).total, 1);
    // readSection через инструмент: порции не усечены, nextCursor ведёт дальше
    const sec = await tools.dispatch('readSection', { documentId: 'D1', sectionId: 'D1-S1', maxChars: 30 });
    assert.equal(sec.text.length, 30);
    assert.equal(sec.hasMore, true);
    const st = await tools.dispatch('status', {});
    assert.ok(st.documents >= 4 && st.scope_restricted === true);
    // клинреки через инструмент
    const cr = await tools.dispatch('searchClinrec', { publicReferenceTerm: 'алгоритм лечения', mode: 'hybrid' });
    assert.equal(cr.results[0].expansion, 'window');
    assert.equal(cr.source, 'clinrec');
    const csec = await tools.dispatch('getClinrecSection', { documentId: 'R1', sectionId: 'R1-S2' });
    assert.match(csec.text, /Родитель про шкалы/);
    // лимит размера ответа: результаты усекаются с конца, не тексты
    const tiny = createKnowledgeTools({ pool, maxResponseChars: 2500 });
    const big = await tiny.dispatch('searchText', {
      publicReferenceTerm: 'нарушения сна дозы бессонница сонливость головная',
      limit: 50,
    });
    assert.ok(JSON.stringify(big).length <= 2500 + 400);
    assert.equal(big.truncated, true);
    assert.equal(big.hasMore, true);
    assert.ok(big.results.length >= 1);
  });

  await t.test('контракт SQLite-версии: те же имена/схемы инструментов и ключи ответов', async (st) => {
    const sqliteTools = require('../../src/modules/medication_knowledge/tools');
    const sqliteDefs = new Map(sqliteTools.toolDefinitions.map((d) => [d.name, d]));
    const mine = new Map(toolDefinitions.map((d) => [d.name, d]));
    for (const [name, def] of sqliteDefs) {
      assert.ok(mine.has(name), `нет инструмента ${name}`);
      if (name === 'status') continue; // описание отличается намеренно
      assert.deepEqual(mine.get(name).inputSchema, def.inputSchema, `схема ${name}`);
    }
    // Ответы: ключи конверта и результатов — надмножество общего ядра SQLite-версии на реальном корпусе.
    const { DEFAULT_SOURCE_DIR } = require('../../src/modules/medication_knowledge/corpus');
    if (!fs.existsSync(DEFAULT_SOURCE_DIR)) return st.skip('нет исходных инструкций для сравнения с SQLite');
    const store = require('../../src/modules/medication_knowledge/store');
    const sqliteSearch = require('../../src/modules/medication_knowledge/search');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-contract-'));
    const db = store.openKnowledgeStore({ filename: path.join(dir, 'k.sqlite3') });
    try {
      store.importCorpus(db);
      const keys = (o) => Object.keys(o);
      const covers = (mineObj, sqliteObj, ignore = []) => {
        for (const k of keys(sqliteObj)) if (!ignore.includes(k)) assert.ok(k in mineObj, `в ответе нет ключа ${k}`);
      };
      const sd = sqliteSearch.searchDrugs(db, { query: 'авианр' });
      assert.ok(sd.results.length > 0);
      const md = await medSearch.searchDrugs(pool, { query: 'золоф' });
      assert.ok(md.results.length > 0);
      covers(md, sd);
      covers(md.results[0], sd.results[0]);
      assert.equal(md.results[0].match_type, sd.results[0].match_type); // оба fuzzy
      const sx = await sqliteSearch.searchText(db, { query: 'доза' });
      assert.ok(sx.results.length > 0);
      const mx = await medSearch.searchText(pool, { query: 'доза' });
      assert.ok(mx.results.length > 0);
      covers(mx, sx);
      const core = ['generation', 'content_hash', 'line_start', 'line_end', 'page_start', 'page_end'];
      covers(mx.results[0], sx.results[0], core);
      const firstDoc = store.listDocuments(db)[0];
      const stoc = sqliteSearch.getToc(db, { documentId: firstDoc.id });
      const mtoc = await medSearch.getToc(pool, { documentId: 'D1' });
      covers(mtoc, stoc);
      covers(mtoc.document, stoc.document);
      const sr = sqliteSearch.readSection(db, {
        documentId: firstDoc.id,
        sectionId: stoc.sections[0].id,
        maxChars: 50,
      });
      const mr = await medSearch.readSection(pool, { documentId: 'D1', sectionId: 'D1-S1', maxChars: 50 });
      covers(
        mr,
        sr,
        [
          'generation',
          'start_offset',
          'end_offset',
          'line_end',
          'page_end',
          'parent_id',
          'line_start',
          'page_start',
        ].filter((k) => !(k in mr)),
      );
      const sa = await sqliteSearch.searchAdverseEffects(db, { query: 'головная боль' });
      assert.ok(sa.confirmed.results.length > 0 && sa.confirmed.results[0].drugs.length > 0);
      const ma = await medSearch.searchAdverseEffects(pool, { query: 'головная боль' });
      covers(ma, sa);
      covers(ma.confirmed, sa.confirmed);
      covers(ma.confirmed.results[0], sa.confirmed.results[0]);
      covers(ma.confirmed.results[0].drugs[0], sa.confirmed.results[0].drugs[0]);
      covers(ma.confirmed.results[0].drugs[0].evidence[0], {
        occurrence_id: 1,
        effect_id: 1,
        block_id: 1,
        source: 1,
        block: 1,
        qualifier_blocks: 1,
        source_mentions: 1,
        review_required: 1,
      });
      // семантика поведения: «мигрень» не подтверждается через «головную боль» в обеих реализациях
      assert.equal((await sqliteSearch.searchAdverseEffects(db, { query: 'мигрень' })).confirmed.total, 0);
      assert.equal((await medSearch.searchAdverseEffects(pool, { query: 'мигрень' })).confirmed.total, 0);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
