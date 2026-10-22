'use strict';

/**
 * Отправка сообщения пациента в ИИ-чат. Порядок строго фиксирован:
 *   1. валидация (пусто / длина / rate-limit) — ничего не сохраняется, текст возвращается пользователю;
 *   2. сохранение сообщения пациента;
 *   3. ДЕТЕРМИНИРОВАННЫЙ кризисный шлюз (crisisGate) — ДО провайдера. При срабатывании провайдер
 *      не вызывается, ответ фиксированный (texts.CRISIS_*), эскалация создаётся всегда (в т.ч. без врача);
 *   4. провайдер ИИ (+ пост-фильтр). Ошибка провайдера не теряет сообщение: сохраняется «недоступен» с «Повторить».
 */

const db = require('../db');
const threads = require('./threads');
const provider = require('./provider');
const gate = require('./crisisGate');
const texts = require('./texts');

const MAX_LEN = 2000;
const RATE_LIMIT = 20; // сообщений
const RATE_WINDOW_MS = 60 * 1000;

const hits = new Map(); // userId -> [timestamps]
let clock = () => Date.now();

function rateLimited(userId) {
  const now = clock();
  const arr = (hits.get(userId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_LIMIT) {
    hits.set(userId, arr);
    return true;
  }
  arr.push(now);
  hits.set(userId, arr);
  return false;
}

function resetRateLimit() {
  hits.clear();
}

function setClock(fn) {
  clock = fn || (() => Date.now());
}

function historyFor(threadId) {
  return threads
    .listMessages(threadId)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.kind !== 'error')
    .map((m) => ({ role: m.role, text: m.text }));
}

async function runProvider({ user, thread, role }) {
  try {
    const out = await provider.generate({ role, messages: historyFor(thread.id), context: { threadId: thread.id } });
    const kind = out.flags && out.flags.filtered ? 'filtered' : 'normal';
    const msg = threads.addMessage(thread.id, { role: 'assistant', text: out.text, kind, intent: (out.flags && out.flags.topic) || null, flags: { provider: out.flags.provider } });
    threads.audit({ userId: user.id, role: user.role, threadId: thread.id, event: 'reply', provider: out.flags.provider });
    return { assistant: msg, unavailable: false };
  } catch (e) {
    console.error('ai provider failed:', e && e.message);
    const msg = threads.addMessage(thread.id, { role: 'assistant', text: texts.UNAVAILABLE, kind: 'error' });
    threads.audit({ userId: user.id, role: user.role, threadId: thread.id, event: 'provider_error' });
    return { assistant: msg, unavailable: true };
  }
}

/**
 * @returns {Promise<{status:number, error?:string, thread?:object, user?:object, assistant?:object, crisis?:boolean,
 *   unavailable?:boolean, draft?:string}>}
 */
async function sendPatientMessage({ user, threadId, text }) {
  const raw = typeof text === 'string' ? text : '';
  const draft = raw;
  if (!raw.trim()) return { status: 400, error: texts.EMPTY, draft };
  // Ограничения длины и частоты НЕ применяются к кризисным сообщениям: кризисная фраза не должна
  // теряться из-за «слишком длинно» или «слишком часто».
  const isCrisis = gate.screen(raw).crisis;
  if (!isCrisis) {
    if (raw.length > MAX_LEN) return { status: 422, error: texts.TOO_LONG(MAX_LEN), draft };
    if (rateLimited(user.id)) return { status: 429, error: texts.RATE_LIMITED, draft };
  }

  let thread;
  if (threadId) {
    thread = threads.getThread(user.id, threadId, 'patient');
    // W3.K (L-2): кризисная фраза не теряется из-за устаревшего/удалённого треда — сообщение уходит в новый диалог
    if (!thread && isCrisis) thread = threads.createThread({ ownerUserId: user.id, role: 'patient' });
    if (!thread) return { status: 404, error: 'Диалог не найден.', draft };
  } else {
    thread = threads.createThread({ ownerUserId: user.id, role: 'patient' });
  }
  const body = raw.trim().slice(0, MAX_LEN * 2); // верхняя граница хранения даже для кризисного текста
  const first = db.prepare('SELECT COUNT(*) AS n FROM ai_messages WHERE thread_id = ?').get(thread.id).n === 0;
  const userMsg = threads.addMessage(thread.id, { role: 'user', text: body });
  if (first) thread.title = threads.applyAutoTitle(thread, body);

  // --- кризисный приоритет: ДО провайдера ---
  const g = gate.handleText({ patientId: user.id, text: raw.trim(), source: 'chatbot' });
  if (g.crisis) {
    const reply = !g.delivered ? texts.CRISIS_DELIVERY_FAILED : g.hasClinician ? texts.CRISIS_WITH_CLINICIAN : texts.CRISIS_NO_CLINICIAN;
    const assistant = threads.addMessage(thread.id, { role: 'assistant', text: reply, kind: 'crisis', intent: 'crisis', flags: { escalation_id: g.escalationId } });
    threads.audit({ userId: user.id, role: user.role, threadId: thread.id, event: 'crisis', crisis: true });
    return { status: 200, thread, user: userMsg, assistant, crisis: true, hasClinician: g.hasClinician, delivered: g.delivered };
  }

  threads.audit({ userId: user.id, role: user.role, threadId: thread.id, event: 'message' });
  const r = await runProvider({ user, thread, role: 'patient' });
  return { status: 200, thread, user: userMsg, assistant: r.assistant, crisis: false, unavailable: r.unavailable };
}

/** «Повторить» после недоступности: убирает сообщение-ошибку и повторно вызывает провайдера по сохранённой истории. */
async function retryLast({ user, threadId }) {
  const thread = threads.getThread(user.id, threadId, 'patient');
  if (!thread) return { status: 404, error: 'Диалог не найден.' };
  if (rateLimited(user.id)) return { status: 429, error: texts.RATE_LIMITED };
  const msgs = threads.listMessages(thread.id);
  const last = msgs[msgs.length - 1];
  if (!last || last.kind !== 'error') return { status: 200, thread };
  db.prepare('DELETE FROM ai_messages WHERE id = ?').run(last.id);
  const r = await runProvider({ user, thread, role: 'patient' });
  return { status: 200, thread, assistant: r.assistant, unavailable: r.unavailable };
}

module.exports = { sendPatientMessage, retryLast, resetRateLimit, setClock, MAX_LEN, RATE_LIMIT };
