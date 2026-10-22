'use strict';

/**
 * Сбор снимков данных для светофора (src/triage_rules.js) и список пациентов
 * клинициста: поиск, фильтры, теги, архив, отложенные флаги. Только чтение
 * данных пациентов, закреплённых за клиницистом (care_assignments).
 */

const db = require('./db');
const catalog = require('./instruments_catalog');
const { INSTRUMENTS } = require('./instruments');
const rules = require('./triage_rules');
const crisisQueue = require('./crisis_queue');
const { parseTs, DAY } = rules;

const SNOOZE_DEFAULT_DAYS = 7;

// поиск без учёта регистра и ё/е
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();

function bandsFor(code) {
  return INSTRUMENTS[code] && INSTRUMENTS[code].bands ? INSTRUMENTS[code].bands : null;
}

function hasTable(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function subs(r) {
  if (r.instrument !== 'hads' || !r.subscales_json) return null;
  try { return JSON.parse(r.subscales_json); } catch (e) { return null; }
}

function snapshotFor(patient, now, cfg) {
  const pid = patient.id;
  const online = db.prepare('SELECT id, instrument, total_score, subscales_json, created_at FROM online_results WHERE patient_id = ?').all(pid);
  const offline = db.prepare('SELECT id, instrument, total_score, subscales_json, test_date, created_at FROM offline_results WHERE patient_id = ? AND total_score IS NOT NULL AND invalid_at IS NULL').all(pid);
  const results = [
    ...online.map((r) => ({ id: `o${r.id}`, instrument: r.instrument, total: r.total_score, at: r.created_at, bands: bandsFor(r.instrument), subscales: subs(r), stub: catalog.isStub(r.instrument) })),
    ...offline.map((r) => ({ id: `f${r.id}`, instrument: r.instrument, total: r.total_score, at: r.test_date || r.created_at, bands: bandsFor(r.instrument), subscales: subs(r), stub: catalog.isStub(r.instrument) })),
  ];
  const pending = db
    .prepare("SELECT id, instrument, assigned_at FROM instrument_assignments WHERE patient_id = ? AND status = 'pending'")
    .all(pid)
    .map((p) => ({ ...p, stub: catalog.isStub(p.instrument) }));

  const windowStart = new Date(now.getTime() - cfg.adherenceWindowDays * DAY).toISOString();
  const wnd = db
    .prepare("SELECT instrument, status, assigned_at FROM instrument_assignments WHERE patient_id = ? AND status IN ('pending','completed')")
    .all(pid)
    .filter((a) => !catalog.isStub(a.instrument) && (parseTs(a.assigned_at) || 0) >= new Date(windowStart));

  const moodLast = db.prepare('SELECT MAX(created_at) AS t FROM mood_entries WHERE patient_id = ?').get(pid).t;
  const chatLast = db
    .prepare(
      `SELECT MAX(m.created_at) AS t FROM chatbot_messages m JOIN chatbot_sessions s ON s.id = m.session_id
       WHERE s.patient_id = ? AND m.sender = 'user'`
    )
    .get(pid).t;
  const times = [
    ...results.filter((r) => !r.stub && r.id.startsWith('o')).map((r) => parseTs(r.at)),
    parseTs(moodLast),
    parseTs(chatLast),
  ].filter(Boolean);
  const lastActivityAt = times.length ? new Date(Math.max(...times.map((d) => d.getTime()))).toISOString() : null;

  const open = db.prepare("SELECT id, tier, due_at, unresolved FROM crisis_escalations WHERE patient_id = ? AND status = 'open'").all(pid)
    .map((e) => ({ ...e, kind: 'tier' }));
  if (hasTable('patient_appeals')) {
    const ap = db.prepare("SELECT id, created_at FROM patient_appeals WHERE patient_id = ? AND status = 'open' AND (routed_to IS NULL OR routed_to = 'clinician')").all(pid);
    for (const a of ap) {
      open.push({ id: a.id, tier: crisisQueue.APPEAL_EFFECTIVE_TIER, kind: 'appeal', due_at: crisisQueue.appealDueAt(a.created_at), unresolved: 0 });
    }
  }

  // W2.F: приём по плану учитывается только при включённом конфиге и если пациент делится журналом приёма
  let meds = null;
  if (cfg.medAdherenceEnabled && patient.clinical_consent_given && patient.account_status === 'active') {
    const v = require('./care/meds').clinicianView(pid, true);
    meds = v.adherence;
  }

  return {
    meds,
    consent: { clinical: !!patient.clinical_consent_given, active: patient.account_status === 'active' },
    openEscalations: open,
    results,
    pending,
    assignedInWindow: wnd.length,
    completedInWindow: wnd.filter((a) => a.status === 'completed').length,
    lastActivityAt,
    hasDiary: !!moodLast,
  };
}

/** Применить отложенный жёлтый флаг (REQ-CLN-004). Красный не откладывается. */
function applySnooze(verdict, snooze, now) {
  if (!snooze || verdict.color !== 'yellow') return verdict;
  const until = parseTs(snooze.until);
  if (!until || until <= now) return verdict;
  const known = new Set(JSON.parse(snooze.keys_json || '[]'));
  const fresh = verdict.reasons.filter((r) => !known.has(r.key));
  if (fresh.length) return verdict; // новое ухудшение/причина — флаг возвращается
  const g = rules.COLORS.green;
  return {
    ...verdict,
    color: 'green', word: g.word, icon: g.icon, rank: g.rank,
    snoozedUntil: snooze.until,
    oneLine: `Флаг отложен до ${snooze.until.slice(0, 10)}: ${verdict.oneLine}`,
    why: `Отложено до ${snooze.until.slice(0, 10)}. Исходные причины: ${verdict.why}`,
  };
}

/**
 * Пациенты клинициста со светофором. opts: {q, status, tag, archived:'only'|'all'|undefined, now, config}
 */
function listPatients(clinicianId, opts = {}) {
  const now = opts.now || new Date();
  const cfg = { ...rules.CONFIG, ...(opts.config || {}) };
  const rows = db
    .prepare(
      `SELECT u.id, u.full_name, u.email, u.clinical_consent_given, u.account_status, ca.archived_at, ca.created_at AS assigned_at
       FROM care_assignments ca JOIN users u ON u.id = ca.patient_id
       WHERE ca.clinician_id = ? ORDER BY u.full_name`
    )
    .all(clinicianId);
  const tagRows = db.prepare('SELECT patient_id, tag FROM patient_tags WHERE clinician_id = ? ORDER BY tag').all(clinicianId);
  const tagsBy = new Map();
  for (const t of tagRows) {
    if (!tagsBy.has(t.patient_id)) tagsBy.set(t.patient_id, []);
    tagsBy.get(t.patient_id).push(t.tag);
  }
  const snoozes = new Map(db.prepare('SELECT * FROM triage_snoozes WHERE clinician_id = ?').all(clinicianId).map((s) => [s.patient_id, s]));
  const coClin = db.prepare(
    `SELECT ca.patient_id, u.full_name FROM care_assignments ca JOIN users u ON u.id = ca.clinician_id
     WHERE ca.patient_id IN (SELECT patient_id FROM care_assignments WHERE clinician_id = ?) AND ca.clinician_id != ?`
  ).all(clinicianId, clinicianId);
  const coBy = new Map();
  for (const c of coClin) {
    if (!coBy.has(c.patient_id)) coBy.set(c.patient_id, []);
    coBy.get(c.patient_id).push(c.full_name);
  }

  let out = rows.map((p) => {
    const verdict = applySnooze(rules.evaluate(snapshotFor(p, now, cfg), now, cfg), snoozes.get(p.id), now);
    return { ...p, archived: !!p.archived_at, tags: tagsBy.get(p.id) || [], verdict, alsoWith: coBy.get(p.id) || [] };
  });

  const allTags = [...new Set(tagRows.map((t) => t.tag))].sort();
  const q = norm(opts.q);
  if (opts.archived === 'only') out = out.filter((p) => p.archived);
  else if (opts.archived !== 'all') out = out.filter((p) => !p.archived || p.verdict.color === 'red');
  if (q) out = out.filter((p) => norm(p.full_name).includes(q));
  if (opts.status) out = out.filter((p) => p.verdict.color === opts.status);
  if (opts.tag) out = out.filter((p) => p.tags.includes(opts.tag));

  out.sort((a, b) => a.verdict.rank - b.verdict.rank || b.verdict.reasons.length - a.verdict.reasons.length || a.full_name.localeCompare(b.full_name, 'ru'));
  return { patients: out, allTags };
}

/** Счётчики по цветам (по всем неархивным, до фильтров). */
function counts(patients) {
  const c = { red: 0, yellow: 0, gray: 0, green: 0 };
  for (const p of patients) c[p.verdict.color] += 1;
  return c;
}

function snooze(clinicianId, patientId, verdict, days = SNOOZE_DEFAULT_DAYS, now = new Date()) {
  const until = new Date(now.getTime() + days * DAY).toISOString();
  db.prepare(
    `INSERT INTO triage_snoozes (clinician_id, patient_id, until, keys_json) VALUES (?, ?, ?, ?)
     ON CONFLICT(clinician_id, patient_id) DO UPDATE SET until = excluded.until, keys_json = excluded.keys_json`
  ).run(clinicianId, patientId, until, JSON.stringify(verdict.reasons.map((r) => r.key)));
  return until;
}

/** Светофор одного закреплённого пациента (для шапки карточки); null — не закреплён. */
function verdictFor(clinicianId, patientId, now = new Date()) {
  const row = listPatients(clinicianId, { archived: 'all', now }).patients.find((p) => p.id === Number(patientId));
  return row || null;
}

module.exports = { verdictFor, listPatients, counts, snooze, snapshotFor, applySnooze, norm, SNOOZE_DEFAULT_DAYS };
