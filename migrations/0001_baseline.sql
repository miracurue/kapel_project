-- Clinical Compass — черновая целевая схема SQLite (этап 11, 2026-10-17).
-- Это ПРОЕКТ, а не миграция: этап 12/14 разрезает его на пронумерованные файлы migrations/NNNN_*.sql.
-- Проверка: файл целиком выполняется на пустой базе в памяти (команда в 11-database.md, Self-check).
-- Соглашения:
--   * id INTEGER PRIMARY KEY; время — TEXT ISO-8601 UTC ('2026-10-17T09:30:00Z'); флаги — INTEGER 0/1 с CHECK;
--   * JSON — TEXT с CHECK (json_valid(...));
--   * новые таблицы — STRICT (SQLite сам проверяет типы);
--   * поля *_enc — шифротекст AEAD уровня приложения (формат 'v1:<key_id>:<base64>'); в synthetic допускается
--     демо-ключ, ключи — только в переменных окружения, не в базе;
--   * поля [ЧПД] — чувствительные персональные данные (здоровье/тайна), [ПД] — обычные ПД (см. 11-database.md, таблица полей);
--   * организация одна (01, 08 Basis) — признака организации в таблицах нет.
PRAGMA foreign_keys = ON;

-- =====================================================================
-- 0. Служебное
-- =====================================================================
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,               -- номер файла миграции
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,                    -- sha256 текста миграции
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;

-- =====================================================================
-- 1. Учётные записи, вход, сессии
-- =====================================================================
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_no TEXT NOT NULL UNIQUE,           -- служебный номер «П-000123» (админ видит пациента только им)
  email TEXT UNIQUE COLLATE NOCASE,          -- [ПД]; NULL у «надгробия» и у пациента без почты
  email_hmac TEXT UNIQUE,                    -- HMAC нижнего регистра почты: журналы и поиск без открытой почты
  password_hash TEXT,                        -- bcrypt; NULL у «надгробия»
  role TEXT NOT NULL CHECK (role IN ('patient','psychiatrist','psychologist','admin')),
  full_name TEXT,                            -- [ПД]; NULL у «надгробия»
  contact_phone TEXT,                        -- [ПД] необязательно
  age_band TEXT CHECK (age_band IN ('18-24','25-34','35-44','45-54','55-64','65+')), -- квази-ID, опционально
  sex TEXT CHECK (sex IN ('f','m','na')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','deactivated','deletion_requested','tombstone')),
  status_reason TEXT,                        -- код причины из списка S-54
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  flag_clinical_lead INTEGER NOT NULL DEFAULT 0 CHECK (flag_clinical_lead IN (0,1)),
  flag_research INTEGER NOT NULL DEFAULT 0 CHECK (flag_research IN (0,1)),
  flag_reference_reviewer INTEGER NOT NULL DEFAULT 0 CHECK (flag_reference_reviewer IN (0,1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  password_changed_at TEXT,
  sessions_valid_from TEXT,                  -- сессии старше — недействительны
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT,
  updated_by INTEGER REFERENCES users(id),
  CHECK (status = 'tombstone' OR (email IS NOT NULL OR role = 'patient') AND full_name IS NOT NULL)
);
CREATE INDEX idx_users_role_status ON users(role, status);
CREATE INDEX idx_users_name ON users(full_name COLLATE NOCASE) WHERE role <> 'patient';

CREATE TABLE user_prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  onboarding_done_at TEXT,
  ai_intro_seen_at TEXT,
  share_diary_scores INTEGER NOT NULL DEFAULT 1 CHECK (share_diary_scores IN (0,1)),
  share_diary_notes INTEGER NOT NULL DEFAULT 0 CHECK (share_diary_notes IN (0,1)),
  share_med_log INTEGER NOT NULL DEFAULT 1 CHECK (share_med_log IN (0,1)),
  hints_enabled INTEGER NOT NULL DEFAULT 1 CHECK (hints_enabled IN (0,1)),          -- F-34 у врача
  course_support_enabled INTEGER NOT NULL DEFAULT 1 CHECK (course_support_enabled IN (0,1)),
  timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
  theme TEXT NOT NULL DEFAULT 'auto' CHECK (theme IN ('auto','light','dark')),
  large_font INTEGER NOT NULL DEFAULT 0 CHECK (large_font IN (0,1)),
  care_change_kind TEXT, care_change_at TEXT,
  last_seen_at TEXT,
  reply_note TEXT,                           -- автоответ специалиста (было care_clinician_settings)
  updated_at TEXT
) STRICT;

CREATE TABLE external_accounts (            -- будущие боты и вход через другие сервисы; в MVP пусто
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK (provider IN ('telegram','max','esia','other')),
  external_id_hmac TEXT NOT NULL,            -- внешний ID только хешем
  linked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  revoked_at TEXT,
  UNIQUE (provider, external_id_hmac)
) STRICT;
CREATE INDEX idx_ext_user ON external_accounts(user_id);

CREATE TABLE sessions (                     -- DB-03, DB-04: вместо памяти процесса
  sid_hash TEXT PRIMARY KEY,                 -- sha256 ID сессии из cookie
  user_id INTEGER REFERENCES users(id),      -- NULL — анонимная
  data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)), -- без ПД, только флаги/CSRF
  device_label TEXT,                         -- «Chrome · Windows», без fingerprint
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  abs_expires_at TEXT NOT NULL,
  closed_at TEXT, close_reason TEXT
) STRICT;
CREATE INDEX idx_sessions_user ON sessions(user_id) WHERE closed_at IS NULL;
CREATE INDEX idx_sessions_exp ON sessions(idle_expires_at);

