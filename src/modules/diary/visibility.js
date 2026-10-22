'use strict';
// Apply on each read, including previously attached context chips.
function scoresVisible(db, patientId, actor) {
  if (actor?.role === 'patient' && actor.id === patientId) return true;
  return (
    ['psychiatrist', 'psychologist'].includes(actor?.role) &&
    db.prepare('SELECT share_diary_scores FROM user_prefs WHERE user_id=?').get(patientId)?.share_diary_scores !== 0
  );
}
function notesVisible(db, patientId, actor) {
  if (actor?.role === 'patient' && actor.id === patientId) return true;
  return (
    ['psychiatrist', 'psychologist'].includes(actor?.role) &&
    db.prepare('SELECT share_diary_notes FROM user_prefs WHERE user_id=?').get(patientId)?.share_diary_notes === 1
  );
}
function redactEntry(db, patientId, actor, entry) {
  const result = { ...entry };
  if (!scoresVisible(db, patientId, actor))
    for (const key of ['mood', 'sleep', 'anxiety', 'legacy_sleep_hours', 'sleepHours', 'sleepQuality'])
      delete result[key];
  const perNote = entry.id
    ? db
        .prepare('SELECT shared FROM diary_day_notes WHERE patient_id=? AND note_id=?')
        .get(patientId, `legacy-${entry.id}`)
    : null;
  const own = actor?.role === 'patient' && actor.id === patientId;
  if (
    !own &&
    (!['psychiatrist', 'psychologist'].includes(actor?.role) ||
      (perNote ? perNote.shared !== 1 : !notesVisible(db, patientId, actor)))
  )
    for (const key of ['note', 'triggers', 'triggers_json']) delete result[key];
  return result;
}
module.exports = { scoresVisible, notesVisible, redactEntry };
