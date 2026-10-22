'use strict';

const { dailySeries, shiftDay } = require('../analytics/facts');
const { scoresVisible } = require('../diary/visibility');

// The caller enforces patient.view_card and records the patient access audit.
function buildOverview(db, patientId, user, current, timezone = 'Europe/Moscow') {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(current));
  const from = shiftDay(today, -13);
  const registered = db.prepare('SELECT created_at FROM users WHERE id=?').get(patientId)?.created_at || null;
  const startedDay = registered
    ? new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(registered))
    : null;
  const crisis = db
    .prepare(
      `SELECT count(*) total,
       COALESCE(sum(CASE WHEN status='new' THEN 1 ELSE 0 END),0) new,
       COALESCE(sum(CASE WHEN status='in_work' THEN 1 ELSE 0 END),0) in_work,
       COALESCE(sum(CASE WHEN status='handled' THEN 1 ELSE 0 END),0) handled
       FROM crisis_escalations WHERE patient_id=?`,
    )
    .get(patientId);
  // A repeat can be appended to an existing escalation. Count each occurrence;
  // legacy escalations without an incident log still represent one occurrence.
  const occurrences = db
    .prepare(
      `SELECT count(*) + COALESCE(sum((SELECT count(*) FROM crisis_incident_log cl
       WHERE cl.escalation_id=ce.id AND cl.event_type='appended')),0) n
       FROM crisis_escalations ce WHERE ce.patient_id=?`,
    )
    .get(patientId).n;
  const nextVisit =
    db
      .prepare(
        `SELECT id,starts_at,format,place FROM visits
       WHERE patient_id=? AND status='scheduled' AND julianday(starts_at)>=julianday(?)
       ORDER BY julianday(starts_at),id LIMIT 1`,
      )
      .get(patientId, current) || null;
  const ae =
    user.role === 'psychiatrist'
      ? db
          .prepare(
            `SELECT id,status,description_enc text,created_at FROM adverse_events
       WHERE patient_id=? AND psychiatrist_id=? AND status NOT IN ('draft','cancelled')
       AND (visible_from IS NULL OR visible_from<=?) ORDER BY created_at DESC,id DESC`,
          )
          .all(patientId, user.id, current)
      : null;
  const ownMeds =
    user.role === 'psychiatrist'
      ? db
          .prepare(
            `SELECT pm.id,pv.dose_value dose,pv.dose_unit unit,pv.times_json,dp.trade_name,i.name inn_name
       FROM patient_meds pm JOIN patient_med_versions pv ON pv.patient_med_id=pm.id AND pv.version=pm.current_version
       JOIN drug_products dp ON dp.id=pv.product_id JOIN inn i ON i.id=pv.inn_id
       WHERE pm.patient_id=? AND pm.status='active' AND pm.hidden_at IS NULL
       AND (pv.end_date IS NULL OR pv.end_date>=?) ORDER BY pm.id`,
          )
          .all(patientId, today)
          .map(({ times_json, ...m }) => ({ ...m, times: JSON.parse(times_json || '[]') }))
      : null;
  return {
    as_of: current,
    timezone,
    today,
    registered_at: registered,
    days_in_system: startedDay
      ? Math.max(0, Math.round((Date.parse(today) - Date.parse(startedDay)) / 86400000))
      : null,
    diary: {
      from,
      to: today,
      days: (scoresVisible(db, patientId, user) ? dailySeries(db, patientId, from, today).days : []).map(
        ({ day, mood, sleep_score, anxiety_score }) => ({
          day,
          mood,
          sleep_score,
          anxiety_score,
        }),
      ),
    },
    crisis: { ...crisis, occurrences, active: crisis.new + crisis.in_work },
    adverse_events: ae
      ? {
          total: ae.length,
          pending: ae.filter((a) => ['submitted', 'awaiting_doctor', 'service_queue'].includes(a.status)).length,
          latest: ae.slice(0, 3),
        }
      : null,
    patient_meds: ownMeds,
    next_visit: nextVisit,
  };
}

module.exports = { buildOverview };
