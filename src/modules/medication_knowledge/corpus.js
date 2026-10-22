'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
// Bump whenever parsing/chunk boundaries change: old embeddings must be invalidated.
const IMPORTER_VERSION = 2;
const sentenceSegmenter = new Intl.Segmenter('ru', { granularity: 'sentence' });
const DEFAULT_SOURCE_DIR = path.resolve(__dirname, '../../../docs/Лекарства');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const normalize = (value) =>
  value
    .toLocaleLowerCase('ru')
    .replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function sentenceBoundaries(text) {
  const boundaries = [];
  for (const { index, segment } of sentenceSegmenter.segment(text)) {
    const end = index + segment.length;
    const prefix = text
      .slice(0, end)
      .trimEnd()
      .replace(/[»”"')\]]+$/u, '');
    // ICU recognizes most lowercase continuations, but initials and common
    // Russian abbreviations may precede a capitalized word inside a sentence.
    // Prefer an oversized sentence over cutting these ambiguous boundaries.
    if (
      /(?:^|[^\p{L}])(?:т\.\s*[едп]|др|см|рис|табл|стр|гг|мг|мкг|мл|кг|ед|мин|сек|проф|доц|акад|им|ул|кв|тыс|млн|млрд|напр|ред|ср)\.$/iu.test(
        prefix,
      )
    )
      continue;
    if (/(?:^|[^\p{L}])\p{L}\.$/u.test(prefix)) continue;
    boundaries.push(end);
  }
  return boundaries;
}

function parseDocument(drug, content) {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) || [];
  const locations = [];
  let offset = 0;
  let page = null;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/<!--\s*Страница\s+(\d+)/i);
    if (marker) page = marker[1];
    locations.push({ offset, line: i + 1, page });
    offset += lines[i].length;
  }
  function locate(position) {
    let lo = 0;
    let hi = locations.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (locations[mid].offset <= position) lo = mid;
      else hi = mid - 1;
    }
    return locations[lo] || { line: 1, page: null };
  }
  const sections = [
    {
      id: `${drug.id}:preamble`,
      document_id: drug.id,
      parent_id: null,
      level: 0,
      title: 'Преамбула',
      start_offset: 0,
      end_offset: content.length,
    },
  ];
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^(#{1,6})\s+(.+?)\s*\n?$/);
    if (!heading) continue;
    const start = locations[i].offset;
    if (sections.length === 1) sections[0].end_offset = start;
    const level = heading[1].length;
    while (stack.length && stack.at(-1).level >= level) stack.pop().end_offset = start;
    const section = {
      id: `${drug.id}:s${sections.length}`,
      document_id: drug.id,
      parent_id: stack.at(-1)?.id || null,
      level,
      title: heading[2],
      start_offset: start,
      end_offset: content.length,
    };
    sections.push(section);
    stack.push(section);
  }
  const provenance = (start, end) => ({
    line_start: locate(start).line,
    line_end: locate(Math.max(start, end - 1)).line,
    page_start: locate(start).page,
    page_end: locate(Math.max(start, end - 1)).page,
  });
  for (const section of sections) Object.assign(section, provenance(section.start_offset, section.end_offset));
  // Blank-line blocks keep Markdown lists and tables intact. Long prose may split
  // only after sentence punctuation; a sentence itself is never truncated.
  const blocks = [];
  let cursor = 0;
  for (const match of content.matchAll(/\n[\t ]*\n+/g)) {
    const end = match.index + match[0].length;
    blocks.push([cursor, end]);
    cursor = end;
  }
  if (cursor < content.length) blocks.push([cursor, content.length]);
  const units = [];
  for (const [start, end] of blocks) {
    const block = content.slice(start, end);
    if (block.length <= 1800 || /^\s*(?:\||[-*+]\s|\d+[.)]\s)/m.test(block)) {
      units.push([start, end]);
      continue;
    }
    let previous = start;
    for (const localBoundary of sentenceBoundaries(block)) {
      const boundary = start + localBoundary;
      if (boundary - previous >= 1200) {
        units.push([previous, boundary]);
        previous = boundary;
      }
    }
    if (previous < end) units.push([previous, end]);
  }
  const ranges = [];
  for (const unit of units) {
    const previous = ranges.at(-1);
    if (previous && previous[1] - previous[0] < 1200 && unit[1] - previous[0] <= 1800) previous[1] = unit[1];
    else ranges.push([...unit]);
  }
  const chunks = ranges.map(([start, end], ordinal) => {
    const text = content.slice(start, end);
    const section = sections.filter((s) => s.start_offset <= start && s.end_offset > start).at(-1) || sections[0];
    return {
      id: `${drug.id}:c${String(ordinal).padStart(5, '0')}`,
      document_id: drug.id,
      section_id: section.id,
      section_ids: JSON.stringify(
        sections.filter((s) => s.start_offset < end && s.end_offset > start).map((s) => s.id),
      ),
      ordinal,
      start_offset: start,
      end_offset: end,
      content: text,
      content_hash: hash(text),
      oversize: Number(text.length > 1800),
      ...provenance(start, end),
    };
  });
  return { ...drug, content, sections, chunks };
}

