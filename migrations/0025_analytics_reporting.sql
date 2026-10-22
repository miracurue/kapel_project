-- Repeatable event facts are views over authoritative sources, never patient/day upserts.
CREATE VIEW analytics_source_events AS
WITH latest AS (SELECT m.* FROM mood_entries m WHERE m.hidden_at IS NULL AND m.id=(SELECT MAX(x.id) FROM mood_entries x WHERE x.patient_id=m.patient_id AND x.entry_date=m.entry_date AND x.hidden_at IS NULL))
SELECT patient_id, entry_date AS day, 'mood_entries' AS source, CAST(id AS TEXT) AS source_id,
 'mood' AS metric, '' AS dimension, CAST(mood AS REAL) AS value, 'score_1_5' AS unit,
 created_at AS recorded_at, 1 AS clinician_visible
FROM latest WHERE hidden_at IS NULL AND mood IS NOT NULL
UNION ALL SELECT patient_id,entry_date,'mood_entries',CAST(id AS TEXT),'sleep_score','',CASE sleep WHEN 'bad' THEN 0.0 WHEN 'ok' THEN 1.0 ELSE 2.0 END,'score_0_2',created_at,1 FROM latest WHERE hidden_at IS NULL AND sleep IN ('bad','ok','good')
UNION ALL SELECT patient_id,entry_date,'mood_entries',CAST(id AS TEXT),'anxiety_score','',CASE anxiety WHEN 'none' THEN 0.0 WHEN 'some' THEN 1.0 ELSE 2.0 END,'score_0_2',created_at,1 FROM latest WHERE hidden_at IS NULL AND anxiety IN ('none','some','strong')
UNION ALL SELECT patient_id,entry_date,'mood_entries',CAST(id AS TEXT),'sleep_hours','',legacy_sleep_hours,'hour',created_at,1 FROM latest WHERE hidden_at IS NULL AND legacy_sleep_hours IS NOT NULL
UNION ALL SELECT patient_id,entry_date,'mood_entries',CAST(id AS TEXT),'note_present','',1.0,'note',created_at,1 FROM mood_entries WHERE hidden_at IS NULL AND note IS NOT NULL AND note<>''
UNION ALL SELECT patient_id,day,'diary_day_notes',note_id,'note_present','',1.0,'note',created_at,CASE WHEN shared=1 THEN 1 ELSE 0 END FROM diary_day_notes n WHERE text<>'' AND NOT EXISTS(SELECT 1 FROM mood_entries m WHERE m.patient_id=n.patient_id AND n.note_id='legacy-'||m.id AND m.hidden_at IS NULL AND m.note IS NOT NULL AND m.note<>'')
UNION ALL SELECT patient_id,substr(created_at,1,10),'online_results',CAST(id AS TEXT),'test_score',json_object('instrument',instrument,'version',instrument_version,'mode','online'),CAST(total_score AS REAL),'score',created_at,CASE WHEN self_initiated=0 OR shared_at IS NOT NULL THEN 1 ELSE 0 END FROM online_results WHERE invalid_at IS NULL
UNION ALL SELECT patient_id,test_date,'offline_results',CAST(id AS TEXT),'test_score',json_object('instrument',instrument,'version',NULL,'mode','offline'),CAST(total_score AS REAL),'score',created_at,1 FROM offline_results WHERE invalid_at IS NULL AND status='saved'
UNION ALL SELECT patient_id,day,'med_log',CAST(id AS TEXT),'medication_status',status,CASE status WHEN 'taken' THEN 1.0 ELSE 0.0 END,'mark',logged_at,1 FROM med_log WHERE hidden_at IS NULL
UNION ALL SELECT patient_id,COALESCE(onset_date,substr(created_at,1,10)),'adverse_events',CAST(id AS TEXT),'adverse_event',COALESCE(severity,'unknown'),1.0,'report',created_at,1 FROM adverse_events WHERE status NOT IN ('draft','cancelled')
UNION ALL SELECT patient_id,substr(starts_at,1,10),'visits',CAST(id AS TEXT),'visit',status,1.0,'visit',created_at,1 FROM visits WHERE status NOT IN ('draft','cancelled')
UNION ALL SELECT v.patient_id,v.day,'diary_habit_values',CAST(v.id AS TEXT),'habit_value',json_object('habit_id',v.habit_id,'version',v.version,'type',json_extract(d.definition_json,'$.type')),CASE WHEN json_type(v.value_json) IN ('integer','real','true','false') THEN CAST(json_extract(v.value_json,'$') AS REAL) ELSE NULL END,COALESCE(json_extract(d.definition_json,'$.unit'),''),v.recorded_at,CASE WHEN json_extract(d.definition_json,'$.shared')=1 AND json_extract(current.definition_json,'$.shared')=1 THEN 1 ELSE 0 END
FROM diary_habit_values v JOIN diary_habit_versions d ON d.patient_id=v.patient_id AND d.habit_id=v.habit_id AND d.version=v.version JOIN diary_habits h ON h.patient_id=v.patient_id AND h.habit_id=v.habit_id JOIN diary_habit_versions current ON current.patient_id=h.patient_id AND current.habit_id=h.habit_id AND current.version=h.current_version WHERE v.hidden_at IS NULL;

