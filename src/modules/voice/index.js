'use strict';

// W-31: пересылка в ml-worker (/stt, /ocr). Реальных пациентов в запросах нет:
// байты файла передаются как есть, текст расшифровки в журнал не пишется (PD-17).

function workerHeaders(config) {
  return { authorization: `Bearer ${config.mlWorkerToken || ''}` };
}

async function forwardFile(config, endpoint, buffer, mime, filename = 'file') {
  if (!config.mlWorkerUrl) return { ok: false, reason: 'not_configured' };
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename);
    const res = await fetch(`${config.mlWorkerUrl.replace(/\/+$/, '')}${endpoint}`, {
      method: 'POST',
      headers: workerHeaders(config),
      body: form,
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'down' };
  }
}

module.exports = { forwardFile };
