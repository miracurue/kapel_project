'use strict';

/**
 * Адаптер `openai_compat` (M-19): любой OpenAI-совместимый адрес — llama.cpp / vLLM
 * на будущем сервере заказчика. Адрес — в реестре моделей (ai_models.api_base),
 * ключ — в окружении (имя переменной — ai_models.secret_name, значение никогда не в базе).
 * Модель на нашем сервере может быть помечена data_class='local_ok' — тогда она работает и при real.
 */

// Нейтральные сообщения шлюза (assistant.tool_call, role 'tool') -> формат tools OpenAI.
function toOpenaiMessage(m) {
  if (m.role === 'assistant' && m.tool_call)
    return {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: m.tool_call.id, type: 'function', function: { name: m.tool_call.name, arguments: JSON.stringify(m.tool_call.arguments || {}) } },
      ],
    };
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
  return m;
}

function createOpenaiCompat() {
  return {
    name: 'openai_compat',
    /** @returns {Promise<{text: string, tool?: object, usage?: object}>} */
    async call({ model, payload, signal }) {
      const base = String(model.api_base || '').replace(/\/+$/, '');
      if (!base) throw Object.assign(new Error('openai_compat: не задан api_base модели'), { adapterCode: 'config' });
      const secretName = model.secret_name || '';
      const apiKey = secretName ? process.env[secretName] || '' : '';
      const body = {
        model: model.model_ident,
        messages: [
          ...(payload.system ? [{ role: 'system', content: payload.system }] : []),
          ...(payload.messages || []).map(toOpenaiMessage),
        ],
        ...(payload.tools && payload.tools.length
          ? { tools: payload.tools.map((d) => (d.type ? d : { type: 'function', function: d })) }
          : {}),
        // Служебные вызовы без рассуждения (план и проверка полноты поиска): reasoning понимает OpenRouter, у прочих
        // OpenAI-совместимых серверов неизвестное поле лучше не посылать.
        ...(payload.reasoning && /openrouter\.ai/i.test(base) ? { reasoning: payload.reasoning } : {}),
        // Свой сервер (llama.cpp, vLLM) поле reasoning не знает, а отключение рассуждения шаблону чата передаётся так:
        // без этого планировщик Qwen думал по 20–30 с и упирался в таймаут вызова.
        ...(payload.reasoning && payload.reasoning.enabled === false && !/openrouter\.ai|api\.openai\.com/i.test(base)
          ? { chat_template_kwargs: { enable_thinking: false } }
          : {}),
        ...(Number.isFinite(payload.temperature) ? { temperature: payload.temperature } : {}),
        ...(Number.isFinite(payload.max_tokens) ? { max_tokens: payload.max_tokens } : {}),
      };
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw Object.assign(new Error(`openai_compat: HTTP ${res.status}`), { adapterCode: 'error' });
      const data = await res.json();
      const choice = data && Array.isArray(data.choices) && data.choices[0];
      const message = choice && choice.message;
      const usage = data && data.usage ? { prompt: data.usage.prompt_tokens, completion: data.usage.completion_tokens } : null;
      if (message && message.tool_calls && message.tool_calls[0] && message.tool_calls[0].function) {
        const fn = message.tool_calls[0].function;
        return { text: '', tool: { id: message.tool_calls[0].id, name: fn.name, arguments: fn.arguments }, usage };
      }
      return { text: String((message && message.content) || ''), usage };
    },
  };
}

module.exports = { createOpenaiCompat };
