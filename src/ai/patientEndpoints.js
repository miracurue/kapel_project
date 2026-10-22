'use strict';

/**
 * Маршруты серверной части ИИ-помощника пациента (F-27) и тредов (F-28).
 * Вызывается из src/ai/patientApi.js после подготовки шлюза, F-80 и реестра.
 */

const MAX_TEXT_LEN = 2000;

// S-31: словарь признаков НЯ (F-30). Значение по умолчанию — код-запас, review-required:
// клинический владелец утверждает и меняет словарь настройкой ae.detect_dictionary,
// новое значение действует со следующего сообщения (перечитать настройки при каждом вызове).
const DEFAULT_AE_DICTIONARY = [
  { phrase: 'тошнит', category: 'nausea' },
  { phrase: 'тошнота', category: 'nausea' },
  { phrase: 'рвота', category: 'vomiting' },
  { phrase: 'головокружение', category: 'dizziness' },
  { phrase: 'кружится голова', category: 'dizziness' },
  { phrase: 'головная боль', category: 'headache' },
  { phrase: 'зуд', category: 'skin' },
  { phrase: 'сыпь', category: 'skin' },
  { phrase: 'побочный эффект', category: 'other' },
];
// Жалоба, похожая на НЯ, при которой словарь не сработал: запасной путь — модель ae_extraction.
const AE_TRIGGER_RE = /тошнит|тошнота|головокруж|кружится голова|зуд|сыпь|рвот|побочн|диаре|понос|головная боль/i;

