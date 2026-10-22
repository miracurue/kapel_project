'use strict';
// covers: medication knowledge corpus provenance, lossless chunks and atomic imports.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_SOURCE_DIR,
  loadCorpus,
  parseDocument,
  hash,
} = require('../../src/modules/medication_knowledge/corpus');
const {
  openKnowledgeStore,
  importCorpus,
  activeGeneration,
  getDocument,
  getToc,
  readSection,
  getStatus,
} = require('../../src/modules/medication_knowledge/store');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medication-knowledge-'));
  const db = openKnowledgeStore({ filename: path.join(dir, 'knowledge.sqlite3') });
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir };
}
function copySources(dir) {
  const source = path.join(dir, 'sources');
  fs.mkdirSync(path.join(source, 'побочные_реакции'), { recursive: true });
  for (const file of fs.readdirSync(DEFAULT_SOURCE_DIR).filter((f) => f.endsWith('.md')))
    fs.copyFileSync(path.join(DEFAULT_SOURCE_DIR, file), path.join(source, file));
  fs.copyFileSync(
    path.join(DEFAULT_SOURCE_DIR, 'побочные_реакции/реестр.json'),
    path.join(source, 'побочные_реакции/реестр.json'),
  );
  return source;
}

test('real corpus preserves exact Markdown, every chunk UTF-16 range, IDs and audited registry', (t) => {
  const { db } = fixture(t);
  const result = importCorpus(db);
  assert.equal(result.documents, 12);
  assert.equal(result.effects, 365);
  assert.equal(result.links, 1651);
  const corpus = loadCorpus();
  assert.deepEqual(
    JSON.parse(db.prepare('SELECT registry_raw FROM generations WHERE id=?').get(result.generation).registry_raw),
    corpus.registry,
  );
  for (const doc of corpus.documents) {
    assert.equal(getDocument(db, doc.id).content, doc.content);
    const chunks = db
      .prepare('SELECT * FROM chunks WHERE generation=? AND document_id=? ORDER BY ordinal')
      .all(result.generation, doc.id);
    assert.equal(chunks.map((c) => c.content).join(''), doc.content);
    let offset = 0;
    for (const c of chunks) {
      assert.equal(c.start_offset, offset);
      assert.equal(c.content, doc.content.slice(c.start_offset, c.end_offset));
      assert.equal(c.content_hash, hash(c.content));
      assert.deepEqual(
        JSON.parse(c.section_ids),
        doc.sections.filter((s) => s.start_offset < c.end_offset && s.end_offset > c.start_offset).map((s) => s.id),
      );
      assert.equal(c.oversize, Number(c.content.length > 1800));
      offset = c.end_offset;
    }
    assert.equal(offset, doc.content.length);
    for (const s of getToc(db, doc.id)) {
      const read = readSection(db, doc.id, s.id);
      assert.equal(read.text, doc.content.slice(s.start_offset, s.end_offset));
      if (s.parent_id) {
        const parent = getToc(db, doc.id).find((p) => p.id === s.parent_id);
        assert.ok(parent.start_offset <= s.start_offset && parent.end_offset >= s.end_offset);
      }
    }
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM source_mentions WHERE generation=?').get(result.generation).n,
    1723,
  );
  const saved = db
    .prepare('SELECT raw_json FROM effect_links WHERE generation=? ORDER BY id')
    .all(result.generation)
    .map((r) => JSON.parse(r.raw_json));
  assert.deepEqual(
    saved,
    [...corpus.registry.occurrences].sort((a, b) => a.id.localeCompare(b.id)),
  );
  assert.equal(importCorpus(db).changed, false);
  assert.equal(getStatus(db).stale, false);
  const rebuilt = importCorpus(db, { rebuild: true });
  assert.notEqual(rebuilt.generation, result.generation);
  assert.equal(rebuilt.links, result.links);
});

test('paragraph/sentence boundaries preserve long sentences, table and preamble', () => {
  const prose = 'Предложение достаточно длинное. '.repeat(140);
  const table = '| Заголовок | Значение |\n' + '| Очень длинная ячейка | Значение |\n'.repeat(100);
  const text =
    'Исходная преамбула.\n\n# Родитель\n\n## Дочерний\n\n' + prose + '\n\n' + table + '\n\n## Следующий\n\nКонец.';
  const doc = parseDocument({ id: 'D00' }, text);
  assert.equal(doc.chunks.map((c) => c.content).join(''), text);
  assert.equal(text.slice(doc.sections[0].start_offset, doc.sections[0].end_offset), 'Исходная преамбула.\n\n');
  const tableChunk = doc.chunks.find((c) => c.content.includes('| Заголовок'));
  assert.ok(tableChunk.content.includes(table));
  assert.equal(tableChunk.oversize, 1);
  const parent = doc.sections.find((s) => s.title === 'Родитель');
  assert.ok(text.slice(parent.start_offset, parent.end_offset).includes('Конец.'));
});

