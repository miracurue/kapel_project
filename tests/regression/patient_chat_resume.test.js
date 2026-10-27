'use strict';
// covers: F-27, F-28 — вкладка «Чат» пациента возвращает в последний чат в пределах окна давности, а не в новый.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useApp } = require('../lib/suite');
const { expectOk } = require('../lib/client');
const F = require('../lib/flows');
const { activeThread, RESUME_WINDOW_MS } = require('../../src/ai/chatResume');
const ctx = useApp();

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
function setThread(id, patch) {
  const db = ctx.app.db();
  try {
    for (const [col, value] of Object.entries(patch))
      db.prepare(`UPDATE ai_threads SET ${col}=? WHERE id=?`).run(value, id); // col — из тестового литерала
  } finally {
    db.close();
  }
}
const location = (r) => r.headers.get('location') || '';

test('активный тред: граница окна давности включительно', async () => {
  const p = await ctx.as('patA');
  ctx.app.ai.setDefault({ mode: 'text', text: 'Ответ' });
  const threadId = expectOk(await F.patientAsk(p, 'Привет, как дела')).thread.id;
  const db = ctx.app.db();
  try {
    const last = Date.parse('2026-01-10T10:00:00Z');
    db.prepare('UPDATE ai_threads SET last_message_at=?, updated_at=? WHERE id=?').run(iso(last), iso(last), threadId);
    const userId = db.prepare('SELECT owner_user_id u FROM ai_threads WHERE id=?').get(threadId).u;
    assert.equal(activeThread(db, userId, last + RESUME_WINDOW_MS - 1)?.id, threadId, 'за миллисекунду до границы');
    assert.equal(activeThread(db, userId, last + RESUME_WINDOW_MS)?.id, threadId, 'ровно на границе');
    assert.equal(activeThread(db, userId, last + RESUME_WINDOW_MS + 1), null, 'после границы — новый чат');
  } finally {
    db.close();
  }
});

test('вкладка «Чат»: недавний тред открывается, старый, «новый чат», вопрос с другой вкладки и скрытый — нет', async () => {
  const p = await ctx.fresh('patB');
  ctx.app.ai.setDefault({ mode: 'text', text: 'Ответ' });
  const threadId = expectOk(await F.patientAsk(p, 'Мне тревожно перед работой')).thread.id;

  const back = await p.get('/app?tab=chat');
  assert.equal(back.status, 302);
  assert.equal(location(back), `/app?tab=chat&thread=${threadId}`);
  assert.equal((await p.get('/app')).status, 302, 'без параметра tab вкладка тоже чат');

  assert.equal((await p.get('/app?tab=chat&new=1')).status, 200, '«Новый чат» не перенаправляется');
  assert.equal((await p.get('/app?tab=chat&ask=visit:1')).status, 200, 'вопрос с другой вкладки идёт в новый чат');
  assert.equal((await p.get(`/app?tab=chat&thread=${threadId}`)).status, 200);
  assert.equal((await p.get('/app?tab=diary')).status, 200, 'другие вкладки не затронуты');

  const old = iso(Date.now() - RESUME_WINDOW_MS - 60000);
  setThread(threadId, { last_message_at: old, updated_at: old });
  assert.equal((await p.get('/app?tab=chat')).status, 200, 'тред старше окна — открывается новый чат');

  const fresh = iso(Date.now() - 60000);
  setThread(threadId, { last_message_at: fresh, updated_at: fresh });
  assert.equal((await p.get('/app?tab=chat')).status, 302);
  setThread(threadId, { hidden_at: fresh });
  assert.equal((await p.get('/app?tab=chat')).status, 200, 'удалённый тред не возвращается');
});

test('кризисный тред не подхватывается как обычный чат; сообщение с thread_id продолжает тот же тред', async () => {
  const p = await ctx.fresh('patC');
  ctx.app.ai.setDefault({ mode: 'text', text: 'Ответ' });
  const first = expectOk(await F.patientAsk(p, 'Расскажи, как работает дневник'));
  const second = expectOk(await F.patientAsk(p, 'А что с напоминаниями', { thread_id: first.thread.id }));
  assert.equal(second.thread.id, first.thread.id, 'тот же тред');
  const rows = ctx.app.query('SELECT count(*) n FROM ai_messages WHERE thread_id=?', [first.thread.id]);
  assert.equal(rows[0].n, 4);

  setThread(first.thread.id, { mode: 'crisis' });
  assert.equal((await p.get('/app?tab=chat')).status, 200);
});

test('чужой тред не возвращается другому пациенту', async () => {
  const a = await ctx.fresh('patA');
  const b = await ctx.fresh('patD');
  ctx.app.ai.setDefault({ mode: 'text', text: 'Ответ' });
  expectOk(await F.patientAsk(a, 'Привет'));
  const aThread = ctx.app.query("SELECT id FROM ai_threads WHERE owner_user_id=? AND purpose='patient_assistant'", [
    ctx.id('patA'),
  ])[0].id;
  const r = await b.get('/app?tab=chat');
  assert.ok(!location(r).includes(`thread=${aThread}`), 'чат другого пациента не открывается');
  assert.equal((await b.get(`/api/v1/ai/threads/${aThread}`)).status, 404);
});
