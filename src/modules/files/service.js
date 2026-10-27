'use strict';
const sharp = require('sharp');
const { TextDecoder } = require('util');

// Decode every pixel and encode a new image. Sharp drops EXIF/XMP/IPTC by default.
async function sanitize(data, mime) {
  const image = sharp(data, { failOn: 'warning', limitInputPixels: 40000000 }).rotate();
  return mime === 'image/png' ? image.png().toBuffer() : image.jpeg().toBuffer();
}

// F-15: TXT — только валидный UTF-8, бинарное содержимое отклоняется (0x00, расширенный контроль).
function utf8Text(data) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (/\u0000/.test(text) || (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length > 4) return null;
    return text;
  } catch (_) {
    return null;
  }
}

function readable(db, row, user, current) {
  if (!row || ['deleted', 'hidden'].includes(row.status) || (row.expires_at && row.expires_at <= current)) return false;
  if (row.status === 'temp') return row.owner_user_id === user.id;
  if (row.status !== 'linked') return false;
  let object;
  if (row.linked_type === 'care_message') {
    object = db
      .prepare("SELECT patient_id,clinician_id,visible_from FROM care_messages WHERE id=? AND status='sent'")
      .get(row.linked_id);
  } else if (row.linked_type === 'adverse_event') {
    if (user.role === 'psychologist') return false;
    object = db
      .prepare('SELECT patient_id,visible_from,status,psychiatrist_id FROM adverse_events WHERE id=?')
      .get(row.linked_id);
    // Личная запись пациента без врача никому, кроме него, не видна.
    if (object && object.status === 'service_queue' && !object.psychiatrist_id && user.role !== 'patient') return false;
    // F-45: файлы черновика НЯ читает только владелец-пациент; отменённые — никто.
    if (object && ['cancelled', 'draft'].includes(object.status))
      return object.status === 'draft' && user.role === 'patient' && user.id === object.patient_id;
  } else if (row.linked_type === 'offline_result') {
    // Фото бланка очного приёма: только специалист, закреплённый за пациентом (пациенту оно не показывается).
    if (user.role === 'patient') return false;
    object = db.prepare("SELECT patient_id,'' visible_from FROM offline_results WHERE id=?").get(row.linked_id);
  } else if (row.linked_type === 'ai_message') {
    return (
      row.owner_user_id === user.id &&
      user.role === 'patient' &&
      Boolean(
        db
          .prepare(
            "SELECT 1 FROM ai_messages m JOIN ai_threads t ON t.id=m.thread_id WHERE m.id=? AND m.kind<>'error' AND t.owner_user_id=? AND t.hidden_at IS NULL AND t.expires_at>?",
          )
          .get(row.linked_id, user.id, current),
      )
    );
  } else return false;
  if (!object || object.patient_id !== row.patient_id || object.visible_from > current) return false;
  if (user.role === 'patient' && object.patient_id === user.id) return true;
  if (row.linked_type === 'care_message' && !messageParticipant(db, user.id, object, current)) return false;
  return (
    ['psychiatrist', 'psychologist'].includes(user.role) &&
    Boolean(
      db
        .prepare(
          "SELECT 1 FROM care_assignments WHERE patient_id=? AND clinician_id=? AND ended_at IS NULL AND COALESCE(end_reason,'')<>'signal_only'",
        )
        .get(row.patient_id, user.id),
    )
  );
}
function messageParticipant(db, actorId, message, current) {
  if (message.clinician_id === actorId) return true;
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM care_assignments ca JOIN substitutions s ON ca.end_reason='substitution:' || s.id WHERE ca.patient_id=? AND ca.clinician_id=? AND ca.ended_at IS NULL AND s.absent_id=? AND s.substitute_id=? AND s.status='confirmed' AND s.date_from<=? AND s.date_to>=?",
      )
      .get(message.patient_id, actorId, message.clinician_id, actorId, current.slice(0, 10), current.slice(0, 10)),
  );
}
const uploads = new Map();
async function lock(key) {
  const previous = uploads.get(key) || Promise.resolve();
  let unlock;
  const current = new Promise((resolve) => {
    unlock = resolve;
  });
  uploads.set(key, current);
  await previous;
  return () => {
    if (uploads.get(key) === current) uploads.delete(key);
    unlock();
  };
}
module.exports = { sanitize, readable, lock, messageParticipant, utf8Text };
