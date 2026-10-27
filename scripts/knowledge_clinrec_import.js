#!/usr/bin/env node
'use strict';

// Клинреки -> Postgres (схема clinrec). Команды: import | embed | status | verify.
//   knowledge/clinrecs/tools/build_all.sh   # сначала собрать чанки из knowledge/clinrecs/source
//   node scripts/knowledge_clinrec_import.js import [--doc id]... [--force]   # из knowledge/clinrecs (v2)
//   (прежний формат: --legacy-dir docs/clinrecs/rag)
//   NODE_EXTRA_CA_CERTS=deploy/certs/russian_trusted_root_ca.pem \
//     node --env-file=.env scripts/knowledge_clinrec_import.js embed [--doc id] [--limit n]
//   node scripts/knowledge_clinrec_import.js status
//   node --env-file=.env scripts/knowledge_clinrec_import.js verify [--no-queries]
// Адрес БД: KNOWLEDGE_DATABASE_URL. Ключ GigaChat читается из окружения и нигде не печатается.
const path = require('node:path');
const { createPool, close, toVectorLiteral } = require('../src/modules/knowledge/pg');
const { loadClinrecCorpus, summarizeClinrecCorpus } = require('../src/modules/knowledge/clinrec_corpus');
const { loadClinrecV2 } = require('../src/modules/knowledge/clinrec_v2');
const { importClinrec } = require('../src/modules/knowledge/clinrec_import');
const { embedClinrec, embedStatus, DIMENSIONS } = require('../src/modules/knowledge/embed_pg');

const CONTROL_QUERIES = ['маниакальный эпизод лечение', 'психообразование при БАР'];

function parseArgs(argv) {
  const o = { cmd: argv[0], legacyDir: null, docs: [], force: false, limit: null, queries: true, json: false };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--legacy-dir') o.legacyDir = path.resolve(argv[++i]);
    else if (a === '--doc') o.docs.push(argv[++i]);
    else if (a === '--force') o.force = true;
    else if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a === '--no-queries') o.queries = false;
    else if (a === '--json') o.json = true;
    else throw new Error(`неизвестный аргумент ${a}`);
  }
  return o;
}
const loadCorpus = (o) => (o.legacyDir ? loadClinrecCorpus(o.legacyDir) : loadClinrecV2());
const err = (s) => process.stderr.write(`${s}\n`);
const out = (o) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);

function makeClient() {
  const { createEmbeddingClient, diagnosticConfiguration } = require('../src/modules/medication_knowledge/embeddings');
  if (!diagnosticConfiguration().configured)
    throw new Error('GIGACHAT_AUTH_KEY не задан (запускайте с --env-file=.env)');
  return createEmbeddingClient({ batchSize: 8, maxRetries: 3, timeoutMs: 60000 });
}

async function cmdImport(pool, o) {
  const corpus = loadCorpus(o);
  err(
    `корпус: ${corpus.documents.length} документов, ${corpus.chunks.length} чанков, ошибок ${corpus.errors.length}, предупреждений ${corpus.warnings.length}`,
  );
  const report = await importClinrec(pool, corpus, {
    documents: o.docs,
    force: o.force,
    onDocument: (r) =>
      err(
        `  ${r.id}: ${r.status}, чанков ${r.counts.chunks}, к векторизации ${r.counts.embeddable}, векторов сохранено ${r.vectors_kept}`,
      ),
  });
  out(report);
}

async function cmdEmbed(pool, o) {
  const client = makeClient();
  let last = 0;
  const report = await embedClinrec(pool, {
    client,
    documentId: o.docs[0] || null,
    limit: o.limit,
    onProgress: (p) => {
      if (p.done - last >= 40 || p.done === p.of) {
        last = p.done;
        err(
          `embed: ${p.done}/${p.of} текстов, векторов записано ${p.embedded}, пропущено ${p.skipped}, повторов ${p.retries}`,
        );
      }
    },
  });
  out(report);
  if (report.skipped.length) process.exitCode = 3; // есть решения за человеком
}

