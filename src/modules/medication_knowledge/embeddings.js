'use strict';

// Public medication instructions/search terms only. Never pass patient context here.
// NODE_EXTRA_CA_CERTS is read by Node at startup; TLS verification stays enabled.
// Official API: https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/post-embeddings
// Model limits: https://developers.sber.ru/docs/ru/gigachat/models/embeddings-giga-r
const https = require('node:https');
const { randomUUID } = require('node:crypto');
const { URL } = require('node:url');
const { clearTimeout } = require('node:timers');

const MODELS = Object.freeze({
  EmbeddingsGigaR: { tokens: 4096, dimensions: 2560 },
  Embeddings: { tokens: 512, dimensions: 1024 },
  'Embeddings-2': { tokens: 512, dimensions: 1024 },
});
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
]);
const RETRY_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

function transportFailure(error) {
  const safe = failure('transport');
  if (error && NETWORK_CODES.has(error.code)) safe.networkCode = error.code;
  return safe;
}

function failure(code, status) {
  const error = new Error(`medication embeddings: ${code}${status ? ` (HTTP ${status})` : ''}`);
  error.code = code;
  if (status) error.status = status;
  return error;
}

function diagnosticConfiguration(env = process.env) {
  return {
    authKeyPresent: Boolean(env.GIGACHAT_AUTH_KEY),
    accessTokenPresent: Boolean(env.GIGACHAT_ACCESS_TOKEN),
    scopePresent: Boolean(env.GIGACHAT_SCOPE),
    modelPresent: Boolean(env.GIGACHAT_EMBEDDING_MODEL),
    apiUrlPresent: Boolean(env.GIGACHAT_API_URL),
    oauthUrlPresent: Boolean(env.GIGACHAT_OAUTH_URL),
    extraCaPresent: Boolean(env.NODE_EXTRA_CA_CERTS),
    configured: Boolean(env.GIGACHAT_AUTH_KEY || env.GIGACHAT_ACCESS_TOKEN),
  };
}

function endpoint(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw failure('config');
    return url.href.replace(/\/+$/, '');
  } catch {
    throw failure('config');
  }
}

function nativeRequest({ url, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    // Official endpoints support TLS 1.3. Explicit minimum also avoids the
    // reproducible TLS 1.2 ClientHello reset on api.giga.chat in this environment.
    const req = https.request(
      url,
      { method: 'POST', headers, rejectUnauthorized: true, minVersion: 'TLSv1.3' },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) {
            finish(failure('response_too_large'));
            res.destroy();
            req.destroy();
          } else chunks.push(chunk);
        });
        res.on('error', (error) => finish(transportFailure(error)));
        res.on('end', () => {
          // Ignore error bodies: providers may echo credentials or input text.
          if (res.statusCode < 200 || res.statusCode >= 300) {
            finish(null, { status: res.statusCode, headers: res.headers });
            return;
          }
          try {
            finish(null, {
              status: res.statusCode,
              headers: res.headers,
              data: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch {
            finish(failure('invalid_json'));
          }
        });
      },
    );
    req.on('error', (error) => finish(transportFailure(error)));
    timer = setTimeout(() => {
      finish(failure('timeout'));
      req.destroy();
    }, timeoutMs);
    req.end(body);
  });
}

/**
 * Configuration uses existing GIGACHAT_AUTH_KEY / SCOPE / API_URL / OAUTH_URL,
 * optional GIGACHAT_ACCESS_TOKEN and GIGACHAT_EMBEDDING_MODEL. The caller loads
 * .env explicitly (node --env-file=.env); this module never reads secret files.
 * request/sleep/now are injectable for offline tests. Batch size is a local
 * policy (8 by default), not a claimed provider limit. Requests are serialized.
 */
