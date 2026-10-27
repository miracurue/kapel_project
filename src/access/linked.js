'use strict';

// Чтение «чужого» среза по связи специалистов (маршрутизация). Отдельно от isFullyAssigned:
// связь не заменяет закрепление, а только добавляет чтение среза коллеги. Действует, пока
// связь не снята, оба специалиста полностью закреплены (не signal_only), оба активны
// и у пациента есть базовое согласие.
const { isFullyAssigned, hasBaseConsent } = require('./assignment');

const SPECIALIST_ROLES = ['psychiatrist', 'psychologist'];

/** Активные связи этого специалиста по пациенту: [{ id, colleague: {id, full_name, role} }]. */
function linkedReadAccess(db, requesterId, patientId) {
  if (!isFullyAssigned(db, patientId, requesterId) || !hasBaseConsent(db, patientId)) return [];
  const rows = db
    .prepare(
      `SELECT l.id, u.id colleague_id, u.full_name, u.role
       FROM care_links l
       JOIN users u ON u.id = CASE WHEN l.clinician_a=? THEN l.clinician_b ELSE l.clinician_a END
       WHERE l.patient_id=? AND l.ended_at IS NULL AND (l.clinician_a=? OR l.clinician_b=?)
         AND u.status='active' AND u.role IN ('psychiatrist','psychologist')`,
    )
    .all(requesterId, patientId, requesterId, requesterId);
  return rows
    .filter((r) => isFullyAssigned(db, patientId, r.colleague_id))
    .map((r) => ({ id: r.id, colleague: { id: r.colleague_id, full_name: r.full_name, role: r.role } }));
}

module.exports = { linkedReadAccess, SPECIALIST_ROLES };
