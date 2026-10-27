'use strict';
// Клинреки v2 (knowledge/clinrecs): чанкер -> корпус -> строки для импорта. Без БД и сети; нужен python3.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadClinrecV2, MAX_CHARS } = require('../../src/modules/knowledge/clinrec_v2');
const { buildDocumentRows } = require('../../src/modules/knowledge/clinrec_import');

const ROOT = path.join(__dirname, '../../knowledge/clinrecs');
const py = spawnSync('python3', ['--version']);
const skip = py.status !== 0 && 'нет python3';

function build(slug) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'clinrec-v2-'));
  const r = spawnSync('python3', [path.join(ROOT, 'tools/chunker.py'), path.join(ROOT, 'source', `${slug}.md`), `--out=${out}`]);
  assert.equal(r.status, 0, String(r.stderr));
  return out;
}

test('клинреки v2: чанкер и корпус — лимит, родители, режимы, метки методик и шаблонов', { skip }, () => {
  const out = build('07_panic');
  const corpus = loadClinrecV2(ROOT, { outDir: out });
  const only = { ...corpus, documents: corpus.documents.filter((d) => d.document_id === 'panic_2024') };
  assert.deepEqual(corpus.errors.filter((e) => e.document_id === 'panic_2024'), []);
  const chunks = corpus.chunks.filter((c) => c.document_id === 'panic_2024');
  assert.ok(chunks.length > 50);
  assert.ok(chunks.every((c) => c.text.length <= MAX_CHARS && c.embed && c.kind === 'main'));
  assert.equal(new Set(chunks.map((c) => c.id)).size, chunks.length);
  const parentIds = new Set(corpus.parents.map((p) => p.id));
  for (const c of chunks.filter((x) => x.parent_id)) {
    assert.ok(parentIds.has(c.parent_id), `родитель ${c.parent_id}`);
    assert.ok(['parent', 'window'].includes(c.mode));
  }
  assert.ok(chunks.filter((c) => !c.parent_id).every((c) => c.mode === 'self'));
  assert.ok(chunks.some((c) => c.metadata.methods.some((m) => m.code === 'gad7' || m.code === 'phq9' || m.url)));
  const tpl = chunks.filter((c) => c.metadata.templates.length);
  assert.deepEqual(tpl.flatMap((c) => c.metadata.templates.map((t) => t.code)), ['b-epi']);
  const rows = buildDocumentRows({ ...corpus, documents: only.documents }, 'panic_2024');
  assert.equal(rows.chunks.length, chunks.length);
  assert.ok(rows.chunks.every((c) => c.embed_text_hash && c.embed_text.startsWith('Паническое расстройство')));
});
