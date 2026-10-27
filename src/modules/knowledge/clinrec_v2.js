'use strict';

// Клинреки v2 -> корпус для clinrec_import.js. Источник: knowledge/clinrecs (SOURCES.md):
//   source/<slug>.md — размеченный исходник (единственный источник истины),
//   out/<slug>/{chunks,parents,sections}.json — результат knowledge/clinrecs/tools/chunker.py,
//   documents.json — slug -> id и название документа в базе.
// Форма результата та же, что у loadClinrecCorpus (clinrec_corpus.js), поэтому importClinrec работает без изменений.
// Здесь индексируются только чанки основного текста; скрытые разделы (оглавление, литература, приложения) читаются
// по таблице sections, методики и шаблоны представлены в metadata.methods.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { embedTextOf } = require('./clinrec_corpus');

const MAX_CHARS = 2000;
// Искусственно разбитый раздел: если родитель короткий — модели отдаётся он целиком, иначе чанк с соседями.
const PARENT_MODE_MAX_CHARS = 6000;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function loadClinrecV2(rootDir = 'knowledge/clinrecs', options = {}) {
  const root = path.resolve(rootDir);
  const outDir = path.resolve(options.outDir || path.join(root, 'out'));
  const out = { documents: [], sections: [], parents: [], chunks: [], references: [], warnings: [], errors: [] };
  const fail = (document_id, code, message) => out.errors.push({ document_id, code, message });
  const warn = (document_id, code, message) => out.warnings.push({ document_id, code, message });
  const registry = readJson(path.join(root, 'documents.json')).documents;
  for (const [slug, entry] of Object.entries(registry)) {
    const docId = entry.id;
    const dir = path.join(outDir, slug);
    const sourceFile = path.join(root, 'source', `${slug}.md`);
    let files;
    try {
      files = {
        chunks: readJson(path.join(dir, 'chunks.json')),
        parents: readJson(path.join(dir, 'parents.json')).parents,
        sections: readJson(path.join(dir, 'sections.json')).sections,
        source: fs.readFileSync(sourceFile),
      };
    } catch (e) {
      fail(docId, 'file_unreadable', `${slug}: ${e.message}`);
      continue;
    }
    const { chunks, parents, sections, source } = files;
    out.documents.push({
      document_id: docId,
      title: entry.title,
      source_sha256: sha256(source),
      schema_version: 2,
      dir: slug,
      source_file: path.relative(process.cwd(), sourceFile),
      source_status: 'ok',
    });
    const sid = (id) => `${docId}.n.${id}`;
    const sectionIds = new Set(sections.map((s) => s.id));
    for (const s of sections)
      out.sections.push({
        id: sid(s.id),
        document_id: docId,
        parent_id: s.parent == null ? null : sid(s.parent),
        level: s.level,
        title: s.title,
        kind: s.hidden ? 'hidden' : s.kind,
        collection: null,
        start_line: null,
        end_line_exclusive: null,
        own_span: { start: s.mstart, end: s.sub_end },
        span: { start: s.mstart, end: s.sub_end },
      });
    const parentIds = new Set(parents.map((p) => p.id));
    const parentText = new Map(parents.map((p) => [p.id, p.text.length]));
    for (const p of parents) {
      const base = p.id.split('#')[0];
      out.parents.push({
        id: `${docId}.p.${p.id}`,
        document_id: docId,
        section_id: sectionIds.has(base) ? sid(base) : null,
        heading_path: p.breadcrumb,
        text: p.text,
        span: null,
        kind: 'main',
        title: p.title,
        source_text: null,
        metadata: {},
        child_ids: chunks.filter((c) => c.split && c.split.parent_id === p.id).map((c) => `${docId}.c.${c.id}`),
      });
    }
    const cid = (id) => (id == null ? null : `${docId}.c.${id}`);
    for (const c of chunks) {
      if (c.text.length > MAX_CHARS) fail(docId, 'chunk_too_long', `${c.id}: ${c.text.length} знаков`);
      const split = c.split || null;
      if (split && !parentIds.has(split.parent_id))
        fail(docId, 'parent_missing', `${c.id}: нет родителя ${split.parent_id} в parents.json`);
      let mode = 'self';
      if (split) mode = (parentText.get(split.parent_id) || Infinity) <= PARENT_MODE_MAX_CHARS ? 'parent' : 'window';
      const covered = (c.nodes && c.nodes.length ? c.nodes : [c.id.split('#')[0]]).filter((n) => {
        if (!sectionIds.has(n)) warn(docId, 'section_missing', `${c.id}: нет раздела ${n}`);
        return sectionIds.has(n);
      });
      const base = covered[0];
      const methods = c.methods || [];
      const embed_text = embedTextOf(entry.title, c.breadcrumb, c.text);
      out.chunks.push({
        id: cid(c.id),
        document_id: docId,
        kind: 'main',
        source_kind: c.type,
        collection: null,
        section_id: base === undefined ? null : sid(base),
        parent_id: split ? `${docId}.p.${split.parent_id}` : null,
        mode,
        heading_path: c.breadcrumb,
        title: c.title,
        text: c.text,
        source_text: null,
        span: null,
        neighbors: { previous_id: cid(c.prev), next_id: cid(c.next), limit_each_side: mode === 'window' ? 1 : 0 },
        depends_on: { required_chunk_ids: [], always_include_spans: [] },
        metadata: {
          node_id: c.id,
          section_ids: covered.map(sid), // все разделы, чей текст входит в чанк (группа соседних разделов — один чанк)
          topics: c.topics,
          order: c.order,
          split,
          methods: methods.filter((m) => m.kind !== 'template'),
          templates: methods.filter((m) => m.kind === 'template'),
          apps: c.apps,
        },
        embed: true,
        embed_text,
        oversized: false,
      });
    }
    const ids = out.chunks.filter((x) => x.document_id === docId).map((x) => x.id);
    if (new Set(ids).size !== ids.length) fail(docId, 'duplicate_chunk_id', 'повторяющиеся id чанков');
  }
  return out;
}

module.exports = { loadClinrecV2, MAX_CHARS, PARENT_MODE_MAX_CHARS };
