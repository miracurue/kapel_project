'use strict';

function load(db, patientId, includeArchived = false) {
  const habits = db
    .prepare('SELECT * FROM diary_habits WHERE patient_id=? ORDER BY habit_id')
    .all(patientId)
    .filter((h) => includeArchived || !h.archived_at);
  const state = { habits: [], entries: {}, dayNotes: [] };
  for (const h of habits) {
    const row = db
      .prepare('SELECT definition_json FROM diary_habit_versions WHERE patient_id=? AND habit_id=? AND version=?')
      .get(patientId, h.habit_id, h.current_version);
    state.habits.push(JSON.parse(row.definition_json));
    const dates = {};
    for (const v of db
      .prepare(
        'SELECT day,value_json FROM diary_habit_values WHERE patient_id=? AND habit_id=? AND hidden_at IS NULL ORDER BY day,ordinal',
      )
      .all(patientId, h.habit_id))
      (dates[v.day] ||= []).push(JSON.parse(v.value_json));
    state.entries[h.habit_id] = dates;
  }
  state.dayNotes = db
    .prepare('SELECT note_id id,day,text,shared FROM diary_day_notes WHERE patient_id=? ORDER BY day,note_id')
    .all(patientId)
    .map((n) => ({ ...n, shared: !!n.shared }));
  return state;
}
function persist(db, patientId, state, before, today, timestamp) {
  for (const old of before.habits)
    if (!state.habits.some((h) => h.id === old.id))
      db.prepare('UPDATE diary_habits SET archived_at=? WHERE patient_id=? AND habit_id=?').run(
        timestamp,
        patientId,
        old.id,
      );
  for (const h of state.habits) {
    const previous = db
      .prepare(
        'SELECT h.current_version,h.archived_at,v.definition_json FROM diary_habits h JOIN diary_habit_versions v ON v.patient_id=h.patient_id AND v.habit_id=h.habit_id AND v.version=h.current_version WHERE h.patient_id=? AND h.habit_id=?',
      )
      .get(patientId, h.id);
    if (previous?.archived_at) throw new Error('history');
    const definition = JSON.stringify(h);
    const version = previous ? previous.current_version + (previous.definition_json !== definition ? 1 : 0) : 1;
    if (!previous)
      db.prepare('INSERT INTO diary_habits(patient_id,habit_id,current_version) VALUES (?,?,?)').run(
        patientId,
        h.id,
        version,
      );
    if (!previous || version !== previous.current_version) {
      db.prepare(
        'INSERT INTO diary_habit_versions(patient_id,habit_id,version,definition_json,created_at) VALUES (?,?,?,?,?)',
      ).run(patientId, h.id, version, definition, timestamp);
      db.prepare('UPDATE diary_habits SET current_version=? WHERE patient_id=? AND habit_id=?').run(
        version,
        patientId,
        h.id,
      );
    }
    const values = state.entries[h.id]?.[today] || [];
    const oldValues = before.entries[h.id]?.[today] || [];
    // Preserve provenance for unchanged measurements when settings/sharing change.
    if (JSON.stringify(values) !== JSON.stringify(oldValues)) {
      for (let ordinal = 0; ordinal < Math.max(oldValues.length, values.length); ordinal += 1) {
        if (JSON.stringify(oldValues[ordinal]) === JSON.stringify(values[ordinal])) continue;
        db.prepare(
          'UPDATE diary_habit_values SET hidden_at=? WHERE patient_id=? AND habit_id=? AND day=? AND ordinal=? AND hidden_at IS NULL',
        ).run(timestamp, patientId, h.id, today, ordinal);
        if (ordinal < values.length)
          db.prepare(
            'INSERT INTO diary_habit_values(patient_id,habit_id,version,day,ordinal,value_json,measured_at,recorded_at) VALUES (?,?,?,?,?,?,NULL,?)',
          ).run(patientId, h.id, version, today, ordinal, JSON.stringify(values[ordinal]), timestamp);
      }
    }
  }
  const existing = db.prepare('SELECT * FROM diary_day_notes WHERE patient_id=?').all(patientId);
  for (const old of existing) {
    const n = state.dayNotes.find((n) => n.id === old.note_id);
    if (n && n.day === old.day && n.text === old.text && Number(n.shared) === old.shared) continue;
    db.prepare(
      'INSERT INTO diary_note_revisions(patient_id,note_id,day,text,shared,created_at,superseded_at) VALUES (?,?,?,?,?,?,?)',
    ).run(patientId, old.note_id, old.day, old.text, old.shared, old.created_at, timestamp);
    db.prepare('DELETE FROM diary_day_notes WHERE patient_id=? AND note_id=?').run(patientId, old.note_id);
  }
  for (const n of state.dayNotes)
    if (!db.prepare('SELECT 1 FROM diary_day_notes WHERE patient_id=? AND note_id=?').get(patientId, n.id))
      db.prepare(
        'INSERT INTO diary_day_notes(patient_id,note_id,day,text,shared,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      ).run(
        patientId,
        n.id,
        n.day,
        n.text,
        Number(n.shared),
        existing.find((o) => o.note_id === n.id)?.created_at || timestamp,
        timestamp,
      );
}
function exportData(db, patientId) {
  return {
    ...load(db, patientId, true),
    note_history: db.prepare('SELECT * FROM diary_note_revisions WHERE patient_id=? ORDER BY id').all(patientId),
    definitions: db
      .prepare('SELECT * FROM diary_habit_versions WHERE patient_id=? ORDER BY habit_id,version')
      .all(patientId),
    measurements: db
      .prepare('SELECT * FROM diary_habit_values WHERE patient_id=? ORDER BY habit_id,day,ordinal')
      .all(patientId),
    tracking: db.prepare('SELECT * FROM diary_habits WHERE patient_id=? ORDER BY habit_id').all(patientId),
  };
}
module.exports = { load, persist, exportData };
