'use strict';

// Поиск по инструкциям лекарств и реестру побочных реакций в Postgres (схема med).
// Контракты и поля ответов повторяют SQLite-версию (src/modules/medication_knowledge/search.js).
// Все функции асинхронные, первый аргумент — pool. Область поиска options.scope
// ({documentIds, innNorm}) задаёт сервер; options.drugIds модель может лишь сузить.
const {
  MAX_DEPTH,
  LEXICAL_DEPTH_MIN,
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
  resolveMedDocumentIds,
  lexicalRanked,
  semanticRanked,
} = require('./rrf');

const MODES = ['lexical', 'semantic', 'hybrid'];
const TOO_BROAD_HINT =
  'Запрос состоит из слишком частых слов: лексический поиск пропущен. Уточните запрос (название препарата, редкий термин) или используйте semantic/hybrid.';
const chunkSpec = (filters) => ({ table: 'med.chunks', idColumn: 'id', filters });

function contextOf(options) {
  if (options.context !== undefined && (typeof options.context !== 'string' || options.context.length > 200))
    throw failure('invalid_context');
  return options.context === undefined ? undefined : normalizeText(options.context);
}

async function searchDrugs(pool, options = {}) {
  const q = queryTerm(options.query);
  const paging = pageArgs(options);
  const ids = await resolveMedDocumentIds(pool, options.scope, options.drugIds);
  if (ids && !ids.length) return page([], paging);
  const f = bindFilter([docFilter('id', ids)], 2);
  const names = ['inn', 'drug_label', 'source_file', 'id', "coalesce(trade_name, '')"].map((x) => sqlNorm(x));
  const exactNames = ['inn', 'drug_label', 'id', "coalesce(trade_name, '')"].map((x) => sqlNorm(x));
  const { rows } = await pool.query(
    `SELECT id, inn, drug_label AS label, source_file AS file, sha256, trade_name,
            GREATEST(${names.map((n) => sqlNameScore(n, '$1')).join(', ')}) AS score,
            (${exactNames.map((n) => `${n} = $1`).join(' OR ')}) AS exact
     FROM med.documents WHERE ${f.sql}
     ORDER BY score DESC, id`,
    [q, ...f.params],
  );
  const mapped = rows
    .map((r) => ({
      id: r.id,
      inn: r.inn,
      label: r.label,
      file: r.file,
      sha256: r.sha256,
      trade_name: r.trade_name,
      score: r.exact ? 1 : r.score,
      match_type: r.exact ? 'exact' : 'fuzzy',
      review_required: true,
    }))
    .filter((r) => r.match_type === 'exact' || r.score >= FUZZY_THRESHOLD);
  const exact = mapped.filter((r) => r.match_type === 'exact');
  return page(exact.length ? exact : mapped, paging);
}

async function inScope(pool, documentId, options) {
  if (typeof documentId !== 'string' || !documentId || documentId.length > 200) throw failure('document_not_found');
  const ids = await resolveMedDocumentIds(pool, options.scope);
  if (ids && !ids.includes(documentId)) throw failure('document_not_found');
}

async function getToc(pool, options = {}) {
  const { documentId } = options;
  await inScope(pool, documentId, options);
  const doc = (
    await pool.query(
      'SELECT id, inn, drug_label AS label, source_file AS file, sha256 FROM med.documents WHERE id = $1',
      [documentId],
    )
  ).rows[0];
  if (!doc) throw failure('document_not_found');
  const { rows } = await pool.query(
    `SELECT id, document_id, parent_id, level, ord, title, path, start_char AS start_offset, end_char AS end_offset,
            start_line AS line_start, page AS page_start
     FROM med.sections WHERE document_id = $1 ORDER BY ord, level`,
    [documentId],
  );
  return { document: doc, sections: rows, review_required: true };
}

