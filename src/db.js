'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.TDR_DB_PATH || path.join(DATA_DIR, 'tdr.sqlite3');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// удалённые строки (ПД, физическое удаление по запросу) затираются нулями, а не остаются в свободных страницах файла БД
db.pragma('secure_delete = ON');

function usersDdl(name) {
  return `
CREATE TABLE ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('patient','psychiatrist','psychologist','admin')),
  full_name TEXT NOT NULL,
  -- согласие пациента на обработку персональных данных и данных о здоровье
  -- (152-ФЗ ст.9 ч.4 — спец. категория, см. документ RES-3 «informed-consent», часть 1+2)
  consent_given INTEGER NOT NULL DEFAULT 0,
  consent_version TEXT,
  consent_at TEXT,
  -- отзыв согласия (152-ФЗ ст.9 ч.2, ст.14/21): если заполнено — пациент
  -- запросил отзыв/удаление, аккаунт переведён в account_status != 'active'
  consent_revoked_at TEXT,
  -- отдельное информированное согласие на использование результатов для
  -- наблюдения врачом/психологом (323-ФЗ ст.20) — юридически отдельное
  -- основание от согласия на обработку ПД выше (RES-3 «informed-consent»,
  -- часть 2); раздельный чекбокс в онбординге, см. RES-6
  clinical_consent_given INTEGER NOT NULL DEFAULT 0,
  clinical_consent_at TEXT,
  -- согласие на использование обезличенных данных в научной части
  -- (RES-3 «informed-consent», часть 3) — опциональное и отзывается отдельно
  anonymized_export_opt_in INTEGER NOT NULL DEFAULT 0,
  export_consent_revoked_at TEXT,
  -- 'active' | 'deletion_requested' | 'deleted' — право на отзыв согласия
  -- и удаление данных (152-ФЗ ст.14, 21); см. /account/deletion-request
  account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','deletion_requested','deleted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
}

db.exec(`
${usersDdl('users').replace('CREATE TABLE users','CREATE TABLE IF NOT EXISTS users')}

-- Минимизация данных (152-ФЗ): возрастной диапазон/пол собираются только у
-- пациента, только опционально и только ради п.2 документа
-- "anonymization-requirements" (демография для научного экспорта),
-- точная дата рождения не собирается вовсе.
-- ALTER TABLE ... ADD COLUMN идемпотентно догоняет схему на уже
-- существующей БД (ensureColumn ниже).

-- связь пациент <-> лечащий психиатр/психолог
CREATE TABLE IF NOT EXISTS care_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(patient_id, clinician_id)
);

CREATE TABLE IF NOT EXISTS instrument_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  assigned_by INTEGER NOT NULL REFERENCES users(id),
  instrument TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
  -- назначено автоматически движком кризисного протокола (напр. PHQ-9 п.9 ≥1
  -- -> обязательный C-SSRS Screen, RES-2 "scales-and-battery" §1.5), а не
  -- врачом вручную; assigned_by в этом случае = тот же врач, что уже ведёт
  -- пациента (техническое ограничение схемы: assigned_by NOT NULL)
  auto_assigned INTEGER NOT NULL DEFAULT 0,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- СПЕЦИАЛЬНАЯ КАТЕГОРИЯ ПД (данные о здоровье, 152-ФЗ ст.10) + врачебная тайна
