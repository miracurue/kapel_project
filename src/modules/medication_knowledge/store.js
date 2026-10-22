'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { randomUUID } = require('node:crypto');
const { migrate } = require('./schema');
const { DEFAULT_SOURCE_DIR, loadCorpus, normalize } = require('./corpus');
function openKnowledgeStore({ filename = path.resolve(__dirname, '../../../data/medication_knowledge.sqlite3') } = {}) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  try {
    migrate(db, filename);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function activeGeneration(db) {
  return db.prepare("SELECT value FROM knowledge_meta WHERE key='active_generation'").get()?.value || null;
}
function batches(db, rows, insert) {
  for (let i = 0; i < rows.length; i += 500)
    db.transaction((batch) => {
      for (const row of batch) insert(row);
    }).immediate(rows.slice(i, i + 500));
}
function importCorpus(db, { sourceDir = DEFAULT_SOURCE_DIR, rebuild = false } = {}) {
  const corpus = loadCorpus(sourceDir);
  const active = activeGeneration(db);
  if (
    !rebuild &&
    active &&
    db.prepare('SELECT fingerprint FROM generations WHERE id=?').get(active)?.fingerprint === corpus.fingerprint
  )
    return { generation: active, changed: false, ...counts(db) };
  const generation = rebuild ? `${corpus.fingerprint}:${randomUUID()}` : corpus.fingerprint;
  if (db.prepare('SELECT id FROM generations WHERE id=?').get(generation)) {
    db.transaction(() => {
      db.prepare('DELETE FROM documents_fts WHERE generation=?').run(generation);
      db.prepare('DELETE FROM chunks_fts WHERE generation=?').run(generation);
      db.prepare('DELETE FROM effects_fts WHERE generation=?').run(generation);
      db.prepare('DELETE FROM generations WHERE id=?').run(generation);
    }).immediate();
  }
  db.transaction(() =>
    db
      .prepare("INSERT INTO generations VALUES (?,?,?,?,?,'building')")
      .run(generation, corpus.fingerprint, new Date().toISOString(), corpus.registryHash, corpus.registryRaw),
  ).immediate();
  const docs = db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?)');
  const docFts = db.prepare('INSERT INTO documents_fts VALUES (?,?,?,?,?,?)');
  batches(db, corpus.documents, (d) => {
    docs.run(
      generation,
      d.id,
      d.inn,
      d.label,
      d.file,
      d.sha256,
      d.content,
      JSON.stringify(corpus.registry.drugs.find((r) => r.id === d.id)),
    );
    docFts.run(generation, d.id, d.inn, d.label, d.file, d.content);
  });
  const sectionInsert = db.prepare(
    'INSERT INTO sections VALUES (@generation,@id,@document_id,@parent_id,@level,@title,@start_offset,@end_offset,@line_start,@line_end,@page_start,@page_end)',
  );
  batches(
    db,
    corpus.documents.flatMap((d) => d.sections),
    (s) => sectionInsert.run({ generation, ...s }),
  );
  const chunkInsert = db.prepare(
    'INSERT INTO chunks VALUES (@generation,@id,@document_id,@section_id,@section_ids,@ordinal,@start_offset,@end_offset,@content,@content_hash,@oversize,@line_start,@line_end,@page_start,@page_end)',
  );
  const chunkFts = db.prepare('INSERT INTO chunks_fts VALUES (?,?,?)');
  batches(
    db,
    corpus.documents.flatMap((d) => d.chunks),
    (c) => {
      chunkInsert.run({ generation, ...c });
      chunkFts.run(generation, c.id, c.content);
    },
  );
  const effectInsert = db.prepare('INSERT INTO effects VALUES (?,?,?,?,?,?)');
  const aliasInsert = db.prepare('INSERT INTO effect_aliases VALUES (?,?,?,?)');
  const effectFts = db.prepare('INSERT INTO effects_fts VALUES (?,?,?,?)');
  batches(db, corpus.registry.effects, (e) => {
    effectInsert.run(generation, e.id, e.name, e.category, e.status, JSON.stringify(e));
    effectFts.run(generation, e.id, e.name, e.aliases.join(' '));
  });
  batches(
    db,
    corpus.registry.effects.flatMap((e) => [...new Set([e.name, ...e.aliases])].map((alias) => ({ id: e.id, alias }))),
    (a) => aliasInsert.run(generation, a.id, a.alias, normalize(a.alias)),
  );
  const blockInsert = db.prepare('INSERT INTO blocks VALUES (?,?,?,?)');
  batches(db, corpus.registry.blocks, (b) => blockInsert.run(generation, b.id, b.drug, JSON.stringify(b)));
  const mentionInsert = db.prepare('INSERT INTO source_mentions VALUES (?,?,?,?)');
  batches(db, corpus.registry.source_mentions, (m) => mentionInsert.run(generation, m.id, m.drug, JSON.stringify(m)));
  const linkInsert = db.prepare('INSERT INTO effect_links VALUES (?,?,?,?,?,?,?,?,?)');
  batches(db, corpus.registry.occurrences, (o) =>
    linkInsert.run(generation, o.id, o.effect, o.drug, o.block, o.frequency, o.context, o.raw_term, JSON.stringify(o)),
  );
  db.transaction(() => {
    db.prepare("UPDATE generations SET state='ready' WHERE id=?").run(generation);
    db.prepare(
      "INSERT INTO knowledge_meta(key,value) VALUES ('active_generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(generation);
  }).immediate();
  return { generation, changed: true, ...counts(db) };
}
function counts(db) {
  const generation = activeGeneration(db);
  return {
    documents: db.prepare('SELECT count(*) AS n FROM documents WHERE generation=?').get(generation).n,
    sections: db.prepare('SELECT count(*) AS n FROM sections WHERE generation=?').get(generation).n,
    chunks: db.prepare('SELECT count(*) AS n FROM chunks WHERE generation=?').get(generation).n,
    effects: db.prepare('SELECT count(*) AS n FROM effects WHERE generation=?').get(generation).n,
    links: db.prepare('SELECT count(*) AS n FROM effect_links WHERE generation=?').get(generation).n,
  };
}
function getStatus(db, { sourceDir = DEFAULT_SOURCE_DIR } = {}) {
  const generation = activeGeneration(db);
  let stale = false;
  let error = null;
  try {
    stale =
      loadCorpus(sourceDir).fingerprint !==
      db.prepare('SELECT fingerprint FROM generations WHERE id=?').get(generation)?.fingerprint;
  } catch (err) {
    stale = true;
    error = err.message;
  }
  return { generation, stale, error, ...counts(db) };
}
function listDocuments(db) {
  return db
    .prepare('SELECT id,inn,label,file,sha256 FROM documents WHERE generation=? ORDER BY id')
    .all(activeGeneration(db));
}
function getDocument(db, id) {
  return db.prepare('SELECT * FROM documents WHERE generation=? AND id=?').get(activeGeneration(db), id) || null;
}
function getToc(db, id) {
  return db
    .prepare('SELECT * FROM sections WHERE generation=? AND document_id=? ORDER BY start_offset,level')
    .all(activeGeneration(db), id);
}
function readSection(db, documentId, sectionId) {
  const section = db
    .prepare('SELECT * FROM sections WHERE generation=? AND document_id=? AND id=?')
    .get(activeGeneration(db), documentId, sectionId);
  if (!section) return null;
  const doc = getDocument(db, documentId);
  return {
    ...section,
    text: doc.content.slice(section.start_offset, section.end_offset),
    source_file: doc.file,
    source_hash: doc.sha256,
    review_required: true,
  };
}
module.exports = {
  openKnowledgeStore,
  importCorpus,
  activeGeneration,
  counts,
  getStatus,
  listDocuments,
  getDocument,
  getToc,
  readSection,
};