async function cmdStatus(pool, o) {
  out(await embedStatus(pool, o.docs[0] || null));
}

async function cmdVerify(pool, o) {
  const checks = [];
  const check = (name, ok, detail) =>
    checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  const corpus = loadCorpus(o);
  const summary = summarizeClinrecCorpus(corpus);
  const { rows: per } = await pool.query(
    `SELECT d.id,
            (SELECT count(*)::int FROM clinrec.sections WHERE document_id = d.id) AS sections,
            (SELECT count(*)::int FROM clinrec.parents WHERE document_id = d.id) AS parents,
            (SELECT count(*)::int FROM clinrec.chunks WHERE document_id = d.id) AS chunks,
            (SELECT count(*)::int FROM clinrec.chunks WHERE document_id = d.id AND embed) AS embeddable,
            (SELECT count(*)::int FROM clinrec."references" WHERE document_id = d.id) AS refs
       FROM clinrec.documents d ORDER BY d.id`,
  );
  const byId = new Map(per.map((r) => [r.id, r]));
  const bad = [];
  for (const [id, s] of Object.entries(summary.by_document)) {
    const r = byId.get(id);
    if (
      !r ||
      r.sections !== s.sections ||
      r.parents !== s.parents ||
      r.chunks !== s.chunks ||
      r.embeddable !== s.embeddable ||
      r.refs !== s.references
    )
      bad.push(id);
  }
  check(
    'счётчики по документам равны корпусу (разделы, родители, чанки, к векторизации, литература)',
    !bad.length,
    bad.length
      ? { расходятся: bad }
      : {
          документов_корпуса: summary.documents,
          посторонних_в_БД: per.filter((r) => !summary.by_document[r.id]).map((r) => r.id),
        },
  );
  const st = await embedStatus(pool);
  st.documents = st.documents.filter((r) => summary.by_document[r.document_id]);
  st.total.embeddable = st.documents.reduce((a, r) => a + r.embeddable, 0);
  check('к векторизации ровно как в корпусе', st.total.embeddable === summary.totals.embeddable, {
    в_БД: st.total.embeddable,
    в_корпусе: summary.totals.embeddable,
  });
  const { rows: v } = await pool.query(
    `SELECT count(*) FILTER (WHERE embedding IS NOT NULL)::int AS vectors,
            count(DISTINCT vector_dims(embedding)) AS dim_variants, min(vector_dims(embedding)) AS dim_min, max(vector_dims(embedding)) AS dim_max,
            count(*) FILTER (WHERE embed AND embedding IS NULL AND embed_skip_reason IS NULL)::int AS null_without_reason,
            count(*) FILTER (WHERE embed AND embed_skip_reason IS NOT NULL)::int AS skipped,
            count(*) FILTER (WHERE embedding IS NOT NULL AND embedding_hash IS DISTINCT FROM embed_text_hash)::int AS stale,
            count(*) FILTER (WHERE NOT embed AND embedding IS NOT NULL)::int AS vector_on_non_embed,
            count(DISTINCT embedding_model) FILTER (WHERE embedding IS NOT NULL) AS models
       FROM clinrec.chunks WHERE document_id = ANY($1::text[])`,
    [Object.keys(summary.by_document)],
  );
  const x = v[0];
  check(
    'все векторы размерности 2560',
    x.vectors > 0 && Number(x.dim_variants) === 1 && x.dim_min === DIMENSIONS && x.dim_max === DIMENSIONS,
    { векторов: x.vectors, dim: [x.dim_min, x.dim_max] },
  );
  check('нет чанков к векторизации без вектора и без причины', x.null_without_reason === 0, {
    без_вектора_без_причины: x.null_without_reason,
  });
  check('векторов + пропущенных = к векторизации', x.vectors + x.skipped === summary.totals.embeddable, {
    векторов: x.vectors,
    пропущено: x.skipped,
    к_векторизации: summary.totals.embeddable,
  });
  check('вектор соответствует актуальному embed_text (нет устаревших)', x.stale === 0 && x.vector_on_non_embed === 0, {
    устаревших: x.stale,
    вектор_у_не_embed: x.vector_on_non_embed,
  });
  const { rows: skippedRows } = await pool.query(
    'SELECT id, embed_skip_reason AS reason, length(embed_text) AS chars FROM clinrec.chunks WHERE embed_skip_reason IS NOT NULL ORDER BY id',
  );

  // План: ближайшие соседи. На ~2k строк планировщик может выбрать seq scan, поэтому показываем и естественный план, и с enable_seqscan=off.
  const client = await pool.connect();
  let plan;
  try {
    await client.query('BEGIN');
    const probe = (
      await client.query('SELECT embedding::text AS e FROM clinrec.chunks WHERE embedding IS NOT NULL LIMIT 1')
    ).rows[0];
    const q = 'SELECT id FROM clinrec.chunks ORDER BY embedding <=> $1::halfvec LIMIT 5';
    const explain = async () =>
      (await client.query(`EXPLAIN ${q}`, [probe && probe.e])).rows.map((r) =>
        String(r['QUERY PLAN'])
          .replace(/\[[-0-9.,e]{50,}\]/g, '[vector]')
          .slice(0, 160),
      );
    const natural = probe ? await explain() : [];
    await client.query('SET LOCAL enable_seqscan = off');
    const forced = probe ? await explain() : [];
    await client.query('ROLLBACK');
    plan = { natural, forced_no_seqscan: forced };
  } finally {
    client.release();
  }
  check(
    'EXPLAIN ближайших соседей использует HNSW (индекс chunks_embedding)',
    plan.forced_no_seqscan.some((l) => /chunks_embedding/.test(l)),
    plan,
  );

  let queries = null;
  if (o.queries) {
    try {
      const client2 = makeClient();
      const { vectors } = await client2.embed(CONTROL_QUERIES);
      queries = [];
      for (let i = 0; i < CONTROL_QUERIES.length; i += 1) {
        const lit = toVectorLiteral(vectors[i]);
        const top = (
          await pool.query(
            `SELECT id, heading_path, round((embedding <=> $1::halfvec)::numeric, 4) AS dist
             FROM clinrec.chunks WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::halfvec LIMIT 5`,
            [lit],
          )
        ).rows;
        const topBar = (
          await pool.query(
            `SELECT id, heading_path, round((embedding <=> $1::halfvec)::numeric, 4) AS dist
             FROM clinrec.chunks WHERE embedding IS NOT NULL AND document_id = 'bar_2025' ORDER BY embedding <=> $1::halfvec LIMIT 5`,
            [lit],
          )
        ).rows;
        queries.push({ query: CONTROL_QUERIES[i], top5_all: top, top5_bar_2025: topBar });
      }
    } catch (e) {
      queries = {
        error: `${e.code || e.name}${e.status ? ` HTTP ${e.status}` : ''}${e.networkCode ? ` ${e.networkCode}` : ''}`,
      };
    }
  }
  const ok = checks.every((c) => c.ok);
  out({ ok, checks, skipped: skippedRows, per_document: per, queries });
  if (!ok) process.exitCode = 1;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const commands = { import: cmdImport, embed: cmdEmbed, status: cmdStatus, verify: cmdVerify };
  if (!commands[o.cmd]) {
    err('команды: import | embed | status | verify');
    process.exit(2);
  }
  const pool = createPool({ statement_timeout: 600000 });
  try {
    await commands[o.cmd](pool, o);
  } finally {
    await close(pool);
  }
}

main().catch((e) => {
  // Ключи и тела ответов не печатаются: клиент отдаёт только коды.
  err(
    `ошибка: ${e.code ? `${e.code} — ` : ''}${e.message}${e.status ? ` (HTTP ${e.status})` : ''}${e.networkCode ? ` ${e.networkCode}` : ''}`,
  );
  process.exit(1);
});
