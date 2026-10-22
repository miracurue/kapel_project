-- Unified diary. Patient ownership is explicit; personal habit state never enters analytics.
-- Erasure discovers all patient_id tables; only metadata remains in audit logs.
CREATE TABLE diary_workspaces (
  patient_id INTEGER PRIMARY KEY REFERENCES users(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  updated_at TEXT NOT NULL
) STRICT;
