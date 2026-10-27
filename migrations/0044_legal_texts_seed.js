'use strict';

// Опубликованные версии юридических текстов для регистрации и согласий (AUDIT_CONSENT_ACCESS H6): экран, ссылка
// «Полный текст» и журнал согласий читают одну и ту же строку content_versions. Черновики лежат в config/legal/
// (по мотивам .agents/web-developer/files/05-legal/), все помечены is_stand_in = 1 и «review-required»: юрист их не
// проверял. Заменить текст — опубликовать новую версию в админке (POST /admin/content/docs/{kind}/versions).
// Прежняя автозаглушка «STAND-IN: текст согласия …» вытесняется новой версией; вид 'program' в интерфейсе не
// используется, ему текст ставится, только если опубликованного нет.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'config', 'legal');
const KINDS = [
  'consent.base',
  'consent.ai',
  'consent.research',
  'consent.program',
  'consent.staff_pd',
  'doc.policy',
  'doc.agreement',
];

function up(db) {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  for (const kind of KINDS) {
    const body = fs.readFileSync(path.join(DIR, `${kind}.md`), 'utf8').trim() + '\n';
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    const current = db
      .prepare(
        "SELECT id, version, body_sha256 FROM content_versions WHERE kind=? AND status='published' ORDER BY version DESC LIMIT 1",
      )
      .get(kind);
    if (current && (current.body_sha256 === hash || kind === 'consent.program')) continue;
    const last = db.prepare('SELECT COALESCE(MAX(version), 0) v FROM content_versions WHERE kind=?').get(kind).v;
    if (current)
      db.prepare("UPDATE content_versions SET status='superseded' WHERE kind=? AND status='published'").run(kind);
    db.prepare(
      `INSERT INTO content_versions(kind,version,body_md,body_sha256,sign_method,status,is_stand_in,comment,created_at,published_at)
       VALUES (?,?,?,?,?,'published',1,?,?,?)`,
    ).run(kind, last + 1, body, hash, 'demo_click', 'Черновик, review-required: config/legal', stamp, stamp);
  }
}

module.exports = up;
