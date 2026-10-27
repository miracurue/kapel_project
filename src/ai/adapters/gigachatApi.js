'use strict';

/**
 * Адаптер `gigachat_api` (M-19, S-41): OAuth-токен с кешем (один токен на серию вызовов,
 * живёт 30 минут — обновляем заранее), затем POST /chat/completions.
 *
 * Адреса переопределяются окружением (GIGACHAT_OAUTH_URL / GIGACHAT_API_URL) — в автотестах
 * это подделка, сети в тестах нет; в бою адреса из S-41. Ключ — только в окружении
 * (GIGACHAT_AUTH_KEY), в базе и журналах его нет. Сертификат НУЦ Минцифры подключается
 * стандартной переменной NODE_EXTRA_CA_CERTS (читается Node при старте процесса).
 * В теле запроса — только ключи #ТИП-N# после F-80: реальный текст наружу не уходит (PD-15).
 */

const crypto = require('crypto');

const DEFAULT_OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
// Модели 3-й серии (GigaChat-3-Ultra/Pro/Lightning) есть только на api.giga.chat; на прежнем
// gigachat.devices.sberbank.ru/api/v1 их нет (404 «No such model»).
const DEFAULT_API_URL = 'https://api.giga.chat/v1';

// Токен — на процесс: одна серия вызовов — один токен (M-19, T-125).
const tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken(signal) {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 60 * 1000) return tokenCache.token;
  const oauthUrl = process.env.GIGACHAT_OAUTH_URL || DEFAULT_OAUTH_URL;
  const authKey = process.env.GIGACHAT_AUTH_KEY || '';
  const scope = process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';
  if (!authKey) throw Object.assign(new Error('gigachat: нет GIGACHAT_AUTH_KEY'), { adapterCode: 'config' });
  const res = await fetch(oauthUrl, {
    method: 'POST',
    // Выдача токена принимает только форму (application/x-www-form-urlencoded); JSON даёт 415.
    headers: {
      authorization: `Basic ${authKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      rquid: crypto.randomUUID(),
    },
    body: new URLSearchParams({ scope }).toString(),
    signal,
  });
  if (!res.ok) throw Object.assign(new Error(`gigachat oauth: HTTP ${res.status}`), { adapterCode: 'error' });
  const data = await res.json();
  if (!data || !data.access_token) throw Object.assign(new Error('gigachat oauth: нет access_token'), { adapterCode: 'error' });
  tokenCache.token = String(data.access_token);
  tokenCache.expiresAt = Number(data.expires_at) || now + 29 * 60 * 1000;
  return tokenCache.token;
}

function createGigachatApi() {
  return {
    name: 'gigachat_api',
    /** @returns {Promise<{text: string, tool?: object, usage?: object}>} */
    async call({ model, payload, signal }) {
      const token = await getAccessToken(signal);
      const apiUrl = (process.env.GIGACHAT_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
      const body = {
        model: model.model_ident,
        messages: [
          ...(payload.system ? [{ role: 'system', content: payload.system }] : []),
          ...(payload.messages || []).map(toGigaMessage),
        ],
        ...(payload.tools && payload.tools.length ? { functions: payload.tools } : {}),
        ...(model.params_json && model.params_json.temperature !== undefined ? { temperature: model.params_json.temperature } : {}),
      };
      const res = await fetch(`${apiUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        // Тело ответа с ошибкой в журналы не пишется (PD-17): только статус.
        throw Object.assign(new Error(`gigachat: HTTP ${res.status}`), { adapterCode: 'error' });
      }
      const data = await res.json();
      const choice = data && Array.isArray(data.choices) && data.choices[0];
      const message = choice && choice.message;
      const usage = data && data.usage ? { prompt: data.usage.prompt_tokens, completion: data.usage.completion_tokens } : null;
      if (message && message.function_call) {
        const fc = message.function_call;
        return {
          text: '',
          tool: { id: fc.id, name: fc.name, arguments: typeof fc.arguments === 'string' ? safeParse(fc.arguments) : fc.arguments || {} },
          usage,
        };
      }
      return { text: String((message && message.content) || ''), usage };
    },
  };
}

// Нейтральные сообщения шлюза (assistant.tool_call, role 'tool') -> формат functions GigaChat.
function toGigaMessage(m) {
  if (m.role === 'assistant' && m.tool_call)
    return { role: 'assistant', content: '', function_call: { name: m.tool_call.name, arguments: m.tool_call.arguments || {} } };
  // Результат функции GigaChat принимает только JSON-строкой: обычный текст заворачиваем в {"result": …}.
  if (m.role === 'tool') return { role: 'function', name: m.name, content: JSON.stringify({ result: m.content }) };
  return m;
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { _raw: String(raw) };
  }
}

module.exports = { createGigachatApi };
