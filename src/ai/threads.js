'use strict';

/**
 * Треды и сообщения ИИ-чата — общие для ролей (пациент сейчас, врач — W1.C2).
 * Любая выборка/изменение скоплены владельцем (owner_user_id): чужой тред недоступен
 * (getThread возвращает null — маршруты отвечают 404). Врач/админ не читают чужие треды (REQ-AIP-013).
 */

const db = require('../db');

const DEFAULT_TITLE = 'Новый диалог';

function createThread({ ownerUserId, role, patientId = null, title = DEFAULT_TITLE, titleAuto = true }) {
  const info = db
    .prepare('INSERT INTO ai_threads (owner_user_id, role, patient_id, title, title_auto) VALUES (?, ?, ?, ?, ?)')
    .run(ownerUserId, role, patientId, title, titleAuto ? 1 : 0);
  return getThread(ownerUserId, info.lastInsertRowid);
}

function getThread(ownerUserId, threadId, role = null) {
  const id = Number(threadId);
  if (!Number.isInteger(id)) return null;
  const row = db.prepare('SELECT * FROM ai_threads WHERE id = ? AND owner_user_id = ?').get(id, ownerUserId);
  if (!row) return null;
  if (role && row.role !== role) return null;
  return row;
}

/** Сортировка по последней активности (REQ-AIP-002). */
function listThreads(ownerUserId, role = null) {
  const rows = db.prepare('SELECT * FROM ai_threads WHERE owner_user_id = ? ORDER BY updated_at DESC, id DESC').all(ownerUserId);
  return role ? rows.filter((r) => r.role === role) : rows;
}

function listMessages(threadId) {
  return db.prepare('SELECT * FROM ai_messages WHERE thread_id = ? ORDER BY id ASC').all(threadId);
}

function addMessage(threadId, { role, text, kind = 'normal', intent = null, flags = null }) {
  const info = db
    .prepare('INSERT INTO ai_messages (thread_id, role, text, kind, intent, flags_json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(threadId, role, text, kind, intent, flags ? JSON.stringify(flags) : null);
  db.prepare("UPDATE ai_threads SET updated_at = datetime('now') WHERE id = ?").run(threadId);
  return db.prepare('SELECT * FROM ai_messages WHERE id = ?').get(info.lastInsertRowid);
}

function autoTitle(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return DEFAULT_TITLE;
  return clean.length > 40 ? `${clean.slice(0, 40).trimEnd()}…` : clean;
}

/** Авто-название по первому сообщению, пока пользователь не переименовал вручную. */
function applyAutoTitle(thread, firstText) {
  if (!thread.title_auto) return thread.title;
  const title = autoTitle(firstText);
  db.prepare('UPDATE ai_threads SET title = ? WHERE id = ?').run(title, thread.id);
  return title;
}

function renameThread(ownerUserId, threadId, title) {
  const thread = getThread(ownerUserId, threadId);
  if (!thread) return null;
  const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!clean) return thread;
  db.prepare('UPDATE ai_threads SET title = ?, title_auto = 0 WHERE id = ?').run(clean, thread.id);
  return getThread(ownerUserId, thread.id);
}

/**
 * Удаляет тред и его сообщения из кабинета пользователя. Журнал инцидентов (crisis_escalations /
 * crisis_incident_log с цитатой) и ai_audit НЕ трогаются (REQ-AIP-016).
 */
function deleteThread(ownerUserId, threadId) {
  const thread = getThread(ownerUserId, threadId);
  if (!thread) return false;
  db.transaction(() => {
    db.prepare('DELETE FROM ai_messages WHERE thread_id = ?').run(thread.id);
    db.prepare('DELETE FROM ai_threads WHERE id = ?').run(thread.id);
    // Перенесённая из старого чата копия тоже удаляется, иначе миграция вернёт диалог обратно.
    if (thread.legacy_session_id) {
      db.prepare('DELETE FROM chatbot_messages WHERE session_id = ?').run(thread.legacy_session_id);
      db.prepare('DELETE FROM chatbot_sessions WHERE id = ?').run(thread.legacy_session_id);
    }
  })();
  return true;
}

function audit({ userId, role, threadId = null, event, crisis = false, provider = null }) {
  // ТЕКСТ СООБЩЕНИЙ В АУДИТ НЕ ПИШЕТСЯ (REQ-AIP-014).
  db.prepare('INSERT INTO ai_audit (user_id, role, thread_id, event, crisis, provider) VALUES (?, ?, ?, ?, ?, ?)').run(
    userId, role, threadId, event, crisis ? 1 : 0, provider
  );
}

function introSeen(userId) {
  const row = db.prepare('SELECT intro_seen_at FROM ai_prefs WHERE user_id = ?').get(userId);
  return !!(row && row.intro_seen_at);
}

function markIntroSeen(userId) {
  db.prepare("INSERT INTO ai_prefs (user_id, intro_seen_at) VALUES (?, datetime('now')) ON CONFLICT(user_id) DO UPDATE SET intro_seen_at = COALESCE(intro_seen_at, datetime('now'))").run(userId);
}

/**
 * Идемпотентный перенос старых chatbot_sessions/chatbot_messages в ai_threads/ai_messages без потери
 * (REQ-AIP-002, NFR-014). Старые таблицы не удаляются. Повторный вызов ничего не дублирует
 * (UNIQUE legacy_session_id / legacy_message_id). patientId — ограничить одним пациентом.
 */
function migrateLegacyChat(patientId = null) {
  const sessions = patientId
    ? db.prepare('SELECT * FROM chatbot_sessions WHERE patient_id = ?').all(patientId)
    : db.prepare('SELECT * FROM chatbot_sessions').all();
  let moved = 0;
  db.transaction(() => {
    for (const s of sessions) {
      let thread = db.prepare('SELECT * FROM ai_threads WHERE legacy_session_id = ?').get(s.id);
      const msgs = db.prepare('SELECT * FROM chatbot_messages WHERE session_id = ? ORDER BY id ASC').all(s.id);
      if (!thread) {
        if (msgs.length === 0) continue; // пустую сессию переносить незачем
        const firstUser = msgs.find((m) => m.sender === 'user');
        const info = db
          .prepare(
            "INSERT INTO ai_threads (owner_user_id, role, title, title_auto, legacy_session_id, created_at, updated_at) VALUES (?, 'patient', ?, 1, ?, ?, ?)"
          )
          .run(s.patient_id, firstUser ? autoTitle(firstUser.text) : DEFAULT_TITLE, s.id, s.created_at, msgs[msgs.length - 1].created_at);
        thread = { id: info.lastInsertRowid };
      }
      const ins = db.prepare(
        'INSERT OR IGNORE INTO ai_messages (thread_id, role, text, kind, intent, legacy_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      for (const m of msgs) {
        const r = ins.run(thread.id, m.sender === 'user' ? 'user' : 'assistant', m.text, m.intent === 'crisis' && m.sender === 'bot' ? 'crisis' : 'normal', m.intent, m.id, m.created_at);
        moved += r.changes;
      }
    }
  })();
  return moved;
}

module.exports = {
  DEFAULT_TITLE, createThread, getThread, listThreads, listMessages, addMessage, applyAutoTitle, renameThread, deleteThread,
  audit, introSeen, markIntroSeen, migrateLegacyChat, autoTitle,
};
