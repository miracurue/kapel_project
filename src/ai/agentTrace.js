'use strict';

/**
 * Трассировка ИИ-агента (миграция 0034): запуск = один ответ, шаги = вызовы модели, инструментов и навыков.
 *
 * Тексты (вопрос, ответ, аргументы, результаты инструментов, пояснение модели «зачем») пишутся только при
 * DATA_MODE != 'real' — решение владельца 2026-10-25; в них уже метки #ТИП-N# вместо ПДн (псевдонимизация до шлюза).
 * В боевом режиме остаются имена инструментов, числа и статусы. Срок хранения — RETENTION_DAYS, стирает
 * задача планировщика (src/jobs/aiRetention.js). Любой сбой записи трассировки не ломает ответ модели.
 */

const RETENTION_DAYS = 30;
const RESULT_MAX = 4000;
const TEXT_MAX = 12000;
const ARGS_MAX = 2000;

const ERROR_MAX = 300;
const RESUME_WINDOW_MS = 6 * 3600000; // прерванный ответ можно продолжить в течение шести часов
const RESUME_MAX_CALLS = 4;
const STALE_RUNNING_MS = 2 * 60000; // запуск в статусе «идёт» дольше двух минут считается оборванным (сервер перезапущен)

const clip = (s, max) => {
  const t = String(s == null ? '' : s);
  return t.length <= max ? t : `${t.slice(0, max)}…`;
};

function argsJson(args) {
  try {
    const raw = JSON.stringify(args && typeof args === 'object' ? args : {});
    return raw.length <= ARGS_MAX ? raw : JSON.stringify({ _clipped: raw.slice(0, ARGS_MAX) });
  } catch {
    return '{}';
  }
}

/** Без БД или при сбое — пустой трассировщик с тем же интерфейсом. */
const NOOP = Object.freeze({ id: null, step() {}, finish() {} });

/** Причина сбоя вызова модели: код адаптера, имя и сообщение ошибки, код причины сети. Тело ответа провайдера не пишется. */
function describeError(e) {
  if (!e) return null;
  const parts = [e.adapterCode, e.name !== 'Error' ? e.name : null, e.message, e.cause && (e.cause.code || e.cause.message)];
  return clip(parts.filter(Boolean).join(': '), ERROR_MAX);
}

