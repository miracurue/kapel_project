'use strict';

// Схема, которую раньше создавал при каждом старте src/db.js (первая версия приложения), а не миграции:
// 12 таблиц, 3 индекса и 9 колонок. Базы, поднятые до этой миграции, их уже имеют, поэтому всё — «если нет».
// После неё src/db.js схему не трогает: база целиком описана миграциями.
const TABLES = `
CREATE TABLE IF NOT EXISTS chatbot_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chatbot_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES chatbot_sessions(id),
  sender TEXT NOT NULL CHECK (sender IN ('user','bot')),
  text TEXT NOT NULL,
  intent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS export_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_by INTEGER REFERENCES users(id),
  run_at TEXT NOT NULL DEFAULT (datetime('now')),
  consent_filter TEXT NOT NULL,
  row_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  intro_seen_at TEXT
);

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

CREATE TABLE IF NOT EXISTS admin_action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  target_user_id INTEGER,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS treatment_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

CREATE TABLE IF NOT EXISTS care_clinician_settings (
  clinician_id INTEGER PRIMARY KEY REFERENCES users(id),
  reply_note TEXT,
  away_until TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_attach_thread ON ai_attachments(thread_id, seq);

CREATE INDEX IF NOT EXISTS idx_ai_attach_exp ON ai_attachments(expires_at);

CREATE INDEX IF NOT EXISTS idx_admin_action_log_created ON admin_action_log(created_at);
`;

const COLUMNS = [
  ['users', 'deactivated_at', 'TEXT'],
  ['user_prefs', 'share_med_own', 'INTEGER NOT NULL DEFAULT 0'],
  ['care_assignments', 'archived_at', 'TEXT'],
  ['crisis_escalations', 'unresolved', 'INTEGER NOT NULL DEFAULT 0'],
  ['crisis_escalations', 'stub_notified_at', 'TEXT'],
  ['crisis_escalations', 'ack_outcome', 'TEXT'],
  ['mood_entries', 'sleep_hours', 'REAL'],
  ['mood_entries', 'triggers', 'TEXT'],
  ['mood_entries', 'shared_once', 'INTEGER NOT NULL DEFAULT 0'],
];

module.exports = function migrate(db) {
  db.exec(TABLES);
  for (const [table, column, definition] of COLUMNS) {
    const exists = db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name=?').get(table, column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};
