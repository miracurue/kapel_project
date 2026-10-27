'use strict';

/**
 * Журнал агента для администратора (трассировка, миграция 0033; src/ai/agentTrace.js):
 *   GET /admin/api/agent/runs                — список ответов агента (?page, from, to, status, user_id)
 *   GET /admin/api/agent/runs/:id            — один ответ со всеми шагами
 *   GET /admin/api/agent/runs/:id/download   — то же файлом JSON
 *   GET /admin/api/agent/download?from&to    — все ответы за период файлом JSON (не более 500)
 * Только администратор. Пациент — служебным номером (PD-20). Тексты есть только у запусков демо-режима
 * (texts_stored = 1). Просмотр одного ответа и каждое скачивание пишутся в журнал действий без содержимого.
 */

const PAGE_SIZE = 50;
const EXPORT_MAX = 500;
const STATUSES = ['running', 'ok', 'fallback', 'filtered', 'error', 'timeout', 'limit'];
const MAX_PERIOD_MS = 366 * 86400000;

const RUN_COLS = `r.id, r.created_at, r.finished_at, r.role, r.purpose, r.prompt_key, r.thread_id, r.message_id, r.model_ident,
  r.status, r.steps, r.tool_calls, r.tokens_in, r.tokens_out, r.duration_ms, r.stop_reason, r.texts_stored,
  u.full_name AS user_name, p.service_no AS patient_no`;
const RUN_FROM = 'ai_agent_runs r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN users p ON p.id = r.patient_id';

function install(app, { db, P }) {
  const admin = (req, res) => {
    if (!req.user) {
      P.sendError(req, res, 401, 'E-SESSION-EXPIRED');
      return false;
    }
    if (req.user.role !== 'admin') {
      P.sendError(req, res, 403, 'E-ACCESS');
      return false;
    }
    return true;
  };
  const day = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null);
  const logAction = (req, action, targetId) => {
    try {
      db.prepare('INSERT INTO action_log(actor_id,actor_role,action,target_type,target_id) VALUES (?,?,?,?,?)').run(
        req.user.id,
        req.user.role,
        action,
        'agent_run',
        targetId === null || targetId === undefined ? null : String(targetId),
      );
    } catch {
      /* журнал не ломает чтение */
    }
  };

  /** Условия списка из запроса; null — ошибка проверки. */
  function filters(query) {
    const where = [];
    const args = [];
    const from = day(query.from);
    const to = day(query.to);
    if ((query.from && !from) || (query.to && !to)) return null;
    if (from && to && new Date(to) - new Date(from) > MAX_PERIOD_MS) return null;
    if (from) {
      where.push('r.created_at >= ?');
      args.push(`${from}T00:00:00Z`);
    }
    if (to) {
      where.push('r.created_at <= ?');
      args.push(`${to}T23:59:59.999Z`);
    }
    if (query.status) {
      if (!STATUSES.includes(String(query.status))) return null;
      where.push('r.status = ?');
      args.push(String(query.status));
    }
    if (query.user_id !== undefined && query.user_id !== '') {
      const id = Number(query.user_id);
      if (!Number.isInteger(id) || id < 1) return null;
      where.push('r.user_id = ?');
      args.push(id);
    }
    return { clause: where.length ? ` WHERE ${where.join(' AND ')}` : '', args };
  }

  const stepsOf = (runId) =>
    db
      .prepare(
        `SELECT n, kind, model_ident, name, args_json, result_text, result_chars, reason_text, tokens_in, tokens_out,
           context_tokens, duration_ms, status, created_at FROM ai_agent_steps WHERE run_id = ? ORDER BY n`,
      )
      .all(runId)
      .map((s) => {
        let args = null;
        try {
          args = s.args_json ? JSON.parse(s.args_json) : null;
        } catch {
          args = null;
        }
        const { args_json: _omit, ...rest } = s;
        return { ...rest, args };
      });

  function fullRun(id) {
    const run = db
      .prepare(
        `SELECT ${RUN_COLS}, r.question_text, r.answer_text, r.prompt_layers_json FROM ${RUN_FROM} WHERE r.id = ?`,
      )
      .get(id);
    if (!run) return null;
    let layers = null;
    try {
      layers = run.prompt_layers_json ? JSON.parse(run.prompt_layers_json) : null;
    } catch {
      layers = null;
    }
    const { prompt_layers_json: _omit, ...rest } = run;
    return { ...rest, prompt_layers: layers, steps_list: stepsOf(id) };
  }

  const sendJsonFile = (res, name, body) => {
    res.set({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    });
    return res.send(JSON.stringify(body, null, 2));
  };

  app.get('/admin/api/agent/runs', (req, res) => {
    if (!admin(req, res)) return undefined;
    const f = filters(req.query);
    if (!f) return P.sendError(req, res, 422, 'E-VALIDATION');
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ${RUN_FROM}${f.clause}`).get(...f.args).n;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const items = db
      .prepare(`SELECT ${RUN_COLS} FROM ${RUN_FROM}${f.clause} ORDER BY r.id DESC LIMIT ? OFFSET ?`)
      .all(...f.args, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    return res.json({ items, page, page_size: PAGE_SIZE, total });
  });

  app.get('/admin/api/agent/runs/:id(\\d+)', (req, res) => {
    if (!admin(req, res)) return undefined;
    const run = fullRun(Number(req.params.id));
    if (!run) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    logAction(req, 'agent.trace.view', run.id);
    return res.json(run);
  });

  app.get('/admin/api/agent/runs/:id(\\d+)/download', (req, res) => {
    if (!admin(req, res)) return undefined;
    const run = fullRun(Number(req.params.id));
    if (!run) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    logAction(req, 'agent.trace.export', run.id);
    return sendJsonFile(res, `agent_run_${run.id}.json`, { schema: 'agent-trace/1', runs: [run] });
  });

  app.get('/admin/api/agent/download', (req, res) => {
    if (!admin(req, res)) return undefined;
    const f = filters(req.query);
    if (!f) return P.sendError(req, res, 422, 'E-VALIDATION');
    const ids = db
      .prepare(`SELECT r.id FROM ${RUN_FROM}${f.clause} ORDER BY r.id DESC LIMIT ?`)
      .all(...f.args, EXPORT_MAX)
      .map((r) => r.id);
    logAction(req, 'agent.trace.export', null);
    return sendJsonFile(res, 'agent_runs.json', {
      schema: 'agent-trace/1',
      filters: { from: req.query.from || null, to: req.query.to || null, status: req.query.status || null },
      limit: EXPORT_MAX,
      runs: ids.map(fullRun).filter(Boolean),
    });
  });
}

module.exports = { install, PAGE_SIZE, EXPORT_MAX };
