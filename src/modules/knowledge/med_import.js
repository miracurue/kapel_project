'use strict';

// Одноразовый перенос базы лекарств SQLite (medication_knowledge) -> Postgres (схема med).
// Векторы переносятся как есть (Float32 LE -> halfvec), GigaChat не вызывается.
// Замена данных идёт одной транзакцией: повторный запуск даёт то же состояние.
const crypto = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');
const { toVectorLiteral, withTransaction } = require('./pg');

const DEFAULT_SQLITE = path.resolve(__dirname, '../../../data/medication_knowledge.sqlite3');
const DIM = 2560;
const EXPECTED = {
  documents: 12,
  sections: 1278,
  chunks: 363,
  effects: 365,
  effect_aliases: 707,
  effect_links: 1651,
  blocks: 487,
  source_mentions: 1723,
  vectors: 728,
};

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// Нормализованное МНН: нижний регистр, ё -> е, схлопнутые пробелы.
function normalizeInn(value) {
  return String(value).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function openSource(file = DEFAULT_SQLITE) {
  return new Database(file, { readonly: true, fileMustExist: true });
}

function activeGeneration(db) {
  const row = db.prepare("SELECT value FROM knowledge_meta WHERE key='active_generation'").get();
  if (!row) throw new Error('active_generation is not set in the SQLite source');
  return row.value;
}

function blobToFloat32(blob) {
  const copy = Buffer.from(blob); // выровненная копия
  return new Float32Array(copy.buffer, copy.byteOffset, copy.length / 4);
}

// Читает активное поколение целиком и строит строки для PG.
function readSource(db) {
  const generation = activeGeneration(db);
  const all = (sql) => db.prepare(sql).all(generation);
  const documents = all('SELECT * FROM documents WHERE generation=? ORDER BY id');
  const sections = all('SELECT * FROM sections WHERE generation=? ORDER BY document_id,start_offset,level,id');
  const chunks = all('SELECT * FROM chunks WHERE generation=? ORDER BY document_id,ordinal');
  const effects = all('SELECT * FROM effects WHERE generation=? ORDER BY id');
  const aliases = all('SELECT * FROM effect_aliases WHERE generation=? ORDER BY effect_id,alias');
  const blocks = all('SELECT * FROM blocks WHERE generation=? ORDER BY id');
  const mentions = all('SELECT * FROM source_mentions WHERE generation=? ORDER BY id');
  const links = all('SELECT * FROM effect_links WHERE generation=? ORDER BY id');
  const embeddings = all('SELECT * FROM embeddings WHERE generation=? ORDER BY entity_type,entity_id');
  const meta = db.prepare('SELECT registry_hash FROM generations WHERE id=?').get(generation);

  // ord и path для разделов: порядок в документе и цепочка заголовков.
  const byId = new Map(sections.map((s) => [s.id, s]));
  const ordInDoc = new Map();
  const pathOf = (s) => {
    const parts = [];
    for (let cur = s, n = 0; cur && n < 64; cur = cur.parent_id ? byId.get(cur.parent_id) : null, n++)
      parts.unshift(cur.title);
    return parts.join(' / ');
  };
  for (const s of sections) {
    const ord = ordInDoc.get(s.document_id) || 0;
    s.ord = ord;
    ordInDoc.set(s.document_id, ord + 1);
    s.path = pathOf(s);
  }
  return {
    generation,
    registryHash: meta.registry_hash,
    documents,
    sections,
    chunks,
    effects,
    aliases,
    blocks,
    mentions,
    links,
    embeddings,
  };
}

// Сверка вектора с текстом, по которому он считался (см. index_embeddings.entities).
function effectText(effect) {
  return [effect.name, ...JSON.parse(effect.raw_json).aliases].join('\n');
}

// Сортирует документы по порядку внешних ключей: sections с родителями раньше детей.
function sectionsInInsertOrder(sections) {
  const done = new Set();
  const out = [];
  let pending = sections.slice();
  while (pending.length) {
    const next = [];
    for (const s of pending) {
      if (!s.parent_id || done.has(s.parent_id)) {
        out.push(s);
        done.add(s.id);
      } else next.push(s);
    }
    if (next.length === pending.length) throw new Error('section parent cycle or missing parent');
    pending = next;
  }
  return out;
}

async function insertMany(client, table, columns, rows, mapRow, batch = 200) {
  for (let i = 0; i < rows.length; i += batch) {
    const part = rows.slice(i, i + batch);
    const params = [];
    const tuples = part.map((row) => {
      const values = mapRow(row);
      return `(${values
        .map((v) => {
          params.push(v);
          return `$${params.length}`;
        })
        .join(',')})`;
    });
    await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`, params);
  }
}

async function importMed(pool, { sqlitePath = DEFAULT_SQLITE } = {}) {
  const db = openSource(sqlitePath);
  let src;
  try {
    src = readSource(db);
  } finally {
    db.close();
  }
  const stale = [];
  const undetermined = [];
  const warnings = [];

  const docIds = new Set(src.documents.map((d) => d.id));
  const chunkById = new Map(src.chunks.map((c) => [c.id, c]));
  const effectById = new Map(src.effects.map((e) => [e.id, e]));
  const vectors = { chunk: new Map(), effect: new Map() };
  for (const e of src.embeddings) {
    if (e.dimensions !== DIM || e.vector.length !== DIM * 4)
      throw new Error(`bad vector size for ${e.entity_type}:${e.entity_id}`);
    const entity = e.entity_type === 'chunk' ? chunkById.get(e.entity_id) : effectById.get(e.entity_id);
    if (!entity) throw new Error(`vector for unknown ${e.entity_type}:${e.entity_id}`);
    const expectedHash = e.entity_type === 'chunk' ? entity.content_hash : sha256(effectText(entity));
    if (e.content_hash !== expectedHash) {
      stale.push({ type: e.entity_type, id: e.entity_id, stored: e.content_hash, expected: expectedHash });
      continue; // устаревший вектор не переносим, пересчёт отдельной задачей
    }
    vectors[e.entity_type].set(e.entity_id, e);
  }

  const drugMap = [];
  for (const d of src.documents) {
    const norm = normalizeInn(d.inn);
    if (!norm) undetermined.push({ document_id: d.id, label: d.label, file: d.file, reason: 'empty inn' });
    else drugMap.push([norm, d.id]);
  }

  const counts = await withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [7_353_100_002]);
    // Полная замена: каскад чистит разделы, чанки, блоки, связи, упоминания, drug_map.
    await client.query('DELETE FROM med.documents');
    await client.query('DELETE FROM med.effects');

    await insertMany(
      client,
      'med.documents',
      ['id', 'drug_label', 'inn', 'trade_name', 'source_file', 'sha256', 'markdown'],
      src.documents,
      (d) => [d.id, d.label, d.inn, null, d.file, d.sha256, d.content],
    );
    const ordered = sectionsInInsertOrder(src.sections);
    await insertMany(
      client,
      'med.sections',
      [
        'id',
        'document_id',
        'parent_id',
        'level',
        'ord',
        'title',
        'path',
        'start_char',
        'end_char',
        'start_line',
        'page',
      ],
      ordered,
      (s) => [
        s.id,
        s.document_id,
        s.parent_id,
        s.level,
        s.ord,
        s.title,
        s.path,
        s.start_offset,
        s.end_offset,
        s.line_start,
        s.page_start,
      ],
    );
    await insertMany(
      client,
      'med.chunks',
      [
        'id',
        'document_id',
        'section_id',
        'section_ids',
        'ord',
        'text',
        'oversized',
        'content_hash',
        'start_char',
        'end_char',
      ],
      src.chunks,
      (c) => [
        c.id,
        c.document_id,
        c.section_id,
        JSON.parse(c.section_ids),
        c.ordinal,
        c.content,
        c.oversize === 1,
        c.content_hash,
        c.start_offset,
        c.end_offset,
      ],
    );
    await insertMany(client, 'med.effects', ['id', 'name', 'category', 'status', 'raw_json'], src.effects, (e) => [
      e.id,
      e.name,
      e.category,
      e.status,
      e.raw_json,
    ]);
    await insertMany(client, 'med.effect_aliases', ['effect_id', 'alias', 'normalized'], src.aliases, (a) => [
      a.effect_id,
      a.alias,
      a.normalized,
    ]);
    await insertMany(client, 'med.blocks', ['id', 'document_id', 'raw_json'], src.blocks, (b) => [
      b.id,
      b.document_id,
      b.raw_json,
    ]);
    await insertMany(client, 'med.source_mentions', ['id', 'document_id', 'raw_json'], src.mentions, (m) => [
      m.id,
      m.document_id,
      m.raw_json,
    ]);
    await insertMany(
      client,
      'med.effect_links',
      ['id', 'effect_id', 'document_id', 'block_id', 'frequency', 'context', 'raw_term', 'raw_json'],
      src.links,
      (l) => [l.id, l.effect_id, l.document_id, l.block_id, l.frequency, l.context, l.raw_term, l.raw_json],
    );
    await insertMany(client, 'med.drug_map', ['inn_name_norm', 'document_id'], drugMap, (r) => r);

    let vectorCount = 0;
    for (const [type, table] of [
      ['chunk', 'med.chunks'],
      ['effect', 'med.effects'],
    ]) {
      for (const [id, e] of vectors[type]) {
        await client.query(
          `UPDATE ${table} SET embedding=$2::halfvec, embedding_model=$3, embedding_hash=$4 WHERE id=$1`,
          [id, toVectorLiteral(blobToFloat32(e.vector)), e.model, e.content_hash],
        );
        vectorCount++;
      }
    }
    for (const [key, value] of [
      ['med_source_generation', src.generation],
      ['med_registry_hash', src.registryHash],
      ['med_embedding_model', [...new Set(src.embeddings.map((e) => e.model))].join(',')],
    ]) {
      await client.query(
        `INSERT INTO public.knowledge_meta (key, value) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
        [key, value],
      );
    }
    return {
      documents: src.documents.length,
      sections: src.sections.length,
      chunks: src.chunks.length,
      effects: src.effects.length,
      effect_aliases: src.aliases.length,
      effect_links: src.links.length,
      blocks: src.blocks.length,
      source_mentions: src.mentions.length,
      vectors: vectorCount,
    };
  });
  void docIds;
  if (stale.length) warnings.push(`${stale.length} vectors are stale and were not imported`);
  return {
    source_generation: src.generation,
    counts,
    stale_vectors: stale,
    undetermined_inn: undetermined,
    drug_map: drugMap.map(([inn, document_id]) => ({ inn, document_id })),
    warnings,
  };
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

