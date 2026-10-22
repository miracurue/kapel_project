-- W-03: структура пользователей уже включена в 0001 baseline.
CREATE TRIGGER IF NOT EXISTS consent_events_no_delete
BEFORE DELETE ON consent_events
BEGIN SELECT RAISE(ABORT,'append-only'); END;