function createEmbeddingClient(config = {}) {
  const env = config.env || process.env;
  const authKey = config.authKey ?? env.GIGACHAT_AUTH_KEY ?? '';
  const fixedToken = config.accessToken ?? env.GIGACHAT_ACCESS_TOKEN ?? '';
  const scope = config.scope ?? env.GIGACHAT_SCOPE ?? 'GIGACHAT_API_PERS';
  const model = config.model ?? env.GIGACHAT_EMBEDDING_MODEL ?? 'EmbeddingsGigaR';
  const limits = MODELS[model];
  const batchSize = config.batchSize ?? 8;
  const timeoutMs = config.timeoutMs ?? 30000;
  const maxRetries = config.maxRetries ?? 2;
  const api = endpoint(config.apiUrl || env.GIGACHAT_API_URL || 'https://api.giga.chat/v1');
  const oauth = endpoint(
    config.oauthUrl || env.GIGACHAT_OAUTH_URL || 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
  );
  if (
    !limits ||
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 16 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000 ||
    !Number.isInteger(maxRetries) ||
    maxRetries < 0 ||
    maxRetries > 3 ||
    !['GIGACHAT_API_PERS', 'GIGACHAT_API_B2B', 'GIGACHAT_API_CORP'].includes(scope) ||
    typeof authKey !== 'string' ||
    typeof fixedToken !== 'string' ||
    /[\r\n]/.test(authKey + fixedToken)
  )
    throw failure('config');
  const request = config.request || nativeRequest;
  const sleep = config.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = config.now || Date.now;
  let token = fixedToken;
  let expiresAt = fixedToken ? Infinity : 0;
  let queue = Promise.resolve();

  async function send(url, headers, body) {
    for (let retry = 0; ; retry += 1) {
      let response;
      try {
        response = await request({ url, headers, body, timeoutMs });
      } catch (error) {
        // Never propagate transport messages, URLs, bodies, or error causes.
        const safe = failure(
          error && ['timeout', 'invalid_json', 'response_too_large'].includes(error.code) ? error.code : 'transport',
        );
        const networkCode = error && (NETWORK_CODES.has(error.networkCode) ? error.networkCode : error.code);
        if (NETWORK_CODES.has(networkCode)) safe.networkCode = networkCode;
        safe.phase = url === oauth ? 'oauth' : url.endsWith('/tokens/count') ? 'tokens' : 'embeddings';
        if (retry < maxRetries && (safe.code === 'timeout' || RETRY_NETWORK_CODES.has(safe.networkCode))) {
          await sleep(500 * 2 ** retry);
          continue;
        }
        throw safe;
      }
      const status = response && response.status;
      if (!Number.isInteger(status)) throw failure('invalid_response');
      if ((status === 429 || status >= 500) && retry < maxRetries) {
        const raw = response.headers && response.headers['retry-after'];
        const seconds = Number(raw);
        const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(raw) - now();
        await sleep(Math.min(10000, Math.max(250 * 2 ** retry, Number.isFinite(delay) ? delay : 0)));
        continue;
      }
      if (status < 200 || status >= 300) throw failure('http', status);
      return response.data;
    }
  }

  async function accessToken() {
    if (token && now() < expiresAt - 60000) return token;
    if (!authKey) throw failure('missing_credentials');
    const data = await send(
      oauth,
      {
        authorization: `Basic ${authKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        rquid: randomUUID(),
      },
      new URLSearchParams({ scope }).toString(),
    );
    let expiry = Number(data && data.expires_at);
    if (expiry < 1e12) expiry *= 1000;
    if (
      !data ||
      typeof data.access_token !== 'string' ||
      !data.access_token ||
      /[\r\n]/.test(data.access_token) ||
      !Number.isFinite(expiry) ||
      expiry <= now() + 60000
    ) {
      throw failure('invalid_oauth_response');
    }
    token = data.access_token;
    expiresAt = expiry;
    return token;
  }

  async function apiCall(path, input) {
    for (let refresh = 0; ; refresh += 1) {
      const bearer = await accessToken();
      try {
        return await send(
          `${api}${path}`,
          {
            authorization: `Bearer ${bearer}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          JSON.stringify({ model, input }),
        );
      } catch (error) {
        if (error.status !== 401 || !authKey || refresh > 0) throw error;
        token = '';
        expiresAt = 0;
      }
    }
  }

  async function run(texts) {
    const vectors = [];
    for (let start = 0; start < texts.length; start += batchSize) {
      const input = texts.slice(start, start + batchSize);
      const counts = await apiCall('/tokens/count', input);
      if (
        !Array.isArray(counts) ||
        counts.length !== input.length ||
        counts.some((row) => !row || !Number.isInteger(row.tokens) || row.tokens < 1)
      ) {
        throw failure('invalid_token_count');
      }
      if (counts.some((row) => row.tokens > limits.tokens)) throw failure('input_token_limit');
      const result = await apiCall('/embeddings', input);
      if (!result || result.model !== model || !Array.isArray(result.data) || result.data.length !== input.length)
        throw failure('invalid_embeddings');
      const ordered = new Array(input.length);
      for (const row of result.data) {
        if (
          !row ||
          !Number.isInteger(row.index) ||
          row.index < 0 ||
          row.index >= input.length ||
          ordered[row.index] ||
          !Array.isArray(row.embedding) ||
          row.embedding.length !== limits.dimensions ||
          row.embedding.some((n) => typeof n !== 'number' || !Number.isFinite(n)) ||
          !row.embedding.some((n) => n !== 0)
        ) {
          throw failure('invalid_embeddings');
        }
        ordered[row.index] = row.embedding;
      }
      vectors.push(...ordered);
    }
    return { model, vectors };
  }

  return {
    model,
    async embed(texts) {
      if (!Array.isArray(texts) || !texts.length || texts.some((text) => typeof text !== 'string' || !text.trim()))
        throw failure('invalid_input');
      const copy = texts.slice();
      const result = queue.then(() => run(copy));
      queue = result.catch(() => {});
      return result;
    },
  };
}

module.exports = { createEmbeddingClient, diagnosticConfiguration, MODELS };
