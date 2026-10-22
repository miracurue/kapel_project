'use strict';

/**
 * Кризисная очередь клинициста (REQ-CRI-001…010) поверх существующей логики
 * crisisProtocol/escalation (она не менялась) и таблицы patient_appeals.
 *
 * Элемент очереди: { ref:'12'|'a3', kind:'tier'|'appeal', id, tier (эффективный
 * приоритет: appeal = 2, OQ-13 review-required), status, patient_id, patient_name, ... }.
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const escalation = require('./escalation');
const { isBusinessHours, TIERS } = require('./crisisProtocol');
const { parseTs, slaText } = require('./triage_rules');

// Приоритет обращения пациента в очереди и его SLA — review-required (OQ-13).
const APPEAL_EFFECTIVE_TIER = 2;
const SLA_MINUTES = { business: 15, off: 30 }; // справочный текст; фактический срок — crisisProtocol.computeDueAt

function appealDueAt(createdAt) {
  const d = parseTs(createdAt) || new Date();
  const mins = isBusinessHours(d) ? SLA_MINUTES.business : SLA_MINUTES.off;
  return new Date(d.getTime() + mins * 60000).toISOString();
}

function hasTable(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

function contactPhoneExpr() {
  return hasColumn('users', 'contact_phone') ? 'u.contact_phone' : 'NULL';
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function clip(s, n = 200) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** Элементы очереди клинициста: эскалации и обращения его пациентов (включая архивных). */
function listQueue(clinicianId, { ackedLimit = 30 } = {}) {
  const phone = contactPhoneExpr();
  const esc = db.prepare(
    `SELECT DISTINCT ce.*, u.full_name AS patient_name, ${phone} AS contact_phone, 'tier' AS kind,
       (SELECT full_name FROM users b WHERE b.id = ce.backup_notified_id) AS backup_name
     FROM crisis_escalations ce
     JOIN users u ON u.id = ce.patient_id
     JOIN care_assignments ca ON ca.patient_id = ce.patient_id
     WHERE ca.clinician_id = ?`
  ).all(clinicianId).map((r) => ({
    ...r,
    ref: String(r.id), // обращения пациента — «a<id>»
    reasons: safeJson(r.reasons_json, []),
    triggers: safeJson(r.triggers_json, []),
    // Tier 0/1 не требуют немедленного подтверждения, но подтверждаются так же
    effTier: r.tier,
  }));
  let appeals = [];
  if (hasTable('patient_appeals')) {
    appeals = db.prepare(
      `SELECT DISTINCT pa.*, u.full_name AS patient_name, ${phone} AS contact_phone, 'appeal' AS kind
       FROM patient_appeals pa
       JOIN users u ON u.id = pa.patient_id
       JOIN care_assignments ca ON ca.patient_id = pa.patient_id
       WHERE ca.clinician_id = ? AND (pa.routed_to IS NULL OR pa.routed_to = 'clinician')`
    ).all(clinicianId).map((r) => ({
      ...r,
      ref: `a${r.id}`,
      tier: APPEAL_EFFECTIVE_TIER,
      effTier: APPEAL_EFFECTIVE_TIER,
      status: r.status === 'acknowledged' ? 'acknowledged' : 'open',
      due_at: appealDueAt(r.created_at),
      reasons: r.message ? [clip(r.message)] : ['Пациент нажал «Мне сейчас тяжело, сообщить врачу»'],
      triggers: [],
      instrument: 'appeal',
      unresolved: 0,
      escalated_to_backup_at: null,
    }));
  }
  const all = [...esc, ...appeals];
  const open = all
    .filter((x) => x.status === 'open')
    .sort((a, b) => b.effTier - a.effTier || (parseTs(a.due_at)?.getTime() ?? Infinity) - (parseTs(b.due_at)?.getTime() ?? Infinity) ||
      parseTs(b.created_at) - parseTs(a.created_at));
  const acked = all
    .filter((x) => x.status !== 'open')
    .sort((a, b) => (parseTs(b.acknowledged_at) || 0) - (parseTs(a.acknowledged_at) || 0))
    .slice(0, ackedLimit);
  return { open, acked };
}

/** Группировка по пациенту без сокрытия (REQ-CRI-010): порядок групп — по самому приоритетному элементу. */
function groupByPatient(items) {
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.patient_id)) groups.set(it.patient_id, { patient_id: it.patient_id, patient_name: it.patient_name, items: [] });
    groups.get(it.patient_id).items.push(it);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    latest: [...g.items].sort((a, b) => parseTs(b.created_at) - parseTs(a.created_at))[0],
  }));
}

function countOpen(clinicianId) {
  const a = db.prepare(
    `SELECT COUNT(DISTINCT ce.id) AS n FROM crisis_escalations ce
     JOIN care_assignments ca ON ca.patient_id = ce.patient_id
     WHERE ca.clinician_id = ? AND ce.status = 'open'`
  ).get(clinicianId).n;
  let b = 0;
  if (hasTable('patient_appeals')) {
    b = db.prepare(
      `SELECT COUNT(DISTINCT pa.id) AS n FROM patient_appeals pa
       JOIN care_assignments ca ON ca.patient_id = pa.patient_id
       WHERE ca.clinician_id = ? AND pa.status = 'open' AND (pa.routed_to IS NULL OR pa.routed_to = 'clinician')`
    ).get(clinicianId).n;
  }
  return a + b;
}

function getItem(clinicianId, ref) {
  const { open, acked } = listQueue(clinicianId, { ackedLimit: 100000 });
  return [...open, ...acked].find((x) => x.ref === ref) || null;
}

