'use strict';

/**
 * Назначения клинициста (W1.B2): создание (одному/нескольким, тест или пакет), проверка дублей,
 * статус «ожидает ввода врачом» для очных методик, отмена, расписание повторов, пометка
 * «ошибочный ввод». Никаких клинических порогов здесь нет; состав пакетов — review-required.
 *
 *  pending        — онлайн-тест ждёт прохождения пациентом (пациент видит);
 *  waiting_entry  — очная методика (clinician_entered): ждёт ввода протокола врачом, пациент НЕ видит
 *                   (REQ-CAT-007, дефект A0-B4); закрывается, когда врач внёс результат («готово»);
 *  completed / cancelled.
 */

const db = require('./db');
const catalog = require('./instruments_catalog');
const { canAccessPatient } = require('./permissions');

const DAY = 86400000;
const COMMENT_MAX = 200;

// Состав пакетов — review-required (REQ-CAT-010): демонстрационные подборки, не клинический протокол.
const PACKAGES = Object.freeze([
  { code: 'tdr_screen', title: 'Скрининг ТДР', items: ['phq9', 'gad7', 'who5'], note: 'Депрессия, тревога, благополучие' },
  { code: 'pathopsych_ext', title: 'Расширенная патопсихология', items: ['luria10', 'schulte', 'proverbs', 'classification'], note: 'Очные методики: ждут ввода протокола врачом' },
  { code: 'therapy_control', title: 'Контроль терапии', items: ['phq9', 'gad7', 'who5'], note: 'Повторное измерение в ходе лечения' },
]);

const getPackage = (code) => PACKAGES.find((p) => p.code === code) || null;

/** Любая методика каталога, кроме неизвестных кодов. Онлайн -> pending, очная -> waiting_entry. */
function statusFor(code) {
  const e = catalog.getEntry(code);
  if (!e) return null;
  if (e.mode === 'online' || e.mode === 'online_stub') return 'pending';
  if (e.mode === 'clinician_entered') return 'waiting_entry';
  return null;
}

function consentState(patientId) {
  const u = db.prepare('SELECT clinical_consent_given, account_status, consent_revoked_at FROM users WHERE id = ?').get(patientId);
  if (!u) return { ok: false, reason: 'Пациент не найден.' };
  if (u.account_status !== 'active' || u.consent_revoked_at) return { ok: false, reason: 'Согласие отозвано или запрошено удаление данных.' };
  if (!u.clinical_consent_given) return { ok: false, reason: 'Клиническое согласие не оформлено.' };
  return { ok: true, reason: '' };
}

/**
 * W3.K (L-5): запись клинических данных о пациенте (ввод результата, протокол, импорт CSV, калькулятор, сеанс обследования)
 * запрещена при отозванном клиническом согласии или запросе на удаление (статус не active). Намеренно уже consentState:
 * «согласие ещё не оформлено» очный ввод не блокирует.
 */
const WRITE_BLOCKED_MSG = 'Запись недоступна: пациент отозвал согласие или запросил удаление данных. Новые данные о пациенте вносить нельзя.';
function writeBlocked(patientId) {
  const u = db.prepare('SELECT account_status, consent_revoked_at FROM users WHERE id = ?').get(patientId);
  if (!u) return { blocked: true, reason: 'Пациент не найден.' };
  if (u.account_status !== 'active' || u.consent_revoked_at) return { blocked: true, reason: WRITE_BLOCKED_MSG };
  return { blocked: false, reason: '' };
}

function isArchivedFor(clinicianId, patientId) {
  const r = db.prepare('SELECT archived_at FROM care_assignments WHERE patient_id = ? AND clinician_id = ?').get(patientId, clinicianId);
  return !!(r && r.archived_at);
}

function patientName(id) {
  const r = db.prepare('SELECT full_name FROM users WHERE id = ?').get(id);
  return r ? r.full_name : `№${id}`;
}

function ensureArray(v) {
  if (v === undefined || v === null || v === '') return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x)).filter(Boolean);
}

function cleanComment(s) {
  return String(s || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, COMMENT_MAX) || null;
}