-- (323-ФЗ ст.13): результаты скрининга. Доступ — только сам пациент и
-- закреплённые за ним клиницисты (см. care_assignments), см. SPECIAL_CATEGORY_TABLES.
CREATE TABLE IF NOT EXISTS online_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER REFERENCES instrument_assignments(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  instrument TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  total_score INTEGER NOT NULL,
  subscales_json TEXT,
  band TEXT,
  risk_flag INTEGER NOT NULL DEFAULT 0,
  risk_reasons_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- СПЕЦИАЛЬНАЯ КАТЕГОРИЯ ПД (данные о здоровье) + врачебная тайна (323-ФЗ ст.13).
-- Используется и для прямых офлайн-результатов шкал пациента (PHQ-9/GAD-7/
-- HADS/WHO-5, введённых врачом с бланка), и для патопсихологической батареи
-- психолога, которая по дизайну (RES-2 "scales-and-battery" §2) не имеет
-- онлайн-самотеста: BDI-II, фрагменты СМИЛ, STAI/Спилбергер-Ханин.
CREATE TABLE IF NOT EXISTS offline_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  entered_by INTEGER NOT NULL REFERENCES users(id),
  instrument TEXT NOT NULL,
  total_score INTEGER,
  subscales_json TEXT,
  -- критический пункт 9 (суицидальные мысли), если методика его выделяет
  -- отдельно (BDI-II) — хранится отдельно от total_score для сверки с
  -- C-SSRS и для discrepancy_item9 в comparison_pairs (RES-2 "literature-
  -- review-methodology" §2.2)
  item9_score INTEGER,
  band TEXT,
  risk_flag INTEGER NOT NULL DEFAULT 0,
  risk_reasons_json TEXT,
  test_date TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- W0.4: протоколы методик из каталога-заглушек (clinician_entered). Универсальные
-- поля: время, ошибки, баллы, наблюдения. status 'draft' — заглушка, не клиническое
-- заключение. Миграция только добавлением (CREATE TABLE IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS catalog_protocols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  entered_by INTEGER NOT NULL REFERENCES users(id),
  instrument TEXT NOT NULL,
  test_date TEXT NOT NULL,
  protocol_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- СПЕЦИАЛЬНАЯ КАТЕГОРИЯ ПД (данные о здоровье, риск для жизни) + врачебная тайна.
-- Кризисные эскалации создаются автоматически логикой подсчёта баллов,
-- не зависят от того, прочитал ли кто-то экран с текстом.
-- tier/triggers/due_at/SLA — см. RES-2 "crisis-protocol" §2-3: Tier 0-3,
-- триггеры A-F, SLA подтверждения 15 мин (рабочее время) / 30 мин (вне).
CREATE TABLE IF NOT EXISTS crisis_escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  online_result_id INTEGER REFERENCES online_results(id),
  instrument TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  tier INTEGER NOT NULL DEFAULT 1 CHECK (tier IN (0,1,2,3)),
  triggers_json TEXT NOT NULL DEFAULT '[]',
  -- дедлайн подтверждения по SLA протокола (null для Tier 0/1, которые не
  -- требуют немедленного ack — см. crisisProtocol.js)
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged_by INTEGER REFERENCES users(id),
  acknowledged_at TEXT,
  -- эскалация по цепочке дежурства при неподтверждении в SLA (RES-2
  -- "crisis-protocol" §3, Tier 2/3): кому передано и когда
  escalated_to_backup_at TEXT,
  backup_notified_id INTEGER REFERENCES users(id),
  -- ни основной, ни резервный специалист не подтвердили — процедурная
  -- гарантия ручного разбора, а не обещание результата (см. §3 Tier 3)
  unresolved INTEGER NOT NULL DEFAULT 0
);

-- Append-only журнал инцидентов кризисного протокола (RES-2 "crisis-protocol"
-- §3 "Журналирование"): приложение никогда не выполняет UPDATE/DELETE над
-- этой таблицей — только INSERT на каждое событие жизненного цикла эскалации
-- (создание, уведомление, подтверждение, передача резерву, unresolved).
-- Нужен и для безопасности пациента, и для юридической защиты сервиса.
CREATE TABLE IF NOT EXISTS crisis_incident_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  escalation_id INTEGER NOT NULL REFERENCES crisis_escalations(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created','specialist_notified','backup_notified','acknowledged','unresolved','manual_review_outcome'
  )),
  actor_id INTEGER REFERENCES users(id),
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Структура для научного сравнения офлайн/онлайн одного пациента (RES-2
-- "literature-review-methodology" §2.2-2.3): создаётся автоматически при
-- сохранении офлайн-результата (comparison.js), не вручную специалистом.
CREATE TABLE IF NOT EXISTS comparison_pairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  online_result_id INTEGER NOT NULL REFERENCES online_results(id),
  offline_result_id INTEGER NOT NULL REFERENCES offline_results(id),
  online_scale TEXT NOT NULL,
  offline_scale TEXT NOT NULL,
  -- 'same_scale_within_window' (<=14 дней, основная выборка) |
  -- 'same_scale_wide_window' (>14 дней, возможна реальная динамика) |
  -- 'cross_instrument' (напр. PHQ-9 <-> BDI-II, отдельная подвыборка)
  comparability TEXT NOT NULL CHECK (comparability IN (
    'same_scale_within_window','same_scale_wide_window','cross_instrument'
  )),
  time_delta_days REAL NOT NULL,
  discrepancy_raw INTEGER,
  discrepancy_item9 INTEGER,
  clinician_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(online_result_id, offline_result_id)
);

