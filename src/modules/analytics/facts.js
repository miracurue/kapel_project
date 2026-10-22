'use strict';

// Чтение фактов одного пациента (контур с идентификатором): по праву доступа, не для когорт.

const { analyse, forPatient, forClinician } = require('./interpret');

const SERIES_METRICS = ['mood', 'sleep_score', 'anxiety_score', 'note_present'];

function dailySeries(db, patientId, from, to) {
  const rows = db
    .prepare(
      `SELECT day, metric, value, computed_at FROM analytics_facts
       WHERE patient_id = ? AND day BETWEEN ? AND ? AND metric IN (${SERIES_METRICS.map(() => '?').join(',')})
       ORDER BY day`,
    )
    .all(patientId, from, to, ...SERIES_METRICS);
  const byDay = new Map();
  let updatedAt = null;
  for (const r of rows) {
    const d = byDay.get(r.day) || { day: r.day };
    d[r.metric] = r.value;
    byDay.set(r.day, d);
    if (!updatedAt || r.computed_at > updatedAt) updatedAt = r.computed_at;
  }
  return { days: [...byDay.values()], updatedAt };
}

const shiftDay = (iso, delta) => new Date(Date.parse(`${iso}T00:00:00Z`) + delta * 86400000).toISOString().slice(0, 10);

/** Находки и толкование за окно, заканчивающееся сегодня. */
function patientFindings(db, patientId, today, windowDays) {
  const { days, updatedAt } = dailySeries(db, patientId, shiftDay(today, -(windowDays - 1)), today);
  return { findings: analyse(days, today, windowDays), updated_at: updatedAt };
}

function patientInsights(db, patientId, today, windowDays = 14) {
  const { findings, updated_at } = patientFindings(db, patientId, today, windowDays);
  return { ...forPatient(findings), updated_at };
}

function clinicianInsights(db, patientId, today, windowDays = 14) {
  const { findings, updated_at } = patientFindings(db, patientId, today, windowDays);
  return { ...forClinician(findings), updated_at };
}

module.exports = { dailySeries, patientInsights, clinicianInsights, shiftDay };
