'use strict';

/**
 * Очередь «Без врача» администратора (REQ-CRI-007, REQ-ADM-009, OQ-7).
 *
 * Попадают:
 *  - открытые эскалации пациентов без активного врача (нет привязки или врач деактивирован);
 *  - открытые эскалации, не подтверждённые в срок и без резерва (unresolved) — «без резерва»;
 *  - обращения пациента (patient_contact_requests, patient_appeals) без активного врача.
 * Админ видит только метаданные: пациент, тип, время, уровень, SLA. Текст/цитаты — никогда (REQ-ADM-007).
 * Действия: «передать врачу» (привязка пациента к выбранному клиницисту — запись сразу появляется в его очереди)
 * и «подтвердить». Оба действия пишутся в admin_action_log; подтверждение эскалации — ещё и в crisis_incident_log.
 */

const db = require('./db');
const escalation = require('./escalation');
const core = require('./admin_core');
const { TRIGGER_LABELS, appealDueAt } = require('./crisis_queue');

const NO_ACTIVE_DOCTOR_SQL = `NOT EXISTS (
  SELECT 1 FROM care_assignments ca JOIN users c ON c.id = ca.clinician_id
  WHERE ca.patient_id = %P% AND c.deactivated_at IS NULL AND c.account_status = 'active')`;
const noDoctor = (col) => NO_ACTIVE_DOCTOR_SQL.replace('%P%', col);