function loadCorpus(sourceDir = DEFAULT_SOURCE_DIR) {
  const registryPath = path.join(sourceDir, 'побочные_реакции/реестр.json');
  const raw = fs.readFileSync(registryPath, 'utf8');
  const registry = JSON.parse(raw);
  if (registry.schema_version !== 1) throw new Error('Unsupported medication registry schema');
  const documents = registry.drugs.map((drug) => {
    if (path.basename(drug.file) !== drug.file) throw new Error('Unsafe source filename');
    const bytes = fs.readFileSync(path.join(sourceDir, drug.file));
    if (hash(bytes) !== drug.sha256) throw new Error(`Stale or corrupt medication source: ${drug.id}`);
    return parseDocument(drug, bytes.toString('utf8'));
  });
  const ids = new Set(documents.map((d) => d.id));
  const effects = new Set(registry.effects.map((e) => e.id));
  const blocks = new Map(registry.blocks.map((b) => [b.id, b]));
  for (const [label, values] of Object.entries({
    drugs: registry.drugs,
    effects: registry.effects,
    occurrences: registry.occurrences,
    blocks: registry.blocks,
    source_mentions: registry.source_mentions,
  })) {
    if (new Set(values.map((v) => v.id)).size !== values.length) throw new Error(`Duplicate registry IDs: ${label}`);
  }
  const mentions = new Map(registry.source_mentions.map((m) => [m.id, m]));
  const occurrences = new Map(registry.occurrences.map((o) => [o.id, o]));
  for (const occurrence of registry.occurrences) {
    if (
      !ids.has(occurrence.drug) ||
      !effects.has(occurrence.effect) ||
      blocks.get(occurrence.block)?.drug !== occurrence.drug
    )
      throw new Error('Invalid registry occurrence provenance');
    for (const id of occurrence.qualifier_block_ids || [])
      if (blocks.get(id)?.drug !== occurrence.drug) throw new Error('Invalid qualifier block provenance');
    for (const id of occurrence.source_mention_ids || [])
      if (mentions.get(id)?.drug !== occurrence.drug || !mentions.get(id).occurrence_ids.includes(occurrence.id))
        throw new Error('Invalid source mention provenance');
  }
  for (const block of registry.blocks) {
    const document = documents.find((d) => d.id === block.drug);
    if (
      !document ||
      document.content
        .split('\n')
        .slice(block.line - 1, block.end_line)
        .join('\n') !== block.source_text
    )
      throw new Error(`Invalid registry source block: ${block.id}`);
  }
  for (const mention of registry.source_mentions) {
    const document = documents.find((d) => d.id === mention.drug);
    if (
      !document ||
      !document.content
        .split('\n')
        .slice(mention.line_start - 1, mention.line_end)
        .join('\n')
        .includes(mention.source_quote)
    )
      throw new Error(`Invalid mention quote: ${mention.id}`);
    for (const id of mention.occurrence_ids)
      if (occurrences.get(id)?.drug !== mention.drug || !occurrences.get(id).source_mention_ids?.includes(mention.id))
        throw new Error('Invalid reverse source mention provenance');
  }
  const fingerprint = hash(
    JSON.stringify({ importer: IMPORTER_VERSION, registry: hash(raw), files: documents.map((d) => [d.id, d.sha256]) }),
  );
  return { sourceDir, registry, registryRaw: raw, registryHash: hash(raw), documents, fingerprint };
}
module.exports = { DEFAULT_SOURCE_DIR, hash, normalize, parseDocument, loadCorpus };
