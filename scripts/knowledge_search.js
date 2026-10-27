#!/usr/bin/env node
'use strict';

// Ручная проверка поиска по Postgres-хранилищу знаний. Выводит JSON.
//   KNOWLEDGE_DATABASE_URL=... node scripts/knowledge_search.js <tool> --query 'сон' [--mode hybrid]
// Инструменты: drugs | toc | section | text | adverse | clinrec | clinrec-section | status
// Для semantic/hybrid нужны GIGACHAT_AUTH_KEY / ACCESS_TOKEN (node --env-file=.env); без них
// semantic вернёт available:false, hybrid откатится к lexical.
const { createPool, close } = require('../src/modules/knowledge/pg');
const { createKnowledgeTools } = require('../src/modules/knowledge/tools');

function parse(argv) {
  const [tool, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (['semantic', 'no-candidates'].includes(key)) opts[key] = true;
    else opts[key] = rest[++i];
  }
  return { tool, opts };
}
const list = (v) =>
  v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
const num = (v) => (v === undefined ? undefined : Number(v));

const MAP = {
  drugs: 'searchDrugs',
  toc: 'getToc',
  section: 'readSection',
  text: 'searchText',
  adverse: 'searchAdverseEffects',
  clinrec: 'searchClinrec',
  'clinrec-section': 'getClinrecSection',
  status: 'status',
};

async function main() {
  const { tool, opts } = parse(process.argv.slice(2));
  if (!MAP[tool] || opts.help) {
    console.error(
      'usage: knowledge_search.js <drugs|toc|section|text|adverse|clinrec|clinrec-section|status> [--query T] [--mode lexical|semantic|hybrid]\n' +
        '  [--limit N --offset N] [--document-id ID --section-id ID --parent-id ID --cursor N --max-chars N]\n' +
        '  [--drug-ids A,B] [--kinds main,method] [--document-ids A,B] [--context С] [--semantic] [--no-candidates]\n' +
        '  scope (server-side): [--scope-inn МНН] [--scope-documents A,B] [--scope-clinrec A,B]',
    );
    process.exit(2);
  }
  const scope = {};
  if (opts['scope-inn']) scope.innNorm = opts['scope-inn'];
  if (opts['scope-documents']) scope.documentIds = list(opts['scope-documents']);
  if (opts['scope-clinrec']) scope.clinrecDocumentIds = list(opts['scope-clinrec']);
  let embeddingClient;
  if (process.env.GIGACHAT_AUTH_KEY || process.env.GIGACHAT_ACCESS_TOKEN) {
    const { createEmbeddingClient } = require('../src/modules/medication_knowledge/embeddings');
    embeddingClient = createEmbeddingClient();
  }
  const pool = createPool();
  try {
    const tools = createKnowledgeTools({ pool, embeddingClient, scope });
    const args = {
      publicReferenceTerm: opts.query,
      mode: opts.mode,
      limit: num(opts.limit),
      offset: num(opts.offset),
      documentId: opts['document-id'],
      sectionId: opts['section-id'],
      parentId: opts['parent-id'],
      cursor: num(opts.cursor),
      maxChars: num(opts['max-chars']),
      drugIds: list(opts['drug-ids']),
      kinds: list(opts.kinds),
      documentIds: list(opts['document-ids']),
      context: opts.context,
      semantic: opts.semantic,
      includeCandidates: opts['no-candidates'] ? false : undefined,
    };
    const wanted = tools.definitions.find((d) => d.name === MAP[tool]).inputSchema.properties;
    for (const k of Object.keys(args)) if (args[k] === undefined || !(k in wanted)) delete args[k];
    console.log(JSON.stringify(await tools.dispatch(MAP[tool], args), null, 2));
  } finally {
    await close(pool);
  }
}

main().catch((error) => {
  console.error(error.code ? `${error.code}: ${error.message}` : error.message);
  process.exit(1);
});
