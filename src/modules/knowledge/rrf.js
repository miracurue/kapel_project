'use strict';

// Общие примитивы поиска по Postgres-хранилищу знаний: ошибки, нормализация, пагинация,
// слияние рангов (RRF), кэш вектора запроса, лексический и векторный (HNSW) поиск.
// Модули search_med.js и search_clinrec.js строят на них свои запросы.
const { toVectorLiteral } = require('./pg');

const DIMENSIONS = 2560;
const RRF_K = 60;
const MAX_DEPTH = 5000; // максимум кандидатов для semantic/hybrid (offset+limit)
const LEXICAL_DEPTH_MIN = 100;
const QUERY_CACHE_SIZE = 500;
const FUZZY_THRESHOLD = 0.4; // порог pg_trgm-близости названий

function failure(code) {
  const error = new Error(`knowledge search: ${code}`);
  error.code = code;
  return error;
}

// Та же нормализация, что у SQLite-версии (corpus.normalize).
function normalizeText(value) {
  return String(value)
    .toLocaleLowerCase('ru')
    .replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
// То же самое на стороне SQL (для сравнения нормализованных названий).
const sqlNorm = (expr) => `btrim(regexp_replace(replace(lower(${expr}), 'ё', 'е'), '[^[:alnum:]]+', ' ', 'g'))`;

// Близость строк в SQL: точное = 1, вхождение = 0.55..0.95, иначе триграммы pg_trgm.
const sqlNameScore = (x, q) =>
  `(CASE WHEN ${x} = ${q} THEN 1.0::float8
         WHEN length(${x}) > 0 AND (strpos(${x}, ${q}) > 0 OR strpos(${q}, ${x}) > 0)
           THEN (least(length(${x}), length(${q}))::float8 / greatest(length(${x}), length(${q}))) * 0.4 + 0.55
         ELSE similarity(${x}, ${q})::float8 END)`;

function queryTerm(value) {
  if (typeof value !== 'string' || value.length > 1000 || !normalizeText(value)) throw failure('invalid_query');
  return normalizeText(value);
}
function integer(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > max) throw failure('invalid_pagination');
  return value;
}
function pageArgs(options = {}) {
  const limit = integer(options.limit, 20, 500);
  const offset = integer(options.offset, 0, 1000000);
  if (limit < 1) throw failure('invalid_pagination');
  return { limit, offset };
}
function page(rows, { limit, offset }) {
  return {
    results: rows.slice(offset, offset + limit),
    total: rows.length,
    offset,
    limit,
    hasMore: offset + limit < rows.length,
  };
}

