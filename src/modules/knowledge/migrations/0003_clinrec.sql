-- Клинические рекомендации (parent–child RAG). Тексты публичные, данных пациентов нет.
CREATE SCHEMA clinrec;

CREATE TABLE clinrec.documents (
  id text PRIMARY KEY,
  title text NOT NULL,
  source_sha256 text NOT NULL,
  version text,
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_title_trgm ON clinrec.documents USING gin (lower(title) gin_trgm_ops);

CREATE TABLE clinrec.sections (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES clinrec.documents(id) ON DELETE CASCADE,
  parent_id text REFERENCES clinrec.sections(id) ON DELETE CASCADE,
  level integer NOT NULL,
  ord integer NOT NULL,
  title text NOT NULL,
  path text NOT NULL,
  span jsonb
);
CREATE INDEX sections_document_ord ON clinrec.sections (document_id, ord);

-- Родительские фрагменты: отдаются модели целиком, когда найден дочерний чанк.
CREATE TABLE clinrec.parents (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES clinrec.documents(id) ON DELETE CASCADE,
  section_id text REFERENCES clinrec.sections(id) ON DELETE SET NULL,
  heading_path text[] NOT NULL DEFAULT '{}',
  text text NOT NULL,
  span jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX parents_document ON clinrec.parents (document_id);
CREATE INDEX parents_section ON clinrec.parents (section_id);

CREATE TABLE clinrec.chunks (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES clinrec.documents(id) ON DELETE CASCADE,
  section_id text REFERENCES clinrec.sections(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('main', 'method', 'appendix', 'supporting', 'reference')),
  parent_id text REFERENCES clinrec.parents(id) ON DELETE SET NULL,
  mode text NOT NULL CHECK (mode IN ('self', 'parent', 'window')),
  heading_path text[] NOT NULL DEFAULT '{}',
  text text NOT NULL,
  source_text text,
  span jsonb,
  metadata jsonb NOT NULL DEFAULT '{}',
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('russian'::regconfig, text)) STORED,
  embedding halfvec(2560),
  embedding_model text,
  embedding_hash text,
  CHECK ((embedding IS NULL) = (embedding_model IS NULL))
);
CREATE INDEX chunks_document ON clinrec.chunks (document_id);
CREATE INDEX chunks_section ON clinrec.chunks (section_id);
CREATE INDEX chunks_parent ON clinrec.chunks (parent_id);
CREATE INDEX chunks_kind ON clinrec.chunks (kind);
CREATE INDEX chunks_tsv ON clinrec.chunks USING gin (tsv);
CREATE INDEX chunks_embedding ON clinrec.chunks USING hnsw (embedding halfvec_cosine_ops);

CREATE TABLE clinrec."references" (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES clinrec.documents(id) ON DELETE CASCADE,
  ord integer NOT NULL,
  text text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE (document_id, ord)
);