-- СПЕЦИАЛЬНАЯ КАТЕГОРИЯ ПД (данные о здоровье) — свободный текст заметки,
-- в научный экспорт не попадает ни в каком виде (см. research_export.js)
CREATE TABLE IF NOT EXISTS mood_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  mood_score INTEGER NOT NULL CHECK (mood_score BETWEEN 1 AND 10),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  remind_at TEXT NOT NULL,
  recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none','daily','weekly')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chatbot_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- СПЕЦИАЛЬНАЯ КАТЕГОРИЯ ПД (свободный текст переписки о состоянии здоровья).
-- Бот работает полностью локально (детерминированный разбор по ключевым
-- словам, см. chatbot.js) — текст никуда за пределы процесса не уходит,
-- поэтому трансграничной передачи (152-ФЗ ст.12) в текущей архитектуре нет.
-- Если в будущем подключается внешний LLM API — обязательно либо модель,
-- развёрнутая в РФ, либо обезличивание текста перед отправкой (см. COMPLIANCE.md).
CREATE TABLE IF NOT EXISTS chatbot_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES chatbot_sessions(id),
  sender TEXT NOT NULL CHECK (sender IN ('user','bot')),
  text TEXT NOT NULL,
  intent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --- Научный экспорт: псевдонимизация (см. RES-3 документ "anonymization-requirements") ---

-- Таблица сопоставления «псевдоним ↔ реальный patient_id» хранится отдельно
-- от самого датасета экспорта и не читается модулем research_export.js —
-- только таблицы ниже (research_pseudonyms, data_subject_requests,
-- export_audit_log, phi_access_log) считаются «контуром доступа», а не
-- «контуром данных для исследователей».
CREATE TABLE IF NOT EXISTS research_pseudonyms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  pseudonym TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- срок жизни записи сопоставления; значение берётся из
  -- RESEARCH_PSEUDONYM_TTL_DAYS (по умолчанию 180 дней, см. COMPLIANCE.md —
  -- конкретный срок под конкретное исследование фиксирует PlatformEngineer
  -- совместно с ClinicalLead)
  expires_at TEXT NOT NULL
);

-- Журнал каждого запуска научного экспорта (кто, когда, какой фильтр по
-- согласию применён, сколько строк) — требование п.4 документа
-- "anonymization-requirements"
CREATE TABLE IF NOT EXISTS export_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_by INTEGER REFERENCES users(id),
  run_at TEXT NOT NULL DEFAULT (datetime('now')),
  consent_filter TEXT NOT NULL,
  row_count INTEGER NOT NULL
);

-- Журнал обращений к врачебной тайне (152-ФЗ спец.категория + 323-ФЗ ст.13):
-- кто, к данным какого пациента, какое действие, когда
CREATE TABLE IF NOT EXISTS phi_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES users(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Реализация прав субъекта данных (152-ФЗ ст.14, 21): отзыв согласия,
-- отзыв согласия на научный экспорт, запрос удаления данных
CREATE TABLE IF NOT EXISTS data_subject_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  request_type TEXT NOT NULL CHECK (request_type IN ('export_consent_revocation','consent_revocation_and_deletion')),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  actions_taken_json TEXT NOT NULL
);
`);

// W1.C1: общее ИИ-ядро (треды/сообщения для всех ролей), аудит обращений без текста,
// настройки пользователя чата и обращения пациента к человеку. Только добавление.
db.exec(`
-- СПЕЦИАЛЬНАЯ КАТЕГОРИЯ ПД: title (свободный текст) и ai_messages.text.
-- role — роль владельца (patient | psychiatrist | psychologist); patient_id заполняется
-- для тредов ИИ-пространства врача, привязанных к пациенту (W1.C2), иначе NULL.
CREATE TABLE IF NOT EXISTS ai_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  patient_id INTEGER REFERENCES users(id),
  title TEXT NOT NULL DEFAULT 'Новый диалог',
  title_auto INTEGER NOT NULL DEFAULT 1,
  legacy_session_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_threads_owner ON ai_threads(owner_user_id, updated_at);

CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES ai_threads(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  text TEXT NOT NULL,
  -- normal | crisis (фиксированный кризисный ответ) | error (провайдер недоступен) | filtered (пост-фильтр)
  kind TEXT NOT NULL DEFAULT 'normal',
  intent TEXT,
  flags_json TEXT,
  legacy_message_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_messages_thread ON ai_messages(thread_id, id);

-- Аудит обращений к ИИ (REQ-AIP-014): БЕЗ текста сообщений. thread_id без FK:
-- запись остаётся после удаления диалога пациентом.
CREATE TABLE IF NOT EXISTS ai_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  thread_id INTEGER,
  event TEXT NOT NULL,
  crisis INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  intro_seen_at TEXT
);