CREATE VIEW analytics_shared_events AS
SELECT e.* FROM analytics_source_events e JOIN users u ON u.id=e.patient_id
LEFT JOIN user_prefs p ON p.user_id=e.patient_id
WHERE e.clinician_visible=1 AND u.status <> 'tombstone'
AND EXISTS(SELECT 1 FROM consent_current c WHERE c.user_id=e.patient_id AND c.consent_kind='base' AND c.action='given')
AND (e.metric NOT IN ('mood','sleep_score','sleep_hours','anxiety_score') OR COALESCE(p.share_diary_scores,1)=1)
AND (e.metric <> 'note_present' OR e.source='diary_day_notes' OR COALESCE((SELECT shared FROM diary_day_notes n WHERE n.patient_id=e.patient_id AND n.note_id='legacy-'||e.source_id),p.share_diary_notes,0)=1)
AND (e.metric <> 'medication_status' OR COALESCE(p.share_med_log,1)=1);

-- Views expose only random subject codes. Habit IDs have no shared semantics, so no automatic cohort inclusion.
CREATE VIEW analytics_reporting_members AS
SELECT DISTINCT s.subject_code,a.clinician_id,'current' AS scope, NULL AS started_day,NULL AS ended_day
FROM analytics_subjects s JOIN care_assignments a ON a.patient_id=s.patient_id
JOIN users u ON u.id=s.patient_id
WHERE a.ended_at IS NULL AND COALESCE(a.end_reason,'')<>'signal_only' AND u.status<>'tombstone'
AND EXISTS(SELECT 1 FROM consent_current c WHERE c.user_id=s.patient_id AND c.consent_kind='base' AND c.action='given')
UNION
SELECT DISTINCT s.subject_code,a.clinician_id,'historical',
 CASE WHEN ep.started_at IS NOT NULL AND ep.started_at>a.started_at THEN substr(ep.started_at,1,10) ELSE substr(a.started_at,1,10) END,
 CASE WHEN a.ended_at IS NULL THEN substr(ep.ended_at,1,10) WHEN ep.ended_at IS NULL THEN substr(a.ended_at,1,10) ELSE min(substr(a.ended_at,1,10),substr(ep.ended_at,1,10)) END
FROM analytics_subjects s JOIN care_assignments a ON a.patient_id=s.patient_id
LEFT JOIN care_episodes ep ON ep.id=a.episode_id AND ep.patient_id=a.patient_id
JOIN users u ON u.id=s.patient_id
WHERE COALESCE(a.end_reason,'')<>'signal_only' AND (a.episode_id IS NULL OR ep.id IS NOT NULL) AND u.status<>'tombstone'
AND EXISTS(SELECT 1 FROM consent_current c WHERE c.user_id=s.patient_id AND c.consent_kind='base' AND c.action='given')
UNION
SELECT s.subject_code,NULL,'program',NULL,NULL FROM analytics_subjects s JOIN users u ON u.id=s.patient_id
WHERE u.role='patient' AND u.status<>'tombstone'
AND EXISTS(SELECT 1 FROM consent_current c WHERE c.user_id=s.patient_id AND c.consent_kind='base' AND c.action='given')
AND EXISTS(SELECT 1 FROM consent_current c WHERE c.user_id=s.patient_id AND c.consent_kind='program' AND c.action='given');

