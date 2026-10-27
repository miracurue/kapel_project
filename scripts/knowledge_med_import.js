#!/usr/bin/env node
'use strict';

// Перенос базы лекарств SQLite -> Postgres (схема med).
//   node scripts/knowledge_med_import.js import [--sqlite путь]
//   node scripts/knowledge_med_import.js verify [--sqlite путь]
// Адрес: KNOWLEDGE_DATABASE_URL. Отчёт — JSON в stdout. Код выхода 1, если verify не прошёл.
const { createPool, close } = require('../src/modules/knowledge/pg');
const { migrate } = require('../src/modules/knowledge/migrate');
const { importMed, verifyMed, DEFAULT_SQLITE } = require('../src/modules/knowledge/med_import');

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const i = rest.indexOf('--sqlite');
  const sqlitePath = i >= 0 ? rest[i + 1] : DEFAULT_SQLITE;
  if (!['import', 'verify'].includes(command)) {
    console.error('usage: knowledge_med_import.js import|verify [--sqlite path]');
    process.exit(2);
  }
  const pool = createPool();
  try {
    let report;
    if (command === 'import') {
      await migrate(pool);
      report = await importMed(pool, { sqlitePath });
    } else {
      report = await verifyMed(pool, { sqlitePath });
      if (!report.ok) process.exitCode = 1;
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await close(pool);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
