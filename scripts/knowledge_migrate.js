#!/usr/bin/env node
'use strict';

// Применяет миграции Postgres-хранилища знаний. Адрес — KNOWLEDGE_DATABASE_URL.
// Вывод — JSON; код выхода 1 при ошибке.
const { createPool, healthcheck, close } = require('../src/modules/knowledge/pg');
const { migrate } = require('../src/modules/knowledge/migrate');

async function main() {
  const pool = createPool();
  try {
    const result = await migrate(pool);
    const health = await healthcheck(pool);
    process.stdout.write(`${JSON.stringify({ ...result, health })}\n`);
    if (!health.ok) process.exitCode = 1;
  } finally {
    await close(pool);
  }
}

main().catch((error) => {
  process.stderr.write(`knowledge_migrate: ${error.message}\n`);
  process.exit(1);
});
