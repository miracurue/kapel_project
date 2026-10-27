'use strict';

// Импорт базы лекарств SQLite -> Postgres (схема med). Автономный: создаёт временную БД на
// сервере KNOWLEDGE_TEST_DATABASE_URL (имя cc_medimp_*), синтетический SQLite-источник и
// удаляет всё по завершении. Чужие БД и схемы не затрагиваются. Без переменной — skip.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createPool, close } = require('../../src/modules/knowledge/pg');
const { migrate } = require('../../src/modules/knowledge/migrate');
const { importMed, verifyMed, normalizeInn } = require('../../src/modules/knowledge/med_import');

const url = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const skip = url ? false : 'KNOWLEDGE_TEST_DATABASE_URL не задан: нужен Postgres с pgvector (deploy/compose.dev.yml)';
const DIM = 2560;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function vecBlob(seed) {
  let s = seed >>> 0;
  const buf = Buffer.alloc(DIM * 4);
  let sq = 0;
  for (let i = 0; i < DIM; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const v = s / 4294967296 - 0.5;
    buf.writeFloatLE(v, i * 4);
    sq += buf.readFloatLE(i * 4) ** 2;
  }
  return { buf, norm: Math.sqrt(sq) };
}

function buildSource(file) {
  const db = new Database(file);
  const migrations = path.resolve(__dirname, '../../src/modules/medication_knowledge/migrations');
  for (const f of fs.readdirSync(migrations).sort()) db.exec(fs.readFileSync(path.join(migrations, f), 'utf8'));
  const g = 'g1';
  db.prepare("INSERT INTO knowledge_meta VALUES ('active_generation', ?)").run(g);
  db.prepare("INSERT INTO generations VALUES (?, 'fp', '2026-01-01', 'reg', '{}', 'ready')").run(g);
  const md = '# Инструкция\nТекст раздела про ЁЖ.\n## Побочные\nТошнота, головная боль.\n';
  const docs = [
    ['D01', 'Амитриптилин', 'Озон'],
    ['D02', 'Ёлочный  Препарат', 'Тест'],
  ];
  for (const [id, inn, label] of docs) {
    db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?)').run(g, id, inn, label, `${id}.md`, sha(md), md, '{}');
    const cut = md.indexOf('## ');
    db.prepare('INSERT INTO sections VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
      g,
      `${id}:s1`,
      id,
      null,
      1,
      'Инструкция',
      0,
      md.length,
      1,
      5,
      '1',
      '1',
    );
    db.prepare('INSERT INTO sections VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
      g,
      `${id}:s2`,
      id,
      `${id}:s1`,
      2,
      'Побочные',
      cut,
      md.length,
      3,
      5,
      '1',
      '1',
    );
    const parts = [md.slice(0, cut), md.slice(cut)];
    let off = 0;
    parts.forEach((text, i) => {
      db.prepare('INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        g,
        `${id}:c${i}`,
        id,
        i ? `${id}:s2` : `${id}:s1`,
        JSON.stringify([`${id}:s1`]),
        i,
        off,
        off + text.length,
        text,
        sha(text),
        0,
        1,
        5,
        '1',
        '1',
      );
      off += text.length;
    });
  }
  db.prepare('INSERT INTO blocks VALUES (?,?,?,?)').run(g, 'B1', 'D01', '{"x":1}');
  db.prepare('INSERT INTO source_mentions VALUES (?,?,?,?)').run(g, 'S1', 'D01', '{"x":2}');
  for (const [id, name] of [
    ['AE1', 'тошнота'],
    ['AE2', 'головная боль'],
  ]) {
    const raw = { id, name, category: 'К', aliases: [name, `${name} 2`], status: 'review-required' };
    db.prepare('INSERT INTO effects VALUES (?,?,?,?,?,?)').run(
      g,
      id,
      name,
      'К',
      'review-required',
      JSON.stringify(raw),
    );
    for (const a of raw.aliases) db.prepare('INSERT INTO effect_aliases VALUES (?,?,?,?)').run(g, id, a, a);
  }
  db.prepare('INSERT INTO effect_links VALUES (?,?,?,?,?,?,?,?,?)').run(
    g,
    'R1',
    'AE1',
    'D01',
    'B1',
    'часто',
    'приём',
    'тошнота',
    '{"k":1}',
  );
  db.prepare('INSERT INTO embedding_namespaces VALUES (?,?,?,?,?)').run(g, 'EmbeddingsGigaR', DIM, 'ready', 0);
  let seed = 1;
  const put = (type, id, hash) => {
    const { buf, norm } = vecBlob(seed++);
    db.prepare('INSERT INTO embeddings VALUES (?,?,?,?,?,?,?,?)').run(
      g,
      type,
      id,
      'EmbeddingsGigaR',
      DIM,
      hash,
      buf,
      norm,
    );
  };
  for (const c of db.prepare('SELECT id, content_hash FROM chunks').all()) put('chunk', c.id, c.content_hash);
  put('effect', 'AE1', sha('тошнота\nтошнота\nтошнота 2'));
  put('effect', 'AE2', 'stale-hash'); // устаревший: не должен переехать
  db.close();
}

