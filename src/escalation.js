'use strict';

/**
 * Создание кризисных эскалаций с Tier/SLA, передача по цепочке дежурства
 * при неподтверждении в срок, и append-only лог инцидентов (RES-2,
 * «Кризисный протокол», раздел 3).
 *
 * Ограничение MVP (явно описано в документе, раздел 6): нет настоящего
 * круглосуточного дежурства. «Резерв» здесь — следующий психиатр/психолог,
 * также закреплённый за этим пациентом (care_assignments), по порядку
 * назначения. Если второй клиницист не назначен — нет технической
 * возможности передать резерву, эскалация помечается unresolved для
 * обязательного ручного разбора (раздел 3, Tier 3, «Резерв второго порядка»).
 */

const db = require('./db');
const { TIERS, computeDueAt } = require('./crisisProtocol');

function logIncident(escalationId, patientId, eventType, actorId, detail) {
  db.prepare(
    `INSERT INTO crisis_incident_log (escalation_id, patient_id, event_type, actor_id, detail_json) VALUES (?, ?, ?, ?, ?)`
  ).run(escalationId, patientId, eventType, actorId ?? null, detail ? JSON.stringify(detail) : null);
}

function resolvePrimaryClinician(patientId) {
  const row = db.prepare('SELECT clinician_id FROM care_assignments WHERE patient_id = ? ORDER BY id ASC LIMIT 1').get(patientId);
  return row ? row.clinician_id : null;
}

function resolveBackupClinician(patientId, excludeClinicianId) {
  const row = db
    .prepare('SELECT clinician_id FROM care_assignments WHERE patient_id = ? AND clinician_id != ? ORDER BY id ASC LIMIT 1')
    .get(patientId, excludeClinicianId);
  return row ? row.clinician_id : null;
}

/**
 * Создаёт эскалацию в той же транзакции, что вызывающий код (инструмент
 * не передаётся явно — вызывающая сторона сама оборачивает это в db.transaction
 * при необходимости атомарности с сохранением результата теста).
 */
