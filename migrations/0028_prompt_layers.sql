-- Слои промптов ИИ: роли, инструменты, навыки, задачи (src/ai/promptCatalog.js).
-- Прежние плоские промпты (patient_assistant, clinician_chat, document_draft…) заменены новыми ключами вида
-- role.*, tools.*, skill.*, task.*; их версии по решению владельца не сохраняются, начальные тексты загружает
-- сервер из prompts/<слой>/<имя>/v001.md при запуске.
-- В журнале ИИ добавлен список версий слоёв, из которых собрана инструкция запроса (без текстов).

UPDATE ai_eval_runs SET prompt_version_id = NULL
 WHERE prompt_version_id IN (
   SELECT id FROM prompt_versions
    WHERE prompt_key NOT LIKE 'role.%' AND prompt_key NOT LIKE 'tools.%'
      AND prompt_key NOT LIKE 'skill.%' AND prompt_key NOT LIKE 'task.%');

DELETE FROM prompt_versions
 WHERE prompt_key NOT LIKE 'role.%' AND prompt_key NOT LIKE 'tools.%'
   AND prompt_key NOT LIKE 'skill.%' AND prompt_key NOT LIKE 'task.%';

ALTER TABLE ai_audit ADD COLUMN prompt_layers_json TEXT CHECK (prompt_layers_json IS NULL OR json_valid(prompt_layers_json));
