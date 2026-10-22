'use strict';

/**
 * Тонкий клиент ml-worker (12, «Части системы»): /ner здесь, /stt и /ocr — W-31.
 * Сеть разрешена только к СВОЕМУ ml-worker внутри контура организации (ML_WORKER_URL);
 * токен — общий секрет из окружения (ML_WORKER_TOKEN). Реальных пациентов в запросах нет:
 * /ner получает сырой текст до псевдонимизации, потому что распознаёт имена — это наш сервис.
 * Клиент никогда не бросает исключений наружу: недоступность → { ok: false } и режим «только правила» (F-80).
 */

const DEFAULT_TIMEOUT_MS = 5000;

function createMlClient({ config }) {
  const baseUrl = (config.mlWorkerUrl || '').replace(/\/+$/, '');
  const token = config.mlWorkerToken || '';
  const defaultTimeoutMs = config.mlNerTimeoutMs || DEFAULT_TIMEOUT_MS;

  async function post(path, body, timeoutMs = defaultTimeoutMs) {
    if (!baseUrl) return { ok: false, reason: 'not_configured' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, reason: `http_${res.status}` };
      return { ok: true, data: await res.json() };
    } catch (e) {
      return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'down' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Natasha NER: { ok: true, entities: [{type, start, end, text}] } — сейчас только PERSON. */
  async function ner(text, timeoutMs) {
    const r = await post('/ner', { text: String(text || '') }, timeoutMs);
    if (!r.ok) return r;
    const entities = Array.isArray(r.data && r.data.entities) ? r.data.entities : [];
    return { ok: true, entities };
  }

  return { ner, post };
}

module.exports = { createMlClient, DEFAULT_TIMEOUT_MS };
