'use strict';

/**
 * Серверная часть ИИ специалиста (W-35): чат с выбранным закреплённым пациентом (F-32),
 * черновик документа от ИИ (F-33) с экспортом, диагностические гипотезы (F-34),
 * экспорт треда. Перенесено из src/ai/patientEndpoints.js (носитель T-031) и развито.
 *
 * Права маршрутов объявлены в замороженном контракте (src/access → operations.json):
 * сессия, CSRF, роль и чужой пациент проверяются контрактным middleware до этих
 * обработчиков. ИИ вызывается только через src/ai/gateway.js; перед шлюзом —
 * псевдонимизация F-80 (в базе, модели и журналах — только ключи #ТИП-N#).
 * Журналы — без текстов и значений (PD-17); чтение контекста — в phi_access_log.
 */

const express = require('express');

const chipsMod = require('../../modules/context/chips');
const exporter = require('./export');
const docDraft = require('./docDraft');
const hintsSchema = require('./hintsSchema');
const { buildContext } = require('./clinicianContext');
// W-49: заключения психолога (conclusions/conclusion_versions) обслуживает модуль
// documents; делегирование — по требованию в момент запроса (модуль монтируется позже).
const docsApi = require('../../modules/documents/routes');

const DOC_TYPES = new Set([
  'visit_summary',
  'mis_summary',
  'dynamics',
  'exam_protocol',
  'consult_request',
  'crisis_record',
  'memo',
  'final_summary',
  'conclusion',
]);

