'use strict';

// Психообразование: прогресс пациента и назначение модулей врачом/психологом (REQ-PAT-022, REQ-PSY-007).
const db = require('../db');
const content = require('../content/psychoed');

function listForPatient(patientId) {
  const prog = new Map(db.prepare('SELECT module_key, read_at FROM psychoed_progress WHERE patient_id = ?').all(patientId).map((r) => [r.module_key, r.read_at]));
  const asg = new Map(db.prepare('SELECT a.module_key, a.assigned_at, u.full_name FROM psychoed_assignments a JOIN users u ON u.id = a.assigned_by WHERE a.patient_id = ?').all(patientId).map((r) => [r.module_key, r]));
  return content.MODULES.map((m) => ({ ...m, readAt: prog.get(m.key) || null, assigned: asg.get(m.key) || null }));
}

function setRead(patientId, key, read) {
  if (!content.byKey(key)) return false;
  if (read) db.prepare('INSERT INTO psychoed_progress (patient_id, module_key, read_at) VALUES (?, ?, ?) ON CONFLICT(patient_id, module_key) DO NOTHING').run(patientId, key, new Date().toISOString());
  else db.prepare('DELETE FROM psychoed_progress WHERE patient_id = ? AND module_key = ?').run(patientId, key);
  return true;
}

function assign(patientId, key, byId) {
  if (!content.byKey(key)) return false;
  db.prepare('INSERT INTO psychoed_assignments (patient_id, module_key, assigned_by) VALUES (?, ?, ?) ON CONFLICT(patient_id, module_key) DO NOTHING').run(patientId, key, byId);
  return true;
}

function unassign(patientId, key) {
  return db.prepare('DELETE FROM psychoed_assignments WHERE patient_id = ? AND module_key = ?').run(patientId, key).changes === 1;
}

/** Назначенные и ещё не прочитанные модули (для «Сегодня»). */
function pendingAssigned(patientId) {
  return listForPatient(patientId).filter((m) => m.assigned && !m.readAt);
}

module.exports = { listForPatient, setRead, assign, unassign, pendingAssigned };
