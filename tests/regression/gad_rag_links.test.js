'use strict';
// covers: GAD methods digitization — application links, preserved clinical context/source.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const registry = require('../../src/modules/clinical/instruments/gad_methods.json');
const root = path.resolve(__dirname, '../..');
// Прежний формат RAG ГТР (docs/clinrecs/rag) перенесён в archive/clinrecs-legacy-2026-10-23; без него тесты пропускаются.
const skip = !fs.existsSync(path.join(root, 'docs/clinrecs/rag/02_gad')) && 'нет docs/clinrecs/rag (архив)';

function run(argument) {
  const result = spawnSync('python3', ['-I', 'scripts/clinrecs/resolve_gad_rag.py', argument], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('ГТР RAG: all chunks retain verified source context or resolve to a method card', { skip }, () => {
  assert.match(run('--verify'), /Context assembly verified for all 147 chunks/);
});

test('ГТР RAG: method retrieval gives canonical links without appendix full text', { skip }, () => {
  const result = JSON.parse(run('gtr_2024.chunk.1388'));
  assert.equal(result.mode, 'application_link');
  assert.deepEqual(result.fragments, []);
  const link = result.application_links[0];
  const canonical = registry.find((method) => method.appendix === 'Г1');
  for (const field of ['appendix', 'code', 'codes', 'title', 'mode', 'assignable', 'href']) {
    assert.deepEqual(link[field], canonical[field]);
  }
  assert.match(result.context_text, /\]\(\/work\?tab=tools&tool=hars\)/);
  assert.doesNotMatch(result.context_text, /Тревожное настроение|Содержание \(шаблон\)/);
});

test('ГТР RAG: psychodiagnostics enriches method references and preserves missing Г21', { skip }, () => {
  const result = JSON.parse(run('gtr_2024.chunk.0423'));
  assert.ok(result.fragments.length > 0);
  const links = result.context_metadata.appendix_links;
  for (const link of links.filter((item) => /^Г(?:[1-9]|1[0-6])$/.test(item.label))) {
    const canonical = registry.find((method) => method.appendix === link.label);
    for (const field of ['appendix', 'code', 'title', 'mode', 'assignable', 'href']) {
      assert.equal(link[field], canonical[field]);
    }
    assert.ok(link.markdown.includes(link.href));
  }
  const itt = links.find((link) => link.label === 'Г4');
  assert.deepEqual(itt.codes, ['itt_l', 'itt_s']);
  assert.match(itt.markdown, /tool=itt_l/);
  assert.match(itt.markdown, /tool=itt_s/);
  const missing = JSON.parse(run('gtr_2024.chunk.0425')).context_metadata.appendix_links.find(
    (link) => link.label === 'Г21',
  );
  assert.equal(missing.status, 'missing');
  assert.deepEqual(missing.resolved_target_ids, []);
  assert.equal(missing.href, undefined);
});

test('ГТР RAG: Г4 selection exposes both ITT forms and placeholders remain navigable', { skip }, () => {
  const itt = JSON.parse(run('gtr_2024.chunk.1686'));
  assert.deepEqual(itt.application_links[0].codes, ['itt_l', 'itt_s']);
  assert.match(itt.context_text, /tool=itt_l/);
  assert.match(itt.context_text, /tool=itt_s/);
  const placeholder = JSON.parse(run('gtr_2024.chunk.2117')).application_links[0];
  assert.equal(placeholder.appendix, 'Г8');
  assert.equal(placeholder.mode, 'awaiting_text');
  assert.equal(placeholder.assignable, false);
  assert.ok(placeholder.href.startsWith('/work?tab=tools&tool='));
});
