'use strict';

/**
 * Мягкие напоминания «кому пора повторить тест» (REQ-TLS-006). Необязательные: ничего не блокируют, не красные,
 * можно отложить. Интервал — настройка врача (по умолчанию DEFAULT_DAYS; значение review-required, клинических норм нет).
 */

const db = require('../db');
const card = require('../patient_card');
const triage = require('../triage_data');
const { INSTRUMENTS } = require('../instruments');

const DEFAULT_DAYS = 28;
const CHOICES = [14, 28, 56, 84];
const SNOOZE_DAYS = 30;
const DAY = 86400000;

function parseDays(v) {
  const n = Number(v);
  return CHOICES.includes(n) ? n : DEFAULT_DAYS;
}

/** [{patient:{id,full_name}, items:[{code, lastDate, days}]}] — только закреплённые, согласившиеся, не архивные, не отложенные. */
function due(clinicianId, { days = DEFAULT_DAYS, now = new Date() } = {}) {
  const snoozed = new Map(db.prepare('SELECT patient_id, until FROM tool_repeat_snoozes WHERE clinician_id = ?').all(clinicianId).map((r) => [r.patient_id, r.until]));
  const out = [];
  for (const p of triage.listPatients(clinicianId, { now }).patients) {
    if (p.archived || !p.clinical_consent_given || p.account_status !== 'active') continue;
    const until = snoozed.get(p.id);
    if (until && new Date(until) > now) continue;
    const pending = new Set(db.prepare("SELECT instrument FROM instrument_assignments WHERE patient_id = ? AND status IN ('pending','waiting_entry')").all(p.id).map((r) => r.instrument));
    const last = new Map();
    for (const r of card.gatherResults(p.id, { consentOk: true })) {
      if (r.stub || !INSTRUMENTS[r.instrument] || r.instrument === 'cssrs') continue;
      last.set(r.instrument, r); // ряд отсортирован по времени
    }
    const items = [];
    for (const [code, r] of last) {
      if (pending.has(code)) continue;
      const d = Math.floor((now.getTime() - r.atMs) / DAY);
      if (d >= days) items.push({ code, lastDate: String(r.at).slice(0, 10), days: d });
    }
    if (items.length) out.push({ patient: { id: p.id, full_name: p.full_name }, items: items.sort((a, b) => b.days - a.days) });
  }
  return out.sort((a, b) => b.items[0].days - a.items[0].days);
}

function snooze(clinicianId, patientId, now = new Date()) {
  if (!db.prepare('SELECT 1 FROM care_assignments WHERE clinician_id = ? AND patient_id = ?').get(clinicianId, patientId)) return false;
  db.prepare('INSERT INTO tool_repeat_snoozes (clinician_id, patient_id, until) VALUES (?, ?, ?) ON CONFLICT(clinician_id, patient_id) DO UPDATE SET until = excluded.until')
    .run(clinicianId, patientId, new Date(now.getTime() + SNOOZE_DAYS * DAY).toISOString());
  return true;
}

module.exports = { due, snooze, parseDays, DEFAULT_DAYS, CHOICES, SNOOZE_DAYS };