// Раздел вместе с потомками: диапазон [min(start), max(end)) по поддереву; текст постранично, без усечения.
async function readSection(pool, options = {}) {
  const { documentId, sectionId } = options;
  await inScope(pool, documentId, options);
  if (typeof sectionId !== 'string' || !sectionId) throw failure('section_not_found');
  const { rows } = await pool.query(
    `WITH RECURSIVE t AS (
       SELECT * FROM med.sections WHERE document_id = $1 AND id = $2
       UNION ALL SELECT s.* FROM med.sections s JOIN t ON s.parent_id = t.id AND s.document_id = $1)
     SELECT r.id, r.document_id, r.parent_id, r.level, r.title, r.path, r.page AS page_start, r.start_line AS line_start,
            (SELECT min(start_char) FROM t) AS start_offset, (SELECT max(end_char) FROM t) AS end_offset,
            d.source_file, d.sha256 AS source_hash
     FROM med.sections r JOIN med.documents d ON d.id = r.document_id
     WHERE r.document_id = $1 AND r.id = $2`,
    [documentId, sectionId],
  );
  if (!rows.length) throw failure('section_not_found');
  const section = rows[0];
  const total = section.end_offset - section.start_offset;
  const cursor = integer(options.cursor, 0, total);
  const size = integer(options.maxChars, 12000, 1000000);
  if (!size) throw failure('invalid_pagination');
  const end = Math.min(total, cursor + size);
  const { rows: text } = await pool.query(
    'SELECT substr(markdown, $2::int, $3::int) AS text FROM med.documents WHERE id = $1',
    [documentId, section.start_offset + cursor + 1, end - cursor],
  );
  return {
    ...section,
    text: text[0].text,
    cursor,
    nextCursor: end < total ? end : null,
    total,
    hasMore: end < total,
    review_required: true,
  };
}

