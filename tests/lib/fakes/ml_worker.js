'use strict';

// Подделка сервиса ml-worker (12, «Части системы»): /health, /stt, /ocr, /ner.
// Настоящие модели (GigaAM, Tesseract, Natasha) в автотестах не запускаются (build-rules, раздел 6).
// Тест управляет ответами напрямую: fake.mode.stt = 'ok' | 'empty' | 'down' | 'slow' и т. п.
// Подделка проверяет общий токен ML_WORKER_TOKEN (заголовок Authorization: Bearer или X-ML-Worker-Token).

const http = require('http');

// Синтетические имена, которые «находит» поддельный Natasha (настоящие люди не используются, PD-24).
const SYNTHETIC_NAMES = [
  'Марина Тестова', 'Марины Тестовой', 'Марине Тестовой', 'Тестова Марина',
  'Олег Пробный', 'Олега Пробного', 'Олегу Пробному',
  'Зоя Вымышленная', 'Зои Вымышленной', 'Пётр Условный', 'Петра Условного', 'Петр Условный',
  'Анна Синтетикова', 'Анны Синтетиковой', 'Игорь Демонстров', 'Игоря Демонстрова',
];

function startFakeMlWorker({ token }) {
  const calls = [];
  const mode = { stt: 'ok', ocr: 'printed', ner: 'ok', health: 'ok' };
  const preset = {
    stt: 'Расшифровка синтетической записи: хочу спросить про лекарство',
    ocr: 'Синтетический бланк. Сумма баллов 14. Пункт 9: 0',
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const auth = req.headers.authorization || '';
      const tokenOk = auth === `Bearer ${token}` || req.headers['x-ml-worker-token'] === token;
      const url = new URL(req.url, 'http://x');
      calls.push({ method: req.method, path: url.pathname, tokenOk, size: body.length, at: Date.now(),
        text: url.pathname === '/ner' ? safeText(body) : undefined });
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (!tokenOk && url.pathname !== '/health') return send(401, { error: 'token' });
      const m = mode[url.pathname.slice(1)];
      if (m === 'down') { res.destroy(); return undefined; }
      if (m === 'error') return send(500, { error: 'fake failure' });
      const go = () => {
        switch (url.pathname) {
          case '/health': return send(200, { status: 'ok', models: { stt: 'fake', ocr: 'fake', ner: 'fake' } });
          case '/stt':
            if (m === 'empty') return send(200, { text: '', segments: [], status: 'empty' });
            return send(200, { text: preset.stt, status: 'ok', segments: [{ start: 0, end: 3.2, text: preset.stt }] });
          case '/ocr':
            if (m === 'handwritten') return send(200, { text: '', status: 'handwritten_unrecognized' });
            return send(200, { text: preset.ocr, status: 'printed', pages: 1 });
          case '/ner': {
            const text = safeText(body);
            const entities = [];
            for (const name of SYNTHETIC_NAMES) {
              let i = text.indexOf(name);
              while (i >= 0) { entities.push({ type: 'PERSON', start: i, end: i + name.length, text: name }); i = text.indexOf(name, i + 1); }
            }
            return send(200, { entities });
          }
          default: return send(404, { error: 'not found' });
        }
      };
      if (m === 'slow') setTimeout(go, 130000); else go();
      return undefined;
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        calls, mode, preset,
        callsTo(p) { return calls.filter((c) => c.path === p); },
        reset() { calls.length = 0; Object.assign(mode, { stt: 'ok', ocr: 'printed', ner: 'ok', health: 'ok' }); },
        close() { return new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }); },
      });
    });
  });
}

function safeText(buf) {
  const s = buf.toString('utf8');
  try { const j = JSON.parse(s); return String(j.text || ''); } catch (_) { return s; }
}

module.exports = { startFakeMlWorker, SYNTHETIC_NAMES };
