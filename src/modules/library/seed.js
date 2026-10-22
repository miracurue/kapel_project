'use strict';

/**
 * W-48 (этап 14, веха В6): стартовый синтетический контент библиотеки (F-50).
 * Таблицы library_items/library_versions/library_positions/library_fts созданы
 * базовой миграцией 0001 (схема этапа 11), отдельная миграция не требуется —
 * номер 0011 уже занят (`0011_queue_return.sql`, см. 14-build.md).
 *
 * Сид идемпотентен: заполняет библиотеку только если она пуста. Контент —
 * STAND-IN (is_stand_in=1, пометка «требует клинического ревью»), как
 * договорились для каталога тестов (решение владельца 2026-10-10). Аудио —
 * синтетический WAV (тишина с опорным тоном), файл хранится в <data>/files
 * как stored_files purpose='library_media', linked на версию материала.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Синтетический WAV: 16-битный PCM mono, достаточно байт для отдачи частями (Range).
function makeWav(seconds = 3, rate = 8000) {
  const samples = seconds * rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    // тихий тон 220 Гц с медленной огибающей — слышимый, но спокойный звук
    const envelope = 0.25 + 0.2 * Math.sin((2 * Math.PI * i) / samples);
    const v = Math.round(envelope * 12000 * Math.sin((2 * Math.PI * 220 * i) / rate));
    data.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const ITEMS = [
  {
    slug: 'stand-in-breath-article',
    media: 'read',
    title: 'STAND-IN: Дыхание при тревоге — обзор для пациента',
    summary: 'Синтетический материал-заглушка о дыхательных техниках; подлежит клинической проверке.',
    body: '## Дыхание при тревоге\n\nSTAND-IN: этот текст — синтетическая заглушка. Он не является клинически проверенной рекомендацией и требует ревью специалиста.\n\n- Медленный выдох длиннее вдоха.\n- Практика по несколько минут в день.\n\n*Источник и автор указаны для демонстрации карточки материала.*',
    author: 'Демо Автор',
    source: 'Внутренняя заглушка Clinical Compass',
    duration_s: null,
    with_file: false,
  },
  {
    slug: 'stand-in-relax-audio-1',
    media: 'listen',
    title: 'STAND-IN: Аудиозанятие «Спокойное дыхание» (5 минут)',
    summary: 'Синтетическая аудиозапись-заглушка для проверки плеера и позиции «Продолжить».',
    body: null,
    author: 'Демо Автор',
    source: 'Внутренняя заглушка Clinical Compass',
    duration_s: 3,
    with_file: true,
  },
  {
    slug: 'stand-in-sleep-audio-2',
    media: 'listen',
    title: 'STAND-IN: Аудиозанятие «Перед сном» (3 минуты)',
    summary: 'Синтетическая аудиозапись-заглушка; проверка фильтра «аудио».',
    body: null,
    author: 'Демо Автор',
    source: 'Внутренняя заглушка Clinical Compass',
    duration_s: 3,
    with_file: true,
  },
];

// Переиндексация библиотечного полнотекстового поиска: в индексе только опубликованное.
function reindexFts(db) {
  db.prepare('DELETE FROM library_fts').run();
  const rows = db
    .prepare(
      `SELECT li.id, lv.title, lv.summary, lv.body_md FROM library_items li
       JOIN library_versions lv ON lv.item_id=li.id AND lv.version=li.current_version
       WHERE li.status='published' AND li.hidden_at IS NULL`,
    )
    .all();
  for (const r of rows)
    db.prepare('INSERT INTO library_fts(rowid,title,summary,body) VALUES (?,?,?,?)').run(
      r.id,
      r.title,
      r.summary || '',
      r.body_md || '',
    );
}

function ensureLibrarySeed(db, config, P) {
  const count = db.prepare('SELECT count(*) n FROM library_items').get().n;
  if (count > 0) return false;
  const current = P.iso(new Date());
  const reviewDate = current.slice(0, 10);
  const admin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  const run = db.transaction(() => {
    const dir = path.join(config.dataDir, 'files');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const item of ITEMS) {
      const info = db
        .prepare(
          "INSERT INTO library_items(slug,media,status,current_version,tags_json,created_at,updated_at) VALUES (?,?, 'published', 1, '[]', ?, ?)",
        )
        .run(item.slug, item.media, current, current);
      const itemId = Number(info.lastInsertRowid);
      let fileId = null;
      if (item.with_file) {
        const wav = makeWav(item.duration_s || 3);
        const storage = `${crypto.randomUUID()}.wav`;
        fs.writeFileSync(path.join(dir, storage), wav, { mode: 0o600 });
        const f = db
          .prepare(
            "INSERT INTO stored_files(owner_user_id,purpose,storage_name,mime,size_bytes,sha256,scan_status,exif_stripped,status,linked_type,linked_id,created_at) VALUES (?,?,?,?,?,?, 'not_required', 0, 'linked', 'library_version', NULL, ?)",
          )
          .run(
            admin ? admin.id : null,
            'library_media',
            storage,
            'audio/wav',
            wav.length,
            crypto.createHash('sha256').update(wav).digest('hex'),
            current,
          );
        fileId = Number(f.lastInsertRowid);
      }
      const v = db
        .prepare(
          `INSERT INTO library_versions(item_id,version,title,summary,body_md,author,source,review_date,file_id,duration_s,is_stand_in,created_by,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          itemId,
          1,
          item.title,
          item.summary,
          item.body,
          item.author,
          item.source,
          reviewDate,
          fileId,
          item.duration_s,
          1,
          admin ? admin.id : null,
          current,
        );
      if (fileId) db.prepare('UPDATE stored_files SET linked_id=? WHERE id=?').run(Number(v.lastInsertRowid), fileId);
    }
    reindexFts(db);
  });
  run();
  return true;
}

module.exports = { ensureLibrarySeed, reindexFts, makeWav };
