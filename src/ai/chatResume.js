'use strict';

/**
 * Возврат в тот же чат пациента: если с последнего сообщения прошло не больше RESUME_WINDOW_MS,
 * вкладка «Чат» открывает последний обычный тред, а не новый. Кризисные треды сюда не входят:
 * их открывает кризисный режим (src/ai/crisisMode.js).
 */

const RESUME_WINDOW_HOURS = 6;
const RESUME_WINDOW_MS = RESUME_WINDOW_HOURS * 3600 * 1000;

/**
 * @param {object} db
 * @param {number} userId
 * @param {number} nowMs текущее время (из часов приложения)
 * @returns {{id: number, last_message_at: string} | null}
 */
function activeThread(db, userId, nowMs) {
  const row = db
    .prepare(
      "SELECT id, COALESCE(last_message_at, updated_at) last_at FROM ai_threads WHERE owner_user_id=? AND purpose='patient_assistant' AND hidden_at IS NULL AND COALESCE(mode,'') <> 'crisis' ORDER BY COALESCE(last_message_at, updated_at) DESC, id DESC LIMIT 1",
    )
    .get(userId);
  if (!row) return null;
  const age = nowMs - Date.parse(row.last_at);
  return Number.isFinite(age) && age <= RESUME_WINDOW_MS ? { id: row.id, last_message_at: row.last_at } : null;
}

module.exports = { activeThread, RESUME_WINDOW_HOURS, RESUME_WINDOW_MS };
