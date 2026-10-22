'use strict';

// Настройки пользователя (user_prefs): тема, шрифт, «что видит врач», онбординг,
// метка недействительности старых сессий (смена пароля, REQ-SEC-012).

const db = require('./db');

const DEFAULTS = {
  onboarding_pending: 0,
  share_diary_scores: 1, // OQ-2: оценки видны врачу
  share_diary_notes: 0, // заметки по умолчанию не делятся
  share_ai_chats: 0,
  share_med_log: 1, // журнал приёма по плану врача виден врачу (review-required)
  share_med_own: 0, // личный список препаратов пациента врачу не виден, пока не разрешено
  theme: 'auto',
  large_font: 0,
  sessions_valid_from: 0,
  last_seen_at: null,
  had_clinician: 0,
};

function getPrefs(userId) {
  const row = db.prepare('SELECT * FROM user_prefs WHERE user_id = ?').get(userId);
  return row ? row : { user_id: userId, ...DEFAULTS };
}

function setPrefs(userId, patch) {
  db.prepare('INSERT OR IGNORE INTO user_prefs (user_id) VALUES (?)').run(userId);
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db.prepare(`UPDATE user_prefs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE user_id = ?`).run(...keys.map((k) => patch[k]), userId);
}

// D7: запомнить, что связь с врачом изменилась ('changed' — другой врач, 'ended' — наблюдение завершено).
function noteCareChange(patientId, kind) {
  setPrefs(patientId, { care_change_kind: kind, care_change_at: new Date().toISOString() });
}
function clearCareChange(patientId) {
  setPrefs(patientId, { care_change_kind: null, care_change_at: null });
}

// Если сессия начата раньше метки sessions_valid_from — она недействительна.
function middleware(req, res, next) {
  res.locals.prefs = null;
  res.locals.showSupport = false;
  const u = req.session && req.session.user;
  if (!u) return next();
  const prefs = getPrefs(u.id);
  if (prefs.sessions_valid_from && (u.since || 0) < prefs.sessions_valid_from) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  if (u.role === 'patient') {
    res.locals.prefs = prefs;
    res.locals.patientText = require('./patient_text');
    res.locals.hasClinician = !!db.prepare('SELECT 1 FROM care_assignments WHERE patient_id = ? LIMIT 1').get(u.id);
    if (req.session.showSupport) {
      res.locals.showSupport = true;
      req.session.showSupport = false;
    }
  }
  next();
}

module.exports = { getPrefs, setPrefs, noteCareChange, clearCareChange, middleware, DEFAULTS };