// Расшифровка триггеров — из описания в src/crisisProtocol.js (review-required)
const TRIGGER_LABELS = {
  A: 'C-SSRS: поведение',
  B: 'C-SSRS: идеация 4–5',
  C: 'PHQ-9 пункт 9 ≥1',
  D: 'BDI-II пункт 9 ≥2',
  E: 'свободный текст',
  F: 'самоповреждение (NSSI)',
};

const OUTCOMES = {
  reached: 'дозвонился',
  not_reached: 'не дозвонился',
  visit_scheduled: 'очный приём назначен',
  false_alarm: 'ложное срабатывание',
  other: 'другое',
};

/** Подтверждение «Обработано» (REQ-CRI-004): исход и заметка необязательны. */
function acknowledge(clinicianId, ref, { outcome, note } = {}) {
  const item = getItem(clinicianId, ref);
  if (!item || item.status !== 'open') return null;
  if (item.kind === 'appeal') {
    db.prepare("UPDATE patient_appeals SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = datetime('now') WHERE id = ?")
      .run(clinicianId, item.id);
    return item;
  }
  escalation.acknowledgeEscalation(item.id, clinicianId);
  if (outcome && OUTCOMES[outcome]) {
    db.prepare('UPDATE crisis_escalations SET ack_outcome = ? WHERE id = ?').run(outcome, item.id);
  }
  const cleanNote = note ? clip(String(note).trim(), 500) : '';
  if ((outcome && OUTCOMES[outcome]) || cleanNote) {
    escalation.logIncident(item.id, item.patient_id, 'manual_review_outcome', clinicianId, {
      outcome: OUTCOMES[outcome] ? outcome : null,
      note: cleanNote || null,
    });
  }
  return item;
}

function eventLog(escalationId) {
  return db.prepare(
    `SELECT l.*, u.full_name AS actor_name FROM crisis_incident_log l
     LEFT JOIN users u ON u.id = l.actor_id WHERE l.escalation_id = ? ORDER BY l.id ASC`
  ).all(escalationId).map((r) => ({ ...r, detail: safeJson(r.detail_json, {}) }));
}

// ---------- заглушка канала оповещений (REQ-CRI-008, за интерфейсом) ----------

const NOTIFY_TEXT = 'Оповещения только внутри сервиса: при отсутствии входа в кабинет никто не уведомляется. Круглосуточного дежурства в MVP нет.';

function outboxPath() {
  if (process.env.TDR_OUTBOX_PATH) return process.env.TDR_OUTBOX_PATH;
  const dbPath = process.env.TDR_DB_PATH;
  return path.join(dbPath ? path.dirname(dbPath) : path.join(__dirname, '..', 'data'), 'outbox.log');
}

/** Провайдер-заглушка: строка JSON в outbox.log, без ФИО и текста. Заменяется e-mail/SMS отдельным решением. */
const notifier = {
  name: 'outbox-log-stub',
  send(evt) {
    const file = outboxPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(evt) + '\n', { mode: 0o600 });
  },
};

/** Новые эскалации Tier>=2 (и обращения) -> notifier, один раз; в записи нет ПД. */
function sweepNotifications(now = new Date(), provider = notifier) {
  const rows = db.prepare('SELECT id, tier FROM crisis_escalations WHERE tier >= ? AND stub_notified_at IS NULL').all(TIERS.HIGH);
  for (const r of rows) {
    provider.send({ type: 'escalation', id: r.id, tier: r.tier, at: now.toISOString() });
    db.prepare('UPDATE crisis_escalations SET stub_notified_at = ? WHERE id = ?').run(now.toISOString(), r.id);
  }
  return rows.length;
}

/** Просрочка SLA вне /crisis (REQ-CRI-003): по любому запросу и по таймеру. */
function sweep(now = new Date()) {
  const overdue = escalation.checkOverdueEscalations(now);
  const sent = sweepNotifications(now);
  return { overdue, sent };
}

function middleware(req, res, next) {
  const user = req.session && req.session.user;
  res.locals.crisisOpenCount = 0;
  res.locals.notifyText = NOTIFY_TEXT;
  res.locals.triggerLabel = (t) => (TRIGGER_LABELS[t] ? `${t} — ${TRIGGER_LABELS[t]}` : t);
  res.locals.TRIAGE_DISCLAIMER = require('./triage_rules').DISCLAIMER;
  res.locals.slaText = (due) => slaText(due, new Date());
  if (user && (user.role === 'psychiatrist' || user.role === 'psychologist')) {
    try {
      sweep();
      res.locals.crisisOpenCount = countOpen(user.id);
    } catch (e) {
      console.error('crisis sweep failed', e);
    }
  } else if (user && user.role === 'admin') {
    try { sweep(); } catch (e) { console.error('crisis sweep failed', e); }
  }
  // новые эскалации, созданные этим запросом (пациент прошёл тест) — в outbox сразу после ответа
  res.on('finish', () => { try { sweepNotifications(); } catch (e) { /* журнал оповещений вторичен */ } });
  next();
}

function startTimer(intervalMs = 60000) {
  const t = setInterval(() => { try { sweep(); } catch (e) { console.error('crisis timer failed', e); } }, intervalMs);
  if (t.unref) t.unref();
  return t;
}

module.exports = {
  TRIGGER_LABELS, APPEAL_EFFECTIVE_TIER, SLA_MINUTES, appealDueAt, OUTCOMES, NOTIFY_TEXT,
  listQueue, groupByPatient, countOpen, getItem, acknowledge, eventLog,
  sweep, sweepNotifications, middleware, startTimer, notifier, outboxPath, slaText, clip,
};
