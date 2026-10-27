-- Расширения и служебные таблицы хранилища знаний. Схемы med и clinrec — в 0002 и 0003.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Версия корпуса: key/value (registry_hash, embedding_model и т.п.). Замена данных идёт
-- в одной транзакции, поэтому отдельных «поколений» как в SQLite-версии не нужно (MVCC).
CREATE TABLE public.knowledge_meta (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
