'use strict';

/**
 * Композер (F-12, F-13, F-29) — подсказки над полем ввода, поиск «@» и
 * «+ → Из моих данных», готовые вопросы «✦ Спросить ИИ» (S-16) и серверная
 * проверка чипов на каждой отправке.
 *
 * Безопасность:
 *  - allowlist — 08 «Common rules A»: чего нет в списке, не прикрепляется никем;
 *  - каждая ссылка перепроверяется на сервере: роль, владелец объекта, доступ
 *    специалиста к пациенту (закрепление), тип, версия (устаревшая заменяется
 *    действующей), режим данных (проверяет шлюз F-26), пациент не в архиве;
 *  - чужой или недоступный объект — 409 E-CONTEXT-REJECTED со списком, модель
 *    не вызывается (middleware регистрируется раньше обработчиков сообщений);
 *  - отказ пишется в phi_access_log (decision='deny'), разрешённые ссылки — тоже
 *    (section 'ai.context', без содержимого объектов — PD-03, PD-14);
 *  - в ответах только ссылки {тип, ID, версия} и подписи; содержимого (тексты
 *    дневника, ответы методик) в подсказках и поиске нет (PD-14).
 */

const { t } = require('../../i18n');
const { instrumentLabelFor } = require('../../format');

// «Мне хуже» — служебный вопрос безопасности S-16, удалять из списка нельзя.
const WORSE = 'Мне хуже';

// Allowlist 08 «Common rules A» по ролям. Чего нет в наборе — отклоняется у всех
// (переписка с врачом, пациентский ИИ-чат, кризисная цитата и «весь профиль»
// не прикрепляются никогда — отдельных типов для них нет намеренно).
const ALLOWED = {
  patient: new Set(['plan_item', 'purchase', 'patient_med', 'result', 'diary_entry', 'visit', 'adverse_event', 'library_item', 'file']),
  psychiatrist: new Set(['patient', 'plan_item', 'purchase', 'patient_med', 'result', 'diary_entry', 'visit', 'adverse_event', 'library_item', 'file']),
  psychologist: new Set(['patient', 'result', 'diary_entry', 'visit', 'library_item', 'file']),
};

// Готовые вопросы S-16 по типу объекта: ключи словаря + всегда «Мне хуже».
const QUESTION_KEYS = {
  plan_item: ['msg.ask.med.1', 'msg.ask.med.2', 'msg.ask.med.3'],
  result: ['msg.ask.test.1', 'msg.ask.test.2', 'msg.ask.test.3'],
  diary_entry: ['msg.ask.diary.1', 'msg.ask.diary.2', 'msg.ask.diary.3'],
  visit: ['msg.ask.visit.1', 'msg.ask.visit.2', 'msg.ask.visit.3'],
  library_item: ['msg.ask.library.1', 'msg.ask.library.2', 'msg.ask.library.3'],
  adverse_event: ['msg.ask.ae.1', 'msg.ask.ae.2'],
};

function roleKey(user) {
  return user && ALLOWED[user.role] ? user.role : null;
}

function shortDate(value) {
  const s = String(value || '').slice(0, 10);
  return s.length === 10 ? `${s.slice(8, 10)}.${s.slice(5, 7)}` : s;
}

function medLabel(item) {
  const dose = item.dose_value === null || item.dose_value === undefined ? '' : ` ${String(item.dose_value).replace(/\.0$/, '')} ${item.dose_unit || ''}`.replace(/\s+$/, '');
  return `${item.name}${dose}`;
}

/**
 * Доступ к объекту по чипу (F-13, условия 1–5 и 7; условие 6 — шлюз F-26).
 * @returns {{ok:boolean, reason?:string, patientId?:number, label?:string}}
 */
