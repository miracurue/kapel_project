'use strict';

/**
 * Сервис ИИ-пространства врача: отправка сообщений/сценариев, привязка к пациенту, удаление диалога.
 * Кризисный шлюз врачу не нужен (кризис пациента показывается баннером, REQ-AID-014).
 * Порядок отправки: валидация (длина/частота) -> тред (404 для чужого) -> сохранение сообщения врача ->
 * контекст пациента (только закреплённый + согласия) -> материалы треда -> провайдер (+пост-фильтр) -> ответ.
 * Ошибка провайдера не теряет ни сообщение, ни файлы (REQ-AID-015).
 */

const ejs = require('ejs');
const path = require('path');
const db = require('../../db');
const threads = require('../threads');
const provider = require('../provider');
const scenarios = require('./scenarios');
const context = require('./context');
const store = require('./store');
const { DRAFT_LABEL } = require('./export');

const MAX_LEN = 8000;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_THREADS = 200;
const CONTEXT_CHARS = 12000;

const T = {
  EMPTY: 'Напишите сообщение или выберите сценарий над полем ввода.',
  TOO_LONG: (n) => `Сообщение длиннее ${n} символов. Сократите его или разделите на части — введённый текст не потерян.`,
  RATE: 'Слишком много запросов за минуту. Подождите немного и отправьте снова — текст сохранён в поле ввода.',
  THREAD_LIMIT: `Достигнут лимит: ${MAX_THREADS} диалогов. Удалите ненужные диалоги в списке слева и попробуйте снова.`,
  UNAVAILABLE: 'Помощник временно недоступен. Ваше сообщение и прикреплённые материалы сохранены — нажмите «Повторить» чуть позже.',
  NOT_FOUND: 'Диалог не найден.',
};

const hits = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const arr = (hits.get(userId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_LIMIT) { hits.set(userId, arr); return true; }
  arr.push(now);
  hits.set(userId, arr);
  return false;
}
function resetRateLimit() { hits.clear(); }

// ---------- аудит ----------

/** Аудит обращений: кто, когда, тред, id привязанного пациента, число файлов. БЕЗ содержимого (REQ-AID-013). */
function audit({ user, threadId = null, event, patientId = null, files = null, provider: prov = null }) {
  db.prepare('INSERT INTO ai_audit (user_id, role, thread_id, event, crisis, provider, patient_id, files) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
    .run(user.id, user.role, threadId, event, prov, patientId, files);
}

function phi(user, patientId, action) {
  db.prepare('INSERT INTO phi_access_log (actor_id, patient_id, action) VALUES (?, ?, ?)').run(user.id, patientId, action);
}

// ---------- треды ----------

function countThreads(userId) {
  return db.prepare("SELECT COUNT(*) AS n FROM ai_threads WHERE owner_user_id = ? AND role = 'clinician'").get(userId).n;
}

/** Создать тред; patientId — только закреплённый (иначе null и причина). */
function createThread(user, { patientId = null } = {}) {
  if (countThreads(user.id) >= MAX_THREADS) return { error: T.THREAD_LIMIT, status: 422 };
  let pid = null;
  if (patientId) {
    const acc = context.access(user, patientId);
    if (!acc.ok) return { error: 'Этот пациент не закреплён за вами или недоступен.', status: 403 };
    pid = acc.patient.id;
  }
  const thread = threads.createThread({ ownerUserId: user.id, role: 'clinician', patientId: pid });
  if (pid) {
    phi(user, pid, 'ai_bind_patient');
    audit({ user, threadId: thread.id, event: 'ws_bind_patient', patientId: pid });
  } else audit({ user, threadId: thread.id, event: 'ws_thread_created' });
  return { thread };
}

/** Привязать уже существующий непривязанный тред. Повторная привязка к другому пациенту запрещена. */
function bindThread(user, thread, patientId) {
  if (thread.patient_id) return { error: 'Диалог уже привязан к пациенту. Начните новый диалог для другого пациента.', status: 409 };
  const acc = context.access(user, patientId);
  if (!acc.ok) return { error: 'Этот пациент не закреплён за вами или недоступен.', status: 403 };
  db.prepare('UPDATE ai_threads SET patient_id = ? WHERE id = ?').run(acc.patient.id, thread.id);
  db.prepare('UPDATE ai_attachments SET patient_id = ? WHERE thread_id = ?').run(acc.patient.id, thread.id);
  phi(user, acc.patient.id, 'ai_bind_patient');
  audit({ user, threadId: thread.id, event: 'ws_bind_patient', patientId: acc.patient.id });
  return { thread: threads.getThread(user.id, thread.id, 'clinician') };
}

/** Удаление диалога: материалы (файлы + записи), сообщения, тред. Аудит остаётся без текста. */
function deleteThreadFully(user, thread) {
  const files = store.deleteThreadMaterials(thread.id);
  threads.deleteThread(user.id, thread.id);
  audit({ user, threadId: thread.id, event: 'ws_thread_deleted', patientId: thread.patient_id || null, files });
}

// ---------- контекст для провайдера ----------

function materialsFor(thread) {
  const rows = store.listMaterials(thread.id, thread.owner_user_id);
  if (!rows.length) return [];
  const budget = Math.floor(CONTEXT_CHARS / rows.length);
  return rows.map((r) => ({ seq: r.seq, name: r.name, hasText: !!r.has_text, text: String(r.text_extracted || '').slice(0, budget) }));
}

function history(threadId) {
  return threads
    .listMessages(threadId)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && !['error', 'hint'].includes(m.kind))
    .map((m) => ({ role: m.role, text: m.text }));
}