function isoWeekOf(iso) {
  const d = new Date(iso);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

module.exports = function registerEndpoints(app, h) {
  const { db, P, idemCached, saveIdem, crisis, pii, gateway, activeSetting } = h;

  // Кеш идемпотентности хранит только ссылки (PD-17/L-46, канарейка T-312: тексты
  // пользователя и ИИ в таблице idempotency_keys недопустимы). Полный ответ
  // восстанавливается из базы при повторе с тем же ключом.
  function rebuildAiReply(ref, user) {
    if (!ref || !ref.__ai_reply) return null;
    const t = db
      .prepare('SELECT * FROM ai_threads WHERE id=? AND owner_user_id=?')
      .get(Number(ref.__ai_reply.thread_id), user.id);
    if (!t) return null;
    const m = db
      .prepare('SELECT * FROM ai_messages WHERE id=? AND thread_id=?')
      .get(Number(ref.__ai_reply.reply_id), t.id);
    if (!m) return null;
    const scope = h.scopeFor(t, user.id);
    const shown = pii.reveal(m.text, scope);
    return { thread: h.threadView(t), reply: h.replyView(m, shown.text), warnings: h.warningsOf(shown.warnings) };
  }

  // ------------------------------------------------------------------
  // F-30: предложение оформить побочный эффект. Ничего врачу само не
  // отправляется — только подсказка пациенту с предзаполнением формы НЯ.
  // Сначала словарь S-31, если не сработал и жалоба похожа на НЯ — модель
  // ae_extraction через шлюз (запасной путь); сбой извлечения ответ не ломает.
  // ------------------------------------------------------------------
  function aeDictionary() {
    const value = activeSetting ? activeSetting('ae.detect_dictionary').value : null;
    return Array.isArray(value) && value.length ? value : DEFAULT_AE_DICTIONARY;
  }

  function aeSuggestion(parts) {
    return {
      prefill: {
        symptoms: Array.isArray(parts.symptoms) ? parts.symptoms.filter(Boolean).slice(0, 5) : [],
        severity: parts.severity === undefined || parts.severity === null ? null : parts.severity,
        related: parts.related || 'unknown',
        med: parts.med || null,
      },
    };
  }

  function aeFromDictionary(text) {
    const lower = String(text).toLowerCase();
    const hit = aeDictionary().find((e) => e && e.phrase && lower.includes(String(e.phrase).toLowerCase()));
    return hit ? aeSuggestion({ symptoms: [hit.category || hit.phrase] }) : null;
  }

  async function aeFromModel(text, user, threadId) {
    try {
      const out = await gateway.run({
        purpose: 'ae_extraction',
        user,
        patientId: user.id,
        threadId: threadId || null,
        text,
      });
      if (out.tool && out.tool.name === 'report_adverse_event') return aeSuggestion(out.tool.arguments || {});
    } catch (e) {
      if (h.isGatewayError(e)) return null; // извлечение необязательно: сбой модели не влияет на ответ
      throw e;
    }
    return null;
  }

  async function detectAe(text, user, threadId) {
    const fromDictionary = aeFromDictionary(text);
    if (fromDictionary) return fromDictionary;
    if (!AE_TRIGGER_RE.test(text)) return null;
    return aeFromModel(text, user, threadId);
  }

  // ------------------------------------------------------------------
  // F-27: вопрос пациентскому ИИ-помощнику
  // ------------------------------------------------------------------
  app.post('/api/v1/ai/patient/messages', async (req, res) => {
    const user = req.user;
    const text = String((req.body && req.body.text) || '');
    // Кризисная проверка ДО согласий, лимитов и ИИ; при кризисе модель не вызывается (F-16).
    const crisisCard = crisis(text, 'ai_chat', user.id);
    if (crisisCard) return res.json({ crisis: crisisCard, reply: { status: 'crisis' } });
    if (!text.trim()) {
      return P.sendError(req, res, 422, 'E-VALIDATION', {
        fields: [{ field: 'text', key: 'err.e-validation.empty_message' }],
      });
    }
    if (text.length > MAX_TEXT_LEN) {
      return P.sendError(req, res, 422, 'E-VALIDATION', {
        fields: [{ field: 'text', key: 'err.e-validation.too_long' }],
      });
    }
    // Согласие на ИИ (PD-09): отключено — помощник пациента недоступен; ИИ специалиста это не касается.
    if (!h.consentAiGiven(user.id)) return P.sendError(req, res, 403, 'E-CONSENT-AI');
    const state = idemCached(req, user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) {
      const rebuilt = rebuildAiReply(state.cached, user);
      if (rebuilt) return res.json(rebuilt);
    }

    const uploadIds = Array.isArray(req.body.upload_ids) ? req.body.upload_ids.map(Number) : [];
    const validUploads = () =>
      uploadIds.length <= 5 &&
      new Set(uploadIds).size === uploadIds.length &&
      uploadIds.every((id) =>
        db
          .prepare("SELECT 1 FROM stored_files WHERE id=? AND owner_user_id=? AND status='temp' AND expires_at>?")
          .get(id, user.id, h.nowIso()),
      );
    if (!validUploads()) return P.sendError(req, res, 422, 'E-VALIDATION');

    let thread;
    const threadId = Number(req.body && req.body.thread_id) || null;
    if (threadId) {
      thread = h.getOwnThread(user.id, threadId, 'patient_assistant');
      if (!thread) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    } else {
      thread = h.createThread({ userId: user.id, role: 'patient', purpose: 'patient_assistant', patientId: user.id });
    }

    const scope = { scopeType: 'patient', scopeId: user.id };
    let userMsg = null;
    try {
      gateway.limits.check('patient_assistant', user.id); // S-14; кризисный путь выше лимитов не идёт
      // F-80 перед моделью: NER (наш ml-worker) + правила; NER недоступен — «только правила».
      const ner = await pii.nerDetect(text);
      const pseudo = pii.pseudonymize(text, scope, { nerEntities: ner.entities, nerOk: ner.ok });
      userMsg = h.addMessage(thread.id, { role: 'user', text: pseudo.text });
      h.autoTitle(thread.id, pseudo.text);
      const out = await gateway.run({
        purpose: 'patient_assistant',
        user,
        patientId: user.id,
        threadId: thread.id,
        text: pseudo.text,
        history: h.historyFor(thread.id, userMsg.id),
        piiCounts: pseudo.counts,
        piiMode: pseudo.mode,
      });
      const asMsg = h.addMessage(thread.id, {
        role: 'assistant',
        text: out.text,
        kind: out.status === 'filtered' ? 'filtered' : 'normal',
        aiGenerated: 1,
        modelId: out.model.id,
        bindingVersion: out.bindingVersion,
        promptVersion: out.promptVersion,
        flags: { provider: out.model.adapter },
      });
      const shown = pii.reveal(asMsg.text, scope);
      const fresh = db.prepare('SELECT * FROM ai_threads WHERE id=?').get(thread.id);
      const response = {
        thread: h.threadView(fresh),
        reply: h.replyView(asMsg, shown.text),
        warnings: h.warningsOf(shown.warnings),
      };
      // F-30: жалоба на переносимость → мягкое предложение с предзаполнением; врачу само не уходит.
      try {
        const ae = await detectAe(pseudo.text, user, thread.id);
        if (ae) response.ae_suggestion = ae;
      } catch (_) {
        // извлечение НЯ — необязательный шаг
      }
      db.transaction(() => {
        if (!validUploads()) throw Object.assign(new Error('E-VALIDATION'), { code: 'E-VALIDATION' });
        for (const id of uploadIds)
          db.prepare(
            "UPDATE stored_files SET purpose='ai_attachment',linked_type='ai_message',linked_id=?,patient_id=?,status='linked',expires_at=NULL WHERE id=?",
          ).run(userMsg.id, user.id, id);
        saveIdem(user.id, state, { __ai_reply: { thread_id: thread.id, reply_id: asMsg.id } });
      }).immediate();
      return res.status(201).json(response);
    } catch (e) {
      // Сбой модели ввод не теряет: сообщение остаётся со статусом error, ответ — «Повторить» (T-108).
      if (userMsg) db.prepare("UPDATE ai_messages SET kind='error' WHERE id=?").run(userMsg.id);
      if (e.code === 'E-VALIDATION') return P.sendError(req, res, 422, 'E-VALIDATION');
      if (h.isGatewayError(e)) return h.sendGatewayError(res, e);
      throw e;
    }
  });

  // ------------------------------------------------------------------
  // F-28: история ИИ-чатов (только свои треды)
  // ------------------------------------------------------------------
  app.get('/api/v1/ai/threads', (req, res) => {
    const purpose = req.query.purpose ? String(req.query.purpose) : null;
    const rows = purpose
      ? db
          .prepare(
            'SELECT * FROM ai_threads WHERE owner_user_id=? AND purpose=? AND hidden_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT 50',
          )
          .all(req.user.id, purpose)
      : db
          .prepare(
            'SELECT * FROM ai_threads WHERE owner_user_id=? AND hidden_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT 50',
          )
          .all(req.user.id);
    res.json({ items: rows.map(h.threadView), page: 1, page_size: 50, total: rows.length });
  });

  app.get('/api/v1/ai/threads/:thread_id', (req, res) => {
    const thread = h.getOwnThread(req.user.id, req.params.thread_id);
    if (!thread) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const scope = h.scopeFor(thread, req.user.id);
    const warnings = [];
    const messages = db
      .prepare('SELECT * FROM ai_messages WHERE thread_id=? ORDER BY id')
      .all(thread.id)
      .map((m) => {
        const shown = pii.reveal(m.text, scope);
        warnings.push(...shown.warnings);
        return {
          id: m.id,
          author: m.role,
          role: m.role,
          text: shown.text,
          status: m.kind === 'normal' ? 'normal' : m.kind,
          kind: m.kind,
          ai_generated: Boolean(m.ai_generated),
          model_id: m.model_id || null,
          created_at: m.created_at,
        };
      });
    res.json({ thread: h.threadView(thread), messages, warnings: h.warningsOf(warnings) });
  });

  app.patch('/api/v1/ai/threads/:thread_id', (req, res) => {
    const thread = h.getOwnThread(req.user.id, req.params.thread_id);
    if (!thread) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const title = String((req.body && req.body.title) || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title || title.length > 80) {
      return P.sendError(req, res, 422, 'E-VALIDATION', {
        fields: [{ field: 'title', key: 'err.e-validation.required' }],
      });
    }
    db.prepare('UPDATE ai_threads SET title=?, title_auto=0, updated_at=? WHERE id=?').run(
      title,
      h.nowIso(),
      thread.id,
    );
    res.json({ thread: h.threadView(db.prepare('SELECT * FROM ai_threads WHERE id=?').get(thread.id)) });
  });

  // Стирание треда — мягкое с «Отменить» (F-17); физическое стирание делает планировщик (S-23).
  app.delete('/api/v1/ai/threads/:thread_id', (req, res) => {
    const thread = h.getOwnThread(req.user.id, req.params.thread_id);
    if (!thread) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    db.prepare('UPDATE ai_threads SET hidden_at=?, updated_at=? WHERE id=?').run(h.nowIso(), h.nowIso(), thread.id);
    db.prepare('INSERT INTO action_log(actor_id,actor_role,action,target_type,target_id) VALUES (?,?,?,?,?)').run(
      req.user.id,
      req.user.role,
      'ai.thread.hidden',
      'ai_thread',
      String(thread.id),
    );
    const undo = h.makeUndo(req.user.id, 'ai.thread.delete', 'ai_thread', thread.id);
    res.json({ ok: true, undo });
  });

  // «Повторить» после сбоя модели: ввод не потерян (kind='error'), ответ запрашивается заново.
  app.post('/api/v1/ai/messages/:message_id/retry', async (req, res) => {
    const user = req.user;
    const messageId = Number(req.params.message_id);
    const msg = Number.isInteger(messageId)
      ? db
          .prepare(
            'SELECT m.*, t.owner_user_id, t.id AS thread_id_ref FROM ai_messages m JOIN ai_threads t ON t.id=m.thread_id WHERE m.id=?',
          )
          .get(messageId)
      : null;
    if (!msg || msg.owner_user_id !== user.id || msg.role !== 'user') return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const thread = h.getOwnThread(user.id, msg.thread_id_ref);
    if (!thread) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (thread.purpose === 'patient_assistant' && !h.consentAiGiven(user.id))
      return P.sendError(req, res, 403, 'E-CONSENT-AI');
    const state = idemCached(req, user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) {
      const rebuilt = rebuildAiReply(state.cached, user);
      if (rebuilt) return res.json(rebuilt);
    }

    if (msg.kind !== 'error') {
      const last = db
        .prepare("SELECT * FROM ai_messages WHERE thread_id=? AND role='assistant' ORDER BY id DESC LIMIT 1")
        .get(thread.id);
      if (!last) return P.sendError(req, res, 422, 'E-VALIDATION');
      const shown = pii.reveal(last.text, h.scopeFor(thread, user.id));
      return res.json({
        thread: h.threadView(thread),
        reply: h.replyView(last, shown.text),
        warnings: h.warningsOf(shown.warnings),
      });
    }

    const scope = h.scopeFor(thread, user.id);
    try {
      gateway.limits.check(thread.purpose, user.id);
      const out = await gateway.run({
        purpose: thread.purpose,
        user,
        patientId: thread.patient_id || null,
        threadId: thread.id,
        text: msg.text,
        history: h.historyFor(thread.id, msg.id),
      });
      db.prepare('UPDATE ai_messages SET kind=? WHERE id=?').run('normal', msg.id);
      const asMsg = h.addMessage(thread.id, {
        role: 'assistant',
        text: out.text,
        kind: out.status === 'filtered' ? 'filtered' : 'normal',
        aiGenerated: 1,
        modelId: out.model.id,
        bindingVersion: out.bindingVersion,
        promptVersion: out.promptVersion,
        flags: { provider: out.model.adapter },
      });
      const shown = pii.reveal(asMsg.text, scope);
      const response = {
        thread: h.threadView(db.prepare('SELECT * FROM ai_threads WHERE id=?').get(thread.id)),
        reply: h.replyView(asMsg, shown.text),
        warnings: h.warningsOf(shown.warnings),
      };
      db.transaction(() => {
        saveIdem(user.id, state, { __ai_reply: { thread_id: thread.id, reply_id: asMsg.id } });
      }).immediate();
      return res.status(201).json(response);
    } catch (e) {
      if (h.isGatewayError(e)) return h.sendGatewayError(res, e);
      throw e;
    }
  });

  // ------------------------------------------------------------------
  // F-31: оценка ответа ИИ (👍/👎). Одна оценка на ответ и пользователя —
  // повтор заменяет (PK message_id, user_id); хранится без текста диалога (PD-17).
  // ------------------------------------------------------------------
  app.post('/api/v1/ai/messages/:message_id/rating', (req, res) => {
    const user = req.user;
    const messageId = Number(req.params.message_id);
    const msg = Number.isInteger(messageId)
      ? db
          .prepare(
            'SELECT m.*, t.owner_user_id, t.purpose AS thread_purpose FROM ai_messages m JOIN ai_threads t ON t.id=m.thread_id WHERE m.id=?',
          )
          .get(messageId)
      : null;
    if (!msg || msg.owner_user_id !== user.id || msg.role !== 'assistant')
      return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const useful = req.body ? req.body.useful : undefined;
    if (typeof useful !== 'boolean') {
      return P.sendError(req, res, 422, 'E-VALIDATION', {
        fields: [{ field: 'useful', key: 'err.e-validation.required' }],
      });
    }
    const reason = req.body.reason === undefined || req.body.reason === null ? null : String(req.body.reason);
    if (reason && !['wrong', 'unclear', 'off_topic', 'other'].includes(reason)) {
      return P.sendError(req, res, 422, 'E-VALIDATION', {
        fields: [{ field: 'reason', key: 'err.e-validation.required' }],
      });
    }
    const state = idemCached(req, user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) return res.json(state.cached);
    const rating = useful ? 'useful' : 'not_useful';
    db.prepare(
      'INSERT INTO ai_ratings(message_id,user_id,role,purpose,model_id,prompt_version,rating,reason,week,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET rating=excluded.rating, reason=excluded.reason, updated_at=excluded.updated_at',
    ).run(
      msg.id,
      user.id,
      msg.role,
      msg.thread_purpose,
      msg.model_id || null,
      msg.prompt_version || null,
      rating,
      reason,
      isoWeekOf(h.nowIso()),
      h.nowIso(),
    );
    const response = { ok: true, rating };
    saveIdem(user.id, state, response);
    return res.json(response);
  });

  // ------------------------------------------------------------------
  // F-32: носитель POST /api/v1/ai/clinician/messages перенесён и развит в
  // src/ai/workspace/clinicianApi.js (W-35: чат с контекстом F-13, черновики F-33,
  // гипотезы F-34, экспорт треда). Здесь осталась серверная часть помощника
  // пациента (F-27/F-28/F-30/F-31) и треды.
  // ------------------------------------------------------------------
};