function createEscalation({ patientId, onlineResultId = null, instrument, reasons, tier, triggers }) {
  const dueAt = computeDueAt(tier);
  const info = db
    .prepare(
      `INSERT INTO crisis_escalations (patient_id, online_result_id, instrument, reasons_json, tier, triggers_json, due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(patientId, onlineResultId, instrument, JSON.stringify(reasons), tier, JSON.stringify(triggers), dueAt);
  const escalationId = info.lastInsertRowid;

  logIncident(escalationId, patientId, 'created', null, { tier, triggers, reasons });
  if (tier >= TIERS.HIGH) {
    const primaryId = resolvePrimaryClinician(patientId);
    logIncident(escalationId, patientId, 'specialist_notified', null, {
      notified: primaryId,
      channel: 'in-app (push/SMS — реальный канал подключается вне MVP, см. ограничения протокола)',
      due_at: dueAt,
    });
  }
  return escalationId;
}

// W3.K (L-4): схлопывание потока кризисных сообщений. Повторная кризисная фраза пациента (свободный текст) в окне
// CRISIS_MERGE_WINDOW_MIN минут (по умолчанию 15; 0 — выключено), пока предыдущая эскалация не подтверждена,
// ДОПОЛНЯЕТ её (цитата в причины, уровень не снижается, срок SLA не отодвигается), а не создаёт новую строку очереди.
// Первая кризисная фраза всегда создаёт эскалацию; подтверждённая эскалация новую не поглощает.
const FREE_TEXT_SOURCES = ['chatbot', 'message', 'previsit', 'appeal', 'contact_request', 'diary'];
const MERGE_MAX_QUOTES = 10; // сверх этого дополняется только счётчик, строки/журнал не растут
const mergeWindowMin = () => {
  const v = Number(process.env.CRISIS_MERGE_WINDOW_MIN);
  return Number.isFinite(v) && v >= 0 ? v : 15;
};

function mergeIntoOpen({ patientId, instrument, reasons, tier, triggers, now = new Date() }) {
  const win = mergeWindowMin();
  if (!win || !FREE_TEXT_SOURCES.includes(instrument)) return null;
  const since = new Date(now.getTime() - win * 60000).toISOString().slice(0, 19).replace('T', ' ');
  const ex = db
    .prepare(
      `SELECT * FROM crisis_escalations WHERE patient_id = ? AND status = 'open' AND online_result_id IS NULL
       AND instrument IN (${FREE_TEXT_SOURCES.map(() => '?').join(',')}) AND created_at >= ? ORDER BY id DESC LIMIT 1`
    )
    .get(patientId, ...FREE_TEXT_SOURCES, since);
  if (!ex) return null;
  let old = [];
  try { old = JSON.parse(ex.reasons_json); } catch { old = []; }
  const COUNT_RE = /^Повторных кризисных сообщений в окне: (\d+)$/;
  const quotes = old.filter((r) => !COUNT_RE.test(String(r)));
  const prevCount = Number((old.map((r) => COUNT_RE.exec(String(r))).find(Boolean) || [0, 0])[1]);
  const count = prevCount + 1;
  const newQuotes = quotes.length < MERGE_MAX_QUOTES ? quotes.concat(reasons) : quotes;
  const merged = newQuotes.concat([`Повторных кризисных сообщений в окне: ${count}`]);
  const newTier = Math.max(ex.tier, tier);
  const trig = [...new Set([...(JSON.parse(ex.triggers_json || '[]')), ...triggers])];
  let due = ex.due_at;
  if (newTier > ex.tier) {
    const nd = computeDueAt(newTier, now);
    if (nd && (!due || nd < due)) due = nd;
  }
  db.prepare('UPDATE crisis_escalations SET reasons_json = ?, tier = ?, triggers_json = ?, due_at = ? WHERE id = ?')
    .run(JSON.stringify(merged), newTier, JSON.stringify(trig), due, ex.id);
  if (count <= MERGE_MAX_QUOTES) logIncident(ex.id, patientId, 'created', null, { merged: true, tier: newTier, triggers: trig, reasons });
  if (newTier >= TIERS.HIGH && ex.tier < TIERS.HIGH) {
    logIncident(ex.id, patientId, 'specialist_notified', null, { notified: resolvePrimaryClinician(patientId), channel: 'in-app (push/SMS — реальный канал подключается вне MVP, см. ограничения протокола)', due_at: due });
  }
  return ex.id;
}

/**
 * Проверяет открытые эскалации Tier 2/3 на просрочку SLA и передаёт их
 * резервному дежурному (или помечает unresolved, если резерва нет).
 * Вызывается лениво при открытии /crisis — в MVP нет фонового воркера.
 */
function checkOverdueEscalations(now = new Date()) {
  const overdue = db
    .prepare(
      `SELECT * FROM crisis_escalations
       WHERE status = 'open' AND tier >= ? AND due_at IS NOT NULL AND due_at < ? AND escalated_to_backup_at IS NULL AND unresolved = 0`
    )
    .all(TIERS.HIGH, now.toISOString());

  for (const esc of overdue) {
    const primaryId = resolvePrimaryClinician(esc.patient_id);
    const backupId = resolveBackupClinician(esc.patient_id, primaryId);
    if (backupId) {
      db.prepare('UPDATE crisis_escalations SET escalated_to_backup_at = ?, backup_notified_id = ? WHERE id = ?').run(
        now.toISOString(),
        backupId,
        esc.id
      );
      logIncident(esc.id, esc.patient_id, 'backup_notified', null, { backup_notified_id: backupId });
    } else {
      db.prepare('UPDATE crisis_escalations SET unresolved = 1 WHERE id = ?').run(esc.id);
      logIncident(esc.id, esc.patient_id, 'unresolved', null, {
        reason: 'нет резервного дежурного (MVP-ограничение) — требуется ручной разбор в начале следующего рабочего дня',
      });
    }
  }
  return overdue.length;
}

function acknowledgeEscalation(escalationId, actorId) {
  const row = db.prepare('SELECT * FROM crisis_escalations WHERE id = ?').get(escalationId);
  if (!row) return null;
  db.prepare("UPDATE crisis_escalations SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = datetime('now') WHERE id = ?").run(
    actorId,
    escalationId
  );
  logIncident(escalationId, row.patient_id, 'acknowledged', actorId, {});
  return row;
}

module.exports = { createEscalation, mergeIntoOpen, FREE_TEXT_SOURCES, checkOverdueEscalations, acknowledgeEscalation, logIncident, resolvePrimaryClinician, resolveBackupClinician };