function checkChip(db, user, chip, patientId) {
  const type = chip && chip.type;
  const id = chip && chip.id;
  if (!ALLOWED[roleKey(user)]) return { ok: false, reason: 'role' };
  if (!ALLOWED[user.role].has(type)) return { ok: false, reason: 'type' };
  if (type === 'patient') {
    // Чип пациента проверяет сам обработчик сообщения (закрепление → 404).
    return { ok: true, patientId: Number(id) };
  }
  const obj = resolveObject(db, type, id);
  if (!obj) return { ok: false, reason: 'not_found' };
  if (type === 'file') {
    const own = obj.ownerId === user.id || (!!obj.patientId && !!patientId && obj.patientId === patientId);
    if (!own) return { ok: false, reason: 'foreign' };
    return { ok: true, patientId: obj.patientId || null, label: obj.label };
  }
  if (type === 'library_item') {
    // Журнал для специалистов пациенту не прикрепляется.
    if (user.role === 'patient' && obj.audience !== 'patient') return { ok: false, reason: 'not_found' };
    return { ok: true, patientId: null, label: obj.label };
  }
  // Объект пациента: у пациента — только свой; у специалиста — объекта выбранного пациента.
  const expected = user.role === 'patient' ? user.id : patientId;
  if (!expected || obj.patientId !== expected) return { ok: false, reason: 'foreign' };
  return { ok: true, patientId: obj.patientId, label: obj.label };
}

function sessionTag(req) {
  try {
    const P = require('../../platform');
    return P.sha((req.session && req.session.sid_hash) || '');
  } catch (_) {
    return null;
  }
}

/**
 * Запись чтения/отказа в phi_access_log (PD-03): только раздел, тип и ID объекта,
 * без содержимого. Отказ пишется всегда; разрешённые чтения — специалистом по
 * своим закреплённым пациентам (читает контекст пациента — PD-03).
 */
function logAccess(db, req, user, type, rawId, decision, patientId, basis) {
  try {
    db.prepare(
      'INSERT INTO phi_access_log(actor_id,actor_role,patient_id,section,action,decision,basis,object_type,object_id,session_tag,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      user ? user.id : null,
      user ? user.role : null,
      patientId,
      'ai.context',
      'view',
      decision,
      basis || (user && user.role === 'patient' ? 'self' : 'assignment'),
      type,
      Number.isInteger(rawId) ? rawId : null,
      sessionTag(req),
      new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    );
  } catch (_) {
    /* журнал не должен ломать действие; отказ всё равно возвращается */
  }
}

/**
 * Проверка чипов перед отправкой сообщения (F-13). Отклонённые ссылки попадают
 * в журнал (deny), разрешённые не раскрывают содержимого.
 */
function validateChips(db, req, user, chips, patientId) {
  const rejected = [];
  const allowed = [];
  for (const chip of chips) {
    if (!chip || typeof chip !== 'object' || !chip.type || !(Number.isInteger(chip.id) || typeof chip.id === 'string')) {
      rejected.push({ type: String((chip && chip.type) || '?'), id: null, reason: 'malformed' });
      continue;
    }
    const check = checkChip(db, user, chip, patientId);
    if (!check.ok) {
      rejected.push({ type: chip.type, id: Number.isInteger(chip.id) ? chip.id : null, reason: check.reason });
      logAccess(db, req, user, chip.type, chip.id, 'deny', check.patientId || (user.role === 'patient' ? user.id : patientId) || null);
    } else {
      allowed.push({ ...chip, label: check.label });
    }
  }
  return { rejected, allowed };
}

module.exports = {
  WORSE,
  ALLOWED,
  QUESTION_KEYS,
  roleKey,
  resolveObject,
  checkChip,
  validateChips,
  logAccess,
  medLabel,
  shortDate,
};

/**
 * Разрешение ссылки на объект: возвращает владельца-пациента и подпись без
 * содержимого. object_id у plan_item — число или сквозной item_key.
 */
