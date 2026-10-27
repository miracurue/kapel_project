#!/usr/bin/env node
'use strict';

// Нагрузочный тест хранилища знаний (Postgres + pgvector) на синтетическом корпусе масштаба заказчика.
// Основную БД не трогает: на том же сервере создаётся временная БД lt_*, в конце она удаляется (WITH (FORCE)).
//
//   KNOWLEDGE_TEST_DATABASE_URL=postgres://knowledge:pw@127.0.0.1:54330/knowledge \
//     node scripts/knowledge_loadtest.js --docs 2000 --chunks-per-doc 30 --effects 10000 --clinrec-chunks 5000 \
//       --container cc-knowledge-loadtest --out /tmp/loadtest.json
//
// Фазы: загрузка -> построение HNSW (матрица вариантов) -> recall@10 против точного перебора ->
// latency searchText(hybrid) при разной конкуренции -> размеры/память. Эмбеддинг-клиент фейковый (без сети),
// поэтому задержка запроса к GigaChat в цифры НЕ входит.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { createPool, toVectorLiteral } = require('../src/modules/knowledge/pg');
const { migrate } = require('../src/modules/knowledge/migrate');
const { knnRanked, bindFilter } = require('../src/modules/knowledge/rrf');
const rrfModule = require('../src/modules/knowledge/rrf');
let medSearch = require('../src/modules/knowledge/search_med');
let clinSearch = require('../src/modules/knowledge/search_clinrec');

const DIM = 2560;
const MODEL = 'loadtest-fake';

// ---------- детерминированный ГПСЧ ----------
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
const hash32 = (str) => crypto.createHash('sha1').update(String(str)).digest().readUInt32LE(0);

// ---------- синтетические векторы с кластерной структурой ----------
// v = 0.7*common + centroid[cluster] + noise; косинус внутри кластера ~0.7, между кластерами ~0.2
// (у настоящих эмбеддингов есть общая компонента, поэтому «пустого» ортогонального пространства нет).
function makeVectorSpace(clusters) {
  const gauss = (r) => (r() + r() + r() + r() - 2) * 1.7320508; // сумма 4 равномерных, std = 1
  const common = new Float32Array(DIM);
  const rc = rng(7);
  for (let i = 0; i < DIM; i++) common[i] = gauss(rc) * 0.7;
  const centroids = [];
  for (let c = 0; c < clusters; c++) {
    const r = rng(1000 + c);
    const v = new Float32Array(DIM);
    for (let i = 0; i < DIM; i++) v[i] = gauss(r);
    centroids.push(v);
  }
  return {
    clusters,
    vector(cluster, seed, noise = 0.8) {
      const r = rng(seed);
      const c = centroids[cluster % clusters];
      const v = new Float32Array(DIM);
      for (let i = 0; i < DIM; i++) v[i] = common[i] + c[i] + (r() + r() + r() - 1.5) * 2 * noise;
      return v;
    },
    perturb(base, seed, noise) {
      const r = rng(seed);
      const v = new Float32Array(DIM);
      for (let i = 0; i < DIM; i++) v[i] = base[i] + (r() + r() + r() - 1.5) * 2 * noise;
      return v;
    },
  };
}
const literal = (v) => {
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Math.round(v[i] * 1000) / 1000;
  return `[${out.join(',')}]`;
};

// ---------- русскоподобный текст ----------
const BASE_WORDS = (
  'препарат пациент доза приём таблетка раствор введение лечение терапия применение показание противопоказание ' +
  'побочный реакция нарушение печень почки сердце давление головная боль тошнота рвота сонливость бессонница ' +
  'беременность лактация дети взрослые пожилые риск симптом синдром депрессия тревога судороги аллергия сыпь ' +
  'концентрация период выведение метаболизм всасывание биодоступность взаимодействие ингибитор рецептор ' +
  'суточная максимальная начальная поддерживающая курс неделя месяц отмена постепенно контроль мониторинг ' +
  'врач наблюдение дозировка снижение повышение увеличение частота редко часто очень иногда единичные случаи'
).split(' ');
const SYL = ['ка', 'ли', 'мо', 'ра', 'сте', 'ни', 'до', 'пре', 'вал', 'зон', 'тен', 'гор', 'лам', 'син', 'фе', 'рит', 'бу', 'мет', 'ал', 'ци'];
function pseudoWord(i, minSyl = 2) {
  let n = i;
  let w = '';
  for (let k = 0; k < minSyl || n > 0; k++) {
    w += SYL[n % SYL.length];
    n = Math.floor(n / SYL.length);
  }
  return w;
}
function makeVocab(size) {
  const words = [...BASE_WORDS];
  for (let i = 0; words.length < size; i++) words.push(`${pseudoWord(i, 3)}${['ин', 'ол', 'ат', 'ид'][i % 4]}`);
  return words;
}
function makeText(vocab, r, words) {
  const out = [];
  for (let i = 0; i < words; i++) out.push(vocab[Math.floor(vocab.length * Math.pow(r(), 1.6))]);
  return out;
}

// ---------- служебное ----------
const sh = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 15000 }, (err, stdout) => resolve(err ? '' : stdout)));
const now = () => Number(process.hrtime.bigint() / 1000000n);
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] : null);
const mib = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
const log = (...a) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

