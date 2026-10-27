'use strict';

// Исключение из L-11 на этапе разработки (решение владельца 2026-10-25): модели, которые позже будут развёрнуты
// локально, тестируются через зарубежный шлюз (OpenRouter). В реестре моделей появляется место «foreign_external».
// Безопасность держит шлюз: такая модель всегда synthetic_only (CHECK таблицы), при DATA_MODE=real она не вызывается
// (E-MODEL-MODE), наружу уходят только псевдонимизированные тексты синтетического режима. Перед боем модель
// отключается.
//
// SQLite не меняет CHECK на месте, поэтому таблица пересоздаётся (порядок из документации SQLite, «12 шагов»):
// внешние ключи на это время выключает запускатель (foreignKeysOff), индексы и триггеры переносятся, перед COMMIT
// проверяется foreign_key_check. Строки и их id не меняются.

function up(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_models'").get();
  const from = "CHECK (location IN ('our_server','ru_external'))";
  const to = "CHECK (location IN ('our_server','ru_external','foreign_external'))";
  if (!row || !row.sql.includes(from) || !row.sql.startsWith('CREATE TABLE ai_models'))
    throw new Error('ai_models: ожидаемое определение таблицы не найдено');
  const extras = db
    .prepare("SELECT sql FROM sqlite_master WHERE tbl_name='ai_models' AND type IN ('index','trigger') AND sql IS NOT NULL")
    .all();
  db.exec(row.sql.replace(from, to).replace('CREATE TABLE ai_models', 'CREATE TABLE ai_models_new'));
  db.exec('INSERT INTO ai_models_new SELECT * FROM ai_models');
  db.exec('DROP TABLE ai_models');
  db.exec('ALTER TABLE ai_models_new RENAME TO ai_models');
  for (const e of extras) db.exec(e.sql);

  db.prepare(
    `INSERT INTO ai_models(title, adapter, api_base, model_ident, secret_name, params_json, location, data_class, supports_tools, license_url, status_243fz, enabled)
     VALUES ('Qwen3.8-Flash (OpenRouter, разработка)', 'openai_compat', 'https://openrouter.ai/api/v1', 'qwen/qwen3.8-flash',
             'OPENROUTER_API_KEY', '{}', 'foreign_external', 'synthetic_only', 1, 'https://openrouter.ai/qwen/qwen3.8-flash', 'other', 1)`,
  ).run();
}

up.foreignKeysOff = true;
module.exports = up;
