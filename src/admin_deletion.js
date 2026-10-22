'use strict';

/**
 * Исполнение запросов на удаление данных (REQ-ADM-006, OQ-6, 152-ФЗ ст.14/21).
 *
 * Решение OQ-6 (default PM, review-required): ФИЗИЧЕСКИ удаляются все клинические данные пациента
 * и файлы на диске; идентифицирующие поля учётной записи стираются (запись-«надгробие» без ПД остаётся
 * только ради целостности ссылок журналов аудита); журналы аудита без ПД остаются; тексты цитат в
 * кризисных журналах обезличиваются (остаётся факт: уровень, триггеры, время, исход).
 * Исполнение транзакционное: любая ошибка -> откат, ничего не удалено. Файлы удаляются после коммита.
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const core = require('./admin_core');

// Ожидаемый срок исполнения от даты запроса. review-required (юрист): 152-ФЗ ст.21 — порядка 30 дней.
const DELETION_DUE_DAYS = Number(process.env.DELETION_DUE_DAYS || 30);

// W-38: Белый список таблиц для стирания (F-85).
// Таблицы из этого списка сохраняют факт (строку), но текстовые поля стираются.
// Остальные таблицы с patient_id/user_id стираются полностью (каскадное стирание без списка запрещено).
const ERASURE_FACT_WHITELIST = new Set([
  'phi_access_log',
  'crisis_incident_log',
  'crisis_escalations',
  'consent_events',
  'data_subject_requests',
  'export_log',
  'service_queue',
  'care_episodes',
  'care_assignments',
  'ai_audit',
  'action_log',
]);

// Регулярное выражение для текстовых колонок, подлежащих стиранию в whitelist-таблицах.
// Должно совпадать с TEXT_COL в tests/api/16_privacy.test.js.
const TEXT_COL_RE = /(_enc|^note$|^body$|^text$|^quote|^message|answers_json|triggers_json)/;

// Таблица учётной записи: остаётся как «надгробие» (без ПДн), строки не удаляются.
const TOMBSTONE_TABLES = new Set(['users']);

// Колонки, в которых другие модули хранят путь к файлу на диске (материалы ИИ-пространства и т.п.).
const FILE_COLUMNS = ['file_path', 'storage_path', 'stored_path', 'disk_path'];

const CATEGORY_LABELS = {
  online_results: 'Результаты онлайн-тестов',
  offline_results: 'Результаты очных тестов',
  catalog_protocols: 'Протоколы методик',
  comparison_pairs: 'Пары сравнения онлайн/очно',
  instrument_assignments: 'Назначения тестов',
  mood_entries: 'Дневник настроения',
  diary_workspaces: 'Настройки дневника',
  diary_habits: 'Отслеживаемые привычки и архив',
  diary_habit_versions: 'Версии определений привычек',
  diary_habit_values: 'Измерения привычек и исправления',
  diary_day_notes: 'Заметки дневника',
  diary_note_revisions: 'История заметок дневника',
  analytics_product_activity: 'Активность пользователя',
  reminders: 'Напоминания',
  chatbot_sessions: 'Сессии чат-бота',
  chatbot_messages: 'Сообщения чат-бота',
  ai_threads: 'Диалоги с ИИ',
  ai_messages: 'Сообщения ИИ-чата',
  ai_prefs: 'Настройки ИИ-чата',
  patient_contact_requests: 'Обращения к врачу',
  patient_appeals: 'Обращения «Мне тяжело»',
  care_assignments: 'Привязки к врачам',
  patient_tags: 'Метки пациента у врачей',
  triage_snoozes: 'Отложенные флаги сводки',
  research_pseudonyms: 'Псевдоним для научного экспорта',
};

function uploadRoot() {
  return (
    process.env.TDR_UPLOAD_DIR ||
    path.join(
      process.env.TDR_DB_PATH ? path.dirname(process.env.TDR_DB_PATH) : path.join(__dirname, '..', 'data'),
      'uploads',
    )
  );
}

function tables() {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((t) => t.name);
}
function columns(table) {
  return db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((c) => c.name);
}

/** Таблицы с patient_id, которые надо чистить (кроме таблиц из белого списка и надгробий). */
function patientTables() {
  return tables().filter(
    (t) => !ERASURE_FACT_WHITELIST.has(t) && !TOMBSTONE_TABLES.has(t) && columns(t).includes('patient_id'),
  );
}