function parseSize(text) {
  const m = /^([\d.]+)\s*(KiB|MiB|GiB|kB|MB|GB|B)?/i.exec(text.trim());
  if (!m) return 0;
  const mult = { b: 1, kib: 1024, kb: 1000, mib: 1048576, mb: 1e6, gib: 1073741824, gb: 1e9 }[(m[2] || 'B').toLowerCase()];
  return Number(m[1]) * mult;
}
// Потребление контейнера (docker stats) в фоне: максимум памяти и CPU за фазу.
function sampler(container) {
  const state = { memMax: 0, cpuMax: 0, n: 0, stopped: false };
  if (!container) return { stop: () => state };
  const loop = (async () => {
    while (!state.stopped) {
      const out = await sh('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}|{{.CPUPerc}}', container]);
      const [mem, cpu] = out.trim().split('|');
      if (mem) {
        state.memMax = Math.max(state.memMax, parseSize(mem.split('/')[0]));
        state.cpuMax = Math.max(state.cpuMax, parseFloat(cpu) || 0);
        state.n++;
      }
    }
  })();
  return {
    stop: async () => {
      state.stopped = true;
      await loop;
      return { memMaxMiB: mib(state.memMax), cpuMaxPct: state.cpuMax, samples: state.n };
    },
  };
}

