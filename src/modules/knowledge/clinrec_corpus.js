'use strict';
// Нормализация клинических рекомендаций (docs/clinrecs/rag/*) в единый вид записей для импорта в хранилище знаний.
// Чистая функция чтения: только файловая система, без сети и БД, ничего не пишет и не исправляет.
// Формат источника — parent–child (docs/clinrecs/rag/01_bipolar/README.md): режимы self/parent/window,
// родители не индексируются, source_text неизменен, text — без библиографических номеров.
// Расхождения не чинятся догадками: ошибки (errors) блокируют импорт, предупреждения (warnings) требуют решения человека.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REQUIRED_FILES = [
  'chunks',
  'parents',
  'sections',
  'methods',
  'appendices',
  'supporting',
  'references',
  'manifest',
];
const MODES = new Set(['self', 'parent', 'window']);

const DEFAULTS = {
  maxTokens: 4096, // предел модели эмбеддингов
  charsPerToken: 2.0, // консервативная оценка для русского текста; настоящий токенизатор здесь не используется
  margin: 0.2, // запас: кандидат в oversized, если оценка выше maxTokens * (1 - margin)
  repoRoot: null, // по умолчанию rootDir/../../.. (manifest.source_file задан от корня репозитория)
  sample: 5, // сколько id показывать в предупреждении
};

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isSpan(s) {
  return !!s && Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= 0 && s.end > s.start;
}

function embedTextOf(docTitle, headingPath, text) {
  // manifest.embedding_input: manifest.title + heading_path + chunk.text; text сам по себе не меняется.
  return [docTitle, (headingPath || []).join(' > '), text].filter((x) => x !== '' && x != null).join('\n');
}

/**
 * @param {string} rootDir каталог docs/clinrecs/rag
 * @param {object} [options] maxTokens, charsPerToken, margin, repoRoot, sample
 */
