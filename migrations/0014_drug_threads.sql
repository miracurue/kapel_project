-- Вкладка «Лекарства» специалиста: чат по препарату хранится как обычный ИИ-тред (purpose = 'drug_chat').
-- Только добавление колонки: препарат каталога, к которому открыт тред. NULL — у всех прочих тредов.

ALTER TABLE ai_threads ADD COLUMN drug_inn_id INTEGER REFERENCES inn(id);
CREATE INDEX idx_ai_threads_drug ON ai_threads(owner_user_id, drug_inn_id) WHERE drug_inn_id IS NOT NULL;
