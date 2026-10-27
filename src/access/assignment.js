'use strict';

// Единая проверка закрепления врача за пациентом (аудит H3). «Закреплён» — только тот, у кого
// ended_at IS NULL и закрепление не «только сигналы» (end_reason='signal_only'). Новый маршрут
// берёт проверку отсюда, а не пишет свой запрос. Кризисным сигналам signal_only разрешён ({ signal: true }).
const FULL_SQL =
  "SELECT 1 FROM care_assignments WHERE patient_id=? AND clinician_id=? AND ended_at IS NULL AND (? OR COALESCE(end_reason,'')<>'signal_only')";

/** Закреплён ли врач за пациентом (по умолчанию без закреплений «только сигналы»). */
function isFullyAssigned(db, patientId, clinicianId, { signal = false } = {}) {
  return Boolean(db.prepare(FULL_SQL).get(patientId, clinicianId, signal ? 1 : 0));
}

/** Дано ли пациентом базовое согласие (consent_current). */
function hasBaseConsent(db, patientId) {
  return (
    db.prepare("SELECT action FROM consent_current WHERE user_id=? AND consent_kind='base'").get(patientId)?.action ===
    'given'
  );
}

module.exports = { isFullyAssigned, hasBaseConsent };