function loadClinrecCorpus(rootDir, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const root = path.resolve(rootDir);
  const repoRoot = path.resolve(opt.repoRoot || path.join(root, '..', '..', '..'));
  const out = { documents: [], sections: [], parents: [], chunks: [], references: [], warnings: [], errors: [] };
  const warn = (document_id, code, message, extra) =>
    out.warnings.push({ document_id, code, message, ...(extra || {}) });
  const fail = (document_id, code, message, extra) => out.errors.push({ document_id, code, message, ...(extra || {}) });
  const sampleIds = (ids) => ids.slice(0, opt.sample);

  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{2}_/.test(d.name))
    .map((d) => d.name)
    .sort();
  if (!dirs.length) fail(null, 'no_documents', `в ${root} нет каталогов клинреков вида NN_name`);

  const seenChunkIds = new Map(); // id -> document_id
  const seenParentIds = new Map();
  const seenSectionIds = new Map();
  const seenDocIds = new Map();
  const hardLimitChars = opt.maxTokens * opt.charsPerToken;
  const softLimitChars = hardLimitChars * (1 - opt.margin);

  for (const dir of dirs) {
    const dp = path.join(root, dir);
    const raw = {};
    let broken = false;
    for (const f of REQUIRED_FILES) {
      const file = path.join(dp, `${f}.json`);
      try {
        raw[f] = readJson(file);
      } catch (e) {
        fail(dir, 'file_unreadable', `${dir}/${f}.json: ${e.code === 'ENOENT' ? 'нет файла' : e.message}`);
        broken = true;
      }
    }
    if (broken) continue;
    const mf = raw.manifest;
    const docId = mf.document_id;
    if (!docId) {
      fail(dir, 'no_document_id', `${dir}/manifest.json без document_id`);
      continue;
    }
    for (const f of REQUIRED_FILES) {
      if (f !== 'manifest' && raw[f].document_id !== docId) {
        fail(docId, 'document_id_mismatch', `${dir}/${f}.json: document_id=${raw[f].document_id}, в manifest ${docId}`);
      }
    }
    if (seenDocIds.has(docId))
      fail(docId, 'duplicate_document_id', `document_id ${docId} в ${seenDocIds.get(docId)} и ${dir}`);
    seenDocIds.set(docId, dir);
    const docTitle = mf.title || '';

    // ---- исходный Markdown: SHA-256 и круговая проверка span ----
    const sourcePath = mf.source_file ? path.resolve(repoRoot, mf.source_file) : null;
    let source_status = 'no_hash';
    let sourceCps = null;
    if (mf.source_sha256) {
      if (sourcePath && fs.existsSync(sourcePath)) {
        const buf = fs.readFileSync(sourcePath);
        if (sha256(buf) === mf.source_sha256) {
          source_status = 'verified';
          sourceCps = Array.from(buf.toString('utf8'));
        } else {
          source_status = 'mismatch';
          fail(
            docId,
            'source_sha_mismatch',
            `SHA-256 ${mf.source_file} не совпадает с manifest; span-координаты недействительны`,
          );
        }
      } else {
        source_status = 'missing';
        warn(
          docId,
          'source_missing',
          `исходник ${mf.source_file || '(не указан)'} не найден; SHA-256 и span не проверены (docs/clinrecs/ вне Git)`,
        );
      }
    } else {
      warn(docId, 'source_sha_absent', 'в manifest нет source_sha256');
    }
    const checkSpanText = (rec, label) => {
      if (!sourceCps || !isSpan(rec.span) || typeof rec.source_text !== 'string') return;
      if (sourceCps.slice(rec.span.start, rec.span.end).join('') !== rec.source_text) {
        fail(docId, 'span_text_mismatch', `${label} ${rec.id}: source_text не равен срезу исходника по span`);
      }
    };

    // ---- разделы ----
    const sectionIds = new Set();
    for (const s of raw.sections.sections) {
      // Дубль id раздела — дефект источника (напр. 25_catatonia: Приложения В и Г под одним id); не чиним, чанки по id всё же разрешаются.
      if (seenSectionIds.has(s.id))
        warn(
          docId,
          'duplicate_section_id',
          `раздел ${s.id} («${s.title}») повторяет id раздела из ${seenSectionIds.get(s.id)}; ссылки на него неоднозначны`,
          { section_id: s.id },
        );
      seenSectionIds.set(s.id, docId);
      sectionIds.add(s.id);
      out.sections.push({
        id: s.id,
        document_id: docId,
        parent_id: s.parent ?? null,
        level: s.level ?? null,
        title: s.title ?? '',
        kind: s.kind ?? null,
        collection: s.collection ?? null,
        start_line: s.start_line ?? null,
        end_line_exclusive: s.end_line_exclusive ?? null,
        span: s.span ?? null,
        own_span: s.own_span ?? null,
      });
    }
    for (const s of out.sections.filter((x) => x.document_id === docId)) {
      if (s.parent_id && !sectionIds.has(s.parent_id))
        fail(docId, 'section_parent_missing', `раздел ${s.id}: родитель ${s.parent_id} не найден`);
    }

    // ---- родители: основные, методики, приложения ----
    const parentRecords = [];
    const addParent = (p, kind) => {
      const n = {
        id: p.id,
        document_id: docId,
        kind,
        title: p.title ?? '',
        section_id: p.section_id ?? null,
        heading_path: p.heading_path || [],
        text: p.text,
        source_text: p.source_text,
        span: p.span ?? null,
        child_ids: p.child_ids || [],
        metadata: p.metadata || {},
        section_subtree_span: p.section_subtree_span ?? null,
        ancestor_context_spans: p.ancestor_context_spans || [],
        required_context_spans: p.required_context_spans || [],
        original_appendix_label: p.original_appendix_label ?? null,
        indexed: p.index_in_vector_search === true,
      };
      parentRecords.push(n);
    };
    raw.parents.parents.forEach((p) => addParent(p, 'main'));
    raw.methods.parents.forEach((p) => addParent(p, 'method'));
    raw.appendices.appendices.forEach((p) => addParent(p, 'appendix'));
    const parentById = new Map();
    for (const p of parentRecords) {
      if (seenParentIds.has(p.id) || parentById.has(p.id))
        fail(docId, 'duplicate_parent_id', `родитель ${p.id} не уникален`);
      seenParentIds.set(p.id, docId);
      parentById.set(p.id, p);
      if (p.indexed)
        fail(
          docId,
          'parent_indexed',
          `родитель ${p.id} помечен для векторного индекса: родители не индексируются повторно`,
        );
      if (typeof p.text !== 'string' || !p.text) fail(docId, 'parent_text_empty', `родитель ${p.id} без text`);
      if (p.section_id && !sectionIds.has(p.section_id))
        fail(docId, 'section_missing', `родитель ${p.id}: раздел ${p.section_id} не найден`);
      checkSpanText(p, 'родитель');
    }

    // ---- чанки трёх коллекций ----
    const rawChunks = [
      ...raw.chunks.chunks.map((c) => [c, 'main', 'chunks.json']),
      ...raw.methods.chunks.map((c) => [c, 'method', 'methods.json']),
      ...raw.appendices.appendices.flatMap((a) => (a.chunks || []).map((c) => [c, 'appendix', 'appendices.json'])),
    ];
    const docChunkIds = new Set(rawChunks.map(([c]) => c.id));
    const chunkById = new Map(rawChunks.map(([c]) => [c.id, c]));
    const refIds = new Set(raw.references.items.map((r) => r.id));
    const expectedParentKind = { main: 'main', method: 'method', appendix: 'appendix' };

    const oversizedIds = [];
    const overHardIds = [];
    const residualCitation = [];
    const dupEmbed = new Map();

    for (const [c, kind, file] of rawChunks) {
      const where = `${file}:${c.id}`;
      if (typeof c.id !== 'string' || !c.id) {
        fail(docId, 'chunk_id_missing', `${file}: чанк без id`);
        continue;
      }
      if (seenChunkIds.has(c.id))
        fail(docId, 'duplicate_chunk_id', `чанк ${c.id} уже есть в ${seenChunkIds.get(c.id)}`);
      seenChunkIds.set(c.id, docId);
      if (c.document_id !== docId) fail(docId, 'chunk_document_mismatch', `${where}: document_id=${c.document_id}`);
      const r = c.retrieval || {};
      const mode = r.mode ?? null;
      if (!MODES.has(mode)) fail(docId, 'bad_mode', `${where}: режим ${JSON.stringify(mode)}`);
      const embed = c.index_in_vector_search === true;
      if (typeof c.index_in_vector_search !== 'boolean')
        fail(docId, 'index_flag_missing', `${where}: нет булева index_in_vector_search`);
      const hasText = typeof c.text === 'string' && c.text.trim().length > 0;
      if (embed && !hasText)
        fail(docId, 'embed_chunk_without_text', `${where}: подлежит векторизации, но text пуст или отсутствует`);
      if (typeof c.source_text !== 'string' || !c.source_text)
        fail(docId, 'source_text_missing', `${where}: нет source_text`);
      if (hasText && typeof c.source_text === 'string' && c.text.length > c.source_text.length) {
        warn(docId, 'text_longer_than_source', `${where}: text длиннее source_text`);
      }
      if (hasText && /\[\d+(?:\s*[,–-]\s*\d+)*\]/.test(c.text)) residualCitation.push(c.id);
      if (!isSpan(c.span)) fail(docId, 'bad_span', `${where}: некорректный span`);
      else checkSpanText(c, 'чанк');

      // родитель
      const parent = parentById.get(c.parent_id);
      if (!c.parent_id || !parent) fail(docId, 'parent_missing', `${where}: родитель ${c.parent_id} не найден`);
      else {
        if (parent.kind !== expectedParentKind[kind])
          warn(
            docId,
            'parent_kind_unexpected',
            `${where}: родитель ${parent.id} вида ${parent.kind}, чанк вида ${kind}`,
          );
        if (!parent.child_ids.includes(c.id))
          fail(docId, 'parent_child_link_broken', `${where}: нет в child_ids родителя ${parent.id}`);
      }
      const ctx = r.context_parent_id ?? null;
      if (mode === 'parent' || mode === 'window') {
        if (!ctx || !parentById.has(ctx))
          fail(docId, 'context_parent_missing', `${where}: режим ${mode}, context_parent_id=${ctx} не найден`);
        else if (ctx !== c.parent_id)
          warn(docId, 'context_parent_differs', `${where}: context_parent_id ${ctx} != parent_id ${c.parent_id}`);
      } else if (mode === 'self' && ctx != null && !parentById.has(ctx)) {
        fail(docId, 'context_parent_missing', `${where}: context_parent_id=${ctx} не найден`);
      }
      // соседи — только того же родителя
      for (const [key, label] of [
        ['previous_chunk_id', 'previous'],
        ['next_chunk_id', 'next'],
      ]) {
        const nid = r[key];
        if (nid == null) continue;
        const nb = chunkById.get(nid);
        if (!nb) fail(docId, 'neighbor_missing', `${where}: ${label} ${nid} не найден`);
        else if (nb.parent_id !== c.parent_id)
          fail(docId, 'neighbor_other_parent', `${where}: ${label} ${nid} из другого родителя`);
      }
      // обязательные зависимости: чанк или родитель (родители не индексируются, но читаются по id)
      for (const rid of r.required_chunk_ids || []) {
        if (!docChunkIds.has(rid) && !parentById.has(rid))
          fail(docId, 'required_missing', `${where}: required ${rid} не найден`);
      }
      for (const sp of r.always_include_spans || []) {
        if (!isSpan(sp)) fail(docId, 'bad_always_include_span', `${where}: некорректный always_include_span`);
      }
      if (c.section_id && !sectionIds.has(c.section_id))
        fail(docId, 'section_missing', `${where}: раздел ${c.section_id} не найден`);
      if (!c.section_id) warn(docId, 'section_absent', `${where}: нет section_id`);
      for (const rid of (c.metadata && c.metadata.reference_ids) || []) {
        if (!refIds.has(rid)) fail(docId, 'reference_missing', `${where}: литература ${rid} не найдена`);
      }

      // размер
      const embed_text = hasText ? embedTextOf(docTitle, c.heading_path, c.text) : '';
      const est_tokens = Math.ceil(embed_text.length / opt.charsPerToken);
      const oversized = embed && embed_text.length > softLimitChars;
      if (oversized) oversizedIds.push(c.id);
      if (embed && embed_text.length > hardLimitChars) overHardIds.push(c.id);
      if (embed && hasText) {
        const list = dupEmbed.get(embed_text) || [];
        list.push(c.id);
        dupEmbed.set(embed_text, list);
      }

      out.chunks.push({
        id: c.id,
        document_id: docId,
        kind,
        source_kind: c.kind ?? null,
        collection: c.collection ?? null,
        parent_id: c.parent_id ?? null,
        mode,
        context_parent_id: ctx,
        heading_path: c.heading_path || [],
        title: c.title ?? '',
        section_id: c.section_id ?? null,
        text: c.text,
        embed_text,
        source_text: c.source_text,
        span: c.span ?? null,
        neighbors: {
          previous_id: r.previous_chunk_id ?? null,
          next_id: r.next_chunk_id ?? null,
          limit_each_side: r.neighbor_limit_each_side ?? null,
        },
        depends_on: {
          required_chunk_ids: r.required_chunk_ids || [],
          always_include_spans: r.always_include_spans || [],
        },
        atomic_oversize: r.atomic_oversize === true,
        retrieval_reason: r.reason ?? null,
        metadata: c.metadata || {},
        embed,
        est_tokens,
        oversized,
      });
    }

    // родитель -> дети: каждый child_id существует и ссылается назад
    for (const p of parentRecords) {
      for (const cid of p.child_ids) {
        const ch = chunkById.get(cid);
        if (!ch) fail(docId, 'child_missing', `родитель ${p.id}: ребёнок ${cid} не найден`);
        else if (ch.parent_id !== p.id)
          fail(docId, 'child_parent_mismatch', `родитель ${p.id}: ребёнок ${cid} указывает на ${ch.parent_id}`);
      }
      const ids = new Set(p.child_ids);
      // eslint-disable-next-line no-unused-vars -- поле indexed намеренно не попадает в публикуемую запись
      const { indexed, ...pub } = p;
      out.parents.push(pub);
      void ids;
    }

    // ---- служебные записи и литература (не векторизуются) ----
    const supportIds = new Set();
    for (const s of raw.supporting.records) {
      if (seenChunkIds.has(s.id) || supportIds.has(s.id))
        fail(docId, 'duplicate_chunk_id', `служебная запись ${s.id} не уникальна`);
      seenChunkIds.set(s.id, docId);
      supportIds.add(s.id);
      if (s.section_id && !sectionIds.has(s.section_id))
        fail(docId, 'section_missing', `supporting.json:${s.id}: раздел ${s.section_id} не найден`);
      checkSpanText(s, 'служебная запись');
      out.chunks.push({
        id: s.id,
        document_id: docId,
        kind: 'supporting',
        source_kind: null,
        collection: 'supporting',
        parent_id: null,
        mode: null,
        context_parent_id: null,
        heading_path: s.heading_path || [],
        title: s.title ?? '',
        section_id: s.section_id ?? null,
        text: s.text,
        embed_text: '',
        source_text: s.source_text,
        span: s.span ?? null,
        neighbors: { previous_id: null, next_id: null, limit_each_side: null },
        depends_on: { required_chunk_ids: [], always_include_spans: [] },
        atomic_oversize: false,
        retrieval_reason: null,
        metadata: s.metadata || {},
        embed: false,
        est_tokens: 0,
        oversized: false,
      });
    }
    const refNumbers = new Set();
    for (const it of raw.references.items) {
      if (seenChunkIds.has(it.id)) fail(docId, 'duplicate_chunk_id', `литература ${it.id} не уникальна`);
      seenChunkIds.set(it.id, docId);
      if (refNumbers.has(it.number))
        warn(docId, 'reference_number_duplicate', `номер литературы ${it.number} повторяется`);
      refNumbers.add(it.number);
      const rec = {
        id: it.id,
        document_id: docId,
        number: it.number ?? null,
        text: it.text,
        span: it.span ?? null,
        source_text: it.source_text ?? null,
        continuation_lines: it.continuation_lines ?? null,
      };
      out.references.push(rec);
      out.chunks.push({
        id: it.id,
        document_id: docId,
        kind: 'reference',
        source_kind: null,
        collection: 'references',
        parent_id: null,
        mode: null,
        context_parent_id: null,
        heading_path: [],
        title: '',
        section_id: null,
        text: it.text,
        embed_text: '',
        source_text: it.source_text ?? null,
        span: it.span ?? null,
        neighbors: { previous_id: null, next_id: null, limit_each_side: null },
        depends_on: { required_chunk_ids: [], always_include_spans: [] },
        atomic_oversize: false,
        retrieval_reason: null,
        metadata: { number: it.number ?? null },
        embed: false,
        est_tokens: 0,
        oversized: false,
      });
    }

    // ---- агрегированные предупреждения по документу ----
    if (residualCitation.length) {
      warn(
        docId,
        'citation_marks_in_text',
        `${residualCitation.length} чанков с остатками «[n]» в text (оставлено как в источнике)`,
        { ids: sampleIds(residualCitation), count: residualCitation.length },
      );
    }
    if (oversizedIds.length) {
      warn(
        docId,
        'oversized_candidates',
        `${oversizedIds.length} векторизуемых чанков длиннее ${Math.round((1 - opt.margin) * 100)}% лимита ${opt.maxTokens} токенов (оценка ${opt.charsPerToken} симв/ток); из них сверх лимита: ${overHardIds.length}`,
        { ids: sampleIds(oversizedIds), count: oversizedIds.length, over_hard_limit: overHardIds.length },
      );
    }
    const dups = [...dupEmbed.values()].filter((v) => v.length > 1);
    if (dups.length)
      warn(docId, 'duplicate_embed_text', `${dups.length} групп чанков с одинаковым embed_text`, {
        groups: dups.slice(0, opt.sample),
      });

    // ---- сверка со счётчиками manifest ----
    const counts = mf.counts || {};
    const mine = out.chunks.filter((x) => x.document_id === docId);
    const actual = {
      clinical_chunks: mine.filter((x) => x.kind === 'main').length,
      method_chunks: mine.filter((x) => x.kind === 'method').length,
      clinical_parents: raw.parents.parents.length,
      methods: raw.methods.parents.length,
      appendices: raw.appendices.appendices.length,
      all_search_chunks: mine.filter((x) => x.embed).length,
      oversized_atomic_chunks: mine.filter((x) => x.atomic_oversize).length,
    };
    for (const [k, v] of Object.entries(actual)) {
      if (counts[k] != null && counts[k] !== v)
        warn(docId, 'manifest_count_mismatch', `manifest.counts.${k}=${counts[k]}, фактически ${v}`);
    }
    const modes = { self: 0, parent: 0, window: 0 };
    mine
      .filter((x) => x.embed)
      .forEach((x) => {
        if (modes[x.mode] != null) modes[x.mode] += 1;
      });
    for (const [m, v] of Object.entries(counts.retrieval_modes || {})) {
      if (modes[m] !== v)
        warn(docId, 'manifest_count_mismatch', `manifest.counts.retrieval_modes.${m}=${v}, фактически ${modes[m]}`);
    }

    out.documents.push({
      document_id: docId,
      dir,
      title: docTitle,
      guideline_id: mf.guideline_id ?? null,
      clinical_year: mf.clinical_year ?? null,
      source_file: mf.source_file ?? null,
      source_sha256: mf.source_sha256 ?? null,
      source_status,
      schema_version: mf.schema_version ?? null,
      references_completeness: raw.references.completeness ?? null,
      unresolved_citation_numbers: (raw.references.unresolved_citation_numbers || []).length,
    });
  }

  // ---- межфайловые проверки, зависящие от всех документов ----
  return out;
}

