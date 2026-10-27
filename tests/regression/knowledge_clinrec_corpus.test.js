'use strict';
// Нормализация клинреков (docs/clinrecs/rag) без БД и сети: единый вид чанка, ссылки, счётчики, режимы parent–child.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadClinrecCorpus, summarizeClinrecCorpus } = require('../../src/modules/knowledge/clinrec_corpus');

const RAG = path.join(__dirname, '..', '..', 'docs', 'clinrecs', 'rag');
const real = fs.existsSync(RAG);

test(
  'реальные данные: 12 документов, без ошибок, id уникальны, text непуст у векторизуемых',
  { skip: !real && 'нет docs/clinrecs/rag' },
  () => {
    const c = loadClinrecCorpus(RAG);
    assert.deepEqual(c.errors, []);
    assert.equal(c.documents.length, 12);
    const ids = c.chunks.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length);
    const emb = c.chunks.filter((x) => x.embed);
    assert.ok(emb.length > 0);
    for (const ch of emb) {
      assert.ok(ch.text && ch.text.trim().length > 0, ch.id);
      assert.ok(['main', 'method', 'appendix'].includes(ch.kind), ch.id);
      assert.ok(['self', 'parent', 'window'].includes(ch.mode), ch.id);
      assert.ok(ch.parent_id, ch.id);
      assert.ok(ch.embed_text.includes(ch.text), ch.id);
    }
    for (const ch of c.chunks.filter((x) => x.kind === 'supporting' || x.kind === 'reference'))
      assert.equal(ch.embed, false);
    const sum = summarizeClinrecCorpus(c);
    assert.equal(sum.totals.embeddable, emb.length);
    // родители не векторизуются и не попадают в чанки
    const parentIds = new Set(c.parents.map((p) => p.id));
    assert.ok(!c.chunks.some((x) => parentIds.has(x.id)));
  },
);

test(
  'режимы parent–child: parent/window указывают на существующего родителя, соседи из того же родителя',
  { skip: !real && 'нет docs/clinrecs/rag' },
  () => {
    const c = loadClinrecCorpus(RAG);
    const parents = new Map(c.parents.map((p) => [p.id, p]));
    const byId = new Map(c.chunks.map((x) => [x.id, x]));
    for (const ch of c.chunks.filter((x) => x.embed)) {
      if (ch.mode !== 'self') assert.ok(parents.has(ch.context_parent_id), ch.id);
      for (const nid of [ch.neighbors.previous_id, ch.neighbors.next_id].filter(Boolean)) {
        assert.equal(byId.get(nid).parent_id, ch.parent_id, ch.id);
      }
    }
  },
);

test(
  'source_text неизменен: у text не длиннее source_text, text без библиографических номеров, кроме отмеченных',
  { skip: !real && 'нет docs/clinrecs/rag' },
  () => {
    const c = loadClinrecCorpus(RAG);
    for (const ch of c.chunks.filter((x) => x.embed)) assert.ok(ch.text.length <= ch.source_text.length, ch.id);
    const residual = c.warnings.filter((w) => w.code === 'citation_marks_in_text');
    // остатки допустимы только как предупреждение, не как ошибка
    assert.ok(residual.every((w) => w.count > 0));
  },
);

function tinyCorpus(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinrec-'));
  const d = path.join(dir, '01_x');
  fs.mkdirSync(d);
  const doc = 'x_1';
  const span = { start: 0, end: 5, start_line: 1, end_line: 1 };
  const chunk = (id, extra = {}) => ({
    id,
    document_id: doc,
    title: 't',
    section_id: 's1',
    heading_path: ['X', 'Y'],
    span,
    source_text: 'Текст [1]',
    text: 'Текст',
    metadata: { reference_ids: [] },
    kind: 'recommendation',
    collection: 'clinical',
    index_in_vector_search: true,
    parent_id: 'x_1.parent.1',
    retrieval: {
      mode: 'window',
      context_parent_id: 'x_1.parent.1',
      previous_chunk_id: null,
      next_chunk_id: null,
      required_chunk_ids: [],
      always_include_spans: [],
      neighbor_limit_each_side: 1,
      atomic_oversize: false,
    },
    ...extra,
  });
  const files = {
    chunks: {
      schema_version: '1.0',
      document_id: doc,
      chunks: [
        chunk('x_1.chunk.1', {
          retrieval: {
            mode: 'window',
            context_parent_id: 'x_1.parent.1',
            previous_chunk_id: null,
            next_chunk_id: 'x_1.chunk.2',
            required_chunk_ids: [],
            always_include_spans: [],
            neighbor_limit_each_side: 1,
            atomic_oversize: false,
          },
        }),
        chunk('x_1.chunk.2', {
          retrieval: {
            mode: 'window',
            context_parent_id: 'x_1.parent.1',
            previous_chunk_id: 'x_1.chunk.1',
            next_chunk_id: null,
            required_chunk_ids: [],
            always_include_spans: [],
            neighbor_limit_each_side: 1,
            atomic_oversize: false,
          },
        }),
      ],
    },
    parents: {
      schema_version: '1.0',
      document_id: doc,
      parents: [
        {
          id: 'x_1.parent.1',
          document_id: doc,
          title: 'p',
          section_id: 's1',
          heading_path: ['X'],
          span,
          source_text: 'Текст',
          text: 'Текст',
          child_ids: ['x_1.chunk.1', 'x_1.chunk.2'],
          index_in_vector_search: false,
        },
      ],
    },
    sections: {
      schema_version: '1.0',
      document_id: doc,
      sections: [{ id: 's1', parent: null, level: 1, title: 'X', kind: 'section', span }],
    },
    methods: { schema_version: '1.0', document_id: doc, parents: [], chunks: [] },
    appendices: { schema_version: '1.0', document_id: doc, appendices: [] },
    supporting: { schema_version: '1.0', document_id: doc, records: [] },
    references: {
      schema_version: '1.0',
      document_id: doc,
      items: [],
      unresolved_citation_numbers: [],
      completeness: 'x',
    },
    manifest: { schema_version: '1.0', document_id: doc, title: 'Док', counts: {} },
  };
  if (mutate) mutate(files);
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(d, `${k}.json`), JSON.stringify(v));
  return dir;
}
const codes = (arr) => arr.map((x) => x.code);

