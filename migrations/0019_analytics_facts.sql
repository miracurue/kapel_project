-- Аналитика: общее место для фактов. Источники (сейчас дневник; позже тесты, приём, НЯ) пишут сюда
-- обезличенные числа по дням; пациент, специалист, администратор и программа поддержки читают одно и то же
-- и каждый получает своё толкование (src/modules/analytics/). Свободного текста в фактах нет: от заметки
-- хранится только отметка «заметка есть».
--
-- analytics_facts       — факты по пациенту и дню (контур с идентификатором, читают пациент и закреплённый специалист).
-- analytics_subjects    — случайный код субъекта вместо patient_id: общий для всех представлений когорты.
-- analytics_cohort_facts / analytics_program_facts — представления БЕЗ идентификаторов пациента.
--   Когорта специалиста: действующие закрепления. Программа поддержки: только те, у кого действует согласие 'program'
--   (отзыв согласия исключает пациента при следующем запросе). Код читает когорты только через них, соединением «только чтение».
-- Факты по дневнику ведут триггеры на mood_entries: так их обновляют и API, и восстановление после «Отменить»,
-- и правка по запросу пациента, и стирание.

CREATE TABLE analytics_facts (
  patient_id INTEGER NOT NULL REFERENCES users(id),
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  source TEXT NOT NULL,
  source_id INTEGER,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (patient_id, day, metric)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_analytics_facts_day ON analytics_facts(day, metric);

CREATE TABLE analytics_subjects (
  patient_id INTEGER PRIMARY KEY REFERENCES users(id),
  subject_code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

-- Последняя непрятанная запись за день, развёрнутая в строки «метрика — значение».
CREATE VIEW analytics_diary_facts AS
WITH latest AS (
  SELECT m.* FROM mood_entries m
  WHERE m.hidden_at IS NULL
    AND m.id = (SELECT MAX(x.id) FROM mood_entries x WHERE x.patient_id = m.patient_id AND x.entry_date = m.entry_date AND x.hidden_at IS NULL)
)
SELECT patient_id, entry_date AS day, 'diary_entry' AS metric, 1.0 AS value, id AS source_id FROM latest
UNION ALL SELECT patient_id, entry_date, 'mood', CAST(mood AS REAL), id FROM latest WHERE mood IS NOT NULL
UNION ALL SELECT patient_id, entry_date, 'sleep_score', CASE sleep WHEN 'bad' THEN 0.0 WHEN 'ok' THEN 1.0 ELSE 2.0 END, id FROM latest WHERE sleep IN ('bad','ok','good')
UNION ALL SELECT patient_id, entry_date, 'anxiety_score', CASE anxiety WHEN 'none' THEN 0.0 WHEN 'some' THEN 1.0 ELSE 2.0 END, id FROM latest WHERE anxiety IN ('none','some','strong')
UNION ALL SELECT patient_id, entry_date, 'note_present', 1.0, id FROM latest WHERE note IS NOT NULL AND note <> '';

CREATE TRIGGER analytics_diary_ai AFTER INSERT ON mood_entries BEGIN
  DELETE FROM analytics_facts WHERE patient_id = NEW.patient_id AND day = NEW.entry_date AND source = 'diary';
  INSERT INTO analytics_facts(patient_id, day, metric, value, source, source_id, computed_at)
    SELECT patient_id, day, metric, value, 'diary', source_id, strftime('%Y-%m-%dT%H:%M:%SZ','now')
    FROM analytics_diary_facts WHERE patient_id = NEW.patient_id AND day = NEW.entry_date;
  INSERT OR IGNORE INTO analytics_subjects(patient_id, subject_code, created_at)
    VALUES (NEW.patient_id, lower(hex(randomblob(12))), strftime('%Y-%m-%dT%H:%M:%SZ','now'));
END;

CREATE TRIGGER analytics_diary_au AFTER UPDATE ON mood_entries BEGIN
  DELETE FROM analytics_facts WHERE source = 'diary' AND ((patient_id = OLD.patient_id AND day = OLD.entry_date) OR (patient_id = NEW.patient_id AND day = NEW.entry_date));
  INSERT INTO analytics_facts(patient_id, day, metric, value, source, source_id, computed_at)
    SELECT patient_id, day, metric, value, 'diary', source_id, strftime('%Y-%m-%dT%H:%M:%SZ','now')
    FROM analytics_diary_facts WHERE (patient_id = OLD.patient_id AND day = OLD.entry_date) OR (patient_id = NEW.patient_id AND day = NEW.entry_date);
  INSERT OR IGNORE INTO analytics_subjects(patient_id, subject_code, created_at)
    VALUES (NEW.patient_id, lower(hex(randomblob(12))), strftime('%Y-%m-%dT%H:%M:%SZ','now'));
END;

CREATE TRIGGER analytics_diary_ad AFTER DELETE ON mood_entries BEGIN
  DELETE FROM analytics_facts WHERE patient_id = OLD.patient_id AND day = OLD.entry_date AND source = 'diary';
  INSERT INTO analytics_facts(patient_id, day, metric, value, source, source_id, computed_at)
    SELECT patient_id, day, metric, value, 'diary', source_id, strftime('%Y-%m-%dT%H:%M:%SZ','now')
    FROM analytics_diary_facts WHERE patient_id = OLD.patient_id AND day = OLD.entry_date;
END;

-- Код субъекта нужен и тем, у кого ещё нет записей: он стоит в знаменателе «из скольких».
CREATE TRIGGER analytics_subject_on_assignment AFTER INSERT ON care_assignments BEGIN
  INSERT OR IGNORE INTO analytics_subjects(patient_id, subject_code, created_at)
    VALUES (NEW.patient_id, lower(hex(randomblob(12))), strftime('%Y-%m-%dT%H:%M:%SZ','now'));
END;
CREATE TRIGGER analytics_subject_on_consent AFTER INSERT ON consent_events BEGIN
  INSERT OR IGNORE INTO analytics_subjects(patient_id, subject_code, created_at)
    VALUES (NEW.user_id, lower(hex(randomblob(12))), strftime('%Y-%m-%dT%H:%M:%SZ','now'));
END;

-- Перенос того, что уже есть: дневник, закрепления, согласия.
INSERT OR IGNORE INTO analytics_subjects(patient_id, subject_code, created_at)
  SELECT DISTINCT patient_id, lower(hex(randomblob(12))), strftime('%Y-%m-%dT%H:%M:%SZ','now') FROM mood_entries;
INSERT OR IGNORE INTO analytics_subjects(patient_id, subject_code, created_at)
  SELECT DISTINCT patient_id, lower(hex(randomblob(12))), strftime('%Y-%m-%dT%H:%M:%SZ','now') FROM care_assignments;
INSERT OR IGNORE INTO analytics_subjects(patient_id, subject_code, created_at)
  SELECT DISTINCT e.user_id, lower(hex(randomblob(12))), strftime('%Y-%m-%dT%H:%M:%SZ','now') FROM consent_events e JOIN users u ON u.id = e.user_id WHERE u.role = 'patient';
INSERT INTO analytics_facts(patient_id, day, metric, value, source, source_id, computed_at)
  SELECT patient_id, day, metric, value, 'diary', source_id, strftime('%Y-%m-%dT%H:%M:%SZ','now') FROM analytics_diary_facts;

-- Когорта специалиста: без patient_id; clinician_id — только чтобы отобрать «своих».
CREATE VIEW analytics_cohort_facts AS
SELECT s.subject_code, a.clinician_id, f.day, date(f.day, 'weekday 0', '-6 days') AS week, f.metric, f.value, f.source, f.computed_at
FROM analytics_facts f
JOIN analytics_subjects s ON s.patient_id = f.patient_id
JOIN care_assignments a ON a.patient_id = f.patient_id AND a.ended_at IS NULL AND (a.end_reason IS NULL OR a.end_reason <> 'signal_only');

-- Программа поддержки и общие цифры администратора: только согласившиеся, без идентификаторов и без специалиста.
CREATE VIEW analytics_program_facts AS
SELECT s.subject_code, f.day, date(f.day, 'weekday 0', '-6 days') AS week, f.metric, f.value, f.source, f.computed_at
FROM analytics_facts f
JOIN analytics_subjects s ON s.patient_id = f.patient_id
JOIN consent_current c ON c.user_id = f.patient_id AND c.consent_kind = 'program' AND c.action = 'given';

-- Знаменатели: кто входит в когорту, даже если записей ещё нет.
CREATE VIEW analytics_cohort_members AS
SELECT DISTINCT s.subject_code, a.clinician_id
FROM analytics_subjects s
JOIN care_assignments a ON a.patient_id = s.patient_id AND a.ended_at IS NULL AND (a.end_reason IS NULL OR a.end_reason <> 'signal_only');

CREATE VIEW analytics_program_members AS
SELECT s.subject_code
FROM analytics_subjects s
JOIN consent_current c ON c.user_id = s.patient_id AND c.consent_kind = 'program' AND c.action = 'given';
