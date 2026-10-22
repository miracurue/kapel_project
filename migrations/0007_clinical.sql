-- W-13: fields required by the v2 clinical workflow.  The baseline already
-- contains the target clinical tables; this migration makes draft confirmation
-- explicit for installations created before V2.
ALTER TABLE offline_results ADD COLUMN confirmed_at TEXT;
