-- Трассировка ИИ-агента (чат специалиста): один запуск на ответ, строка на каждый шаг внутри него.
-- Нужна для отладки: какие инструменты и навыки вызвала модель, с какими аргументами, что получила,
-- сколько токенов и времени ушло. Решение владельца 2026-10-25: тексты (вопрос, ответ, аргументы и
-- результаты инструментов) хранятся только в демо-режиме с синтетическими данными, с метками #ТИП-N#
-- вместо ПДн, 30 дней (expires_at), видит только администратор. При DATA_MODE=real текстовые поля пустые,
-- остаются шаги, имена инструментов и числа. Это не технический журнал: ai_audit по-прежнему без текстов.
-- Стирание пациента удаляет его запуски (patient_id), шаги удаляются каскадом.

CREATE TABLE ai_agent_runs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  purpose TEXT NOT NULL,
  prompt_key TEXT NOT NULL,
  thread_id INTEGER,
  message_id INTEGER,
  patient_id INTEGER REFERENCES users(id),
  model_ident TEXT,
  prompt_layers_json TEXT CHECK (prompt_layers_json IS NULL OR json_valid(prompt_layers_json)),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'fallback', 'filtered', 'error', 'timeout', 'limit')),
  steps INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  stop_reason TEXT,
  question_text TEXT,
  answer_text TEXT,
  texts_stored INTEGER NOT NULL DEFAULT 0 CHECK (texts_stored IN (0, 1)),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_agent_runs_created ON ai_agent_runs(created_at DESC);
CREATE INDEX idx_agent_runs_expires ON ai_agent_runs(expires_at);
CREATE INDEX idx_agent_runs_thread ON ai_agent_runs(thread_id);

CREATE TABLE ai_agent_steps (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES ai_agent_runs(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('model', 'tool', 'skill', 'note')),
  model_ident TEXT,
  name TEXT,
  args_json TEXT CHECK (args_json IS NULL OR json_valid(args_json)),
  result_text TEXT,
  result_chars INTEGER,
  reason_text TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  context_tokens INTEGER,
  duration_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error', 'timeout', 'repeat', 'denied')),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, n)
) STRICT;
