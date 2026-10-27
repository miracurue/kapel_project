'use strict';

// Поиск по клиническим рекомендациям (схема clinrec) с разворачиванием parent–child.
// Находится маленький дочерний чанк; модели отдаётся контекст по режиму самого чанка:
//   self   — сам чанк;
//   parent — полный родительский фрагмент (clinrec.parents.text) вместо чанка;
//   window — чанк + соседние чанки (metadata.neighbors: previous_id/next_id/limit_each_side).
// Явные зависимости (metadata.depends_on.required_chunk_ids) добавляются как relation:'required'
// (рекурсивно, не глубже 3 уровней, не более 20 чанков); always_include_spans отдаются
// как координаты. Форма metadata — соглашение импорта клинреков (neighbors/depends_on из
// clinrec_corpus.js); если ключей нет, window деградирует до self.
// Результаты с общим родителем сливаются (matched_chunks перечисляет попадания).
const {
  MAX_DEPTH,
  LEXICAL_DEPTH_MIN,
  failure,
  queryTerm,
  integer,
  pageArgs,
  rrfFuse,
  docFilter,
  stringList,
  intersect,
  lexicalRanked,
  semanticRanked,
} = require('./rrf');

const MODES = ['lexical', 'semantic', 'hybrid'];
const KINDS = ['main', 'method', 'appendix', 'supporting', 'reference'];
const CONTEXT_MAX_CHARS = 12000; // потолок текста контекста одного результата; остальное — getClinrecSection
const REQUIRED_MAX = 20;
const REQUIRED_DEPTH = 3;
const WINDOW_MAX_SIDE = 5;
const FOCUS_PAGE_MAX = 60000; // страница раздела с подсвеченным фрагментом не больше этого

function documentScope(options) {
  return intersect(
    stringList(options.scope?.documentIds ?? options.scope?.clinrecDocumentIds, 'invalid_scope'),
    stringList(options.documentIds, 'invalid_document_filter'),
  );
}

