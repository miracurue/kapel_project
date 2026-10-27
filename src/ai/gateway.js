'use strict';

/**
 * Единый шлюз ИИ (F-26). Порядок шагов строго фиксирован:
 *  (1) кризисная проверка уже пройдена вызывающим (crisisGate — до шлюза);
 *  (2) привязка назначения (кеш 30 с) и режим данных: модель synthetic_only при DATA_MODE=real
 *      не вызывается — вторая проверка после записи привязки (L-03, PD-01);
 *  (3) лимиты F-23/S-14 (частота по назначению и месячный бюджет токенов);
 *  (4) псевдонимизация F-80 выполнена до шлюза (src/ai/pii) — модель видит только ключи #ТИП-N#;
 *  (5) промпт = системная инструкция из слоёв активных версий (роль пользователя, общие правила инструментов,
 *      список навыков, задача — src/ai/promptCatalog.js) + текст пользователя отдельным сообщением
 *      («данные, не инструкции»); у навыка слой роли не подмешивается;
 *  (6) вызов модели с таймаутом назначения (S-15); при ошибке или таймауте — ОДИН вызов запасной модели;
 *  (7) проверка ответа: пустой — E-AI-EMPTY; пост-фильтр (outputFilter) заменяет опасный совет
 *      безопасным текстом; длина ограничена (4000 пациент / 12000 специалист);
 *  (8)-(9) ответ сохраняет вызывающий: с ключами, с ai_generated=1, моделью и версиями;
 *  (10) журнал ai_audit без текстов и значений (PD-17): назначение, модель, версии, статус,
 *      длительность, токены, число замен по типам ключей, признак «только правила».
 */

const outputFilter = require('./outputFilter');
const texts = require('./texts');
const catalog = require('./promptCatalog');
const skillSchemas = require('./skills');
const { createAgentTrace, describeError } = require('./agentTrace');
const ctxBudget = require('./contextBudget');
const guardMarks = require('./guardMarks');
const crypto = require('node:crypto');

const DEFAULT_TIMEOUTS = {
  patient_assistant: 30,
  clinician_chat: 60,
  document_draft: 90,
  diagnostic_hints: 90,
  ae_extraction: 15,
  order_parse: 10,
  admin_assistant: 30,
};
const DEFAULT_LIMITS = {
  // Код-запас до В5 (config/defaults), утверждённое значение 20/10мин задаёт администратор через S-14;
  // в тестах файл 07 задаёт >29 вопросов от одного пациента до T-111.
  patient_per_10min: 60,
  patient_per_day: 200,
  clinician_per_hour: 60,
  hints_per_day: 20,
  admin_per_hour: 60,
  budget_tokens: 0,
  warn_percent: 80,
};
const MAX_LEN = { patient_assistant: 4000, default: 12000 };
// Общий бюджет времени цикла инструментов: после него модель отвечает по уже собранному (без новых вызовов).
const AGENT_BUDGET_MS = 120000;
// Последний шаг цикла: инструментов нет, но модель может всё равно запросить вызов и вернуть пустой текст.
const FINAL_TEXT =
  'Инструменты больше недоступны. Ответь сейчас текстом по уже полученному, ссылаясь только на номера [n], которые есть в результатах; собственные знания помечай [0]. Не рассказывай, что искал и что нашёл. Не вызывай функции.';
// Вызов модели в схеме «план и исполнение» (план, проверка полноты) короче вызова ответа: при сбое схема откатывается.
const PLAN_CALL_TIMEOUT_S = 30;
const REPEAT_TEXT =
  'Этот инструмент с теми же аргументами уже вызывался, его результат есть выше. Ответь по нему или выбери другой инструмент.';

class GatewayError extends Error {
  constructor(status, code, details) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details || null;
  }
}

/** Счётчики частоты — в памяти процесса (демо-ограничение, STAND-IN: для real — общее хранилище). */
function createLimits({ settings }) {
  const hits = new Map(); // `${purpose}:${userId}` -> { version, times: [] }
  function limitFor(purpose) {
    const cfg = { ...DEFAULT_LIMITS, ...(settings('ai.limits').value || {}) };
    if (purpose === 'patient_assistant')
      return { windowMs: 10 * 60 * 1000, max: cfg.patient_per_10min, dayMax: cfg.patient_per_day };
    if (purpose === 'clinician_chat') return { windowMs: 60 * 60 * 1000, max: cfg.clinician_per_hour };
    if (purpose === 'diagnostic_hints') return { windowMs: 24 * 60 * 60 * 1000, max: cfg.hints_per_day };
    if (purpose === 'admin_assistant') return { windowMs: 60 * 60 * 1000, max: cfg.admin_per_hour };
    return null;
  }
  function check(purpose, userId) {
    const rule = limitFor(purpose);
    if (!rule) return;
    const { version } = settings('ai.limits');
    const key = `${purpose}:${userId}`;
    const nowMs = Date.now();
    let entry = hits.get(key);
    // Новое значение настройки действует сразу: счётчики прежней версии обнуляются.
    if (!entry || entry.version !== version) {
      entry = { version, times: [] };
      hits.set(key, entry);
    }
    entry.times = entry.times.filter((t) => nowMs - t < Math.max(rule.windowMs, 24 * 60 * 60 * 1000));
    if (rule.max && entry.times.length >= rule.max) throw new GatewayError(429, 'E-AI-LIMIT');
    if (rule.dayMax && entry.times.filter((t) => nowMs - t < 24 * 60 * 60 * 1000).length >= rule.dayMax) {
      throw new GatewayError(429, 'E-AI-LIMIT');
    }
  }
  function record(purpose, userId) {
    const { version } = settings('ai.limits');
    const key = `${purpose}:${userId}`;
    const entry = hits.get(key) || { version, times: [] };
    if (entry.version !== version) entry.times = [];
    entry.version = version;
    entry.times.push(Date.now());
    hits.set(key, entry);
  }
  return { check, record };
}

