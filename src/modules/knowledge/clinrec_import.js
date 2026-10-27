'use strict';

// Импорт нормализованного корпуса клинреков (clinrec_corpus.js) в Postgres, схема clinrec.
// Идемпотентно: документ заменяется целиком в одной транзакции, уже посчитанные векторы
// переносятся на новые строки по совпадению embed_text_hash (= sha256 текста, уходящего в модель).
// Документ с неизменным содержимым (fingerprint) не перезаписывается. Данных пациентов здесь нет.
const crypto = require('node:crypto');
const { withTransaction } = require('./pg');
const { summarizeClinrecCorpus } = require('./clinrec_corpus');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const SLICE = 400;

function failure(code, message, extra) {
  const e = new Error(`clinrec import: ${message || code}`);
  e.code = code;
  return Object.assign(e, extra || {});
}

// Строки таблиц для одного документа. Ничего не отбрасывается: лишние поля уходят в meta/metadata.
function buildDocumentRows(corpus, documentId) {
  const doc = corpus.documents.find((d) => d.document_id === documentId);
  if (!doc) throw failure('unknown_document', `нет документа ${documentId}`);
  const byId = new Map();
  const sections = [];
  const sectionRemap = new Map(); // дубли id раздела внутри документа (дефект источника) получают суффикс
  let ord = 0;
  for (const s of corpus.sections.filter((x) => x.document_id === documentId)) {
    let id = s.id;
    const meta = {
      kind: s.kind,
      collection: s.collection,
      start_line: s.start_line,
      end_line_exclusive: s.end_line_exclusive,
      own_span: s.own_span,
    };
    if (byId.has(id)) {
      id = `${s.id}~dup${[...byId.keys()].filter((k) => k === s.id || k.startsWith(`${s.id}~dup`)).length + 1}`;
      meta.original_id = s.id;
      meta.duplicate_of = s.id;
    }
    const parent = s.parent_id ? byId.get(s.parent_id) : null;
    const row = {
      id,
      document_id: documentId,
      parent_id: s.parent_id ? sectionRemap.get(s.parent_id) || s.parent_id : null,
      level: s.level ?? 0,
      ord: ord++,
      title: s.title,
      path: parent ? `${parent.path} > ${s.title}` : s.title,
      span: s.span ?? null,
      meta,
    };
    byId.set(id, row);
    if (!sectionRemap.has(s.id)) sectionRemap.set(s.id, s.id);
    sections.push(row);
  }
  const parents = corpus.parents
    .filter((p) => p.document_id === documentId)
    .map((p) => ({
      id: p.id,
      document_id: documentId,
      section_id: p.section_id,
      heading_path: p.heading_path,
      text: p.text,
      span: p.span,
      kind: p.kind,
      title: p.title,
      source_text: p.source_text,
      metadata: {
        ...p.metadata,
        child_ids: p.child_ids,
        section_subtree_span: p.section_subtree_span,
        ancestor_context_spans: p.ancestor_context_spans,
        required_context_spans: p.required_context_spans,
        original_appendix_label: p.original_appendix_label,
      },
    }));
  const chunks = corpus.chunks
    .filter((c) => c.document_id === documentId)
    .map((c) => ({
      id: c.id,
      document_id: documentId,
      section_id: c.section_id,
      kind: c.kind,
      parent_id: c.parent_id,
      mode: c.mode,
      heading_path: c.heading_path,
      text: c.text ?? '',
      source_text: c.source_text ?? null,
      span: c.span,
      metadata: {
        ...c.metadata,
        title: c.title,
        source_kind: c.source_kind,
        collection: c.collection,
        context_parent_id: c.context_parent_id,
        neighbors: c.neighbors,
        depends_on: c.depends_on,
        atomic_oversize: c.atomic_oversize,
        retrieval_reason: c.retrieval_reason,
        est_tokens: c.est_tokens,
        oversized_candidate: c.oversized,
      },
      embed: c.embed === true,
      embed_text: c.embed ? c.embed_text : null,
      embed_text_hash: c.embed ? sha256(c.embed_text) : null,
    }));
  const references = corpus.references
    .filter((r) => r.document_id === documentId)
    .map((r, i) => ({
      id: r.id,
      document_id: documentId,
      ord: i,
      text: r.text,
      metadata: {
        number: r.number,
        span: r.span,
        source_text: r.source_text,
        continuation_lines: r.continuation_lines,
      },
    }));
  const document = {
    id: documentId,
    title: doc.title,
    source_sha256: doc.source_sha256 || '',
    version: doc.schema_version == null ? null : String(doc.schema_version),
    meta: {
      dir: doc.dir,
      guideline_id: doc.guideline_id,
      clinical_year: doc.clinical_year,
      source_file: doc.source_file,
      source_status: doc.source_status,
      references_completeness: doc.references_completeness,
      unresolved_citation_numbers: doc.unresolved_citation_numbers,
    },
  };
  const fingerprint = sha256(JSON.stringify({ document, sections, parents, chunks, references }));
  return {
    document: { ...document, meta: { ...document.meta, fingerprint } },
    sections,
    parents,
    chunks,
    references,
    fingerprint,
  };
}

