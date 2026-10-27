-- Кризисный режим чата пациента (решение владельца 2026-10-26, .agents/tasks/2026-10-26-patient-crisis-mode.md).
--
-- ai_threads.mode = 'crisis' — тред кризисного разговора; crisis_escalation_id — сигнал врачу, к которому он привязан.
-- У остальных тредов оба поля NULL.
--
-- crisis_ai_assessments — оценка ИИ внутри кризисного разговора (только добавление): уровень, безопасность сейчас,
-- один ли человек, есть ли средства, уверенность и короткая заметка для врача. Оценка НЕ отменяет и НЕ закрывает сигнал:
-- она только дополняет карточку врача и может поднять уровень сигнала. Закрывает сигнал врач.

ALTER TABLE ai_threads ADD COLUMN mode TEXT;
ALTER TABLE ai_threads ADD COLUMN crisis_escalation_id INTEGER REFERENCES crisis_escalations(id);
CREATE INDEX idx_ai_threads_crisis ON ai_threads(crisis_escalation_id) WHERE crisis_escalation_id IS NOT NULL;

CREATE TABLE crisis_ai_assessments (
  id INTEGER PRIMARY KEY,
  escalation_id INTEGER NOT NULL REFERENCES crisis_escalations(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  thread_id INTEGER NOT NULL REFERENCES ai_threads(id),
  level TEXT NOT NULL CHECK (level IN ('accidental','distress_no_risk','passive_ideation','active_ideation','plan_or_intent','attempt_in_progress')),
  safe_now TEXT NOT NULL CHECK (safe_now IN ('yes','no','unknown')),
  alone TEXT NOT NULL CHECK (alone IN ('yes','no','unknown')),
  means TEXT NOT NULL CHECK (means IN ('yes','no','unknown')),
  confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
  note_enc TEXT,
  model_id INTEGER,
  prompt_version INTEGER,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_crisis_ai_esc ON crisis_ai_assessments(escalation_id, id);
CREATE TRIGGER crisis_ai_no_update BEFORE UPDATE ON crisis_ai_assessments BEGIN SELECT RAISE(ABORT,'append-only'); END;
