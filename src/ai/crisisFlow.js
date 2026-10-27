'use strict';

/**
 * Кризисный разговор в чате пациента: открытие треда режима `crisis` и ход разговора.
 *
 * Вызывается из src/ai/patientEndpoints.js (кризисная фраза в чате или сигнал модели raise_crisis_signal, тред режима crisis) и из кнопки
 * POST /api/v1/crisis/help (src/server.js). Сигнал врачу к этому моменту уже создан кодом (crisisGate / recordCrisis).
 *  - Первый ход детерминирован: сценарное сообщение, модель не вызывается (REQ-AIP-006/007, F-16).
 *  - Дальше, если есть согласие на ИИ, отвечает модель с инструментом assess_crisis (src/ai/crisisMode.js);
 *    при любом сбое, лимите, фильтре или пустом ответе — сценарий.
 *  - Тяжёлая оценка поднимает сигнал и добавляет к ответу «звони 112» из кода.
 */

const crisisMode = require('./crisisMode');
const crisisGate = require('./crisisGate');
const { stripMarkers } = require('./workspace/sources');

const THREAD_TITLE = 'Трудный момент';
// Пока сигнал не обработан врачом, кризисный разговор остаётся режимом чата; без новых сообщений он сам гаснет через сутки
// (то же окно, в котором новые кризисные фразы дополняют открытый сигнал, recordCrisis в src/server.js).
const ACTIVE_WINDOW_MS = 24 * 3600 * 1000;
// Соседние сообщения, сказанные подряд («не хочу» / «жить»), проверяются вместе.
const JOIN_WINDOW_MS = 10 * 60 * 1000;
const JOIN_MESSAGES = 2;
const isoOf = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

