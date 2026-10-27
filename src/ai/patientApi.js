'use strict';

/**
 * Серверная часть ИИ-помощника пациента (F-27) и тредов (F-28) поверх единого шлюза F-26.
 * Все вызовы ИИ — только через src/ai/gateway.js; свободный текст сначала проходит
 * кризисную проверку (src/ai/crisisGate.js — вызывается, файл не меняется), потом
 * согласие на ИИ, лимиты и псевдонимизацию F-80.
 *
 * Права маршрутов объявлены в замороженном контракте (src/access → operations.json):
 * роль, perm и цель доступа проверяются контрактным middleware до этих обработчиков.
 * Треды видит только владелец: чужой тред — 404 E-NOT-FOUND (REQ-AIP-013).
 * В базе и журналах — только ключи #ТИП-N#; значения подставляются при показе (F-80).
 */

const { createMlClient } = require('../ml/client');
const { createPii } = require('./pii');
const { createRegistry } = require('./registry');
const { createGateway, GatewayError } = require('./gateway');
const { createCrisisFlow } = require('./crisisFlow');
const { createChatConduct } = require('../modules/patient/chatConduct');
const crisisMode = require('./crisisMode');
const { isFullyAssigned } = require('../access/assignment');
const { createPatientSelfTools } = require('./patientSelfTools');
const journalStore = require('../modules/journal/store');

// S-23: срок хранения ИИ-тредов берётся из настройки retention.ai_days
// (W-41, действует сразу); без настройки — 30 дней.
const THREAD_TTL_MS_DEFAULT = 30 * 86400000;
const MAX_TEXT_LEN = 2000;

function errKey(code) {
  return `err.${String(code).toLowerCase()}`;
}

