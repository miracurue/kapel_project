'use strict';

/**
 * Размер контекста под модель и сжатие длинной истории чата специалиста (этап 7 плана агента).
 *
 * Размер окна берётся из параметров модели (ai_models.params_json.context_tokens; экрана правки моделей пока нет),
 * без него — DEFAULT_CONTEXT_TOKENS. Токены оцениваются грубо по числу знаков (CHARS_PER_TOKEN, с запасом для русского
 * текста). Под историю отводится HISTORY_SHARE окна за вычетом системной инструкции и текущего сообщения; остальное —
 * ответ модели и результаты инструментов. Старые сообщения, не поместившиеся в бюджет, заменяются кратким содержанием
 * (его делает вызывающий — навык skill.history_summary).
 */

const DEFAULT_CONTEXT_TOKENS = 32000;
const CHARS_PER_TOKEN = 3;
const HISTORY_SHARE = 0.5;
const MIN_HISTORY_TOKENS = 1000;
const MIN_KEEP = 4;
const MAX_KEEP = 40;
const SUMMARY_SOURCE_MAX_CHARS = 24000;

const estimateTokens = (text) => Math.ceil(String(text || '').length / CHARS_PER_TOKEN);

function contextTokensOf(model) {
  let params = {};
  try {
    const raw = model && model.params_json;
    params = raw && typeof raw === 'object' ? raw : raw ? JSON.parse(raw) : {};
  } catch {
    params = {};
  }
  const n = Number(params.context_tokens);
  return Number.isInteger(n) && n >= 2000 ? n : DEFAULT_CONTEXT_TOKENS;
}

/** Бюджет истории в токенах для окна модели. */
function historyBudget(contextTokens, systemText, userText) {
  return Math.max(
    MIN_HISTORY_TOKENS,
    Math.floor(contextTokens * HISTORY_SHARE) - estimateTokens(systemText) - estimateTokens(userText),
  );
}

/**
 * Делит историю на «старое» (на сжатие) и «свежее» (как есть). Свежими остаются последние сообщения, пока
 * помещаются в бюджет, но не меньше MIN_KEEP и не больше MAX_KEEP.
 * @returns {{older: {role:string,text:string}[], recent: {role:string,text:string}[]}}
 */
function splitHistory(history, budgetTokens) {
  const list = Array.isArray(history) ? history : [];
  let used = 0;
  let keep = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const cost = estimateTokens(list[i].text) + 4;
    if (keep >= MAX_KEEP || (keep >= MIN_KEEP && used + cost > budgetTokens)) break;
    used += cost;
    keep += 1;
  }
  return { older: list.slice(0, list.length - keep), recent: list.slice(list.length - keep) };
}

/** Текст старой части беседы для навыка сжатия: последние SUMMARY_SOURCE_MAX_CHARS знаков. */
function transcriptOf(messages) {
  const text = messages.map((m) => `${m.role === 'user' ? 'Специалист' : 'ИИ'}: ${m.text}`).join('\n\n');
  return text.length <= SUMMARY_SOURCE_MAX_CHARS ? text : `…${text.slice(-SUMMARY_SOURCE_MAX_CHARS)}`;
}

module.exports = {
  DEFAULT_CONTEXT_TOKENS,
  estimateTokens,
  contextTokensOf,
  historyBudget,
  splitHistory,
  transcriptOf,
  MIN_KEEP,
  MAX_KEEP,
};