test('синтетический корпус: корректный проходит без ошибок', () => {
  const c = loadClinrecCorpus(tinyCorpus());
  assert.deepEqual(c.errors, []);
  assert.equal(c.chunks.filter((x) => x.embed).length, 2);
  assert.equal(c.chunks[0].embed_text, 'Док\nX > Y\nТекст');
});

test('синтетический корпус: векторизуемый чанк без text — ошибка, не пропуск', () => {
  const c = loadClinrecCorpus(
    tinyCorpus((f) => {
      delete f.chunks.chunks[0].text;
    }),
  );
  assert.ok(codes(c.errors).includes('embed_chunk_without_text'));
});

test('синтетический корпус: дубли id, битые родитель/сосед/раздел/зависимость', () => {
  const dup = loadClinrecCorpus(
    tinyCorpus((f) => {
      f.chunks.chunks[1].id = 'x_1.chunk.1';
    }),
  );
  assert.ok(codes(dup.errors).includes('duplicate_chunk_id'));
  const bad = loadClinrecCorpus(
    tinyCorpus((f) => {
      f.chunks.chunks[0].parent_id = 'x_1.parent.404';
      f.chunks.chunks[1].retrieval.previous_chunk_id = 'x_1.chunk.404';
      f.chunks.chunks[1].section_id = 'nope';
      f.chunks.chunks[1].retrieval.required_chunk_ids = ['zzz'];
    }),
  );
  for (const code of ['parent_missing', 'neighbor_missing', 'section_missing', 'required_missing'])
    assert.ok(codes(bad.errors).includes(code), code);
});

test('синтетический корпус: родитель в индексе и режим parent без родителя — ошибки', () => {
  const c = loadClinrecCorpus(
    tinyCorpus((f) => {
      f.parents.parents[0].index_in_vector_search = true;
      f.chunks.chunks[0].retrieval.context_parent_id = null;
    }),
  );
  assert.ok(codes(c.errors).includes('parent_indexed'));
  assert.ok(codes(c.errors).includes('context_parent_missing'));
});

test('синтетический корпус: oversized помечается предупреждением, а несовпадение SHA исходника — ошибка', () => {
  const big = loadClinrecCorpus(
    tinyCorpus((f) => {
      f.chunks.chunks[0].text = 'я'.repeat(9000);
      f.chunks.chunks[0].source_text = 'я'.repeat(9000);
    }),
  );
  assert.ok(codes(big.warnings).includes('oversized_candidates'));
  assert.equal(big.chunks[0].oversized, true);
  assert.equal(big.chunks[1].oversized, false);
  const dir = tinyCorpus();
  const src = path.join(dir, 'src.md');
  fs.writeFileSync(src, 'Текст');
  const mfPath = path.join(dir, '01_x', 'manifest.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  mf.source_file = 'src.md';
  mf.source_sha256 = '0'.repeat(64);
  fs.writeFileSync(mfPath, JSON.stringify(mf));
  const c = loadClinrecCorpus(dir, { repoRoot: dir });
  assert.ok(codes(c.errors).includes('source_sha_mismatch'));
  const missing = loadClinrecCorpus(
    tinyCorpus((f) => {
      f.manifest.source_file = 'нет.md';
      f.manifest.source_sha256 = 'a'.repeat(64);
    }),
  );
  assert.ok(codes(missing.warnings).includes('source_missing'));
});