/** Таблицы персональных настроек пациента по user_id (user_prefs и т.п.); ai_* обрабатываются отдельно. */
function userTables() {
  return tables().filter(
    (t) =>
      !ERASURE_FACT_WHITELIST.has(t) &&
      !TOMBSTONE_TABLES.has(t) &&
      t !== 'ai_prefs' &&
      !columns(t).includes('patient_id') &&
      columns(t).includes('user_id'),
  );
}

/** Описание того, что будет удалено: [{table,label,count}] — только числа, без содержимого. */
function inventory(patientId) {
  const pid = Number(patientId);
  const inv = [];
  const add = (table, count) =>
    inv.push({ table, label: CATEGORY_LABELS[table] || `Прочие данные пациента (${table})`, count });
  for (const t of patientTables())
    add(t, db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE patient_id = ?`).get(pid).n);
  for (const t of userTables()) add(t, db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE user_id = ?`).get(pid).n);
  add(
    'chatbot_messages',
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM chatbot_messages WHERE session_id IN (SELECT id FROM chatbot_sessions WHERE patient_id = ?)',
      )
      .get(pid).n,
  );
  if (tables().includes('ai_threads')) {
    add(
      'ai_messages',
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM ai_messages WHERE thread_id IN (SELECT id FROM ai_threads WHERE owner_user_id = ? OR patient_id = ?)',
        )
        .get(pid, pid).n,
    );
    add(
      'ai_threads',
      db.prepare('SELECT COUNT(*) AS n FROM ai_threads WHERE owner_user_id = ? OR patient_id = ?').get(pid, pid).n,
    );
    add('ai_prefs', db.prepare('SELECT COUNT(*) AS n FROM ai_prefs WHERE user_id = ?').get(pid).n);
  }
  // убрать дубли по имени таблицы (chatbot_messages/ai_* считаются явно)
  const seen = new Map();
  for (const r of inv) if (!seen.has(r.table) || r.count > seen.get(r.table).count) seen.set(r.table, r);
  return [...seen.values()]
    .filter((r) => r.table !== 'invite_codes')
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}

/** Что остаётся (с числами) — для честного отчёта. */
function retained(patientId) {
  const pid = Number(patientId);
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  return [
    {
      label: 'Журнал обращений к данным (phi_access_log): кто, когда, какое действие — без содержимого',
      count: n('SELECT COUNT(*) AS n FROM phi_access_log WHERE patient_id = ?', pid),
    },
    {
      label: 'Журнал кризисных событий (crisis_incident_log): уровень, триггеры, время, исход; тексты цитат стираются',
      count: n('SELECT COUNT(*) AS n FROM crisis_incident_log WHERE patient_id = ?', pid),
    },
    {
      label: 'Записи о кризисных эскалациях: уровень, триггеры, время; текст причины стирается',
      count: n('SELECT COUNT(*) AS n FROM crisis_escalations WHERE patient_id = ?', pid),
    },
    {
      label: 'Аудит обращений к ИИ (ai_audit): без содержимого',
      count: n('SELECT COUNT(*) AS n FROM ai_audit WHERE user_id = ?', pid),
    },
    {
      label: 'Запись о факте запроса и исполнения удаления (без персональных данных)',
      count: n('SELECT COUNT(*) AS n FROM data_subject_requests WHERE patient_id = ?', pid),
    },
  ];
}

// ---------- очередь запросов ----------

function dueDate(requestedAt) {
  const d = new Date(
    String(requestedAt).replace(' ', 'T') + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(requestedAt)) ? '' : 'Z'),
  );
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + DELETION_DUE_DAYS * 86400000).toISOString();
}