function hasTable(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function whyEscalation(r) {
  if (r.no_doctor) return r.has_assignment ? 'врач деактивирован' : 'у пациента нет врача';
  if (r.unresolved) return 'не подтверждена в срок, резерва нет';
  return '';
}

/** Открытые элементы: эскалации + обращения. Только метаданные. */
function listOpen() {
  const items = [];
  const esc = db
    .prepare(
      `SELECT ce.id, ce.patient_id, ce.tier, ce.triggers_json, ce.instrument, ce.created_at, ce.due_at, ce.unresolved,
              u.full_name AS patient_name,
              (${noDoctor('ce.patient_id')}) AS no_doctor,
              EXISTS (SELECT 1 FROM care_assignments x WHERE x.patient_id = ce.patient_id) AS has_assignment
       FROM crisis_escalations ce JOIN users u ON u.id = ce.patient_id
       WHERE ce.status = 'open' AND ((${noDoctor('ce.patient_id')}) OR ce.unresolved = 1)
       ORDER BY ce.tier DESC, ce.created_at ASC`
    )
    .all();
  for (const r of esc) {
    items.push({
      ref: `e${r.id}`, kind: 'escalation', id: r.id, patient_id: r.patient_id, patient_name: r.patient_name,
      tier: r.tier, effTier: r.tier, instrument: r.instrument, created_at: r.created_at, due_at: r.due_at,
      triggers: safeJson(r.triggers_json, []), why: whyEscalation(r), no_doctor: !!r.no_doctor, unresolved: !!r.unresolved,
    });
  }
  if (hasTable('patient_contact_requests')) {
    const rows = db
      .prepare(
        `SELECT pc.id, pc.patient_id, pc.created_at, pc.clinician_id, u.full_name AS patient_name
         FROM patient_contact_requests pc JOIN users u ON u.id = pc.patient_id
         WHERE pc.status = 'open' AND (pc.to_admin = 1 OR (${noDoctor('pc.patient_id')}))`
      )
      .all();
    for (const r of rows) {
      items.push({
        ref: `c${r.id}`, kind: 'contact', id: r.id, patient_id: r.patient_id, patient_name: r.patient_name, tier: null, effTier: 2,
        instrument: null, created_at: r.created_at, due_at: appealDueAt(r.created_at), triggers: [],
        why: 'обращение пациента, врача нет', no_doctor: true, unresolved: false,
      });
    }
  }
  if (hasTable('patient_appeals')) {
    const rows = db
      .prepare(
        `SELECT pa.id, pa.patient_id, pa.created_at, u.full_name AS patient_name
         FROM patient_appeals pa JOIN users u ON u.id = pa.patient_id
         WHERE pa.status = 'open' AND (pa.routed_to = 'admin' OR (${noDoctor('pa.patient_id')}))`
      )
      .all();
    for (const r of rows) {
      items.push({
        ref: `a${r.id}`, kind: 'appeal', id: r.id, patient_id: r.patient_id, patient_name: r.patient_name, tier: null, effTier: 2,
        instrument: null, created_at: r.created_at, due_at: appealDueAt(r.created_at), triggers: [],
        why: 'обращение пациента, врача нет', no_doctor: true, unresolved: false,
      });
    }
  }
  return items.sort((a, b) => b.effTier - a.effTier || String(a.created_at).localeCompare(String(b.created_at)));
}

function countOpen() {
  return listOpen().length;
}

/** Недавно обработанные админом (для контекста). */
function listHandled(limit = 15) {
  const out = [];
  const esc = db
    .prepare(
      `SELECT ce.id, ce.patient_id, ce.tier, ce.acknowledged_at, u.full_name AS patient_name, a.full_name AS by_name
       FROM crisis_escalations ce JOIN users u ON u.id = ce.patient_id JOIN users a ON a.id = ce.acknowledged_by
       WHERE ce.status = 'acknowledged' AND a.role = 'admin' ORDER BY ce.acknowledged_at DESC LIMIT ?`
    )
    .all(limit);
  for (const r of esc) out.push({ ref: `e${r.id}`, label: `Эскалация: ${require('./labels').tierLabel(r.tier)}`, patient_name: r.patient_name, at: r.acknowledged_at, by: r.by_name });
  if (hasTable('patient_contact_requests')) {
    const rows = db
      .prepare(
        `SELECT pc.id, pc.handled_at, u.full_name AS patient_name, a.full_name AS by_name
         FROM patient_contact_requests pc JOIN users u ON u.id = pc.patient_id JOIN users a ON a.id = pc.handled_by
         WHERE pc.status = 'handled' AND a.role = 'admin' ORDER BY pc.handled_at DESC LIMIT ?`
      )
      .all(limit);
    for (const r of rows) out.push({ ref: `c${r.id}`, label: 'Обращение пациента', patient_name: r.patient_name, at: r.handled_at, by: r.by_name });
  }
  if (hasTable('patient_appeals')) {
    const rows = db
      .prepare(
        `SELECT pa.id, pa.acknowledged_at, u.full_name AS patient_name, a.full_name AS by_name
         FROM patient_appeals pa JOIN users u ON u.id = pa.patient_id JOIN users a ON a.id = pa.acknowledged_by
         WHERE pa.status = 'acknowledged' AND a.role = 'admin' ORDER BY pa.acknowledged_at DESC LIMIT ?`
      )
      .all(limit);
    for (const r of rows) out.push({ ref: `a${r.id}`, label: 'Обращение пациента', patient_name: r.patient_name, at: r.acknowledged_at, by: r.by_name });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

function findOpen(ref) {
  return listOpen().find((x) => x.ref === ref) || null;
}

function acknowledge(adminId, ref) {
  const it = findOpen(ref);
  if (!it) return { ok: false, error: 'Запись не найдена или уже обработана.' };
  db.transaction(() => {
    if (it.kind === 'escalation') {
      escalation.acknowledgeEscalation(it.id, adminId);
      escalation.logIncident(it.id, it.patient_id, 'manual_review_outcome', adminId, { outcome: 'acknowledged_by_admin' });
    } else if (it.kind === 'contact') {
      db.prepare("UPDATE patient_contact_requests SET status = 'handled', handled_by = ?, handled_at = datetime('now') WHERE id = ?").run(adminId, it.id);
    } else {
      db.prepare("UPDATE patient_appeals SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = datetime('now') WHERE id = ?").run(adminId, it.id);
    }
    core.logAdmin(adminId, 'queue_acknowledge', it.patient_id, { ref: it.ref, kind: it.kind });
  })();
  return { ok: true, item: it };
}

/** Передать врачу: привязка пациента к клиницисту; запись остаётся неподтверждённой и появляется в его очереди. */
function handOver(adminId, ref, clinicianId) {
  const it = findOpen(ref);
  if (!it) return { ok: false, error: 'Запись не найдена или уже обработана.' };
  const clin = core.getUser(clinicianId);
  if (!clin || !core.isActiveAccount(clin) || !['psychiatrist', 'psychologist'].includes(clin.role)) {
    return { ok: false, error: 'Выберите активного психиатра или психолога.' };
  }
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO care_assignments (patient_id, clinician_id) VALUES (?, ?)').run(it.patient_id, clin.id);
    db.prepare('UPDATE care_assignments SET archived_at = NULL WHERE patient_id = ? AND clinician_id = ?').run(it.patient_id, clin.id);
    if (it.kind === 'contact') {
      db.prepare('UPDATE patient_contact_requests SET clinician_id = ?, to_admin = 0 WHERE id = ?').run(clin.id, it.id);
    } else if (it.kind === 'appeal') {
      db.prepare("UPDATE patient_appeals SET clinician_id = ?, routed_to = 'clinician' WHERE id = ?").run(clin.id, it.id);
    } else {
      escalation.logIncident(it.id, it.patient_id, 'specialist_notified', adminId, { notified: clin.id, channel: 'in-app, передано администратором' });
    }
    core.logAdmin(adminId, 'queue_handover', it.patient_id, { ref: it.ref, kind: it.kind, clinician_id: clin.id });
    db.prepare('INSERT INTO phi_access_log (actor_id, patient_id, action) VALUES (?, ?, ?)').run(adminId, it.patient_id, 'assignment_add'); // M-4
    require('./patient_prefs').noteCareChange(it.patient_id, 'changed');
  })();
  return { ok: true, item: it, clinician: clin };
}

/** Числа для «Требует решения»: сколько красных/всего. */
function summary() {
  const items = listOpen();
  return { total: items.length, escalations: items.filter((i) => i.kind === 'escalation').length, appeals: items.filter((i) => i.kind !== 'escalation').length };
}

module.exports = { listOpen, countOpen, listHandled, findOpen, acknowledge, handOver, summary, TRIGGER_LABELS };
