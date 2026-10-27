'use strict';

/**
 * Предложение оформить нежелательное явление из чата (пакет E плана 2026-10-23-ae-intake).
 * Общие помощники для чата пациента и чата специалиста: словарь признаков, «не повторять» (12 часов), метка предложения.
 * Хранение «не повторять»: в flags_json сообщения ассистента ставится ae_offer:true, когда ответ с предложением
 * реально отдан клиенту; плюс учитываются записи НЯ из чата (adverse_events.source='ai_chat'). Новых таблиц нет.
 */

const { offerEligibility } = require('../modules/v3/ae_intake');

const REPEAT_WINDOW_MS = 12 * 3600 * 1000;

// S-31: значение по умолчанию (review-required); действующий словарь — настройка ae.detect_dictionary.
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

// Жалоба, похожая на НЯ, при которой словарь не сработал: запасной путь — модель ae_extraction (чат пациента).
const AE_TRIGGER_RE = /тошнит|тошнота|головокруж|кружится голова|зуд|сыпь|рвот|побочн|диаре|понос|головная боль/i;

function dictionary(activeSetting) {
  const value = activeSetting ? activeSetting('ae.detect_dictionary').value : null;
  return Array.isArray(value) && value.length ? value : DEFAULT_AE_DICTIONARY;
}

/** Запись словаря, сработавшая в тексте, или null. */
function dictionaryHit(activeSetting, text) {
  const lower = String(text || '').toLowerCase();
  return dictionary(activeSetting).find((e) => e && e.phrase && lower.includes(String(e.phrase).toLowerCase())) || null;
}

/**
 * Было ли предложение за последние 12 часов: ответ чата с ae_offer или запись НЯ из чата.
 * Пациент: по пользователю (каждое сообщение страницы чата создаёт свой тред); специалист: по паре специалист + пациент.
 */
function recentlyOffered(db, { user, patientId, nowIso }) {
  const since = new Date(Date.parse(nowIso) - REPEAT_WINDOW_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const isPatient = user.role === 'patient';
  const msg = db
    .prepare(
      `SELECT 1 FROM ai_messages m JOIN ai_threads t ON t.id=m.thread_id
       WHERE t.owner_user_id=? AND t.purpose=? ${isPatient ? '' : 'AND t.patient_id=?'}
         AND m.role='assistant' AND m.created_at>=? AND m.flags_json LIKE '%"ae_offer":true%' LIMIT 1`,
    )
    .get(...[user.id, isPatient ? 'patient_assistant' : 'clinician_chat', ...(isPatient ? [] : [patientId]), since]);
  if (msg) return true;
  const ae = db
    .prepare(
      `SELECT 1 FROM adverse_events WHERE patient_id=? AND source='ai_chat' AND status<>'draft' AND created_at>=?
         ${isPatient ? '' : 'AND reported_by=?'} LIMIT 1`,
    )
    .get(...[patientId, since, ...(isPatient ? [] : [user.id])]);
  return Boolean(ae);
}

/** Какие навыки предлагать модели: пустой список, если предлагать нельзя или недавно уже предлагали. */
function skillsFor(db, { user, patientId, nowIso, iso }) {
  if (!['patient', 'psychiatrist', 'psychologist'].includes(user.role)) return [];
  if (user.role !== 'patient' && !patientId) return [];
  if (!offerEligibility({ db, iso: iso || (() => nowIso) }, { user, patientId })) return [];
  if (recentlyOffered(db, { user, patientId, nowIso })) return [];
  if (user.role === 'patient') return ['skill.ae_offer'];
  return [user.role === 'psychiatrist' ? 'skill.ae_offer_clinician' : 'skill.ae_offer_psychologist'];
}

/** Фиксирует, что ответ с предложением отдан клиенту (вызывать после успешной записи ответа). */
function markOffered(db, messageId) {
  const row = db.prepare('SELECT flags_json FROM ai_messages WHERE id=?').get(messageId);
  let flags = {};
  try {
    flags = row && row.flags_json ? JSON.parse(row.flags_json) : {};
  } catch (_) {
    flags = {};
  }
  flags.ae_offer = true;
  db.prepare('UPDATE ai_messages SET flags_json=? WHERE id=?').run(JSON.stringify(flags), messageId);
}

module.exports = {
  DEFAULT_AE_DICTIONARY,
  AE_TRIGGER_RE,
  REPEAT_WINDOW_MS,
  dictionary,
  dictionaryHit,
  recentlyOffered,
  skillsFor,
  markOffered,
};
