'use strict';

// Read medication schedules from the version that applied on each date. Missing
// marks remain unknown; a changed current dose is never projected into history.
function getMedicationDays(db, patientId, today, timezone = 'Europe/Moscow', currentIso = new Date().toISOString()) {
  const dates = new Map();
  const dateOf = (value) => {
    if (!value || value.length === 10) return value;
    if (dates.has(value)) return dates.get(value);
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(value));
    dates.set(value, date);
    return date;
  };
  const plans = db
    .prepare(
      "SELECT * FROM plan_versions WHERE patient_id=? AND status IN ('published','superseded') AND (visible_from IS NULL OR visible_from<=?) ORDER BY version",
    )
    .all(patientId, currentIso);
  const items = db
    .prepare(
      'SELECT pi.*,i.name FROM plan_items pi JOIN plan_versions pv ON pv.id=pi.plan_version_id JOIN inn i ON i.id=pi.inn_id WHERE pv.patient_id=?',
    )
    .all(patientId);
  const acceptances = db.prepare('SELECT * FROM plan_item_acceptance WHERE patient_id=?').all(patientId);
  const own = db
    .prepare(
      'SELECT pm.id medication_id,pm.created_at medication_created,pm.ended_at,pm.hidden_at,pv.*,dp.trade_name name FROM patient_meds pm JOIN patient_med_versions pv ON pv.patient_med_id=pm.id JOIN drug_products dp ON dp.id=pv.product_id WHERE pm.patient_id=? ORDER BY pv.version',
    )
    .all(patientId);
  const logs = db
    .prepare('SELECT * FROM med_log WHERE patient_id=? AND hidden_at IS NULL AND day<=? ORDER BY id')
    .all(patientId, today);
  const effective = (p) => dateOf(p.visible_from || p.published_at || p.created_at);
  const starts = [
    ...plans.map(effective),
    ...own.map((m) => dateOf(m.medication_created)),
    ...logs.map((m) => m.day),
  ].filter((d) => d <= today);
  const result = {};
  if (!starts.length) return result;
  const first = starts.sort()[0];
  const cursor = new Date(`${first}T12:00:00Z`);
  const add = (day, row, target, key) => {
    const marks = logs.filter((m) => m.day === day && (key ? m.item_key === key : m.patient_med_id === target.id));
    const times = JSON.parse(row.times_json || '[]');
    const slots = [...new Set([...(times.length ? times : ['any']), ...marks.map((m) => m.slot)])];
    for (const slot of slots) {
      const mark = marks.find((m) => m.slot === slot);
      (result[day] ||= []).push({
        target,
        ...(key ? { item_key: key } : {}),
        name: row.name,
        dose: row.dose_value,
        unit: row.dose_unit,
        slot,
        legacy: slot === 'any' && times.some((time) => time !== 'any'),
        status: mark?.status || 'unknown',
      });
    }
  };
  while (cursor.toISOString().slice(0, 10) <= today) {
    const day = cursor.toISOString().slice(0, 10);
    const plan = plans.filter((p) => effective(p) <= day).at(-1);
    if (plan) {
      for (const item of items.filter((i) => i.plan_version_id === plan.id)) {
        const acceptance = acceptances.find(
          (a) =>
            a.item_key === item.item_key && dateOf(a.accepted_at) <= day && (!a.hidden_at || dateOf(a.hidden_at) > day),
        );
        if (
          acceptance &&
          (!item.start_date || item.start_date <= day) &&
          (!item.end_date || item.end_date >= day) &&
          (item.status === 'active' || item.end_date >= day)
        ) {
          add(day, item, { type: 'plan_item', id: item.id }, item.item_key);
        }
      }
    }
    for (const id of new Set(own.map((m) => m.medication_id))) {
      const row = own.filter((m) => m.medication_id === id && dateOf(m.created_at) <= day).at(-1);
      if (
        row &&
        (!row.hidden_at || dateOf(row.hidden_at) > day) &&
        dateOf(row.medication_created) <= day &&
        (!row.ended_at || dateOf(row.ended_at) >= day) &&
        (!row.end_date || row.end_date >= day)
      ) {
        add(day, row, { type: 'patient_med', id });
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  // A plan can remove a medicine after a mark was made that same day. Keep
  // that recorded event visible with its historical version, not today's dose.
  for (const log of logs) {
    const represented = (result[log.day] || []).some(
      (row) =>
        row.slot === log.slot &&
        (log.item_key
          ? row.item_key === log.item_key
          : row.target.type === 'patient_med' && row.target.id === log.patient_med_id),
    );
    if (represented) continue;
    let row;
    let target;
    if (log.item_key) {
      const plan = plans
        .filter(
          (p) =>
            effective(p) <= log.day && items.some((i) => i.plan_version_id === p.id && i.item_key === log.item_key),
        )
        .at(-1);
      row = plan && items.find((i) => i.plan_version_id === plan.id && i.item_key === log.item_key);
      if (row) target = { type: 'plan_item', id: row.id };
    } else {
      row = own.filter((m) => m.medication_id === log.patient_med_id && dateOf(m.created_at) <= log.day).at(-1);
      if (row) target = { type: 'patient_med', id: log.patient_med_id };
    }
    if (row)
      (result[log.day] ||= []).push({
        target,
        ...(log.item_key ? { item_key: log.item_key } : {}),
        name: row.name,
        dose: row.dose_value,
        unit: row.dose_unit,
        slot: log.slot,
        legacy: log.slot === 'any' && JSON.parse(row.times_json || '[]').some((time) => time !== 'any'),
        status: log.status,
      });
  }
  return result;
}

module.exports = { getMedicationDays };
