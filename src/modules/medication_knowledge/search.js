'use strict';
const store = require('./store');
const { normalize } = require('./corpus');
const { namespaceStatus, encodeVector, failure } = require('./index_embeddings');

function integer(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > max) throw failure('invalid_pagination');
  return value;
}
function queryTerm(value) {
  if (typeof value !== 'string' || value.length > 1000 || !normalize(value)) throw failure('invalid_query');
  return normalize(value);
}
function page(rows, { limit, offset } = {}) {
  limit = integer(limit, 20, 500);
  offset = integer(offset, 0, 1000000);
  return {
    results: rows.slice(offset, offset + limit),
    total: rows.length,
    offset,
    limit,
    hasMore: offset + limit < rows.length,
  };
}
function filters(options = {}) {
  const ids = options.drugIds;
  if (
    ids !== undefined &&
    (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => typeof id !== 'string' || id.length > 200))
  )
    throw failure('invalid_drug_filter');
  if (options.context !== undefined && (typeof options.context !== 'string' || options.context.length > 200))
    throw failure('invalid_context');
  return (id, context) =>
    (!ids || ids.includes(id)) &&
    (options.context === undefined || normalize(options.context) === normalize(context || ''));
}
function similarity(a, b) {
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return (Math.min(a.length, b.length) / Math.max(a.length, b.length)) * 0.4 + 0.55;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(next[j - 1] + 1, prev[j] + 1, prev[j - 1] + Number(a[i - 1] !== b[j - 1]));
    prev = next;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
function searchDrugs(db, options = {}) {
  const q = queryTerm(options.query);
  const rows = store
    .listDocuments(db)
    .map((doc) => {
      const score = Math.max(...[doc.inn, doc.label, doc.file, doc.id].map((s) => similarity(q, normalize(s))));
      return {
        ...doc,
        score,
        match_type: [doc.inn, doc.label, doc.id].some((s) => normalize(s) === q) ? 'exact' : 'fuzzy',
        review_required: true,
      };
    })
    .filter((r) => r.score >= 0.55)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const exact = rows.filter((row) => row.match_type === 'exact');
  return page(exact.length ? exact : rows, options);
}
function getToc(db, { documentId } = {}) {
  const doc = store.getDocument(db, documentId);
  if (!doc) throw failure('document_not_found');
  return {
    document: { id: doc.id, inn: doc.inn, label: doc.label, file: doc.file, sha256: doc.sha256 },
    sections: store.getToc(db, documentId),
    review_required: true,
  };
}
function readSection(db, { documentId, sectionId, cursor, maxChars } = {}) {
  const section = store.readSection(db, documentId, sectionId);
  if (!section) throw failure('section_not_found');
  const offset = integer(cursor, 0, section.text.length);
  const size = integer(maxChars, 12000, 1000000);
  if (!size) throw failure('invalid_pagination');
  const end = Math.min(section.text.length, offset + size);
  const total = section.text.length;
  return {
    ...section,
    text: section.text.slice(offset, end),
    cursor: offset,
    nextCursor: end < total ? end : null,
    total,
    hasMore: end < total,
  };
}
function lexicalChunks(db, query, allowed) {
  const expression = query
    .split(/\s+/u)
    .map((token) => '"' + token.replaceAll('"', '""') + '"*')
    .join(' OR ');
  return db
    .prepare(
      'SELECT id,bm25(chunks_fts) AS rank FROM chunks_fts WHERE chunks_fts MATCH ? AND generation=? ORDER BY rank,id',
    )
    .all(expression, store.activeGeneration(db))
    .filter((r) => allowed.has(r.id))
    .map((r, i) => ({ id: r.id, score: -r.rank, rank: i + 1 }));
}
async function semanticScores(db, publicReferenceTerm, entityType, allowed, { client, model = client?.model } = {}) {
  if (!client || typeof client.embed !== 'function')
    return { available: false, reason: 'embedding_client_unavailable', rows: [] };
  const namespace = namespaceStatus(db, model).find((ns) => ns.ready && ns.model === model);
  if (!namespace) return { available: false, reason: 'embedding_index_incomplete', rows: [] };
  const generation = store.activeGeneration(db);
  const response = await client.embed([publicReferenceTerm]);
  if (
    !response ||
    response.model !== namespace.model ||
    !Array.isArray(response.vectors) ||
    response.vectors.length !== 1
  )
    throw failure('invalid_embedding_response');
  const query = encodeVector(response.vectors[0], namespace.dimensions);
  if (store.activeGeneration(db) !== generation) throw failure('generation_changed');
  const rows = db
    .prepare('SELECT entity_id,vector,norm FROM embeddings WHERE generation=? AND model=? AND entity_type=?')
    .all(generation, model, entityType)
    .filter((r) => allowed.has(r.entity_id))
    .map((r) => {
      let dot = 0;
      for (let i = 0; i < namespace.dimensions; i++) dot += query.blob.readFloatLE(i * 4) * r.vector.readFloatLE(i * 4);
      return { id: r.entity_id, score: Math.min(1, Math.max(-1, dot / (query.norm * r.norm))) };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((r, i) => ({ ...r, rank: i + 1 }));
  return { available: true, model, dimensions: namespace.dimensions, rows };
}
async function searchText(db, options = {}) {
  const query = queryTerm(options.query);
  const mode = options.mode || 'lexical';
  if (!['lexical', 'semantic', 'hybrid'].includes(mode)) throw failure('invalid_mode');
  const accept = filters(options);
  const generation = store.activeGeneration(db);
  const chunks = db
    .prepare(
      'SELECT c.*,d.inn,d.label,d.file AS source_file,d.sha256 AS source_hash FROM chunks c JOIN documents d ON d.generation=c.generation AND d.id=c.document_id WHERE c.generation=? ORDER BY c.id',
    )
    .all(generation)
    .filter((c) => accept(c.document_id));
  const allowed = new Set(chunks.map((c) => c.id));
  const lexical = mode !== 'semantic' ? lexicalChunks(db, query, allowed) : [];
  const semantic =
    mode !== 'lexical' ? await semanticScores(db, query, 'chunk', allowed, options) : { available: false, rows: [] };
  let ranked;
  if (mode === 'hybrid' && semantic.available) {
    const scores = new Map();
    for (const list of [lexical, semantic.rows])
      for (const r of list) scores.set(r.id, (scores.get(r.id) || 0) + 1 / (60 + r.rank));
    ranked = [...scores]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  } else ranked = mode === 'semantic' ? semantic.rows : lexical;
  const map = new Map(chunks.map((c) => [c.id, c]));
  const sections = db.prepare('SELECT * FROM sections WHERE generation=?').all(generation);
  const sectionMap = new Map(sections.map((s) => [s.id, s]));
  function headingPath(id) {
    const result = [];
    for (let s = sectionMap.get(id); s; s = sectionMap.get(s.parent_id)) result.unshift(s.title);
    return result;
  }
  const rows = ranked.map((r) => {
    const c = map.get(r.id);
    const ids = c.section_ids ? JSON.parse(c.section_ids) : [c.section_id];
    return {
      ...c,
      score: r.score,
      section_paths: ids.map(headingPath),
      match_type: mode === 'hybrid' && semantic.available ? 'hybrid' : mode === 'semantic' ? 'semantic' : 'lexical',
      review_required: true,
    };
  });
  return {
    ...page(rows, options),
    mode,
    available: mode !== 'semantic' || semantic.available,
    fallback: mode === 'hybrid' && !semantic.available ? 'lexical' : null,
    reason: mode !== 'lexical' && !semantic.available ? semantic.reason : null,
    model: semantic.model || null,
    review_required: true,
  };
}
function effectEvidence(db, effectId, accept) {
  const generation = store.activeGeneration(db);
  const links = db
    .prepare(
      'SELECT l.*,d.inn,d.label,d.file,d.sha256 FROM effect_links l JOIN documents d ON d.generation=l.generation AND d.id=l.document_id WHERE l.generation=? AND l.effect_id=? ORDER BY l.document_id,l.id',
    )
    .all(generation, effectId)
    .filter((r) => accept(r.document_id, r.context));
  const block = db.prepare('SELECT raw_json FROM blocks WHERE generation=? AND id=?');
  const mention = db.prepare('SELECT raw_json FROM source_mentions WHERE generation=? AND id=?');
  const grouped = new Map();
  for (const l of links) {
    const raw = JSON.parse(l.raw_json);
    const evidence = {
      ...raw,
      occurrence_id: l.id,
      effect_id: effectId,
      block_id: l.block_id,
      source: { file: l.file, sha256: l.sha256 },
      block: JSON.parse(block.get(generation, l.block_id).raw_json),
      qualifier_blocks: (raw.qualifier_block_ids || []).map((id) => JSON.parse(block.get(generation, id).raw_json)),
      source_mentions: (raw.source_mention_ids || []).map((id) => JSON.parse(mention.get(generation, id).raw_json)),
      review_required: true,
    };
    if (!grouped.has(l.document_id))
      grouped.set(l.document_id, {
        document_id: l.document_id,
        inn: l.inn,
        label: l.label,
        source_file: l.file,
        source_hash: l.sha256,
        evidence: [],
        review_required: true,
      });
    grouped.get(l.document_id).evidence.push(evidence);
  }
  return [...grouped.values()];
}
async function searchAdverseEffects(db, options = {}) {
  const query = queryTerm(options.query);
  const accept = filters(options);
  const generation = store.activeGeneration(db);
  const effects = db.prepare('SELECT * FROM effects WHERE generation=? ORDER BY id').all(generation);
  const aliases = db.prepare('SELECT effect_id,normalized FROM effect_aliases WHERE generation=?').all(generation);
  const confirmed = [];
  const candidates = [];
  const drugMap = new Map();
  for (const link of db
    .prepare('SELECT effect_id,document_id,context FROM effect_links WHERE generation=?')
    .all(generation)) {
    if (!accept(link.document_id, link.context)) continue;
    if (!drugMap.has(link.effect_id)) drugMap.set(link.effect_id, new Set());
    drugMap.get(link.effect_id).add(link.document_id);
  }
  const allowed = new Set(drugMap.keys());
  for (const e of effects) {
    if (!allowed.has(e.id)) continue;
    const names = aliases.filter((a) => a.effect_id === e.id).map((a) => a.normalized);
    const exact = normalize(e.name) === query;
    const alias = names.includes(query);
    const score = Math.max(...names.map((name) => similarity(query, name)));
    const result = {
      effect_id: e.id,
      name: e.name,
      category: e.category,
      aliases: JSON.parse(e.raw_json).aliases,
      score: exact || alias ? 1 : score,
      match_type: exact ? 'exact' : alias ? 'alias' : 'fuzzy',
      drug_total: drugMap.get(e.id).size,
      review_required: true,
    };
    if (exact || alias) confirmed.push(result);
    else if (options.includeCandidates !== false && score >= 0.5) candidates.push(result);
  }
  let semantic = { available: false, reason: 'semantic_not_requested' };
  if (options.includeCandidates !== false && options.semantic === true) {
    semantic = await semanticScores(db, query, 'effect', allowed, options);
    for (const r of semantic.rows) {
      if (confirmed.some((e) => e.effect_id === r.id) || r.score < 0.3) continue;
      const existing = candidates.find((e) => e.effect_id === r.id);
      if (existing) existing.semantic_score = r.score;
      else {
        const e = effects.find((e) => e.id === r.id);
        candidates.push({
          effect_id: e.id,
          name: e.name,
          category: e.category,
          aliases: JSON.parse(e.raw_json).aliases,
          score: r.score,
          match_type: 'semantic',
          drug_total: drugMap.get(e.id).size,
          review_required: true,
        });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.effect_id.localeCompare(b.effect_id));
  const confirmedDrugs = [...new Set(confirmed.flatMap((e) => [...drugMap.get(e.effect_id)]))];
  function evidencePage(rows) {
    const result = page(rows, options);
    result.results = result.results.map((e) => ({ ...e, drugs: effectEvidence(db, e.effect_id, accept) }));
    return result;
  }
  return {
    confirmed: evidencePage(confirmed),
    candidates: evidencePage(candidates),
    confirmed_drug_ids: confirmedDrugs,
    confirmed_drug_total: confirmedDrugs.length,
    semantic: { available: semantic.available, reason: semantic.reason || null },
    review_required: true,
    interpretation:
      'Matches describe only the supplied instructions. Candidates are not confirmed synonyms; no match does not prove absence of an adverse effect.',
  };
}
function status(db, options) {
  return { ...store.getStatus(db, options), embedding_namespaces: namespaceStatus(db), review_required: true };
}
module.exports = { searchDrugs, getToc, readSection, searchText, searchAdverseEffects, status };
