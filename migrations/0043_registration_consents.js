'use strict';

// Регистрация без обязательного кода, согласия одной формой, заявки специалистов (docs/AUDIT_CONSENT_ACCESS_2026-10-27.md,
// разделы H4–H7).
//
// 1. Журнал согласий принимает два новых вида: 'agreement' (пользовательское соглашение и политика) и 'staff_pd'
//    (согласие специалиста на обработку его персональных данных). SQLite не меняет CHECK на месте, поэтому таблица
//    пересоздаётся (как в 0036): строки и их id сохраняются, индексы и триггеры «только дописывание» переносятся,
//    представление consent_current создаётся заново. Триггер аналитики (0019) теперь срабатывает только для пациентов:
//    у специалистов нет кода субъекта аналитики.
// 2. staff_applications — заявки специалистов в состоянии «ожидает подтверждения». Строки в users до решения
//    администратора нет, поэтому у заявителя нет ни сессии, ни доступа к данным. Согласия заявитель даёт при подаче:
//    версия и хэш текста хранятся здесь, а в журнал согласий уходят при подтверждении с исходным временем подачи.

function up(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='consent_events'").get();
  const from = "CHECK (consent_kind IN ('base','ai','research','program'))";
  const to = "CHECK (consent_kind IN ('base','ai','research','program','agreement','staff_pd'))";
  if (!row || !row.sql.includes(from)) throw new Error('consent_events: ожидаемое определение таблицы не найдено');
  const extras = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE tbl_name='consent_events' AND type IN ('index','trigger') AND sql IS NOT NULL",
    )
    .all()
    .filter((e) => !/analytics_subject_on_consent/.test(e.sql));
  db.exec('DROP TRIGGER IF EXISTS analytics_subject_on_consent');
  db.exec(row.sql.replace(from, to).replace(/CREATE TABLE "?consent_events"?/, 'CREATE TABLE consent_events_new'));
  db.exec('INSERT INTO consent_events_new SELECT * FROM consent_events');
  db.exec('DROP VIEW consent_current');
  db.exec('DROP TABLE consent_events');
  db.exec('PRAGMA legacy_alter_table = ON');
  db.exec('ALTER TABLE consent_events_new RENAME TO consent_events');
  db.exec('PRAGMA legacy_alter_table = OFF');
  for (const e of extras) db.exec(e.sql);
  db.exec(`CREATE VIEW consent_current AS               -- последнее событие по каждому виду решает
SELECT e.* FROM consent_events e
WHERE e.id = (SELECT MAX(id) FROM consent_events x WHERE x.user_id = e.user_id AND x.consent_kind = e.consent_kind)`);
  db.exec(`CREATE TRIGGER analytics_subject_on_consent AFTER INSERT ON consent_events
WHEN EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.role = 'patient') BEGIN
  INSERT OR IGNORE INTO analytics_subjects(patient_id, subject_code, created_at)
    VALUES (NEW.user_id, lower(hex(randomblob(12))), strftime('%Y-%m-%dT%H:%M:%SZ','now'));
END`);

  db.exec(`CREATE TABLE staff_applications (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  email_hmac TEXT NOT NULL,
  password_hash TEXT NOT NULL,                -- bcrypt; пароль, который заявитель задал при подаче
  full_name TEXT NOT NULL,
  role_requested TEXT NOT NULL CHECK (role_requested IN ('psychiatrist','psychologist')),
  specialty TEXT CHECK (specialty IN ('psychiatrist','psychotherapist','clinical_psychologist','neurologist','somatic','other')),
  workplace TEXT,
  qualification TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  approved_role TEXT CHECK (approved_role IN ('psychiatrist','psychologist')),
  reject_reason TEXT,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  user_id INTEGER REFERENCES users(id),       -- заполняется при подтверждении
  agreement_version_id INTEGER NOT NULL REFERENCES content_versions(id),
  agreement_sha256 TEXT NOT NULL,
  pd_version_id INTEGER NOT NULL REFERENCES content_versions(id),
  pd_sha256 TEXT NOT NULL,
  ip_hmac TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT`);
  db.exec(
    "CREATE UNIQUE INDEX uq_staff_app_open_email ON staff_applications(email) WHERE status IN ('pending','approved')",
  );
  db.exec('CREATE INDEX idx_staff_app_status ON staff_applications(status, created_at DESC)');
}

up.foreignKeysOff = true;
module.exports = up;
