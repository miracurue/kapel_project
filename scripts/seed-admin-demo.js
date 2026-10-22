#!/usr/bin/env node
'use strict';

/**
 * Добавка к демо-сиду для кабинета администратора (W1.D): запрос на удаление, эскалация и обращение
 * пациента без врача, коды-приглашения, сотрудник с временным паролем, действия админа в журнале.
 * Только вымышленные данные. Запускать ПОСЛЕ scripts/seed-demo.js на той же БД (TDR_DB_PATH):
 *   TDR_DB_PATH=/tmp/x.sqlite3 node scripts/seed-admin-demo.js
 * Идемпотентно по маркеру (код-приглашение с created_by = админ-сид).
 */

require('./gc-guard'); // до src/db
const db = require('../src/db');
const core = require('../src/admin_core');
const invites = require('../src/invites');
const escalation = require('../src/escalation');

function uid(email) {
  const r = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!r) throw new Error(`нет демо-пользователя ${email}: сначала npm run seed`);
  return r.id;
}

function seedAdminDemo() {
  const admin = uid('admin@example.com');
  if (db.prepare("SELECT 1 FROM admin_action_log WHERE action = 'demo_seed'").get()) return { skipped: true };

  const psy1 = uid('psychiatrist1@example.com');
  const fomin = uid('patient6.nodoctor@example.com'); // без врача
  const novikov = uid('patient8.new@example.com');

  // 1) пациент запросил удаление (как делает /account/deletion-request)
  db.prepare("UPDATE users SET consent_revoked_at = ?, anonymized_export_opt_in = 0, export_consent_revoked_at = ?, account_status = 'deletion_requested' WHERE id = ?")
    .run(new Date().toISOString(), new Date().toISOString(), novikov);
  db.prepare("INSERT INTO data_subject_requests (patient_id, request_type, requested_at, actions_taken_json) VALUES (?, 'consent_revocation_and_deletion', datetime('now', '-3 days'), ?)")
    .run(novikov, JSON.stringify({ account_status: 'deletion_requested' }));

  // 2) эскалация и обращение пациента без врача
  escalation.createEscalation({ patientId: fomin, instrument: 'chatbot', reasons: ['демо: текст эскалации (админу не показывается)'], tier: 3, triggers: ['E'] });
  db.prepare('INSERT INTO patient_contact_requests (patient_id, clinician_id, to_admin, text) VALUES (?, NULL, 1, ?)').run(fomin, 'демо-обращение');

  // 3) коды-приглашения
  const mk = (clin) => { const r = invites.create(clin); db.prepare('UPDATE invite_codes SET created_by = ? WHERE id = ?').run(admin, r.id); return r; };
  mk(psy1);
  const used = mk(psy1);
  db.prepare('UPDATE invite_codes SET used_by = ?, used_at = ? WHERE id = ?').run(uid('patient1.improving@example.com'), new Date().toISOString(), used.id);
  const old = mk(uid('psychiatrist2@example.com'));
  db.prepare("UPDATE invite_codes SET expires_at = datetime('now', '-2 days') WHERE id = ?").run(old.id);

  // 4) новый сотрудник с временным паролем (пароль в сид не сохраняется нигде, кроме хэша)
  core.createStaff(admin, { full_name: 'Демо Психолог Новая', email: 'psychologist.new@example.com', role: 'psychologist' });

  // 5) несколько действий админа для журнала
  core.logAdmin(admin, 'assignment_add', uid('patient1.improving@example.com'), { clinician_id: psy1 });
  core.logAdmin(admin, 'demo_seed', null, { note: 'демо-данные кабинета администратора' });
  return { skipped: false };
}

module.exports = { seedAdminDemo };

if (require.main === module) {
  const r = seedAdminDemo();
  console.log(r.skipped ? 'уже добавлено' : 'демо-данные кабинета администратора добавлены');
}
