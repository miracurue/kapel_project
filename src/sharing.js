'use strict';

// REQ-PAT-017: что врач видит из дневника пациента. Используется кабинетом врача.
const db = require('./db');
const { getPrefs } = require('./patient_prefs');

/** { sharesScores, sharesNotes, entries } — записи уже отфильтрованы по настройкам пациента. */
function diaryForClinician(patientId, limit = 30) {
  const prefs = getPrefs(patientId);
  const rows = db
    .prepare('SELECT * FROM mood_entries WHERE patient_id = ? ORDER BY COALESCE(entry_date, created_at) DESC, id DESC LIMIT ?')
    .all(patientId, limit);
  const sharesScores = !!prefs.share_diary_scores;
  const sharesNotes = !!prefs.share_diary_notes;
  const entries = [];
  for (const r of rows) {
    const once = !!r.shared_once;
    if (!sharesScores && !once) continue;
    const showText = sharesNotes || once;
    entries.push({
      ...r,
      note: showText ? r.note : null,
      triggers: showText ? r.triggers : null,
      notes_hidden: !showText && !!(r.note || r.triggers),
    });
  }
  return { sharesScores, sharesNotes, entries, hiddenCount: rows.length - entries.length };
}

module.exports = { diaryForClinician };