async function headingPaths(pool, sectionIds) {
  if (!sectionIds.length) return new Map();
  const { rows } = await pool.query(
    `WITH RECURSIVE a AS (
       SELECT id, parent_id, title FROM med.sections WHERE id = ANY($1::text[])
       UNION SELECT s.id, s.parent_id, s.title FROM med.sections s JOIN a ON s.id = a.parent_id)
     SELECT id, parent_id, title FROM a`,
    [sectionIds],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function searchText(pool, options = {}) {
  const query = queryTerm(options.query);
  const mode = options.mode || 'lexical';
  if (!MODES.includes(mode)) throw failure('invalid_mode');
  const { limit, offset } = pageArgs(options);
  const ids = await resolveMedDocumentIds(pool, options.scope, options.drugIds);
  const base = { mode, review_required: true };
  if (ids && !ids.length)
    return { ...page([], { limit, offset }), ...base, available: true, fallback: null, reason: null, model: null };
  const spec = chunkSpec([docFilter('document_id', ids)]);
  const wanted = offset + limit + 1;
  if (mode !== 'lexical' && wanted > MAX_DEPTH) throw failure('invalid_pagination');

  let ranked; // [{id, score, lexical_rank?, semantic_rank?}] — страница или полный список кандидатов
  let total;
  let totalExact = true;
  let semantic = { available: false, rows: [] };
  let queryForm = null;
  let lexicalSkipped = null;
  let scan = null;
  const depth = Math.min(MAX_DEPTH, Math.max(LEXICAL_DEPTH_MIN, wanted));
  if (mode === 'lexical') {
    const lex = await lexicalRanked(pool, spec, query, { depth: limit, offset, maxOrMatches: options.maxOrMatches });
    queryForm = lex.form;
    lexicalSkipped = lex.skipped || null;
    total = lex.total;
    ranked = lex.rows.map((r, i) => ({ id: r.id, score: r.score, lexical_rank: offset + i + 1 }));
  } else {
    if (mode === 'semantic')
      semantic = await semanticRanked(pool, spec, query, { client: options.client, depth: wanted });
    else semantic = await semanticRanked(pool, spec, query, { client: options.client, depth });
    scan = semantic.scan || null;
    if (mode === 'semantic') {
      const all = semantic.rows.map((r, i) => ({ id: r.id, score: r.score, semantic_rank: i + 1 }));
      ranked = all.slice(offset, offset + limit);
      total = all.length;
      totalExact = all.length < wanted;
    } else {
      const lex = await lexicalRanked(pool, spec, query, { depth, offset: 0, maxOrMatches: options.maxOrMatches });
      queryForm = lex.form;
      lexicalSkipped = lex.skipped || null;
      const lexList = lex.rows.map((r) => ({ id: r.id, score: r.score }));
      if (semantic.available) {
        const fused = rrfFuse({ lexical: lexList, semantic: semantic.rows });
        const all = fused.map((r) => ({
          id: r.id,
          score: r.score,
          lexical_rank: r.ranks.lexical ?? null,
          semantic_rank: r.ranks.semantic ?? null,
        }));
        ranked = all.slice(offset, offset + limit);
        total = all.length;
        totalExact = lexList.length < depth && semantic.rows.length < depth;
      } else {
        const all = lexList.map((r, i) => ({ id: r.id, score: r.score, lexical_rank: i + 1 }));
        ranked = all.slice(offset, offset + limit);
        total = lex.total;
      }
    }
  }
  const details = await chunkDetails(
    pool,
    ranked.map((r) => r.id),
  );
  const paths = await headingPaths(pool, [...new Set([...details.values()].flatMap((c) => c.section_ids))]);
  const headingPath = (id) => {
    const result = [];
    for (let s = paths.get(id); s; s = paths.get(s.parent_id)) result.unshift(s.title);
    return result;
  };
  const matchType = mode === 'hybrid' && semantic.available ? 'hybrid' : mode === 'semantic' ? 'semantic' : 'lexical';
  const results = ranked.map((r) => {
    const c = details.get(r.id);
    return {
      ...c,
      score: r.score,
      lexical_rank: r.lexical_rank ?? null,
      semantic_rank: r.semantic_rank ?? null,
      section_paths: c.section_ids.map(headingPath),
      match_type: matchType,
      review_required: true,
    };
  });
  return {
    results,
    total,
    offset,
    limit,
    hasMore: offset + limit < total,
    totalExact,
    mode,
    available: mode !== 'semantic' || semantic.available,
    fallback: mode === 'hybrid' && !semantic.available ? 'lexical' : null,
    reason: mode !== 'lexical' && !semantic.available ? semantic.reason : null,
    model: semantic.model || null,
    query_form: queryForm,
    lexical_skipped: lexicalSkipped,
    ...(lexicalSkipped && (mode === 'lexical' || !semantic.available) ? { hint: TOO_BROAD_HINT } : {}),
    vector_scan: scan,
    review_required: true,
  };
}

async function chunkDetails(pool, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const { rows } = await pool.query(
    `SELECT c.id, c.document_id, c.section_id, c.section_ids, c.ord AS ordinal, c.start_char AS start_offset,
            c.end_char AS end_offset, c.text AS content, c.content_hash, c.oversized AS oversize,
            d.inn, d.drug_label AS label, d.source_file, d.sha256 AS source_hash
     FROM med.chunks c JOIN med.documents d ON d.id = c.document_id WHERE c.id = ANY($1::text[])`,
    [ids],
  );
  for (const r of rows) map.set(r.id, { ...r, section_ids: r.section_ids.length ? r.section_ids : [r.section_id] });
  return map;
}

// ---------- побочные реакции ----------
async function effectEvidence(pool, effectIds, ids, accept) {
  if (!effectIds.length) return new Map();
  const f = bindFilter([docFilter('l.document_id', ids)], 2);
  const { rows: links } = await pool.query(
    `SELECT l.id, l.effect_id, l.document_id, l.block_id, l.context, l.raw_json,
            d.inn, d.drug_label AS label, d.source_file AS file, d.sha256
     FROM med.effect_links l JOIN med.documents d ON d.id = l.document_id
     WHERE l.effect_id = ANY($1::text[]) AND ${f.sql} ORDER BY l.document_id, l.id`,
    [effectIds, ...f.params],
  );
  const kept = links.filter((l) => accept(l.context));
  const blockIds = new Set();
  const mentionIds = new Set();
  for (const l of kept) {
    blockIds.add(l.block_id);
    for (const b of l.raw_json.qualifier_block_ids || []) blockIds.add(b);
    for (const m of l.raw_json.source_mention_ids || []) mentionIds.add(m);
  }
  const blocks = new Map(
    (await pool.query('SELECT id, raw_json FROM med.blocks WHERE id = ANY($1::text[])', [[...blockIds]])).rows.map(
      (r) => [r.id, r.raw_json],
    ),
  );
  const mentions = new Map(
    (
      await pool.query('SELECT id, raw_json FROM med.source_mentions WHERE id = ANY($1::text[])', [[...mentionIds]])
    ).rows.map((r) => [r.id, r.raw_json]),
  );
  const byEffect = new Map();
  for (const l of kept) {
    const raw = l.raw_json;
    const evidence = {
      ...raw,
      occurrence_id: l.id,
      effect_id: l.effect_id,
      block_id: l.block_id,
      source: { file: l.file, sha256: l.sha256 },
      block: blocks.get(l.block_id) ?? null,
      qualifier_blocks: (raw.qualifier_block_ids || []).map((id) => blocks.get(id) ?? null).filter(Boolean),
      source_mentions: (raw.source_mention_ids || []).map((id) => mentions.get(id) ?? null).filter(Boolean),
      review_required: true,
    };
    if (!byEffect.has(l.effect_id)) byEffect.set(l.effect_id, new Map());
    const docs = byEffect.get(l.effect_id);
    if (!docs.has(l.document_id))
      docs.set(l.document_id, {
        document_id: l.document_id,
        inn: l.inn,
        label: l.label,
        source_file: l.file,
        source_hash: l.sha256,
        evidence: [],
        review_required: true,
      });
    docs.get(l.document_id).evidence.push(evidence);
  }
  return new Map([...byEffect].map(([k, v]) => [k, [...v.values()]]));
}

async function searchAdverseEffects(pool, options = {}) {
  const query = queryTerm(options.query);
  const paging = pageArgs(options);
  const context = contextOf(options);
  const accept = (linkContext) => context === undefined || normalizeText(linkContext || '') === context;
  const ids = await resolveMedDocumentIds(pool, options.scope, options.drugIds);
  const includeCandidates = options.includeCandidates !== false;

  const empty = {
    confirmed: page([], paging),
    candidates: page([], paging),
    confirmed_drug_ids: [],
    confirmed_drug_total: 0,
    semantic: { available: false, reason: 'semantic_not_requested' },
    review_required: true,
    interpretation:
      'Matches describe only the supplied instructions. Candidates are not confirmed synonyms; no match does not prove absence of an adverse effect.',
  };
  if (ids && !ids.length) return empty;

  // Реакции, у которых есть связи в области (и с нужным контекстом), и их инструкции.
  const lf = bindFilter([docFilter('document_id', ids)], 1);
  const { rows: linkRows } = await pool.query(
    `SELECT effect_id, document_id, context FROM med.effect_links WHERE ${lf.sql}`,
    lf.params,
  );
  const drugMap = new Map();
  for (const l of linkRows) {
    if (!accept(l.context)) continue;
    if (!drugMap.has(l.effect_id)) drugMap.set(l.effect_id, new Set());
    drugMap.get(l.effect_id).add(l.document_id);
  }
  const allowedIds = [...drugMap.keys()];
  const confirmed = [];
  const candidates = [];
  const base = (e) => ({
    effect_id: e.id,
    name: e.name,
    category: e.category,
    aliases: e.aliases,
    drug_total: drugMap.get(e.id).size,
    review_required: true,
  });
  if (allowedIds.length) {
    const { rows: effects } = await pool.query(
      `SELECT e.id, e.name, e.category, e.raw_json->'aliases' AS aliases,
              ${sqlNorm('e.name')} = $1 AS exact_name,
              coalesce(bool_or(a.normalized = $1), false) AS alias,
              GREATEST(${sqlNameScore(sqlNorm('e.name'), '$1')},
                       coalesce(max(${sqlNameScore('a.normalized', '$1')}), 0)) AS score
       FROM med.effects e LEFT JOIN med.effect_aliases a ON a.effect_id = e.id
       WHERE e.id = ANY($2::text[]) GROUP BY e.id ORDER BY e.id`,
      [query, allowedIds],
    );
    for (const e of effects) {
      if (e.exact_name || e.alias)
        confirmed.push({ ...base(e), score: 1, match_type: e.exact_name ? 'exact' : 'alias' });
      else if (includeCandidates && e.score >= FUZZY_THRESHOLD)
        candidates.push({ ...base(e), score: e.score, match_type: 'fuzzy' });
    }
  }
  let semantic = { available: false, reason: 'semantic_not_requested' };
  if (includeCandidates && options.semantic === true && allowedIds.length) {
    const spec = {
      table: 'med.effects',
      idColumn: 'id',
      filters: [{ sql: 'id = ANY($@::text[])', params: [allowedIds] }],
    };
    const wanted = Math.min(MAX_DEPTH, Math.max(50, paging.offset + paging.limit + 1));
    semantic = await semanticRanked(pool, spec, query, { client: options.client, depth: wanted });
    if (semantic.available) {
      const known = new Map();
      const need = [];
      for (const [i, r] of semantic.rows.entries()) {
        if (confirmed.some((e) => e.effect_id === r.id) || r.score < 0.3) continue;
        const existing = candidates.find((e) => e.effect_id === r.id);
        if (existing) {
          existing.semantic_score = r.score;
          existing.semantic_rank = i + 1;
        } else {
          need.push(r.id);
          known.set(r.id, { score: r.score, rank: i + 1 });
        }
      }
      if (need.length) {
        const { rows } = await pool.query(
          `SELECT id, name, category, raw_json->'aliases' AS aliases FROM med.effects WHERE id = ANY($1::text[])`,
          [need],
        );
        for (const e of rows) {
          const k = known.get(e.id);
          candidates.push({
            ...base(e),
            score: k.score,
            semantic_score: k.score,
            semantic_rank: k.rank,
            match_type: 'semantic',
          });
        }
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.effect_id.localeCompare(b.effect_id));
  const confirmedDrugs = [...new Set(confirmed.flatMap((e) => [...drugMap.get(e.effect_id)]))];
  const withEvidence = async (rows) => {
    const result = page(rows, paging);
    const evidence = await effectEvidence(
      pool,
      result.results.map((e) => e.effect_id),
      ids,
      accept,
    );
    result.results = result.results.map((e) => ({ ...e, drugs: evidence.get(e.effect_id) || [] }));
    return result;
  };
  return {
    confirmed: await withEvidence(confirmed),
    candidates: await withEvidence(candidates),
    confirmed_drug_ids: confirmedDrugs,
    confirmed_drug_total: confirmedDrugs.length,
    semantic: { available: semantic.available, reason: semantic.reason || null },
    review_required: true,
    interpretation: empty.interpretation,
  };
}

async function status(pool) {
  const one = async (sql) => (await pool.query(sql)).rows[0];
  const med = await one(
    `SELECT (SELECT count(*)::int FROM med.documents) AS documents, (SELECT count(*)::int FROM med.sections) AS sections,
            (SELECT count(*)::int FROM med.chunks) AS chunks, (SELECT count(*)::int FROM med.effects) AS effects,
            (SELECT count(*)::int FROM med.effect_links) AS links`,
  );
  const vectors = (
    await pool.query(
      `SELECT 'chunks' AS entity, embedding_model AS model, count(*)::int AS n FROM med.chunks WHERE embedding IS NOT NULL GROUP BY 2
       UNION ALL SELECT 'effects', embedding_model, count(*)::int FROM med.effects WHERE embedding IS NOT NULL GROUP BY 2
       ORDER BY 1, 2`,
    )
  ).rows;
  return { ...med, embedding_namespaces: vectors, review_required: true };
}

module.exports = { searchDrugs, getToc, readSection, searchText, searchAdverseEffects, status };
