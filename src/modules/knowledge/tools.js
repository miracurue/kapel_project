'use strict';

// Инструменты агента над Postgres-хранилищем знаний. Имена и аргументы лекарственных
// инструментов повторяют SQLite-версию (medication_knowledge/tools.js); добавлены
// searchClinrec и getClinrecSection. Область поиска (scope) задаёт СЕРВЕР при создании:
// в схемах инструментов для модели её нет, а переданное моделью (drugIds, documentIds)
// может только сузить область.
const med = require('./search_med');
const clinrec = require('./search_clinrec');
const { failure } = require('./rrf');

const DEFAULT_MAX_RESPONSE_CHARS = 60000;
const MAX_SECTION_CHARS = 40000;

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
const id200 = { type: 'string', minLength: 1, maxLength: 200 };
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
  definition('getToc', 'Get all ordered instruction headings and parent IDs.', { documentId: id200 }, ['documentId']),
  definition(
    'readSection',
    'Read the exact section including descendants; follow nextCursor while hasMore.',
    {
      documentId: id200,
      sectionId: id200,
      cursor: { type: 'integer', minimum: 0, maximum: 1000000 },
      maxChars: { type: 'integer', minimum: 1, maximum: 1000000 },
    },
    ['documentId', 'sectionId'],
  ),
  definition(
    'searchText',
    'Find cited instruction chunks. Semantic/hybrid explicitly sends publicReferenceTerm externally; incomplete index is reported.',
    { ...publicTerm, ...pagination, drugIds, mode: { type: 'string', enum: ['lexical', 'semantic', 'hybrid'] } },
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
  definition('status', 'Report record counts and which embedding models cover the stored vectors.', {}),
  definition(
    'searchClinrec',
    'Find passages of clinical recommendations (parent-child: a matched fragment is returned with its parent or neighbouring chunks, with document, heading path and span). Semantic/hybrid explicitly sends publicReferenceTerm externally.',
    {
      ...publicTerm,
      ...pagination,
      mode: { type: 'string', enum: ['lexical', 'semantic', 'hybrid'] },
      kinds: { type: 'array', maxItems: 5, items: { type: 'string', enum: clinrec.KINDS } },
      documentIds: { type: 'array', maxItems: 100, items: id200 },
    },
    ['publicReferenceTerm'],
  ),
  definition(
    'getClinrecSection',
    'Read a clinical recommendation section with subsections (sectionId) or one parent fragment (parentId) page by page; follow nextCursor while hasMore.',
    {
      documentId: id200,
      sectionId: id200,
      parentId: id200,
      cursor: { type: 'integer', minimum: 0, maximum: 1000000 },
      maxChars: { type: 'integer', minimum: 1, maximum: 1000000 },
    },
    ['documentId'],
  ),
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

// Все массивы results (в т.ч. confirmed.results / candidates.results) сокращаются с конца,
// пока ответ не уложится в лимит; отдельные тексты не усекаются.
function fitResponse(result, maxChars) {
  const size = () => JSON.stringify(result).length;
  if (size() <= maxChars) return result;
  const lists = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.results)) lists.push(node);
    for (const key of ['confirmed', 'candidates']) if (node[key]) walk(node[key]);
  };
  walk(result);
  let truncated = false;
  while (size() > maxChars) {
    const target = lists
      .filter((l) => l.results.length > 1)
      .sort((a, b) => JSON.stringify(b.results).length - JSON.stringify(a.results).length)[0];
    if (!target) break;
    target.results.pop();
    target.hasMore = true;
    target.returned = target.results.length;
    truncated = true;
  }
  if (truncated) result.truncated = true;
  result.response_limit_chars = maxChars;
  return result;
}

function createKnowledgeTools({
  pool,
  embeddingClient,
  scope = {},
  maxResponseChars = DEFAULT_MAX_RESPONSE_CHARS,
} = {}) {
  if (!pool || typeof pool.query !== 'function') throw failure('pool_required');
  const frozenScope = Object.freeze({
    ...(scope.documentIds ? { documentIds: [...scope.documentIds] } : {}),
    ...(scope.innNorm !== undefined ? { innNorm: scope.innNorm } : {}),
    ...(scope.clinrecDocumentIds ? { clinrecDocumentIds: [...scope.clinrecDocumentIds] } : {}),
  });
  const medScope = { documentIds: frozenScope.documentIds, innNorm: frozenScope.innNorm };
  if (medScope.documentIds === undefined) delete medScope.documentIds;
  if (medScope.innNorm === undefined) delete medScope.innNorm;
  const clinrecScope = { documentIds: frozenScope.clinrecDocumentIds };
  if (!clinrecScope.documentIds) delete clinrecScope.documentIds;

  async function run(name, args) {
    const { publicReferenceTerm, ...rest } = args;
    const common = { ...rest, query: publicReferenceTerm, client: embeddingClient };
    switch (name) {
      case 'searchDrugs':
      case 'searchText':
      case 'searchAdverseEffects':
        return { ...(await med[name](pool, { ...common, scope: medScope })), source: 'medication_instructions' };
      case 'getToc':
        return { ...(await med.getToc(pool, { ...rest, scope: medScope })), source: 'medication_instructions' };
      case 'readSection': {
        const maxChars = Math.min(rest.maxChars ?? 12000, MAX_SECTION_CHARS);
        return {
          ...(await med.readSection(pool, { ...rest, maxChars, scope: medScope })),
          source: 'medication_instructions',
        };
      }
      case 'status':
        return { ...(await med.status(pool)), scope_restricted: Object.keys(frozenScope).length > 0 };
      case 'searchClinrec':
        return clinrec.searchClinrec(pool, publicReferenceTerm, {
          ...rest,
          client: embeddingClient,
          scope: clinrecScope,
        });
      case 'getClinrecSection': {
        const maxChars = Math.min(rest.maxChars ?? 12000, MAX_SECTION_CHARS);
        return clinrec.getClinrecSection(pool, { ...rest, maxChars, scope: clinrecScope });
      }
      default:
        throw failure('unknown_tool');
    }
  }
  async function dispatch(name, args = {}) {
    const def = toolDefinitions.find((d) => d.name === name);
    if (!def) throw failure('unknown_tool');
    validate(args, def.inputSchema);
    return fitResponse(await run(name, args), maxResponseChars);
  }
  return {
    definitions: toolDefinitions,
    dispatch,
    scope: frozenScope,
    ...Object.fromEntries(toolDefinitions.map((d) => [d.name, (args) => dispatch(d.name, args)])),
  };
}

module.exports = { toolDefinitions, createKnowledgeTools, DEFAULT_MAX_RESPONSE_CHARS };
