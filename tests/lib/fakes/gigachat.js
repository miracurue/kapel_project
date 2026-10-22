'use strict';

// Подделка GigaChat API (OAuth + chat/completions) для проверки адаптера `gigachat_api` без сети.
// Приложение направляется на неё переменными GIGACHAT_OAUTH_URL и GIGACHAT_API_URL, которые
// действуют только при NODE_ENV=test (открытый вопрос 2 отчёта 13; в бою адреса — только из S-41).

const http = require('http');

function startFakeGigaChat() {
  const requests = [];
  let tokensIssued = 0;
  const behaviour = { reply: 'Синтетический ответ GigaChat-подделки.', fail: false };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://x');
      requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });
      const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (url.pathname.endsWith('/oauth')) {
        tokensIssued += 1;
        return send(200, { access_token: `fake-token-${tokensIssued}`, expires_at: Date.now() + 30 * 60 * 1000 });
      }
      if (url.pathname.endsWith('/chat/completions')) {
        if (behaviour.fail) return send(500, { message: 'fake failure' });
        let model = null;
        try { model = JSON.parse(body).model; } catch (_) { /* тело не JSON */ }
        return send(200, {
          model, object: 'chat.completion',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: behaviour.reply } }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        });
      }
      if (url.pathname.endsWith('/models')) return send(200, { data: [{ id: 'GigaChat-2-Max' }, { id: 'GigaChat-2-Pro' }] });
      return send(404, {});
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        oauthUrl: `${base}/api/v2/oauth`,
        apiUrl: `${base}/api/v1`,
        requests, behaviour,
        tokensIssued: () => tokensIssued,
        completions: () => requests.filter((r) => r.path.endsWith('/chat/completions')),
        close() { return new Promise((r) => server.close(() => r())); },
      });
    });
  });
}

module.exports = { startFakeGigaChat };
