-- Поля, нужные импорту и векторизации клинреков (волна 2, задача D).
-- Служебные записи (supporting/reference) не имеют режима поиска: mode допускает NULL (CHECK с NULL проходит).
ALTER TABLE clinrec.chunks ALTER COLUMN mode DROP NOT NULL;

-- embed: чанк подлежит векторизации; embed_text — ровно то, что уходит в модель; embed_text_hash = sha256(embed_text).
-- embedding_hash = embed_text_hash того текста, по которому посчитан вектор (совпадают -> вектор актуален).
-- embed_skip_reason: причина, по которой вектора нет (решение за человеком), например 'input_token_limit'.
ALTER TABLE clinrec.chunks
  ADD COLUMN embed boolean NOT NULL DEFAULT false,
  ADD COLUMN embed_text text,
  ADD COLUMN embed_text_hash text,
  ADD COLUMN embed_skip_reason text,
  ADD CONSTRAINT chunks_skip_has_no_vector CHECK (embed_skip_reason IS NULL OR embedding IS NULL),
  ADD CONSTRAINT chunks_embed_has_text CHECK (NOT embed OR (embed_text IS NOT NULL AND embed_text_hash IS NOT NULL));
CREATE INDEX chunks_embed_pending ON clinrec.chunks (document_id) WHERE embed AND embedding IS NULL;

ALTER TABLE clinrec.parents
  ADD COLUMN kind text,
  ADD COLUMN title text,
  ADD COLUMN source_text text;

ALTER TABLE clinrec.sections ADD COLUMN meta jsonb NOT NULL DEFAULT '{}';
ALTER TABLE clinrec.documents ADD COLUMN meta jsonb NOT NULL DEFAULT '{}';