// ---------- временная БД ----------
async function createTempDb(adminUrl) {
  const name = `lt_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return {
    name,
    url: u.toString(),
    async drop() {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

// ---------- загрузка ----------
async function batchInsert(pool, sql, rows, size) {
  for (let i = 0; i < rows.length; i += size) await pool.query(sql, rows.slice(i, i + size));
}

async function loadMed(pool, o, space, vocab) {
  const t0 = now();
  const innCount = Math.max(1, Math.floor(o.docs * 0.6));
  const chunksTotal = o.docs * o.chunksPerDoc;
  const rd = rng(11);
  let chunkCount = 0;
  const docClusters = [];
  for (let d = 0; d < o.docs; d += 25) {
    const part = [];
    for (let k = d; k < Math.min(o.docs, d + 25); k++) {
      const id = `LT-D${k}`;
      const inn = pseudoWord(k % innCount, 3) + 'ин';
      const cluster = k % space.clusters;
      docClusters[k] = cluster;
      const texts = [];
      for (let c = 0; c < o.chunksPerDoc; c++) texts.push(makeText(vocab, rd, o.wordsPerChunk).join(' '));
      part.push({ id, k, inn, cluster, texts });
    }
    // документы, секции, drug_map
    await pool.query(
      `INSERT INTO med.documents (id, drug_label, inn, trade_name, source_file, sha256, markdown)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])`,
      [
        part.map((p) => p.id),
        part.map((p) => `${p.inn} (${p.id})`),
        part.map((p) => p.inn),
        part.map((p) => `Торг${p.k}`),
        part.map((p) => `${p.id}.md`),
        part.map((p) => `sha-${p.id}`),
        part.map((p) => p.texts.join('\n')),
      ],
    );
    await pool.query(
      `INSERT INTO med.drug_map (inn_name_norm, document_id) SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT DO NOTHING`,
      [part.map((p) => p.inn), part.map((p) => p.id)],
    );
    const sec = [];
    const chunks = [];
    for (const p of part) {
      let off = 0;
      const perSection = 5;
      for (let c = 0; c < p.texts.length; c++) {
        if (c % perSection === 0) {
          const end = off + p.texts.slice(c, c + perSection).reduce((a, t) => a + t.length + 1, 0);
          sec.push([`${p.id}-S${c / perSection}`, p.id, c / perSection, `Раздел ${c / perSection}`, off, end]);
        }
        const text = p.texts[c];
        // 70% чанков из «родного» кластера документа, 30% из соседних
        const cl = rd() < 0.7 ? p.cluster : p.cluster + 1 + Math.floor(rd() * 5);
        chunks.push({
          id: `${p.id}-C${c}`,
          doc: p.id,
          section: `${p.id}-S${Math.floor(c / perSection)}`,
          ord: c,
          text,
          start: off,
          end: off + text.length,
          cluster: cl,
          seed: 100000 + chunkCount++,
        });
        off += text.length + 1;
      }
    }
    await pool.query(
      `INSERT INTO med.sections (id, document_id, level, ord, title, path, start_char, end_char, start_line)
       SELECT a, b, 1, c, d, d, e, f, 1 FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::int[], $6::int[]) AS t(a,b,c,d,e,f)`,
      [0, 1, 2, 3, 4, 5].map((i) => sec.map((s) => s[i])),
    );
    for (let i = 0; i < chunks.length; i += 100) {
      const b = chunks.slice(i, i + 100);
      await pool.query(
        `INSERT INTO med.chunks (id, document_id, section_id, section_ids, ord, text, content_hash, start_char, end_char,
                                 embedding, embedding_model, embedding_hash)
         SELECT a, b, c, ARRAY[c], d, e, 'h-' || a, f, g, h::halfvec, $9, 'h-' || a
         FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[], $6::int[], $7::int[], $8::text[]) AS t(a,b,c,d,e,f,g,h)`,
        [
          b.map((x) => x.id),
          b.map((x) => x.doc),
          b.map((x) => x.section),
          b.map((x) => x.ord),
          b.map((x) => x.text),
          b.map((x) => x.start),
          b.map((x) => x.end),
          b.map((x) => literal(space.vector(x.cluster, x.seed))),
          MODEL,
        ],
      );
    }
    if (d % 250 === 0) log(`med: ${Math.min(o.docs, d + 25)}/${o.docs} документов`);
  }
  // формулировки побочек
  const effects = [];
  for (let i = 0; i < o.effects; i++) {
    const name = `${pseudoWord(i, 2)}${['ия', 'оз', 'ит', 'ез'][i % 4]} ${vocab[(i * 7) % 200]}`;
    effects.push({ id: `LT-E${i}`, name, cluster: i % space.clusters, seed: 900000 + i });
  }
  for (let i = 0; i < effects.length; i += 100) {
    const b = effects.slice(i, i + 100);
    await pool.query(
      `INSERT INTO med.effects (id, name, category, raw_json, embedding, embedding_model, embedding_hash)
       SELECT a, b, 'категория', jsonb_build_object('id', a, 'name', b, 'aliases', '[]'::jsonb), c::halfvec, $4, 'h-' || a
       FROM unnest($1::text[], $2::text[], $3::text[]) AS t(a,b,c)`,
      [b.map((x) => x.id), b.map((x) => x.name), b.map((x) => literal(space.vector(x.cluster, x.seed))), MODEL],
    );
  }
  await pool.query(
    `INSERT INTO med.blocks (id, document_id, raw_json) SELECT 'B-' || id, id, '{}'::jsonb FROM med.documents`,
  );
  await pool.query(
    `INSERT INTO med.effect_links (id, effect_id, document_id, block_id, frequency, context, raw_term, raw_json)
     SELECT 'L-' || e.id, e.id, 'LT-D' || (row_number() OVER (ORDER BY e.id) % $1), 'B-LT-D' || (row_number() OVER (ORDER BY e.id) % $1),
            'часто', 'ctx', e.name, '{}'::jsonb FROM med.effects e`,
    [o.docs],
  );
  return { ms: now() - t0, chunks: chunksTotal, effects: o.effects };
}

async function loadClinrec(pool, o, space, vocab) {
  const t0 = now();
  const r = rng(23);
  const docs = Math.max(1, Math.round(o.clinrecChunks / 50));
  const per = Math.ceil(o.clinrecChunks / docs);
  let n = 0;
  for (let d = 0; d < docs; d++) {
    const id = `LT-CR${d}`;
    await pool.query(`INSERT INTO clinrec.documents (id, title, source_sha256) VALUES ($1,$2,$3)`, [
      id,
      `Клинические рекомендации ${pseudoWord(d, 3)}`,
      `sha-${id}`,
    ]);
    await pool.query(`INSERT INTO clinrec.sections (id, document_id, level, ord, title, path) VALUES ($1,$2,1,1,'Раздел','Раздел')`, [
      `${id}-S`,
      id,
    ]);
    const parents = [];
    const chunks = [];
    for (let c = 0; c < per && n < o.clinrecChunks; c++, n++) {
      const text = makeText(vocab, r, 60).join(' ');
      const parentId = `${id}-P${Math.floor(c / 5)}`;
      if (c % 5 === 0) parents.push({ id: parentId, text: text.repeat(3) });
      chunks.push({ id: `${id}-C${c}`, parent: parentId, text, cluster: (d * 7 + c) % space.clusters, seed: 700000 + n });
    }
    await pool.query(
      `INSERT INTO clinrec.parents (id, document_id, section_id, heading_path, text) SELECT a, $3, $4, ARRAY['Раздел'], b FROM unnest($1::text[], $2::text[]) AS t(a,b)`,
      [parents.map((p) => p.id), parents.map((p) => p.text), id, `${id}-S`],
    );
    for (let i = 0; i < chunks.length; i += 100) {
      const b = chunks.slice(i, i + 100);
      await pool.query(
        `INSERT INTO clinrec.chunks (id, document_id, section_id, kind, parent_id, mode, heading_path, text, embed, embed_text, embed_text_hash,
                                     embedding, embedding_model, embedding_hash)
         SELECT a, $5, $6, 'main', p, 'parent', ARRAY['Раздел'], t, true, t, 'h-' || a, v::halfvec, $7, 'h-' || a
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS x(a,p,t,v)`,
        [
          b.map((x) => x.id),
          b.map((x) => x.parent),
          b.map((x) => x.text),
          b.map((x) => literal(space.vector(x.cluster, x.seed))),
          id,
          `${id}-S`,
          MODEL,
        ],
      );
    }
  }
  return { ms: now() - t0, chunks: n, documents: docs };
}

// ---------- HNSW ----------
const INDEXES = [
  { name: 'med.chunks_embedding', table: 'med.chunks' },
  { name: 'med.effects_embedding', table: 'med.effects' },
  { name: 'clinrec.chunks_embedding', table: 'clinrec.chunks' },
];
async function buildIndex(pool, idx, v) {
  const c = await pool.connect();
  try {
    if (v.mwm) await c.query(`SET maintenance_work_mem = '${v.mwm}'`);
    if (v.workers !== undefined) await c.query(`SET max_parallel_maintenance_workers = ${Number(v.workers)}`);
    const short = idx.name.split('.')[1];
    await c.query(`DROP INDEX IF EXISTS ${idx.name}`);
    const t0 = now();
    await c.query(
      `CREATE INDEX ${short} ON ${idx.table} USING hnsw (embedding halfvec_cosine_ops) WITH (m = ${v.m || 16}, ef_construction = ${v.efc || 64})`,
    );
    return now() - t0;
  } finally {
    c.release();
  }
}

async function sizes(pool) {
  const { rows } = await pool.query(
    `SELECT n.nspname || '.' || c.relname AS name, c.relkind,
            pg_total_relation_size(c.oid) AS total, pg_relation_size(c.oid) AS main,
            CASE WHEN c.relkind = 'r' THEN pg_relation_size(c.reltoastrelid) ELSE 0 END AS toast
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('med', 'clinrec') AND c.relkind IN ('r', 'i') AND c.relpages > 0
     ORDER BY pg_total_relation_size(c.oid) DESC`,
  );
  const tables = {};
  const indexes = {};
  for (const r of rows) {
    if (r.relkind === 'r') tables[r.name] = { heapMiB: mib(r.main), toastMiB: mib(r.toast) };
    else indexes[r.name] = mib(r.main);
  }
  const db = (await pool.query(`SELECT pg_database_size(current_database()) AS s`)).rows[0].s;
  return { tables, indexes, databaseMiB: mib(db) };
}

async function bufferCache(pool) {
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_buffercache');
    const { rows } = await pool.query(
      `SELECT c.relname, count(*)::int AS buffers FROM pg_buffercache b JOIN pg_class c ON c.relfilenode = b.relfilenode
       WHERE b.reldatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
       GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
    );
    const sb = (await pool.query(`SELECT setting::bigint * 8192 AS b FROM pg_settings WHERE name = 'shared_buffers'`)).rows[0].b;
    return { sharedBuffersMiB: mib(Number(sb)), top: rows.map((r) => ({ relation: r.relname, MiB: mib(r.buffers * 8192) })) };
  } catch (e) {
    return { error: e.code || e.message };
  }
}

