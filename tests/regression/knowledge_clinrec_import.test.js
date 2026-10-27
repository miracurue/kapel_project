'use strict';

// covers: импорт клинреков в Postgres (clinrec) и возобновляемая векторизация; без сети, фейковый embedding-клиент.
// Нужен pgvector-инстанс: KNOWLEDGE_TEST_DATABASE_URL (используется только для CREATE/DROP временной БД, данные не трогаются).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPool, close } = require('../../src/modules/knowledge/pg');
const { migrate } = require('../../src/modules/knowledge/migrate');
const { importClinrec, buildDocumentRows, sha256 } = require('../../src/modules/knowledge/clinrec_import');
const { embedClinrec, embedStatus } = require('../../src/modules/knowledge/embed_pg');
const { summarizeClinrecCorpus } = require('../../src/modules/knowledge/clinrec_corpus');

const url = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const skip = url ? false : 'KNOWLEDGE_TEST_DATABASE_URL не задан';
const DIM = 2560;

function chunk(doc, n, over = {}) {
  const text = over.text ?? `Текст чанка ${doc} ${n}`;
  const heading_path = over.heading_path ?? ['Раздел'];
  const embed = over.embed ?? true;
  return {
    id: `${doc}.chunk.${n}`,
    document_id: doc,
    kind: 'main',
    source_kind: 'text',
    collection: 'chunks',
    parent_id: `${doc}.p1`,
    mode: 'self',
    context_parent_id: null,
    heading_path,
    title: '',
    section_id: `${doc}.s1`,
    text,
    embed_text: embed ? ['Док', heading_path.join(' > '), text].join('\n') : '',
    source_text: text,
    span: { start: 0, end: 5 },
    neighbors: { previous_id: null, next_id: null, limit_each_side: null },
    depends_on: { required_chunk_ids: [], always_include_spans: [] },
    atomic_oversize: false,
    retrieval_reason: null,
    metadata: {},
    embed,
    est_tokens: 10,
    oversized: false,
  };
}
function miniCorpus() {
  const docs = ['d1', 'd2'];
  const corpus = { documents: [], sections: [], parents: [], chunks: [], references: [], warnings: [], errors: [] };
  for (const d of docs) {
    corpus.documents.push({
      document_id: d,
      dir: `01_${d}`,
      title: `Док ${d}`,
      guideline_id: 1,
      clinical_year: 2024,
      source_file: null,
      source_sha256: null,
      source_status: 'missing',
      schema_version: 2,
      references_completeness: null,
      unresolved_citation_numbers: 0,
    });
    corpus.sections.push({
      id: `${d}.s0`,
      document_id: d,
      parent_id: null,
      level: 1,
      title: 'Корень',
      kind: 'document',
      collection: null,
      start_line: 1,
      end_line_exclusive: 9,
      span: null,
      own_span: null,
    });
    corpus.sections.push({
      id: `${d}.s1`,
      document_id: d,
      parent_id: `${d}.s0`,
      level: 2,
      title: 'Раздел',
      kind: 'section',
      collection: null,
      start_line: 2,
      end_line_exclusive: 5,
      span: { start: 0, end: 9 },
      own_span: null,
    });
    corpus.parents.push({
      id: `${d}.p1`,
      document_id: d,
      kind: 'main',
      title: 'P',
      section_id: `${d}.s1`,
      heading_path: ['Раздел'],
      text: 'Родитель',
      source_text: 'Родитель',
      span: { start: 0, end: 8 },
      child_ids: [],
      metadata: {},
      section_subtree_span: null,
      ancestor_context_spans: [],
      required_context_spans: [],
      original_appendix_label: null,
    });
    for (let n = 1; n <= 5; n += 1) corpus.chunks.push(chunk(d, n));
    corpus.chunks.push(chunk(d, 6, { embed: false, text: 'Не для вектора' }));
    corpus.chunks.push({
      ...chunk(d, 7, { embed: false }),
      id: `${d}.sup.1`,
      kind: 'supporting',
      mode: null,
      parent_id: null,
      collection: 'supporting',
    });
    corpus.references.push({
      id: `${d}.ref.1`,
      document_id: d,
      number: 1,
      text: 'Литература 1',
      span: null,
      source_text: 'Литература 1',
      continuation_lines: null,
    });
    corpus.chunks.push({
      ...chunk(d, 8, { embed: false, text: 'Литература 1' }),
      id: `${d}.ref.1`,
      kind: 'reference',
      mode: null,
      parent_id: null,
      collection: 'references',
    });
  }
  return corpus;
}
// Детерминированный вектор из текста; 'LONG' в тексте -> input_token_limit, как у настоящего клиента.
function fakeClient(opts = {}) {
  const calls = [];
  return {
    model: 'EmbeddingsGigaR',
    calls,
    async embed(texts) {
      calls.push(texts.slice());
      if (opts.failOnCall && calls.length === opts.failOnCall) {
        const e = new Error('x');
        e.code = opts.failCode || 'http';
        e.status = opts.failStatus || 503;
        throw e;
      }
      if (texts.some((t) => t.includes('LONG'))) {
        const e = new Error('limit');
        e.code = 'input_token_limit';
        throw e;
      }
      const vectors = texts.map((t) => {
        const h = crypto.createHash('sha256').update(t).digest();
        return Array.from({ length: opts.dim || DIM }, (_, i) => (h[i % 32] + 1) / 256 + i / 1e6);
      });
      return { model: 'EmbeddingsGigaR', vectors };
    },
  };
}