test('knowledge med import', { skip }, async (t) => {
  const admin = createPool({ connectionString: url, max: 1 });
  const dbName = `cc_medimp_${process.pid}_${Date.now()}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medimp-'));
  const sqlite = path.join(dir, 'src.sqlite3');
  let pool;
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
  } catch (error) {
    await close(admin);
    t.skip(`нельзя создать временную БД: ${error.code}`);
    return;
  }
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  pool = createPool({ connectionString: u.toString() });
  t.after(async () => {
    await close(pool).catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await close(admin).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });
  buildSource(sqlite);
  await migrate(pool);

  await t.test('нормализация МНН', () => {
    assert.equal(normalizeInn('  Ёлочный   ПРЕПАРАТ '), 'елочный препарат');
  });

  let report;
  await t.test('импорт: счётчики, устаревший вектор, drug_map', async () => {
    report = await importMed(pool, { sqlitePath: sqlite });
    assert.deepEqual(report.counts, {
      documents: 2,
      sections: 4,
      chunks: 4,
      effects: 2,
      effect_aliases: 4,
      effect_links: 1,
      blocks: 1,
      source_mentions: 1,
      vectors: 5,
    });
    assert.deepEqual(
      report.stale_vectors.map((s) => s.id),
      ['AE2'],
    );
    const { rows } = await pool.query('SELECT inn_name_norm, document_id FROM med.drug_map ORDER BY document_id');
    assert.deepEqual(rows, [
      { inn_name_norm: 'амитриптилин', document_id: 'D01' },
      { inn_name_norm: 'елочный препарат', document_id: 'D02' },
    ]);
    const { rows: tsv } = await pool.query(
      "SELECT count(*)::int n FROM med.chunks WHERE tsv @@ plainto_tsquery('russian','тошнота')",
    );
    assert.equal(tsv[0].n, 2);
  });

  await t.test('verify проходит на корректных данных', async () => {
    const v = await verifyMed(pool, {
      sqlitePath: sqlite,
      expected: {
        documents: 2,
        sections: 4,
        chunks: 4,
        effects: 2,
        effect_aliases: 4,
        effect_links: 1,
        blocks: 1,
        source_mentions: 1,
        vectors: 5,
      },
      sample: 5,
    });
    // Устаревший вектор AE2 не перенесён: расхождение числа векторов с источником ожидаемо.
    const failed = v.checks
      .filter((c) => !c.ok)
      .map((c) => c.name)
      .sort();
    assert.deepEqual(failed, ['counts_match_sqlite', 'embedding_model_hash_match_source']);
    assert.ok(v.checks.find((c) => c.name === 'markdown_bytes_equal').ok);
    assert.ok(v.checks.find((c) => c.name === 'chunk_slices_equal').ok);
    assert.ok(v.checks.find((c) => c.name === 'vector_cosine_sample').ok);
    assert.ok(v.checks.find((c) => c.name === 'hnsw_in_plan_seqscan_off').ok);
  });

  await t.test('повторный импорт идемпотентен', async () => {
    const before = (await pool.query('SELECT count(*)::int n FROM med.chunks')).rows[0].n;
    const again = await importMed(pool, { sqlitePath: sqlite });
    assert.deepEqual(again.counts, report.counts);
    assert.equal((await pool.query('SELECT count(*)::int n FROM med.chunks')).rows[0].n, before);
    assert.equal((await pool.query('SELECT count(*)::int n FROM med.drug_map')).rows[0].n, 2);
  });

  await t.test('verify ловит порчу markdown', async () => {
    await pool.query("UPDATE med.documents SET markdown = markdown || 'x' WHERE id = 'D01'");
    const v = await verifyMed(pool, { sqlitePath: sqlite, expected: {}, sample: 2 });
    assert.equal(v.checks.find((c) => c.name === 'markdown_bytes_equal').ok, false);
    assert.equal(v.ok, false);
  });

  await t.test('сбой посреди замены откатывает всё', async () => {
    await importMed(pool, { sqlitePath: sqlite });
    const db = new Database(sqlite);
    db.exec("PRAGMA foreign_keys=OFF; UPDATE effect_links SET block_id='NOPE'");
    db.close();
    await assert.rejects(importMed(pool, { sqlitePath: sqlite }));
    assert.equal((await pool.query('SELECT count(*)::int n FROM med.documents')).rows[0].n, 2);
    assert.equal((await pool.query('SELECT count(*)::int n FROM med.effect_links')).rows[0].n, 1);
  });
});
