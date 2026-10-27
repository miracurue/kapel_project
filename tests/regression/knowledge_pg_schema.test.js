'use strict';

// Схема Postgres-хранилища знаний. Нужен pgvector-инстанс: KNOWLEDGE_TEST_DATABASE_URL.
// Тест создаёт и удаляет собственную временную БД на сервере из KNOWLEDGE_TEST_DATABASE_URL, чужие данные не затрагиваются.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPool, close, toVectorLiteral, withTransaction, healthcheck } = require('../../src/modules/knowledge/pg');
const { migrate } = require('../../src/modules/knowledge/migrate');

const url = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const skip = url
  ? false
  : 'KNOWLEDGE_TEST_DATABASE_URL не задан: запустите Postgres (deploy/compose.dev.yml, сервис knowledge-db) и укажите адрес тестовой БД';
const DIM = 2560;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}
function vec(seed) {
  const r = rng(seed);
  return Array.from({ length: DIM }, r);
}

test('knowledge pg schema', { skip }, async (t) => {
  const dbName = `ks_schema_${process.pid}_${Date.now()}`;
  const admin = createPool({ connectionString: url });
  await admin.query(`CREATE DATABASE ${dbName}`);
  const tmpUrl = new URL(url);
  tmpUrl.pathname = `/${dbName}`;
  const pool = createPool({ connectionString: tmpUrl.toString() });
  t.after(async () => {
    await close(pool);
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await close(admin);
  });

  await t.test('миграции: чистый прогон и идемпотентный повтор', async () => {
    const first = await migrate(pool);
    assert.equal(first.applied.length, first.total);
    const second = await migrate(pool);
    assert.deepEqual(second.applied, []);
    const parallel = await Promise.all([migrate(pool), migrate(pool)]);
    assert.deepEqual(
      parallel.map((p) => p.applied),
      [[], []],
    );
    const health = await healthcheck(pool);
    assert.equal(health.ok, true);
    const [major, minor] = health.vector.split('.').map(Number);
    assert.ok(major > 0 || minor >= 7, `pgvector ${health.vector} < 0.7`);
  });

  await t.test('индексы HNSW, GIN и trigram существуют', async () => {
    const { rows } = await pool.query(
      `SELECT schemaname, tablename, indexdef FROM pg_indexes WHERE schemaname IN ('med','clinrec')`,
    );
    const defs = rows.map((r) => `${r.schemaname}.${r.tablename}: ${r.indexdef}`);
    for (const table of ['med.chunks', 'med.effects', 'clinrec.chunks']) {
      assert.ok(
        defs.some((d) => d.startsWith(`${table}:`) && /USING hnsw \(embedding halfvec_cosine_ops\)/.test(d)),
        `HNSW на ${table}`,
      );
    }
    for (const table of ['med.chunks', 'clinrec.chunks']) {
      assert.ok(
        defs.some((d) => d.startsWith(`${table}:`) && /USING gin \(tsv\)/.test(d)),
        `GIN tsv на ${table}`,
      );
    }
    for (const table of ['med.documents', 'med.effects', 'med.effect_aliases', 'med.effect_links']) {
      assert.ok(
        defs.some((d) => d.startsWith(`${table}:`) && /gin_trgm_ops/.test(d)),
        `trigram на ${table}`,
      );
    }
  });

  await t.test('halfvec: ближайшие по cosine через индекс', async () => {
    await pool.query(`INSERT INTO med.documents (id, drug_label, inn, source_file, sha256, markdown)
      VALUES ('d1', 'Препарат', 'мнн', 'f.md', 'x', 'текст')`);
    await pool.query(`INSERT INTO med.sections (id, document_id, level, ord, title, path, start_char, end_char, start_line)
      VALUES ('s1', 'd1', 1, 0, 'Раздел', 'Раздел', 0, 10, 1)`);
    const N = 200;
    await withTransaction(pool, async (c) => {
      for (let i = 0; i < N; i++) {
        await c.query(
          `INSERT INTO med.chunks (id, document_id, section_id, ord, text, content_hash, start_char, end_char,
             embedding, embedding_model, embedding_hash)
           VALUES ($1, 'd1', 's1', $2, $3, $4, 0, 5, $5::halfvec, 'EmbeddingsGigaR', $4)`,
          [`c${i}`, i, `фрагмент ${i}`, `h${i}`, toVectorLiteral(vec(i + 1))],
        );
      }
    });
    // запрос = слегка искажённый вектор 42
    const q = vec(43).map((x, i) => x + 0.01 * (i % 3));
    const sql = `SELECT id, embedding <=> $1::halfvec AS dist FROM med.chunks ORDER BY embedding <=> $1::halfvec LIMIT 3`;
    const { rows } = await pool.query(sql, [toVectorLiteral(q)]);
    assert.equal(rows[0].id, 'c42');
    assert.ok(rows[0].dist < rows[1].dist);

    const plan = await withTransaction(pool, async (c) => {
      await c.query('SET LOCAL enable_seqscan = off'); // на 200 строках планировщик иначе выберет seq scan
      const r = await c.query(`EXPLAIN ${sql}`, [toVectorLiteral(q)]);
      return r.rows.map((x) => x['QUERY PLAN']).join('\n');
    });
    assert.match(plan, /Index Scan using chunks_embedding/);

    // нулевое число измерений недопустимо: размерность жёсткая
    await assert.rejects(
      pool.query(`UPDATE med.chunks SET embedding = $1::halfvec WHERE id = 'c0'`, [toVectorLiteral([1, 2, 3])]),
    );
    // вектор без модели запрещён
    await assert.rejects(pool.query(`UPDATE med.chunks SET embedding_model = NULL WHERE id = 'c0'`));
  });

  await t.test('русский полнотекстовый поиск с морфологией', async () => {
    await pool.query(
      `UPDATE med.chunks SET text = 'Часто наблюдаются побочные реакции со стороны желудочно-кишечного тракта' WHERE id = 'c1'`,
    );
    const { rows } = await pool.query(`SELECT id FROM med.chunks WHERE tsv @@ plainto_tsquery('russian', $1)`, [
      'побочная реакция',
    ]);
    assert.deepEqual(
      rows.map((r) => r.id),
      ['c1'],
    );
  });

  await t.test('trigram находит опечатку в МНН', async () => {
    await pool.query(`UPDATE med.documents SET inn = 'сертралин' WHERE id = 'd1'`);
    const { rows } = await pool.query(`SELECT id FROM med.documents WHERE lower(inn) % $1`, ['сертралн']);
    assert.deepEqual(
      rows.map((r) => r.id),
      ['d1'],
    );
  });

  await t.test('clinrec: родитель, чанк, ограничения kind/mode', async () => {
    await pool.query(`INSERT INTO clinrec.documents (id, title, source_sha256) VALUES ('r1', 'КР', 'h')`);
    await pool.query(`INSERT INTO clinrec.parents (id, document_id, text) VALUES ('p1', 'r1', 'родитель')`);
    await pool.query(
      `INSERT INTO clinrec.chunks (id, document_id, kind, parent_id, mode, text, embedding, embedding_model, embedding_hash)
       VALUES ('k1', 'r1', 'main', 'p1', 'parent', 'тревожное расстройство', $1::halfvec, 'EmbeddingsGigaR', 'h')`,
      [toVectorLiteral(vec(7))],
    );
    await assert.rejects(
      pool.query(`INSERT INTO clinrec.chunks (id, document_id, kind, mode, text) VALUES ('k2','r1','bad','self','t')`),
    );
    const { rows } = await pool.query(`SELECT id FROM clinrec.chunks ORDER BY embedding <=> $1::halfvec LIMIT 1`, [
      toVectorLiteral(vec(7)),
    ]);
    assert.equal(rows[0].id, 'k1');
  });
});