-- «Связаться с человеком» (REQ-AIP-005 / REQ-CRI-005): обращение пациента — НЕ Tier-эскалация.
-- clinician_id NULL и to_admin = 1 — у пациента нет врача, обращение для очереди админа.
-- Это только запись в сервисе: внешнего оповещения нет. СПЕЦИАЛЬНАЯ КАТЕГОРИЯ ПД (text).
CREATE TABLE IF NOT EXISTS patient_contact_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  clinician_id INTEGER REFERENCES users(id),
  to_admin INTEGER NOT NULL DEFAULT 0,
  thread_id INTEGER,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','handled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  handled_by INTEGER REFERENCES users(id),
  handled_at TEXT
);
`);

// Идемпотентная догонка схемы для БД, созданных до появления новых колонок
// (CREATE TABLE IF NOT EXISTS не добавляет колонки в уже существующую таблицу).
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('instrument_assignments', 'auto_assigned', "INTEGER NOT NULL DEFAULT 0");
ensureColumn('offline_results', 'item9_score', 'INTEGER');
ensureColumn('offline_results', 'band', 'TEXT');
ensureColumn('offline_results', 'risk_flag', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('offline_results', 'risk_reasons_json', 'TEXT');
ensureColumn('crisis_escalations', 'tier', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('crisis_escalations', 'triggers_json', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('crisis_escalations', 'due_at', 'TEXT');
ensureColumn('crisis_escalations', 'escalated_to_backup_at', 'TEXT');
ensureColumn('crisis_escalations', 'backup_notified_id', 'INTEGER REFERENCES users(id)');
ensureColumn('crisis_escalations', 'unresolved', 'INTEGER NOT NULL DEFAULT 0');

// W0.5: идемпотентная миграция роли 'admin' (REQ-ADM-*). SQLite не умеет менять
// CHECK через ALTER, поэтому — стандартная процедура из документации SQLite
// («Making Other Kinds Of Table Schema Changes»): foreign_keys=OFF вне
// транзакции, новая таблица, копирование данных (id сохраняются, поэтому
// ссылки из других таблиц остаются валидными), DROP, RENAME, foreign_key_check.
function migrateUsersRoleAdmin() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!row || /'admin'/.test(row.sql)) return false;
  const oldCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(usersDdl('users_new'));
      const newCols = db.prepare('PRAGMA table_info(users_new)').all().map((c) => c.name);
      const common = newCols.filter((c) => oldCols.includes(c)).join(', ');
      db.exec(`INSERT INTO users_new (${common}) SELECT ${common} FROM users`);
      const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get();
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
      // не откатываем счётчик AUTOINCREMENT назад (id удалённых не переиспользуются)
      if (seq) db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'users'").run(seq.seq);
      const bad = db.prepare('PRAGMA foreign_key_check').all();
      if (bad.length) throw new Error(`users migration broke foreign keys: ${JSON.stringify(bad.slice(0, 3))}`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return true;
}

migrateUsersRoleAdmin();

// W1.A: кабинет пациента. Только идемпотентные добавления.
db.exec(`
-- черновики прохождения теста (ответ сохраняется на каждом шаге)
CREATE TABLE IF NOT EXISTS assignment_drafts (
  assignment_id INTEGER PRIMARY KEY REFERENCES instrument_assignments(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  answers_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- настройки пользователя: онбординг, что видит врач (OQ-2), тема, шрифт,
-- метка «все сессии, начатые раньше, недействительны» (смена пароля)
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  onboarding_pending INTEGER NOT NULL DEFAULT 0,
  share_diary_scores INTEGER NOT NULL DEFAULT 1,
  share_diary_notes INTEGER NOT NULL DEFAULT 0,
  share_ai_chats INTEGER NOT NULL DEFAULT 0,
  theme TEXT NOT NULL DEFAULT 'auto' CHECK (theme IN ('auto','light','dark')),
  large_font INTEGER NOT NULL DEFAULT 0,
  sessions_valid_from INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  had_clinician INTEGER NOT NULL DEFAULT 0
);

-- код-приглашение врача (создаёт кабинет клинициста, W1.B; пациент гасит код)
CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_by INTEGER REFERENCES users(id),
  used_at TEXT,
  revoked_at TEXT
);