function install(app, deps) {
  const { db, P, config, now, activeSetting, makeUndo, idemCached, saveIdem, crisis } = deps;

  const ml = createMlClient({ config });
  const pii = createPii({ db, config, ml });
  const registry = createRegistry({ db, config, now });
  registry.bootstrap(); // начальные промпты из prompts/<ключ>/v001.md и привязка по окружению
  const gateway = createGateway({ db, config, now, registry, pii, settings: activeSetting });

  const nowIso = () => P.iso(now(config));

  // Действующий срок хранения ИИ-материалов (S-23), дней.
  const threadTtlMs = () => {
    const setting = activeSetting('retention.ai_days');
    const days = Number(setting && setting.value);
    return (Number.isInteger(days) && days > 0 ? days : 30) * 86400000;
  };

  function threadView(row) {
    const crisisView =
      row.mode === 'crisis' ? { mode: 'crisis', crisis: crisisMode.statusOf(db, row.crisis_escalation_id) } : {};
    return {
      ...crisisView,
      id: row.id,
      purpose: row.purpose,
      title: row.title,
      patient_id: row.patient_id || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_message_at: row.last_message_at || null,
      expires_at: row.expires_at || null,
    };
  }

  function getOwnThread(userId, threadId, purpose) {
    const id = Number(threadId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const row = db
      .prepare('SELECT * FROM ai_threads WHERE id=? AND owner_user_id=? AND hidden_at IS NULL')
      .get(id, userId);
    if (!row) return null;
    if (purpose && row.purpose !== purpose) return null;
    // W-35 (PD-11, T-133): тред специалиста по откреплённому пациенту недоступен — 404.
    if (row.purpose === 'clinician_chat' && row.patient_id) {
      if (!isFullyAssigned(db, row.patient_id, userId)) return null;
    }
    return row;
  }

  function createThread({ userId, role, purpose, patientId }) {
    const t = nowIso();
    const info = db
      .prepare(
        "INSERT INTO ai_threads(owner_user_id,role,purpose,patient_id,title,title_auto,last_message_at,expires_at,created_at,updated_at) VALUES (?,? ,?,?,'Новый диалог',1,?,?,?,?)",
      )
      .run(userId, role, purpose, patientId || null, t, P.iso(new Date(now(config).getTime() + threadTtlMs())), t, t);
    return db.prepare('SELECT * FROM ai_threads WHERE id=?').get(Number(info.lastInsertRowid));
  }

  function addMessage(
    threadId,
    {
      role,
      text,
      kind = 'normal',
      aiGenerated = 0,
      modelId = null,
      bindingVersion = null,
      promptVersion = null,
      flags = null,
    },
  ) {
    const info = db
      .prepare(
        'INSERT INTO ai_messages(thread_id,role,text,kind,ai_generated,model_id,binding_version,prompt_version,flags_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        threadId,
        role,
        text,
        kind,
        aiGenerated ? 1 : 0,
        modelId,
        bindingVersion,
        promptVersion,
        flags ? JSON.stringify(flags) : null,
        nowIso(),
      );
    db.prepare('UPDATE ai_threads SET last_message_at=?, expires_at=?, updated_at=? WHERE id=?').run(
      nowIso(),
      P.iso(new Date(now(config).getTime() + threadTtlMs())),
      nowIso(),
      threadId,
    );
    return db.prepare('SELECT * FROM ai_messages WHERE id=?').get(Number(info.lastInsertRowid));
  }

  function historyFor(threadId, excludeMessageId = null, limit = 20) {
    return db
      .prepare("SELECT * FROM ai_messages WHERE thread_id=? AND id<>? AND kind NOT IN ('error','crisis') ORDER BY id")
      .all(threadId, excludeMessageId || -1)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-limit)
      .map((m) => ({ role: m.role, text: m.text }));
  }

  function autoTitle(threadId, text) {
    const row = db.prepare('SELECT title_auto FROM ai_threads WHERE id=?').get(threadId);
    if (!row || !row.title_auto) return;
    const clean = String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return;
    db.prepare('UPDATE ai_threads SET title=? WHERE id=?').run(
      clean.length > 40 ? `${clean.slice(0, 40).trimEnd()}…` : clean,
      threadId,
    );
  }

  function scopeFor(thread, userId) {
    // F-80: область — пациент; для треда специалиста без пациента — этот тред.
    if (thread.purpose === 'patient_assistant') return { scopeType: 'patient', scopeId: userId };
    if (thread.patient_id) return { scopeType: 'patient', scopeId: thread.patient_id };
    return { scopeType: 'thread', scopeId: thread.id };
  }

  function warningsOf(list) {
    return [...new Set(list)].map((code) => ({ code, key: errKey(code) }));
  }

  function replyView(msg, shownText) {
    return {
      id: msg.id,
      role: msg.role,
      text: shownText,
      ai_generated: Boolean(msg.ai_generated),
      status: msg.kind === 'normal' ? 'normal' : msg.kind,
      kind: msg.kind,
      created_at: msg.created_at,
    };
  }

  function consentAiGiven(userId) {
    const row = db.prepare("SELECT action FROM consent_current WHERE user_id=? AND consent_kind='ai'").get(userId);
    return Boolean(row && row.action === 'given');
  }

  function sendGatewayError(res, e) {
    return P.sendError(res.req, res, e.status, e.code, e.details ? { details: e.details } : undefined);
  }

  function isGatewayError(e) {
    return e instanceof GatewayError;
  }

  // Кризисный разговор в чате пациента; кнопка «Мне нужна помощь» (src/server.js) открывает его через app.locals.
  const crisisFlow = createCrisisFlow({
    db,
    config,
    now,
    pii,
    gateway,
    createThread,
    addMessage,
    historyFor,
    consentAiGiven,
    isGatewayError,
  });
  app.locals.crisisFlow = crisisFlow;
  // Метки заигрывания/грубости и пауза чата (статус ТРОЛЛЬ); админка читает и снимает паузу через app.locals.
  const chatConduct = createChatConduct({ db, nowIso });
  app.locals.chatConduct = chatConduct;

  // Инструменты чтения данных самого пациента и журнала (src/ai/patientSelfTools.js).
  const journal = journalStore.create(db, () => now(config).getTime());
  const timezone = () => (activeSetting('org.timezone_hours').value || {}).timezone || 'Europe/Moscow';
  const selfTools = ({ user, scope, onCrisis }) =>
    createPatientSelfTools({
      db,
      onCrisis,
      pii,
      scope,
      user,
      journal,
      today: () => new Intl.DateTimeFormat('en-CA', { timeZone: timezone() }).format(now(config)),
      nowIso,
      timezone,
      counts: {},
      mergeCounts: (a, b) => {
        for (const [k, v] of Object.entries(b || {})) a[k] = (a[k] || 0) + v;
      },
      onUse: (name) => {
        try {
          db.prepare(
            "INSERT INTO phi_access_log(actor_id,actor_role,patient_id,section,action,decision,basis,object_type,created_at) VALUES (?,?,?,'ai.tool','view','allow','self',?,?)",
          ).run(user.id, user.role, user.id, name, nowIso());
        } catch (_) {
          /* журнал не ломает ответ */
        }
      },
    });
  const articleLinks = (ids) =>
    ids
      .map((id) => journal.article({ id: 0, role: 'patient' }, id))
      .filter(Boolean)
      .map((a) => ({ id: a.id, title: a.title, url: `/journal/${a.id}` }));

  // Маршруты — в отдельном файле, чтобы модуль оставался обозримым.
  require('./patientEndpoints')(app, {
    selfTools,
    journal,
    articleLinks,
    crisisFlow,
    chatConduct,
    db,
    P,
    config,
    now,
    nowIso,
    makeUndo,
    idemCached,
    saveIdem,
    crisis,
    pii,
    gateway,
    activeSetting, // W-34: словарь НЯ S-31 читается при каждом сообщении — изменение действует сразу
    threadView,
    getOwnThread,
    createThread,
    addMessage,
    historyFor,
    autoTitle,
    scopeFor,
    warningsOf,
    replyView,
    consentAiGiven,
    isGatewayError,
    sendGatewayError,
  });

  // W-35: серверная часть ИИ специалиста (F-32/F-33/F-34) — чат с пациентом,
  // черновики документов с экспортом, диагностические гипотезы, экспорт треда.
  require('./workspace/clinicianApi').install(app, {
    db,
    P,
    config,
    now,
    nowIso,
    makeUndo,
    idemCached,
    saveIdem,
    pii,
    gateway,
    activeSetting,
    threadView,
    getOwnThread,
    createThread,
    addMessage,
    historyFor,
    autoTitle,
    scopeFor,
    warningsOf,
    replyView,
    isGatewayError,
    sendGatewayError,
  });

  // Шаблоны текстов врача (раздел «Документы»): личные шаблоны, кнопка «ИИ», подстановка данных пациента.
  require('./workspace/templatesApi').install(app, { db, P, nowIso, pii, gateway, isGatewayError, sendGatewayError });
  // Документы специалиста по пациенту (извещение о НЯ по бланку): создаются из шаблона, «Готово» неизменяемо.
  require('./workspace/documentsApi').install(app, { db, P, nowIso, idemCached, saveIdem });

  // Вкладка «Лекарства» специалиста: поиск, карточка препарата, ИИ-чат о нём (обычный тред purpose = 'drug_chat').
  require('../modules/drugs/routes').install(app, {
    db,
    P,
    config,
    now,
    pii,
    gateway,
    createThread,
    addMessage,
    historyFor,
    scopeFor,
    warningsOf,
    replyView,
    threadView,
    isGatewayError,
    sendGatewayError,
  });

  // «Лекарства» пациента: статьи по препарату и прежние назначения.
  require('../modules/library/medsApi').install(app, { db, P, nowIso });

  // Библиотека специалиста: свои материалы, картинки, ИИ-черновик по основным мыслям, публикация.
  require('../modules/library/authoring').install(app, {
    db,
    P,
    config,
    nowIso,
    pii,
    gateway,
    isGatewayError,
    sendGatewayError,
  });
}

module.exports = { install };