function parseVectorText(text) {
  return Float32Array.from(text.slice(1, -1).split(',').map(Number));
}

async function verifyMed(
  pool,
  { sqlitePath = DEFAULT_SQLITE, expected = EXPECTED, sample = 20, minCosine = 0.9999 } = {},
) {
  const db = openSource(sqlitePath);
  const checks = [];
  const add = (name, ok, details) =>
    checks.push({ name, ok: Boolean(ok), ...(details === undefined ? {} : { details }) });
  try {
    const generation = activeGeneration(db);
    const one = async (sql, params) => (await pool.query(sql, params)).rows;

    // 1. Счётчики PG против ожидаемых и против SQLite.
    const pgCounts = {};
    for (const t of [
      'documents',
      'sections',
      'chunks',
      'effects',
      'effect_aliases',
      'effect_links',
      'blocks',
      'source_mentions',
    ]) {
      pgCounts[t] = (await one(`SELECT count(*)::int AS n FROM med.${t}`))[0].n;
    }
    pgCounts.vectors =
      (
        await one(
          `SELECT (SELECT count(*) FROM med.chunks WHERE embedding IS NOT NULL) + (SELECT count(*) FROM med.effects WHERE embedding IS NOT NULL) AS n`,
        )
      )[0].n * 1;
    const srcCounts = {};
    for (const t of [
      'documents',
      'sections',
      'chunks',
      'effects',
      'effect_aliases',
      'effect_links',
      'blocks',
      'source_mentions',
      'embeddings',
    ]) {
      srcCounts[t === 'embeddings' ? 'vectors' : t] = db
        .prepare(`SELECT count(*) AS n FROM ${t} WHERE generation=?`)
        .get(generation).n;
    }
    add(
      'counts_expected',
      Object.keys(expected).every((k) => Number(pgCounts[k]) === expected[k]),
      { pg: pgCounts, expected },
    );
    add(
      'counts_match_sqlite',
      Object.keys(srcCounts).every((k) => Number(pgCounts[k]) === srcCounts[k]),
      { sqlite: srcCounts },
    );

    // 2. ID совпадают как множества.
    for (const t of ['documents', 'sections', 'chunks', 'effects', 'blocks', 'source_mentions', 'effect_links']) {
      const a = (await one(`SELECT id FROM med.${t} ORDER BY id`)).map((r) => r.id);
      const b = db
        .prepare(`SELECT id FROM ${t} WHERE generation=? ORDER BY id`)
        .all(generation)
        .map((r) => r.id);
      add(`ids_${t}`, a.length === b.length && a.every((x, i) => x === b[i]));
    }

    // 3. Markdown побайтно и sha256.
    const pgDocs = await one('SELECT id, markdown, sha256 FROM med.documents ORDER BY id');
    const srcDocs = new Map(
      db
        .prepare('SELECT id, inn, content, sha256 FROM documents WHERE generation=?')
        .all(generation)
        .map((d) => [d.id, d]),
    );
    const mdBad = pgDocs.filter(
      (d) =>
        !srcDocs.has(d.id) || !Buffer.from(d.markdown, 'utf8').equals(Buffer.from(srcDocs.get(d.id).content, 'utf8')),
    );
    add('markdown_bytes_equal', mdBad.length === 0 && pgDocs.length > 0, { mismatched: mdBad.map((d) => d.id) });
    const shaBad = pgDocs.filter((d) => d.sha256 !== srcDocs.get(d.id)?.sha256);
    add('sha256_equals_source', shaBad.length === 0, { mismatched: shaBad.map((d) => d.id) });
    const shaOfMd = pgDocs.filter((d) => sha256(Buffer.from(d.markdown, 'utf8')) !== d.sha256);
    add('sha256_equals_hash_of_markdown', shaOfMd.length === 0, { mismatched: shaOfMd.map((d) => d.id) });

    // 4. Срезы чанков по start/end.
    const mdById = new Map(pgDocs.map((d) => [d.id, d.markdown]));
    const pgChunks = await one('SELECT id, document_id, text, start_char, end_char, content_hash FROM med.chunks');
    const sliceBad = pgChunks.filter((c) => mdById.get(c.document_id).slice(c.start_char, c.end_char) !== c.text);
    add('chunk_slices_equal', sliceBad.length === 0 && pgChunks.length > 0, {
      count: sliceBad.length,
      mismatched: sliceBad.slice(0, 10).map((c) => c.id),
    });
    const hashBad = pgChunks.filter((c) => sha256(c.text) !== c.content_hash);
    add('chunk_content_hash_is_sha256_of_text', hashBad.length === 0, {
      count: hashBad.length,
      mismatched: hashBad.slice(0, 10).map((c) => c.id),
    });

    // 5. Векторы: хэш и косинус.
    const srcVec = db
      .prepare('SELECT entity_type, entity_id, model, content_hash, vector FROM embeddings WHERE generation=?')
      .all(generation);
    const pgHash = new Map();
    for (const r of await one(
      'SELECT id, embedding_model AS m, embedding_hash AS h, (embedding IS NOT NULL) AS has FROM med.chunks',
    ))
      pgHash.set(`chunk:${r.id}`, r);
    for (const r of await one(
      'SELECT id, embedding_model AS m, embedding_hash AS h, (embedding IS NOT NULL) AS has FROM med.effects',
    ))
      pgHash.set(`effect:${r.id}`, r);
    const hashMis = srcVec.filter((v) => {
      const r = pgHash.get(`${v.entity_type}:${v.entity_id}`);
      return !r || !r.has || r.h !== v.content_hash || r.m !== v.model;
    });
    add('embedding_model_hash_match_source', hashMis.length === 0, {
      mismatched: hashMis.slice(0, 10).map((v) => `${v.entity_type}:${v.entity_id}`),
    });
    const chunkHashMis = pgChunks.filter(
      (c) => pgHash.get(`chunk:${c.id}`)?.has && pgHash.get(`chunk:${c.id}`).h !== c.content_hash,
    );
    add('chunk_embedding_hash_equals_content_hash', chunkHashMis.length === 0, {
      stale: chunkHashMis.map((c) => c.id),
    });
    const effRows = await one('SELECT id, raw_json, name FROM med.effects');
    const effStale = effRows.filter(
      (e) =>
        pgHash.get(`effect:${e.id}`)?.has &&
        pgHash.get(`effect:${e.id}`).h !== sha256([e.name, ...e.raw_json.aliases].join('\n')),
    );
    add('effect_embedding_hash_equals_text_hash', effStale.length === 0, { stale: effStale.map((e) => e.id) });

    const pick = srcVec.slice();
    for (let i = pick.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pick[i], pick[j]] = [pick[j], pick[i]];
    }
    const cos = [];
    let staleCount = 0;
    for (const v of pick) {
      if (cos.length >= sample) break;
      const table = v.entity_type === 'chunk' ? 'med.chunks' : 'med.effects';
      const [row] = await one(`SELECT embedding::text AS t FROM ${table} WHERE id=$1`, [v.entity_id]);
      // Устаревший вектор при импорте не переносится (embedding IS NULL): в выборку косинуса он не входит.
      if (!row || row.t === null) {
        staleCount++;
        continue;
      }
      cos.push({
        id: `${v.entity_type}:${v.entity_id}`,
        cosine: cosine(blobToFloat32(v.vector), parseVectorText(row.t)),
      });
    }
    const minSeen = cos.length ? Math.min(...cos.map((c) => c.cosine ?? 0)) : null;
    add(
      'vector_cosine_sample',
      cos.length > 0 && (cos.length === sample || cos.length >= srcVec.length - staleCount) && minSeen >= minCosine,
      { sampled: cos.length, min: minSeen, threshold: minCosine },
    );

    // 6. HNSW в плане ближайших соседей.
    const [probe] = await one('SELECT embedding::text AS t FROM med.chunks WHERE embedding IS NOT NULL LIMIT 1');
    const planFor = async (seqscanOff) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (seqscanOff) await client.query('SET LOCAL enable_seqscan = off');
        const { rows } = await client.query(
          `EXPLAIN SELECT id FROM med.chunks ORDER BY embedding <=> '${probe.t}'::halfvec LIMIT 5`,
        );
        await client.query('ROLLBACK');
        return rows.map((r) => r['QUERY PLAN']);
      } finally {
        client.release();
      }
    };
    if (probe) {
      const forced = await planFor(true);
      const normal = await planFor(false);
      add(
        'hnsw_in_plan_seqscan_off',
        forced.some((l) => /chunks_embedding/.test(l)),
        forced.slice(0, 4).map((l) => l.slice(0, 110)),
      );
      checks.push({
        name: 'hnsw_in_plan_default_info',
        ok: true,
        uses_hnsw: normal.some((l) => /chunks_embedding/.test(l)),
        details: normal.slice(0, 4).map((l) => l.slice(0, 110)),
      });
    } else add('hnsw_in_plan_seqscan_off', false, 'no vectors');

    // 7. drug_map.
    const map = await one('SELECT inn_name_norm, document_id FROM med.drug_map ORDER BY document_id');
    add(
      'drug_map_covers_all_documents',
      map.length === pgDocs.length &&
        pgDocs.every((d) =>
          map.some((m) => m.document_id === d.id && m.inn_name_norm === normalizeInn(srcDocs.get(d.id).inn)),
        ),
      map,
    );
  } finally {
    db.close();
  }
  return { ok: checks.filter((c) => c.name !== 'hnsw_in_plan_default_info').every((c) => c.ok), checks };
}

module.exports = { importMed, verifyMed, normalizeInn, readSource, openSource, EXPECTED, DEFAULT_SQLITE };
