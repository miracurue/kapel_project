'use strict';
// covers: medication knowledge retrieval, provenance, completeness, persistent embeddings and safe agent tools.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../../src/modules/medication_knowledge/store');
const search = require('../../src/modules/medication_knowledge/search');
const {
  indexEmbeddings,
  namespaceStatus,
  entities,
} = require('../../src/modules/medication_knowledge/index_embeddings');
const { createKnowledgeTools, toolDefinitions } = require('../../src/modules/medication_knowledge/tools');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medication-retrieval-'));
  const filename = path.join(dir, 'knowledge.sqlite3');
  const db = store.openKnowledgeStore({ filename });
  store.importCorpus(db);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, filename };
}
function client() {
  return {
    model: 'offline-test',
    dimensions: 3,
    calls: 0,
    async embed(texts) {
      this.calls++;
      return {
        model: this.model,
        vectors: texts.map((text) => (/мигрень|головная боль/u.test(text.toLowerCase()) ? [0, 1, 0] : [1, 0, 0])),
      };
    },
  };
}
test('drug INN/manufacturer identity, typo tolerance, full toc and lossless section pagination', (t) => {
  const { db } = fixture(t);
  const drugs = search.searchDrugs(db, { query: 'амитриптилин', limit: 1 });
  assert.equal(drugs.results[0].match_type, 'exact');
  assert.ok(drugs.total >= 3);
  assert.equal(drugs.hasMore, true);
  assert.equal(search.searchDrugs(db, { query: 'авианр' }).results[0].id, 'D01');
  const duloxetine = search.searchDrugs(db, { query: 'дулоксетин' });
  assert.deepEqual(
    duloxetine.results.map((d) => d.id),
    ['D05', 'D06', 'D07'],
  );
  assert.ok(search.searchDrugs(db, { query: 'дулокситин' }).results.every((d) => d.match_type === 'fuzzy'));
  const toc = search.getToc(db, { documentId: 'D01' });
  assert.ok(toc.sections.length > 10);
  const sectionId = toc.sections.find((s) => s.end_offset - s.start_offset > 1000).id;
  let text = '',
    cursor;
  for (;;) {
    const result = search.readSection(db, { documentId: 'D01', sectionId, cursor, maxChars: 137 });
    text += result.text;
    if (!result.hasMore) {
      assert.equal(text.length, result.total);
      break;
    }
    cursor = result.nextCursor;
  }
  assert.equal(text, store.readSection(db, 'D01', sectionId).text);
  assert.throws(() => search.readSection(db, { documentId: 'D02', sectionId }), /section_not_found/);
});
test('escaped lexical query, filters before limit, provenance and explicit semantic fallback', async (t) => {
  const { db } = fixture(t);
  const result = await search.searchText(db, { query: 'головная боль', drugIds: ['D12'], limit: 1 });
  assert.equal(result.results[0].document_id, 'D12');
  assert.ok(result.total > 1);
  assert.ok(result.hasMore);
  assert.ok(result.results[0].source_hash);
  assert.ok(result.results[0].section_paths.length);
  assert.ok(result.results[0].line_start > 0);
  await search.searchText(db, { query: '" OR * ); DROP TABLE documents; --' });
  assert.equal(store.counts(db).documents, 12);
  const unavailable = await search.searchText(db, { query: 'боль', mode: 'semantic', client: client() });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.reason, 'embedding_index_incomplete');
  const hybrid = await search.searchText(db, { query: 'боль', mode: 'hybrid' });
  assert.equal(hybrid.fallback, 'lexical');
  assert.ok(hybrid.total > 0);
  assert.throws(() => search.searchDrugs(db, { query: '' }), /invalid_query/);
  await assert.rejects(search.searchText(db, { query: 'боль', drugIds: 'D12' }), /invalid_drug_filter/);
});
test('adverse registry exact/alias evidence retains qualifiers, mentions and manufacturer identity; migraine is never confirmed by headache', async (t) => {
  const { db } = fixture(t);
  const headache = await search.searchAdverseEffects(db, { query: 'ГОЛОВНАЯ БОЛЬ', includeCandidates: false });
  assert.equal(headache.confirmed.results[0].effect_id, 'AE0075');
  assert.equal(headache.confirmed.results[0].match_type, 'exact');
  assert.ok(headache.confirmed_drug_total >= 3);
  const evidence = headache.confirmed.results.flatMap((e) => e.drugs.flatMap((d) => d.evidence));
  assert.ok(evidence.some((e) => e.qualifier_blocks.length > 0));
  assert.ok(evidence.some((e) => e.source_mentions.length > 0));
  assert.ok(evidence.every((e) => e.occurrence_id && e.block_id && e.effect_id && e.source.sha256 && e.block.line));
  assert.ok(evidence.every((e) => typeof e.frequency === 'string' && typeof e.context === 'string'));
  const migraine = await search.searchAdverseEffects(db, { query: 'мигрень' });
  assert.equal(migraine.confirmed.total, 0);
  assert.equal(migraine.confirmed_drug_total, 0);
  const aliasEffect = db
    .prepare(
      'SELECT e.name,a.alias FROM effect_aliases a JOIN effects e ON e.generation=a.generation AND e.id=a.effect_id WHERE a.generation=? AND a.normalized != ? AND a.alias != e.name LIMIT 1',
    )
    .get(store.activeGeneration(db), '');
  assert.ok(aliasEffect);
  const alias = await search.searchAdverseEffects(db, { query: aliasEffect.alias, includeCandidates: false });
  assert.ok(alias.confirmed.results.some((e) => e.name === aliasEffect.name && e.match_type === 'alias'));
  const filtered = await search.searchAdverseEffects(db, {
    query: 'головная боль',
    drugIds: ['D12'],
    context: 'приём',
  });
  for (const e of filtered.confirmed.results)
    for (const d of e.drugs) {
      assert.equal(d.document_id, 'D12');
      assert.ok(d.evidence.every((r) => r.context === 'приём'));
    }
});
test('embedding indexing persists Float32, resumes completed batches, rejects malformed dimensions and idempotently validates namespace', async (t) => {
  const { db } = fixture(t);
  const fake = client();
  const original = fake.embed;
  fake.embed = async function (texts) {
    if (this.calls === 1) {
      this.calls++;
      const error = new Error('secret provider response must not escape');
      error.phase = 'tokens';
      error.networkCode = 'ECONNRESET';
      throw error;
    }
    return original.call(this, texts);
  };
  await assert.rejects(indexEmbeddings(db, { client: fake, batchSize: 16 }), /index_failed/);
  assert.equal(namespaceStatus(db)[0].status, 'partial');
  assert.equal(namespaceStatus(db)[0].valid_count, 16);
  assert.equal(namespaceStatus(db)[0].last_error.code, 'index_failed');
  assert.equal(namespaceStatus(db)[0].last_error.phase, 'tokens');
  assert.equal(namespaceStatus(db)[0].last_error.networkCode, 'ECONNRESET');
  assert.ok(!JSON.stringify(namespaceStatus(db)[0]).includes('secret provider'));
  fake.embed = original;
  const indexed = await indexEmbeddings(db, { client: fake, batchSize: 16 });
  assert.equal(indexed.ready, true);
  assert.equal(indexed.last_error, null);
  assert.equal(indexed.resumed, 16);
  assert.equal(indexed.embedded, entities(db).length - 16);
  const calls = fake.calls;
  assert.equal((await indexEmbeddings(db, { client: fake })).embedded, 0);
  assert.equal(fake.calls, calls);
  const row = db.prepare('SELECT * FROM embeddings LIMIT 1').get();
  assert.equal(row.vector.length, 12);
  assert.equal(row.dimensions, 3);
  await assert.rejects(indexEmbeddings(db, { client: { ...fake, dimensions: 4 } }), /namespace_dimensions_mismatch/);
  const bad = { model: 'offline-bad', dimensions: 3, embed: async () => ({ model: 'offline-bad', vectors: [[1, 2]] }) };
  await assert.rejects(indexEmbeddings(db, { client: bad, batchSize: 1 }), /invalid_dimensions/);
  assert.equal(namespaceStatus(db, bad.model)[0].ready, false);
  for (const vector of [
    [0, 0, 0],
    [1, NaN, 0],
    [Infinity, 0, 1],
  ]) {
    const invalid = {
      model: 'offline-invalid',
      dimensions: 3,
      embed: async () => ({ model: 'offline-invalid', vectors: [vector] }),
    };
    await assert.rejects(indexEmbeddings(db, { client: invalid, batchSize: 1 }), /invalid_vector/);
    assert.equal(namespaceStatus(db, invalid.model)[0].valid_count, 0);
  }
});
test('semantic cosine/hybrid and candidate-only migraine, stale hashes and generations never use an old namespace', async (t) => {
  const { db } = fixture(t);
  const fake = client();
  await indexEmbeddings(db, { client: fake, batchSize: 16 });
  const semantic = await search.searchText(db, {
    query: 'головная боль',
    mode: 'semantic',
    client: fake,
    drugIds: ['D12'],
    limit: 1,
  });
  assert.equal(semantic.available, true);
  assert.equal(semantic.results[0].document_id, 'D12');
  assert.equal(semantic.results[0].match_type, 'semantic');
  assert.ok(semantic.results[0].score <= 1);
  const hybrid = await search.searchText(db, { query: 'головная боль', mode: 'hybrid', client: fake, limit: 1 });
  assert.equal(hybrid.fallback, null);
  assert.equal(hybrid.results[0].match_type, 'hybrid');
  const migraine = await search.searchAdverseEffects(db, { query: 'мигрень', semantic: true, client: fake, limit: 1 });
  assert.equal(migraine.confirmed.total, 0);
  assert.equal(migraine.candidates.results[0].effect_id, 'AE0075');
  assert.equal(migraine.candidates.results[0].match_type, 'semantic');
  db.prepare("UPDATE embeddings SET content_hash='stale' WHERE entity_type='effect' AND entity_id='AE0075'").run();
  assert.equal(namespaceStatus(db)[0].ready, false);
  const calls = fake.calls;
  assert.equal((await search.searchText(db, { query: 'боль', mode: 'semantic', client: fake })).available, false);
  assert.equal(fake.calls, calls);
  await indexEmbeddings(db, { client: fake });
  assert.equal(namespaceStatus(db)[0].ready, true);
  store.importCorpus(db, { rebuild: true });
  assert.equal(namespaceStatus(db).length, 0);
  assert.equal((await search.searchText(db, { query: 'боль', mode: 'semantic', client: fake })).available, false);
});
test('tools schemas/dispatcher block unknown or injected arguments; offline CLI returns JSON and safe errors', async (t) => {
  const { db, filename } = fixture(t);
  const tools = createKnowledgeTools(db);
  assert.equal(toolDefinitions.length, 6);
  assert.equal((await tools.searchDrugs({ publicReferenceTerm: 'авиандр' })).results[0].id, 'D01');
  await assert.rejects(tools.dispatch('__proto__', {}), /unknown_tool/);
  await assert.rejects(tools.searchText({ publicReferenceTerm: 'боль', client: {} }), /invalid_tool_arguments/);
  await assert.rejects(tools.readSection({ documentId: 'D01' }), /invalid_tool_arguments/);
  const run = (...args) =>
    spawnSync(process.execPath, ['scripts/medication_knowledge.js', ...args], {
      encoding: 'utf8',
      cwd: path.resolve(__dirname, '../..'),
    });
  for (const args of [
    ['help'],
    ['--help'],
    ['status', '--db', filename],
    ['drugs', '--db', filename, '--query', 'авиандр'],
    ['adverse', '--db', filename, '--query', 'мигрень', '--no-candidates'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(JSON.parse(result.stdout));
  }
  const bad = run('search', '--db', filename, '--query', 'secret patient canary', '--limit', 'NaN');
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.equal(JSON.parse(bad.stderr).error, 'invalid_tool_arguments');
  assert.ok(!bad.stderr.includes('canary'));
});
