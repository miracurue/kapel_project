-- W-30/W-32 (этап 14): ИИ-шлюз F-26, реестр моделей M-19 и псевдонимизация F-80.
-- Все таблицы ИИ и псевдонимизации (ai_models, ai_binding_versions, prompt_versions, ai_usage,
-- ai_threads, ai_messages, ai_message_chips, ai_ratings, hint_drafts, ai_audit, pii_values,
-- pii_counters, pii_stats_weekly) уже созданы миграцией 0001 по схеме этапа 11 — здесь только
-- начальные записи реестра и привязки по умолчанию.

-- Реестр моделей (M-19, 04-technologies): GigaChat-2-Max основная, GigaChat-2-Pro запасная,
-- local_stub для тестов/демо, openai_compat для локальной модели на нашем сервере.
-- У внешних моделей data_class='synthetic_only' (L-11, PD-01): при DATA_MODE=real они не вызываются.
INSERT INTO ai_models(title, adapter, api_base, model_ident, secret_name, params_json, location, data_class, supports_tools, license_url, status_243fz) VALUES
  ('GigaChat-2-Max (Сбер) — основная', 'gigachat_api', NULL, 'GigaChat-2-Max', 'GIGACHAT_AUTH_KEY', '{}', 'ru_external', 'synthetic_only', 1, 'https://developers.sber.ru/docs/ru/gigachat', 'sovereign'),
  ('GigaChat-2-Pro (Сбер) — запасная', 'gigachat_api', NULL, 'GigaChat-2-Pro', 'GIGACHAT_AUTH_KEY', '{}', 'ru_external', 'synthetic_only', 1, 'https://developers.sber.ru/docs/ru/gigachat', 'sovereign'),
  ('Локальная заглушка ИИ — основная (демо/тесты)', 'local_stub', NULL, 'local_stub', NULL, '{}', 'our_server', 'local_ok', 0, 'https://example.test/license/local-stub', 'unknown'),
  ('Локальная заглушка ИИ — запасная (демо/тесты)', 'local_stub', NULL, 'local_stub', NULL, '{}', 'our_server', 'local_ok', 0, 'https://example.test/license/local-stub', 'unknown'),
  ('OpenAI-совместимая модель на нашем сервере', 'openai_compat', NULL, 'openai_compat', 'OPENAI_COMPAT_API_KEY', '{}', 'our_server', 'local_ok', 0, 'https://example.test/license/openai-compat', 'unknown');

-- Привязки назначений по умолчанию (S-02…S-07, S-33): демо и автотесты идут без сети,
-- поэтому по умолчанию — local_stub. Если при запуске сервера в окружении есть ключ GigaChat
-- (GIGACHAT_AUTH_KEY), стартовая автонастройка создаёт следующую версию привязки на GigaChat
-- (см. src/ai/registry.js) — переключение без правки миграции и без перезапуска привязок.
INSERT INTO ai_binding_versions(purpose, version, primary_model_id, fallback_model_id, status, comment)
SELECT p.purpose, 1,
       (SELECT id FROM ai_models WHERE title = 'Локальная заглушка ИИ — основная (демо/тесты)'),
       (SELECT id FROM ai_models WHERE title = 'Локальная заглушка ИИ — запасная (демо/тесты)'),
       'active',
       'Начальная привязка W-30: демо и тесты без сети (local_stub). Боевая модель включается настройкой (UC-44) или автонастройкой по окружению.'
FROM (
  SELECT 'patient_assistant' AS purpose
  UNION ALL SELECT 'clinician_chat'
  UNION ALL SELECT 'document_draft'
  UNION ALL SELECT 'diagnostic_hints'
  UNION ALL SELECT 'ae_extraction'
  UNION ALL SELECT 'order_parse'
  UNION ALL SELECT 'admin_assistant'
) AS p;

-- Начальные версии промптов загружаются из prompts/<ключ>/v001.md при первом запуске сервера
-- (src/ai/registry.js): в миграции пути к файлам недоступны.
INSERT INTO action_log(actor_id, action, new_safe_json) VALUES (NULL, 'migration.ai_registry_seeded', json_object('task', 'W-30'));