function createCrisisFlow(h) {
  const { db, pii, gateway, now } = h;

  function findThread(userId, escalationId) {
    return db
      .prepare(
        "SELECT * FROM ai_threads WHERE owner_user_id=? AND mode='crisis' AND crisis_escalation_id=? AND hidden_at IS NULL ORDER BY id DESC LIMIT 1",
      )
      .get(userId, escalationId);
  }

  /** Открытый кризисный тред пациента (сигнал не обработан, разговор шёл в последние сутки) или undefined. */
  function activeThread(userId) {
    const since = isoOf(new Date(now(h.config).getTime() - ACTIVE_WINDOW_MS));
    return db
      .prepare(
        "SELECT t.* FROM ai_threads t JOIN crisis_escalations e ON e.id=t.crisis_escalation_id WHERE t.owner_user_id=? AND t.mode='crisis' AND t.hidden_at IS NULL AND e.status IN ('new','in_work') AND t.updated_at>=? ORDER BY t.id DESC LIMIT 1",
      )
      .get(userId, since);
  }

  /** Недавние сообщения пациента из обычных тредов чата (до текущего), чтобы поймать фразу, разбитую на части. */
  function recentUserText(userId) {
    const since = isoOf(new Date(now(h.config).getTime() - JOIN_WINDOW_MS));
    return db
      .prepare(
        "SELECT m.text FROM ai_messages m JOIN ai_threads t ON t.id=m.thread_id WHERE t.owner_user_id=? AND t.purpose='patient_assistant' AND t.mode IS NOT 'crisis' AND m.role='user' AND m.kind NOT IN ('error','crisis') AND m.created_at>=? ORDER BY m.id DESC LIMIT ?",
      )
      .all(userId, since, JOIN_MESSAGES)
      .reverse()
      .map((r) => r.text)
      .join(' ');
  }

  async function pseudonymized(text, scope) {
    const ner = await pii.nerDetect(text);
    return pii.pseudonymize(text, scope, { nerEntities: ner.entities, nerOk: ner.ok });
  }

  function view(thread) {
    return {
      id: thread.id,
      escalation_id: thread.crisis_escalation_id,
      has_clinician: crisisGate.hasClinician(thread.owner_user_id),
      ...(crisisMode.statusOf(db, thread.crisis_escalation_id) || {}),
    };
  }

  /**
   * Открывает кризисный тред по сигналу (или возвращает открытый) и кладёт в него сценарное первое сообщение.
   * text — фраза пациента, если она была (кнопка без текста её не имеет).
   */
  async function open({ user, escalationId, delivered = true, text = '', adopt = null }) {
    const scope = { scopeType: 'patient', scopeId: user.id };
    let thread = escalationId ? findThread(user.id, escalationId) : null;
    let created = false;
    let adopted = false;
    if (!thread) {
      // Кризис распознала модель посреди обычного разговора: тред становится кризисным, а не заводится новый
      // (реплика пациента в нём уже есть, модель продолжит с той же историей).
      adopted = Boolean(adopt && adopt.owner_user_id === user.id);
      thread = adopted
        ? adopt
        : h.createThread({ userId: user.id, role: 'patient', purpose: 'patient_assistant', patientId: user.id });
      db.prepare("UPDATE ai_threads SET mode='crisis', crisis_escalation_id=?, title=?, title_auto=0 WHERE id=?").run(
        escalationId || null,
        THREAD_TITLE,
        thread.id,
      );
      thread = db.prepare('SELECT * FROM ai_threads WHERE id=?').get(thread.id);
      created = true;
    }
    let message = null;
    if (created) {
      if (!adopted && String(text).trim()) {
        const pseudo = await pseudonymized(String(text), scope);
        h.addMessage(thread.id, { role: 'user', text: pseudo.text });
      }
      message = h.addMessage(thread.id, {
        role: 'assistant',
        text: crisisMode.openingText({ hasClinician: crisisGate.hasClinician(user.id), delivered }),
        flags: { crisis_script: 'opening' },
      });
    }
    return { thread, created, message, view: { ...view(thread), ...(adopted ? { adopted: true } : {}) } };
  }

  function scripted(thread, user, urgent) {
    const count = db
      .prepare("SELECT COUNT(*) n FROM ai_messages WHERE thread_id=? AND role='assistant'")
      .get(thread.id).n;
    let text = crisisMode.scriptedReply(count);
    if (urgent) text = `${crisisMode.URGENT_LINE} ${text}`;
    return h.addMessage(thread.id, { role: 'assistant', text, flags: { crisis_script: 'step' } });
  }

  /** Ход разговора в кризисном треде. Возвращает { message, shown, assessment }. */
  async function turn({ user, thread, text, onProgress = null }) {
    const scope = { scopeType: 'patient', scopeId: user.id };
    const pseudo = await pseudonymized(text, scope);
    const userMsg = h.addMessage(thread.id, { role: 'user', text: pseudo.text });
    let assessment = null;
    let message = null;
    if (h.consentAiGiven(user.id)) {
      // Оценку некуда записать, если сигнал не создан: тогда модель отвечает без инструмента.
      const tools = thread.crisis_escalation_id
        ? crisisMode.createTools({
            db,
            escalationId: thread.crisis_escalation_id,
            patientId: user.id,
            threadId: thread.id,
            now: () => now(h.config),
            onAssessed: (a) => {
              assessment = a;
            },
          })
        : null;
      try {
        const out = await gateway.run({
          purpose: 'patient_assistant',
          promptKey: 'task.patient_crisis',
          user,
          patientId: user.id,
          threadId: thread.id,
          text: pseudo.text,
          history: h.historyFor(thread.id, userMsg.id),
          piiCounts: pseudo.counts,
          piiMode: pseudo.mode,
          crisis: true,
          ...(onProgress ? { onProgress } : {}),
          ...(tools ? { tools } : {}),
        });
        const reply = stripMarkers(String(out.text || '')).trim(); // служебные метки источников [0] пациенту не нужны
        if (reply && out.status !== 'filtered' && !crisisMode.isProviderRefusal(reply)) {
          const urgent = crisisMode.isUrgent(assessment);
          const prior = db
            .prepare("SELECT text FROM ai_messages WHERE thread_id=? AND role='assistant' ORDER BY id DESC")
            .all(thread.id);
          let body = urgent
            ? reply
            : crisisMode.withoutRepeated112(
                reply,
                prior.slice(0, 2).map((r) => r.text),
              );
          body = crisisMode.withClarifyingQuestion(
            body,
            prior.length,
            assessment && assessment.level,
            prior.some((r) => crisisMode.hasClarifyingQuestion(r.text)),
          );
          message = h.addMessage(thread.id, {
            role: 'assistant',
            text: urgent && !crisisMode.mentionsEmergency(body) ? `${body}\n\n${crisisMode.URGENT_LINE}` : body,
            aiGenerated: 1,
            modelId: out.model.id,
            bindingVersion: out.bindingVersion,
            promptVersion: out.promptVersion,
            flags: { provider: out.model.adapter, crisis_mode: true },
          });
        }
      } catch (e) {
        if (!h.isGatewayError(e)) throw e; // сбой модели разговор не рвёт: ниже сценарий
      }
    }
    if (!message) message = scripted(thread, user, crisisMode.isUrgent(assessment));
    const shown = pii.reveal(message.text, scope);
    return { message, shown, assessment };
  }

  return { open, turn, findThread, view, activeThread, recentUserText };
}

module.exports = { createCrisisFlow, THREAD_TITLE };
