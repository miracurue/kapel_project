#!/usr/bin/env node
'use strict';
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const email = String(arg('--email') || '')
  .trim()
  .toLowerCase();
const name = String(arg('--name') || '').trim();
if (!email || !name) {
  console.error('usage: --email EMAIL --name NAME');
  process.exit(2);
}
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tdr.sqlite3'));
if (
  db.prepare("SELECT 1 FROM users WHERE role='admin' AND status='active' AND must_change_password=1 LIMIT 1").get() &&
  !process.argv.includes('--recovery')
) {
  console.error('bootstrap administrator already exists');
  db.close();
  process.exit(3);
}
const password = `Cc-${crypto.randomBytes(9).toString('base64url')}!`;
const current = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
db.prepare(
  `INSERT INTO users(service_no,email,email_hmac,password_hash,role,full_name,status,is_demo,must_change_password,created_at) VALUES (?,?,?,?,'admin',?,'active',1,1,?)`,
).run(
  `ADM-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
  email,
  crypto.createHash('sha256').update(email).digest('hex'),
  bcrypt.hashSync(password, 10),
  name,
  current,
);
db.close();
console.log(`temporary password: ${password}`);
