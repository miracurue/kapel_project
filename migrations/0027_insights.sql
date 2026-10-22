-- Аналитика для заказчика и специалиста (диагноз → кто ведёт → что назначают → что происходит → что получается).
-- Здесь только недостающие данные и представления без идентификаторов; метрики считает src/modules/insights.
-- Всё необязательно: сервис автономен от МИС, ни врач, ни пациент не обязаны ничего заполнять.
--
-- patient_diagnoses     — основной диагноз пациента, который врач может указать сам (МКБ-10, из справочника).
-- organizations         — место работы специалиста (поликлиника, больница, частный центр) и регион.
-- clinician_profiles    — специальность, место работы и согласие на агрегированное использование профиля.
-- clinician_interests   — журналы и конференции, которые специалист сам называет.
-- insights_*            — представления: только случайные коды субъектов (analytics_subjects), без patient_id и имён.
--                         Читаются отдельным соединением «только чтение». Пациент попадает в них только при действующем
--                         базовом согласии; кого именно считать (программа или свои пациенты) решает запрос по members.

CREATE TABLE diagnosis_catalog (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  grp TEXT NOT NULL,
  sort INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
-- Справочник предварительный (review-required): список и формулировки утверждает клинический владелец.
INSERT INTO diagnosis_catalog(code,label,grp,sort) VALUES
 ('F41.2','Смешанное тревожное и депрессивное расстройство','anxiety_depressive',1),
 ('F41.1','Генерализованное тревожное расстройство','anxiety',2),
 ('F41.0','Паническое расстройство','anxiety',3),
 ('F32','Депрессивный эпизод','depressive',4),
 ('F33','Рекуррентное депрессивное расстройство','depressive',5),
 ('F34.1','Дистимия','depressive',6),
 ('F43.2','Расстройство адаптации','stress',7),
 ('F40','Фобические тревожные расстройства','anxiety',8);

CREATE TABLE patient_diagnoses (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  code TEXT NOT NULL REFERENCES diagnosis_catalog(code),
  set_by INTEGER NOT NULL REFERENCES users(id),
  set_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  ended_at TEXT
) STRICT;
CREATE UNIQUE INDEX uq_patient_dx_current ON patient_diagnoses(patient_id) WHERE ended_at IS NULL;
CREATE INDEX idx_patient_dx_code ON patient_diagnoses(code) WHERE ended_at IS NULL;

CREATE TABLE organizations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('polyclinic','hospital','private','dispensary','other')),
  region TEXT NOT NULL,
  city TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (name_norm, region)
) STRICT;

CREATE TABLE clinician_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  specialty TEXT CHECK (specialty IN ('psychiatrist','psychotherapist','clinical_psychologist','neurologist','somatic','other')),
  organization_id INTEGER REFERENCES organizations(id),
  analytics_consent INTEGER NOT NULL DEFAULT 0 CHECK (analytics_consent IN (0,1)),
  consent_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE clinician_interests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('journal','conference')),
  title TEXT NOT NULL,
  title_norm TEXT NOT NULL,
  year INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (user_id, kind, title_norm)
) STRICT;

-- Участники: любой пациент с базовым согласием в программе или текущем закреплении (готовое представление 0025).
CREATE VIEW insights_members AS
SELECT subject_code, clinician_id, scope FROM analytics_reporting_members WHERE scope IN ('current','program');

-- Пациенты: диагноз и первый день наблюдения.
CREATE VIEW insights_patients AS
SELECT s.subject_code,
 (SELECT d.code FROM patient_diagnoses d WHERE d.patient_id=s.patient_id AND d.ended_at IS NULL) AS dx_code,
 (SELECT MIN(substr(a.started_at,1,10)) FROM care_assignments a WHERE a.patient_id=s.patient_id AND COALESCE(a.end_reason,'')<>'signal_only') AS enrolled_day
FROM analytics_subjects s JOIN users u ON u.id=s.patient_id
WHERE u.role='patient' AND u.status<>'tombstone'
AND EXISTS(SELECT 1 FROM consent_current c WHERE c.user_id=s.patient_id AND c.consent_kind='base' AND c.action='given');

-- Специалисты пациента: код специалиста, специальность (по роли, если профиль не заполнен), место работы — только при согласии специалиста.
CREATE VIEW insights_patient_clinicians AS
SELECT ps.subject_code AS subject_code, cs.subject_code AS clinician_code, u.role AS role,
 COALESCE(p.specialty, CASE u.role WHEN 'psychiatrist' THEN 'psychiatrist' ELSE 'clinical_psychologist' END) AS specialty,
 CASE WHEN COALESCE(p.analytics_consent,0)=1 THEN o.id END AS org_id,
 CASE WHEN COALESCE(p.analytics_consent,0)=1 THEN o.name END AS org_name,
 CASE WHEN COALESCE(p.analytics_consent,0)=1 THEN o.kind END AS org_kind,
 CASE WHEN COALESCE(p.analytics_consent,0)=1 THEN o.region END AS region,
 COALESCE(p.analytics_consent,0) AS profile_consent