// ---------- запросы ----------
function pick(r, n) {
  return Math.floor(r() * n);
}
async function makeQueries(pool, o, space, vocab, count, seed) {
  const r = rng(seed);
  const total = o.docs * o.chunksPerDoc;
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = pick(r, o.docs);
    const c = pick(r, o.chunksPerDoc);
    const id = `LT-D${d}-C${c}`;
    const { rows } = await pool.query(
      `SELECT c.text, c.embedding::text AS emb, d.inn, c.document_id FROM med.chunks c JOIN med.documents d ON d.id = c.document_id WHERE c.id = $1`,
      [id],
    );
    if (!rows.length) {
      i--;
      continue;
    }
    const base = Float32Array.from(JSON.parse(rows[0].emb));
    const words = rows[0].text.split(' ');
    const text = [words[pick(r, words.length)], words[pick(r, words.length)], words[pick(r, words.length)]].join(' ');
    const vec = space.perturb(base, 555000 + i, 0.5);
    out.push({ i, text: `${text} ${vocab[i % 60]}`, vec, literal: literal(vec), inn: rows[0].inn, doc: rows[0].document_id });
  }
  void total;
  return out;
}
async function makeClinQueries(pool, o, vocab, count, seed) {
  const r = rng(seed);
  const { rows } = await pool.query(
    `SELECT text, embedding::text AS emb FROM clinrec.chunks WHERE embed ORDER BY id OFFSET $1 LIMIT $2`,
    [pick(r, Math.max(1, o.clinrecChunks - count)), count],
  );
  return rows.map((row, i) => {
    const words = row.text.split(' ');
    const text = [words[pick(r, words.length)], words[pick(r, words.length)], words[pick(r, words.length)]].join(' ');
    return { text: `${text} ${vocab[(i + 7) % 60]}`, vec: Float32Array.from(JSON.parse(row.emb)) };
  });
}
function fakeClient(queries) {
  const byText = new Map(queries.map((q) => [q.text.toLowerCase().replaceAll('ё', 'е'), q.vec]));
  return {
    model: MODEL,
    async embed(texts) {
      return { model: MODEL, vectors: texts.map((t) => Array.from(byText.get(t) || new Float32Array(DIM).fill(0.01))) };
    },
  };
}

// ---------- recall ----------
async function topIds(pool, sql, params, settings) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    for (const s of settings) await c.query(s);
    const { rows } = await c.query(sql, params);
    await c.query('COMMIT');
    return rows.map((r) => r.id);
  } finally {
    c.release();
  }
}
async function planUsesHnsw(pool, table, where, params, ef) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    await c.query(`SET LOCAL hnsw.ef_search = ${ef}`);
    await c.query(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    const { rows } = await c.query(
      `EXPLAIN SELECT id FROM ${table} WHERE embedding IS NOT NULL AND ${where} ORDER BY embedding <=> $1::halfvec LIMIT 10`,
      params,
    );
    await c.query('COMMIT');
    return rows.some((r) => /Index Scan using \w*embedding/.test(r['QUERY PLAN']));
  } finally {
    c.release();
  }
}

