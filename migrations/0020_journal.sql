-- Журнал: отдельный раздел «для пациентов» / «для специалистов» поверх library_items (статьи, media='read').
-- journal_likes — лайки статей (без комментариев): один лайк на пару «читатель — статья».
-- published_at — дата первой публикации для ленты (updated_at меняется при каждой правке).
-- cover_url — готовая картинка обложки из каталога public/journal/img (демо), если файл не загружали в хранилище.

CREATE TABLE journal_likes (
  item_id INTEGER NOT NULL REFERENCES library_items(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (item_id, user_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_journal_likes_user ON journal_likes(user_id);

ALTER TABLE library_items ADD COLUMN published_at TEXT;
UPDATE library_items SET published_at = updated_at WHERE status = 'published' AND published_at IS NULL;

ALTER TABLE library_versions ADD COLUMN cover_url TEXT;
