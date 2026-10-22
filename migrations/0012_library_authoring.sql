-- Библиотека как рабочее место специалиста: владелец материала (автор-пользователь), обложка, пометка «с помощью ИИ».
-- Старые материалы остаются без владельца (author — текстом). Только добавление колонок и индекса.

ALTER TABLE library_items ADD COLUMN owner_user_id INTEGER REFERENCES users(id);
ALTER TABLE library_versions ADD COLUMN cover_file_id INTEGER REFERENCES stored_files(id);
ALTER TABLE library_versions ADD COLUMN ai_assisted INTEGER NOT NULL DEFAULT 0 CHECK (ai_assisted IN (0,1));

CREATE INDEX idx_library_owner ON library_items(owner_user_id, status);
