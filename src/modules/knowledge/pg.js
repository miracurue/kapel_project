'use strict';

// Подключение к Postgres хранилища знаний (схемы med и clinrec). Основное приложение
// остаётся на SQLite; сюда не попадают данные пациентов.
const { Pool } = require('pg');

function readConfig(env = process.env) {
  const connectionString = env.KNOWLEDGE_DATABASE_URL || '';
  const int = (name, def, min, max) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer ${min}..${max}`);
    return n;
  };
  return {
    connectionString,
    max: int('KNOWLEDGE_DB_POOL_MAX', 10, 1, 100),
    connectionTimeoutMillis: int('KNOWLEDGE_DB_CONNECT_TIMEOUT_MS', 5000, 100, 120000),
    idleTimeoutMillis: int('KNOWLEDGE_DB_IDLE_TIMEOUT_MS', 30000, 1000, 600000),
    statement_timeout: int('KNOWLEDGE_DB_STATEMENT_TIMEOUT_MS', 30000, 100, 3600000),
    ssl: env.KNOWLEDGE_DB_SSL === '1' ? { rejectUnauthorized: true } : undefined,
  };
}

function createPool(overrides = {}, env = process.env) {
  const config = { ...readConfig(env), ...overrides };
  if (!config.connectionString) throw new Error('KNOWLEDGE_DATABASE_URL is not set');
  const pool = new Pool({ ...config, application_name: 'cc-knowledge' });
  // Ошибка простаивающего клиента не должна ронять процесс.
  pool.on('error', () => {});
  return pool;
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* соединение уже потеряно */
    }
    throw error;
  } finally {
    client.release();
  }
}

// Массив чисел -> текстовый литерал pgvector ('[0.1,0.2]'), параметр с приведением ::halfvec.
function toVectorLiteral(values) {
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) throw new Error('vector must be an array');
  for (const v of values) if (!Number.isFinite(v)) throw new Error('vector contains a non-finite value');
  return `[${Array.from(values).join(',')}]`;
}

async function healthcheck(pool) {
  const started = Date.now();
  try {
    const { rows } = await pool.query(
      `SELECT (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector,
              (SELECT extversion FROM pg_extension WHERE extname = 'pg_trgm') AS pg_trgm,
              (SELECT count(*)::int FROM pg_namespace WHERE nspname IN ('med', 'clinrec')) AS schemas`,
    );
    const row = rows[0];
    return { ok: Boolean(row.vector && row.pg_trgm && row.schemas === 2), ms: Date.now() - started, ...row };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: error.code || error.name };
  }
}

async function close(pool) {
  await pool.end();
}

module.exports = { readConfig, createPool, withTransaction, toVectorLiteral, healthcheck, close };