test('buildDocumentRows: дубли id раздела не теряются, хеш = sha256 embed_text', () => {
  const c = miniCorpus();
  c.sections.push({ ...c.sections[1], title: 'Дубль' });
  const r = buildDocumentRows(c, 'd1');
  assert.equal(r.sections.length, 3);
  assert.equal(new Set(r.sections.map((s) => s.id)).size, 3);
  assert.equal(r.sections[2].meta.duplicate_of, 'd1.s1');
  const emb = r.chunks.find((x) => x.embed);
  assert.equal(emb.embed_text_hash, sha256(emb.embed_text));
  assert.equal(r.chunks.filter((x) => x.embed).length, 5);
  assert.equal(buildDocumentRows(miniCorpus(), 'd1').fingerprint, buildDocumentRows(miniCorpus(), 'd1').fingerprint);
});

test('clinrec import + embed на Postgres', { skip }, async (t) => {
  const name = `kn_test_${process.pid}_${Date.now() % 100000}`;
  const admin = createPool({ connectionString: url, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(url);
  u.pathname = `/${name}`;
  const pool = createPool({ connectionString: u.href, max: 4 });
  t.after(async () => {
    await close(pool);
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await close(admin);
  });
  await migrate(pool);
  const corpus = miniCorpus();
  const summary = summarizeClinrecCorpus(corpus);
  const q = async (sql, p) => (await pool.query(sql, p)).rows;

  await t.test('первый импорт: счётчики равны корпусу, повтор не меняет', async () => {
    const r = await importClinrec(pool, corpus);
    assert.deepEqual(
      r.documents.map((d) => d.status),
      ['created', 'created'],
    );
    assert.equal(r.total.chunks, summary.totals.chunks);
    assert.equal(r.total.embeddable, 10);
    assert.equal(r.total.refs, 2);
    const again = await importClinrec(pool, corpus);
    assert.deepEqual(
      again.documents.map((d) => d.status),
      ['unchanged', 'unchanged'],
    );
    const [row] = await q(
      `SELECT count(*)::int AS n FROM clinrec.chunks WHERE mode IS NULL AND kind IN ('supporting','reference')`,
    );
    assert.equal(row.n, 4);
  });

  await t.test('embed: пакет сохраняется, слишком длинный чанк пропускается с причиной, не усекается', async () => {
    // d2.chunk.3 станет «слишком длинным»
    const c2 = miniCorpus();
    const idx = c2.chunks.findIndex((x) => x.id === 'd2.chunk.3');
    c2.chunks[idx] = chunk('d2', 3, { text: 'LONG текст' });
    await importClinrec(pool, c2);
    const client = fakeClient();
    const report = await embedClinrec(pool, { client, batchSize: 8, sleep: async () => {} });
    assert.equal(report.embedded, 9);
    assert.deepEqual(
      report.skipped.map((s) => [s.id, s.reason]),
      [['d2.chunk.3', 'input_token_limit']],
    );
    const st = await embedStatus(pool);
    assert.deepEqual(st.total, { embeddable: 10, embedded: 9, skipped: 1, pending: 0 });
    const [dims] = await q(
      `SELECT count(DISTINCT vector_dims(embedding))::int AS v, min(vector_dims(embedding))::int AS d FROM clinrec.chunks WHERE embedding IS NOT NULL`,
    );
    assert.deepEqual(dims, { v: 1, d: DIM });
    const [chunkRow] = await q(
      `SELECT embed_text, embedding IS NULL AS no_vec FROM clinrec.chunks WHERE id='d2.chunk.3'`,
    );
    assert.equal(chunkRow.no_vec, true);
    assert.ok(chunkRow.embed_text.includes('LONG текст'), 'текст не усечён');
    // повторный запуск ничего не вызывает
    const c = fakeClient();
    const second = await embedClinrec(pool, { client: c, sleep: async () => {} });
    assert.equal(c.calls.length, 0);
    assert.equal(second.pending, 0);
  });

  await t.test(
    'повторный импорт: векторы сохраняются у неизменённого текста, у изменённого сбрасываются; причина пропуска живёт',
    async () => {
      const c3 = miniCorpus();
      c3.chunks[c3.chunks.findIndex((x) => x.id === 'd2.chunk.3')] = chunk('d2', 3, { text: 'LONG текст' });
      c3.chunks[c3.chunks.findIndex((x) => x.id === 'd1.chunk.2')] = chunk('d1', 2, { text: 'Изменённый текст' });
      const r = await importClinrec(pool, c3);
      assert.deepEqual(
        r.documents.map((d) => d.status),
        ['replaced', 'unchanged'],
      );
      assert.equal(r.documents[0].vectors_kept, 4);
      const st = await embedStatus(pool);
      assert.deepEqual(st.total, { embeddable: 10, embedded: 8, skipped: 1, pending: 1 });
      // принудительная замена d2: вектора и причина пропуска переносятся
      const f = await importClinrec(pool, c3, { force: true, documents: ['d2'] });
      assert.equal(f.documents[0].status, 'replaced');
      assert.equal(f.documents[0].vectors_kept, 5);
      const done = await embedClinrec(pool, { client: fakeClient(), sleep: async () => {} });
      assert.equal(done.embedded, 1);
      assert.equal(done.resumed, 8);
    },
  );

  await t.test('ошибка записи откатывает замену документа целиком', async () => {
    const broken = miniCorpus();
    broken.chunks.find((x) => x.id === 'd1.chunk.1').mode = 'bogus';
    broken.chunks.find((x) => x.id === 'd1.chunk.1').text = 'другое';
    const before = await q(
      `SELECT count(*)::int AS n, count(embedding)::int AS v FROM clinrec.chunks WHERE document_id='d1'`,
    );
    await assert.rejects(importClinrec(pool, broken, { documents: ['d1'] }));
    const after = await q(
      `SELECT count(*)::int AS n, count(embedding)::int AS v FROM clinrec.chunks WHERE document_id='d1'`,
    );
    assert.deepEqual(after, before);
  });

  await t.test('корпус с ошибками блокирует импорт', async () => {
    const bad = miniCorpus();
    bad.errors.push({ document_id: 'd1', code: 'x', message: 'x' });
    await assert.rejects(importClinrec(pool, bad), (e) => e.code === 'corpus_errors');
  });

  await t.test(
    'возобновление: сбой посреди прогона не теряет записанные пакеты; временные сбои повторяются',
    async () => {
      const c = miniCorpus();
      c.chunks.push(
        ...[11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((n) => chunk('d1', n, { text: `Дополнительный ${n}` })),
      );
      await importClinrec(pool, c);
      // второй вызов клиента -> нетранзиентная ошибка
      const failing = fakeClient({ failOnCall: 2, failCode: 'invalid_embeddings' });
      await assert.rejects(
        embedClinrec(pool, { client: failing, batchSize: 4, sleep: async () => {} }),
        (e) => e.code === 'invalid_embeddings',
      );
      const mid = await embedStatus(pool);
      assert.ok(mid.total.pending > 0 && mid.total.embedded >= 4);
      const sleeps = [];
      const flaky = fakeClient({ failOnCall: 1, failStatus: 429 });
      const rep = await embedClinrec(pool, { client: flaky, batchSize: 4, sleep: async (ms) => sleeps.push(ms) });
      assert.equal(rep.retries, 1);
      assert.deepEqual(sleeps, [1000]);
      const st = await embedStatus(pool);
      assert.equal(st.total.pending, 0);
      assert.equal(st.total.embedded + st.total.skipped, st.total.embeddable);
    },
  );

  await t.test('неверная размерность ответа не записывается', async () => {
    const c = miniCorpus();
    c.chunks.push(chunk('d1', 30, { text: 'Новый для размерности' }));
    await importClinrec(pool, c, { documents: ['d1'] });
    await assert.rejects(
      embedClinrec(pool, { client: fakeClient({ dim: 1024 }), sleep: async () => {} }),
      (e) => e.code === 'invalid_dimensions',
    );
    const [row] = await q(`SELECT embedding IS NULL AS n FROM clinrec.chunks WHERE id='d1.chunk.30'`);
    assert.equal(row.n, true);
  });

  await t.test('одинаковый embed_text векторизуется один раз', async () => {
    const c = miniCorpus();
    c.chunks.push(chunk('d1', 40, { text: 'Дубль текста' }), chunk('d1', 41, { text: 'Дубль текста' }));
    await importClinrec(pool, c, { documents: ['d1'] });
    const cl = fakeClient();
    const rep = await embedClinrec(pool, { client: cl, sleep: async () => {} });
    assert.equal(cl.calls.flat().filter((x) => x.includes('Дубль текста')).length, 1);
    assert.equal(rep.pending, 2);
    assert.equal(rep.embedded, 2);
  });
});