-- «обращение пациента» («Мне сейчас тяжело, сообщить врачу»): не Tier-эскалация
CREATE TABLE IF NOT EXISTS patient_appeals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  clinician_id INTEGER REFERENCES users(id),
  routed_to TEXT NOT NULL DEFAULT 'clinician' CHECK (routed_to IN ('clinician','admin')),
  message TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged_by INTEGER REFERENCES users(id),
  acknowledged_at TEXT
);
`);
ensureColumn('mood_entries', 'entry_date', 'TEXT');
ensureColumn('mood_entries', 'sleep_hours', 'REAL');
ensureColumn('mood_entries', 'anxiety', 'INTEGER');
ensureColumn('mood_entries', 'triggers', 'TEXT');
ensureColumn('mood_entries', 'shared_once', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('mood_entries', 'updated_at', 'TEXT');
ensureColumn('users', 'contact_phone', 'TEXT');
ensureColumn('instrument_assignments', 'comment', 'TEXT');
// W1.B1: кабинет клинициста (сводка, список пациентов, кризисная очередь).
// Только добавление, идемпотентно. Общие с W1.A таблицы — та же форма, что согласована.
db.exec(`
CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  clinician_id INTEGER,
  created_at TEXT,
  expires_at TEXT,
  used_by INTEGER,
  used_at TEXT,
  revoked_at TEXT
);
-- обращение пациента «Мне сейчас тяжело, сообщить врачу» (REQ-PAT-003 / REQ-CRI-005):
-- отдельная метка, не Tier-эскалация; приоритет и SLA — review-required (OQ-13)
CREATE TABLE IF NOT EXISTS patient_appeals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER,
  clinician_id INTEGER,
  routed_to TEXT,
  message TEXT,
  status TEXT,
  created_at TEXT,
  acknowledged_by INTEGER,
  acknowledged_at TEXT
);
-- теги пациентов (свободные, необязательные), личные для клинициста
CREATE TABLE IF NOT EXISTS patient_tags (
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (clinician_id, patient_id, tag)
);
-- отложенные жёлтые флаги светофора (REQ-CLN-004); keys_json — ключи причин на момент откладывания
CREATE TABLE IF NOT EXISTS triage_snoozes (
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  until TEXT NOT NULL,
  keys_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (clinician_id, patient_id)
);
`);
ensureColumn('care_assignments', 'archived_at', 'TEXT');
// W1.C2: ИИ-пространство клинициста. Только добавление, идемпотентно.
db.exec(`
-- Материалы врача (REQ-AID-005/012). СПЕЦИАЛЬНАЯ КАТЕГОРИЯ ПД: name и text_extracted (свободный текст).
-- Файл хранится ВНЕ public/ под случайным именем (storage_path — абсолютный путь под <data>/uploads/ai); при включённом маскировании на диске и в БД
-- лежит только замаскированный текст. Срок хранения — expires_at; удаление стирает файл и строку.
CREATE TABLE IF NOT EXISTS ai_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES ai_threads(id),
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  patient_id INTEGER REFERENCES users(id),
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  storage_path TEXT,
  stored_as TEXT NOT NULL DEFAULT 'original',
  text_extracted TEXT NOT NULL DEFAULT '',
  has_text INTEGER NOT NULL DEFAULT 1,
  masked INTEGER NOT NULL DEFAULT 0,
  mask_count INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_attach_thread ON ai_attachments(thread_id, seq);
CREATE INDEX IF NOT EXISTS idx_ai_attach_exp ON ai_attachments(expires_at);

