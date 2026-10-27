'use strict';

/**
 * Поведение пациента в чате с ИИ: метки [[GAME]] / [[RUDE]] от слоя prompts/guard/patient_conduct и статус ТРОЛЛЬ.
 *
 * Метка — событие (patient_chat_marks), в тексте её уже нет (шлюз вырезает до показа и сохранения). Три метки любого
 * вида за скользящие 3 часа включают мягкую паузу чата на час (patient_chat_blocks). Пауза снимается сама по
 * blocked_until или вручную администратором. Метки, уже приведшие к паузе, повторно не считаются.
 *
 * Не блокируется и не считается никогда: кризисный разговор (проверка crisisGate и кризисный тред идут выше этого
 * модуля и сюда не заходят). Содержимого чатов у модуля нет и админу оно не отдаётся — только факт и срок паузы.
 */

const MARK_WINDOW_MS = 3 * 60 * 60 * 1000;
const MARKS_TO_BLOCK = 3;
const BLOCK_MS = 60 * 60 * 1000;
const KINDS = ['GAME', 'RUDE'];

function createChatConduct({ db, nowIso }) {
  const ts = (ms) => new Date(ms).toISOString();

  /** Действующая пауза пациента или null. */
  function activeBlock(patientId) {
    const row = db
      .prepare(
        'SELECT id, started_at, blocked_until FROM patient_chat_blocks WHERE patient_id=? AND cleared_at IS NULL AND blocked_until>? ORDER BY id DESC LIMIT 1',
      )
      .get(Number(patientId), nowIso());
    return row ? { id: row.id, started_at: row.started_at, blocked_until: row.blocked_until } : null;
  }

  /**
   * Записывает метку и, если набралось три за 3 часа, включает паузу.
   * @returns {{blocked: boolean, blocked_until: string|null, count: number}}
   */
  function record(patientId, kind, threadId = null) {
    if (!KINDS.includes(kind)) return { blocked: false, blocked_until: null, count: 0 };
    const pid = Number(patientId);
    const now = nowIso();
    return db
      .transaction(() => {
        db.prepare('INSERT INTO patient_chat_marks(patient_id, thread_id, kind, created_at) VALUES (?,?,?,?)').run(
          pid,
          threadId ? Number(threadId) : null,
          kind,
          now,
        );
        db.prepare(
          "INSERT INTO action_log(actor_id, actor_role, action, target_type, target_id, target_user_id, new_safe_json) VALUES (NULL,'system','chat.conduct_mark','user',?,?,?)",
        ).run(pid, pid, JSON.stringify({ kind }));
        // Окно: последние 3 часа, но не раньше начала последней паузы (её метки уже учтены).
        const last = db.prepare('SELECT MAX(started_at) s FROM patient_chat_blocks WHERE patient_id=?').get(pid);
        const from = ts(Math.max(new Date(now).getTime() - MARK_WINDOW_MS, last && last.s ? new Date(last.s).getTime() : 0));
        const count = db
          .prepare('SELECT COUNT(*) n FROM patient_chat_marks WHERE patient_id=? AND created_at>?')
          .get(pid, from).n;
        if (count < MARKS_TO_BLOCK || activeBlock(pid)) return { blocked: false, blocked_until: null, count };
        const until = ts(new Date(now).getTime() + BLOCK_MS);
        db.prepare('INSERT INTO patient_chat_blocks(patient_id, started_at, blocked_until) VALUES (?,?,?)').run(
          pid,
          now,
          until,
        );
        db.prepare(
          "INSERT INTO action_log(actor_id, actor_role, action, target_type, target_id, target_user_id, new_safe_json) VALUES (NULL,'system','chat.troll_set','user',?,?,?)",
        ).run(pid, pid, JSON.stringify({ until, marks: count }));
        return { blocked: true, blocked_until: until, count };
      })
      .immediate();
  }

  /** Снятие паузы администратором. @returns {boolean} была ли действующая пауза. */
  function clear(patientId, adminId) {
    const pid = Number(patientId);
    const now = nowIso();
    const done = db
      .prepare(
        'UPDATE patient_chat_blocks SET cleared_at=?, cleared_by=? WHERE patient_id=? AND cleared_at IS NULL AND blocked_until>?',
      )
      .run(now, adminId, pid, now);
    return done.changes > 0;
  }

  /** Все действующие паузы: Map patient_id -> blocked_until (для админки; без содержимого чатов). */
  function activeMap() {
    const rows = db
      .prepare('SELECT patient_id, MAX(blocked_until) AS until FROM patient_chat_blocks WHERE cleared_at IS NULL AND blocked_until>? GROUP BY patient_id')
      .all(nowIso());
    return new Map(rows.map((r) => [r.patient_id, r.until]));
  }

  return { activeBlock, record, clear, activeMap, MARK_WINDOW_MS, MARKS_TO_BLOCK, BLOCK_MS };
}

module.exports = { createChatConduct, MARK_WINDOW_MS, MARKS_TO_BLOCK, BLOCK_MS };