FROM care_assignments a
JOIN analytics_subjects ps ON ps.patient_id=a.patient_id
JOIN analytics_subjects cs ON cs.patient_id=a.clinician_id
JOIN users u ON u.id=a.clinician_id AND u.status<>'tombstone'
LEFT JOIN clinician_profiles p ON p.user_id=a.clinician_id
LEFT JOIN organizations o ON o.id=p.organization_id
WHERE a.ended_at IS NULL AND COALESCE(a.end_reason,'')<>'signal_only';

-- Журналы и конференции — только специалистов, давших согласие.
CREATE VIEW insights_clinician_interests AS
SELECT cs.subject_code AS clinician_code, i.kind, i.title, i.title_norm, i.year
FROM clinician_interests i JOIN clinician_profiles p ON p.user_id=i.user_id AND p.analytics_consent=1
JOIN analytics_subjects cs ON cs.patient_id=i.user_id JOIN users u ON u.id=i.user_id AND u.status<>'tombstone';

-- Опубликованный план: МНН, срок и число приёмов в день. Срок = конец минус начало; без даты окончания срок не указан.
CREATE VIEW insights_plan_items AS
SELECT s.subject_code, pi.item_key, i.id AS inn_id, i.name AS inn_name, i.drug_group,
 pi.start_date, pi.end_date, pi.status,
 CASE WHEN pi.end_date IS NOT NULL AND pi.start_date IS NOT NULL THEN CAST(julianday(pi.end_date)-julianday(pi.start_date) AS INTEGER) END AS duration_days,
 MAX(1, json_array_length(pi.times_json)) AS slots_per_day
FROM plan_items pi JOIN plan_versions pv ON pv.id=pi.plan_version_id AND pv.status='published'
JOIN inn i ON i.id=pi.inn_id JOIN analytics_subjects s ON s.patient_id=pv.patient_id;

-- «Купил(а) препарат»: сама отметка пациента, без цены и аптеки.
CREATE VIEW insights_purchases AS
SELECT s.subject_code, pm.item_key, i.id AS inn_id, i.name AS inn_name, substr(pm.created_at,1,10) AS day
FROM purchase_marks pm JOIN drug_products dp ON dp.id=pm.product_id JOIN inn i ON i.id=dp.inn_id
JOIN analytics_subjects s ON s.patient_id=pm.patient_id WHERE pm.status IN ('current','previous');

-- Отметки приёма по пунктам плана; только если пациент делится журналом приёма.
CREATE VIEW insights_med_marks AS
SELECT s.subject_code, l.item_key, l.day, l.slot, l.status
FROM med_log l JOIN analytics_subjects s ON s.patient_id=l.patient_id LEFT JOIN user_prefs p ON p.user_id=l.patient_id
WHERE l.hidden_at IS NULL AND l.item_key IS NOT NULL AND COALESCE(p.share_med_log,1)=1;

-- Сообщения о побочных эффектах: отправленные, не отменённые; по одной строке на отмеченную жалобу.
CREATE VIEW insights_adverse AS
SELECT s.subject_code, ae.id AS report_ref, substr(COALESCE(ae.onset_date,ae.created_at),1,10) AS day,
 j.value AS complaint, ae.severity, ae.inn_id, i.name AS inn_name,
 ae.psychiatrist_id AS clinician_id, ae.visible_from
FROM adverse_events ae JOIN analytics_subjects s ON s.patient_id=ae.patient_id
LEFT JOIN inn i ON i.id=ae.inn_id
LEFT JOIN json_each(CASE WHEN json_valid(ae.complaint_codes_json) THEN ae.complaint_codes_json ELSE '[]' END) j
WHERE ae.status NOT IN ('draft','cancelled');

-- Результаты тестов (то же правило видимости, что и в analytics_shared_events).
CREATE VIEW insights_tests AS
SELECT s.subject_code, e.day, json_extract(e.dimension,'$.instrument') AS instrument,
 json_extract(e.dimension,'$.version') AS version, json_extract(e.dimension,'$.mode') AS mode, e.value AS score
FROM analytics_shared_events e JOIN analytics_subjects s ON s.patient_id=e.patient_id
WHERE e.metric='test_score' AND e.value IS NOT NULL;

CREATE VIEW insights_mood AS
SELECT s.subject_code, e.day, e.value AS mood
FROM analytics_shared_events e JOIN analytics_subjects s ON s.patient_id=e.patient_id
WHERE e.metric='mood' AND e.value IS NOT NULL;