`);
ensureColumn('ai_audit', 'patient_id', 'INTEGER');
ensureColumn('ai_audit', 'files', 'INTEGER');

ensureColumn('crisis_escalations', 'stub_notified_at', 'TEXT');
ensureColumn('crisis_escalations', 'ack_outcome', 'TEXT');

// W1.D: кабинет администратора. Только добавление, идемпотентно.
// users: деактивация администратором, обязательная смена пароля (временный пароль),
// отметка «сессии, выданные до этого момента, недействительны» (сброс пароля/деактивация).
ensureColumn('users', 'deactivated_at', 'TEXT');
ensureColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'password_changed_at', 'TEXT');
ensureColumn('users', 'sessions_valid_from', 'TEXT');
ensureColumn('users', 'created_by', 'INTEGER');
// запросы субъекта данных: исполнение удаления (REQ-ADM-006). report_json — «что удалено», без ПД.
ensureColumn('data_subject_requests', 'status', "TEXT NOT NULL DEFAULT 'pending'");
ensureColumn('data_subject_requests', 'executed_at', 'TEXT');
ensureColumn('data_subject_requests', 'executed_by', 'INTEGER');
ensureColumn('data_subject_requests', 'report_json', 'TEXT');
ensureColumn('invite_codes', 'created_by', 'INTEGER');
db.exec(`
-- Журнал действий администратора (REQ-ADM-011, REQ-SEC-007): только на дополнение — приложение
-- не выполняет UPDATE/DELETE. detail_json без паролей и без клинического содержимого.
CREATE TABLE IF NOT EXISTS admin_action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  target_user_id INTEGER,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_action_log_created ON admin_action_log(created_at);
`);

// W1.B2: назначения (отмена, ожидание ввода врачом, срок/комментарий), заметки, повторы,
// пометка «ошибочный ввод». Только добавление. instrument_assignments пересоздаётся один раз
// (SQLite не умеет менять CHECK через ALTER) по процедуре из документации SQLite, как users.
const ASSIGNMENTS_DDL = `
CREATE TABLE instrument_assignments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  assigned_by INTEGER NOT NULL REFERENCES users(id),
  instrument TEXT NOT NULL,
  -- pending: ждёт прохождения пациентом; waiting_entry: ждёт ввода протокола врачом (пациент не видит);
  -- completed; cancelled: отменено врачом (REQ-CAT-012)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','cancelled','waiting_entry')),
  auto_assigned INTEGER NOT NULL DEFAULT 0,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  due_date TEXT,
  comment TEXT,
  cancelled_at TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancel_reason TEXT,
  batch_code TEXT,
  schedule_id INTEGER,
  entry_protocol_id INTEGER
);`;

function migrateAssignmentsStatus() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'instrument_assignments'").get();
  if (!row || /'cancelled'/.test(row.sql)) return false;
  const oldCols = db.prepare('PRAGMA table_info(instrument_assignments)').all().map((c) => c.name);
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(ASSIGNMENTS_DDL);
      const newCols = db.prepare('PRAGMA table_info(instrument_assignments_new)').all().map((c) => c.name);
      const common = newCols.filter((c) => oldCols.includes(c)).join(', ');
      db.exec(`INSERT INTO instrument_assignments_new (${common}) SELECT ${common} FROM instrument_assignments`);
      const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'instrument_assignments'").get();
      db.exec('DROP TABLE instrument_assignments');
      db.exec('ALTER TABLE instrument_assignments_new RENAME TO instrument_assignments');
      if (seq) db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'instrument_assignments'").run(seq.seq);
      const bad = db.prepare('PRAGMA foreign_key_check').all();
      if (bad.length) throw new Error(`assignments migration broke foreign keys: ${JSON.stringify(bad.slice(0, 3))}`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return true;
}
migrateAssignmentsStatus();
ensureColumn('instrument_assignments', 'due_date', 'TEXT');
ensureColumn('instrument_assignments', 'comment', 'TEXT');
ensureColumn('instrument_assignments', 'cancelled_at', 'TEXT');
ensureColumn('instrument_assignments', 'cancelled_by', 'INTEGER');
ensureColumn('instrument_assignments', 'cancel_reason', 'TEXT');
ensureColumn('instrument_assignments', 'batch_code', 'TEXT');
ensureColumn('instrument_assignments', 'schedule_id', 'INTEGER');
ensureColumn('instrument_assignments', 'entry_protocol_id', 'INTEGER');

// «Ошибочный ввод»: результат не удаляется, а исключается из динамики, светофора и экспорта (REQ-CAT-012)
for (const t of ['offline_results', 'catalog_protocols']) {
  ensureColumn(t, 'invalid_at', 'TEXT');
  ensureColumn(t, 'invalid_by', 'INTEGER');
  ensureColumn(t, 'invalid_reason', 'TEXT');
}
ensureColumn('catalog_protocols', 'assignment_id', 'INTEGER');

db.exec(`
-- расписание повторных назначений (REQ-CLN-020): не более одного ожидающего того же теста
CREATE TABLE IF NOT EXISTS assignment_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  instrument TEXT NOT NULL,
  every_days INTEGER NOT NULL CHECK (every_days BETWEEN 1 AND 365),
  next_due_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
-- СПЕЦИАЛЬНАЯ КАТЕГОРИЯ ПД: заметки клинициста (REQ-CLN-015), приватны автору (OQ-11); всё, кроме id, необязательно
CREATE TABLE IF NOT EXISTS clinician_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT,
  tags TEXT,
  note_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_clinician_notes_patient ON clinician_notes(patient_id, author_id);