const SQL = {
  document: `INSERT INTO clinrec.documents (id, title, source_sha256, version, meta)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
  sections: `INSERT INTO clinrec.sections (id, document_id, parent_id, level, ord, title, path, span, meta)
             SELECT id, document_id, parent_id, level, ord, title, path, span, meta
             FROM jsonb_to_recordset($1::jsonb) AS x(id text, document_id text, parent_id text, level int, ord int,
               title text, path text, span jsonb, meta jsonb)`,
  parents: `INSERT INTO clinrec.parents (id, document_id, section_id, heading_path, text, span, metadata, kind, title, source_text)
            SELECT id, document_id, section_id, ARRAY(SELECT jsonb_array_elements_text(heading_path)), text, span, metadata,
                   kind, title, source_text
            FROM jsonb_to_recordset($1::jsonb) AS x(id text, document_id text, section_id text, heading_path jsonb,
              text text, span jsonb, metadata jsonb, kind text, title text, source_text text)`,
  chunks: `INSERT INTO clinrec.chunks (id, document_id, section_id, kind, parent_id, mode, heading_path, text, source_text,
              span, metadata, embed, embed_text, embed_text_hash)
           SELECT id, document_id, section_id, kind, parent_id, mode, ARRAY(SELECT jsonb_array_elements_text(heading_path)),
                  text, source_text, span, metadata, embed, embed_text, embed_text_hash
           FROM jsonb_to_recordset($1::jsonb) AS x(id text, document_id text, section_id text, kind text, parent_id text,
              mode text, heading_path jsonb, text text, source_text text, span jsonb, metadata jsonb, embed boolean,
              embed_text text, embed_text_hash text)`,
  references: `INSERT INTO clinrec."references" (id, document_id, ord, text, metadata)
               SELECT id, document_id, ord, text, metadata
               FROM jsonb_to_recordset($1::jsonb) AS x(id text, document_id text, ord int, text text, metadata jsonb)`,
};

async function insertSlices(client, sql, rows) {
  for (let i = 0; i < rows.length; i += SLICE) await client.query(sql, [JSON.stringify(rows.slice(i, i + SLICE))]);
}

async function countsOf(client, documentId) {
  const { rows } = await client.query(
    `SELECT (SELECT count(*)::int FROM clinrec.sections WHERE document_id = $1) AS sections,
            (SELECT count(*)::int FROM clinrec.parents WHERE document_id = $1) AS parents,
            (SELECT count(*)::int FROM clinrec.chunks WHERE document_id = $1) AS chunks,
            (SELECT count(*)::int FROM clinrec.chunks WHERE document_id = $1 AND embed) AS embeddable,
            (SELECT count(*)::int FROM clinrec."references" WHERE document_id = $1) AS refs`,
    [documentId],
  );
  return rows[0];
}

async function importDocument(pool, rows, { force = false } = {}) {
  const id = rows.document.id;
  const expected = {
    sections: rows.sections.length,
    parents: rows.parents.length,
    chunks: rows.chunks.length,
    embeddable: rows.chunks.filter((c) => c.embed).length,
    refs: rows.references.length,
  };
  return withTransaction(pool, async (client) => {
    await client.query('SET LOCAL statement_timeout = 0');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`clinrec:${id}`]);
    const { rows: old } = await client.query("SELECT meta->>'fingerprint' AS fp FROM clinrec.documents WHERE id = $1", [
      id,
    ]);
    if (!force && old.length && old[0].fp === rows.fingerprint) {
      const now = await countsOf(client, id);
      if (JSON.stringify(now) === JSON.stringify(expected))
        return { id, status: 'unchanged', counts: now, vectors_kept: 0 };
    }
    // Векторы и причины пропуска переживают замену, если текст для модели не изменился.
    await client.query(
      `CREATE TEMP TABLE keep_embeddings ON COMMIT DROP AS
         SELECT id, embedding, embedding_model, embedding_hash, embed_skip_reason, embed_text_hash
         FROM clinrec.chunks WHERE document_id = $1 AND embed AND (embedding IS NOT NULL OR embed_skip_reason IS NOT NULL)`,
      [id],
    );
    await client.query('DELETE FROM clinrec.documents WHERE id = $1', [id]);
    const d = rows.document;
    await client.query(SQL.document, [d.id, d.title, d.source_sha256, d.version, JSON.stringify(d.meta)]);
    await insertSlices(client, SQL.sections, rows.sections);
    await insertSlices(client, SQL.parents, rows.parents);
    await insertSlices(client, SQL.chunks, rows.chunks);
    await insertSlices(client, SQL.references, rows.references);
    const restored = await client.query(
      `UPDATE clinrec.chunks c
          SET embedding = k.embedding, embedding_model = k.embedding_model, embedding_hash = k.embedding_hash,
              embed_skip_reason = k.embed_skip_reason
         FROM keep_embeddings k
        WHERE k.id = c.id AND c.embed AND k.embed_text_hash = c.embed_text_hash
          AND (k.embedding_hash IS NULL OR k.embedding_hash = c.embed_text_hash)`,
    );
    const got = await countsOf(client, id);
    for (const key of Object.keys(expected)) {
      if (got[key] !== expected[key])
        throw failure('count_mismatch', `${id}: ${key} записано ${got[key]}, в корпусе ${expected[key]}`);
    }
    return { id, status: old.length ? 'replaced' : 'created', counts: got, vectors_kept: restored.rowCount };
  });
}

/**
 * @param {import('pg').Pool} pool
 * @param {object} corpus результат loadClinrecCorpus
 * @param {{documents?: string[], force?: boolean, onDocument?: Function}} [options]
 */
async function importClinrec(pool, corpus, options = {}) {
  const started = Date.now();
  if (corpus.errors.length) {
    throw failure('corpus_errors', `корпус содержит ${corpus.errors.length} ошибок, импорт заблокирован`, {
      errors: corpus.errors.slice(0, 10),
    });
  }
  const summary = summarizeClinrecCorpus(corpus);
  const wanted = options.documents && options.documents.length ? new Set(options.documents) : null;
  const results = [];
  for (const d of corpus.documents) {
    if (wanted && !wanted.has(d.document_id)) continue;
    const rows = buildDocumentRows(corpus, d.document_id);
    const r = await importDocument(pool, rows, options);
    const s = summary.by_document[d.document_id];
    // Сверка с by_document корпуса.
    const mismatch = ['chunks', 'parents', 'sections'].filter((k) => r.counts[k] !== s[k]);
    if (r.counts.embeddable !== s.embeddable) mismatch.push('embeddable');
    if (r.counts.refs !== s.references) mismatch.push('references');
    if (mismatch.length) throw failure('summary_mismatch', `${d.document_id}: расхождение ${mismatch.join(',')}`);
    results.push(r);
    if (options.onDocument) options.onDocument(r);
  }
  const total = results.reduce(
    (a, r) => {
      for (const k of Object.keys(r.counts)) a[k] = (a[k] || 0) + r.counts[k];
      a.vectors_kept += r.vectors_kept;
      return a;
    },
    { vectors_kept: 0 },
  );
  return { documents: results, total, warnings: corpus.warnings.length, ms: Date.now() - started };
}

module.exports = { importClinrec, buildDocumentRows, importDocument, sha256 };
