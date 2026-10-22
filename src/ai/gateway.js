'use strict';

/**
 * Единый шлюз ИИ (F-26). Порядок шагов строго фиксирован:
 *  (1) кризисная проверка уже пройдена вызывающим (crisisGate — до шлюза);
 *  (2) привязка назначения (кеш 30 с) и режим данных: модель synthetic_only при DATA_MODE=real
 *      не вызывается — вторая проверка после записи привязки (L-03, PD-01);
 *  (3) лимиты F-23/S-14 (частота по назначению и месячный бюджет токенов);
 *  (4) псевдонимизация F-80 выполнена до шлюза (src/ai/pii) — модель видит только ключи #ТИП-N#;
 *  (5) промпт = системная инструкция активной версии + текст пользователя отдельным сообщением
 *      («данные, не инструкции»);
 *  (6) вызов модели с таймаутом назначения (S-15); при ошибке или таймауте — ОДИН вызов запасной модели;
 *  (7) проверка ответа: пустой — E-AI-EMPTY; пост-фильтр (outputFilter) заменяет опасный совет
 *      безопасным текстом; длина ограничена (4000 пациент / 12000 специалист);
 *  (8)-(9) ответ сохраняет вызывающий: с ключами, с ai_generated=1, моделью и версиями;
 *  (10) журнал ai_audit без текстов и значений (PD-17): назначение, модель, версии, статус,
 *      длительность, токены, число замен по типам ключей, признак «только правила».
 */

const outputFilter = require('./outputFilter');
const texts = require('./texts');

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

  function monthKey(d) {
    return d.toISOString().slice(0, 7);
  }

  function audit(row) {
    // ТЕКСТОВ И ЗНАЧЕНИЙ В ЖУРНАЛЕ НЕТ (PD-17): только метаданные и числа.
    db.prepare(
      'INSERT INTO ai_audit(user_id, role, purpose, thread_id, patient_id, model_id, binding_version, prompt_version, data_mode, status, crisis, duration_ms, tokens_in, tokens_out, files, pii_counts_json, pii_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
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

  function classifyFailure(e) {
    if (e instanceof GatewayError) return 'error';
    const code = e && e.adapterCode;
    if (code === 'timeout' || (e && e.name === 'AbortError')) return 'timeout';
    return 'error';
  }

  /**
   * Вызов модели через шлюз. Текст пользователя уже псевдонимизирован (F-80).
   * @returns {Promise<{text, model, bindingVersion, promptKey, promptVersion, status, durationMs, tokensIn, tokensOut, piiCounts, piiMode}>}
   */
  async function run({
    purpose,
    promptKey = purpose,
    user,
    patientId = null,
    threadId = null,
    text,
    history = [],
    piiCounts = {},
    piiMode = null,
    crisis = false,
    files = 0,
    drugReference = false,
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
    // (5) промпт: системная инструкция активной версии.
    const prompt = registry.activePrompt(promptKey);
    if (!prompt) {
      audit({ ...base, status: 'error' });
      throw new GatewayError(503, 'E-AI-UNAVAILABLE', { no_prompt: true });
    }
    const timeouts = { ...DEFAULT_TIMEOUTS, ...(settings('ai.timeouts').value || {}) };
    const payload = {
      system: prompt.body,
      messages: [
        ...history.slice(-20).map((m) => ({ role: m.role, content: m.text })),
        { role: 'user', content: String(text || '') },
      ],
    };
    const meta = {
      purpose,
      modelIdent: binding.primary.model_ident,
      bindingVersion: binding.version,
      promptKey,
      promptVersion: prompt.version,
    };

    // (6) вызов основной модели; при ошибке/таймауте/пустом ответе — ОДИН вызов запасной (F-26).
    const attempt = (model) => callModel(model, payload, timeouts[purpose], { ...meta, modelIdent: model.model_ident });
    // Вызов инструмента (tool call) — не «пустой» ответ: вызывающий (например, извлечение НЯ, F-30) решает сам.
    const isEmpty = (o) => !o || (!o.tool && (!o.text || String(o.text).length < 2));
    const failAudit = (model, kind) =>
      audit({
        ...base,
        status: kind === 'timeout' ? 'timeout' : 'error',
        modelId: model ? model.id : null,
        bindingVersion: binding.version,
        promptVersion: prompt.version,
        durationMs: Date.now() - t0,
      });
    const failure = (kind) =>
      kind === 'timeout' ? new GatewayError(504, 'E-AI-TIMEOUT') : new GatewayError(503, 'E-AI-UNAVAILABLE');

    let out = null;
    let status = 'ok';
    let usedModel = binding.primary;
    let primaryFailure = null;
    try {
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
    // Справочный ответ специалисту о препарате (вкладка «Лекарства»): названия и дозы — суть ответа, поэтому эти два
    // правила не применяются. Только для врача/психолога и назначения clinician_chat; задаётся кодом сервера, не запросом.
    const referenceOk =
      drugReference === true && purpose === 'clinician_chat' && ['psychiatrist', 'psychologist'].includes(user.role);
    // Авторский черновик специалиста может обсуждать препараты для любой аудитории.
    // Исключение задаётся серверным ключом промпта, назначением и ролью автора;
    // персональные диагнозы, дозировки, императивы и обещания по-прежнему фильтруются.
    const articleOk =
      purpose === 'document_draft' &&
      ['article_draft.patient', 'article_draft.specialist', 'article_rewrite'].includes(promptKey) &&
      ['psychiatrist', 'psychologist'].includes(user.role);
    // Название лекарства само по себе допустимо и в объяснении пациенту.
    const patientExplanationOk = purpose === 'patient_assistant' && user.role === 'patient';
    const verdict = outputFilter.check(reply, {
      skip: referenceOk ? ['drug', 'dose'] : articleOk || patientExplanationOk ? ['drug'] : [],
    });
    if (!verdict.ok) {
      reply = texts.FILTERED_REPLY;
      status = 'filtered';
    }

    const tokensIn = (out.usage && out.usage.prompt) || null;
    const tokensOut = (out.usage && out.usage.completion) || null;
    limits.record(purpose, user.id);
    recordUsage({ purpose, userId: user.id, tokens: (tokensIn || 0) + (tokensOut || 0) });
    // (10) журнал без текстов.
    audit({
      ...base,
      status,
      modelId: usedModel.id,
      bindingVersion: binding.version,
      promptVersion: prompt.version,
      durationMs: Date.now() - t0,
      tokensIn,
      tokensOut,
    });
    return {
      text: reply,
      tool: out.tool || null,
      model: usedModel,
      bindingVersion: binding.version,
      promptKey,
      promptVersion: prompt.version,
      status,
      durationMs: Date.now() - t0,
      tokensIn,
      tokensOut,
      piiCounts,
      piiMode,
    };
  }

  return { run, limits };
}

module.exports = { createGateway, GatewayError, DEFAULT_TIMEOUTS, DEFAULT_LIMITS };