-- «Лечение» (психиатр): необязательный список схем/заметок терапии. Публикация пациенту и журнал приёма — W2.F
CREATE TABLE IF NOT EXISTS treatment_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// W2.G: быстрые инструменты врача. Только добавление, идемпотентно. Без patient_id в таблицах импорта: связь с
// пациентом идёт через созданные результаты (offline_results / catalog_protocols), которые чистит удаление пациента.
db.exec(`
-- Шаблоны документов врача (REQ-TLS-002): текст с плейсхолдерами [ФИО], [дата]; данных пациента не хранит (подстановка при выгрузке).
CREATE TABLE IF NOT EXISTS tool_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_templates_owner ON tool_templates(owner_id);
-- СПЕЦИАЛЬНАЯ КАТЕГОРИЯ ПД (временно): загруженный CSV между шагами «предпросмотр» и «подтверждение»; удаляется после подтверждения/отмены, срок 1 час.
CREATE TABLE IF NOT EXISTS tool_import_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  encoding TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Партии импорта CSV (REQ-TLS-003): откат в течение 24 часов.
CREATE TABLE IF NOT EXISTS tool_import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_ok INTEGER NOT NULL DEFAULT 0,
  rows_skipped INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  rolled_back_at TEXT
);
CREATE TABLE IF NOT EXISTS tool_import_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES tool_import_batches(id),
  kind TEXT NOT NULL CHECK (kind IN ('offline','protocol')),
  result_id INTEGER NOT NULL,
  waiting_assignment_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tool_import_items_batch ON tool_import_items(batch_id);
-- Отложенные напоминания «пора повторить тест» (необязательные).
CREATE TABLE IF NOT EXISTS tool_repeat_snoozes (
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  until TEXT NOT NULL,
  PRIMARY KEY (clinician_id, patient_id)
);
`);

// W2.E: рабочее место заключений психолога (REQ-PSY-001..009). Миграция только добавлением.
// СПЕЦИАЛЬНАЯ КАТЕГОРИЯ ПД. Подписанная версия неизменяема (триггер); новая правка = новая версия.
// Между таблицами нет FK: обезличивание/удаление пациента (W1.D) чистит их по patient_id.
ensureColumn('catalog_protocols', 'session_id', 'INTEGER');
db.exec(`
CREATE TABLE IF NOT EXISTS exam_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  session_date TEXT NOT NULL,
  title TEXT,
  plan_json TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_exam_sessions_patient ON exam_sessions(patient_id);
CREATE TABLE IF NOT EXISTS conclusions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT,
  released_to_patient INTEGER NOT NULL DEFAULT 0,
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_conclusions_patient ON conclusions(patient_id);
CREATE TABLE IF NOT EXISTS conclusion_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conclusion_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed')),
  title TEXT,
  sections_json TEXT NOT NULL DEFAULT '{}',
  protocol_refs_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  signed_by INTEGER,
  signed_name TEXT,
  signed_at TEXT,
  sign_method TEXT,
  checksum TEXT,
  UNIQUE (conclusion_id, version)
);
CREATE TRIGGER IF NOT EXISTS conclusion_versions_signed_immutable
BEFORE UPDATE ON conclusion_versions
WHEN OLD.status = 'signed'
BEGIN
  SELECT RAISE(ABORT, 'signed conclusion version is immutable');
END;
`);
// W2.F: психообразование, приём лекарств, сообщения врач-пациент, опросник перед приёмом. Только добавление.
// У всех таблиц с данными пациента есть patient_id: удаление данных (admin_deletion) чистит их автоматически.
db.exec(`
CREATE TABLE IF NOT EXISTS psychoed_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  module_key TEXT NOT NULL,
  assigned_by INTEGER NOT NULL REFERENCES users(id),
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (patient_id, module_key)
);
CREATE TABLE IF NOT EXISTS psychoed_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  module_key TEXT NOT NULL,
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (patient_id, module_key)
);
-- Пункты плана приёма. source='clinician': план психиатра (свободный текст), виден пациенту только после published_at;
-- source='patient': личный список пациента (врачу виден по настройке share_med_own).
CREATE TABLE IF NOT EXISTS med_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  source TEXT NOT NULL CHECK (source IN ('clinician','patient')),
  author_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  how_text TEXT,
  slot TEXT NOT NULL DEFAULT 'none' CHECK (slot IN ('morning','evening','both','none')),
  published_at TEXT,
  ack_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS med_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  item_id INTEGER NOT NULL REFERENCES med_items(id),
  day TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('morning','evening','any')),
  status TEXT NOT NULL CHECK (status IN ('taken','skipped','later')),
  logged_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, day, slot)
);
-- Асинхронные сообщения: тред = пара (пациент, клиницист). Админ текст не читает (нет маршрута).
CREATE TABLE IF NOT EXISTS care_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  sender_role TEXT NOT NULL CHECK (sender_role IN ('patient','clinician')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT,
  handled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_care_messages_thread ON care_messages(patient_id, clinician_id, id);
CREATE TABLE IF NOT EXISTS care_clinician_settings (
  clinician_id INTEGER PRIMARY KEY REFERENCES users(id),
  reply_note TEXT,
  away_until TEXT
);
CREATE TABLE IF NOT EXISTS previsit_forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','skipped','cancelled')),
  answers_json TEXT,
  submitted_at TEXT
);
`);
ensureColumn('user_prefs', 'share_med_log', 'INTEGER NOT NULL DEFAULT 1');
// W2.X (D7): пациенту нужно спокойно сообщить «врач изменился / наблюдение завершено»; NULL — нечего показывать
ensureColumn('user_prefs', 'care_change_kind', 'TEXT');
ensureColumn('user_prefs', 'care_change_at', 'TEXT');
ensureColumn('user_prefs', 'share_med_own', 'INTEGER NOT NULL DEFAULT 0');