function createGateway({ db, config, now, registry, pii, settings }) {
  const limits = createLimits({ settings });
  const tracer = createAgentTrace({ db, config, nowIso: () => now(config).toISOString() });

  function monthKey(d) {
    return d.toISOString().slice(0, 7);
  }

  function audit(row) {
    // ТЕКСТОВ И ЗНАЧЕНИЙ В ЖУРНАЛЕ НЕТ (PD-17): только метаданные и числа.
    db.prepare(
      'INSERT INTO ai_audit(user_id, role, purpose, thread_id, patient_id, model_id, binding_version, prompt_version, data_mode, status, crisis, duration_ms, tokens_in, tokens_out, files, pii_counts_json, pii_mode, prompt_layers_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      row.userId,
      row.role,
      row.purpose,
      row.threadId || null,
      row.patientId || null,
      row.modelId || null,
      row.bindingVersion || null,
      row.promptVersion || null,
      config.dataMode,
      row.status,
      row.crisis ? 1 : 0,
      row.durationMs || null,
      row.tokensIn || null,
      row.tokensOut || null,
      row.files || 0,
      row.piiCounts && Object.keys(row.piiCounts).length ? JSON.stringify(row.piiCounts) : null,
      row.piiMode || null,
      row.layers && row.layers.length ? JSON.stringify(row.layers) : null,
    );
  }

  function recordUsage({ purpose, userId, tokens }) {
    const month = monthKey(now(config));
    const bump = db.prepare(
      'INSERT INTO ai_usage(month, purpose, user_id, requests, tokens) VALUES (?,?,?,1,?) ON CONFLICT(month, purpose, user_id) DO UPDATE SET requests = requests + 1, tokens = tokens + excluded.tokens',
    );
    db.transaction(() => {
      bump.run(month, purpose, userId, tokens);
      bump.run(month, purpose, 0, tokens); // итог по организации (бюджет S-14)
    })();
  }

  function checkDataMode(model) {
    if (config.dataMode === 'real' && model && model.data_class === 'synthetic_only') {
      throw new GatewayError(503, 'E-MODEL-MODE', { model: model.model_ident });
    }
  }

  function budgetCheck() {
    const cfg = { ...DEFAULT_LIMITS, ...(settings('ai.limits').value || {}) };
    if (!cfg.budget_tokens) return;
    const month = monthKey(now(config));
    const row = db.prepare('SELECT sum(tokens) s FROM ai_usage WHERE month = ?').get(month);
    if ((row && row.s ? row.s : 0) >= cfg.budget_tokens) throw new GatewayError(429, 'E-AI-LIMIT', { budget: true });
  }

  function callModel(model, payload, timeoutS, meta) {
    const adapters = require('./adapters');
    const adapter = adapters.get(model.adapter);
    if (!adapter) throw new GatewayError(503, 'E-AI-UNAVAILABLE', { adapter: model.adapter });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutS) * 1000);
    return adapter.call({ model, payload, signal: controller.signal, meta }).finally(() => clearTimeout(timer));
  }

  function parseArgs(raw) {
    if (raw && typeof raw === 'object') return raw;
    try {
      return JSON.parse(String(raw || '{}')) || {};
    } catch (_) {
      return {};
    }
  }

  /**
   * Цикл вызова инструментов (tool use) для одной модели: модель просит данные -> tools.execute -> результат
   * возвращается в диалог, пока модель не ответит текстом. Не более tools.maxCalls обращений и не дольше
   * AGENT_BUDGET_MS; на последнем шаге инструменты не предлагаются, и модель отвечает по уже полученному.
   * Повтор того же вызова с теми же аргументами не выполняется. Сообщения в нейтральной форме
   * (assistant.tool_call, role 'tool'); в формат конкретной модели их переводит адаптер.
   * Каждый шаг пишется в трассировку агента (tr), если она есть.
   */
  async function callWithTools(model, payload, timeoutS, meta, tools, tr, session = newSession(), onProgress = null) {
    const maxCalls = tools.maxCalls || 4;
    // Журнал вызовов общий для основной и запасной модели: запасная продолжает с найденного, а не ищет заново.
    const messages = [...payload.messages, ...session.messages];
    const usage = { prompt: 0, completion: 0 };
    const t0 = Date.now();
    const seen = session.seen;
    for (let step = session.calls; ; step += 1) {
      const overBudget = Date.now() - t0 > AGENT_BUDGET_MS;
      const final = step >= maxCalls || overBudget;
      if (onProgress) onProgress({ phase: final && step > 0 ? 'answer' : 'think' });
      const callMessages = final && step > 0 ? [...messages, { role: 'user', content: FINAL_TEXT }] : messages;
      const out = await tracedCall(
        model,
        { ...payload, messages: callMessages, tools: final ? undefined : tools.definitions },
        timeoutS,
        meta,
        tr,
      );
      if (out.usage) {
        usage.prompt += out.usage.prompt || 0;
        usage.completion += out.usage.completion || 0;
      }
      if (!out.tool || final) {
        let stop = 'answer';
        if (final) stop = overBudget ? 'budget' : 'max_steps';
        return { ...out, tool: undefined, usage, stop };
      }
      const args = parseArgs(out.tool.arguments);
      const id = out.tool.id || `call_${step + 1}`;
      const kind = out.tool.name === 'use_skill' ? 'skill' : 'tool';
      const key = `${out.tool.name}:${JSON.stringify(args)}`;
      const s0 = Date.now();
      let content;
      let status = 'ok';
      if (onProgress) onProgress({ phase: 'tool', name: kind === 'skill' ? 'use_skill' : out.tool.name });
      if (seen.has(key)) {
        content = REPEAT_TEXT;
        status = 'repeat';
      } else {
        seen.add(key);
        try {
          content = String(await tools.execute(out.tool.name, args));
        } catch (e) {
          content = 'Не удалось получить данные этим инструментом.';
          status = 'error';
        }
      }
      if (tr)
        tr.step({
          kind,
          name: kind === 'skill' ? `use_skill:${String(args.name || '')}` : out.tool.name,
          args,
          result: content,
          durationMs: Date.now() - s0,
          status,
        });
      const pair = [
        { role: 'assistant', content: '', tool_call: { id, name: out.tool.name, arguments: args } },
        { role: 'tool', tool_call_id: id, name: out.tool.name, content },
      ];
      messages.push(...pair);
      session.messages.push(...pair);
      session.calls = step + 1;
    }
  }

  /** Журнал вызовов инструментов одного ответа: общий для основной и запасной модели. */
  function newSession() {
    return { messages: [], seen: new Set(), calls: 0 };
  }

  /**
   * Продолжение прерванного ответа: инструменты, которые агент уже вызвал в оборвавшемся запуске этого треда,
   * вызываются снова, а результаты кладутся в журнал, чтобы модель не искала то же самое заново.
   * Номера источников [n] при этом получаются заново (повтор идёт через те же инструменты) и согласованы с ответом.
   */
  async function resumeInterrupted(session, tools, tr, threadId) {
    if (!tr || !tr.id || !threadId || !tools || !tools.execute) return;
    const prior = tracer.interruptedCalls(threadId, tr.id);
    if (!prior) return;
    const names = new Set((tools.definitions || []).map((d) => d.name));
    let resumed = 0;
    for (const c of prior.calls) {
      if (!names.has(c.tool) || c.tool === 'use_skill') continue;
      const key = `${c.tool}:${JSON.stringify(c.args)}`;
      if (session.seen.has(key)) continue;
      const s0 = Date.now();
      let content;
      let status = 'ok';
      try {
        content = String(await tools.execute(c.tool, c.args));
      } catch (e) {
        content = null;
        status = 'error';
      }
      if (content === null) {
        tr.step({
          kind: 'tool',
          name: c.tool,
          args: c.args,
          durationMs: Date.now() - s0,
          status,
          reason: `возобновление после сбоя запуска ${prior.runId}`,
        });
        continue;
      }
      session.seen.add(key);
      const id = `resume_${resumed + 1}`;
      session.messages.push(
        { role: 'assistant', content: '', tool_call: { id, name: c.tool, arguments: c.args } },
        { role: 'tool', tool_call_id: id, name: c.tool, content },
      );
      session.calls += 1;
      resumed += 1;
      tr.step({
        kind: 'tool',
        name: c.tool,
        args: c.args,
        result: content,
        durationMs: Date.now() - s0,
        status,
        reason: `возобновление после сбоя запуска ${prior.runId}`,
      });
    }
  }

  /** Один вызов модели с записью шага в трассировку (успех и сбой). */
  async function tracedCall(model, payload, timeoutS, meta, tr, stepName = null) {
    const s0 = Date.now();
    try {
      const out = await callModel(model, payload, timeoutS, meta);
      if (tr) {
        const u = out && out.usage ? out.usage : {};
        tr.step({
          kind: 'model',
          model: model.model_ident,
          name: out && out.tool ? out.tool.name : stepName,
          result: out && !out.tool ? String(out.text || '') : null,
          tokensIn: u.prompt ?? null,
          tokensOut: u.completion ?? null,
          contextTokens: u.prompt ?? null,
          durationMs: Date.now() - s0,
        });
      }
      return out;
    } catch (e) {
      if (tr)
        tr.step({
          kind: 'model',
          model: model.model_ident,
          name: stepName,
          durationMs: Date.now() - s0,
          status: classifyFailure(e) === 'timeout' ? 'timeout' : 'error',
          error: describeError(e),
        });
      throw e;
    }
  }

  function classifyFailure(e) {
    if (e instanceof GatewayError) return 'error';
    const code = e && e.adapterCode;
    if (code === 'timeout' || (e && e.name === 'AbortError')) return 'timeout';
    return 'error';
  }

  /**
   * Вызов модели через шлюз. Текст пользователя уже псевдонимизирован (F-80).
   * @returns {Promise<{text, tool, flags, model, bindingVersion, promptKey, promptVersion, promptLayers, status, durationMs, tokensIn, tokensOut, piiCounts, piiMode}>}
   */
  /**
   * Блок «Сведения о собеседнике»: пол и (для пациента) признак закреплённого психиатра. Имён и другого ПДн нет.
   * Только для запросов с ролью пользователя; у навыков-функций блока нет.
   */
  const SEX_TEXT = { f: 'женский', m: 'мужской' };
  function interlocutorFacts(user) {
    if (!user || !user.id) return '';
    let sex = null;
    try {
      const row = db.prepare('SELECT sex FROM users WHERE id = ?').get(user.id);
      sex = row ? row.sex : null;
      // Форма обращения, которую пациент выбрал сам (чат, «Мои данные»), важнее поля users.sex, которое никто не заполняет.
      const pref = db.prepare('SELECT address_form, address_form_set FROM user_prefs WHERE user_id = ?').get(user.id);
      if (pref && pref.address_form_set) sex = pref.address_form;
    } catch {
      sex = null;
    }
    const lines = [];
    const known = SEX_TEXT[sex];
    if (user.role === 'patient') {
      lines.push(`пол: ${known || 'не указан'}`);
      let has = false;
      try {
        has = Boolean(
          db
            .prepare(
              "SELECT 1 FROM care_assignments ca JOIN users u ON u.id=ca.clinician_id WHERE ca.patient_id=? AND ca.ended_at IS NULL AND u.role='psychiatrist' LIMIT 1",
            )
            .get(user.id),
        );
      } catch {
        has = false;
      }
      lines.push(
        has
          ? 'закреплённый психиатр: есть'
          : 'закреплённого психиатра нет — не обещай, что сообщение дойдёт до врача; если у пользователя есть свой врач вне сервиса, посоветуй рассказать ему',
      );
    } else if (known) {
      lines.push(`пол: ${known}`);
    }
    return lines.length ? `Сведения о собеседнике:\n${lines.map((l) => `- ${l}`).join('\n')}` : '';
  }

  // Краткие содержания ранней части бесед: в памяти процесса (не хранятся в БД), ключ — тред и сжатая часть.
  const summaries = new Map();
  async function summarizeOlder({ older, user, patientId, threadId }) {
    const last = older[older.length - 1];
    const key = `${threadId}|${older.length}|${crypto.createHash('sha256').update(String(last.text)).digest('hex').slice(0, 16)}`;
    if (summaries.has(key)) return summaries.get(key);
    try {
      const sub = await run({
        purpose: 'clinician_chat',
        promptKey: 'skill.history_summary',
        user,
        patientId,
        threadId,
        text: ctxBudget.transcriptOf(older),
      });
      const out = String(sub.text || '').trim();
      if (!out || sub.status === 'filtered') return null;
      if (summaries.size >= 500) summaries.delete(summaries.keys().next().value);
      summaries.set(key, out);
      return out;
    } catch {
      return null;
    }
  }

  async function run({
    purpose,
    promptKey = catalog.DEFAULT_KEY_BY_PURPOSE[purpose] || purpose,
    skills = [],
    user,
    patientId = null,
    threadId = null,
    text,
    history = [],
    piiCounts = {},
    piiMode = null,
    crisis = false,
    files = 0,
    tools = null,
    onProgress = null,
    question = null,
  }) {
    const t0 = Date.now();
    const base = { purpose, userId: user.id, role: user.role, patientId, threadId, piiCounts, piiMode, crisis, files };
    // (2) ИИ выключен администратором (S-32) — кризисный путь сюда не доходит.
    const enabled = settings('ai.enabled').value;
    if (enabled && enabled.all === false) {
      audit({ ...base, status: 'error' });
      throw new GatewayError(503, 'E-AI-UNAVAILABLE', { disabled: true });
    }
    // (2) привязка назначения и двойная проверка режима данных.
    const binding = registry.getBinding(purpose);
    if (!binding || !binding.primary || !binding.primary.enabled) {
      audit({ ...base, status: 'error' });
      throw new GatewayError(503, 'E-AI-UNAVAILABLE', { no_binding: true });
    }
    checkDataMode(binding.primary);
    // (3) лимиты частоты и бюджет токенов (S-14).
    try {
      limits.check(purpose, user.id);
      budgetCheck();
    } catch (e) {
      audit({ ...base, status: 'limit' });
      throw e;
    }
    // (4а) Защитный слой (prompts/guard): для обращений специалиста и чата пациента. Пустое первое обращение
    // специалиста («ф», «?») отсекается без модели; остальное модель решает по смыслу (метка [[OFFTOPIC]]).
    const guardKey = catalog.guardFor(promptKey, user.role);
    if (
      guardKey === catalog.GUARD_CLINICIAN &&
      question !== null &&
      !history.length &&
      guardMarks.isTrivial(question)
    ) {
      const row = registry.activePrompt(promptKey);
      audit({ ...base, status: 'ok', modelId: binding.primary.id, bindingVersion: binding.version, promptVersion: row ? row.version : null, durationMs: Date.now() - t0 });
      return {
        text: texts.OFF_TOPIC_REPLY,
        tool: null,
        flags: [],
        offTopic: true,
        marks: [],
        model: binding.primary,
        bindingVersion: binding.version,
        promptKey,
        promptVersion: row ? row.version : null,
        promptLayers: [],
        status: 'ok',
        durationMs: Date.now() - t0,
        tokensIn: null,
        tokensOut: null,
        piiCounts,
        piiMode,
        traceId: null,
      };
    }
    // (5) промпт: системная инструкция из слоёв активных версий (роль, инструменты, навыки, задача).
    const withTools = Boolean(tools && tools.definitions && tools.definitions.length);
    const skillKeys = skills.filter((k) => catalog.categoryOf(k) === 'skill' && catalog.entryOf(k));
    // Схема «план и исполнение» (tools.plan, src/ai/workspace/clinrecPlan.js): поиск делает код, модель отвечает без
    // инструментов. Нужны действующие версии трёх её промптов и отсутствие навыков; иначе — прежний цикл инструментов.
    const planSpec =
      tools && tools.plan && !skillKeys.length && tools.plan.promptKeys.every((k) => registry.activePrompt(k))
        ? tools.plan
        : null;
    const facts = catalog.categoryOf(promptKey) === 'skill' ? '' : interlocutorFacts(user);
    const assembleFor = (planned) =>
      catalog.assemble({
        promptKey,
        userRole: user.role,
        withTools: planned || withTools,
        toolsKey: planned ? planSpec.answerKey : (tools && tools.rulesKey) || 'tools.common',
        skills: skillKeys,
        activePrompt: (key) => registry.activePrompt(key),
        facts,
      });
    const built = assembleFor(Boolean(planSpec));
    if (!catalog.entryOf(promptKey) || built.missing.length) {
      audit({ ...base, status: 'error' });
      throw new GatewayError(503, 'E-AI-UNAVAILABLE', { no_prompt: true });
    }
    const layers = [...built.layers];
    const promptVersion = built.layers.find((l) => l.key === promptKey).version;
    const prompt = { version: promptVersion };
    const timeouts = { ...DEFAULT_TIMEOUTS, ...(settings('ai.timeouts').value || {}) };
    // (5а) история. В чате специалиста — под окно модели (params_json.context_tokens): свежие сообщения как есть,
    // ранние — кратким содержанием (навык skill.history_summary, этап 7 плана агента); иначе последние 20.
    let historyMsgs = history.slice(-20);
    let system = built.system;
    let summaryNote = '';
    let historyNote = null;
    if (
      purpose === 'clinician_chat' &&
      catalog.categoryOf(promptKey) !== 'skill' &&
      history.length > ctxBudget.MIN_KEEP
    ) {
      const contextTokens = ctxBudget.contextTokensOf(binding.primary);
      const split = ctxBudget.splitHistory(history, ctxBudget.historyBudget(contextTokens, built.system, text));
      historyMsgs = split.recent;
      if (split.older.length) {
        const summary = await summarizeOlder({ older: split.older, user, patientId, threadId });
        if (summary) {
          summaryNote = `\n\nКраткое содержание более ранней части беседы (сжато автоматически, сообщений: ${split.older.length}):\n${summary}`;
          system = `${built.system}${summaryNote}`;
        }
        historyNote = {
          older: split.older.length,
          recent: split.recent.length,
          summarized: Boolean(summary),
          contextTokens,
        };
      }
    }
    const payload = {
      system,
      messages: [
        ...historyMsgs.map((m) => ({ role: m.role, content: m.text })),
        { role: 'user', content: String(text || '') },
      ],
    };
    // Прямой вызов навыка (режим function) без явных инструментов: в запрос идёт схема функции навыка, иначе настоящая
    // модель не вернёт вызов функции. Режим навыка задан в каталоге, схема — в src/ai/skills.js.
    const ownFn = !withTools && catalog.skillMode(promptKey) === 'function' ? skillSchemas.functionOf(promptKey) : null;
    if (ownFn) payload.tools = [ownFn];
    const flags = [];
    const meta = {
      purpose,
      modelIdent: binding.primary.model_ident,
      bindingVersion: binding.version,
      promptKey,
      promptVersion: prompt.version,
      promptLayers: layers,
    };

    // Инструменты запроса: описания берутся из каталога (слой «Инструменты»), навыки предлагаются функцией use_skill.
    const makeCallTools = () => {
      let callTools = tools;
      if (withTools || skillKeys.length) {
        const definitions = ((tools && tools.definitions) || []).map((d) => {
          const row = registry.activePrompt(`tools.${d.name}`);
          const text = row ? catalog.parseBody(row.body).text : '';
          if (!text) return d;
          layers.push({ key: `tools.${d.name}`, version: row.version });
          return { ...d, description: text };
        });
        if (skillKeys.length) {
          definitions.push({
            name: 'use_skill',
            description: 'Вызвать навык из списка доступных навыков: передай его имя и текст для обработки.',
            parameters: {
              type: 'object',
              properties: {
                name: { type: 'string', enum: skillKeys.map(catalog.skillName), description: 'Имя навыка' },
                input: { type: 'string', description: 'Текст, который навык должен обработать' },
              },
              required: ['name', 'input'],
            },
          });
        }
        const runSkill = async (args) => {
          const key = `skill.${String((args && args.name) || '')}`;
          const entry = catalog.entryOf(key);
          if (!entry || !skillKeys.includes(key)) return 'Такого навыка нет среди доступных.';
          // Режим instructions: тело навыка возвращается в диалог как инструкция; флаг навыка попадает в результат шлюза.
          if (catalog.skillMode(key) === 'instructions') {
            const row = registry.activePrompt(key);
            const body = row ? catalog.parseBody(row.body).text : '';
            if (!body) return 'Не удалось выполнить навык.';
            if (entry.flag && !flags.includes(entry.flag)) flags.push(entry.flag);
            return `Инструкция навыка ${args.name}:\n${body}`;
          }
          try {
            const sub = await run({
              purpose: entry.purpose,
              promptKey: key,
              user,
              patientId,
              threadId,
              text: String((args && args.input) || ''),
            });
            if (sub.tool) return JSON.stringify({ skill: args.name, result: sub.tool.arguments });
            return sub.text || 'Навык ничего не нашёл.';
          } catch (e) {
            return e && e.code === 'E-AI-EMPTY' ? 'Навык ничего не нашёл.' : 'Не удалось выполнить навык.';
          }
        };
        callTools = {
          maxCalls: tools && tools.maxCalls,
          definitions,
          execute: (name, args) => (name === 'use_skill' ? runSkill(args) : tools.execute(name, args)),
        };
      }
      return callTools;
    };
    let callTools = planSpec ? null : makeCallTools();

    // Трассировка агента: чат специалиста (не подзапрос навыка) — каждый шаг модели и инструментов (миграция 0033).
    const tr =
      purpose === 'clinician_chat' && catalog.categoryOf(promptKey) !== 'skill'
        ? tracer.start({
            user,
            purpose,
            promptKey,
            threadId,
            patientId,
            modelIdent: binding.primary.model_ident,
            layers,
            question: String(text || ''),
          })
        : null;
    if (tr && historyNote)
      tr.step({
        kind: 'note',
        name: 'history_summary',
        result: `Окно модели ${historyNote.contextTokens} токенов: ранних сообщений ${historyNote.older} ${historyNote.summarized ? 'сжато' : 'отброшено (сжатие не удалось)'}, свежих ${historyNote.recent}.`,
        status: historyNote.summarized ? 'ok' : 'error',
      });
    const traceEnd = (fields) => {
      if (tr) tr.finish({ durationMs: Date.now() - t0, ...fields });
    };

    // Схема «план и исполнение»: план, поиск и проверка полноты до ответа. Вызовы модели — основной моделью назначения,
    // без рассуждения, через тот же вызов с записью в журнал шагов; токены входят в итог ai_audit. Неудача — прежний цикл.
    const planUsage = { prompt: 0, completion: 0 };
    if (planSpec) {
      let planned = null;
      try {
        const ask = async ({ key, text: askText, name }) => {
          const row = registry.activePrompt(key);
          if (!row) throw new Error(`нет промпта ${key}`);
          if (!layers.some((l) => l.key === key)) layers.push({ key, version: row.version });
          const o = await tracedCall(
            binding.primary,
            {
              system: catalog.parseBody(row.body).text,
              messages: [{ role: 'user', content: askText }],
              reasoning: { enabled: false },
              temperature: 0,
              max_tokens: 3000,
            },
            Math.min(timeouts[purpose], PLAN_CALL_TIMEOUT_S),
            { ...meta, modelIdent: binding.primary.model_ident, promptKey: key },
            tr,
            name,
          );
          planUsage.prompt += (o.usage && o.usage.prompt) || 0;
          planUsage.completion += (o.usage && o.usage.completion) || 0;
          if (o.tool) throw new Error('модель вернула вызов функции вместо текста');
          return String(o.text || '');
        };
        planned = await planSpec.execute({
          ask,
          step: (st) => tr && tr.step(st),
          progress: (ev) => onProgress && onProgress(ev),
          history: historyMsgs,
        });
      } catch {
        planned = null;
      }
      if (planned && planned.offTopic) {
        // Планировщик счёл вопрос нецелевым: тяжёлый поиск и ответ не запускаются (слой guard.scope_clinician).
        const tIn = planUsage.prompt || null;
        const tOut = planUsage.completion || null;
        limits.record(purpose, user.id);
        recordUsage({ purpose, userId: user.id, tokens: (tIn || 0) + (tOut || 0) });
        audit({
          ...base,
          status: 'ok',
          modelId: binding.primary.id,
          bindingVersion: binding.version,
          promptVersion: prompt.version,
          layers,
          durationMs: Date.now() - t0,
          tokensIn: tIn,
          tokensOut: tOut,
        });
        traceEnd({ status: 'ok', answer: texts.OFF_TOPIC_REPLY, stopReason: 'offtopic', modelIdent: binding.primary.model_ident });
        return {
          text: texts.OFF_TOPIC_REPLY,
          tool: null,
          flags,
          offTopic: true,
          marks: [],
          model: binding.primary,
          bindingVersion: binding.version,
          promptKey,
          promptVersion: prompt.version,
          promptLayers: layers,
          status: 'ok',
          durationMs: Date.now() - t0,
          tokensIn: tIn,
          tokensOut: tOut,
          piiCounts,
          piiMode,
          traceId: tr ? tr.id : null,
        };
      }
      if (planned) {
        payload.messages[payload.messages.length - 1].content = planned.text;
        // Ответ по готовым фрагментам: рассуждение не отключается, но его бюджет можно ограничить (иначе у Qwen ответ
        // на сложный клинический случай уходит за таймаут; уровень effort модель не соблюдает, бюджет max_tokens — да).
        if (planSpec.answerReasoning) payload.reasoning = planSpec.answerReasoning;
        if (tr)
          tr.step({
            kind: 'note',
            name: 'plan_execute',
            result: `Схема «план и исполнение»: запросов ${planned.queries}, доискиваний ${planned.missing}.`,
          });
        if (onProgress) onProgress({ phase: 'answer' });
      } else {
        // Откат: правила и инструменты прежнего цикла, запрос врача как был.
        const loop = assembleFor(false);
        system = `${loop.system}${summaryNote}`;
        payload.system = system;
        for (let i = layers.length - 1; i >= 0; i -= 1) if (layers[i].key === planSpec.answerKey) layers.splice(i, 1);
        for (const l of loop.layers) if (!layers.some((x) => x.key === l.key)) layers.push(l);
        callTools = makeCallTools();
        if (tr)
          tr.step({
            kind: 'note',
            name: 'plan_fallback',
            result: 'План не получился или ничего не найдено: отвечаю прежним циклом инструментов.',
            status: 'error',
          });
      }
    }

    // (6) вызов основной модели; при ошибке/таймауте/пустом ответе — ОДИН вызов запасной (F-26).
    const session = newSession();
    const attempt = (model) =>
      callTools && callTools.definitions.length
        ? callWithTools(
            model,
            payload,
            timeouts[purpose],
            { ...meta, modelIdent: model.model_ident },
            callTools,
            tr,
            session,
            onProgress,
          )
        : tracedCall(model, payload, timeouts[purpose], { ...meta, modelIdent: model.model_ident }, tr);
    // Вызов инструмента (tool call) — не «пустой» ответ: вызывающий (например, извлечение НЯ, F-30) решает сам.
    const isEmpty = (o) => !o || (!o.tool && (!o.text || String(o.text).length < 2));
    const failAudit = (model, kind) => {
      traceEnd({
        status: kind === 'timeout' ? 'timeout' : 'error',
        stopReason: kind,
        modelIdent: model ? model.model_ident : null,
      });
      return audit({
        ...base,
        status: kind === 'timeout' ? 'timeout' : 'error',
        modelId: model ? model.id : null,
        bindingVersion: binding.version,
        promptVersion: prompt.version,
        layers,
        durationMs: Date.now() - t0,
      });
    };
    const failure = (kind) =>
      kind === 'timeout' ? new GatewayError(504, 'E-AI-TIMEOUT') : new GatewayError(503, 'E-AI-UNAVAILABLE');

    let out = null;
    let status = 'ok';
    let usedModel = binding.primary;
    let primaryFailure = null;
    try {
      if (callTools && callTools.definitions.length) await resumeInterrupted(session, callTools, tr, threadId);
      out = await attempt(binding.primary);
    } catch (e) {
      primaryFailure = classifyFailure(e);
    }
    if (primaryFailure || isEmpty(out)) {
      usedModel = binding.fallback;
      if (!usedModel) {
        failAudit(binding.primary, primaryFailure || 'error');
        throw primaryFailure ? failure(primaryFailure) : new GatewayError(502, 'E-AI-EMPTY');
      }
      checkDataMode(usedModel);
      try {
        out = await attempt(usedModel);
      } catch (e2) {
        const kind2 = classifyFailure(e2);
        failAudit(usedModel, kind2);
        throw failure(kind2);
      }
      if (isEmpty(out)) {
        failAudit(usedModel, 'error');
        throw new GatewayError(502, 'E-AI-EMPTY');
      }
      status = 'fallback';
    }

    // (7) пост-фильтр и ограничения длины.
    let reply = String(out.text || '');
    const cap = MAX_LEN[purpose] || MAX_LEN.default;
    if (reply.length > cap) reply = reply.slice(0, cap);
    // Чат специалиста (психиатр/психолог) не проходит пост-фильтр вывода целиком.
    // Специалист задаёт клинические вопросы и ожидает справочный клинический контент —
    // формулировки диагноза по критериям, назначения, дозы, препараты, схемы приёма.
    // Клиническое решение всегда за врачом, ИИ здесь — справочник/второй пилот, а не
    // источник пациентских формулировок. Решение владельца: фильтр безопасности снимается
    // со всего чата психиатра и психолога (ранее ослаблялись только drug/dose).
    // Пациентский контур (patient_assistant), авторские черновики (document_draft) и
    // кризисный протокол (crisisGate, до провайдера) этим изменением не затрагиваются.
    const clinicianChatUnfiltered =
      purpose === 'clinician_chat' && ['psychiatrist', 'psychologist'].includes(user.role);
    // Авторский черновик специалиста может обсуждать препараты для любой аудитории.
    // Исключение задаётся серверным ключом промпта, назначением и ролью автора;
    // персональные диагнозы, дозировки, императивы и обещания по-прежнему фильтруются.
    const articleOk =
      purpose === 'document_draft' &&
      ['task.article_patient', 'task.article_specialist', 'task.article_rewrite'].includes(promptKey) &&
      ['psychiatrist', 'psychologist'].includes(user.role);
    // Решение владельца 2026-10-26: в чате пациента пост-фильтр не применяется. Фильтр скрывал и поддерживающие слова
    // («всё будет хорошо», «примите душ»), лишая пациента ответа. Границы остаются в промпте роли (нет диагнозов, доз,
    // обещаний); ответ по-прежнему пишется в журнал ИИ. Чтобы вернуть фильтр, уберите patientUnfiltered ниже.
    const patientUnfiltered = purpose === 'patient_assistant' && user.role === 'patient';
    const verdict = outputFilter.check(reply, {
      skip:
        clinicianChatUnfiltered || patientUnfiltered ? outputFilter.DENY.map((d) => d.id) : articleOk ? ['drug'] : [],
    });
    if (!verdict.ok) {
      reply = purpose === 'clinician_chat' ? texts.FILTERED_REPLY_CLINICIAN : texts.FILTERED_REPLY;
      status = 'filtered';
    }
    // Метки защитных слоёв: вырезаются из текста до показа и сохранения (prompts/guard, src/ai/guardMarks.js).
    // Специалист: [[OFFTOPIC]] -> стандартное сообщение, вызывающий ничего не создаёт. Пациент: [[GAME]]/[[RUDE]] ->
    // метка уходит вызывающему, текст чистый.
    let offTopic = false;
    let marks = [];
    if (guardKey === catalog.GUARD_CLINICIAN && guardMarks.hasOffTopic(out.text)) {
      offTopic = true;
      reply = texts.OFF_TOPIC_REPLY;
      status = 'ok';
    } else if (guardKey === catalog.GUARD_PATIENT) {
      const stripped = guardMarks.stripConduct(reply);
      marks = stripped.marks;
      reply = stripped.text || (marks.length ? texts.CONDUCT_EMPTY_REPLY : reply);
    }

    const tokensIn = ((out.usage && out.usage.prompt) || 0) + planUsage.prompt || null;
    const tokensOut = ((out.usage && out.usage.completion) || 0) + planUsage.completion || null;
    limits.record(purpose, user.id);
    recordUsage({ purpose, userId: user.id, tokens: (tokensIn || 0) + (tokensOut || 0) });
    // (10) журнал без текстов.
    audit({
      ...base,
      status,
      modelId: usedModel.id,
      bindingVersion: binding.version,
      promptVersion: prompt.version,
      layers,
      durationMs: Date.now() - t0,
      tokensIn,
      tokensOut,
    });
    traceEnd({
      status,
      answer: status === 'filtered' ? `[ответ модели заменён пост-фильтром]\n${String(out.text || '')}` : reply,
      stopReason: out.stop || 'answer',
      modelIdent: usedModel.model_ident,
    });
    return {
      text: reply,
      tool: out.tool ? { ...out.tool, arguments: parseArgs(out.tool.arguments) } : null,
      flags,
      model: usedModel,
      bindingVersion: binding.version,
      promptKey,
      promptVersion: prompt.version,
      promptLayers: layers,
      status,
      durationMs: Date.now() - t0,
      tokensIn,
      tokensOut,
      piiCounts,
      piiMode,
      traceId: tr ? tr.id : null,
      offTopic,
      marks,
    };
  }

  return { run, limits, attachTraceMessage: tracer.attachMessage };
}

module.exports = { createGateway, GatewayError, DEFAULT_TIMEOUTS, DEFAULT_LIMITS };
