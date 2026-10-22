-- «Мои статьи»: беседа автора с ИИ по статье. Реплики хранятся в псевдонимизированном виде (как уходят в модель, F-80);
-- вся беседа этой статьи передаётся модели вместе с новой репликой. Данных пациентов нет, patient_id нет.
CREATE TABLE library_chat (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES library_items(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;
CREATE INDEX idx_library_chat_item ON library_chat(item_id, id);