module.exports = db;

// Реестр таблиц/полей, классифицированных как специальная категория
// персональных данных (152-ФЗ ст.10, данные о здоровье) и/или врачебная
// тайна (323-ФЗ ст.13). Используется для документации и как единая точка
// правды для access-логирования и для того, что НИКОГДА не должно попасть
// в научный экспорт в текстовом/построчном виде.
module.exports.SPECIAL_CATEGORY_TABLES = {
  online_results: { classification: 'special_category_health_data', freeTextFields: [] },
  offline_results: { classification: 'special_category_health_data', freeTextFields: ['notes'] },
  catalog_protocols: { classification: 'special_category_health_data', freeTextFields: ['protocol_json'] },
  crisis_escalations: { classification: 'special_category_health_data', freeTextFields: ['reasons_json'] },
  mood_entries: { classification: 'special_category_health_data', freeTextFields: ['note', 'triggers'] },
  assignment_drafts: { classification: 'special_category_health_data', freeTextFields: ['answers_json'] },
  patient_appeals: { classification: 'special_category_health_data', freeTextFields: ['message'] },
  chatbot_messages: { classification: 'special_category_health_data', freeTextFields: ['text'] },
  ai_threads: { classification: 'special_category_health_data', freeTextFields: ['title'] },
  ai_messages: { classification: 'special_category_health_data', freeTextFields: ['text', 'flags_json'] },
  ai_attachments: { classification: 'special_category_health_data', freeTextFields: ['name', 'text_extracted', 'note'] },
  patient_contact_requests: { classification: 'special_category_health_data', freeTextFields: ['text'] },
  instrument_assignments: { classification: 'linked_to_health_data', freeTextFields: [] },
  crisis_incident_log: { classification: 'special_category_health_data', freeTextFields: ['detail_json'] },
  comparison_pairs: { classification: 'special_category_health_data', freeTextFields: ['clinician_note'] },
  clinician_notes: { classification: 'special_category_health_data', freeTextFields: ['body', 'tags'] },
  treatment_items: { classification: 'special_category_health_data', freeTextFields: ['body'] },
  tool_import_drafts: { classification: 'special_category_health_data', freeTextFields: ['content'] },
  tool_templates: { classification: 'free_text_clinician_authored', freeTextFields: ['title', 'body'] },
  exam_sessions: { classification: 'special_category_health_data', freeTextFields: ['title', 'note'] },
  conclusions: { classification: 'special_category_health_data', freeTextFields: ['title'] },
  conclusion_versions: { classification: 'special_category_health_data', freeTextFields: ['title', 'sections_json', 'reason'] },
  med_items: { classification: 'special_category_health_data', freeTextFields: ['name', 'how_text'] },
  med_log: { classification: 'special_category_health_data', freeTextFields: [] },
  care_messages: { classification: 'special_category_health_data', freeTextFields: ['body'] },
  previsit_forms: { classification: 'special_category_health_data', freeTextFields: ['answers_json'] },
  psychoed_progress: { classification: 'linked_to_health_data', freeTextFields: [] },
  psychoed_assignments: { classification: 'linked_to_health_data', freeTextFields: [] },
};