// RRF: lists = { имя: [{id}, ...] в порядке ранга }. Возвращает все id с суммой 1/(k+rank)
// и рангами по каждому списку (для отладки).
function rrfFuse(lists, k = RRF_K) {
  const acc = new Map();
  for (const [name, list] of Object.entries(lists)) {
    list.forEach((item, i) => {
      const rank = i + 1;
      const entry = acc.get(item.id) || { id: item.id, score: 0, ranks: {} };
      entry.score += 1 / (k + rank);
      entry.ranks[name] = rank;
      acc.set(item.id, entry);
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------- scope / фильтры ----------
// filter = { sql: 'document_id = ANY($@::text[])', params: [...] }; $@ -> следующий номер параметра.
function bindFilter(filters, startIndex) {
  const parts = [];
  const params = [];
  for (const f of filters.filter(Boolean)) {
    let sql = f.sql;
    for (const p of f.params || []) {
      params.push(p);
      sql = sql.replace('$@', `$${startIndex + params.length - 1}`);
    }
    parts.push(`(${sql})`);
  }
  return { sql: parts.length ? parts.join(' AND ') : 'TRUE', params };
}
const docFilter = (column, ids) => (ids === null ? null : { sql: `${column} = ANY($@::text[])`, params: [ids] });

function stringList(value, code, max = 1000) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > max || value.some((x) => typeof x !== 'string' || !x || x.length > 200))
    throw failure(code);
  return [...new Set(value)];
}
function intersect(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  const set = new Set(b);
  return a.filter((x) => set.has(x));
}

// Область поиска лекарств: scope задаёт сервер ({documentIds, innNorm}), drugIds модель может
// только сузить. null = без ограничения; [] = пусто.
async function resolveMedDocumentIds(pool, scope = {}, drugIds) {
  if (scope !== null && typeof scope !== 'object') throw failure('invalid_scope');
  let ids = stringList(scope?.documentIds, 'invalid_scope');
  if (scope?.innNorm !== undefined) {
    if (typeof scope.innNorm !== 'string' || !normalizeText(scope.innNorm)) throw failure('invalid_scope');
    const { rows } = await pool.query('SELECT document_id FROM med.drug_map WHERE inn_name_norm = $1', [
      normalizeText(scope.innNorm),
    ]);
    ids = intersect(
      ids,
      rows.map((r) => r.document_id),
    );
  }
  return intersect(ids, stringList(drugIds, 'invalid_drug_filter', 100));
}

// ---------- кэш вектора запроса ----------
const caches = new WeakMap(); // клиент -> Map (LRU)
function embedQuery(client, term, { dimensions = DIMENSIONS } = {}) {
  let cache = caches.get(client);
  if (!cache) caches.set(client, (cache = new Map()));
  const key = `${client.model}\u0000${term}`;
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  // Наружу уходит только очищенный поисковый термин.
  const promise = (async () => {
    const response = await client.embed([term]);
    if (
      !response ||
      response.model !== client.model ||
      !Array.isArray(response.vectors) ||
      response.vectors.length !== 1 ||
      (!Array.isArray(response.vectors[0]) && !ArrayBuffer.isView(response.vectors[0])) ||
      response.vectors[0].length !== dimensions
    )
      throw failure('invalid_embedding_response');
    const v = Array.from(response.vectors[0]);
    if (!v.every(Number.isFinite) || v.every((x) => x === 0)) throw failure('invalid_embedding_response');
    return { model: response.model, literal: toVectorLiteral(v) };
  })();
  cache.set(key, promise);
  promise.catch(() => cache.get(key) === promise && cache.delete(key));
  if (cache.size > QUERY_CACHE_SIZE) cache.delete(cache.keys().next().value);
  return promise;
}
const cacheSize = (client) => caches.get(client)?.size || 0;

// ---------- лексический поиск ----------
// Максимум совпадений OR-формы, которые ещё имеет смысл ранжировать. Больше — запрос слишком общий
// (частые слова), ранжирование десятков тысяч строк стоит сотен мс CPU и ничего не различает;
// лексическая ветка пропускается (lexical_skipped:'too_broad'), hybrid остаётся на векторной.
const OR_MAX_MATCHES = (() => {
  const n = Number(process.env.KNOWLEDGE_LEXICAL_OR_MAX_MATCHES);
  return Number.isInteger(n) && n > 0 ? n : 3000;
})();
function orTsQuery(term) {
  const tokens = [...new Set(term.split(' ').filter((t) => t.length > 1))].slice(0, 20);
  return tokens.map((t) => `${t}:*`).join(' | ');
}
// Возвращает {rows:[{id,score}], total, form, skipped?}. Сначала websearch (AND, ts_rank_cd); если пусто —
// OR-форма (префиксы, ts_rank_cd, как раньше) с предохранителем: если оценка планировщика (до ранжирования) или
// фактическое число совпадений больше OR_MAX_MATCHES — skipped:'too_broad' и пустой список.
async function lexicalRanked(pool, spec, term, { depth, offset = 0, maxOrMatches = OR_MAX_MATCHES }) {
  const f = bindFilter(spec.filters, 2);
  const run = async (tsq, param, o = { depth, offset }) => {
    const { rows } = await pool.query(
      `WITH q AS (SELECT ${tsq} AS tq)
       SELECT ${spec.idColumn} AS id, ts_rank_cd(tsv, q.tq, 1)::float8 AS score, count(*) OVER ()::int AS total
       FROM ${spec.table}, q WHERE tsv @@ q.tq AND ${f.sql}
       ORDER BY score DESC, ${spec.idColumn} LIMIT ${Number(o.depth)} OFFSET ${Number(o.offset)}`,
      [param, ...f.params],
    );
    return rows;
  };
  // Оценка числа совпадений OR-формы по статистике планировщика (EXPLAIN, ~1 мс): точный подсчёт
  // частых слов стоит 100+ мс. Оценка по MCELEM-статистике tsvector близка к факту для частых лексем.
  const orEstimate = async (param) => {
    const { rows } = await pool.query(
      `EXPLAIN (FORMAT JSON) SELECT 1 FROM ${spec.table} WHERE tsv @@ to_tsquery('russian', $1) AND ${f.sql}`,
      [param, ...f.params],
    );
    return Number(rows[0]['QUERY PLAN'][0].Plan['Plan Rows']);
  };
  let rows = await run(`websearch_to_tsquery('russian', $1)`, term);
  let form = 'and';
  let skipped = null;
  if (!rows.length) {
    // Пусто: либо AND ничего не находит (тогда пробуем OR), либо offset за концом списка.
    const probe = offset > 0 ? await run(`websearch_to_tsquery('russian', $1)`, term, { depth: 1, offset: 0 }) : [];
    const or = orTsQuery(term);
    if (!probe.length && or) {
      form = 'or';
      if ((await orEstimate(or)) > maxOrMatches) skipped = 'too_broad';
      else {
        rows = await run(`to_tsquery('russian', $1)`, or);
        // страница за концом списка: общее число совпадений берём из первой строки
        const head =
          rows.length || !offset ? rows : await run(`to_tsquery('russian', $1)`, or, { depth: 1, offset: 0 });
        if (head.length && head[0].total > maxOrMatches) {
          rows = [];
          skipped = 'too_broad';
        }
      }
    }
  }
  // total считается окном по всем совпадениям; при offset за пределами списка строк нет.
  const result = {
    rows: rows.map((r) => ({ id: r.id, score: r.score })),
    total: rows.length ? rows[0].total : 0,
    form,
  };
  if (skipped) result.skipped = skipped;
  return result;
}

// ---------- векторный поиск ----------
const versions = new WeakMap();
async function pgvectorVersion(pool) {
  if (!versions.has(pool)) {
    const { rows } = await pool.query(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
    versions.set(pool, rows[0]?.extversion || '0');
  }
  return versions.get(pool);
}
const iterativeSupported = (v) => {
  const [major, minor] = v.split('.').map(Number);
  return major > 0 || minor >= 8;
};

// Доступность векторов в области: все строки области должны иметь вектор нужной модели.
// Результат кэшируется на короткое время (полный скан области стоит 20-30 мс на 60 тыс. чанков);
// импорт/embed в этом же процессе сбрасывает кэш через clearEmbeddingStatusCache(), в других процессах
// изменение видно не позже чем через TTL.
const STATUS_TTL_MS = (() => {
  const n = Number(process.env.KNOWLEDGE_STATUS_CACHE_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 15000;
})();
const statusCaches = new WeakMap(); // pool -> Map(key -> {at, value})
let statusEpoch = 0; // смена эпохи обесценивает все ключи (WeakMap целиком не очистить)
function clearEmbeddingStatusCache(pool) {
  if (pool) statusCaches.delete(pool);
  else statusEpoch += 1;
}
async function embeddingStatus(pool, spec, model) {
  const key = `${statusEpoch}\u0000${spec.table}\u0000${model}\u0000${JSON.stringify(spec.filters.filter(Boolean))}`;
  let cache = statusCaches.get(pool);
  if (!cache) statusCaches.set(pool, (cache = new Map()));
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;
  const value = await embeddingStatusUncached(pool, spec, model);
  if (STATUS_TTL_MS > 0) {
    if (cache.size >= 200) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), value });
  }
  return value;
}
async function embeddingStatusUncached(pool, spec, model) {
  const f = bindFilter(spec.filters, 2);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE embedding IS NOT NULL AND embedding_model = $1)::int AS ok,
            count(*) FILTER (WHERE embedding IS NOT NULL)::int AS any
     FROM ${spec.table} WHERE ${f.sql}`,
    [model, ...f.params],
  );
  const { total, ok, any } = rows[0];
  if (total === 0) return { ready: true, total, ok };
  if (ok === total) return { ready: true, total, ok };
  return {
    ready: false,
    total,
    ok,
    reason: any > ok && ok === 0 ? 'embedding_model_mismatch' : 'embedding_index_incomplete',
  };
}

// kNN по cosine с фильтром. HNSW с WHERE без итеративного скана отдаёт меньше строк, чем есть
// в области (фильтр применяется к ef_search кандидатам). Поэтому: hnsw.iterative_scan (pgvector
// >= 0.8) + проверка полноты; если строк меньше, чем должно быть — точный запасной проход.
async function knnRanked(pool, spec, vector, model, depth) {
  const f = bindFilter(spec.filters, 3);
  const where = `embedding IS NOT NULL AND embedding_model = $2 AND ${f.sql}`;
  const params = [vector, model, ...f.params];
  const id = spec.idColumn;
  const iterative = iterativeSupported(await pgvectorVersion(pool));
  const client = await pool.connect();
  let rows;
  let scan = iterative ? 'hnsw-iterative' : 'hnsw';
  try {
    await client.query('BEGIN READ ONLY');
    if (iterative) {
      await client.query(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      await client.query(`SET LOCAL hnsw.max_scan_tuples = 300000`);
    }
    await client.query(`SET LOCAL hnsw.ef_search = ${Math.min(1000, Math.max(40, depth))}`);
    ({ rows } = await client.query(
      `SELECT ${id} AS id, dist FROM (
         SELECT ${id}, (embedding <=> $1::halfvec)::float8 AS dist FROM ${spec.table}
         WHERE ${where} ORDER BY embedding <=> $1::halfvec LIMIT ${Number(depth)}
       ) s ORDER BY dist, id`,
      params,
    ));
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* соединение потеряно */
    }
    throw error;
  } finally {
    client.release();
  }
  if (rows.length < depth) {
    // Сколько строк должно быть в области; если индекс отдал меньше — точный проход без индекса.
    const fc = bindFilter(spec.filters, 2);
    const { rows: c } = await pool.query(
      `SELECT count(*)::int AS n FROM ${spec.table} WHERE embedding IS NOT NULL AND embedding_model = $1 AND ${fc.sql}`,
      [model, ...fc.params],
    );
    const expected = Math.min(depth, c[0].n);
    if (rows.length < expected) {
      ({ rows } = await pool.query(
        `WITH s AS MATERIALIZED (SELECT ${id} AS id, embedding FROM ${spec.table} WHERE ${where})
         SELECT id, (embedding <=> $1::halfvec)::float8 AS dist FROM s ORDER BY dist, id LIMIT ${Number(depth)}`,
        params,
      ));
      scan = 'exact';
    }
  }
  return { rows: rows.map((r) => ({ id: r.id, score: 1 - r.dist, distance: r.dist })), scan };
}

// Семантическая ветка: проверка клиента и индекса, запрос эмбеддинга, kNN.
// Любой сбой эмбеддинг-запроса -> available:false (hybrid откатится к lexical).
async function semanticRanked(pool, spec, term, { client, depth }) {
  if (!client || typeof client.embed !== 'function')
    return { available: false, reason: 'embedding_client_unavailable', rows: [] };
  if (!client.model) return { available: false, reason: 'embedding_client_unavailable', rows: [] };
  const status = await embeddingStatus(pool, spec, client.model);
  if (!status.ready) return { available: false, reason: status.reason, rows: [] };
  if (status.total === 0) return { available: true, model: client.model, rows: [], scan: 'none' };
  let query;
  try {
    query = await embedQuery(client, term);
  } catch (error) {
    return { available: false, reason: 'embedding_request_failed', error_code: error?.code || 'unknown', rows: [] };
  }
  const { rows, scan } = await knnRanked(pool, spec, query.literal, query.model, depth);
  return { available: true, model: query.model, rows, scan };
}

module.exports = {
  DIMENSIONS,
  RRF_K,
  MAX_DEPTH,
  LEXICAL_DEPTH_MIN,
  QUERY_CACHE_SIZE,
  FUZZY_THRESHOLD,
  failure,
  normalizeText,
  sqlNorm,
  sqlNameScore,
  queryTerm,
  integer,
  pageArgs,
  page,
  rrfFuse,
  bindFilter,
  docFilter,
  stringList,
  intersect,
  resolveMedDocumentIds,
  embedQuery,
  cacheSize,
  lexicalRanked,
  embeddingStatus,
  clearEmbeddingStatusCache,
  OR_MAX_MATCHES,
  knnRanked,
  semanticRanked,
};
