'use strict';
// Адаптер gigachat_api: формат запросов к настоящему API Сбера. Подделка в tests/lib/fakes/gigachat.js
// не проверяет тип тела и схему авторизации выдачи токена — настоящий сервис отвечает 415 на JSON.
// covers: F-26, M-19
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

let server;
let base;
const seen = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/v2/oauth') {
        const form = (req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded');
        if (!form) return res.writeHead(415).end('{}');
        return res.end(JSON.stringify({ access_token: 'tok-1', expires_at: Date.now() + 30 * 60 * 1000 }));
      }
      return res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ок' } }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.GIGACHAT_OAUTH_URL = `${base}/api/v2/oauth`;
  process.env.GIGACHAT_API_URL = `${base}/v1`;
  process.env.GIGACHAT_AUTH_KEY = 'a2V5LXRlc3Q=';
});

after(async () => {
  delete process.env.GIGACHAT_OAUTH_URL;
  delete process.env.GIGACHAT_API_URL;
  delete process.env.GIGACHAT_AUTH_KEY;
  await new Promise((r) => server.close(r));
});

test('gigachat_api: токен запрашивается формой с Basic, чат — с Bearer и нужной моделью', async () => {
  const { createGigachatApi } = require('../../src/ai/adapters/gigachatApi');
  const out = await createGigachatApi().call({
    model: { model_ident: 'GigaChat-3-Ultra' },
    payload: { system: 'Инструкция', messages: [{ role: 'user', content: 'Привет' }] },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(out.text, 'ок');
  assert.deepEqual(out.usage, { prompt: 3, completion: 1 });

  const [oauth, chat] = seen;
  assert.equal(oauth.url, '/api/v2/oauth');
  assert.match(oauth.headers['content-type'], /^application\/x-www-form-urlencoded/);
  assert.equal(oauth.headers.authorization, 'Basic a2V5LXRlc3Q=');
  assert.ok(oauth.headers.rquid, 'RqUID задан');
  assert.equal(oauth.body, 'scope=GIGACHAT_API_PERS');

  assert.equal(chat.url, '/v1/chat/completions');
  assert.equal(chat.headers.authorization, 'Bearer tok-1');
  const sent = JSON.parse(chat.body);
  assert.equal(sent.model, 'GigaChat-3-Ultra');
  assert.deepEqual(sent.messages.map((m) => m.role), ['system', 'user']);
});

test('gigachat_api: адрес API по умолчанию — api.giga.chat (модели 3-й серии там)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../../src/ai/adapters/gigachatApi'), 'utf8');
  assert.match(src, /DEFAULT_API_URL = 'https:\/\/api\.giga\.chat\/v1'/);
});