/** Сводка по документам и видам для CLI и тестов. */
function summarizeClinrecCorpus(corpus) {
  const documents = {};
  const totals = { chunks: 0, embeddable: 0, oversized: 0, parents: 0, sections: 0, references: 0 };
  for (const d of corpus.documents) {
    documents[d.document_id] = {
      dir: d.dir,
      source_status: d.source_status,
      chunks: 0,
      embeddable: 0,
      oversized: 0,
      by_kind: {},
      embeddable_by_kind: {},
      modes_embeddable: { self: 0, parent: 0, window: 0 },
      parents: 0,
      sections: 0,
      references: 0,
    };
  }
  for (const c of corpus.chunks) {
    const s = documents[c.document_id];
    if (!s) continue;
    s.chunks += 1;
    totals.chunks += 1;
    s.by_kind[c.kind] = (s.by_kind[c.kind] || 0) + 1;
    if (c.embed) {
      s.embeddable += 1;
      totals.embeddable += 1;
      s.embeddable_by_kind[c.kind] = (s.embeddable_by_kind[c.kind] || 0) + 1;
      if (s.modes_embeddable[c.mode] != null) s.modes_embeddable[c.mode] += 1;
    }
    if (c.oversized) {
      s.oversized += 1;
      totals.oversized += 1;
    }
  }
  for (const p of corpus.parents)
    if (documents[p.document_id]) {
      documents[p.document_id].parents += 1;
      totals.parents += 1;
    }
  for (const x of corpus.sections)
    if (documents[x.document_id]) {
      documents[x.document_id].sections += 1;
      totals.sections += 1;
    }
  for (const r of corpus.references)
    if (documents[r.document_id]) {
      documents[r.document_id].references += 1;
      totals.references += 1;
    }
  return { documents: corpus.documents.length, totals, by_document: documents };
}

module.exports = { loadClinrecCorpus, summarizeClinrecCorpus, embedTextOf, DEFAULTS };