CREATE TABLE login_attempts (               -- DB-02
  id INTEGER PRIMARY KEY,
  email_hmac TEXT, ip_hmac TEXT,
  user_id INTEGER REFERENCES users(id),
  result TEXT NOT NULL CHECK (result IN ('ok','bad_password','unknown','blocked','second_factor_fail','locked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;
CREATE INDEX idx_login_email ON login_attempts(email_hmac, created_at);
CREATE INDEX idx_login_ip ON login_attempts(ip_hmac, created_at);

CREATE TABLE rate_counters (                -- F-23: окна лимитов (вход, загрузки, ИИ, коды)
  key TEXT NOT NULL,                         -- 'ai.patient:<user_id>', 'upload:<user_id>' …
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
) STRICT, WITHOUT ROWID;

CREATE TABLE password_reset_tokens (        -- DB-10
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','superseded','expired')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  used_at TEXT
) STRICT;
CREATE INDEX idx_reset_user ON password_reset_tokens(user_id, status);

CREATE TABLE second_factor (                -- DB-113
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  secret_enc TEXT NOT NULL,                  -- TOTP-секрет, AEAD ключом TOTP_ENC_KEY
  enabled_at TEXT,
  last_step INTEGER,                         -- последний принятый шаг времени (код не принимается дважды)
  failed_count INTEGER NOT NULL DEFAULT 0,
  reset_at TEXT, reset_by INTEGER REFERENCES users(id)
) STRICT;
CREATE TABLE second_factor_backup_codes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  used_at TEXT,
  UNIQUE (user_id, code_hash)
) STRICT;

CREATE TABLE invite_codes (                 -- DB-06, DB-87
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,            -- сам код показывается один раз и не хранится
  clinician_id INTEGER REFERENCES users(id), -- NULL — приглашение администратора без специалиста
  created_by INTEGER NOT NULL REFERENCES users(id),
  episode_reopen_patient_id INTEGER REFERENCES users(id), -- повторное подключение архивного (F-94)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','revoked','expired')),
  expires_at TEXT NOT NULL,
  used_by INTEGER REFERENCES users(id), used_at TEXT, revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_invite_clinician ON invite_codes(clinician_id, status);
CREATE INDEX idx_invite_exp ON invite_codes(status, expires_at);

-- =====================================================================
-- 2. Версионируемый контент: документы сервиса, согласия, справка, шаблоны
-- =====================================================================
CREATE TABLE content_versions (             -- DB-92, DB-122 (S-46, S-47, S-64)
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                        -- 'doc.policy','consent.base','consent.ai','consent.research','consent.program','help.patient','doc_template.discharge' …
  version INTEGER NOT NULL,
  body_md TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  sign_method TEXT,                          -- для согласий: 'demo_click' | модуль юриста
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','published','superseded','rejected')),
  publish_from TEXT,                         -- «опубликовать с даты»
  basis TEXT,                                -- основание при real («утверждено юристом …»)
  is_stand_in INTEGER NOT NULL DEFAULT 0 CHECK (is_stand_in IN (0,1)),
  author_id INTEGER REFERENCES users(id),   -- NULL = «система» (начальная загрузка)
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  published_at TEXT,
  UNIQUE (kind, version)
) STRICT;
CREATE INDEX idx_content_kind_status ON content_versions(kind, status, version DESC);
CREATE TRIGGER content_published_immutable BEFORE UPDATE OF body_md, body_sha256 ON content_versions
WHEN OLD.status IN ('published','superseded') BEGIN SELECT RAISE(ABORT,'published content is immutable'); END;

CREATE TABLE consent_events (               -- DB-08, DB-09; только добавление
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  consent_kind TEXT NOT NULL CHECK (consent_kind IN ('base','ai','research','program')),
  action TEXT NOT NULL CHECK (action IN ('given','revoked')),
  content_version_id INTEGER NOT NULL REFERENCES content_versions(id), -- согласие ссылается на версию текста
  text_sha256 TEXT NOT NULL,
  sign_method TEXT NOT NULL,
  ip_hmac TEXT,                              -- IP хешем (доказательство, Q-03)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;
CREATE INDEX idx_consent_user_kind ON consent_events(user_id, consent_kind, id DESC);
CREATE INDEX idx_consent_kind_action ON consent_events(consent_kind, action, user_id);
CREATE TRIGGER consent_events_append_only BEFORE UPDATE ON consent_events BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE VIEW consent_current AS               -- последнее событие по каждому виду решает
SELECT e.* FROM consent_events e
WHERE e.id = (SELECT MAX(id) FROM consent_events x WHERE x.user_id = e.user_id AND x.consent_kind = e.consent_kind);

-- =====================================================================
-- 3. Настройки, утверждения, секреты, чек-лист real
-- =====================================================================
CREATE TABLE setting_versions (             -- DB-91, DB-97, DB-98, DB-99; все S-01…S-66
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,                         -- 'crisis.sla', 'prompt.patient_assistant' хранится в prompt_versions
  version INTEGER NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  status TEXT NOT NULL CHECK (status IN ('draft','pending_approval','active','previous','rejected')),
  is_clinical INTEGER NOT NULL DEFAULT 0 CHECK (is_clinical IN (0,1)),
  author_id INTEGER REFERENCES users(id),   -- NULL = «система»
  comment TEXT,
  approved_by_text TEXT,                     -- synthetic: «кто утвердил» (ФИО, должность, дата)
  approved_by INTEGER REFERENCES users(id), -- real: КО
  approved_at TEXT,
  basis TEXT,                                -- юридически значимые при real
  rolled_back_from INTEGER,                  -- номер версии, значение которой вернули
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (key, version),
  CHECK (approved_by IS NULL OR approved_by <> author_id)
) STRICT;
CREATE UNIQUE INDEX uq_setting_active ON setting_versions(key) WHERE status = 'active';
CREATE INDEX idx_setting_key_ver ON setting_versions(key, version DESC);
CREATE TRIGGER setting_value_immutable BEFORE UPDATE OF value_json, key, version ON setting_versions
BEGIN SELECT RAISE(ABORT,'setting version is immutable'); END;

CREATE TABLE approvals (                    -- DB-100: очередь утверждений КО
  id INTEGER PRIMARY KEY,
  object_type TEXT NOT NULL CHECK (object_type IN ('setting','prompt','binding','content','instrument','library','eval_set')),
  object_id INTEGER NOT NULL,                -- id версии в соответствующей таблице
  object_key TEXT NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','superseded')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT, reason TEXT,
  check_run_id INTEGER,                      -- прогон набора/кризисного корпуса
  reminded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (decided_by IS NULL OR decided_by <> author_id)
) STRICT;
CREATE INDEX idx_approvals_pending ON approvals(status, created_at);

CREATE TABLE secret_meta (                  -- DB-119: только метаданные; значения — в файле хранилища секретов
  name TEXT PRIMARY KEY,                     -- 'gigachat.auth_key','smtp.password'
  is_set INTEGER NOT NULL DEFAULT 0 CHECK (is_set IN (0,1)),
  source TEXT NOT NULL DEFAULT 'store' CHECK (source IN ('store','env')),
  set_by INTEGER REFERENCES users(id), set_at TEXT,
  last_check_at TEXT, last_check_ok INTEGER CHECK (last_check_ok IN (0,1)), last_check_error TEXT
) STRICT;

CREATE TABLE real_checklist_marks (         -- DB-131, S-59
  item_code TEXT PRIMARY KEY,                -- 14 пунктов L-48
  checked INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0,1)),
  confirmed_by_text TEXT,                    -- кто подтвердил (юрист, ИБ, клиника)
  document_ref TEXT,
  marked_by INTEGER REFERENCES users(id),
  marked_at TEXT
) STRICT;
CREATE TABLE real_checklist_history (
  id INTEGER PRIMARY KEY, item_code TEXT NOT NULL, checked INTEGER NOT NULL,
  confirmed_by_text TEXT, document_ref TEXT, marked_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;

-- =====================================================================
-- 4. Журналы (только добавление)
-- =====================================================================
CREATE TABLE phi_access_log (               -- DB-32, DB-34
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES users(id),
  actor_role TEXT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  section TEXT NOT NULL,                     -- 'card.overview','tab.diary','crisis','file','ai.context','account.credentials','export'
  action TEXT NOT NULL,                      -- 'view','list','download','export'
  decision TEXT NOT NULL DEFAULT 'allow' CHECK (decision IN ('allow','deny')),
  basis TEXT CHECK (basis IN ('self','assignment','substitution','crisis','admin_service','research')),
  object_type TEXT, object_id INTEGER,
  session_tag TEXT,                          -- для дедупликации 1 мин
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_phi_patient_time ON phi_access_log(patient_id, created_at DESC);
CREATE INDEX idx_phi_actor_time ON phi_access_log(actor_id, created_at DESC);
CREATE INDEX idx_phi_time ON phi_access_log(created_at);
CREATE TRIGGER phi_log_no_update BEFORE UPDATE ON phi_access_log BEGIN SELECT RAISE(ABORT,'append-only'); END;

CREATE TABLE action_log (                   -- DB-33 (было admin_action_log; все роли)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES users(id),     -- NULL = система/команда на сервере
  actor_role TEXT,
  action TEXT NOT NULL,                      -- 'auth.login','setting.save','user.block','catalog.merge' …
  target_type TEXT, target_id INTEGER,
  target_user_id INTEGER,
  old_safe_json TEXT CHECK (old_safe_json IS NULL OR json_valid(old_safe_json)), -- коды/хеши/длины, без ПД и текстов
  new_safe_json TEXT CHECK (new_safe_json IS NULL OR json_valid(new_safe_json)),
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_action_time ON action_log(created_at);
CREATE INDEX idx_action_actor ON action_log(actor_id, created_at);
CREATE INDEX idx_action_target_user ON action_log(target_user_id, created_at);
CREATE INDEX idx_action_kind ON action_log(action, created_at);
CREATE TRIGGER action_log_no_update BEFORE UPDATE ON action_log BEGIN SELECT RAISE(ABORT,'append-only'); END;

CREATE TABLE export_log (                   -- DB-86 (было export_audit_log)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('self_export','research','program','clinical_doc','ae_notice','logs_csv','settings_json','ai_thread','subject_answer')),
  patient_id INTEGER REFERENCES users(id),   -- для личных и клинических
  filter_json TEXT CHECK (filter_json IS NULL OR json_valid(filter_json)),
  consent_filter TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  file_sha256 TEXT,
  recipient_class TEXT,                      -- 'patient','clinician','sponsor_aggregate','researcher','admin'
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;
CREATE INDEX idx_export_time ON export_log(created_at);
CREATE INDEX idx_export_patient ON export_log(patient_id, created_at);
CREATE TRIGGER export_log_no_update BEFORE UPDATE ON export_log BEGIN SELECT RAISE(ABORT,'append-only'); END;

CREATE TABLE ai_audit (                     -- DB-35; без текстов
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  purpose TEXT NOT NULL,                     -- patient_assistant | clinician_chat | … | admin_assistant | eval
  thread_id INTEGER,                         -- без FK: запись остаётся после стирания треда
  patient_id INTEGER,
  model_id INTEGER, binding_version INTEGER, prompt_version INTEGER,
  data_mode TEXT NOT NULL CHECK (data_mode IN ('synthetic','real')),
  status TEXT NOT NULL CHECK (status IN ('ok','fallback','error','timeout','crisis','filtered','limit')),
  crisis INTEGER NOT NULL DEFAULT 0 CHECK (crisis IN (0,1)),
  duration_ms INTEGER, tokens_in INTEGER, tokens_out INTEGER,
  files INTEGER NOT NULL DEFAULT 0,
  pii_counts_json TEXT CHECK (pii_counts_json IS NULL OR json_valid(pii_counts_json)), -- {"PERSON":2,"PHONE":1}
  pii_mode TEXT CHECK (pii_mode IN ('ner+rules','rules_only')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;
CREATE INDEX idx_ai_audit_time ON ai_audit(created_at);
CREATE INDEX idx_ai_audit_purpose ON ai_audit(purpose, created_at);

-- =====================================================================
-- 5. Закрепления, эпизоды, замещения
-- =====================================================================
CREATE TABLE care_episodes (                -- DB-82, DB-111
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  started_at TEXT NOT NULL,
  opened_by INTEGER REFERENCES users(id),
  ended_at TEXT, ended_by INTEGER REFERENCES users(id),
  end_reason TEXT CHECK (end_reason IN ('course_completed','transferred','refused','other')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;
CREATE UNIQUE INDEX uq_episode_active ON care_episodes(patient_id) WHERE ended_at IS NULL;

CREATE TABLE care_assignments (             -- DB-14, DB-110
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  episode_id INTEGER REFERENCES care_episodes(id),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_by INTEGER REFERENCES users(id),
  ended_at TEXT, ended_by INTEGER REFERENCES users(id),
  end_reason TEXT                            -- 'archive','reassign','patient_request','deactivated','admin'
);
CREATE UNIQUE INDEX uq_assignment_active ON care_assignments(patient_id, clinician_id) WHERE ended_at IS NULL;
CREATE INDEX idx_assign_clinician ON care_assignments(clinician_id, ended_at);
CREATE INDEX idx_assign_patient ON care_assignments(patient_id, ended_at);

CREATE TABLE substitutions (                -- DB-83, DB-112
  id INTEGER PRIMARY KEY,
  absent_id INTEGER NOT NULL REFERENCES users(id),
  substitute_id INTEGER NOT NULL REFERENCES users(id),
  scope TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all','selected')),
  date_from TEXT NOT NULL, date_to TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','rejected','ended','cancelled')),
  kind TEXT NOT NULL DEFAULT 'temporary' CHECK (kind IN ('temporary','permanent')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  confirmed_by INTEGER REFERENCES users(id), confirmed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (absent_id <> substitute_id), CHECK (date_from <= date_to)
) STRICT;
CREATE INDEX idx_subst_sub_dates ON substitutions(substitute_id, status, date_from, date_to);
CREATE INDEX idx_subst_abs_dates ON substitutions(absent_id, status, date_from, date_to);
CREATE TABLE substitution_patients (
  substitution_id INTEGER NOT NULL REFERENCES substitutions(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (substitution_id, patient_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE patient_tags (
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (clinician_id, patient_id, tag)
);
CREATE TABLE triage_snoozes (
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  until TEXT NOT NULL,
  keys_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (clinician_id, patient_id)
);

-- =====================================================================
-- 6. Файлы (описания; сами файлы вне базы и вне public/)
-- =====================================================================
CREATE TABLE stored_files (                 -- DB-17, DB-18, DB-19; было ai_attachments
  id INTEGER PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  patient_id INTEGER REFERENCES users(id),   -- область данных пациента (стирание по нему)
  purpose TEXT NOT NULL CHECK (purpose IN ('temp_upload','audio_temp','ai_attachment','message_attachment','ae_attachment','offline_source','library_media','export_bundle','subject_answer','import_csv')),
  storage_name TEXT NOT NULL UNIQUE,         -- случайное имя под <data>/files/, права 0600
  original_name_enc TEXT,                    -- [ЧПД возможно] исходное имя только шифротекстом
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  scan_status TEXT NOT NULL DEFAULT 'not_required' CHECK (scan_status IN ('not_required','pending','clean','infected','error')),
  exif_stripped INTEGER NOT NULL DEFAULT 0 CHECK (exif_stripped IN (0,1)),
  text_extracted TEXT,                       -- [ЧПД] распознанный текст (для ИИ — с ключами F-80)
  text_status TEXT CHECK (text_status IN ('none','printed','handwritten_unrecognized','failed')),
  linked_type TEXT,                          -- 'ai_message','care_message','adverse_event','offline_result','library_version','export_link'
  linked_id INTEGER,
  status TEXT NOT NULL DEFAULT 'temp' CHECK (status IN ('temp','linked','hidden','deleted')),
  hidden_at TEXT,
  expires_at TEXT,                           -- temp: +20 мин (S-23); ИИ: +30 дн.
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;
CREATE INDEX idx_files_exp ON stored_files(status, expires_at);
CREATE INDEX idx_files_link ON stored_files(linked_type, linked_id);
CREATE INDEX idx_files_patient ON stored_files(patient_id);

-- =====================================================================
-- 7. Кризисные сигналы и обращения
-- =====================================================================
CREATE TABLE crisis_escalations (           -- DB-20, DB-77, DB-78, DB-79 (имя таблицы сохранено)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  source TEXT NOT NULL,                      -- 'test','diary','ai_chat','message','appeal','previsit','ae','offline'
  source_ref_type TEXT, source_ref_id INTEGER,
  online_result_id INTEGER REFERENCES online_results(id),
  instrument TEXT,
  tier INTEGER NOT NULL DEFAULT 1 CHECK (tier IN (0,1,2,3)),
  triggers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(triggers_json)),
  quote_enc TEXT,                            -- [ЧПД] минимальная цитата; стирается при стирании пациента
  reasons_json TEXT,                         -- (наследие) коды причин
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_work','handled')),
  version INTEGER NOT NULL DEFAULT 1,
  due_at TEXT,
  taken_by INTEGER REFERENCES users(id), taken_at TEXT,
  handled_by INTEGER REFERENCES users(id), handled_at TEXT,
  outcome_code TEXT, outcome_note_enc TEXT,  -- [ЧПД] заметка до 500
  outcome_due_at TEXT,                       -- напоминание взявшему (S-19)
  escalated_to_backup_at TEXT, backup_notified_id INTEGER REFERENCES users(id),
  manual_review_at TEXT,                     -- второй срок → служебная очередь
  admin_assigned_to INTEGER REFERENCES users(id), -- «только этот сигнал» (F-83)
  last_appended_at TEXT,                     -- дописан повтор за 24 ч
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_crisis_patient_status ON crisis_escalations(patient_id, status, created_at);
CREATE INDEX idx_crisis_status_due ON crisis_escalations(status, due_at);
CREATE INDEX idx_crisis_taken ON crisis_escalations(taken_by) WHERE status = 'in_work';

CREATE TABLE crisis_incident_log (          -- DB-21; только добавление
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  escalation_id INTEGER NOT NULL REFERENCES crisis_escalations(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('created','appended','specialist_notified','taken','released','contacted',
    'outcome','undo','backup_notified','manual_review','admin_assigned','returned_to_new','unresolved','manual_review_outcome','acknowledged')),
  actor_id INTEGER REFERENCES users(id),
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)), -- коды; свободный текст запрещён
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_incident_esc ON crisis_incident_log(escalation_id, id);
CREATE TRIGGER incident_no_update BEFORE UPDATE ON crisis_incident_log BEGIN SELECT RAISE(ABORT,'append-only'); END;

CREATE TABLE patient_appeals (              -- DB-22 (объединены patient_appeals + patient_contact_requests)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  clinician_id INTEGER REFERENCES users(id),
  routed_to TEXT NOT NULL DEFAULT 'clinician' CHECK (routed_to IN ('clinician','service_queue')),
  kind TEXT NOT NULL DEFAULT 'need_help' CHECK (kind IN ('need_help','contact_human')),
  message_enc TEXT,                          -- [ЧПД]
  escalation_id INTEGER REFERENCES crisis_escalations(id),
  thread_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged')),
  acknowledged_by INTEGER REFERENCES users(id), acknowledged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_appeals_clin ON patient_appeals(clinician_id, status);
CREATE INDEX idx_appeals_patient ON patient_appeals(patient_id);

-- =====================================================================
-- 8. Отмена, повтор, уведомления, письма, задачи
-- =====================================================================
CREATE TABLE undo_actions (                 -- DB-23, DB-24
  key_hash TEXT PRIMARY KEY,                 -- случайный ключ, выдан автору
  author_id INTEGER NOT NULL REFERENCES users(id),
  action_type TEXT NOT NULL,                 -- 'diary.save','assignment.send','crisis.take' …
  method TEXT NOT NULL CHECK (method IN ('delayed_visibility','soft_delete','inverse')),
  object_type TEXT NOT NULL, object_id INTEGER NOT NULL,
  inverse_json TEXT CHECK (inverse_json IS NULL OR json_valid(inverse_json)), -- данные обратного действия (ссылки до слияния и т. п.)
  window_until TEXT NOT NULL,                -- сейчас + S-01; сервер принимает ещё +5 с
  state TEXT NOT NULL DEFAULT 'applied' CHECK (state IN ('applied','undone','final')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  undone_at TEXT
) STRICT;
CREATE INDEX idx_undo_window ON undo_actions(state, window_until);

CREATE TABLE idempotency_keys (             -- DB-26
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  response_json TEXT,                        -- итог без ПД: статус и ID созданного объекта
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (user_id, key)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_idem_time ON idempotency_keys(created_at);

CREATE TABLE notifications (                -- DB-27, DB-28, DB-29
  id INTEGER PRIMARY KEY,
  recipient_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  event_key TEXT NOT NULL,                   -- одно уведомление на событие и получателя
  object_type TEXT, object_id INTEGER,
  title TEXT NOT NULL,                       -- нейтральный, без клиники (инициалы/номер)
  caption TEXT,                              -- «в работе у …»
  patient_id INTEGER REFERENCES users(id),   -- для стирания и скрытия при откреплении (не показывается)
  visible_from TEXT NOT NULL,
  read_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (recipient_id, event_key)
) STRICT;
CREATE INDEX idx_notif_recipient ON notifications(recipient_id, read_at, visible_from DESC);
CREATE INDEX idx_notif_object ON notifications(object_type, object_id);
CREATE INDEX idx_notif_created ON notifications(created_at);

CREATE TABLE mail_queue (                   -- DB-30, DB-120
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('password_reset','test')),
  user_id INTEGER REFERENCES users(id),
  to_enc TEXT NOT NULL,                      -- [ПД] адрес шифротекстом; стирается после отправки/срока
  to_hmac TEXT NOT NULL,
  ref_type TEXT, ref_id INTEGER,             -- токен сброса
  template_version INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','retry','failed','expired')),
  smtp_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  sent_at TEXT,
  UNIQUE (ref_type, ref_id)
) STRICT;
CREATE INDEX idx_mail_due ON mail_queue(status, next_attempt_at);

CREATE TABLE scheduled_jobs (               -- DB-31, DB-130
  name TEXT PRIMARY KEY,                     -- 'reminders','crisis_due','retention', …
  last_started_at TEXT, last_finished_at TEXT,
  last_status TEXT CHECK (last_status IN ('ok','error')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  lease_until TEXT                           -- «взято» до (защита от двойного запуска)
) STRICT;
CREATE TABLE job_marks (                    -- «выполнено» для единичных действий (напоминание N, показ поддержки…)
  job TEXT NOT NULL,
  item_key TEXT NOT NULL,
  done_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (job, item_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE service_queue (                -- DB-101, DB-102: служебная очередь администратора
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('crisis_no_clinician','crisis_manual_review','ae_no_psychiatrist','message_no_clinician',
     'erasure','subject_info','stop_processing','dispute_access','change_clinician','substitution','patient_without_clinician',
     'mail_failed','job_failed','ai_budget','correction_overdue','catalog_review')),
  patient_id INTEGER REFERENCES users(id),   -- показывается номером
  ref_type TEXT, ref_id INTEGER,             -- ссылка на сигнал/запрос/НЯ (без текста)
  priority INTEGER NOT NULL DEFAULT 5,       -- 0 — кризис без специалиста
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','taken','done','rejected','waiting')),
  taken_by INTEGER REFERENCES users(id), taken_at TEXT,
  closed_by INTEGER REFERENCES users(id), closed_at TEXT, result_code TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;
CREATE INDEX idx_queue_open ON service_queue(status, priority, due_at);
CREATE INDEX idx_queue_ref ON service_queue(ref_type, ref_id);
CREATE UNIQUE INDEX uq_queue_open_ref ON service_queue(kind, ref_type, ref_id) WHERE status IN ('new','taken','waiting');

-- =====================================================================
-- 9. Запросы субъекта, выгрузки, исправления
-- =====================================================================
CREATE TABLE data_subject_requests (        -- DB-67, DB-103 (пересоздаётся: новые виды и статусы)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  request_type TEXT NOT NULL CHECK (request_type IN ('erasure','correction','info','stop_processing','dispute_access',
     'change_clinician','consent_revocation','export_consent_revocation','consent_revocation_and_deletion')),
  subject_ref_type TEXT, subject_ref_id INTEGER, -- что исправить / какой доступ оспорен / какой специалист
  text_enc TEXT,                             -- [ЧПД] «что неверно», причина
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','in_work','done','rejected','cancelled','waiting_crisis','pending','executed')),
  due_at TEXT NOT NULL,
  assignee_id INTEGER REFERENCES users(id),
  answer_enc TEXT,                           -- ответ/причина отказа пациенту
  answer_file_id INTEGER REFERENCES stored_files(id),
  answer_visible_from TEXT,
  executed_at TEXT, executed_by INTEGER REFERENCES users(id),
  report_json TEXT,                          -- «что стёрто» — категории и числа
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  actions_taken_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_dsr_patient ON data_subject_requests(patient_id, request_type, status);
CREATE INDEX idx_dsr_due ON data_subject_requests(status, due_at);
CREATE UNIQUE INDEX uq_dsr_open ON data_subject_requests(patient_id, request_type, IFNULL(subject_ref_type,''), IFNULL(subject_ref_id,0))
  WHERE status IN ('submitted','in_work','waiting_crisis','pending');

CREATE TABLE export_links (                 -- DB-66
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  file_id INTEGER NOT NULL REFERENCES stored_files(id),
  link_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,                  -- +15 мин
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;

CREATE TABLE record_revisions (             -- F-54: история версий клинических записей при исправлении
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  table_name TEXT NOT NULL,                  -- 'mood_entries','offline_results','med_log' …
  row_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  before_json TEXT NOT NULL CHECK (json_valid(before_json)), -- [ЧПД] прежние значения
  reason TEXT NOT NULL,
  request_id INTEGER REFERENCES data_subject_requests(id),
  changed_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (table_name, row_id, revision)
) STRICT;
CREATE INDEX idx_revisions_patient ON record_revisions(patient_id);

CREATE TABLE research_pseudonyms (          -- DB-85; ключ HMAC — вне базы
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  pseudonym TEXT NOT NULL UNIQUE,            -- HMAC-SHA256(RESEARCH_HMAC_KEY, patient_id || study)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL                   -- +180 дн. (S-23)
);
CREATE INDEX idx_pseud_exp ON research_pseudonyms(expires_at);

-- =====================================================================
-- 10. Методики, назначения, результаты
-- =====================================================================
CREATE TABLE instruments (                  -- DB-48, DB-123
  code TEXT PRIMARY KEY,                     -- 'phq9','gad7','cssrs','who5','bdi2','stai','mmpi', 'hads' (только 'blocked')
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('scale','battery','protocol','previsit')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','stand_in','withdrawn','blocked')),
  online_allowed INTEGER NOT NULL DEFAULT 0 CHECK (online_allowed IN (0,1)),  -- право онлайн-показа (L-40)
  self_service INTEGER NOT NULL DEFAULT 0 CHECK (self_service IN (0,1)),      -- F-38
  rights_holder TEXT, rights_basis TEXT, translation_source TEXT, rights_checked_at TEXT, -- L-41
  current_version INTEGER,
  updated_at TEXT, updated_by INTEGER REFERENCES users(id)
) STRICT;
CREATE TRIGGER instruments_hads_blocked BEFORE UPDATE OF status ON instruments
WHEN NEW.code = 'hads' AND NEW.status <> 'blocked' BEGIN SELECT RAISE(ABORT,'HADS is blocked'); END;
CREATE TRIGGER instruments_hads_insert BEFORE INSERT ON instruments
WHEN NEW.code = 'hads' AND NEW.status <> 'blocked' BEGIN SELECT RAISE(ABORT,'HADS is blocked'); END;

CREATE TABLE instrument_versions (
  id INTEGER PRIMARY KEY,
  instrument_code TEXT NOT NULL REFERENCES instruments(code),
  version INTEGER NOT NULL,
  schema_json TEXT NOT NULL CHECK (json_valid(schema_json)), -- M-12: вопросы, типы, варианты, баллы, reverse
  scoring_json TEXT NOT NULL CHECK (json_valid(scoring_json)),
  bands_json TEXT,                           -- словесные полосы (review-required)
  is_stand_in INTEGER NOT NULL DEFAULT 0 CHECK (is_stand_in IN (0,1)),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','published','superseded')),
  author_id INTEGER REFERENCES users(id), approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (instrument_code, version)
) STRICT;

CREATE TABLE package_templates (            -- DB-74, S-53
  id INTEGER PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id),     -- NULL — общий пакет администратора
  title TEXT NOT NULL,
  items_json TEXT NOT NULL CHECK (json_valid(items_json)), -- 2–10 кодов методик
  is_shared INTEGER NOT NULL DEFAULT 0 CHECK (is_shared IN (0,1)),
  hidden_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT
) STRICT;
CREATE INDEX idx_pkg_owner ON package_templates(owner_id, hidden_at);

CREATE TABLE instrument_assignments (       -- DB-45, DB-72, DB-73
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  assigned_by INTEGER REFERENCES users(id),  -- NULL — авто (кризисный протокол)
  instrument TEXT NOT NULL,
  instrument_version INTEGER,                -- начатое прохождение держит свою версию
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','cancelled','waiting_entry')),
  auto_assigned INTEGER NOT NULL DEFAULT 0,
  visible_from TEXT,                         -- отложенная видимость (F-17)
  batch_code TEXT, package_template_id INTEGER REFERENCES package_templates(id),
  schedule_id INTEGER,
  due_date TEXT, comment TEXT,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  cancelled_at TEXT, cancelled_by INTEGER REFERENCES users(id), cancel_reason TEXT,
  entry_protocol_id INTEGER
);
CREATE INDEX idx_ia_patient ON instrument_assignments(patient_id, status, assigned_at DESC);
CREATE INDEX idx_ia_batch ON instrument_assignments(batch_code);
CREATE UNIQUE INDEX uq_ia_open ON instrument_assignments(patient_id, instrument) WHERE status IN ('pending','in_progress','waiting_entry');

CREATE TABLE assignment_drafts (            -- DB-46
  assignment_id INTEGER PRIMARY KEY REFERENCES instrument_assignments(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  answers_json TEXT NOT NULL DEFAULT '{}',   -- [ЧПД]
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE assignment_schedules (
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
CREATE INDEX idx_sched_due ON assignment_schedules(active, next_due_at);

CREATE TABLE online_results (               -- DB-47
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER UNIQUE REFERENCES instrument_assignments(id), -- один результат на назначение
  patient_id INTEGER NOT NULL REFERENCES users(id),
  instrument TEXT NOT NULL,
  instrument_version INTEGER,
  answers_json TEXT NOT NULL,                -- [ЧПД]
  total_score INTEGER NOT NULL,
  subscales_json TEXT, band TEXT,
  risk_flag INTEGER NOT NULL DEFAULT 0, risk_reasons_json TEXT,
  self_initiated INTEGER NOT NULL DEFAULT 0 CHECK (self_initiated IN (0,1)), -- F-38
  shared_at TEXT,                            -- «Показать врачу» (для самостоятельных)
  invalid_at TEXT, invalid_by INTEGER, invalid_reason TEXT,
  supersedes_id INTEGER REFERENCES online_results(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_online_patient ON online_results(patient_id, instrument, created_at);

CREATE TABLE offline_results (              -- DB-76
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  entered_by INTEGER NOT NULL REFERENCES users(id),
  instrument TEXT NOT NULL,
  total_score INTEGER, subscales_json TEXT, item9_score INTEGER, band TEXT,
  risk_flag INTEGER NOT NULL DEFAULT 0, risk_reasons_json TEXT,
  test_date TEXT NOT NULL,
  notes TEXT,                                -- [ЧПД]
  entry_method TEXT NOT NULL DEFAULT 'form' CHECK (entry_method IN ('form','voice','photo','file','csv')),
  source_file_id INTEGER REFERENCES stored_files(id),
  status TEXT NOT NULL DEFAULT 'saved' CHECK (status IN ('draft','saved')),
  invalid_at TEXT, invalid_by INTEGER, invalid_reason TEXT,
  supersedes_id INTEGER REFERENCES offline_results(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_offline_patient ON offline_results(patient_id, instrument, test_date);

CREATE TABLE catalog_protocols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  entered_by INTEGER NOT NULL REFERENCES users(id),
  instrument TEXT NOT NULL, test_date TEXT NOT NULL,
  protocol_json TEXT NOT NULL,               -- [ЧПД]
  status TEXT NOT NULL DEFAULT 'draft',
  assignment_id INTEGER, session_id INTEGER, source_file_id INTEGER REFERENCES stored_files(id),
  invalid_at TEXT, invalid_by INTEGER, invalid_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_protocols_patient ON catalog_protocols(patient_id, test_date);

CREATE TABLE comparison_pairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  online_result_id INTEGER NOT NULL REFERENCES online_results(id),
  offline_result_id INTEGER NOT NULL REFERENCES offline_results(id),
  online_scale TEXT NOT NULL, offline_scale TEXT NOT NULL,
  comparability TEXT NOT NULL CHECK (comparability IN ('same_scale_within_window','same_scale_wide_window','cross_instrument')),
  time_delta_days REAL NOT NULL,
  discrepancy_raw INTEGER, discrepancy_item9 INTEGER,
  clinician_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (online_result_id, offline_result_id)
);
CREATE INDEX idx_pairs_scale ON comparison_pairs(online_scale, created_at);

CREATE TABLE exam_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  session_date TEXT NOT NULL, title TEXT, plan_json TEXT NOT NULL DEFAULT '[]', note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
);
CREATE INDEX idx_exam_sessions_patient ON exam_sessions(patient_id);

-- =====================================================================
-- 11. Дневник, напоминания, поддержка курса
-- =====================================================================
CREATE TABLE mood_entries (                 -- DB-49
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  entry_date TEXT NOT NULL,
  mood INTEGER CHECK (mood BETWEEN 1 AND 5),
  sleep TEXT CHECK (sleep IN ('bad','ok','good')),
  anxiety TEXT CHECK (anxiety IN ('none','some','strong')),
  triggers_json TEXT,                        -- [ЧПД] коды списка S-54 + «другое» до 100
  note TEXT,                                 -- [ЧПД] до 2 000
  legacy_mood_score INTEGER, legacy_sleep_hours REAL, -- значения старой схемы (1–10, часы)
  hidden_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  CHECK (mood IS NOT NULL OR sleep IS NOT NULL OR anxiety IS NOT NULL OR triggers_json IS NOT NULL OR note IS NOT NULL OR legacy_mood_score IS NOT NULL)
);
CREATE INDEX idx_mood_patient_day ON mood_entries(patient_id, entry_date) WHERE hidden_at IS NULL;
CREATE INDEX idx_mood_hidden ON mood_entries(hidden_at) WHERE hidden_at IS NOT NULL;

CREATE TABLE reminders (                    -- DB-51
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('med','diary','custom')),
  plan_item_id INTEGER REFERENCES plan_items(id),
  patient_med_id INTEGER REFERENCES patient_meds(id),
  message TEXT NOT NULL,
  time_hhmm TEXT NOT NULL,                   -- в часовом поясе пациента
  days_mask INTEGER NOT NULL DEFAULT 127,    -- пн..вс
  remind_at TEXT,                            -- (наследие) разовое время
  recurrence TEXT NOT NULL DEFAULT 'daily' CHECK (recurrence IN ('none','daily','weekly')),
  snooze_until TEXT,                         -- «напомнить через час»
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX idx_reminders_patient ON reminders(patient_id, active);
CREATE INDEX idx_reminders_due ON reminders(active, time_hhmm);

CREATE TABLE course_support_shown (         -- DB-55
  patient_id INTEGER NOT NULL REFERENCES users(id),
  rule_key TEXT NOT NULL,
  week INTEGER NOT NULL,
  shown_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (patient_id, rule_key, week)
) STRICT, WITHOUT ROWID;

-- =====================================================================
-- 12. Справочник МНН, торговые наименования, аптеки, поиск
-- =====================================================================
CREATE TABLE reference_versions (           -- DB-125: версии импорта / ручной правки каталога
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('drugs','pharmacies')),
  source TEXT NOT NULL,                      -- 'ESKLP','GRLS','manual','stand_in'
  source_date TEXT,
  file_id INTEGER REFERENCES stored_files(id),
  status TEXT NOT NULL CHECK (status IN ('preview','applied','rolled_back','superseded')),
  stats_json TEXT CHECK (stats_json IS NULL OR json_valid(stats_json)),  -- добавлено/изменено/снято/ошибки
  applied_by INTEGER REFERENCES users(id), applied_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;

CREATE TABLE inn (                          -- МНН психиатрии (DB-54, DB-133)
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,                        -- «сертралин»
  name_norm TEXT NOT NULL,                   -- нормализованное (регистр, ё→е, пробелы)
  drug_group TEXT NOT NULL CHECK (drug_group IN ('antidepressant','anxiolytic','antipsychotic','mood_stabilizer','hypnotic_sedative','corrector','other')),
  atc_code TEXT,
  rx_only INTEGER CHECK (rx_only IN (0,1)),
  status TEXT NOT NULL DEFAULT 'in_catalog' CHECK (status IN ('in_catalog','pending','merged','rejected','withdrawn')),
  merged_into_id INTEGER REFERENCES inn(id),
  source TEXT NOT NULL,                      -- 'ESKLP','GRLS','manual_checked','entered_by_patient','entered_by_clinician','stand_in'
  source_date TEXT,
  author_id INTEGER REFERENCES users(id),    -- только для pending; в очереди не показывается
  reject_reason TEXT,
  version_added INTEGER REFERENCES reference_versions(id),
  version_removed INTEGER REFERENCES reference_versions(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT, updated_by INTEGER REFERENCES users(id),
  CHECK (status <> 'merged' OR merged_into_id IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX uq_inn_name_catalog ON inn(name_norm) WHERE status = 'in_catalog';
CREATE INDEX idx_inn_group ON inn(status, drug_group, name_norm);

CREATE TABLE drug_products (                -- торговые наименования (дженерики)
  id INTEGER PRIMARY KEY,
  inn_id INTEGER NOT NULL REFERENCES inn(id),
  trade_name TEXT NOT NULL,                  -- «Золофт»
  trade_name_norm TEXT NOT NULL,
  manufacturer TEXT,
  dosage_form TEXT,                          -- «таблетки, покрытые оболочкой»
  strength TEXT,                             -- «50 мг»
  reg_number TEXT,                           -- № РУ (если есть)
  status TEXT NOT NULL DEFAULT 'in_catalog' CHECK (status IN ('in_catalog','pending','merged','rejected','withdrawn')),
  merged_into_id INTEGER REFERENCES drug_products(id),
  source TEXT NOT NULL,
  source_date TEXT,
  author_id INTEGER REFERENCES users(id),
  reject_reason TEXT, reject_text_for_patient TEXT,
  version_added INTEGER REFERENCES reference_versions(id),
  version_removed INTEGER REFERENCES reference_versions(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT, updated_by INTEGER REFERENCES users(id),
  CHECK (status <> 'merged' OR merged_into_id IS NOT NULL)
) STRICT;
CREATE INDEX idx_products_inn ON drug_products(inn_id, status, trade_name_norm);
CREATE INDEX idx_products_pending ON drug_products(status, trade_name_norm, created_at) WHERE status = 'pending';
CREATE INDEX idx_products_author ON drug_products(author_id, created_at) WHERE status = 'pending';

CREATE TABLE drug_search_terms (            -- DB-134: все написания для подсказок
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('inn','product')),
  entity_id INTEGER NOT NULL,
  inn_id INTEGER NOT NULL REFERENCES inn(id),-- для фильтра «только этот МНН»
  term_norm TEXT NOT NULL,                   -- нормализованная кириллица
  origin TEXT NOT NULL CHECK (origin IN ('name','synonym','merged_spelling','translit','layout')),
  visibility TEXT NOT NULL DEFAULT 'all' CHECK (visibility IN ('all','author')),
  author_id INTEGER REFERENCES users(id),    -- для 'author' (записи «на проверке»)
  UNIQUE (entity_type, entity_id, term_norm)
) STRICT;
CREATE INDEX idx_terms_prefix ON drug_search_terms(term_norm);             -- начало слова, точное совпадение, запросы из 2 букв
CREATE INDEX idx_terms_inn ON drug_search_terms(inn_id, term_norm);
CREATE VIRTUAL TABLE drug_search_fts USING fts5(            -- кандидаты по триграммам (опечатки), затем пересчёт в приложении
  term_norm, content='drug_search_terms', content_rowid='id', tokenize='trigram remove_diacritics 1');
CREATE TRIGGER drug_terms_ai AFTER INSERT ON drug_search_terms BEGIN
  INSERT INTO drug_search_fts(rowid, term_norm) VALUES (new.id, new.term_norm); END;
CREATE TRIGGER drug_terms_ad AFTER DELETE ON drug_search_terms BEGIN
  INSERT INTO drug_search_fts(drug_search_fts, rowid, term_norm) VALUES ('delete', old.id, old.term_norm); END;
CREATE TRIGGER drug_terms_au AFTER UPDATE ON drug_search_terms BEGIN
  INSERT INTO drug_search_fts(drug_search_fts, rowid, term_norm) VALUES ('delete', old.id, old.term_norm);
  INSERT INTO drug_search_fts(rowid, term_norm) VALUES (new.id, new.term_norm); END;

CREATE TABLE catalog_change_log (           -- построчная история каталога: откат версии импорта, ручные правки, слияния
  id INTEGER PRIMARY KEY,
  version_id INTEGER REFERENCES reference_versions(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('inn','product','pharmacy')),
  entity_id INTEGER NOT NULL,
  change TEXT NOT NULL CHECK (change IN ('add','update','withdraw','accept','merge','reject','restore')),
  before_json TEXT, after_json TEXT,
  actor_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;
CREATE INDEX idx_catlog_entity ON catalog_change_log(entity_type, entity_id);
CREATE INDEX idx_catlog_version ON catalog_change_log(version_id);

CREATE TABLE catalog_merge_refs (           -- DB-140: какие ссылки пациентов перенесены (для «Отменить» и истории)
  id INTEGER PRIMARY KEY,
  change_log_id INTEGER NOT NULL REFERENCES catalog_change_log(id),
  ref_table TEXT NOT NULL CHECK (ref_table IN ('purchase_marks','patient_med_versions','plan_items')),
  ref_id INTEGER NOT NULL,
  old_entity_id INTEGER NOT NULL,
  new_entity_id INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_mergerefs_log ON catalog_merge_refs(change_log_id);

CREATE TABLE pharmacy_links (               -- S-52, DB-54
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  url_template TEXT NOT NULL CHECK (url_template LIKE 'https://%' AND url_template LIKE '%{inn}%'),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  is_stand_in INTEGER NOT NULL DEFAULT 1 CHECK (is_stand_in IN (0,1)),
  version_added INTEGER REFERENCES reference_versions(id),
  updated_at TEXT, updated_by INTEGER REFERENCES users(id)
) STRICT;

-- =====================================================================
-- 13. План терапии (МНН), препараты пациента, отметки покупки и приёма
-- =====================================================================
CREATE TABLE plan_versions (                -- DB-53, DB-75
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL,                  -- 0 = черновик (один на пациента), публикации 1, 2, 3…
  status TEXT NOT NULL CHECK (status IN ('draft','published','superseded','cancelled')),
  author_id INTEGER NOT NULL REFERENCES users(id),
  recommendations_enc TEXT,                  -- [ЧПД] текст рекомендаций (было treatment_items)
  ai_generated INTEGER NOT NULL DEFAULT 0 CHECK (ai_generated IN (0,1)),
  visible_from TEXT,                         -- публикация видна через окно «Отменить»
  edit_rev INTEGER NOT NULL DEFAULT 1,       -- номер правки черновика для E-CONFLICT
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  published_at TEXT,
  UNIQUE (patient_id, version)
) STRICT;
CREATE UNIQUE INDEX uq_plan_draft ON plan_versions(patient_id) WHERE status = 'draft';
CREATE INDEX idx_plan_published ON plan_versions(patient_id, status, version DESC);

CREATE TABLE plan_items (                   -- пункт плана: только МНН (без торгового наименования)
  id INTEGER PRIMARY KEY,
  plan_version_id INTEGER NOT NULL REFERENCES plan_versions(id),
  item_key TEXT NOT NULL,                    -- сквозной ключ пункта между версиями (отметки «принято» живут по нему)
  inn_id INTEGER NOT NULL REFERENCES inn(id),-- может указывать на МНН «на проверке»
  dose_value REAL, dose_unit TEXT,
  times_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(times_json)), -- ['morning','evening'] или '08:00'
  start_date TEXT, end_date TEXT, duration_text TEXT,
  comment_enc TEXT,                          -- [ЧПД] комментарий пациенту до 1 000
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  UNIQUE (plan_version_id, item_key)
) STRICT;
CREATE INDEX idx_plan_items_key ON plan_items(item_key);
CREATE INDEX idx_plan_items_inn ON plan_items(inn_id);

CREATE TABLE plan_item_acceptance (         -- «Принять» пункт (F-42), по сквозному ключу
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  item_key TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  review_needed INTEGER NOT NULL DEFAULT 0 CHECK (review_needed IN (0,1)), -- новая версия плана → «проверьте»
  hidden_at TEXT,                            -- «Отменить» принятие
  UNIQUE (patient_id, item_key)
) STRICT;

CREATE TABLE patient_meds (                 -- DB-135, DB-136: препарат, внесённый пациентом
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  current_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  ended_at TEXT,
  hidden_at TEXT,                            -- «Отменить» добавления
  reviewed_version INTEGER,                  -- «врач видел» — номер версии
  reviewed_by INTEGER REFERENCES users(id), reviewed_at TEXT,
  doctor_comment_enc TEXT,                   -- [ЧПД] виден пациенту
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT
) STRICT;
CREATE INDEX idx_pmeds_patient ON patient_meds(patient_id, status) WHERE hidden_at IS NULL;
CREATE INDEX idx_pmeds_unreviewed ON patient_meds(patient_id) WHERE reviewed_version IS NULL OR reviewed_version < current_version;

CREATE TABLE patient_med_versions (
  id INTEGER PRIMARY KEY,
  patient_med_id INTEGER NOT NULL REFERENCES patient_meds(id),
  version INTEGER NOT NULL,
  inn_id INTEGER NOT NULL REFERENCES inn(id),
  product_id INTEGER NOT NULL REFERENCES drug_products(id), -- дженерик обязателен (NOT NULL)
  product_entered_text TEXT,                 -- «вы ввели: …» — сохраняется при слиянии
  dose_value REAL, dose_unit TEXT,
  times_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(times_json)),
  end_date TEXT,
  comment_enc TEXT,                          -- [ЧПД] до 300
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (patient_med_id, version)
) STRICT;
CREATE INDEX idx_pmv_product ON patient_med_versions(product_id);
CREATE INDEX idx_pmv_inn ON patient_med_versions(inn_id);

CREATE TABLE purchase_marks (               -- DB-52: «купил(а) препарат» к пункту плана; история
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  item_key TEXT NOT NULL,                    -- пункт плана (сквозной ключ)
  product_id INTEGER NOT NULL REFERENCES drug_products(id), -- обязательно (E-GENERIC-REQUIRED)
  entered_text TEXT,                         -- что ввёл пациент
  dosage_form TEXT, strength TEXT,           -- уточнение, «не знаю» = NULL
  inn_mismatch INTEGER NOT NULL DEFAULT 0 CHECK (inn_mismatch IN (0,1)),
  status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current','previous','needs_clarification','hidden')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  replaced_at TEXT
) STRICT;
CREATE UNIQUE INDEX uq_purchase_current ON purchase_marks(patient_id, item_key) WHERE status = 'current';
CREATE INDEX idx_purchase_product ON purchase_marks(product_id);

CREATE TABLE med_log (                      -- DB-50: отметка приёма
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  item_key TEXT,                             -- пункт плана
  patient_med_id INTEGER REFERENCES patient_meds(id),
  item_id INTEGER,                           -- (наследие med_items.id) — удаляется после переноса
  day TEXT NOT NULL,
  slot TEXT NOT NULL,                        -- 'morning','day','evening','night','HH:MM','any'
  status TEXT NOT NULL CHECK (status IN ('taken','skipped','later')),
  hidden_at TEXT,
  logged_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((item_key IS NOT NULL) + (patient_med_id IS NOT NULL) = 1)
);
CREATE UNIQUE INDEX uq_medlog_plan ON med_log(patient_id, item_key, day, slot) WHERE item_key IS NOT NULL AND hidden_at IS NULL;
CREATE UNIQUE INDEX uq_medlog_own ON med_log(patient_med_id, day, slot) WHERE patient_med_id IS NOT NULL AND hidden_at IS NULL;
CREATE INDEX idx_medlog_patient_day ON med_log(patient_id, day);

-- =====================================================================
-- 14. Побочные эффекты (НЯ) и извещения
-- =====================================================================
CREATE TABLE adverse_events (               -- DB-56, DB-57
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  complaint_codes_json TEXT,                 -- чипы S-54
  description_enc TEXT,                      -- [ЧПД] до 1 000
  onset_date TEXT,
  severity TEXT CHECK (severity IN ('mild','noticeable','severe')),
  relation_patient TEXT CHECK (relation_patient IN ('yes','no','unknown')),
  item_key TEXT, patient_med_id INTEGER REFERENCES patient_meds(id), inn_id INTEGER REFERENCES inn(id),
  source TEXT NOT NULL DEFAULT 'form' CHECK (source IN ('form','diary','ai_chat','message')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','cancelled','awaiting_doctor','service_queue','related_likely','not_related','insufficient')),
  visible_from TEXT,
  psychiatrist_id INTEGER REFERENCES users(id),
  decision_by INTEGER REFERENCES users(id), decision_at TEXT,
  serious INTEGER CHECK (serious IN (0,1)),
  decision_comment_enc TEXT,                 -- [ЧПД]
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT
) STRICT;
CREATE INDEX idx_ae_patient ON adverse_events(patient_id, created_at DESC);
CREATE INDEX idx_ae_status ON adverse_events(status, psychiatrist_id, created_at);
CREATE INDEX idx_ae_inn ON adverse_events(inn_id, status);

CREATE TABLE ae_notice_versions (           -- DB-58
  id INTEGER PRIMARY KEY,
  adverse_event_id INTEGER NOT NULL REFERENCES adverse_events(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL,
  fields_enc TEXT NOT NULL,                  -- [ЧПД] поля формы приложения 1 Порядка № 3518 (JSON → AEAD)
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready')),
  author_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (adverse_event_id, version)
) STRICT;
CREATE TRIGGER ae_notice_ready_immutable BEFORE UPDATE ON ae_notice_versions WHEN OLD.status = 'ready'
BEGIN SELECT RAISE(ABORT,'ready notice is immutable'); END;

-- =====================================================================
-- 15. Сообщения, визиты, анкеты
-- =====================================================================
CREATE TABLE care_messages (                -- DB-59, DB-60
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  clinician_id INTEGER REFERENCES users(id), -- NULL → служебная очередь (нет специалиста)
  sender_id INTEGER REFERENCES users(id),
  sender_role TEXT NOT NULL CHECK (sender_role IN ('patient','clinician')),
  body TEXT NOT NULL,                        -- [ЧПД]
  visible_from TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT, handled_at TEXT
);
CREATE INDEX idx_care_messages_thread ON care_messages(patient_id, clinician_id, id);
CREATE INDEX idx_care_messages_unread ON care_messages(clinician_id, read_at) WHERE sender_role = 'patient';

CREATE TABLE visits (                       -- DB-61
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  starts_at TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('in_person','remote')),
  place TEXT,
  prepare_enc TEXT,                          -- [ЧПД] «что подготовить» до 500
  previsit_enabled INTEGER NOT NULL DEFAULT 1 CHECK (previsit_enabled IN (0,1)),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','done','no_show','cancelled')),
  visible_from TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT, updated_by INTEGER REFERENCES users(id)
) STRICT;
CREATE INDEX idx_visits_patient ON visits(patient_id, starts_at);
CREATE INDEX idx_visits_clinician ON visits(clinician_id, starts_at);

CREATE TABLE previsit_forms (               -- DB-62
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  visit_id INTEGER UNIQUE REFERENCES visits(id), -- одна анкета на визит
  form_version INTEGER,                      -- версия S-49
  requested_by INTEGER NOT NULL REFERENCES users(id),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','skipped','cancelled')),
  answers_json TEXT,                         -- [ЧПД]
  reminded_at TEXT,
  submitted_at TEXT
);
CREATE INDEX idx_previsit_patient ON previsit_forms(patient_id, status);

-- =====================================================================
-- 16. Документы специалиста, заключения психолога, заметки
-- =====================================================================
CREATE TABLE patient_documents (            -- DB-80
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  doc_type TEXT NOT NULL,                    -- из списка UC-20 (S-54)
  period_from TEXT, period_to TEXT,
  template_version_id INTEGER REFERENCES content_versions(id),
  current_version INTEGER NOT NULL DEFAULT 1,
  hidden_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;
CREATE INDEX idx_pdocs_patient ON patient_documents(patient_id, author_id);
CREATE TABLE patient_document_versions (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES patient_documents(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready')),
  sections_enc TEXT NOT NULL,                -- [ЧПД] разделы; ИИ-текст — с ключами #ТИП-N#
  sources_json TEXT NOT NULL DEFAULT '[]',   -- ссылки на исходные записи (тип, ID, версия)
  ai_sections_json TEXT NOT NULL DEFAULT '[]', -- какие разделы подготовлены ИИ (L-26)
  reason TEXT,
  author_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (document_id, version)
) STRICT;
CREATE TRIGGER pdoc_ready_immutable BEFORE UPDATE ON patient_document_versions WHEN OLD.status = 'ready'
BEGIN SELECT RAISE(ABORT,'ready document version is immutable'); END;

CREATE TABLE conclusions (                  -- DB-81
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT,
  released_to_patient INTEGER NOT NULL DEFAULT 0,
  released_version INTEGER,
  released_visible_from TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX idx_conclusions_patient ON conclusions(patient_id);
CREATE TABLE conclusion_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conclusion_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed')),
  title TEXT, sections_json TEXT NOT NULL DEFAULT '{}', protocol_refs_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT, created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT,
  signed_by INTEGER, signed_name TEXT, signed_at TEXT, sign_method TEXT, checksum TEXT,
  UNIQUE (conclusion_id, version)
);
CREATE TRIGGER conclusion_versions_signed_immutable BEFORE UPDATE ON conclusion_versions WHEN OLD.status = 'signed'
BEGIN SELECT RAISE(ABORT, 'signed conclusion version is immutable'); END;

CREATE TABLE clinician_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT, tags TEXT, note_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
);
CREATE INDEX idx_clinician_notes_patient ON clinician_notes(patient_id, author_id);

CREATE TABLE tool_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
);
CREATE INDEX idx_tool_templates_owner ON tool_templates(owner_id);
CREATE TABLE tool_import_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL, encoding TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE tool_import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  rows_total INTEGER NOT NULL DEFAULT 0, rows_ok INTEGER NOT NULL DEFAULT 0, rows_skipped INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), rolled_back_at TEXT
);
CREATE TABLE tool_import_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES tool_import_batches(id),
  kind TEXT NOT NULL CHECK (kind IN ('offline','protocol')),
  result_id INTEGER NOT NULL, waiting_assignment_id INTEGER
);
CREATE INDEX idx_tool_import_items_batch ON tool_import_items(batch_id);
CREATE TABLE tool_repeat_snoozes (
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  until TEXT NOT NULL,
  PRIMARY KEY (clinician_id, patient_id)
);

-- =====================================================================
-- 17. Библиотека
-- =====================================================================
CREATE TABLE library_items (                -- DB-63, DB-124
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  media TEXT NOT NULL CHECK (media IN ('read','listen','watch')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','published','withdrawn')),
  current_version INTEGER,
  sponsor_caption TEXT,                      -- «при поддержке …» (L-20)
  tags_json TEXT NOT NULL DEFAULT '[]',
  hidden_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT
) STRICT;
CREATE INDEX idx_library_status ON library_items(status, media);
CREATE TABLE library_versions (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES library_items(id),
  version INTEGER NOT NULL,
  title TEXT NOT NULL, summary TEXT, body_md TEXT,
  author TEXT NOT NULL, source TEXT NOT NULL, review_date TEXT NOT NULL,
  reviewed_by_text TEXT, reviewed_by INTEGER REFERENCES users(id),
  file_id INTEGER REFERENCES stored_files(id), duration_s INTEGER,
  is_stand_in INTEGER NOT NULL DEFAULT 0 CHECK (is_stand_in IN (0,1)),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (item_id, version)
) STRICT;
CREATE VIRTUAL TABLE library_fts USING fts5(title, summary, body, tokenize='unicode61 remove_diacritics 2', prefix='2 3');
-- library_fts.rowid = library_items.id; содержит ТОЛЬКО опубликованные версии (переиндексация при публикации/снятии)
CREATE TABLE library_positions (            -- DB-64; личное, в аналитику не идёт
  user_id INTEGER NOT NULL REFERENCES users(id),
  item_id INTEGER NOT NULL REFERENCES library_items(id),
  version INTEGER NOT NULL,
  position_s INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (user_id, item_id)
) STRICT, WITHOUT ROWID;

-- =====================================================================
-- 18. ИИ: модели, привязки, промпты, наборы, треды, псевдонимы
-- =====================================================================
CREATE TABLE ai_models (                    -- DB-114 (M-19)
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL UNIQUE,
  adapter TEXT NOT NULL CHECK (adapter IN ('local_stub','gigachat_api','openai_compat')),
  api_base TEXT,
  model_ident TEXT NOT NULL,                 -- 'GigaChat-2-Max'
  secret_name TEXT,                          -- имя секрета в хранилище/окружении; значение не здесь
  params_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(params_json)),
  location TEXT NOT NULL CHECK (location IN ('our_server','ru_external')),  -- «за рубежом» не сохраняется (L-11)
  data_class TEXT NOT NULL CHECK (data_class IN ('synthetic_only','local_ok')),
  supports_tools INTEGER NOT NULL DEFAULT 0 CHECK (supports_tools IN (0,1)),
  license_url TEXT NOT NULL,
  status_243fz TEXT NOT NULL CHECK (status_243fz IN ('sovereign','national','other','unknown')),
  price_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT, updated_by INTEGER REFERENCES users(id),
  CHECK (location = 'our_server' OR data_class = 'synthetic_only')
) STRICT;

CREATE TABLE ai_binding_versions (          -- DB-115, DB-36 (S-02…S-07, S-33)
  id INTEGER PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('patient_assistant','clinician_chat','document_draft','diagnostic_hints','ae_extraction','order_parse','admin_assistant')),
  version INTEGER NOT NULL,
  primary_model_id INTEGER NOT NULL REFERENCES ai_models(id),
  fallback_model_id INTEGER REFERENCES ai_models(id),
  status TEXT NOT NULL CHECK (status IN ('draft','pending_approval','active','previous','rejected')),
  eval_run_id INTEGER, comment TEXT,
  author_id INTEGER REFERENCES users(id), approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (purpose, version),
  CHECK (fallback_model_id IS NULL OR fallback_model_id <> primary_model_id)
) STRICT;
CREATE UNIQUE INDEX uq_binding_active ON ai_binding_versions(purpose) WHERE status = 'active';

CREATE TABLE prompt_versions (              -- DB-116 (S-08…S-13, S-34)
  id INTEGER PRIMARY KEY,
  prompt_key TEXT NOT NULL,                  -- 'patient_assistant', 'document_draft.discharge'
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','pending_approval','active','previous','rejected')),
  eval_run_id INTEGER,
  author_id INTEGER REFERENCES users(id),   -- NULL = загружено из prompts/<ключ>/v001.md
  comment TEXT,
  approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (prompt_key, version)
) STRICT;
CREATE UNIQUE INDEX uq_prompt_active ON prompt_versions(prompt_key) WHERE status = 'active';
CREATE TRIGGER prompt_body_immutable BEFORE UPDATE OF body, body_sha256 ON prompt_versions
BEGIN SELECT RAISE(ABORT,'prompt version text is immutable'); END;

CREATE TABLE ai_eval_sets (                 -- DB-117 (S-36): версия набора синтетических примеров
  id INTEGER PRIMARY KEY,
  purpose TEXT NOT NULL,
  version INTEGER NOT NULL,
  cases_json TEXT NOT NULL CHECK (json_valid(cases_json)),  -- только синтетика (отметка обязательна)
  synthetic_confirmed INTEGER NOT NULL CHECK (synthetic_confirmed = 1),
  status TEXT NOT NULL CHECK (status IN ('draft','pending_approval','active','previous')),
  author_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (purpose, version)
) STRICT;
CREATE TABLE ai_eval_runs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'ai' CHECK (kind IN ('ai','crisis_corpus','pii_corpus','scoring')),
  eval_set_id INTEGER REFERENCES ai_eval_sets(id),
  purpose TEXT, model_id INTEGER REFERENCES ai_models(id), prompt_version_id INTEGER REFERENCES prompt_versions(id),
  started_by INTEGER REFERENCES users(id),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  pass_rate REAL, forbidden_pass_rate REAL,
  failures_json TEXT,                        -- номера провалившихся примеров
  outputs_json TEXT,                         -- синтетические ответы; стираются через 90 дней
  outputs_expire_at TEXT
) STRICT;
CREATE INDEX idx_eval_runs ON ai_eval_runs(purpose, started_at DESC);
CREATE UNIQUE INDEX uq_eval_running ON ai_eval_runs(kind) WHERE status = 'running';  -- один прогон одновременно

CREATE TABLE ai_usage (                     -- DB-37, DB-118
  month TEXT NOT NULL,                       -- 'YYYY-MM'
  purpose TEXT NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 0,        -- 0 — итог по организации
  requests INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_kopecks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, purpose, user_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE pii_values (                   -- DB-93…DB-96 (F-80): ключ #ТИП-N# ↔ значение
  id INTEGER PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('patient','thread')),
  scope_id INTEGER NOT NULL,                 -- patient_id или ai_threads.id
  pii_type TEXT NOT NULL CHECK (pii_type IN ('PERSON','PHONE','EMAIL','ADDRESS','PASSPORT','SNILS','POLICY','INN','DOC','CARD','DATE_OF_BIRTH','ORG','NICK','URL')),
  n INTEGER NOT NULL CHECK (n >= 1),
  value_enc TEXT NOT NULL,                   -- [ПД/ЧПД] AEAD ключом PII_ENC_KEY (вне базы)
  value_hmac TEXT NOT NULL,                  -- HMAC-SHA256(PII_HMAC_KEY, scope|type|нормализованное значение)
  status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current','previous')),
  key_id TEXT NOT NULL,                      -- версия ключа шифрования (ротация)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (scope_type, scope_id, pii_type, value_hmac),
  UNIQUE (scope_type, scope_id, pii_type, n)
) STRICT;
CREATE TABLE pii_counters (                 -- N без пропусков внутри области (одна транзакция с вставкой)
  scope_type TEXT NOT NULL, scope_id INTEGER NOT NULL, pii_type TEXT NOT NULL,
  last_n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_type, scope_id, pii_type)
) STRICT, WITHOUT ROWID;
CREATE TABLE pii_stats_weekly (             -- DB-126: только числа
  week TEXT NOT NULL, pii_type TEXT NOT NULL, purpose TEXT NOT NULL,
  replacements INTEGER NOT NULL DEFAULT 0, rules_only_calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (week, pii_type, purpose)
) STRICT, WITHOUT ROWID;

CREATE TABLE ai_threads (                   -- DB-38, DB-39, DB-40
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'patient_assistant',
  patient_id INTEGER REFERENCES users(id),   -- у специалиста — выбранный пациент; у пациента — он сам
  title TEXT NOT NULL DEFAULT 'Новый диалог',-- [ЧПД] с ключами F-80
  title_auto INTEGER NOT NULL DEFAULT 1,
  legacy_session_id INTEGER UNIQUE,
  hidden_at TEXT,
  last_message_at TEXT,
  expires_at TEXT,                           -- last_message_at + 30 дн. (S-23)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ai_threads_owner ON ai_threads(owner_user_id, updated_at);
CREATE INDEX idx_ai_threads_exp ON ai_threads(expires_at);
CREATE INDEX idx_ai_threads_patient ON ai_threads(patient_id);

CREATE TABLE ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES ai_threads(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  text TEXT NOT NULL,                        -- [ЧПД] только текст с ключами #ТИП-N#
  kind TEXT NOT NULL DEFAULT 'normal',       -- normal | crisis | error | filtered
  ai_generated INTEGER NOT NULL DEFAULT 0 CHECK (ai_generated IN (0,1)),
  model_id INTEGER, binding_version INTEGER, prompt_version INTEGER,
  intent TEXT, flags_json TEXT,
  legacy_message_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ai_messages_thread ON ai_messages(thread_id, id);
CREATE TRIGGER ai_generated_fixed BEFORE UPDATE OF ai_generated ON ai_messages
BEGIN SELECT RAISE(ABORT,'ai_generated is immutable'); END;

CREATE TABLE ai_message_chips (             -- DB-42: ссылки без содержимого
  message_id INTEGER NOT NULL REFERENCES ai_messages(id),
  object_type TEXT NOT NULL, object_id INTEGER NOT NULL, object_version INTEGER,
  PRIMARY KEY (message_id, object_type, object_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE ai_ratings (                   -- DB-43
  message_id INTEGER NOT NULL,               -- без FK: оценка переживает стирание треда (текста в ней нет)
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL, purpose TEXT NOT NULL,
  model_id INTEGER, prompt_version INTEGER,
  rating TEXT NOT NULL CHECK (rating IN ('useful','not_useful')),
  reason TEXT CHECK (reason IN ('wrong','unclear','off_topic','other')),
  week TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (message_id, user_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_ai_ratings_week ON ai_ratings(week, purpose);

CREATE TABLE hint_drafts (                  -- DB-44: гипотезы, не в карточке пациента
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  clinician_id INTEGER NOT NULL REFERENCES users(id),
  thread_id INTEGER REFERENCES ai_threads(id),
  hypotheses_enc TEXT NOT NULL,              -- [ЧПД] с ключами F-80
  marks_json TEXT NOT NULL DEFAULT '{}',     -- принято/правлено/отклонено по гипотезам
  expires_at TEXT NOT NULL,                  -- как ИИ-материалы: 30 дн.
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT
) STRICT;
CREATE INDEX idx_hints_patient ON hint_drafts(patient_id, clinician_id);
CREATE INDEX idx_hints_exp ON hint_drafts(expires_at);

-- =====================================================================
-- 19. Продуктовые события
-- =====================================================================
CREATE TABLE product_events (               -- DB-88; без текста и ID пациента
  id INTEGER PRIMARY KEY,
  event TEXT NOT NULL, role TEXT NOT NULL, app_version TEXT,
  session_pseudo TEXT,                       -- псевдоним сессии на неделю
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;
CREATE INDEX idx_pe_time ON product_events(created_at);
CREATE TABLE product_events_weekly (
  week TEXT NOT NULL, event TEXT NOT NULL, role TEXT NOT NULL,
  count INTEGER NOT NULL, uniq_sessions INTEGER NOT NULL,
  PRIMARY KEY (week, event, role)
) STRICT, WITHOUT ROWID;
