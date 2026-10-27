'use strict';
// covers: нагрузочный тест хранилища знаний (scripts/knowledge_loadtest.js) в миниатюре: ~2,4 тыс. чанков,
// временная БД lt_*, построение HNSW, recall против точного перебора, searchText(hybrid) при конкуренции 1 и 5.
// Нужен pgvector-инстанс: KNOWLEDGE_TEST_DATABASE_URL (право CREATE DATABASE). Основные схемы не затрагиваются.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { runLoadtest } = require('../../scripts/knowledge_loadtest');

const url = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const skip = url ? false : 'KNOWLEDGE_TEST_DATABASE_URL не задан: нужен Postgres с pgvector (deploy/compose.dev.yml)';

test('нагрузочный тест в миниатюре: загрузка, индекс, recall, latency, временная БД удалена', { skip, timeout: 240000 }, async () => {
  const log = console.error;
  console.error = () => {}; // скрипт пишет прогресс в stderr
  let report;
  try {
    report = await runLoadtest(url, {
      docs: 40,
      chunksPerDoc: 60,
      effects: 100,
      clinrecChunks: 100,
      clusters: 20,
      recallQueries: 8,
      latencyQueries: 20,
      concurrency: [1, 5],
      poolSizes: [4],
      levelSeconds: 2,
    });
  } finally {
    console.error = log;
  }
  assert.equal(report.load.med.chunks, 2400);
  assert.equal(report.builds.length, 1);
  assert.ok(report.sizes.indexes['med.chunks_embedding'] > 0);
  // на таком объёме путь приложения (HNSW + запасной точный проход) обязан совпасть с точным перебором
  for (const scope of report.recall) assert.ok(scope.recallAt10['приложение (knnRanked, depth=100)'] >= 0.95, scope.scope);
  for (const rows of Object.values(report.latency['pool=4'])) {
    for (const r of rows) {
      assert.equal(r.errors, 0);
      assert.ok(r.requests > 0 && r.p95 !== null);
    }
  }
  const admin = new Pool({ connectionString: url, max: 1 });
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [report.database]);
    assert.equal(rows.length, 0, 'временная БД должна быть удалена');
  } finally {
    await admin.end();
  }
});
