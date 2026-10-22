'use strict';
const { createHash } = require('node:crypto');
const { activeGeneration } = require('./store');
const { MODELS } = require('./embeddings');

function failure(code) {
  const error = new Error(`medication knowledge: ${code}`);
  error.code = code;
  return error;
}
function entities(db, generation = activeGeneration(db)) {
  return [
    ...db
      .prepare('SELECT id,content,content_hash FROM chunks WHERE generation=? ORDER BY id')
      .all(generation)
      .map((r) => ({ type: 'chunk', id: r.id, text: r.content, hash: r.content_hash })),
    ...db
      .prepare('SELECT id,name,raw_json FROM effects WHERE generation=? ORDER BY id')
      .all(generation)
      .map((r) => {
        const text = [r.name, ...JSON.parse(r.raw_json).aliases].join('\n');
        return { type: 'effect', id: r.id, text, hash: createHash('sha256').update(text).digest('hex') };
      }),
  ];
}
function encodeVector(vector, dimensions) {
  if ((!Array.isArray(vector) && !(vector instanceof Float32Array)) || vector.length !== dimensions)
    throw failure('invalid_dimensions');
  const blob = Buffer.alloc(dimensions * 4);
  let squared = 0;
  vector.forEach((value, i) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw failure('invalid_vector');
    blob.writeFloatLE(value, i * 4);
    const float = blob.readFloatLE(i * 4);
    if (!Number.isFinite(float)) throw failure('invalid_vector');
    squared += float * float;
  });
  const norm = Math.sqrt(squared);
  if (!Number.isFinite(norm) || norm <= 0) throw failure('invalid_vector');
  return { blob, norm };
}
function validRow(row, entity, dimensions) {
  if (!row || row.dimensions !== dimensions || row.content_hash !== entity.hash || row.vector.length !== dimensions * 4)
    return false;
  try {
    const values = Array.from({ length: dimensions }, (_, i) => row.vector.readFloatLE(i * 4));
    const { norm } = encodeVector(values, dimensions);
    return Math.abs(norm - row.norm) <= Math.max(1, norm) * 1e-6;
  } catch {
    return false;
  }
}
function namespaceStatus(db, model, generation = activeGeneration(db)) {
  const expected = entities(db, generation);
  const namespaces = model
    ? db.prepare('SELECT * FROM embedding_namespaces WHERE generation=? AND model=?').all(generation, model)
    : db.prepare('SELECT * FROM embedding_namespaces WHERE generation=? ORDER BY model').all(generation);
  return namespaces.map((ns) => {
    const rows = db.prepare('SELECT * FROM embeddings WHERE generation=? AND model=?').all(generation, ns.model);
    const map = new Map(rows.map((r) => [`${r.entity_type}:${r.entity_id}`, r]));
    const valid = expected.filter((e) => validRow(map.get(`${e.type}:${e.id}`), e, ns.dimensions)).length;
    return {
      ...ns,
      expected_count: expected.length,
      valid_count: valid,
      last_error: JSON.parse(
        db.prepare('SELECT value FROM knowledge_meta WHERE key=?').get(`embedding_error:${generation}:${ns.model}`)
          ?.value || 'null',
      ),
      ready:
        ns.status === 'ready' && expected.length > 0 && valid === expected.length && rows.length === expected.length,
    };
  });
}
async function indexEmbeddings(
  db,
  {
    client,
    model = client?.model,
    dimensions = client?.dimensions || MODELS[model]?.dimensions,
    batchSize = 8,
    onProgress = () => {},
  } = {},
) {
  if (
    !client ||
    typeof client.embed !== 'function' ||
    typeof model !== 'string' ||
    !model ||
    !Number.isInteger(dimensions) ||
    dimensions < 1 ||
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 16
  )
    throw failure('invalid_index_config');
  const generation = activeGeneration(db);
  if (!generation) throw failure('corpus_unavailable');
  const expected = entities(db, generation);
  const old = db
    .prepare('SELECT dimensions FROM embedding_namespaces WHERE generation=? AND model=?')
    .get(generation, model);
  if (old && old.dimensions !== dimensions) throw failure('namespace_dimensions_mismatch');
  db.transaction(() => {
    db.prepare('DELETE FROM knowledge_meta WHERE key=?').run(`embedding_error:${generation}:${model}`);
    db.prepare(
      "INSERT INTO embedding_namespaces(generation,model,dimensions,status) VALUES (?,?,?,'building') ON CONFLICT(generation,model) DO UPDATE SET status='building'",
    ).run(generation, model, dimensions);
  }).immediate();
  const get = db.prepare('SELECT * FROM embeddings WHERE generation=? AND entity_type=? AND entity_id=? AND model=?');
  const pending = expected.filter((e) => !validRow(get.get(generation, e.type, e.id, model), e, dimensions));
  let indexed = expected.length - pending.length;
  const put = db.prepare(
    'INSERT INTO embeddings(generation,entity_type,entity_id,model,dimensions,content_hash,vector,norm) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(generation,entity_type,entity_id,model) DO UPDATE SET dimensions=excluded.dimensions,content_hash=excluded.content_hash,vector=excluded.vector,norm=excluded.norm',
  );
  try {
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      if (activeGeneration(db) !== generation) throw failure('generation_changed');
      const batch = pending.slice(offset, offset + batchSize);
      const response = await client.embed(batch.map((e) => e.text));
      if (
        !response ||
        response.model !== model ||
        !Array.isArray(response.vectors) ||
        response.vectors.length !== batch.length
      )
        throw failure('invalid_embedding_response');
      const encoded = response.vectors.map((v) => encodeVector(v, dimensions));
      if (activeGeneration(db) !== generation) throw failure('generation_changed');
      db.transaction(() => {
        batch.forEach((e, i) =>
          put.run(generation, e.type, e.id, model, dimensions, e.hash, encoded[i].blob, encoded[i].norm),
        );
        indexed += batch.length;
        db.prepare('UPDATE embedding_namespaces SET indexed_count=? WHERE generation=? AND model=?').run(
          indexed,
          generation,
          model,
        );
      }).immediate();
      onProgress({ indexed, total: expected.length, model });
    }
    db.prepare("UPDATE embedding_namespaces SET status='ready',indexed_count=? WHERE generation=? AND model=?").run(
      indexed,
      generation,
      model,
    );
    const status = namespaceStatus(db, model, generation)[0];
    if (!status.ready) throw failure('index_incomplete');
    return { ...status, embedded: pending.length, resumed: expected.length - pending.length };
  } catch (error) {
    db.prepare("UPDATE embedding_namespaces SET status='partial',indexed_count=? WHERE generation=? AND model=?").run(
      indexed,
      generation,
      model,
    );
    const code = /^[a-z_]+$/.test(error.code || '') ? error.code : 'index_failed';
    const detail = {
      code,
      at: new Date().toISOString(),
      ...(Number.isInteger(error.status) ? { status: error.status } : {}),
      ...(['oauth', 'tokens', 'embeddings'].includes(error.phase) ? { phase: error.phase } : {}),
      ...(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(error.networkCode)
        ? { networkCode: error.networkCode }
        : {}),
    };
    db.prepare(
      'INSERT INTO knowledge_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(`embedding_error:${generation}:${model}`, JSON.stringify(detail));
    const safe = failure(code);
    if (Number.isInteger(error.status)) safe.status = error.status;
    if (detail.phase) safe.phase = detail.phase;
    if (detail.networkCode) safe.networkCode = detail.networkCode;
    throw safe;
  }
}
module.exports = { indexEmbeddings, namespaceStatus, entities, encodeVector, failure };
