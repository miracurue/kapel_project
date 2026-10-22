'use strict';

/**
 * Адаптер `openai_compat` (M-19): любой OpenAI-совместимый адрес — llama.cpp / vLLM
 * на будущем сервере заказчика. Адрес — в реестре моделей (ai_models.api_base),
 * ключ — в окружении (имя переменной — ai_models.secret_name, значение никогда не в базе).
 * Модель на нашем сервере может быть помечена data_class='local_ok' — тогда она работает и при real.
 */

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
          ...(payload.messages || []),
        ],
        ...(payload.tools && payload.tools.length ? { tools: payload.tools } : {}),
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
        return { text: '', tool: { name: fn.name, arguments: fn.arguments }, usage };
      }
      return { text: String((message && message.content) || ''), usage };
    },
  };
}

module.exports = { createOpenaiCompat };
