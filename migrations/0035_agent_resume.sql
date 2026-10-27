-- Причина сбоя шага и память поиска для возобновления прерванного ответа агента.
--
-- error_text: код и короткое пояснение сбоя вызова модели («gigachat: HTTP 429», «fetch failed: UND_ERR_CONNECT_TIMEOUT»,
-- «AbortError»). Тело ответа провайдера не пишется (PD-17), только статус и код; поэтому поле заполняется и при
-- DATA_MODE=real.
--
-- ai_agent_calls: какие инструменты агент уже вызвал в запуске и с какими аргументами (без результатов). Если ответ
-- оборвался (сбой модели, перезапуск сервера), следующий запрос в том же треде повторяет эти вызовы сам и даёт
-- модели уже найденное, а не начинает поиск заново. Результаты не хранятся: их повторяют, номера источников [n]
-- при этом получаются заново и согласованными. Аргументы поиска очищены от ПДн (publicReferenceTerm, метки #ТИП-N#);
-- срок хранения — как у запусков (каскад по ai_agent_runs).

ALTER TABLE ai_agent_steps ADD COLUMN error_text TEXT;

CREATE TABLE ai_agent_calls (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES ai_agent_runs(id) ON DELETE CASCADE,
  thread_id INTEGER,
  n INTEGER NOT NULL,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL CHECK (json_valid(args_json)),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, n)
) STRICT;
CREATE INDEX idx_agent_calls_thread ON ai_agent_calls(thread_id, run_id);
