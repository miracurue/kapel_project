'use strict';

/** Сводка «Требует решения», «Система» и список согласий для админа (REQ-ADM-001/010/012). Только служебные данные. */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const adminQueue = require('./admin_queue');
const deletion = require('./admin_deletion');
const crisisProtocol = require('./crisisProtocol');
const crisisQueue = require('./crisis_queue');
const rules = require('./triage_rules');
const researchExport = require('./research_export');

function needsDecision() {
  const q = adminQueue.summary();
  const pwReset = db
    .prepare("SELECT id, full_name, role FROM users WHERE must_change_password = 1 AND account_status != 'deleted' ORDER BY full_name")
    .all();
  const noDoctorPatients = db
    .prepare(
      `SELECT COUNT(*) AS n FROM users u WHERE u.role = 'patient' AND u.account_status = 'active' AND u.deactivated_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM care_assignments ca JOIN users c ON c.id = ca.clinician_id
                       WHERE ca.patient_id = u.id AND c.deactivated_at IS NULL AND c.account_status = 'active')`
    )
    .get().n;
  return {
    deletion: deletion.pendingCount(),
    noDoctorEscalations: q.escalations,
    noDoctorAppeals: q.appeals,
    noDoctorTotal: q.total,
    passwordResets: pwReset,
    patientsWithoutDoctor: noDoctorPatients,
  };
}

const DEFAULT_SESSION_SECRET_NOTE = 'SESSION_SECRET не задан: ключ сессий генерируется при каждом запуске, все входы сбрасываются при перезапуске.';

function systemInfo() {
  const pkg = require('../package.json');
  const dbPath = process.env.TDR_DB_PATH || path.join(__dirname, '..', 'data', 'tdr.sqlite3');
  let size = null;
  try { size = fs.statSync(dbPath).size; } catch { /* БД в памяти или недоступна */ }
  const byRole = Object.fromEntries(db.prepare('SELECT role, COUNT(*) AS n FROM users WHERE account_status != ? GROUP BY role').all('deleted').map((r) => [r.role, r.n]));
  const warnings = [];
  if (!process.env.SESSION_SECRET) warnings.push(DEFAULT_SESSION_SECRET_NOTE);
  if (!process.env.RESEARCH_PSEUDONYM_SALT || process.env.RESEARCH_PSEUDONYM_SALT === researchExport.DEFAULT_SALT) {
    warnings.push('RESEARCH_PSEUDONYM_SALT не задан или равен значению по умолчанию: псевдонимы научного экспорта предсказуемы. Для не-демо задайте уникальное значение.');
  }
  return {
    version: pkg.version,
    node: process.version,
    dbSize: size,
    byRole,
    mode: process.env.NODE_ENV === 'production' ? 'prod' : 'демо',
    warnings,
    config: {
      sla: crisisQueue.SLA_MINUTES,
      businessHours: 'пн–пт 9:00–18:00',
      pseudonymTtlDays: researchExport.PSEUDONYM_TTL_DAYS,
      deletionDueDays: deletion.DELETION_DUE_DAYS,
      triage: rules.CONFIG,
      tiers: crisisProtocol.TIERS,
    },
  };
}

function consents() {
  return db
    .prepare(
      `SELECT id, full_name, email, consent_given, consent_version, consent_at, clinical_consent_given, clinical_consent_at,
              anonymized_export_opt_in, export_consent_revoked_at, consent_revoked_at, account_status
       FROM users WHERE role = 'patient' AND account_status != 'deleted' ORDER BY full_name`
    )
    .all();
}

module.exports = { needsDecision, systemInfo, consents };
