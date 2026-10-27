'use strict';
// Удаление беседы из истории чатов специалиста: своя скрывается без содержимого в журнале, чужая — 404.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk, expectError } = require('../lib/client');
const ctx = useApp();

test('DELETE /api/v1/ai/threads/{id}: своя беседа скрывается, чужая 404, список обновляется', async () => {
  const a = await ctx.as('psy1');
  const b = await ctx.as('psy2');
  const made = expectOk(await a.post('/api/v1/ai/clinician/messages', { text: 'Секретный вопрос про пациента', chips: [] }), 201);
  const id = made.thread.id;
  expectError(await b.del(`/api/v1/ai/threads/${id}`), 404, 'E-NOT-FOUND');
  assert.equal(ctx.app.query('SELECT hidden_at FROM ai_threads WHERE id=?', id)[0].hidden_at, null);
  expectOk(await a.del(`/api/v1/ai/threads/${id}`));
  assert.ok(ctx.app.query('SELECT hidden_at FROM ai_threads WHERE id=?', id)[0].hidden_at);
  assert.ok(!expectOk(await a.get('/api/v1/ai/threads')).items.some((t) => t.id === id));
  expectError(await a.get(`/api/v1/ai/threads/${id}`), 404, 'E-NOT-FOUND');
  const log = ctx.app.query("SELECT * FROM action_log WHERE action='ai.thread.hidden' AND target_id=?", String(id));
  assert.equal(log.length, 1);
  assert.ok(!JSON.stringify(log).includes('Секретный'));
});
