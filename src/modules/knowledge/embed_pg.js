'use strict';

// Возобновляемая векторизация чанков клинреков (clinrec.chunks, embed = true) в halfvec(2560).
// Клиент — createEmbeddingClient из medication_knowledge/embeddings.js: он сам проверяет длину через
// /tokens/count ДО /embeddings, повторяет 429/5xx и проверяет размерность ответа. Здесь:
//  - пакет сохраняется в PG сразу после ответа (сбой не теряет сделанное, повторный запуск продолжает);
//  - слишком длинный чанк (input_token_limit) НЕ усекается: пакет делится, чанк помечается embed_skip_reason;
//  - временные сбои повторяются с задержкой; остальные ошибки прерывают прогон (состояние сохранено).
const { toVectorLiteral } = require('./pg');

const DIMENSIONS = 2560;
const TRANSIENT_HTTP = (s) => s === 429 || (s >= 500 && s < 600);

function isTransient(error) {
  if (!error) return false;
  if (error.code === 'timeout' || error.code === 'transport') return true;
  return error.code === 'http' && TRANSIENT_HTTP(error.status);
}

function describe(error) {
  return `${error.code || 'error'}${error.status ? ` HTTP ${error.status}` : ''}${error.networkCode ? ` ${error.networkCode}` : ''}${error.phase ? ` [${error.phase}]` : ''}`;
}

async function pendingRows(pool, { documentId, limit } = {}) {
  const { rows } = await pool.query(
    `SELECT id, document_id, embed_text, embed_text_hash FROM clinrec.chunks
      WHERE embed AND embed_skip_reason IS NULL
        AND (embedding IS NULL OR embedding_hash IS DISTINCT FROM embed_text_hash)
        AND ($1::text IS NULL OR document_id = $1)
      ORDER BY document_id, id ${limit ? 'LIMIT ' + Number(limit) : ''}`,
    [documentId || null],
  );
  return rows;
}

/**
 * @param {import('pg').Pool} pool
 * @param {{client: {model: string, embed: Function}, batchSize?: number, documentId?: string, limit?: number,
 *          retries?: number, sleep?: Function, onProgress?: Function, dimensions?: number}} options
 */