// Точный top-10 за один проход по таблице: векторы читаются пачками (halfvec::text), косинус считается в Node
// сразу для всех запросов и областей. Не зависит от плана Postgres и не перечитывает TOAST для каждого запроса.
async function exactTopK(pool, table, queries, scopes) {
  const rounded = [];
  for (const q of queries) {
    const { rows } = await pool.query('SELECT $1::halfvec::text AS t', [q.literal]);
    const v = Float32Array.from(JSON.parse(rows[0].t));
    let n = 0;
    for (let i = 0; i < DIM; i++) n += v[i] * v[i];
    rounded.push({ v, norm: Math.sqrt(n) });
  }
  const top = scopes.map(() => queries.map(() => []));
  const push = (list, id, sim) => {
    if (list.length === 10 && sim <= list[9].sim) return;
    list.push({ id, sim });
    list.sort((x, y) => y.sim - x.sim);
    if (list.length > 10) list.pop();
  };
  let last = '';
  for (;;) {
    const { rows } = await pool.query(
      `SELECT id, document_id AS doc, embedding::text AS t FROM ${table} WHERE embedding IS NOT NULL AND id > $1 ORDER BY id LIMIT 1000`,
      [last],
    );
    if (!rows.length) break;
    for (const r of rows) {
      const v = Float32Array.from(JSON.parse(r.t));
      let n = 0;
      for (let i = 0; i < DIM; i++) n += v[i] * v[i];
      const inv = 1 / Math.sqrt(n);
      for (const [qi, q] of rounded.entries()) {
        let dot = 0;
        const qv = q.v;
        for (let i = 0; i < DIM; i++) dot += qv[i] * v[i];
        const sim = (dot * inv) / q.norm;
        for (const [si, sc] of scopes.entries()) if (sc.has(r.doc, queries[qi])) push(top[si][qi], r.id, sim);
      }
    }
    last = rows[rows.length - 1].id;
  }
  return top.map((perScope) => perScope.map((list) => list.map((x) => x.id)));
}

async function recallPhase(pool, queries, o, table = 'med.chunks') {
  // Области: весь корпус; один документ; ~10% корпуса (по документам).
  const bigScope = new Set(Array.from({ length: Math.max(1, Math.round(o.docs / 10)) }, (_, i) => `LT-D${i * 10}`));
  const scopes = [
    { name: 'весь корпус', where: 'TRUE', pick: () => [], has: () => true },
    { name: 'один документ', where: 'document_id = $2', pick: (q) => [q.doc], has: (doc, q) => doc === q.doc },
    {
      name: '10% документов',
      where: 'document_id = ANY($2::text[])',
      pick: (q) => [[q.doc, ...bigScope]],
      has: (doc, q) => doc === q.doc || bigScope.has(doc),
    },
  ];
  const truth = await exactTopK(pool, table, queries, scopes);
  const result = [];
  for (const [si, sc] of scopes.entries()) {
    const exact = truth[si];
    const variants = [
      { name: 'ef=40', ef: 40, iter: false },
      { name: 'ef=100', ef: 100, iter: false },
      { name: 'ef=40+iterative', ef: 40, iter: true },
      { name: 'ef=100+iterative', ef: 100, iter: true },
    ];
    const cells = {};
    for (const v of variants) {
      let hit = 0;
      let want = 0;
      for (const [i, q] of queries.entries()) {
        const settings = [`SET LOCAL hnsw.ef_search = ${v.ef}`];
        if (v.iter) settings.push('SET LOCAL hnsw.iterative_scan = relaxed_order', 'SET LOCAL hnsw.max_scan_tuples = 300000');
        const got = new Set(
          await topIds(
            pool,
            `SELECT id FROM ${table} WHERE embedding IS NOT NULL AND ${sc.where} ORDER BY embedding <=> $1::halfvec LIMIT 10`,
            [q.literal, ...sc.pick(q)],
            settings,
          ),
        );
        want += exact[i].length;
        hit += exact[i].filter((id) => got.has(id)).length;
      }
      cells[v.name] = Math.round((hit / Math.max(1, want)) * 1000) / 1000;
    }
    // Путь приложения: knnRanked(depth=100) + точный запасной проход, берём топ-10.
    let hit = 0;
    let want = 0;
    const scans = {};
    const t0 = now();
    for (const [i, q] of queries.entries()) {
      const sp = {
        table,
        idColumn: 'id',
        filters: sc.name === 'весь корпус' ? [] : [{ sql: sc.where.replace('$2', '$@'), params: sc.pick(q) }],
      };
      const r = await knnRanked(pool, sp, q.literal, MODEL, 100);
      scans[r.scan] = (scans[r.scan] || 0) + 1;
      const got = new Set(r.rows.slice(0, 10).map((x) => x.id));
      want += exact[i].length;
      hit += exact[i].filter((id) => got.has(id)).length;
    }
    cells['приложение (knnRanked, depth=100)'] = Math.round((hit / Math.max(1, want)) * 1000) / 1000;
    const usesHnsw = await planUsesHnsw(pool, table, sc.where, [queries[0].literal, ...sc.pick(queries[0])], 100);
    result.push({ scope: sc.name, planUsesHnsw: usesHnsw, appScans: scans, appMsPerQuery: Math.round((now() - t0) / queries.length), recallAt10: cells });
  }
  return result;
}

// ---------- нагрузка ----------
async function runLevel(task, concurrency, durationMs, thinkMs = 0) {
  const latencies = [];
  let errors = 0;
  let next = 0;
  const end = now() + durationMs;
  const started = now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (now() < end) {
        const i = next++;
        const t = now();
        try {
          await task(i);
          latencies.push(now() - t);
        } catch {
          errors++;
        }
        if (thinkMs) await new Promise((r) => setTimeout(r, thinkMs * (0.5 + Math.random())));
      }
    }),
  );
  const elapsed = (now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    concurrency,
    requests: latencies.length,
    errors,
    rps: Math.round((latencies.length / elapsed) * 10) / 10,
    p50: pct(latencies, 50),
    p95: pct(latencies, 95),
    p99: pct(latencies, 99),
    max: latencies[latencies.length - 1] ?? null,
  };
}