function listRequests() {
  return (
    db
      .prepare(
        `SELECT r.*, u.full_name AS patient_name, u.email AS patient_email, u.account_status AS patient_status
       FROM data_subject_requests r JOIN users u ON u.id = r.patient_id
       WHERE r.request_type = 'consent_revocation_and_deletion'
       ORDER BY (r.status = 'pending') DESC, r.requested_at DESC, r.id DESC`,
      )
      .all()
      // пациент мог отменить запрос до исполнения (REQ-PAT-018): статус в БД остаётся pending, а аккаунт снова active
      .map((r) => ({
        ...r,
        status: r.status === 'pending' && r.patient_status === 'active' ? 'cancelled' : r.status,
        due_at: dueDate(r.requested_at),
        report: r.report_json ? safeJson(r.report_json) : null,
      }))
  );
}

function getRequest(id) {
  return listRequests().find((r) => r.id === Number(id)) || null;
}

function pendingCount() {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM data_subject_requests r JOIN users u ON u.id = r.patient_id
     WHERE r.request_type = 'consent_revocation_and_deletion' AND r.status = 'pending' AND u.account_status = 'deletion_requested'`,
    )
    .get().n;
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ---------- исполнение ----------

const INCIDENT_KEEP_KEYS = [
  'tier',
  'triggers',
  'notified',
  'channel',
  'due_at',
  'backup_notified_id',
  'reason',
  'outcome',
];

function collectFiles(pid) {
  const files = new Set();
  for (const t of tables()) {
    const cols = columns(t);
    const fileCol = FILE_COLUMNS.find((c) => cols.includes(c));
    const scope = ['patient_id', 'owner_user_id', 'user_id'].filter((c) => cols.includes(c));
    if (!fileCol || !scope.length) continue;
    const rows = db
      .prepare(`SELECT "${fileCol}" AS p FROM "${t}" WHERE ${scope.map((c) => `${c} = ?`).join(' OR ')}`)
      .all(...scope.map(() => pid));
    for (const r of rows) if (r.p) files.add(String(r.p));
  }
  return [...files];
}

function dataRoot() {
  return process.env.TDR_DB_PATH
    ? path.dirname(path.resolve(process.env.TDR_DB_PATH))
    : path.join(__dirname, '..', 'data');
}

/** Путь из БД -> абсолютный; удаляем только внутри каталога данных/загрузок (защита от произвольных путей). */
function resolveFile(p) {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(dataRoot(), p);
  const roots = [path.resolve(dataRoot()), path.resolve(uploadRoot())];
  return roots.some((r) => abs.startsWith(r + path.sep)) ? abs : null;
}

/**
 * Исполняет запрос. opts: { confirmServiceNo }.
 * Возвращает { ok:true, report } или { ok:false, error }.
 * F-85: подтверждение номером пациента; при открытом кризисе — E-CRISIS-OPEN, запрос помечается waiting_crisis.
 */
function execute(adminId, requestId, { confirmServiceNo } = {}) {
  const req = db.prepare('SELECT * FROM data_subject_requests WHERE id = ?').get(Number(requestId));
  // W-38: в очереди администратора запрос стирания имеет вид 'erasure' (T-204); прежний вид
  // согласие+удаление остаётся для страницы /admin/deletion.
  if (!req || !['erasure', 'consent_revocation_and_deletion'].includes(req.request_type))
    return { ok: false, error: 'Запрос не найден.' };
  if (req.status === 'executed') return { ok: false, error: 'E-ALREADY-DONE' };
  const pid = req.patient_id;
  const patient = core.getUser(pid);
  if (!patient || patient.role !== 'patient') return { ok: false, error: 'E-VALIDATION' };
  // W-39/W-50: авторитетная колонка — users.status (account_status в users нет):
  // 'tombstone' — уже стёрт, 'deletion_requested' — запрос активен.
  if (patient.status === 'tombstone') return { ok: false, error: 'E-ALREADY-DONE' };
  if (patient.status !== 'deletion_requested') return { ok: false, error: 'E-VALIDATION' };
  if (String(confirmServiceNo || '').trim() !== String(patient.service_no || '').trim()) {
    return { ok: false, error: 'E-VALIDATION' };
  }
  const openEsc = db
    .prepare("SELECT id FROM crisis_escalations WHERE patient_id = ? AND status IN ('new','in_work')")
    .all(pid);
  if (openEsc.length) {
    // F-85: исполнение откладывается, запрос остаётся в очереди с пометкой.
    db.prepare("UPDATE data_subject_requests SET status = 'waiting_crisis' WHERE id = ?").run(req.id);
    return { ok: false, error: 'E-CRISIS-OPEN', openEscalations: openEsc.length };
  }

  const files = collectFiles(pid);
  const uploadDir = path.join(uploadRoot(), String(pid));
  const nowIso = new Date().toISOString();
  const report = {
    executed_at: nowIso,
    deleted: {},
    files_deleted: 0,
    files_failed: 0,
    escalations_closed: openEsc.length,
    retained: retained(pid).map((r) => ({ label: r.label, count: r.count })),
  };

  db.pragma('foreign_keys = OFF'); // PRAGMA вне транзакции; целостность проверим foreign_key_check до коммита
  try {
    db.transaction(() => {
      // 1) открытые эскалации закрываем осознанно (с записью в журнал инцидентов)
      for (const e of openEsc) {
        db.prepare(
          "UPDATE crisis_escalations SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = datetime('now') WHERE id = ?",
        ).run(adminId, e.id);
        db.prepare(
          "INSERT INTO crisis_incident_log (escalation_id, patient_id, event_type, actor_id, detail_json) VALUES (?, ?, 'manual_review_outcome', ?, ?)",
        ).run(e.id, pid, adminId, JSON.stringify({ outcome: 'closed_by_deletion' }));
      }
      // 2) обезличивание кризисных журналов: остаётся факт, текст — нет
      db.prepare('UPDATE crisis_escalations SET online_result_id = NULL, reasons_json = ? WHERE patient_id = ?').run(
        JSON.stringify(['Текст удалён по запросу субъекта данных']),
        pid,
      );
      const logs = db.prepare('SELECT id, detail_json FROM crisis_incident_log WHERE patient_id = ?').all(pid);
      for (const l of logs) {
        const d = safeJson(l.detail_json);
        if (!d || typeof d !== 'object') continue;
        const kept = {};
        for (const k of INCIDENT_KEEP_KEYS) if (k in d) kept[k] = d[k];
        db.prepare('UPDATE crisis_incident_log SET detail_json = ? WHERE id = ?').run(JSON.stringify(kept), l.id);
      }
      // 3) сообщения чатов (без patient_id в самих строках)
      const cm = db
        .prepare(
          'DELETE FROM chatbot_messages WHERE session_id IN (SELECT id FROM chatbot_sessions WHERE patient_id = ?)',
        )
        .run(pid).changes;
      report.deleted.chatbot_messages = cm;
      if (tables().includes('ai_threads')) {
        report.deleted.ai_messages = db
          .prepare(
            'DELETE FROM ai_messages WHERE thread_id IN (SELECT id FROM ai_threads WHERE owner_user_id = ? OR patient_id = ?)',
          )
          .run(pid, pid).changes;
        report.deleted.ai_threads = db
          .prepare('DELETE FROM ai_threads WHERE owner_user_id = ? OR patient_id = ?')
          .run(pid, pid).changes;
        report.deleted.ai_prefs = db.prepare('DELETE FROM ai_prefs WHERE user_id = ?').run(pid).changes;
      }
      // 4) стирание по белому списку: факты сохраняются, тексты стираются; остальное удаляется.
      const allTables = tables();
      for (const t of allTables) {
        if (TOMBSTONE_TABLES.has(t)) continue; // учётная запись обрабатывается отдельно (надгробие)
        const cols = columns(t);
        const isWhitelisted = ERASURE_FACT_WHITELIST.has(t);
        let changes = 0;
        if (cols.includes('patient_id')) {
          if (isWhitelisted) {
            // Стираем текстовые колонки, оставляя строку-факт.
            const textCols = cols.filter((c) => TEXT_COL_RE.test(c) && c !== 'id');
            if (textCols.length) {
              changes = db
                .prepare(`UPDATE "${t}" SET ${textCols.map((c) => `"${c}" = NULL`).join(', ')} WHERE patient_id = ?`)
                .run(pid).changes;
            }
          } else {
            changes = db.prepare(`DELETE FROM "${t}" WHERE patient_id = ?`).run(pid).changes;
          }
          if (changes) report.deleted[t] = (report.deleted[t] || 0) + changes;
        } else if (cols.includes('user_id')) {
          if (isWhitelisted) {
            const textCols = cols.filter((c) => TEXT_COL_RE.test(c) && c !== 'id');
            if (textCols.length) {
              changes = db
                .prepare(`UPDATE "${t}" SET ${textCols.map((c) => `"${c}" = NULL`).join(', ')} WHERE user_id = ?`)
                .run(pid).changes;
            }
          } else {
            changes = db.prepare(`DELETE FROM "${t}" WHERE user_id = ?`).run(pid).changes;
          }
          if (changes) report.deleted[t] = (report.deleted[t] || 0) + changes;
        }
      }
      // 5) приглашения: убрать связь с пациентом
      db.prepare('UPDATE invite_codes SET used_by = NULL WHERE used_by = ?').run(pid);
      // 6) учётная запись: стереть идентификацию (запись остаётся как «надгробие» без ПД)
      const cols = columns('users');
      const optional = [
        'contact_phone',
        'phone',
        'age_range',
        'gender',
        'sex',
        'nickname',
        'display_name',
        'contact',
      ].filter((c) => cols.includes(c));
      db.prepare(
        `UPDATE users SET email = NULL, email_hmac = NULL, password_hash = NULL, full_name = NULL,
           contact_phone = NULL, age_band = NULL, sex = NULL, status = 'tombstone', status_reason = 'owner_request',
           must_change_password = 0, sessions_valid_from = ?
           ${optional.map((c) => `, "${c}" = NULL`).join('')}
         WHERE id = ?`,
      ).run(nowIso, pid);
      // 7) запись о факте (без ПД) и журнал админа
      report.deleted_total = Object.values(report.deleted).reduce((a, b) => a + b, 0);
      db.prepare(
        "UPDATE data_subject_requests SET status = 'executed', executed_at = ?, executed_by = ?, report_json = ? WHERE id = ?",
      ).run(nowIso, adminId, JSON.stringify(report), req.id);
      core.logAdmin(adminId, 'deletion_execute', pid, {
        request_id: req.id,
        deleted_total: report.deleted_total,
        escalations_closed: openEsc.length,
      });
      const bad = db.prepare('PRAGMA foreign_key_check').all();
      if (bad.length) throw new Error(`foreign_key_check: ${JSON.stringify(bad.slice(0, 3))}`);
    })();
  } catch (e) {
    console.error('deletion failed', e);
    return { ok: false, error: 'Не удалось исполнить запрос: изменения отменены, данные остались на месте.' };
  } finally {
    db.pragma('foreign_keys = ON');
  }

  // файлы — после успешного коммита
  const toRemove = new Set(files.map(resolveFile).filter(Boolean));
  report.files_failed += files.length - [...files.map(resolveFile)].filter(Boolean).length;
  for (const f of toRemove) {
    try {
      fs.rmSync(f, { force: true });
      if (!fs.existsSync(f)) report.files_deleted++;
      else report.files_failed++;
    } catch {
      report.files_failed++;
    }
  }
  try {
    if (fs.existsSync(uploadDir)) {
      const n = countFiles(uploadDir);
      fs.rmSync(uploadDir, { recursive: true, force: true });
      if (!fs.existsSync(uploadDir)) report.files_deleted += n;
      else report.files_failed += n;
    }
  } catch {
    report.files_failed++;
  }
  db.prepare('UPDATE data_subject_requests SET report_json = ? WHERE id = ?').run(JSON.stringify(report), req.id);
  return { ok: true, report };
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }))
    n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  return n;
}

module.exports = {
  DELETION_DUE_DAYS,
  CATEGORY_LABELS,
  uploadRoot,
  inventory,
  retained,
  listRequests,
  getRequest,
  pendingCount,
  dueDate,
  execute,
};