async function embedClinrec(pool, options = {}) {
  const {
    client,
    batchSize = 8,
    documentId = null,
    limit = null,
    retries = 5,
    dimensions = DIMENSIONS,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    onProgress = () => {},
  } = options;
  if (!client || typeof client.embed !== 'function' || !client.model)
    throw new Error('embed_pg: нужен embedding-клиент с model');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 16) throw new Error('embed_pg: batchSize 1..16');
  const started = Date.now();
  const totalEmbeddable = Number(
    (
      await pool.query(
        'SELECT count(*) AS n FROM clinrec.chunks WHERE embed AND ($1::text IS NULL OR document_id = $1)',
        [documentId],
      )
    ).rows[0].n,
  );
  const totalPending = (await pendingRows(pool, { documentId })).length;
  const skippedBefore = Number(
    (
      await pool.query(
        'SELECT count(*) AS n FROM clinrec.chunks WHERE embed AND embed_skip_reason IS NOT NULL AND ($1::text IS NULL OR document_id = $1)',
        [documentId],
      )
    ).rows[0].n,
  );
  const rows = limit ? await pendingRows(pool, { documentId, limit }) : await pendingRows(pool, { documentId });
  // Одинаковый embed_text -> один вектор на все строки (одна ячейка расчёта на хеш).
  const byHash = new Map();
  for (const r of rows) {
    const g = byHash.get(r.embed_text_hash);
    if (g) g.ids.push(r.id);
    else byHash.set(r.embed_text_hash, { hash: r.embed_text_hash, text: r.embed_text, ids: [r.id] });
  }
  const units = [...byHash.values()];
  const report = {
    model: client.model,
    total_embeddable: totalEmbeddable,
    resumed: totalEmbeddable - totalPending - skippedBefore,
    skipped_before: skippedBefore,
    pending: rows.length,
    embedded: 0,
    skipped: [],
    batches: 0,
    retries: 0,
    unique_texts: units.length,
    ms: 0,
  };

  async function save(unit, vector) {
    if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) throw new Error('embed_pg: вектор не массив');
    if (vector.length !== dimensions) {
      const e = new Error(`embed_pg: размерность ${vector.length}, ожидалось ${dimensions}`);
      e.code = 'invalid_dimensions';
      throw e;
    }
    const res = await pool.query(
      `UPDATE clinrec.chunks SET embedding = $1::halfvec, embedding_model = $2, embedding_hash = embed_text_hash,
              embed_skip_reason = NULL
        WHERE id = ANY($3::text[]) AND embed AND embed_text_hash = $4`,
      [toVectorLiteral(vector), client.model, unit.ids, unit.hash],
    );
    report.embedded += res.rowCount;
  }
  async function call(texts) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const out = await client.embed(texts);
        if (!out || out.model !== client.model || !Array.isArray(out.vectors) || out.vectors.length !== texts.length) {
          const e = new Error('embed_pg: неверный ответ клиента');
          e.code = 'invalid_embedding_response';
          throw e;
        }
        return out.vectors;
      } catch (error) {
        if (!isTransient(error) || attempt >= retries) throw error;
        report.retries += 1;
        const delay = Math.min(60000, 1000 * 2 ** attempt);
        process.stderr.write(
          `embed: временный сбой (${describe(error)}), повтор ${attempt + 1}/${retries} через ${delay} мс\n`,
        );
        await sleep(delay);
      }
    }
  }
  async function skip(unit, reason) {
    await pool.query(
      `UPDATE clinrec.chunks SET embed_skip_reason = $1 WHERE id = ANY($2::text[]) AND embed AND embed_text_hash = $3`,
      [reason, unit.ids, unit.hash],
    );
    for (const id of unit.ids) report.skipped.push({ id, reason, chars: unit.text.length });
  }
  async function handle(batch) {
    try {
      const vectors = await call(batch.map((u) => u.text));
      for (let i = 0; i < batch.length; i += 1) await save(batch[i], vectors[i]);
    } catch (error) {
      if (error.code !== 'input_token_limit') throw error;
      if (batch.length === 1) {
        await skip(batch[0], 'input_token_limit');
        process.stderr.write(
          `embed: ${batch[0].ids[0]} пропущен — превышен лимит токенов модели (текст не усекается)\n`,
        );
        return;
      }
      for (const u of batch) await handle([u]); // делим: годные сохраняются, длинный получает причину
    }
  }

  for (let i = 0; i < units.length; i += batchSize) {
    const batch = units.slice(i, i + batchSize);
    await handle(batch);
    report.batches += 1;
    onProgress({
      done: Math.min(i + batch.length, units.length),
      of: units.length,
      embedded: report.embedded,
      skipped: report.skipped.length,
      retries: report.retries,
    });
  }
  report.ms = Date.now() - started;
  return report;
}

async function embedStatus(pool, documentId = null) {
  const { rows } = await pool.query(
    `SELECT document_id,
            count(*) FILTER (WHERE embed)::int AS embeddable,
            count(*) FILTER (WHERE embed AND embedding IS NOT NULL AND embedding_hash = embed_text_hash)::int AS embedded,
            count(*) FILTER (WHERE embed AND embed_skip_reason IS NOT NULL)::int AS skipped,
            count(*) FILTER (WHERE embed AND embed_skip_reason IS NULL
                             AND (embedding IS NULL OR embedding_hash IS DISTINCT FROM embed_text_hash))::int AS pending
       FROM clinrec.chunks WHERE ($1::text IS NULL OR document_id = $1) GROUP BY document_id ORDER BY document_id`,
    [documentId],
  );
  const total = rows.reduce(
    (a, r) => ({
      embeddable: a.embeddable + r.embeddable,
      embedded: a.embedded + r.embedded,
      skipped: a.skipped + r.skipped,
      pending: a.pending + r.pending,
    }),
    { embeddable: 0, embedded: 0, skipped: 0, pending: 0 },
  );
  return { documents: rows, total };
}

module.exports = { embedClinrec, embedStatus, pendingRows, DIMENSIONS };