CREATE VIEW analytics_reporting_events AS
SELECT DISTINCT s.subject_code,m.clinician_id,m.scope,e.day,e.source,e.source_id,e.metric,e.dimension,e.value,e.unit,e.recorded_at
FROM analytics_shared_events e JOIN analytics_subjects s ON s.patient_id=e.patient_id
JOIN analytics_reporting_members m ON m.subject_code=s.subject_code
WHERE e.metric<>'habit_value' AND (m.scope<>'historical' OR EXISTS(
 SELECT 1 FROM care_assignments a LEFT JOIN care_episodes ep ON ep.id=a.episode_id AND ep.patient_id=a.patient_id
 WHERE a.patient_id=e.patient_id AND a.clinician_id=m.clinician_id AND COALESCE(a.end_reason,'')<>'signal_only'
 AND e.day>=substr(a.started_at,1,10) AND (a.ended_at IS NULL OR e.day<=substr(a.ended_at,1,10))
 AND (a.episode_id IS NULL OR (ep.id IS NOT NULL AND e.day>=substr(ep.started_at,1,10) AND (ep.ended_at IS NULL OR e.day<=substr(ep.ended_at,1,10))))));

CREATE TABLE analytics_product_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT, WITHOUT ROWID;
INSERT INTO analytics_product_metadata VALUES ('history_started_at',strftime('%Y-%m-%dT%H:%M:%SZ','now'));
CREATE TABLE analytics_product_activity (
 id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
 role TEXT NOT NULL, event TEXT NOT NULL, session_code TEXT,
 recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;
CREATE INDEX idx_analytics_product_period ON analytics_product_activity(recorded_at,role,user_id);
INSERT OR IGNORE INTO analytics_subjects(patient_id,subject_code,created_at)
 SELECT id,lower(hex(randomblob(12))),strftime('%Y-%m-%dT%H:%M:%SZ','now') FROM users;
-- Baseline is explicitly now, not historical activity.
INSERT INTO analytics_product_activity(user_id,role,event) SELECT id,role,'role_snapshot' FROM users WHERE status<>'tombstone';
CREATE TRIGGER analytics_user_insert AFTER INSERT ON users BEGIN
 INSERT OR IGNORE INTO analytics_subjects(patient_id,subject_code,created_at) VALUES(NEW.id,lower(hex(randomblob(12))),strftime('%Y-%m-%dT%H:%M:%SZ','now'));
 INSERT INTO analytics_product_activity(user_id,role,event) VALUES(NEW.id,NEW.role,'registered');
END;
CREATE TRIGGER analytics_user_role AFTER UPDATE OF role ON users WHEN NEW.role<>OLD.role BEGIN
 INSERT INTO analytics_product_activity(user_id,role,event) VALUES(NEW.id,NEW.role,'role_snapshot');
END;
CREATE TRIGGER analytics_session_insert AFTER INSERT ON sessions WHEN NEW.user_id IS NOT NULL BEGIN
 INSERT INTO analytics_product_activity(user_id,role,event,session_code) SELECT NEW.user_id,role,'session_started',NEW.sid_hash FROM users WHERE id=NEW.user_id;
END;
CREATE TRIGGER analytics_session_identify AFTER UPDATE OF user_id ON sessions WHEN OLD.user_id IS NULL AND NEW.user_id IS NOT NULL BEGIN
 INSERT INTO analytics_product_activity(user_id,role,event,session_code) SELECT NEW.user_id,role,'session_started',NEW.sid_hash FROM users WHERE id=NEW.user_id;
END;
CREATE VIEW analytics_product_users AS SELECT role,COUNT(*) AS people FROM users WHERE status<>'tombstone' GROUP BY role;
CREATE VIEW analytics_product_events AS SELECT s.subject_code,a.role,a.event,a.session_code,a.recorded_at FROM analytics_product_activity a JOIN analytics_subjects s ON s.patient_id=a.user_id JOIN users u ON u.id=a.user_id WHERE u.status<>'tombstone';

-- Existing public cohort endpoints use the same current consent and visibility policy.
DROP VIEW analytics_cohort_facts;
DROP VIEW analytics_program_facts;
DROP VIEW analytics_cohort_members;
DROP VIEW analytics_program_members;
CREATE VIEW analytics_cohort_members AS
 SELECT DISTINCT s.subject_code,a.clinician_id FROM analytics_subjects s
 JOIN users u ON u.id=s.patient_id JOIN care_assignments a ON a.patient_id=s.patient_id
 WHERE a.ended_at IS NULL AND COALESCE(a.end_reason,'')<>'signal_only' AND u.status<>'tombstone'
 AND EXISTS(SELECT 1 FROM consent_current c WHERE c.user_id=s.patient_id AND c.consent_kind='base' AND c.action='given');
CREATE VIEW analytics_program_members AS
 SELECT s.subject_code FROM analytics_subjects s JOIN users u ON u.id=s.patient_id
 WHERE u.role='patient' AND u.status<>'tombstone'
 AND EXISTS(SELECT 1 FROM consent_current c WHERE c.user_id=s.patient_id AND c.consent_kind='base' AND c.action='given')
 AND EXISTS(SELECT 1 FROM consent_current c WHERE c.user_id=s.patient_id AND c.consent_kind='program' AND c.action='given');
CREATE VIEW analytics_cohort_facts AS
 SELECT s.subject_code,m.clinician_id,f.day,date(f.day,'weekday 0','-6 days') week,f.metric,f.value,f.source,f.computed_at
 FROM analytics_facts f JOIN analytics_subjects s ON s.patient_id=f.patient_id
 JOIN analytics_cohort_members m ON m.subject_code=s.subject_code LEFT JOIN user_prefs p ON p.user_id=f.patient_id
 WHERE (f.metric NOT IN ('mood','sleep_score','anxiety_score') OR COALESCE(p.share_diary_scores,1)=1)
 AND (f.metric<>'note_present' OR COALESCE((SELECT shared FROM diary_day_notes WHERE patient_id=f.patient_id AND note_id='legacy-'||f.source_id),p.share_diary_notes,0)=1);
CREATE VIEW analytics_program_facts AS
 SELECT s.subject_code,f.day,date(f.day,'weekday 0','-6 days') week,f.metric,f.value,f.source,f.computed_at
 FROM analytics_facts f JOIN analytics_subjects s ON s.patient_id=f.patient_id
 JOIN analytics_program_members m ON m.subject_code=s.subject_code LEFT JOIN user_prefs p ON p.user_id=f.patient_id
 WHERE (f.metric NOT IN ('mood','sleep_score','anxiety_score') OR COALESCE(p.share_diary_scores,1)=1)
 AND (f.metric<>'note_present' OR COALESCE((SELECT shared FROM diary_day_notes WHERE patient_id=f.patient_id AND note_id='legacy-'||f.source_id),p.share_diary_notes,0)=1);

-- Legacy diary mutations participate in workspace optimistic concurrency.
CREATE TRIGGER diary_workspace_mood_insert AFTER INSERT ON mood_entries BEGIN
 UPDATE diary_workspaces SET revision=revision+1 WHERE patient_id=NEW.patient_id;
END;
CREATE TRIGGER diary_workspace_mood_update AFTER UPDATE ON mood_entries BEGIN
 UPDATE diary_workspaces SET revision=revision+1 WHERE patient_id=NEW.patient_id;
END;
CREATE TRIGGER diary_workspace_mood_delete AFTER DELETE ON mood_entries BEGIN
 UPDATE diary_workspaces SET revision=revision+1 WHERE patient_id=OLD.patient_id;
END;