const HINT_MARKS = new Set(['accepted', 'edited', 'rejected', 'noted']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function install(app, h) {
  const { db, P, config, pii, gateway, idemCached, saveIdem } = h;
  const router = express.Router();
  app.use(router);

  function mergeCounts(target, source) {
    for (const [k, v] of Object.entries(source || {})) target[k] = (target[k] || 0) + v;
  }

  function scopeOfPatient(patientId) {
    return { scopeType: 'patient', scopeId: patientId };
  }

  // Кеш идемпотентности хранит только ссылки (PD-17/L-46, канарейка T-312: тексты
  // пациента и ИИ в таблице idempotency_keys недопустимы). Полные ответы
  // восстанавливаются из базы при повторе с тем же ключом.
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

  function rebuildDraftResponse(ref) {
    if (!ref || !ref.__doc_draft) return null;
    const doc = db.prepare('SELECT * FROM patient_documents WHERE id=?').get(Number(ref.__doc_draft.document_id));
    if (!doc) return null;
    const version = db
      .prepare(
        'SELECT * FROM patient_document_versions WHERE document_id=? AND version=? ORDER BY version DESC LIMIT 1',
      )
      .get(doc.id, Number(ref.__doc_draft.version) || 1);
    if (!version) return null;
    const scope = scopeOfPatient(doc.patient_id);
    let sections = [];
    let aiKeys = [];
    try {
      sections = (JSON.parse(version.sections_enc) || {}).sections || [];
      aiKeys = JSON.parse(version.ai_sections_json || '[]') || [];
    } catch (_) {
      sections = [];
    }
    return {
      id: doc.id,
      number: `${doc.doc_type}-${doc.created_at.slice(0, 4)}-${String(doc.id).padStart(4, '0')}`,
      doc_type: doc.doc_type,
      status: 'draft',
      version: version.version,
      period: { from: doc.period_from, to: doc.period_to },
      ai_generated: Boolean(ref.ai_generated),
      sections: sections.map((s) => ({
        key: s.key,
        title: s.title,
        text: docDraft.renderText(pii, db, scope, s.text),
        ai: Boolean(s.ai) || aiKeys.includes(s.key),
      })),
      unknown_keys: docDraft.unknownKeys(
        db,
        scope,
        sections.map((s) => s.text),
      ).length,
      warnings: h.warningsOf(Array.isArray(ref.warning_codes) ? ref.warning_codes : []),
    };
  }

  function rebuildHintsResponse(ref, user) {
    if (!ref || !ref.__hints) return null;
    const row = db
      .prepare('SELECT * FROM hint_drafts WHERE id=? AND clinician_id=?')
      .get(Number(ref.__hints.hint_id), user.id);
    if (!row) return null;
    const scope = scopeOfPatient(row.patient_id);
    let hypotheses = [];
    try {
      hypotheses = (JSON.parse(pii.reveal(row.hypotheses_enc, scope).text || '{}') || {}).hypotheses || [];
    } catch (_) {
      hypotheses = [];
    }
    return {
      id: row.id,
      ai_generated: true,
      expert_review: true,
      review_note_key: 'msg.ai.hints.mark',
      hypotheses,
      warnings: h.warningsOf(Array.isArray(ref.warning_codes) ? ref.warning_codes : []),
    };
  }

  /** Контекст чипов, псевдонимизированный для модели (F-13 + F-80). */
  async function contextForModel({ req, user, patientId, chips, scope, counts }) {
    const ctx = buildContext({ db, pii, scope, patientId, chips, req, user });
    let pseudoCtx = '';
    if (ctx.rawText) {
      const nerCtx = await pii.nerDetect(ctx.rawText);
      const p = pii.pseudonymize(ctx.rawText, scope, { nerEntities: nerCtx.entities, nerOk: nerCtx.ok });
      pseudoCtx = p.text;
      mergeCounts(counts, p.counts);
    }
    const parts = [];
    if (ctx.patientLine) parts.push(ctx.patientLine);
    if (pseudoCtx) parts.push(`Данные пациента:\n${pseudoCtx}`);
    return { text: parts.join('\n'), refs: ctx.refs };
  }

  // ------------------------------------------------------------------
  // F-32 (W-35): ИИ-чат специалиста с выбранным закреплённым пациентом.
  // До выбора пациента подсказок нет; «@» — только закреплённые (клиент);
  // чип незакреплённого пациента — отказ без вызова модели; ИИ-согласие
  // пациента для ИИ специалиста не нужно (решение владельца 2026-10-16).
  // Без чипов модель знает только #PERSON-1#; ответ показывается врачу
  // с подставленным именем (F-80) и пометкой ИИ.
  // ------------------------------------------------------------------
  app.post('/api/v1/ai/clinician/messages', async (req, res) => {
    const user = req.user;
    const text = String((req.body && req.body.text) || '');
    if (!text.trim()) {
      return P.sendError(req, res, 422, 'E-VALIDATION', {
        fields: [{ field: 'text', key: 'err.e-validation.empty_message' }],
      });
    }
    const chips = Array.isArray(req.body && req.body.chips) ? req.body.chips : [];
    if (chips.length > 5) return P.sendError(req, res, 422, 'E-VALIDATION');
    // Чипы проверены middleware композера (req.composerChips); если его не было — проверяем здесь.
    const allowed = Array.isArray(req.composerChips)
      ? req.composerChips
      : chipsMod.validateChips(db, req, user, chips, null).allowed;
    let patientId = Number(req.body && req.body.patient_id) || null;
    for (const chip of allowed) {
      if (chip.type !== 'patient') continue;
      const pid = Number(chip.id);
      if (patientId && patientId !== pid) return P.sendError(req, res, 422, 'E-VALIDATION');
      patientId = pid;
    }
    if (patientId) {
      // Чип незакреплённого пациента — отказ без вызова модели (T-131).
      const own = db
        .prepare('SELECT 1 FROM care_assignments WHERE patient_id=? AND clinician_id=? AND ended_at IS NULL')
        .get(patientId, user.id);
      if (!own) return P.sendError(req, res, 404, 'E-NOT-FOUND');
      if (
        !db
          .prepare("SELECT 1 FROM consent_current WHERE user_id=? AND consent_kind='base' AND action='given'")
          .get(patientId)
      )
        return P.sendError(req, res, 403, 'E-CONSENT-REQUIRED');
    }
    const state = idemCached(req, user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) {
      const rebuilt = rebuildAiReply(state.cached, user);
      if (rebuilt) return res.json(rebuilt);
    }

    let thread = patientId
      ? db
          .prepare(
            "SELECT * FROM ai_threads WHERE owner_user_id=? AND purpose='clinician_chat' AND patient_id=? AND hidden_at IS NULL ORDER BY id DESC LIMIT 1",
          )
          .get(user.id, patientId)
      : db
          .prepare(
            "SELECT * FROM ai_threads WHERE owner_user_id=? AND purpose='clinician_chat' AND patient_id IS NULL AND hidden_at IS NULL ORDER BY id DESC LIMIT 1",
          )
          .get(user.id);
    if (!thread) thread = h.createThread({ userId: user.id, role: user.role, purpose: 'clinician_chat', patientId });

    const scope = h.scopeFor(thread, user.id);
    let userMsg = null;
    try {
      gateway.limits.check('clinician_chat', user.id);
      const counts = {};
      const ctx = await contextForModel({ req, user, patientId, chips: allowed, scope, counts });
      const ner = await pii.nerDetect(text);
      const pseudo = pii.pseudonymize(text, scope, { nerEntities: ner.entities, nerOk: ner.ok });
      mergeCounts(counts, pseudo.counts);
      userMsg = h.addMessage(thread.id, { role: 'user', text: pseudo.text });
      h.autoTitle(thread.id, pseudo.text);
      const modelText = [ctx.text, pseudo.text ? `Сообщение врача: ${pseudo.text}` : ''].filter(Boolean).join('\n');
      const out = await gateway.run({
        purpose: 'clinician_chat',
        user,
        patientId: thread.patient_id || null,
        threadId: thread.id,
        text: modelText,
        history: h.historyFor(thread.id, userMsg.id),
        piiCounts: counts,
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
      const response = {
        thread: h.threadView(db.prepare('SELECT * FROM ai_threads WHERE id=?').get(thread.id)),
        reply: h.replyView(asMsg, shown.text),
        warnings: h.warningsOf(shown.warnings),
      };
      saveIdem(user.id, state, { __ai_reply: { thread_id: thread.id, reply_id: asMsg.id } });
      return res.status(201).json(response);
    } catch (e) {
      if (userMsg) db.prepare("UPDATE ai_messages SET kind='error' WHERE id=?").run(userMsg.id);
      if (h.isGatewayError(e)) return h.sendGatewayError(res, e);
      throw e;
    }
  });

  // ------------------------------------------------------------------
  // Экспорт треда специалиста (TXT по умолчанию; F-28/PD-11): доступен только
  // владельцу; после открепления пациента тред недоступен (T-133) — 404.
  // Каждый экспорт — в export_log без текстов (L-18).
  // ------------------------------------------------------------------
  app.get('/api/v1/ai/threads/:thread_id/export', (req, res) => {
    const user = req.user;
    const thread = h.getOwnThread(user.id, req.params.thread_id, 'clinician_chat');
    if (!thread) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const fmt = String(req.query.format || 'txt');
    const format = exporter.FORMATS[fmt];
    if (!format)
      return P.sendError(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'format', key: 'err.e-validation' }] });
    const scope = h.scopeFor(thread, user.id);
    const msgs = db
      .prepare(
        "SELECT * FROM ai_messages WHERE thread_id=? AND role IN ('user','assistant') AND kind NOT IN ('error') ORDER BY id",
      )
      .all(thread.id);
    const items = msgs.map((m) => ({
      who: m.role === 'assistant' ? 'ИИ-помощник · черновик, решение за врачом' : 'Врач',
      text: pii.reveal(m.text, scope).text,
    }));
    db.prepare(
      'INSERT INTO export_log(actor_id,kind,patient_id,row_count,recipient_class,created_at) VALUES (?,?,?,?,?,?)',
    ).run(user.id, 'ai_thread', thread.patient_id || null, items.length, 'clinician', h.nowIso());
    res.set({
      'Content-Type': format.mime,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="draft_${exporter.today()}.${fmt}"; filename*=UTF-8''${encodeURIComponent(exporter.fileName(fmt))}`,
    });
    return res.send(
      format.build(exporter.normalize({ title: 'ИИ-диалог специалиста (черновик)', date: exporter.today(), items })),
    );
  });

  // ------------------------------------------------------------------
  // F-33 (W-35): черновик документа от ИИ. Разделы — из записей пациента за
  // период; «нет данных» вместо выдумки; ИИ-текст — отдельным разделом с
  // пометкой, в базе — с ключами F-80. При таймауте/недоступности модели
  // черновик всё равно создаётся из данных, с предупреждением (T-135).
  // ------------------------------------------------------------------
  app.post('/api/v1/patients/:patient_id/documents', async (req, res) => {
    const user = req.user;
    const patientId = Number(req.params.patient_id);
    const type = String((req.body && req.body.type) || '');
    if (!DOC_TYPES.has(type)) {
      return P.sendError(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'type', key: 'err.e-validation' }] });
    }
    if (type === 'conclusion' && user.role !== 'psychologist') return P.sendError(req, res, 403, 'E-ACCESS');
    // W-49: заключение психолога — отдельный жизненный цикл (подпись, выдача),
    // обслуживает модуль documents (conclusions/conclusion_versions).
    if (type === 'conclusion') {
      // Синхронные ошибки Sqlite внутри async-обработчика рушат процесс — оборачиваем.
      try {
        return docsApi.handlers().createConclusion(req, res);
      } catch (e) {
        return P.sendError(req, res, 500, 'E-INTERNAL');
      }
    }
    const period = (req.body && req.body.period) || {};
    const from = DATE_RE.test(String(period.from || '')) ? String(period.from) : '';
    const to = DATE_RE.test(String(period.to || '')) ? String(period.to) : '';
    const chips = Array.isArray(req.body && req.body.chips) ? req.body.chips : [];
    if (chips.length > 5) return P.sendError(req, res, 422, 'E-VALIDATION');
    const { rejected, allowed } = chipsMod.validateChips(db, req, user, chips, patientId);
    if (rejected.length)
      return P.sendError(req, res, 409, 'E-CONTEXT-REJECTED', { details: { rejected_chips: rejected } });
    const useAi = Boolean(req.body && req.body.use_ai);
    const state = idemCached(req, user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) {
      const rebuilt = rebuildDraftResponse(state.cached);
      if (rebuilt) return res.status(201).json(rebuilt);
    }

    const scope = scopeOfPatient(patientId);
    const counts = {};
    const built = docDraft.dataSections({
      user,
      db,
      pii,
      scope,
      patientId,
      period: { from, to },
      counts,
      isPsychiatrist: user.role === 'psychiatrist',
    });
    const chipRefs = allowed.filter((c) => c.type !== 'patient').map((c) => ({ type: c.type, id: Number(c.id) }));
    const warnings = [];
    let aiSections = [];
    if (useAi) {
      const dataText = built.sections.map((s) => `${s.title}:\n${s.text}`).join('\n\n');
      try {
        gateway.limits.check('document_draft', user.id);
        const out = await gateway.run({
          purpose: 'document_draft',
          user,
          patientId,
          threadId: null,
          text:
            `Составь черновик документа «${docDraft.docTitle(type)}» за период ${from || '…'} — ${to || '…'} ` +
            `строго по данным ниже; если данных нет — напиши «нет данных».\nДанные:\n${dataText}`,
          piiCounts: counts,
        });
        if (out.text && out.text.trim())
          aiSections = [{ key: 'ai_draft', title: 'Черновик ИИ', text: out.text, sources: [] }];
      } catch (e) {
        if (!h.isGatewayError(e)) throw e;
        // Черновик всё равно создаётся из данных, без связного текста (T-135).
        warnings.push(e.code === 'E-AI-TIMEOUT' ? 'E-AI-TIMEOUT' : 'E-AI-UNAVAILABLE');
      }
    }
    const sections = [
      ...built.sections.map((s) => ({ ...s, ai: false })),
      ...aiSections.map((s) => ({ ...s, ai: true })),
    ];
    const sources = [...built.refs, ...chipRefs];
    const t = h.nowIso();
    // W-49: единое пространство id patient_documents/conclusions (маршрут /documents/{id}).
    const docId = docsApi.nextDocIdFor(db);
    db.prepare(
      'INSERT INTO patient_documents(id,patient_id,author_id,doc_type,period_from,period_to,current_version,created_at) VALUES (?,?,?,?,?,?,1,?)',
    ).run(docId, patientId, user.id, type, from || null, to || null, t);
    db.prepare(
      'INSERT INTO patient_document_versions(document_id,patient_id,version,status,sections_enc,sources_json,ai_sections_json,author_id,created_at) VALUES (?,?,1,?,?,?,?,?,?)',
    ).run(
      docId,
      patientId,
      'draft',
      JSON.stringify({
        sections: sections.map((s) => ({ key: s.key, title: s.title, text: s.text, ai: Boolean(s.ai) })),
      }),
      JSON.stringify(sources),
      JSON.stringify(aiSections.map((s) => s.key)),
      user.id,
      t,
    );
    const unknown = docDraft.unknownKeys(
      db,
      scope,
      sections.map((s) => s.text),
    );
    const response = {
      id: docId,
      number: `${type}-${t.slice(0, 4)}-${String(docId).padStart(4, '0')}`,
      doc_type: type,
      status: 'draft',
      version: 1,
      period: { from: from || null, to: to || null },
      ai_generated: aiSections.length > 0,
      sections: sections.map((s) => ({
        key: s.key,
        title: s.title,
        text: docDraft.renderText(pii, db, scope, s.text),
        ai: Boolean(s.ai),
      })),
      unknown_keys: unknown.length,
      warnings: h.warningsOf(warnings),
    };
    saveIdem(user.id, state, {
      __doc_draft: { document_id: docId, version: 1 },
      ai_generated: aiSections.length > 0,
      warning_codes: warnings,
    });
    return res.status(201).json(response);
  });

  // Экспорт черновика документа (F-33): обратная подстановка настоящих значений (F-80),
  // неизвестные метки — в квадратных скобках с пометкой; каждая выгрузка — в export_log.
  app.get('/api/v1/documents/:document_id/export', (req, res) => {
    const user = req.user;
    const doc = db
      .prepare('SELECT * FROM patient_documents WHERE id=? AND hidden_at IS NULL')
      .get(Number(req.params.document_id));
    if (!doc) {
      // W-49: заключения психолога экспортирует модуль documents (подпись/версии).
      if (db.prepare('SELECT 1 FROM conclusions WHERE id=?').get(Number(req.params.document_id))) {
        try {
          return docsApi.handlers().exportConclusion(req, res);
        } catch (e) {
          return P.sendError(req, res, 500, 'E-INTERNAL');
        }
      }
      return P.sendError(req, res, 404, 'E-NOT-FOUND');
    }
    const own =
      doc.author_id === user.id ||
      db
        .prepare('SELECT 1 FROM care_assignments WHERE patient_id=? AND clinician_id=? AND ended_at IS NULL')
        .get(doc.patient_id, user.id);
    if (!own) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const fmt = String(req.query.format || '');
    const format = exporter.FORMATS[fmt];
    if (!format)
      return P.sendError(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'format', key: 'err.e-validation' }] });
    const version = db
      .prepare('SELECT * FROM patient_document_versions WHERE document_id=? ORDER BY version DESC LIMIT 1')
      .get(doc.id);
    if (!version) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const scope = scopeOfPatient(doc.patient_id);
    let sections = [];
    let aiKeys = [];
    try {
      sections = (JSON.parse(version.sections_enc) || {}).sections || [];
      aiKeys = JSON.parse(version.ai_sections_json || '[]') || [];
    } catch (_) {
      sections = [];
    }
    const built = docDraft.exportDoc({
      pii,
      db,
      scope,
      doc,
      sections: sections.map((s) => ({ ...s, ai: Boolean(s.ai) || aiKeys.includes(s.key) })),
      aiGenerated: aiKeys.length > 0,
    });
    db.prepare(
      'INSERT INTO export_log(actor_id,kind,patient_id,row_count,recipient_class,created_at) VALUES (?,?,?,?,?,?)',
    ).run(user.id, 'clinical_doc', doc.patient_id, 1, 'clinician', h.nowIso());
    res.set({
      'Content-Type': format.mime,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="draft_${exporter.today()}.${fmt}"; filename*=UTF-8''${encodeURIComponent(exporter.fileName(fmt))}`,
    });
    return res.send(format.build(built));
  });

  // ------------------------------------------------------------------
  // F-34 (W-35): диагностические гипотезы. Только психиатр (право hints.use —
  // контракт); выключатель в профиле — 403 E-HINTS-OFF; при DATA_MODE=real
  // гипотезы выключены, пока клиника не включит настройку hints.enabled_real
  // (STAND-IN: решение владельца о значении по умолчанию пока не зафиксировано).
  // Ответ модели проверяется по схеме; ссылки вне прикреплённого контекста
  // вырезаются; в карточку пациента ничего не пишется автоматически.
  // ------------------------------------------------------------------
  app.post('/api/v1/patients/:patient_id/hints', async (req, res) => {
    const user = req.user;
    const patientId = Number(req.params.patient_id);
    const prefs = db.prepare('SELECT hints_enabled FROM user_prefs WHERE user_id=?').get(user.id);
    if (!prefs || !prefs.hints_enabled) return P.sendError(req, res, 403, 'E-HINTS-OFF');
    if (config.dataMode === 'real') {
      const setting = h.activeSetting('hints.enabled_real');
      if (!setting || !setting.value || setting.value.enabled !== true)
        return P.sendError(req, res, 403, 'E-HINTS-OFF');
    }
    const chips = Array.isArray(req.body && req.body.chips) ? req.body.chips : [];
    if (chips.length > 5) return P.sendError(req, res, 422, 'E-VALIDATION');
    const { rejected, allowed } = chipsMod.validateChips(db, req, user, chips, patientId);
    if (rejected.length)
      return P.sendError(req, res, 409, 'E-CONTEXT-REJECTED', { details: { rejected_chips: rejected } });
    for (const chip of allowed) {
      if (chip.type === 'patient' && Number(chip.id) !== patientId) return P.sendError(req, res, 422, 'E-VALIDATION');
    }
    const state = idemCached(req, user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) {
      const rebuilt = rebuildHintsResponse(state.cached, user);
      if (rebuilt) return res.status(201).json(rebuilt);
    }

    const scope = scopeOfPatient(patientId);
    const counts = {};
    try {
      gateway.limits.check('diagnostic_hints', user.id);
      const ctx = await contextForModel({ req, user, patientId, chips: allowed, scope, counts });
      const modelText =
        `Проанализируй данные пациента и верни диагностические гипотезы для проверки врачом ` +
        `(вызов инструмента diagnostic_hints). Если данных мало — укажи, чего не хватает.\n${ctx.text}`;
      const out = await gateway.run({
        purpose: 'diagnostic_hints',
        user,
        patientId,
        threadId: null,
        text: modelText,
        piiCounts: counts,
      });
      if (!out.tool || out.tool.name !== 'diagnostic_hints') return P.sendError(req, res, 502, 'E-AI-SCHEMA');
      const checked = hintsSchema.validate(out.tool.arguments);
      if (!checked.ok) return P.sendError(req, res, 502, 'E-AI-SCHEMA');
      // Ссылки на объекты вне прикреплённого контекста вырезаются (T-136).
      const filtered = hintsSchema.filterOutsideRefs(checked.hypotheses, ctx.refs);
      const pseudo = pii.pseudonymize(JSON.stringify({ hypotheses: filtered }), scope, {
        nerEntities: [],
        nerOk: false,
      });
      mergeCounts(counts, pseudo.counts);
      const t = h.nowIso();
      const expires = P.iso(new Date(h.now(config).getTime() + 30 * 86400000));
      const info = db
        .prepare(
          "INSERT INTO hint_drafts(patient_id,clinician_id,hypotheses_enc,marks_json,expires_at,created_at) VALUES (?,?,?,'{}',?,?)",
        )
        .run(patientId, user.id, pseudo.text, expires, t);
      const hintId = Number(info.lastInsertRowid);
      const shown = JSON.parse(pii.reveal(pseudo.text, scope).text);
      const response = {
        id: hintId,
        ai_generated: true,
        expert_review: true,
        review_note_key: 'msg.ai.hints.mark',
        hypotheses: shown.hypotheses,
        warnings: [],
      };
      saveIdem(user.id, state, { __hints: { hint_id: hintId }, warning_codes: [] });
      return res.status(201).json(response);
    } catch (e) {
      if (h.isGatewayError(e)) return h.sendGatewayError(res, e);
      throw e;
    }
  });

  // Отметки врача по гипотезам (принял/поправил/отклонил) — только черновик, в карточку не пишется.
  app.patch('/api/v1/hints/:hint_id', (req, res) => {
    const user = req.user;
    const row = db
      .prepare('SELECT * FROM hint_drafts WHERE id=? AND clinician_id=?')
      .get(Number(req.params.hint_id), user.id);
    if (!row) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const marks = Array.isArray(req.body && req.body.marks) ? req.body.marks : null;
    if (!marks || !marks.length || marks.length > 50) return P.sendError(req, res, 422, 'E-VALIDATION');
    const map = (() => {
      try {
        return JSON.parse(row.marks_json || '{}') || {};
      } catch (_) {
        return {};
      }
    })();
    for (const m of marks) {
      if (!m || !Number.isInteger(m.index) || m.index < 0 || m.index > 7 || !HINT_MARKS.has(m.mark)) {
        return P.sendError(req, res, 422, 'E-VALIDATION');
      }
      map[String(m.index)] = m.mark;
    }
    db.prepare('UPDATE hint_drafts SET marks_json=?, updated_at=? WHERE id=?').run(
      JSON.stringify(map),
      h.nowIso(),
      row.id,
    );
    return res.json({ ok: true });
  });

  // Выключатель гипотез в профиле (F-34, T-136/T-450): поле hints_enabled у PATCH /me/prefs.
  // Обработчик зарегистрирован раньше основного (клинического) и передаёт ему остальные поля.
  app.patch('/api/v1/me/prefs', (req, res, next) => {
    const body = req.body || {};
    if (typeof body.hints_enabled !== 'boolean') return next();
    db.prepare('UPDATE user_prefs SET hints_enabled=?, updated_at=? WHERE user_id=?').run(
      body.hints_enabled ? 1 : 0,
      h.nowIso(),
      req.user.id,
    );
    const others = ['diary_notes_visible', 'course_support_enabled', 'timezone', 'share_med_log'].some(
      (k) => body[k] !== undefined,
    );
    if (others) return next();
    return res.json({ ok: true, undo: h.makeUndo(req.user.id, 'prefs.change', 'user_pref', req.user.id) });
  });

  return { router };
}

module.exports = { install };