function createAgentTrace({ db, config, nowIso }) {
  const withTexts = config.dataMode !== 'real';
  const now = () => (nowIso ? nowIso() : new Date().toISOString());

  function start({
    user,
    purpose,
    promptKey,
    threadId = null,
    patientId = null,
    modelIdent = null,
    layers = null,
    question = '',
  }) {
    try {
      const created = now();
      const expires = new Date(Date.parse(created) + RETENTION_DAYS * 86400000).toISOString();
      const info = db
        .prepare(
          `INSERT INTO ai_agent_runs(user_id, role, purpose, prompt_key, thread_id, patient_id, model_ident, prompt_layers_json,
             question_text, texts_stored, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          user.id,
          user.role,
          purpose,
          promptKey,
          threadId,
          patientId,
          modelIdent,
          layers && layers.length ? JSON.stringify(layers) : null,
          withTexts ? clip(question, TEXT_MAX) : null,
          withTexts ? 1 : 0,
          created,
          expires,
        );
      return run(Number(info.lastInsertRowid), threadId);
    } catch {
      return NOOP;
    }
  }

  function run(id, threadId = null) {
    let n = 0;
    let steps = 0;
    let toolCalls = 0;
    const tokens = { in: 0, out: 0 };
    const insert = db.prepare(
      `INSERT INTO ai_agent_steps(run_id, n, kind, model_ident, name, args_json, result_text, result_chars, reason_text,
         tokens_in, tokens_out, context_tokens, duration_ms, status, error_text, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertCall = db.prepare(
      'INSERT INTO ai_agent_calls(run_id, thread_id, n, tool, args_json, created_at) VALUES (?,?,?,?,?,?)',
    );
    return {
      id,
      /**
       * @param {{kind:'model'|'tool'|'skill'|'note', model?:string, name?:string, args?:object, result?:string,
       *   reason?:string, tokensIn?:number, tokensOut?:number, contextTokens?:number, durationMs?:number, status?:string,
       *   error?:string}} s
       */
      step(s) {
        try {
          n += 1;
          if (s.kind === 'model') steps += 1;
          if (s.kind === 'tool' || s.kind === 'skill') toolCalls += 1;
          tokens.in += s.tokensIn || 0;
          tokens.out += s.tokensOut || 0;
          const result = s.result == null ? null : String(s.result);
          insert.run(
            id,
            n,
            s.kind,
            s.model || null,
            s.name || null,
            s.args && withTexts ? argsJson(s.args) : null,
            result !== null && withTexts ? clip(result, RESULT_MAX) : null,
            result !== null ? result.length : null,
            s.reason && withTexts ? clip(s.reason, 500) : null,
            s.tokensIn ?? null,
            s.tokensOut ?? null,
            s.contextTokens ?? null,
            s.durationMs ?? null,
            s.status || 'ok',
            s.error ? clip(s.error, ERROR_MAX) : null,
            now(),
          );
          // Какие инструменты уже вызваны (без результатов): по ним прерванный ответ продолжается в этом же треде.
          if (s.kind === 'tool' && s.name && s.status !== 'repeat') {
            insertCall.run(id, threadId, n, s.name, argsJson(s.args), now());
          }
        } catch {
          /* трассировка не ломает ответ */
        }
      },
      finish({ status, answer = '', durationMs = null, stopReason = null, modelIdent = null, messageId = null }) {
        try {
          db.prepare(
            `UPDATE ai_agent_runs SET status=?, steps=?, tool_calls=?, tokens_in=?, tokens_out=?, duration_ms=?, stop_reason=?,
               answer_text=?, model_ident=COALESCE(?, model_ident), message_id=COALESCE(?, message_id), finished_at=? WHERE id=?`,
          ).run(
            status,
            steps,
            toolCalls,
            tokens.in,
            tokens.out,
            durationMs,
            stopReason,
            withTexts && answer ? clip(answer, TEXT_MAX) : null,
            modelIdent,
            messageId,
            now(),
            id,
          );
        } catch {
          /* трассировка не ломает ответ */
        }
      },
    };
  }

  /**
   * Вызовы инструментов последнего запуска треда, если он оборвался (сбой модели, перезапуск сервера) и ответа нет.
   * Повторяются по порядку без дублей, не более RESUME_MAX_CALLS. Пусто — продолжать нечего.
   * @returns {{runId:number, calls:{tool:string,args:object}[]}|null}
   */
  function interruptedCalls(threadId, excludeRunId = null) {
    if (!threadId) return null;
    try {
      const last = db
        .prepare('SELECT id, status, created_at FROM ai_agent_runs WHERE thread_id = ? AND id != ? ORDER BY id DESC LIMIT 1')
        .get(threadId, excludeRunId || 0);
      if (!last) return null;
      const age = Date.parse(now()) - Date.parse(last.created_at);
      const dead = last.status === 'error' || last.status === 'timeout' || (last.status === 'running' && age > STALE_RUNNING_MS);
      if (!dead || age > RESUME_WINDOW_MS) return null;
      const seen = new Set();
      const calls = [];
      for (const r of db.prepare('SELECT tool, args_json FROM ai_agent_calls WHERE run_id = ? ORDER BY n').all(last.id)) {
        const key = `${r.tool}:${r.args_json}`;
        if (seen.has(key)) continue;
        seen.add(key);
        calls.push({ tool: r.tool, args: JSON.parse(r.args_json) });
        if (calls.length >= RESUME_MAX_CALLS) break;
      }
      return calls.length ? { runId: last.id, calls } : null;
    } catch {
      return null;
    }
  }

  /** Привязать запуск к сохранённому сообщению ответа (после записи в ai_messages). */
  function attachMessage(runId, messageId) {
    if (!runId || !messageId) return;
    try {
      db.prepare('UPDATE ai_agent_runs SET message_id=? WHERE id=?').run(messageId, runId);
    } catch {
      /* не критично */
    }
  }

  return { start, attachMessage, interruptedCalls, withTexts };
}

/** Стирание запусков с истёкшим сроком (шаги — каскадом). Пакет до 500 строк. */
function purgeExpiredRuns(db, nowIsoValue) {
  try {
    const info = db
      .prepare('DELETE FROM ai_agent_runs WHERE id IN (SELECT id FROM ai_agent_runs WHERE expires_at <= ? LIMIT 500)')
      .run(nowIsoValue);
    return { agent_runs: info.changes };
  } catch {
    return { agent_runs: 0 };
  }
}

module.exports = { createAgentTrace, purgeExpiredRuns, describeError, RETENTION_DAYS, NOOP };