function parseFlags(m) {
  try { return m.flags_json ? JSON.parse(m.flags_json) : {}; } catch { return {}; }
}

const HINT_NEEDS_PATIENT = (title) =>
  `Для сценария «${title}» нужен пациент. Привяжите к диалогу своего закреплённого пациента (блок «Привязать пациента» над лентой) `
  + 'или начните новый диалог по пациенту. Без пациента доступны «Что уточнить на приёме» и «Гипотезы для дифдиагностики» в общем виде.';
const HINT_LOST_ACCESS = 'Пациент больше не закреплён за вами или недоступен, поэтому данные сервиса по нему не используются.';

async function runProvider({ user, thread, scenarioKey, periodDays }) {
  const sc = scenarioKey ? scenarios.get(scenarioKey) : null;
  let patient = null;
  let hint = null;
  if (thread.patient_id) {
    const c = context.build(user, thread.patient_id, { periodDays });
    if (c.ok) {
      patient = c.facts;
      phi(user, thread.patient_id, 'ai_context_read');
    } else hint = HINT_LOST_ACCESS;
  }
  if (sc && sc.needsPatient && !patient) {
    const text = hint || HINT_NEEDS_PATIENT(sc.title);
    const msg = threads.addMessage(thread.id, { role: 'assistant', text, kind: 'hint', intent: sc.key });
    audit({ user, threadId: thread.id, event: 'ws_hint', patientId: thread.patient_id || null });
    return { assistant: msg, unavailable: false };
  }
  const mats = materialsFor(thread);
  try {
    const out = await provider.generate({
      role: 'clinician',
      messages: history(thread.id),
      context: { scenario: sc ? sc.key : null, periodDays: periodDays || null, patient, materials: mats },
    });
    const kind = out.flags && out.flags.filtered ? 'filtered' : 'normal';
    // Метка «черновик» — часть самого текста: она видна на экране, попадает в буфер при копировании и в экспорт (REQ-AID-009)
    const msg = threads.addMessage(thread.id, {
      role: 'assistant', text: `${DRAFT_LABEL}\n\n${out.text}`, kind, intent: sc ? sc.key : (out.flags && out.flags.topic) || null,
      flags: { provider: out.flags.provider, sources: kind === 'filtered' ? [] : (out.sources || []).slice(0, 5), scenario: sc ? sc.key : null },
    });
    audit({ user, threadId: thread.id, event: 'ws_reply', patientId: thread.patient_id || null, files: mats.length, provider: out.flags.provider });
    return { assistant: msg, unavailable: false };
  } catch (e) {
    console.error('ai workspace provider failed:', e && e.message);
    const msg = threads.addMessage(thread.id, { role: 'assistant', text: T.UNAVAILABLE, kind: 'error' });
    audit({ user, threadId: thread.id, event: 'ws_provider_error', patientId: thread.patient_id || null, files: mats.length });
    return { assistant: msg, unavailable: true };
  }
}

