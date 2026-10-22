'use strict';

// Единственное место, где создаётся «обращение пациента» (REQ-PAT-003, REQ-CRI-005, REQ-AIP-005).
// Таблицу patient_appeals читает кабинет врача (W1.B1: очередь и светофор). Используют
// экран «Мне плохо» (routes/patient/home.js) и «Связаться с человеком» в чате (ai/contact.js).
// Это не Tier-эскалация и не обещание оповещения: запись видна в кабинете врача или администратора.

const db = require('./db');

// Врач получает обращение, только если есть закреплённый врач И действует клиническое согласие;
// иначе обращение уходит администратору.
function routeFor(patientId) {
  const row = db
    .prepare(
      `SELECT ca.clinician_id FROM care_assignments ca JOIN users u ON u.id = ca.patient_id
       WHERE ca.patient_id = ? AND u.clinical_consent_given = 1 ORDER BY ca.id ASC LIMIT 1`
    )
    .get(patientId);
  return row ? { routedTo: 'clinician', clinicianId: row.clinician_id } : { routedTo: 'admin', clinicianId: null };
}

function createAppeal({ patientId, message }) {
  const route = routeFor(patientId);
  const info = db
    .prepare('INSERT INTO patient_appeals (patient_id, clinician_id, routed_to, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(patientId, route.clinicianId, route.routedTo, message || null, 'open', new Date().toISOString());
  return { id: info.lastInsertRowid, routedTo: route.routedTo, clinicianId: route.clinicianId };
}

function hasRecentOpenAppeal(patientId, minutes = 10) {
  const since = new Date(Date.now() - minutes * 60000).toISOString();
  return !!db.prepare("SELECT 1 FROM patient_appeals WHERE patient_id = ? AND status = 'open' AND created_at > ?").get(patientId, since);
}

module.exports = { createAppeal, routeFor, hasRecentOpenAppeal };
