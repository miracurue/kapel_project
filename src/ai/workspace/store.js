'use strict';

/**
 * Хранение материалов врача (REQ-AID-005/012, REQ-SEC-006).
 *  - файлы лежат ВНЕ public/ (по умолчанию рядом с БД: data/ai_uploads), под случайным именем без расширения;
 *  - при включённом маскировании на диск и в БД попадает ТОЛЬКО замаскированный текст (оригинал не хранится);
 *  - «удалить» стирает файл с диска и строку из БД; просроченное удаляется автоматически (purgeExpired);
 *  - показ до сохранения — через временное хранилище в ПАМЯТИ (staging), на диск до подтверждения ничего не пишется.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../../db');
const pii = require('./pii');

const RETENTION_DAYS = () => Number(process.env.AI_RETENTION_DAYS) || 30;

function uploadDir() {
  // конвенция админского удаления (src/admin_deletion.js): файлы под <data>/uploads, путь в колонке storage_path
  const root = process.env.TDR_UPLOAD_DIR
    || path.join(process.env.TDR_DB_PATH ? path.dirname(path.resolve(process.env.TDR_DB_PATH)) : path.join(__dirname, '..', '..', '..', 'data'), 'uploads');
  const dir = process.env.AI_UPLOAD_DIR || path.join(root, 'ai');
  const resolved = path.resolve(dir);
  const pub = path.resolve(__dirname, '..', '..', '..', 'public');
  if (resolved === pub || resolved.startsWith(pub + path.sep)) throw new Error('upload dir must not be inside public/');
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  return resolved;
}

/** SQLite-формат UTC 'YYYY-MM-DD HH:MM:SS'. */
function sqlTime(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
function parseSql(s) {
  return new Date(String(s).replace(' ', 'T') + 'Z');
}
function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

// ---------- staging (в памяти) ----------

const STAGE_TTL_MS = 20 * 60 * 1000;
const staging = new Map(); // token -> {userId, created, threadId, mask, items}

function stagePrune(now = Date.now()) {
  for (const [k, v] of staging) if (now - v.created > STAGE_TTL_MS) staging.delete(k);
}

function stagePut(userId, payload) {
  stagePrune();
  // не больше 3 одновременных черновиков загрузки на врача
  const mine = [...staging.entries()].filter(([, v]) => v.userId === userId).sort((a, b) => a[1].created - b[1].created);
  while (mine.length >= 3) staging.delete(mine.shift()[0]);
  const token = crypto.randomBytes(18).toString('hex');
  staging.set(token, { userId, created: Date.now(), ...payload });
  return token;
}

function stageGet(userId, token) {
  stagePrune();
  const v = staging.get(String(token || ''));
  return v && v.userId === userId ? v : null;
}

function stageDrop(token) {
  staging.delete(String(token || ''));
}

// ---------- материалы ----------

function randomName() {
  return crypto.randomBytes(16).toString('hex');
}

function unlinkQuiet(storagePath) {
  if (!storagePath) return;
  const abs = path.resolve(storagePath);
  if (!abs.startsWith(path.resolve(uploadDir()) + path.sep)) return; // удаляем только внутри каталога загрузок
  try {
    fs.unlinkSync(abs);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
}

/**
 * Сохраняет подтверждённый врачом материал в тред.
 * item: результат extract.inspect + buf (оригинал). keepIds — отключённые врачом замены.
 */
function saveMaterial({ ownerUserId, threadId, patientId = null, item, buf, mask, keepIds = [], now = new Date() }) {
  let text = item.text;
  let masked = 0;
  let maskCount = 0;
  let data = buf;
  let storedAs = 'original';
  if (mask && item.hasText) {
    const matches = pii.detect(text);
    const r = pii.apply(text, matches, keepIds);
    text = r.text;
    maskCount = r.count;
    masked = 1;
    data = Buffer.from(text, 'utf8'); // оригинал не сохраняем
    storedAs = 'masked_text';
  }
  const stored = path.join(uploadDir(), randomName());
  fs.writeFileSync(stored, data, { mode: 0o600, flag: 'wx' });
  try {
    const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM ai_attachments WHERE thread_id = ?').get(threadId).m) + 1;
    const info = db
      .prepare(
        `INSERT INTO ai_attachments (thread_id, owner_user_id, patient_id, seq, name, kind, size_bytes, storage_path, stored_as,
           text_extracted, has_text, masked, mask_count, note, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(threadId, ownerUserId, patientId, seq, item.name, item.kind, item.size, stored, storedAs, text, item.hasText ? 1 : 0, masked, maskCount, item.note || null,
        sqlTime(now), sqlTime(addDays(now, RETENTION_DAYS())));
    return getMaterial(ownerUserId, info.lastInsertRowid);
  } catch (e) {
    unlinkQuiet(stored);
    throw e;
  }
}

function getMaterial(ownerUserId, id) {
  const n = Number(id);
  if (!Number.isInteger(n)) return null;
  return db.prepare('SELECT * FROM ai_attachments WHERE id = ? AND owner_user_id = ?').get(n, ownerUserId) || null;
}

function listMaterials(threadId, ownerUserId) {
  return db.prepare('SELECT * FROM ai_attachments WHERE thread_id = ? AND owner_user_id = ? ORDER BY seq').all(threadId, ownerUserId);
}

function countMaterials(threadId) {
  return db.prepare('SELECT COUNT(*) AS n FROM ai_attachments WHERE thread_id = ?').get(threadId).n;
}

function readStored(row) {
  if (!row.storage_path) return null;
  const abs = path.resolve(row.storage_path);
  if (!abs.startsWith(path.resolve(uploadDir()) + path.sep)) return null;
  try {
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}

/** Реально стирает файл и запись. @returns {boolean} */
function deleteMaterial(ownerUserId, id) {
  const row = getMaterial(ownerUserId, id);
  if (!row) return false;
  unlinkQuiet(row.storage_path);
  db.prepare('DELETE FROM ai_attachments WHERE id = ?').run(row.id);
  return true;
}

/** Все материалы треда (для удаления диалога). */
function deleteThreadMaterials(threadId) {
  const rows = db.prepare('SELECT id, storage_path FROM ai_attachments WHERE thread_id = ?').all(threadId);
  for (const r of rows) unlinkQuiet(r.storage_path);
  db.prepare('DELETE FROM ai_attachments WHERE thread_id = ?').run(threadId);
  return rows.length;
}

function threadExpiry(thread, now = null) {
  void now;
  return sqlTime(addDays(parseSql(thread.updated_at), RETENTION_DAYS()));
}

/**
 * Автоудаление: материалы с истёкшим expires_at и диалоги врача без активности дольше срока хранения.
 * @returns {{materials:number, threads:number}}
 */
function purgeExpired(now = new Date()) {
  const t = sqlTime(now);
  let materials = 0;
  let threads = 0;
  const expiredMat = db.prepare('SELECT id, storage_path FROM ai_attachments WHERE expires_at <= ?').all(t);
  for (const r of expiredMat) {
    unlinkQuiet(r.storage_path);
    db.prepare('DELETE FROM ai_attachments WHERE id = ?').run(r.id);
    materials++;
  }
  const cutoff = sqlTime(addDays(now, -RETENTION_DAYS()));
  const oldThreads = db.prepare("SELECT id, owner_user_id FROM ai_threads WHERE role = 'clinician' AND updated_at <= ?").all(cutoff);
  for (const th of oldThreads) {
    materials += deleteThreadMaterials(th.id);
    db.prepare('DELETE FROM ai_messages WHERE thread_id = ?').run(th.id);
    db.prepare('DELETE FROM ai_threads WHERE id = ?').run(th.id);
    db.prepare("INSERT INTO ai_audit (user_id, role, thread_id, event) VALUES (?, 'clinician', ?, 'ws_expired_purge')").run(th.owner_user_id, th.id);
    threads++;
  }
  return { materials, threads };
}

let lastPurge = 0;
/** Ленивая проверка срока: не чаще раза в минуту на обращение к разделу. */
function purgeIfDue() {
  const now = Date.now();
  if (now - lastPurge < 60 * 1000) return null;
  lastPurge = now;
  return purgeExpired(new Date());
}

let timer = null;
function startPurgeTimer() {
  if (timer) return;
  timer = setInterval(() => { try { purgeExpired(new Date()); } catch (e) { console.error('ai purge failed:', e && e.message); } }, 60 * 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = {
  RETENTION_DAYS, uploadDir, sqlTime, parseSql, addDays, threadExpiry,
  stagePut, stageGet, stageDrop, saveMaterial, getMaterial, listMaterials, countMaterials, readStored, deleteMaterial,
  deleteThreadMaterials, purgeExpired, purgeIfDue, startPurgeTimer,
};
