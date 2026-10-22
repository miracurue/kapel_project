-- Генерация шаблонов документов (вкладка «Документы»): модель 3-й серии GigaChat.
-- GigaChat-3-Ultra доступна только на https://api.giga.chat/v1 (адрес по умолчанию в адаптере).
-- Как и у остальных внешних моделей, data_class='synthetic_only' (L-11, PD-01): при DATA_MODE=real
-- модель не вызывается. Привязка назначения document_draft создаётся автонастройкой запуска
-- (src/ai/registry.js) при наличии GIGACHAT_AUTH_KEY — миграция привязки не меняет.
INSERT INTO ai_models(title, adapter, api_base, model_ident, secret_name, params_json, location, data_class, supports_tools, license_url, status_243fz) VALUES
  ('GigaChat-3-Ultra (Сбер)', 'gigachat_api', NULL, 'GigaChat-3-Ultra', 'GIGACHAT_AUTH_KEY', '{}', 'ru_external', 'synthetic_only', 1, 'https://developers.sber.ru/docs/ru/gigachat', 'sovereign');