async function loadChunks(pool, ids) {
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT c.id, c.document_id, c.section_id, c.kind, c.mode, c.parent_id, c.heading_path, c.text, c.span, c.metadata,
            d.title AS document_title
     FROM clinrec.chunks c JOIN clinrec.documents d ON d.id = c.document_id WHERE c.id = ANY($1::text[])`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

function meta(chunk) {
  const m = chunk.metadata || {};
  const n = m.neighbors || {};
  const d = m.depends_on || {};
  return {
    previous: n.previous_id ?? null,
    next: n.next_id ?? null,
    side: Number.isInteger(n.limit_each_side) ? Math.min(WINDOW_MAX_SIDE, Math.max(0, n.limit_each_side)) : 1,
    required: Array.isArray(d.required_chunk_ids) ? d.required_chunk_ids.filter((x) => typeof x === 'string') : [],
    spans: Array.isArray(d.always_include_spans) ? d.always_include_spans : [],
  };
}

// Соседи окна: идём по previous_id/next_id до limit_each_side шагов, только внутри документа.
async function windowChunks(pool, chunk, cache) {
  const m = meta(chunk);
  const out = { before: [], after: [] };
  for (const [dir, start] of [
    ['before', m.previous],
    ['after', m.next],
  ]) {
    let id = start;
    for (let i = 0; i < m.side && id; i++) {
      if (!cache.has(id)) for (const [k, v] of await loadChunks(pool, [id])) cache.set(k, v);
      const c = cache.get(id);
      if (!c || c.document_id !== chunk.document_id) break;
      out[dir].push(c);
      id = dir === 'before' ? meta(c).previous : meta(c).next;
    }
  }
  out.before.reverse();
  return out;
}

async function requiredChunks(pool, chunk, cache) {
  const seen = new Set([chunk.id]);
  const out = [];
  let frontier = [chunk];
  for (let depth = 0; depth < REQUIRED_DEPTH && frontier.length && out.length < REQUIRED_MAX; depth++) {
    const ids = [...new Set(frontier.flatMap((c) => meta(c).required))].filter((id) => !seen.has(id));
    const missing = ids.filter((id) => !cache.has(id));
    for (const [k, v] of await loadChunks(pool, missing)) cache.set(k, v);
    frontier = [];
    for (const id of ids) {
      seen.add(id);
      const c = cache.get(id);
      if (!c || c.document_id !== chunk.document_id || out.length >= REQUIRED_MAX) continue;
      out.push(c);
      frontier.push(c);
    }
  }
  return out;
}

function capText(parts) {
  const text = parts.join('\n\n');
  if (text.length <= CONTEXT_MAX_CHARS) return { text, chars: text.length, truncated: false };
  return { text: text.slice(0, CONTEXT_MAX_CHARS), chars: text.length, truncated: true };
}

async function expand(pool, hit, chunk, parents, cache) {
  const m = meta(chunk);
  const part = (c, relation) => ({
    chunk_id: c.id,
    relation,
    heading_path: c.heading_path,
    span: c.span,
    text: c.text,
  });
  let type = chunk.mode;
  let parts;
  let parent = null;
  if (type === 'parent') {
    parent = chunk.parent_id ? parents.get(chunk.parent_id) : null;
    if (!parent)
      type = 'self'; // нет родителя в хранилище: честно отдаём сам чанк
    else
      parts = [
        {
          parent_id: parent.id,
          relation: 'parent',
          heading_path: parent.heading_path,
          span: parent.span,
          text: parent.text,
        },
      ];
  }
  if (type === 'window') {
    const w = await windowChunks(pool, chunk, cache);
    parts = [...w.before.map((c) => part(c, 'previous')), part(chunk, 'match'), ...w.after.map((c) => part(c, 'next'))];
  }
  if (type === 'self') parts = [part(chunk, 'match')];
  const required = await requiredChunks(pool, chunk, cache);
  for (const c of required) if (!parts.some((p) => p.chunk_id === c.id)) parts.push(part(c, 'required'));
  const capped = capText(parts.map((p) => p.text));
  return {
    expansion: type,
    declared_mode: chunk.mode,
    context: capped.text,
    context_chars: capped.chars,
    context_truncated: capped.truncated,
    parts: parts.map(({ text, ...rest }) => ({ ...rest, chars: text.length })),
    always_include_spans: m.spans,
    ...(parent ? { parent_id: parent.id } : {}),
  };
}

async function searchClinrec(pool, query, options = {}) {
  const term = queryTerm(query);
  const mode = options.mode || 'lexical';
  if (!MODES.includes(mode)) throw failure('invalid_mode');
  const { limit, offset } = pageArgs(options);
  const kinds = options.kinds === undefined ? null : stringList(options.kinds, 'invalid_kinds', 5);
  if (kinds && kinds.some((k) => !KINDS.includes(k))) throw failure('invalid_kinds');
  const expandResults = options.expand !== false;
  const ids = documentScope(options);
  const base = { mode, review_required: true, source: 'clinrec' };
  const emptyPage = { results: [], total: 0, offset, limit, hasMore: false };
  if (ids && !ids.length) return { ...emptyPage, ...base, available: true, fallback: null, reason: null, model: null };
  const spec = {
    table: 'clinrec.chunks',
    idColumn: 'id',
    // Только индексируемые чанки: supporting и литература (embed=false) в поиск не входят и векторов не имеют.
    filters: [
      { sql: 'embed' },
      docFilter('document_id', ids),
      kinds ? { sql: 'kind = ANY($@::text[])', params: [kinds] } : null,
    ],
  };
  // Результаты сливаются по родителю, поэтому берём запас кандидатов и режем страницу после слияния.
  const wanted = offset + limit + 1;
  const depth = Math.min(MAX_DEPTH, Math.max(LEXICAL_DEPTH_MIN, wanted * 3));
  if (mode !== 'lexical' && wanted > MAX_DEPTH) throw failure('invalid_pagination');

  let semantic = { available: false, rows: [] };
  let lexList = [];
  let lexTotal = 0;
  let queryForm = null;
  let lexicalSkipped = null;
  let candidates;
  if (mode !== 'lexical') semantic = await semanticRanked(pool, spec, term, { client: options.client, depth });
  if (mode !== 'semantic') {
    const lex = await lexicalRanked(pool, spec, term, { depth, offset: 0, maxOrMatches: options.maxOrMatches });
    lexList = lex.rows;
    lexTotal = lex.total;
    queryForm = lex.form;
    lexicalSkipped = lex.skipped || null;
  }
  if (mode === 'semantic') {
    candidates = semantic.rows.map((r, i) => ({ id: r.id, score: r.score, lexical_rank: null, semantic_rank: i + 1 }));
  } else if (mode === 'hybrid' && semantic.available) {
    candidates = rrfFuse({ lexical: lexList, semantic: semantic.rows }).map((r) => ({
      id: r.id,
      score: r.score,
      lexical_rank: r.ranks.lexical ?? null,
      semantic_rank: r.ranks.semantic ?? null,
    }));
  } else {
    candidates = lexList.map((r, i) => ({ id: r.id, score: r.score, lexical_rank: i + 1, semantic_rank: null }));
  }
  const cache = await loadChunks(
    pool,
    candidates.map((c) => c.id),
  );
  const parentIds = [
    ...new Set([...cache.values()].filter((c) => c.mode === 'parent' && c.parent_id).map((c) => c.parent_id)),
  ];
  const parents = new Map();
  if (parentIds.length && expandResults) {
    const { rows } = await pool.query(
      'SELECT id, document_id, section_id, heading_path, text, span FROM clinrec.parents WHERE id = ANY($1::text[])',
      [parentIds],
    );
    for (const p of rows) parents.set(p.id, p);
  }
  // Слияние по ключу контекста: parent -> один результат на родителя, иначе по чанку.
  const groups = [];
  const byKey = new Map();
  for (const cand of candidates) {
    const chunk = cache.get(cand.id);
    if (!chunk) continue;
    const key =
      expandResults && chunk.mode === 'parent' && parents.has(chunk.parent_id)
        ? `p:${chunk.parent_id}`
        : `c:${chunk.id}`;
    const hit = {
      chunk_id: chunk.id,
      score: cand.score,
      lexical_rank: cand.lexical_rank,
      semantic_rank: cand.semantic_rank,
    };
    if (byKey.has(key)) byKey.get(key).matched_chunks.push(hit);
    else {
      const g = { key, chunk, score: cand.score, matched_chunks: [hit] };
      byKey.set(key, g);
      groups.push(g);
    }
  }
  const matchType = mode === 'hybrid' && semantic.available ? 'hybrid' : mode === 'semantic' ? 'semantic' : 'lexical';
  const pageGroups = groups.slice(offset, offset + limit);
  const results = [];
  for (const g of pageGroups) {
    const c = g.chunk;
    const ex = expandResults
      ? await expand(pool, g, c, parents, cache)
      : {
          expansion: 'none',
          declared_mode: c.mode,
          context: c.text,
          context_chars: c.text.length,
          context_truncated: false,
          parts: [],
        };
    results.push({
      id: g.key,
      document: { id: c.document_id, title: c.document_title },
      kind: c.kind,
      heading_path: ex.parent_id ? parents.get(ex.parent_id).heading_path : c.heading_path,
      section_id: (ex.parent_id ? parents.get(ex.parent_id).section_id : c.section_id) || null,
      span: ex.parent_id ? parents.get(ex.parent_id).span : c.span,
      score: g.score,
      match_type: matchType,
      matched_chunks: g.matched_chunks,
      ...ex,
      review_required: true,
    });
  }
  const exhaustive = candidates.length < depth && (mode === 'lexical' ? lexTotal <= depth : true);
  return {
    results,
    total: groups.length,
    offset,
    limit,
    hasMore: offset + limit < groups.length,
    totalExact: exhaustive,
    mode,
    available: mode !== 'semantic' || semantic.available,
    fallback: mode === 'hybrid' && !semantic.available ? 'lexical' : null,
    reason: mode !== 'lexical' && !semantic.available ? semantic.reason : null,
    model: semantic.model || null,
    query_form: queryForm,
    lexical_skipped: lexicalSkipped,
    ...(lexicalSkipped && (mode === 'lexical' || !semantic.available)
      ? {
          hint: 'Запрос состоит из слишком частых слов: лексический поиск пропущен. Уточните запрос или используйте semantic/hybrid.',
        }
      : {}),
    vector_scan: semantic.scan || null,
    review_required: true,
    source: 'clinrec',
  };
}

// Раздел клинрека целиком (с подразделами) постранично: тексты родительских фрагментов
// (и самостоятельных чанков без родителя) поддерева в порядке sections.ord. Либо один родитель (parentId).
async function getClinrecSection(pool, options = {}) {
  const { documentId, sectionId, parentId } = options;
  const ids = documentScope(options);
  if (typeof documentId !== 'string' || !documentId || (ids && !ids.includes(documentId)))
    throw failure('document_not_found');
  if ((sectionId === undefined) === (parentId === undefined)) throw failure('invalid_tool_arguments');
  const doc = (
    await pool.query('SELECT id, title, version, source_sha256 FROM clinrec.documents WHERE id = $1', [documentId])
  ).rows[0];
  if (!doc) throw failure('document_not_found');
  let parts;
  let section = null;
  if (parentId !== undefined) {
    const { rows } = await pool.query(
      'SELECT id, heading_path, span, text FROM clinrec.parents WHERE id = $1 AND document_id = $2',
      [parentId, documentId],
    );
    if (!rows.length) throw failure('section_not_found');
    parts = rows;
  } else {
    const { rows: s } = await pool.query(
      'SELECT id, parent_id, level, ord, title, path, span FROM clinrec.sections WHERE id = $1 AND document_id = $2',
      [sectionId, documentId],
    );
    if (!s.length) throw failure('section_not_found');
    section = s[0];
    const { rows } = await pool.query(
      `WITH RECURSIVE t AS (
         SELECT id, ord FROM clinrec.sections WHERE id = $1 AND document_id = $2
         UNION ALL SELECT s.id, s.ord FROM clinrec.sections s JOIN t ON s.parent_id = t.id)
       SELECT * FROM (
         SELECT p.id, p.section_id, p.heading_path, p.span, p.text, t.ord, 'parent' AS source, 0 AS seq FROM clinrec.parents p JOIN t ON t.id = p.section_id
         UNION ALL
         (SELECT DISTINCT ON (c.id) c.id, c.section_id, c.heading_path, c.span, c.text, t.ord, 'chunk' AS source,
                 COALESCE((c.metadata->>'order')::int, 0) AS seq
          FROM clinrec.chunks c JOIN t ON t.id = c.section_id OR c.metadata->'section_ids' ? t.id
          WHERE c.parent_id IS NULL AND c.kind <> 'reference' ORDER BY c.id, t.ord)) x`,
      [sectionId, documentId],
    );
    const start = (span) => {
      const v = span && (span.start ?? span.char_start ?? span.start_char ?? span.start_offset);
      return Number.isFinite(Number(v)) ? Number(v) : Infinity;
    };
    parts = rows.sort(
      (a, b) => a.ord - b.ord || start(a.span) - start(b.span) || (a.seq ?? 0) - (b.seq ?? 0) || (a.id < b.id ? -1 : 1),
    );
    if (!parts.length) throw failure('section_not_found');
  }
  const full = parts.map((p) => p.text).join('\n\n');
  const total = full.length;
  const cursor = integer(options.cursor, 0, total);
  let size = integer(options.maxChars, 12000, 1000000);
  if (!size) throw failure('invalid_pagination');
  // Границы частей в тексте раздела (части склеены пустой строкой): по ним клиент подсвечивает найденный фрагмент.
  let at = 0;
  const bounds = parts.map((p) => {
    const b = { start: at, end: at + p.text.length };
    at = b.end + 2;
    return b;
  });
  // Фрагмент, найденный поиском: его часть — родитель чанка (если он есть в разделе) или сам чанк.
  let mark = null;
  if (options.focusChunk !== undefined && sectionId !== undefined) {
    const { rows } = await pool.query('SELECT id, parent_id FROM clinrec.chunks WHERE id = $1 AND document_id = $2', [
      String(options.focusChunk),
      documentId,
    ]);
    const c = rows[0];
    const i = c ? parts.findIndex((p) => p.id === c.parent_id || p.id === c.id) : -1;
    if (i >= 0) {
      mark = { part_id: parts[i].id, start: bounds[i].start, end: bounds[i].end };
      // Страница с подсветкой доходит до конца фрагмента (но не дальше разумного предела).
      if (cursor === 0 && mark.end > size) size = Math.min(mark.end + 400, FOCUS_PAGE_MAX);
    }
  }
  const end = Math.min(total, cursor + size);
  return {
    document: { id: doc.id, title: doc.title, version: doc.version, sha256: doc.source_sha256 },
    section: section && {
      id: section.id,
      level: section.level,
      title: section.title,
      path: section.path,
      span: section.span,
    },
    parts: parts.map((p, i) => ({
      id: p.id,
      section_id: p.section_id || null,
      heading_path: p.heading_path,
      span: p.span,
      chars: p.text.length,
      start: bounds[i].start,
      end: bounds[i].end,
    })),
    mark,
    text: full.slice(cursor, end),
    cursor,
    nextCursor: end < total ? end : null,
    total,
    hasMore: end < total,
    review_required: true,
    source: 'clinrec',
  };
}

module.exports = { searchClinrec, getClinrecSection, KINDS, CONTEXT_MAX_CHARS };