test('stale Markdown and malformed registry fail before replacing active generation', (t) => {
  const { db, dir } = fixture(t);
  importCorpus(db);
  const original = activeGeneration(db);
  const sourceDir = copySources(dir);
  const corpus = loadCorpus(sourceDir);
  const file = path.join(sourceDir, corpus.documents[0].file);
  fs.appendFileSync(file, '\nCorrupt source');
  assert.equal(getStatus(db, { sourceDir }).stale, true);
  assert.throws(() => importCorpus(db, { sourceDir }), /Stale or corrupt/);
  assert.equal(activeGeneration(db), original);
  fs.writeFileSync(file, corpus.documents[0].content);
  const registryPath = path.join(sourceDir, 'побочные_реакции/реестр.json');
  const registry = JSON.parse(corpus.registryRaw);
  registry.occurrences[0].effect = 'AE-phantom';
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  assert.throws(() => importCorpus(db, { sourceDir }), /Invalid registry occurrence/);
  assert.equal(activeGeneration(db), original);
  registry.occurrences[0].effect = corpus.registry.occurrences[0].effect;
  registry.effects.push(registry.effects[0]);
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  assert.throws(() => importCorpus(db, { sourceDir }), /Duplicate registry IDs/);
});

test('failed staged import leaves previous generation available and retry recovers', (t) => {
  const { db } = fixture(t);
  importCorpus(db);
  const previous = activeGeneration(db);
  db.exec(
    "CREATE TRIGGER simulate_failure BEFORE INSERT ON effect_links BEGIN SELECT RAISE(ABORT,'staged failure'); END",
  );
  assert.throws(() => importCorpus(db, { rebuild: true }), /staged failure/);
  assert.equal(activeGeneration(db), previous);
  assert.equal(getDocument(db, 'D01').id, 'D01');
  db.exec('DROP TRIGGER simulate_failure');
  assert.equal(importCorpus(db, { rebuild: true }).links, 1651);
});

test('SQL constraints reject phantom links, invalid model dimensions and chunk hashes', (t) => {
  const { db } = fixture(t);
  const { generation } = importCorpus(db);
  assert.throws(
    () =>
      db
        .prepare('INSERT INTO effect_links VALUES (?,?,?,?,?,?,?,?,?)')
        .run(generation, 'bad', 'missing', 'D01', 'B0001', 'x', 'x', 'x', '{}'),
    /FOREIGN KEY/,
  );
  db.prepare("INSERT INTO embedding_namespaces VALUES (?, 'model', 3, 'building', 0)").run(generation);
  const chunk = db.prepare('SELECT * FROM chunks WHERE generation=? LIMIT 1').get(generation);
  const insert = db.prepare('INSERT INTO embeddings VALUES (?,?,?,?,?,?,?,?)');
  assert.throws(
    () => insert.run(generation, 'chunk', chunk.id, 'model', 3, 'wrong', Buffer.alloc(12), 1),
    /provenance/,
  );
  assert.throws(
    () => insert.run(generation, 'chunk', chunk.id, 'model', 3, chunk.content_hash, Buffer.alloc(8), 1),
    /CHECK/,
  );
  assert.throws(
    () => insert.run(generation, 'chunk', chunk.id, 'model', 2, chunk.content_hash, Buffer.alloc(8), 1),
    /FOREIGN KEY/,
  );
  insert.run(generation, 'chunk', chunk.id, 'model', 3, chunk.content_hash, Buffer.alloc(12), 1);
  assert.throws(
    () => db.prepare('UPDATE effects SET status=? WHERE generation=?').run('approved', generation),
    /CHECK/,
  );
});

test('long prose chunks keep Russian abbreviations, initials and decimal doses inside sentences', () => {
  for (const continuation of [
    'т.е. это продолжение одного предложения.',
    'т. е. Это продолжение одного предложения.',
    'г. Москва указана внутри одного предложения.',
    'проф. Иванов А. И. продолжает одно предложение.',
    'рис. 5 показывает часть того же предложения.',
    '0.5 мг. Дозировка сохранена в том же предложении.',
  ]) {
    const firstSentence = 'А'.repeat(1198) + ' ' + continuation + ' ';
    const text = firstSentence + 'Далее отдельное предложение. '.repeat(50);
    const document = parseDocument({ id: 'X' }, text);
    assert.equal(document.chunks[0].content, firstSentence, continuation);
    assert.equal(document.chunks.map((c) => c.content).join(''), text);
    assert.ok(document.chunks[1].content.startsWith('Далее отдельное предложение.'));
  }
});
