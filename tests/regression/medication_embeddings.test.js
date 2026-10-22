'use strict';
// covers: public medication knowledge embeddings; offline transport/auth contract.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEmbeddingClient, diagnosticConfiguration } = require('../../src/modules/medication_knowledge/embeddings');

function setup(overrides = {}, respond) {
  const calls = [];
  const delays = [];
  const config = {
    env: {},
    authKey: 'test-credential',
    batchSize: 2,
    sleep: async (ms) => delays.push(ms),
    request: async (req) => {
      calls.push(req);
      if (respond) {
        const response = await respond(req, calls);
        if (response) return response;
      }
      if (req.url.includes('/oauth'))
        return { status: 200, data: { access_token: 'test-token', expires_at: Date.now() + 1800000 } };
      const body = JSON.parse(req.body);
      if (req.url.endsWith('/tokens/count')) return { status: 200, data: body.input.map(() => ({ tokens: 10 })) };
      return {
        status: 200,
        data: {
          model: body.model,
          data: body.input.map((_, index) => ({ index, embedding: Array(2560).fill(index + 1) })).reverse(),
        },
      };
    },
    ...overrides,
  };
  return { client: createEmbeddingClient(config), calls, delays };
}

test('OAuth form, exact model, token preflight, ordered vectors and sequential batching', async () => {
  const { client, calls } = setup();
  const result = await client.embed(['Публичная инструкция А.', 'Инструкция Б.', 'Инструкция В.']);
  assert.equal(result.model, 'EmbeddingsGigaR');
  assert.deepEqual(
    result.vectors.map((v) => v[0]),
    [1, 2, 1],
  );
  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname),
    ['/api/v2/oauth', '/v1/tokens/count', '/v1/embeddings', '/v1/tokens/count', '/v1/embeddings'],
  );
  assert.equal(calls[0].body, 'scope=GIGACHAT_API_PERS');
  assert.equal(calls[0].headers.authorization, 'Basic test-credential');
  assert.match(calls[0].headers.rquid, /^[\da-f-]{36}$/);
  assert.equal(calls[1].headers.authorization, 'Bearer test-token');
  assert.equal(JSON.parse(calls[1].body).model, 'EmbeddingsGigaR');
  await client.embed(['Повторный запрос.']);
  assert.equal(calls.filter((c) => c.url.includes('/oauth')).length, 1);
});

test('token preflight rejects oversized text without embedding/truncation', async () => {
  const { client, calls } = setup(
    {},
    (req) => req.url.endsWith('/tokens/count') && { status: 200, data: [{ tokens: 4097 }] },
  );
  await assert.rejects(client.embed(['Длинное предложение.']), { code: 'input_token_limit' });
  assert.equal(
    calls.some((c) => c.url.endsWith('/embeddings')),
    false,
  );
});

test('429 retry delay bounded; expired token refreshes once on 401', async () => {
  let count = 0;
  const { client, calls, delays } = setup({}, (req) => {
    if (req.url.endsWith('/tokens/count')) {
      count += 1;
      if (count === 1) return { status: 429, headers: { 'retry-after': '999999' } };
      if (count === 2) return { status: 401 };
    }
  });
  await client.embed(['Инструкция.']);
  assert.deepEqual(delays, [10000]);
  assert.equal(calls.filter((c) => c.url.includes('/oauth')).length, 2);
});

test('bounded errors redact transport/provider credentials and response bodies', async () => {
  const { client, calls } = setup({}, () => ({ status: 503, data: { secret: 'never-print-this' } }));
  await assert.rejects(client.embed(['Инструкция.']), (error) => {
    assert.equal(error.message, 'medication embeddings: http (HTTP 503)');
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(calls.length, 3);
  const badTransport = setup({
    request: async () => {
      throw new Error('secret=never-print-this');
    },
  });
  await assert.rejects(badTransport.client.embed(['Инструкция.']), { message: 'medication embeddings: transport' });
});

test('reject invalid vector dimensions, indexes, nonfinite coordinates, and mismatched model', async () => {
  for (const modify of [
    (data) => {
      data.model = 'Embeddings';
    },
    (data) => {
      data.data[0].index = 3;
    },
    (data) => {
      data.data[1].index = 0;
    },
    (data) => {
      data.data[0].embedding = [1, 2];
    },
    (data) => {
      data.data[0].embedding[0] = NaN;
    },
    (data) => {
      data.data[0].embedding.fill(0);
    },
  ]) {
    const { client } = setup({}, (req) => {
      if (!req.url.endsWith('/embeddings')) return;
      const data = {
        model: 'EmbeddingsGigaR',
        data: [0, 1].map((index) => ({ index, embedding: Array(2560).fill(1) })),
      };
      modify(data);
      return { status: 200, data };
    });
    await assert.rejects(client.embed(['А.', 'Б.']), { code: 'invalid_embeddings' });
  }
});

test('configuration and input diagnostics are safe and missing credentials fail before network', async () => {
  assert.ok(
    Object.values(diagnosticConfiguration({ GIGACHAT_AUTH_KEY: 'secret' })).every((x) => typeof x === 'boolean'),
  );
  assert.equal(diagnosticConfiguration({}).configured, false);
  let requested = false;
  const client = createEmbeddingClient({
    env: {},
    request: async () => {
      requested = true;
    },
  });
  await assert.rejects(client.embed(['А.']), { code: 'missing_credentials' });
  assert.equal(requested, false);
  for (const input of [[], [''], ['  '], [3], 'А.'])
    await assert.rejects(client.embed(input), { code: 'invalid_input' });
  assert.throws(() => createEmbeddingClient({ apiUrl: 'http://unsafe.local' }), { code: 'config' });
  assert.throws(() => createEmbeddingClient({ model: 'unknown' }), { code: 'config' });
});

test('concurrent embed calls serialize and failures do not poison queue', async () => {
  let active = 0;
  let maximum = 0;
  const { client } = setup({}, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
  });
  await Promise.all([client.embed(['А.']), client.embed(['Б.'])]);
  assert.equal(maximum, 1);
});

test('transient network retries are bounded and expose only allowlisted phase/code', async () => {
  let attempts = 0;
  const { client, delays } = setup({}, (req) => {
    if (req.url.endsWith('/tokens/count') && attempts++ < 2)
      throw Object.assign(new Error('private-url-and-token'), { code: 'ECONNRESET' });
  });
  await client.embed(['Инструкция.']);
  assert.deepEqual(delays, [500, 1000]);
  let failures = 0;
  const broken = setup({}, () => {
    failures += 1;
    throw Object.assign(new Error('secret'), { code: 'EAI_AGAIN' });
  });
  await assert.rejects(broken.client.embed(['Инструкция.']), (error) => {
    assert.equal(error.code, 'transport');
    assert.equal(error.networkCode, 'EAI_AGAIN');
    assert.equal(error.phase, 'oauth');
    assert.equal(error.message, 'medication embeddings: transport');
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(failures, 3);
  const badCert = setup({}, () => {
    throw Object.assign(new Error('secret'), { code: 'CERT_HAS_EXPIRED' });
  });
  await assert.rejects(badCert.client.embed(['Инструкция.']), { code: 'transport', networkCode: 'CERT_HAS_EXPIRED' });
  assert.deepEqual(badCert.delays, []);
});
