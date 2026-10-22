#!/usr/bin/env node
'use strict';
const { openKnowledgeStore, importCorpus } = require('../src/modules/medication_knowledge/store');
const { createKnowledgeTools } = require('../src/modules/medication_knowledge/tools');
const { indexEmbeddings, failure } = require('../src/modules/medication_knowledge/index_embeddings');
const { createEmbeddingClient } = require('../src/modules/medication_knowledge/embeddings');

const HELP = {
  commands: ['import', 'status', 'drugs', 'toc', 'section', 'search', 'adverse', 'embed', 'help'],
  options: [
    '--db FILE',
    '--source-dir DIR',
    '--query PUBLIC_REFERENCE_TERM',
    '--document-id ID',
    '--section-id ID',
    '--cursor N',
    '--max-chars N',
    '--limit N',
    '--offset N',
    '--drug-ids ID,ID',
    '--context TEXT',
    '--mode lexical|semantic|hybrid',
    '--semantic',
    '--no-candidates',
    '--model MODEL',
    '--batch-size N',
    '--rebuild',
  ],
  environment:
    'Only embed/semantic/hybrid use external GigaChat. Load credentials explicitly at startup with node --env-file=.env. Public reference terms only; never patient data.',
};
function parse(argv) {
  const first = argv.shift() || 'help';
  const command = ['--help', '-h'].includes(first) ? 'help' : first;
  const flags = new Set(['semantic', 'no-candidates', 'rebuild']);
  const known = new Set([
    'db',
    'source-dir',
    'query',
    'document-id',
    'section-id',
    'cursor',
    'max-chars',
    'limit',
    'offset',
    'drug-ids',
    'context',
    'mode',
    'model',
    'batch-size',
    ...flags,
  ]);
  const options = {};
  while (argv.length) {
    const key = argv.shift();
    if (!key.startsWith('--') || !known.has(key.slice(2)) || Object.hasOwn(options, key.slice(2)))
      throw failure('invalid_cli_arguments');
    const name = key.slice(2);
    if (flags.has(name)) options[name] = true;
    else {
      const value = argv.shift();
      if (value === undefined || value.startsWith('--')) throw failure('invalid_cli_arguments');
      options[name] = value;
    }
  }
  return { command, options };
}
async function main(argv = process.argv.slice(2)) {
  const { command, options: o } = parse([...argv]);
  if (command === 'help') return HELP;
  if (!HELP.commands.includes(command)) throw failure('unknown_command');
  const db = openKnowledgeStore(o.db ? { filename: o.db } : undefined);
  try {
    if (command === 'import') return importCorpus(db, { sourceDir: o['source-dir'], rebuild: o.rebuild });
    const external =
      command === 'embed' ||
      (command === 'search' && ['semantic', 'hybrid'].includes(o.mode)) ||
      (command === 'adverse' && o.semantic);
    const client = external ? createEmbeddingClient(o.model ? { model: o.model } : undefined) : undefined;
    if (command === 'embed')
      return await indexEmbeddings(db, {
        client,
        batchSize: o['batch-size'] === undefined ? 8 : Number(o['batch-size']),
        onProgress: (p) =>
          process.stderr.write(JSON.stringify({ indexed: p.indexed, total: p.total, model: p.model }) + '\n'),
      });
    const args = {};
    const mapping = {
      query: 'publicReferenceTerm',
      'document-id': 'documentId',
      'section-id': 'sectionId',
      context: 'context',
      mode: 'mode',
    };
    for (const [key, target] of Object.entries(mapping)) if (o[key] !== undefined) args[target] = o[key];
    for (const [key, target] of Object.entries({
      cursor: 'cursor',
      'max-chars': 'maxChars',
      limit: 'limit',
      offset: 'offset',
    }))
      if (o[key] !== undefined) args[target] = Number(o[key]);
    if (o['drug-ids'] !== undefined) args.drugIds = o['drug-ids'].split(',');
    if (o.semantic) args.semantic = true;
    if (o['no-candidates']) args.includeCandidates = false;
    const names = {
      drugs: 'searchDrugs',
      toc: 'getToc',
      section: 'readSection',
      search: 'searchText',
      adverse: 'searchAdverseEffects',
      status: 'status',
    };
    return await createKnowledgeTools(db, { embeddingClient: client, sourceDir: o['source-dir'] }).dispatch(
      names[command],
      args,
    );
  } finally {
    db.close();
  }
}
if (require.main === module)
  main()
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error) => {
      const code = /^[a-z_]+$/.test(error.code || '') ? error.code : 'operation_failed';
      process.stderr.write(
        JSON.stringify({
          error: code,
          ...(Number.isInteger(error.status) ? { status: error.status } : {}),
          ...(['oauth', 'tokens', 'embeddings'].includes(error.phase) ? { phase: error.phase } : {}),
          ...(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(error.networkCode)
            ? { networkCode: error.networkCode }
            : {}),
        }) + '\n',
      );
      process.exitCode = 1;
    });
module.exports = { main };