function cleanDue(s) {
  const v = String(s || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}

function activeDuplicate(patientId, code) {
  return db
    .prepare("SELECT * FROM instrument_assignments WHERE patient_id = ? AND instrument = ? AND status IN ('pending','waiting_entry') ORDER BY id DESC LIMIT 1")
    .get(patientId, code);
}

/**
 * Планирование назначения (без записи): для каждой пары пациент x методика — create | duplicate | refused.
 * Доступ только к закреплённым, при действующем клиническом согласии, не из архива (REQ-CAT-013, ALL-015, CLN-022).
 */
function plan(user, patientIds, codes) {
  const items = [];
  for (const pid of patientIds.map(Number)) {
    const name = Number.isInteger(pid) ? patientName(pid) : String(pid);
    if (!Number.isInteger(pid) || !canAccessPatient(user, pid, db)) {
      items.push({ patientId: pid, patientName: 'недоступный пациент', code: null, action: 'refused', reason: 'Этот пациент не закреплён за вами.', forbidden: true });
      continue;
    }
    const consent = consentState(pid);
    if (!consent.ok) { items.push({ patientId: pid, patientName: name, code: null, action: 'refused', reason: consent.reason }); continue; }
    if (isArchivedFor(user.id, pid)) {
      items.push({ patientId: pid, patientName: name, code: null, action: 'refused', reason: 'Наблюдение завершено (архив): новые назначения невозможны. Верните пациента из архива.' });
      continue;
    }
    for (const code of codes) {
      const st = statusFor(code);
      if (!st) { items.push({ patientId: pid, patientName: name, code, action: 'refused', reason: 'Неизвестная методика.' }); continue; }
      const dup = activeDuplicate(pid, code);
      items.push({ patientId: pid, patientName: name, code, status: st, action: dup ? 'duplicate' : 'create', duplicate: dup || null });
    }
  }
  return items;
}

/**
 * Записать назначения. opts: {due, comment, batchCode, force (создавать и дубли), repeatDays}.
 * Возвращает {created:[ids], skipped:[plan-items]}.
 */
function create(user, patientIds, codes, opts = {}) {
  const items = plan(user, patientIds, codes);
  const due = cleanDue(opts.due);
  const comment = cleanComment(opts.comment);
  const created = [];
  const skipped = [];
  const repeatDays = Number.isInteger(opts.repeatDays) && opts.repeatDays >= 1 && opts.repeatDays <= 365 ? opts.repeatDays : null;
  db.transaction(() => {
    for (const it of items) {
      if (it.action === 'refused' || (it.action === 'duplicate' && !opts.force)) { skipped.push(it); continue; }
      const info = db
        .prepare(
          `INSERT INTO instrument_assignments (patient_id, assigned_by, instrument, status, due_date, comment, batch_code)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(it.patientId, user.id, it.code, it.status, due, comment, opts.batchCode || null);
      created.push(Number(info.lastInsertRowid));
      if (repeatDays) {
        const nextDue = new Date((opts.now || new Date()).getTime() + repeatDays * DAY).toISOString();
        const sid = db
          .prepare('INSERT INTO assignment_schedules (patient_id, clinician_id, instrument, every_days, next_due_at) VALUES (?, ?, ?, ?, ?)')
          .run(it.patientId, user.id, it.code, repeatDays, nextDue).lastInsertRowid;
        db.prepare('UPDATE instrument_assignments SET schedule_id = ? WHERE id = ?').run(sid, info.lastInsertRowid);
      }
    }
  })();
  return { created, skipped, items };
}

/**
 * Отмена ошибочного назначения (REQ-CAT-012). Автоназначенный C-SSRS не отменяется (OQ-10).
 * Возвращает {ok, message}.
 */
function cancel(user, assignmentId, reason) {
  const a = db.prepare('SELECT * FROM instrument_assignments WHERE id = ?').get(Number(assignmentId));
  if (!a || !canAccessPatient(user, a.patient_id, db)) return { ok: false, forbidden: true, message: 'Назначение не найдено или пациент не закреплён за вами.' };
  if (a.auto_assigned) {
    return { ok: false, message: 'Это назначение создано автоматически по кризисному протоколу (C-SSRS после ответа на пункт 9). Его нельзя отменить: оно закроется, когда пациент пройдёт тест.' };
  }
  if (a.status === 'completed') {
    return { ok: false, message: 'Тест уже выполнен: результат нельзя удалить. Если ввод ошибочный, пометьте результат как «ошибочный ввод» в карточке пациента.' };
  }
  if (a.status === 'cancelled') return { ok: true, message: 'Назначение уже отменено.', already: true };
  db.prepare("UPDATE instrument_assignments SET status = 'cancelled', cancelled_at = datetime('now'), cancelled_by = ?, cancel_reason = ? WHERE id = ?").run(
    user.id, cleanComment(reason), a.id
  );
  return { ok: true, message: 'Назначение отменено. Пациент его больше не видит; запись осталась в журнале.' };
}

/** Закрыть ожидание ввода: врач внёс результат по методике (протокол «готово» или очный результат). */
function completeWaiting(patientId, code, protocolId) {
  const w = db
    .prepare("SELECT id FROM instrument_assignments WHERE patient_id = ? AND instrument = ? AND status = 'waiting_entry' ORDER BY id LIMIT 1")
    .get(patientId, code);
  if (!w) return null;
  db.prepare("UPDATE instrument_assignments SET status = 'completed', completed_at = datetime('now'), entry_protocol_id = ? WHERE id = ?").run(protocolId || null, w.id);
  return w.id;
}

/** Привязать черновик протокола к ожидающему назначению (ожидание остаётся, пока не «готово»). */
function linkDraft(patientId, code, protocolId) {
  const w = db
    .prepare("SELECT id FROM instrument_assignments WHERE patient_id = ? AND instrument = ? AND status = 'waiting_entry' ORDER BY id LIMIT 1")
    .get(patientId, code);
  if (w) db.prepare('UPDATE instrument_assignments SET entry_protocol_id = ? WHERE id = ?').run(protocolId, w.id);
}

// ---------- расписание повторов (REQ-CLN-020) ----------

/**
 * Создаёт повторные назначения по расписанию. Не больше одного ожидающего той же методики;
 * после перерыва создаётся ровно одно, а next_due_at сдвигается за «сейчас» (без лавины просроченных).
 */
function runSchedules(now = new Date()) {
  const due = db.prepare('SELECT * FROM assignment_schedules WHERE active = 1 AND next_due_at <= ?').all(now.toISOString());
  let made = 0;
  for (const s of due) {
    db.transaction(() => {
      const clin = db.prepare('SELECT id, role FROM users WHERE id = ?').get(s.clinician_id);
      const stillCared = db.prepare('SELECT archived_at FROM care_assignments WHERE patient_id = ? AND clinician_id = ?').get(s.patient_id, s.clinician_id);
      if (!clin || !stillCared || stillCared.archived_at || !consentState(s.patient_id).ok) {
        // нечем/некому назначать: расписание не копит долг, просто сдвигаем
      } else if (!activeDuplicate(s.patient_id, s.instrument) && statusFor(s.instrument)) {
        db.prepare('INSERT INTO instrument_assignments (patient_id, assigned_by, instrument, status, schedule_id, assigned_at) VALUES (?, ?, ?, ?, ?, ?)').run(
          s.patient_id, s.clinician_id, s.instrument, statusFor(s.instrument), s.id, now.toISOString().replace('T', ' ').slice(0, 19)
        );
        made += 1;
      }
      let next = new Date(s.next_due_at).getTime();
      const step = s.every_days * DAY;
      while (next <= now.getTime()) next += step;
      db.prepare('UPDATE assignment_schedules SET next_due_at = ? WHERE id = ?').run(new Date(next).toISOString(), s.id);
    })();
  }
  return made;
}

function stopSchedule(user, scheduleId) {
  const s = db.prepare('SELECT * FROM assignment_schedules WHERE id = ?').get(Number(scheduleId));
  if (!s || !canAccessPatient(user, s.patient_id, db)) return false;
  db.prepare("UPDATE assignment_schedules SET active = 0, ended_at = datetime('now') WHERE id = ?").run(s.id);
  return true;
}

function listSchedules(patientIds) {
  if (!patientIds.length) return [];
  const ph = patientIds.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM assignment_schedules WHERE active = 1 AND patient_id IN (${ph}) ORDER BY id`).all(...patientIds);
}

// ---------- ошибочный ввод ----------

const MARK_TABLES = { offline: 'offline_results', protocol: 'catalog_protocols' };

function markInvalid(user, patientId, kind, resultId, reason, invalid = true) {
  const table = MARK_TABLES[kind];
  if (!table || !canAccessPatient(user, patientId, db)) return { ok: false };
  const row = db.prepare(`SELECT id FROM ${table} WHERE id = ? AND patient_id = ?`).get(Number(resultId), Number(patientId));
  if (!row) return { ok: false };
  if (invalid) {
    db.prepare(`UPDATE ${table} SET invalid_at = datetime('now'), invalid_by = ?, invalid_reason = ? WHERE id = ?`).run(user.id, cleanComment(reason), row.id);
  } else {
    db.prepare(`UPDATE ${table} SET invalid_at = NULL, invalid_by = NULL, invalid_reason = NULL WHERE id = ?`).run(row.id);
  }
  return { ok: true };
}

/** Текущие назначения (ожидающие/ждущие ввода) пациентов клинициста с именами — для страницы «Назначения» и карточки. */
function listActive(patientIds) {
  if (!patientIds.length) return [];
  const ph = patientIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT ia.*, u.full_name AS patient_name, b.full_name AS by_name
       FROM instrument_assignments ia JOIN users u ON u.id = ia.patient_id LEFT JOIN users b ON b.id = ia.assigned_by
       WHERE ia.patient_id IN (${ph}) AND ia.status IN ('pending','waiting_entry')
       ORDER BY u.full_name, ia.assigned_at DESC, ia.id DESC`
    )
    .all(...patientIds);
}

module.exports = {
  PACKAGES, COMMENT_MAX, getPackage, statusFor, consentState, writeBlocked, WRITE_BLOCKED_MSG, isArchivedFor, ensureArray, cleanComment, cleanDue,
  plan, create, cancel, completeWaiting, linkDraft, runSchedules, stopSchedule, listSchedules, markInvalid, listActive, activeDuplicate,
};
