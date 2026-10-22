'use strict';
const search = require('./search');
const { failure } = require('./index_embeddings');

const pagination = {
  limit: { type: 'integer', minimum: 1, maximum: 500 },
  offset: { type: 'integer', minimum: 0, maximum: 1000000 },
};
const publicTerm = {
  publicReferenceTerm: {
    type: 'string',
    minLength: 1,
    maxLength: 1000,
    description:
      'Public medication/reference terms only. Never include a patient, conversation, record, or identifying information. Semantic search sends this term to GigaChat.',
  },
};
const drugIds = { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 200 } };
function definition(name, description, properties, required = []) {
  return { name, description, inputSchema: { type: 'object', additionalProperties: false, properties, required } };
}
const toolDefinitions = Object.freeze([
  definition(
    'searchDrugs',
    'Find separate manufacturer instructions by trade name, INN, or a typo.',
    { ...publicTerm, ...pagination },
    ['publicReferenceTerm'],
  ),
  definition(
    'getToc',
    'Get all ordered instruction headings and parent IDs.',
    { documentId: { type: 'string', minLength: 1, maxLength: 200 } },
    ['documentId'],
  ),
  definition(
    'readSection',
    'Read the exact section including descendants; follow nextCursor while hasMore.',
    {
      documentId: { type: 'string', minLength: 1, maxLength: 200 },
      sectionId: { type: 'string', minLength: 1, maxLength: 200 },
      cursor: { type: 'integer', minimum: 0, maximum: 1000000 },
      maxChars: { type: 'integer', minimum: 1, maximum: 1000000 },
    },
    ['documentId', 'sectionId'],
  ),
  definition(
    'searchText',
    'Find cited instruction chunks. Semantic/hybrid explicitly sends publicReferenceTerm externally; incomplete index is reported.',
    {
      ...publicTerm,
      ...pagination,
      drugIds,
      mode: { type: 'string', enum: ['lexical', 'semantic', 'hybrid'] },
    },
    ['publicReferenceTerm'],
  ),
  definition(
    'searchAdverseEffects',
    'Return confirmed terms/curated aliases separately from similarity candidates, with every source and qualifier. Absence in corpus is not clinical absence.',
    {
      ...publicTerm,
      ...pagination,
      drugIds,
      context: { type: 'string', maxLength: 200 },
      includeCandidates: { type: 'boolean' },
      semantic: { type: 'boolean' },
    },
    ['publicReferenceTerm'],
  ),
  definition('status', 'Report source staleness, record counts and complete/incomplete vector namespaces.', {}),
]);
function validate(value, schema) {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('invalid_tool_arguments');
    if (
      Object.keys(value).some((key) => !Object.hasOwn(schema.properties, key)) ||
      schema.required.some((key) => !Object.hasOwn(value, key))
    )
      throw failure('invalid_tool_arguments');
    for (const [key, v] of Object.entries(value)) validate(v, schema.properties[key]);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > schema.maxItems) throw failure('invalid_tool_arguments');
    value.forEach((item) => validate(item, schema.items));
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum)
      throw failure('invalid_tool_arguments');
  } else if (
    typeof value !== schema.type ||
    (schema.minLength !== undefined && value.length < schema.minLength) ||
    (schema.maxLength !== undefined && value.length > schema.maxLength) ||
    (schema.enum && !schema.enum.includes(value))
  )
    throw failure('invalid_tool_arguments');
}
function createKnowledgeTools(db, { embeddingClient, sourceDir } = {}) {
  async function dispatch(name, args = {}) {
    const definition = toolDefinitions.find((d) => d.name === name);
    if (!definition) throw failure('unknown_tool');
    validate(args, definition.inputSchema);
    if (name === 'status') return search.status(db, sourceDir ? { sourceDir } : undefined);
    const options = { ...args, query: args.publicReferenceTerm, client: embeddingClient };
    delete options.publicReferenceTerm;
    return search[name](db, options);
  }
  return {
    definitions: toolDefinitions,
    dispatch,
    ...Object.fromEntries(toolDefinitions.map((d) => [d.name, (args) => dispatch(d.name, args)])),
  };
}
module.exports = { toolDefinitions, createKnowledgeTools };
