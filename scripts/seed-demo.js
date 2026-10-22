#!/usr/bin/env node
'use strict';
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tdr.sqlite3'));
db.pragma('foreign_keys = ON');
const current = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const password = bcrypt.hashSync('Synthetic-Pass-2026', 10);
const people = [
  ['DEMO-ADM-001', 'demo.admin@example.test', 'admin', 'Демо Администратор'],
  ['DEMO-PSY-001', 'demo.psychiatrist@example.test', 'psychiatrist', 'Демо Психиатр'],
  ['DEMO-PLG-001', 'demo.psychologist@example.test', 'psychologist', 'Демо Психолог'],
  ['DEMO-PAT-001', 'demo.patient@example.test', 'patient', 'Демо Пациент'],
];
db.transaction(() => {
  const ids = {};
  for (const [service, email, role, name] of people) {
    let row = db.prepare('SELECT id FROM users WHERE email=?').get(email);
    if (!row) {
      const info = db
        .prepare(
          `INSERT INTO users(service_no,email,email_hmac,password_hash,role,full_name,status,is_demo,flag_clinical_lead,created_at)
        VALUES (?,?,?,?,?,?,'active',1,?,?)`,
        )
        .run(
          service,
          email,
          crypto.createHash('sha256').update(email).digest('hex'),
          password,
          role,
          name,
          role === 'psychiatrist' ? 1 : 0,
          current,
        );
      row = { id: Number(info.lastInsertRowid) };
      db.prepare('INSERT INTO user_prefs(user_id,onboarding_done_at) VALUES (?,?)').run(row.id, current);
    }
    ids[role] = row.id;
  }
  if (!db.prepare('SELECT 1 FROM care_episodes WHERE patient_id=?').get(ids.patient)) {
    const ep = db
      .prepare('INSERT INTO care_episodes(patient_id,started_at,opened_by) VALUES (?,?,?)')
      .run(ids.patient, current, ids.admin);
    db.prepare(
      'INSERT INTO care_assignments(patient_id,clinician_id,episode_id,started_at,created_by) VALUES (?,?,?,?,?)',
    ).run(ids.patient, ids.psychiatrist, ep.lastInsertRowid, current, ids.admin);
  }
  for (const kind of ['base', 'ai']) {
    let v = db.prepare("SELECT * FROM content_versions WHERE kind=? AND status='published'").get(`consent.${kind}`);
    if (!v) {
      const body = `STAND-IN: согласие ${kind}`;
      const hash = crypto.createHash('sha256').update(body).digest('hex');
      const info = db
        .prepare(
          "INSERT INTO content_versions(kind,version,body_md,body_sha256,sign_method,status,is_stand_in,published_at) VALUES (?,1,?,?,?,'published',1,?)",
        )
        .run(`consent.${kind}`, body, hash, 'demo_click', current);
      v = { id: info.lastInsertRowid, body_sha256: hash };
    }
    if (!db.prepare('SELECT 1 FROM consent_events WHERE user_id=? AND consent_kind=?').get(ids.patient, kind))
      db.prepare(
        "INSERT INTO consent_events(user_id,consent_kind,action,content_version_id,text_sha256,sign_method,created_at) VALUES (?,?,'given',?,?,?,?)",
      ).run(ids.patient, kind, v.id, v.body_sha256, 'demo_click', current);
  }
})();
db.close();
console.log(JSON.stringify({ seeded: true, synthetic: true }));
