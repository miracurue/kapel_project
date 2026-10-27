#!/usr/bin/env node
'use strict';
// Проверка нормализации клинреков без БД и сети. Печатает JSON-сводку; код выхода 1, если есть errors.
// Использование: node scripts/knowledge_clinrec_check.js [каталог rag] [--max-tokens N] [--chars-per-token X]
const path = require('node:path');
const { loadClinrecCorpus, summarizeClinrecCorpus } = require('../src/modules/knowledge/clinrec_corpus');

const args = process.argv.slice(2);
const opts = {};
let rootDir = path.join(__dirname, '..', 'docs', 'clinrecs', 'rag');
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--max-tokens') opts.maxTokens = Number(args[++i]);
  else if (args[i] === '--chars-per-token') opts.charsPerToken = Number(args[++i]);
  else rootDir = path.resolve(args[i]);
}

const corpus = loadClinrecCorpus(rootDir, opts);
const summary = summarizeClinrecCorpus(corpus);
const report = {
  root: rootDir,
  ok: corpus.errors.length === 0,
  ...summary,
  documents_meta: corpus.documents.map((d) => ({
    document_id: d.document_id,
    title: d.title,
    source_status: d.source_status,
    unresolved_citation_numbers: d.unresolved_citation_numbers,
  })),
  warnings: corpus.warnings,
  errors: corpus.errors,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.ok ? 0 : 1);
