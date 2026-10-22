'use strict';

/**
 * Задача планировщика (F-21/S-23): физическое стирание ИИ-материалов старше срока хранения.
 * Вызывается из общего цикла планировщика src/server.js (никаких своих setInterval):
 *  - треды ИИ с expires_at <= сейчас (30 дней с последнего сообщения) — сообщения, чипы, тред;
 *    вместе с тредом стираются pii_values области треда (scope_type='thread');
 *  - черновики гипотез hint_drafts с истёкшим expires_at.
 * Пакеты по 500 строк, каждая порция — короткая транзакция (BUILD_RULES §4).
 * Журналы ai_audit и crisis_* не трогаются (REQ-AIP-016, без текстов — PD-17).
 */

function purgeExpiredThreads(db, nowIsoValue) {
  const rows = db.prepare('SELECT id FROM ai_threads WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT 500').all(nowIsoValue);
  let threads = 0;
  let messages = 0;
  for (const row of rows) {
    db.transaction(() => {
      // Сначала чипы (ссылаются на сообщения), затем сообщения, затем тред и его область F-80.
      db.prepare('DELETE FROM ai_message_chips WHERE message_id IN (SELECT id FROM ai_messages WHERE thread_id=?)').run(row.id);
      const del = db.prepare('DELETE FROM ai_messages WHERE thread_id=?').run(row.id);
      messages += del.changes;
      db.prepare("DELETE FROM pii_values WHERE scope_type='thread' AND scope_id=?").run(row.id);
      db.prepare('DELETE FROM pii_counters WHERE scope_type=? AND scope_id=?').run('thread', row.id);
      db.prepare('DELETE FROM ai_threads WHERE id=?').run(row.id);
      threads += 1;
    })();
  }
  return { threads, messages };
}

function purgeExpiredHints(db, nowIsoValue) {
  const info = db.prepare('DELETE FROM hint_drafts WHERE expires_at <= ?').run(nowIsoValue);
  return { hints: info.changes };
}

function runPurge({ db, nowIso }) {
  const current = nowIso();
  const threadsResult = purgeExpiredThreads(db, current);
  const hintsResult = purgeExpiredHints(db, current);
  return { at: current, ...threadsResult, ...hintsResult };
}

module.exports = { runPurge, purgeExpiredThreads, purgeExpiredHints };