const EXTRAS_FILE = path.join(__dirname, '..', '..', '..', 'views', 'ai', 'workspace', '_msg_extras.ejs');
async function renderExtras(base, m) {
  return ejs.renderFile(EXTRAS_FILE, { base, m, ws: { sourcesOf }, thread: null });
}

function sourcesOf(m) {
  const f = parseFlags(m);
  return Array.isArray(f.sources) ? f.sources : [];
}

/**
 * @returns {Promise<{status:number,error?:string,draft?:string,thread?:object,user?:object,assistant?:object,unavailable?:boolean,extras?:string}>}
 */
async function sendMessage({ user, base, threadId, text, scenarioKey = null, periodDays = null }) {
  const sc = scenarioKey ? scenarios.get(scenarioKey) : null;
  if (scenarioKey && !sc) return { status: 400, error: 'Неизвестный сценарий.', draft: text || '' };
  const raw = sc ? sc.title : typeof text === 'string' ? text : '';
  const draft = typeof text === 'string' ? text : '';
  if (!raw.trim()) return { status: 400, error: T.EMPTY, draft };
  if (raw.length > MAX_LEN) return { status: 422, error: T.TOO_LONG(MAX_LEN), draft };
  if (rateLimited(user.id)) return { status: 429, error: T.RATE, draft };

  let thread;
  if (threadId) {
    thread = threads.getThread(user.id, threadId, 'clinician');
    if (!thread) return { status: 404, error: T.NOT_FOUND, draft };
  } else {
    const c = createThread(user);
    if (c.error) return { status: c.status, error: c.error, draft };
    thread = c.thread;
  }
  const period = sc && sc.period && scenarios.period(periodDays) ? scenarios.period(periodDays).days : null;
  const first = db.prepare('SELECT COUNT(*) AS n FROM ai_messages WHERE thread_id = ?').get(thread.id).n === 0;
  const body = raw.trim();
  const userMsg = threads.addMessage(thread.id, {
    role: 'user', text: sc && period ? `${body} (${scenarios.period(period).label})` : body, intent: sc ? sc.key : null, flags: period ? { period } : null,
  });
  if (first) {
    // D23: названия сценариев различимы: «Сводка к приёму · Иванова, 10.10» (фамилия и дата, без других ПД)
    let titleText = body;
    if (sc && thread.patient_id) {
      const pu = db.prepare('SELECT full_name FROM users WHERE id = ?').get(thread.patient_id);
      const d = new Date();
      const dd = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
      titleText = `${sc.title} · ${pu ? String(pu.full_name).split(/\s+/)[0] + ', ' : ''}${dd}`;
    }
    thread.title = threads.applyAutoTitle(thread, titleText);
  }
  audit({ user, threadId: thread.id, event: 'ws_message', patientId: thread.patient_id || null });

  const r = await runProvider({ user, thread, scenarioKey: sc ? sc.key : null, periodDays: period });
  const extras = await renderExtras(base, r.assistant);
  return { status: 200, thread, user: userMsg, assistant: r.assistant, unavailable: r.unavailable, extras };
}

/** «Повторить» после ошибки провайдера: тот же вопрос/сценарий, файлы на месте. */
async function retryLast({ user, base, threadId }) {
  const thread = threads.getThread(user.id, threadId, 'clinician');
  if (!thread) return { status: 404, error: T.NOT_FOUND };
  if (rateLimited(user.id)) return { status: 429, error: T.RATE };
  const msgs = threads.listMessages(thread.id);
  const last = msgs[msgs.length - 1];
  if (!last || last.kind !== 'error') return { status: 200, thread };
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  db.prepare('DELETE FROM ai_messages WHERE id = ?').run(last.id);
  const period = lastUser ? (parseFlags(lastUser).period || null) : null;
  const r = await runProvider({ user, thread, scenarioKey: lastUser && scenarios.get(lastUser.intent) ? lastUser.intent : null, periodDays: period });
  return { status: 200, thread, assistant: r.assistant, unavailable: r.unavailable, extras: await renderExtras(base, r.assistant) };
}

module.exports = {
  MAX_LEN, RATE_LIMIT, MAX_THREADS, CONTEXT_CHARS, T, createThread, bindThread, deleteThreadFully, sendMessage, retryLast,
  audit, phi, sourcesOf, parseFlags, resetRateLimit, countThreads,
};