// Моделирует предлагаемое исправление лексической ветки: если термин встречается более чем в maxMatches
// чанках области, ранжирование (ts_rank_cd по десяткам тысяч строк, сотни мс) пропускается: такой запрос не
// различает чанки, hybrid остаётся на векторной ветке. Проба (count с LIMIT) стоит ~10 мс.
function installLexicalGuard(maxMatches) {
  const original = rrfModule.lexicalRanked;
  const orQuery = (term) =>
    [...new Set(term.split(' ').filter((t) => t.length > 1))]
      .slice(0, 20)
      .map((t) => `${t}:*`)
      .join(' | ');
  const guarded = async (pool, spec, term, opts) => {
    const f = bindFilter(spec.filters, 2);
    const probe = async (tsq, param) =>
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM (SELECT 1 FROM ${spec.table} WHERE tsv @@ ${tsq} AND ${f.sql} LIMIT ${maxMatches + 1}) s`,
          [param, ...f.params],
        )
      ).rows[0].n;
    // запасная OR-форма (когда AND пуст) по префиксам частых слов матчит десятки тысяч чанков -> пропускаем её
    if ((await probe(`websearch_to_tsquery('russian', $1)`, term)) === 0) {
      const or = orQuery(term);
      if (or && (await probe(`to_tsquery('russian', $1)`, or)) > maxMatches) return { rows: [], total: 0, form: 'skipped_frequent' };
    }
    return original(pool, spec, term, opts);
  };
  rrfModule.lexicalRanked = guarded;
  for (const m of ['search_med', 'search_clinrec']) delete require.cache[require.resolve(`../src/modules/knowledge/${m}`)];
  medSearch = require('../src/modules/knowledge/search_med');
  clinSearch = require('../src/modules/knowledge/search_clinrec');
  return () => {
    rrfModule.lexicalRanked = original;
    for (const m of ['search_med', 'search_clinrec']) delete require.cache[require.resolve(`../src/modules/knowledge/${m}`)];
    medSearch = require('../src/modules/knowledge/search_med');
    clinSearch = require('../src/modules/knowledge/search_clinrec');
  };
}

async function latencyPhase(o, dbUrl, queries, clinQueries, container) {
  const uninstall = o.lexicalGuard ? installLexicalGuard(o.lexicalGuard) : null;
  try {
    return await latencyPhaseInner(o, dbUrl, queries, clinQueries, container);
  } finally {
    if (uninstall) uninstall();
  }
}

async function latencyPhaseInner(o, dbUrl, queries, clinQueries, container) {
  const client = fakeClient([...queries, ...clinQueries]);
  const out = {};
  for (const poolMax of o.poolSizes) {
    const pool = createPool({ connectionString: dbUrl, max: poolMax }, {});
    if (o.simulateStatusCache) {
      // Моделирует предлагаемое исправление: результат embeddingStatus кэшируется на 60 с (ключ — SQL + параметры).
      const real = pool.query.bind(pool);
      const cache = new Map();
      pool.query = (sql, params, ...rest) => {
        if (typeof sql === 'string' && sql.includes('count(*) FILTER (WHERE embedding IS NOT NULL AND embedding_model')) {
          const key = sql + JSON.stringify(params);
          const hit = cache.get(key);
          if (hit && Date.now() - hit.at < 60000) return Promise.resolve(hit.value);
          return real(sql, params, ...rest).then((value) => (cache.set(key, { at: Date.now(), value }), value));
        }
        return real(sql, params, ...rest);
      };
    }
    try {
      const scenarios = {
        'препарат (область = один МНН)': (i) => {
          const q = queries[i % queries.length];
          return medSearch.searchText(pool, { query: q.text, mode: 'hybrid', limit: 20, client, scope: { innNorm: q.inn } });
        },
        'весь корпус (лекарства)': (i) => {
          const q = queries[i % queries.length];
          return medSearch.searchText(pool, { query: q.text, mode: 'hybrid', limit: 20, client, scope: {} });
        },
        'клинреки (весь корпус)': (i) => {
          const q = clinQueries[i % clinQueries.length];
          return clinSearch.searchClinrec(pool, q.text, { mode: 'hybrid', limit: 10, client });
        },
      };
      for (const [name, fn] of Object.entries(scenarios)) {
        await runLevel(fn, Math.min(4, poolMax), 1500); // прогрев кэша
        for (const conc of o.concurrency) {
          const s = sampler(container);
          const res = await runLevel(fn, conc, o.levelSeconds * 1000, o.thinkMs || 0);
          const mem = await s.stop();
          (out[`pool=${poolMax}`] ||= {})[name] ||= [];
          out[`pool=${poolMax}`][name].push({ ...res, containerMemMaxMiB: mem.memMaxMiB, containerCpuMaxPct: mem.cpuMaxPct });
          log(`pool=${poolMax} ${name} conc=${conc}: p50=${res.p50} p95=${res.p95} p99=${res.p99} rps=${res.rps} err=${res.errors}`);
        }
      }
    } finally {
      await pool.end();
    }
  }
  return out;
}

// ---------- главная функция ----------
const DEFAULTS = {
  docs: 2000,
  chunksPerDoc: 30,
  wordsPerChunk: 90,
  effects: 10000,
  clinrecChunks: 5000,
  clusters: 300,
  recallQueries: 200,
  recallQueriesVariant: 60,
  latencyQueries: 200,
  concurrency: [1, 10, 50, 100],
  poolSizes: [10],
  levelSeconds: 12,
  builds: [{ mwm: '384MB', workers: 1, m: 16, efc: 64 }],
  container: null,
  keep: false,
  skipLatency: false,
  skipRecall: false,
  storage: null, // 'external' -> ALTER COLUMN embedding SET STORAGE EXTERNAL перед загрузкой
};

async function runLoadtest(adminUrl, overrides = {}) {
  const o = { ...DEFAULTS, ...overrides };
  const report = { options: o, startedAt: new Date().toISOString() };
  const tmp = await createTempDb(adminUrl);
  report.database = tmp.name;
  const pool = createPool({ connectionString: tmp.url, max: 4, statement_timeout: 3600000 }, {});
  try {
    const space = makeVectorSpace(o.clusters);
    const vocab = makeVocab(4000);
    await migrate(pool);
    for (const idx of INDEXES) await pool.query(`DROP INDEX ${idx.name}`); // грузим без HNSW, строим после
    if (o.storage)
      for (const t of ['med.chunks', 'med.effects', 'clinrec.chunks'])
        await pool.query(`ALTER TABLE ${t} ALTER COLUMN embedding SET STORAGE ${o.storage}`);
    report.server = (await pool.query(`SELECT current_setting('server_version') AS v, (SELECT extversion FROM pg_extension WHERE extname='vector') AS pgvector`)).rows[0];
    report.settings = Object.fromEntries(
      (await pool.query(`SELECT name, current_setting(name) AS value FROM pg_settings WHERE name IN ('shared_buffers','maintenance_work_mem','work_mem','effective_cache_size','max_parallel_maintenance_workers','max_connections')`)).rows.map((r) => [r.name, r.value]),
    );

    let s = sampler(o.container);
    report.load = { med: await loadMed(pool, o, space, vocab), clinrec: await loadClinrec(pool, o, space, vocab) };
    const t0 = now();
    await pool.query('ANALYZE');
    report.load.analyzeMs = now() - t0;
    report.load.container = await s.stop();
    log('загрузка', JSON.stringify(report.load));
    report.sizesBeforeIndex = await sizes(pool);

    // Построение индексов: матрица вариантов на med.chunks, последний вариант остаётся для всех индексов.
    report.builds = [];
    const medIdx = INDEXES[0];
    for (const [i, v] of o.builds.entries()) {
      s = sampler(o.container);
      let ms = null;
      let error = null;
      try {
        ms = await buildIndex(pool, medIdx, v);
      } catch (e) {
        error = e.message; // например, нехватка /dev/shm при параллельной сборке
        if (i === o.builds.length - 1) throw e;
      }
      const mem = await s.stop();
      const entry = { variant: v, med_chunks_ms: ms, error, container: mem };
      if (error) {
        report.builds.push(entry);
        log('индекс', JSON.stringify(v), `ОШИБКА: ${error}`);
        continue;
      }
      if (!o.skipRecall && i < o.builds.length - 1 && v.recall) {
        const qs = await makeQueries(pool, o, space, vocab, o.recallQueriesVariant, 4242);
        entry.recall = await recallPhase(pool, qs, o);
      }
      entry.indexMiB = (await sizes(pool)).indexes['med.chunks_embedding'] ?? null;
      report.builds.push(entry);
      log('индекс', JSON.stringify(v), `${ms} мс`);
    }
    const last = o.builds[o.builds.length - 1];
    report.finalIndexMs = { med_chunks: report.builds[report.builds.length - 1].med_chunks_ms };
    for (const idx of INDEXES.slice(1)) report.finalIndexMs[idx.name] = await buildIndex(pool, idx, last);
    await pool.query('ANALYZE');
    report.sizes = await sizes(pool);

    // Инкрементальная вставка при готовом индексе (путь «обновление корпуса»).
    {
      const base = space.vector(5, 31337);
      const t = now();
      const rows = 300;
      await pool.query(
        `INSERT INTO med.chunks (id, document_id, section_id, section_ids, ord, text, content_hash, start_char, end_char, embedding, embedding_model, embedding_hash)
         SELECT 'LT-INS' || g, 'LT-D0', 'LT-D0-S0', ARRAY['LT-D0-S0'], 1000 + g, 'вставка ' || g, 'h' || g, 0, 10, $1::halfvec, $2, 'h' || g FROM generate_series(1, ${rows}) g`,
        [literal(base), MODEL],
      );
      report.incrementalInsert = { rows, ms: now() - t, msPerRow: Math.round(((now() - t) / rows) * 10) / 10 };
      await pool.query(`DELETE FROM med.chunks WHERE id LIKE 'LT-INS%'`);
    }

    if (!o.skipRecall) {
      const qs = await makeQueries(pool, o, space, vocab, o.recallQueries, 777);
      s = sampler(o.container);
      report.recall = await recallPhase(pool, qs, o);
      report.recallContainer = await s.stop();
    }
    if (!o.skipLatency) {
      const qs = await makeQueries(pool, o, space, vocab, o.latencyQueries, 999);
      const cqs = await makeClinQueries(pool, o, vocab, 100, 31);
      report.latency = await latencyPhase(o, tmp.url, qs, cqs, o.container);
    }
    report.bufferCache = await bufferCache(pool);
    report.sizesFinal = await sizes(pool);
  } finally {
    await pool.end();
    if (!o.keep) await tmp.drop();
    else report.kept = tmp.name;
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

// Только нагрузка на уже загруженную БД (для повторных замеров и проверки исправлений).
async function runLatencyOnly(adminUrl, dbName, overrides = {}) {
  const o = { ...DEFAULTS, ...overrides };
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  const pool = createPool({ connectionString: u.toString(), max: 2 }, {});
  try {
    const space = makeVectorSpace(o.clusters);
    const vocab = makeVocab(4000);
    const qs = await makeQueries(pool, o, space, vocab, o.latencyQueries, 999);
    const cqs = await makeClinQueries(pool, o, vocab, 100, 31);
    return { options: o, database: dbName, latency: await latencyPhase(o, u.toString(), qs, cqs, o.container) };
  } finally {
    await pool.end();
  }
}

// ---------- CLI ----------
function parseArgs(argv) {
  const o = {};
  const num = (v) => Number(v);
  const list = (v) => v.split(',').map(Number);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--docs') o.docs = num(v());
    else if (a === '--chunks-per-doc') o.chunksPerDoc = num(v());
    else if (a === '--effects') o.effects = num(v());
    else if (a === '--clinrec-chunks') o.clinrecChunks = num(v());
    else if (a === '--recall-queries') o.recallQueries = num(v());
    else if (a === '--concurrency') o.concurrency = list(v());
    else if (a === '--pool') o.poolSizes = list(v());
    else if (a === '--level-seconds') o.levelSeconds = num(v());
    else if (a === '--builds') o.builds = JSON.parse(v());
    else if (a === '--container') o.container = v();
    else if (a === '--storage') o.storage = v();
    else if (a === '--out') o.out = v();
    else if (a === '--url') o.url = v();
    else if (a === '--keep') o.keep = true;
    else if (a === '--latency-only') o.latencyOnly = v();
    else if (a === '--think-ms') o.thinkMs = num(v());
    else if (a === '--lexical-guard') o.lexicalGuard = num(v());
    else if (a === '--simulate-status-cache') o.simulateStatusCache = true;
    else if (a === '--skip-latency') o.skipLatency = true;
    else if (a === '--skip-recall') o.skipRecall = true;
    else throw new Error(`неизвестный аргумент ${a}`);
  }
  return o;
}

function summary(r) {
  const lines = [];
  lines.push(`БД ${r.database}; PostgreSQL ${r.server.v}, pgvector ${r.server.pgvector}; ${JSON.stringify(r.settings)}`);
  lines.push(`загрузка: med ${r.load.med.ms} мс (${r.load.med.chunks} чанков, ${r.load.med.effects} формулировок), clinrec ${r.load.clinrec.ms} мс, ANALYZE ${r.load.analyzeMs} мс`);
  for (const b of r.builds) lines.push(`HNSW ${JSON.stringify(b.variant)}: ${b.error ? 'ОШИБКА ' + b.error + ';' : ''} med.chunks ${b.med_chunks_ms} мс, индекс ${b.indexMiB} МиБ, контейнер макс ${b.container.memMaxMiB} МиБ`);
  lines.push(`финальные индексы, мс: ${JSON.stringify(r.finalIndexMs)}`);
  const top = (m) => Object.entries(m).filter(([, v]) => (v.heapMiB ?? v) >= 1);
  lines.push(`таблицы (>=1 МиБ): ${JSON.stringify(Object.fromEntries(top(r.sizes.tables)))}`);
  lines.push(`индексы (>=1 МиБ): ${JSON.stringify(Object.fromEntries(top(r.sizes.indexes)))}; БД ${r.sizes.databaseMiB} МиБ`);
  lines.push(`вставка в готовый индекс: ${JSON.stringify(r.incrementalInsert)}`);
  lines.push(`кэш буферов: ${JSON.stringify(r.bufferCache)}`);
  for (const sc of r.recall || []) lines.push(`recall@10 [${sc.scope}] hnsw=${sc.planUsesHnsw}: ${JSON.stringify(sc.recallAt10)} scans=${JSON.stringify(sc.appScans)}`);
  for (const [pool, sc] of Object.entries(r.latency || {}))
    for (const [name, rows] of Object.entries(sc))
      for (const x of rows) lines.push(`${pool} | ${name} | conc=${x.concurrency}: p50=${x.p50} p95=${x.p95} p99=${x.p99} мс, ${x.rps} rps, err=${x.errors}, mem<=${x.containerMemMaxMiB} МиБ`);
  return lines.join('\n');
}

function summaryLatency(r) {
  const lines = [];
  for (const [pool, sc] of Object.entries(r.latency))
    for (const [name, rows] of Object.entries(sc))
      for (const x of rows) lines.push(`${pool} | ${name} | conc=${x.concurrency}: p50=${x.p50} p95=${x.p95} p99=${x.p99} мс, ${x.rps} rps, err=${x.errors}, cpu<=${x.containerCpuMaxPct}%`);
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url || process.env.KNOWLEDGE_TEST_DATABASE_URL;
  if (!url) {
    console.error('Нужен KNOWLEDGE_TEST_DATABASE_URL (или --url): сервер с правом CREATE DATABASE.');
    process.exit(2);
  }
  const { out, url: _u, latencyOnly, ...opts } = args;
  void _u;
  if (latencyOnly) {
    const r = await runLatencyOnly(url, latencyOnly, opts);
    if (out) fs.writeFileSync(out, JSON.stringify(r, null, 2));
    console.log(summaryLatency(r));
    return;
  }
  const report = await runLoadtest(url, opts);
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(summary(report));
}

if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });

module.exports = { runLoadtest, runLatencyOnly, makeVectorSpace, makeVocab, rng, DEFAULTS, toVectorLiteral };
