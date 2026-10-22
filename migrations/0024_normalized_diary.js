'use strict';

// Atomic schema + bounded transfer: each INSERT batch contains at most 500 measurements.
module.exports = function migrate(db) {
  db.exec(`
-- Definitions are versioned; repeated measurements retain order and unknown historical time.
CREATE TABLE diary_habits (
 patient_id INTEGER NOT NULL REFERENCES users(id), habit_id TEXT NOT NULL,
 current_version INTEGER NOT NULL CHECK(current_version>0), archived_at TEXT,
 PRIMARY KEY(patient_id,habit_id),
 FOREIGN KEY(patient_id,habit_id,current_version) REFERENCES diary_habit_versions(patient_id,habit_id,version) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;
CREATE TABLE diary_habit_versions (
 patient_id INTEGER NOT NULL, habit_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
 definition_json TEXT NOT NULL CHECK(json_valid(definition_json)), created_at TEXT NOT NULL,
 type TEXT GENERATED ALWAYS AS (json_extract(definition_json,'$.type')) STORED NOT NULL,
 unit TEXT GENERATED ALWAYS AS (COALESCE(json_extract(definition_json,'$.unit'),'')) STORED NOT NULL,
 PRIMARY KEY(patient_id,habit_id,version),
 FOREIGN KEY(patient_id,habit_id) REFERENCES diary_habits(patient_id,habit_id) DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;
CREATE TABLE diary_habit_values (
 id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL, habit_id TEXT NOT NULL, version INTEGER NOT NULL,
 day TEXT NOT NULL CHECK(length(day)=10 AND date(day)=day), ordinal INTEGER NOT NULL CHECK(ordinal>=0), value_json TEXT NOT NULL CHECK(json_valid(value_json)),
 measured_at TEXT, recorded_at TEXT NOT NULL, hidden_at TEXT,
 value_kind TEXT GENERATED ALWAYS AS (json_type(value_json)) STORED CHECK(value_kind IN ('integer','real','text','true','false')),
 value_number REAL GENERATED ALWAYS AS (CASE WHEN json_type(value_json) IN ('integer','real') THEN json_extract(value_json,'$') END) STORED,
 value_text TEXT GENERATED ALWAYS AS (CASE WHEN json_type(value_json)='text' THEN json_extract(value_json,'$') END) STORED,
 value_bool INTEGER GENERATED ALWAYS AS (CASE WHEN json_type(value_json) IN ('true','false') THEN json_extract(value_json,'$') END) STORED,

 FOREIGN KEY(patient_id,habit_id,version) REFERENCES diary_habit_versions(patient_id,habit_id,version) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX idx_diary_values_day ON diary_habit_values(day,patient_id,habit_id);
CREATE INDEX idx_diary_values_patient ON diary_habit_values(patient_id,habit_id,day);
CREATE UNIQUE INDEX idx_diary_values_current ON diary_habit_values(patient_id,habit_id,day,ordinal) WHERE hidden_at IS NULL;
CREATE TRIGGER diary_definition_immutable BEFORE UPDATE ON diary_habit_versions BEGIN SELECT RAISE(ABORT,'immutable definition'); END;
CREATE TRIGGER diary_value_preserve BEFORE UPDATE OF value_json,version,day,ordinal,recorded_at ON diary_habit_values BEGIN SELECT RAISE(ABORT,'immutable measurement'); END;
CREATE TABLE diary_day_notes (
 patient_id INTEGER NOT NULL REFERENCES users(id), note_id TEXT NOT NULL, day TEXT NOT NULL CHECK(length(day)=10 AND date(day)=day),
 text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), shared INTEGER NOT NULL CHECK(shared IN (0,1)),
 PRIMARY KEY(patient_id,note_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE diary_note_revisions (
 id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES users(id), note_id TEXT NOT NULL,
 day TEXT NOT NULL, text TEXT NOT NULL, shared INTEGER NOT NULL CHECK(shared IN (0,1)),
 created_at TEXT NOT NULL, superseded_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_diary_notes_day ON diary_day_notes(patient_id,day);
`);
  const rows = db.prepare('SELECT patient_id,state_json,updated_at FROM diary_workspaces').all();
  const values = db.prepare(
    'INSERT INTO diary_habit_values(patient_id,habit_id,version,day,ordinal,value_json,measured_at,recorded_at) VALUES (?,?,1,?,?,?,NULL,?)',
  );
  const insertBatch = (batch) => {
    for (const args of batch) values.run(...args);
  };
  for (const row of rows) {
    const state = JSON.parse(row.state_json);
    for (const h of state.habits || []) {
      db.prepare('INSERT INTO diary_habits(patient_id,habit_id,current_version) VALUES (?,?,1)').run(
        row.patient_id,
        h.id,
      );
      db.prepare(
        'INSERT INTO diary_habit_versions(patient_id,habit_id,version,definition_json,created_at) VALUES (?,?,1,?,?)',
      ).run(row.patient_id, h.id, JSON.stringify(h), row.updated_at);
    }
    let batch = [];
    for (const [id, dates] of Object.entries(state.entries || {}))
      for (const [day, entries] of Object.entries(dates))
        for (const [ordinal, value] of entries.entries()) {
          batch.push([row.patient_id, id, day, ordinal, JSON.stringify(value), row.updated_at]);
          if (batch.length === 500) {
            insertBatch(batch);
            batch = [];
          }
        }
    insertBatch(batch);
    for (const n of state.dayNotes || [])
      db.prepare(
        'INSERT INTO diary_day_notes(patient_id,note_id,day,text,shared,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      ).run(row.patient_id, n.id, n.day, n.text, Number(n.shared), row.updated_at, row.updated_at);
    for (const [day, w] of Object.entries(state.wellbeings || {}))
      if (!db.prepare('SELECT 1 FROM mood_entries WHERE patient_id=? AND entry_date=?').get(row.patient_id, day))
        db.prepare(
          'INSERT INTO mood_entries(patient_id,entry_date,mood,anxiety,sleep,legacy_sleep_hours,triggers_json,created_at) VALUES (?,?,?,?,?,?,?,?)',
        ).run(
          row.patient_id,
          day,
          w.mood ?? null,
          { 0: 'none', 1: 'some', 2: 'strong' }[w.anxiety] ?? null,
          { 1: 'bad', 2: 'ok', 3: 'good' }[w.sleepQuality] ?? null,
          w.sleepHours ?? null,
          '[]',
          row.updated_at,
        );
    db.prepare('UPDATE diary_workspaces SET state_json=? WHERE patient_id=?').run(
      JSON.stringify({ reminder: state.reminder }),
      row.patient_id,
    );
  }
};