function resolveObject(db, type, rawId) {
  const isNum = Number.isInteger(rawId) && rawId > 0;
  if (!isNum && typeof rawId !== 'string') return null;
  switch (type) {
    case 'diary_entry': {
      if (!isNum) return null;
      const row = db.prepare('SELECT id, patient_id, entry_date FROM mood_entries WHERE id=? AND hidden_at IS NULL').get(rawId);
      return row ? { patientId: row.patient_id, label: t('msg.composer.label.diary', 'Дневник · {when}').replace('{when}', shortDate(row.entry_date)) } : null;
    }
    case 'result': {
      if (!isNum) return null;
      const online = db.prepare('SELECT patient_id, instrument, created_at FROM online_results WHERE id=?').get(rawId);
      if (online) return { patientId: online.patient_id, instrument: online.instrument, label: `${instrumentLabelFor('patient', online.instrument)} · ${shortDate(online.created_at)}` };
      const offline = db.prepare('SELECT patient_id, instrument, test_date FROM offline_results WHERE id=?').get(rawId);
      return offline ? { patientId: offline.patient_id, instrument: offline.instrument, label: `${instrumentLabelFor('patient', offline.instrument)} · ${shortDate(offline.test_date)}` } : null;
    }
    case 'plan_item': {
      const row = isNum
        ? db.prepare("SELECT pi.id, pi.item_key, pi.dose_value, pi.dose_unit, pv.patient_id, pv.version, i.name FROM plan_items pi JOIN plan_versions pv ON pv.id=pi.plan_version_id JOIN inn i ON i.id=pi.inn_id WHERE pi.id=? AND pv.status='published' ORDER BY pv.version DESC LIMIT 1").get(rawId)
        : db.prepare("SELECT pi.id, pi.item_key, pi.dose_value, pi.dose_unit, pv.patient_id, pv.version, i.name FROM plan_items pi JOIN plan_versions pv ON pv.id=pi.plan_version_id JOIN inn i ON i.id=pi.inn_id WHERE pi.item_key=? AND pv.status='published' ORDER BY pv.version DESC LIMIT 1").get(String(rawId));
      return row ? { patientId: row.patient_id, itemKey: row.item_key, version: row.version, label: medLabel(row) } : null;
    }
    case 'purchase': {
      if (!isNum) return null;
      const row = db.prepare("SELECT patient_id, created_at FROM purchase_marks WHERE id=? AND status<>'hidden'").get(rawId);
      return row ? { patientId: row.patient_id, label: t('msg.composer.label.purchase', 'Покупка · {date}').replace('{date}', shortDate(row.created_at)) } : null;
    }
    case 'patient_med': {
      if (!isNum) return null;
      const row = db.prepare('SELECT patient_id, created_at FROM patient_meds WHERE id=? AND hidden_at IS NULL').get(rawId);
      return row ? { patientId: row.patient_id, label: t('msg.composer.label.med', 'Препарат · {date}').replace('{date}', shortDate(row.created_at)) } : null;
    }
    case 'adverse_event': {
      if (!isNum) return null;
      const row = db.prepare('SELECT patient_id, created_at FROM adverse_events WHERE id=?').get(rawId);
      return row ? { patientId: row.patient_id, label: t('msg.composer.label.ae', 'Побочный эффект · {date}').replace('{date}', shortDate(row.created_at)) } : null;
    }
    case 'visit': {
      if (!isNum) return null;
      const row = db.prepare("SELECT patient_id, starts_at FROM visits WHERE id=? AND status<>'cancelled'").get(rawId);
      return row ? { patientId: row.patient_id, label: t('msg.composer.label.visit', 'Визит · {date}').replace('{date}', shortDate(row.starts_at)) } : null;
    }
    case 'library_item': {
      if (!isNum) return null;
      const row = db
        .prepare(
          "SELECT lv.title, li.audience FROM library_items li JOIN library_versions lv ON lv.item_id=li.id AND lv.version=li.current_version WHERE li.id=? AND li.status='published' AND li.hidden_at IS NULL",
        )
        .get(rawId);
      return row ? { patientId: null, label: row.title, audience: row.audience } : null;
    }
    case 'file': {
      if (!isNum) return null;
      const row = db.prepare("SELECT owner_user_id, patient_id FROM stored_files WHERE id=? AND status<>'deleted' AND status<>'hidden'").get(rawId);
      return row ? { patientId: row.patient_id, ownerId: row.owner_user_id, label: t('msg.composer.label.file', 'Файл') } : null;
    }
    default:
      return null;
  }
}
