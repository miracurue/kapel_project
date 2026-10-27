-- Инструкции по применению лекарств и реестр побочных реакций.
-- Все id — текстовые, детерминированные (сохраняются из SQLite-версии и реестра).
-- Эмбеддинги лежат прямо в строках; NULL = ещё не посчитан; embedding_hash = content_hash
-- на момент расчёта (расхождение = вектор устарел).
CREATE SCHEMA med;

CREATE TABLE med.documents (
  id text PRIMARY KEY,
  drug_label text NOT NULL,
  inn text NOT NULL,
  trade_name text,
  source_file text NOT NULL,
  sha256 text NOT NULL,
  markdown text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE med.sections (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES med.documents(id) ON DELETE CASCADE,
  parent_id text REFERENCES med.sections(id) ON DELETE CASCADE,
  level integer NOT NULL,
  ord integer NOT NULL,
  title text NOT NULL,
  path text NOT NULL,
  start_char integer NOT NULL,
  end_char integer NOT NULL CHECK (end_char >= start_char),
  start_line integer NOT NULL,
  page text
);
CREATE INDEX sections_document_ord ON med.sections (document_id, ord);
CREATE INDEX sections_parent ON med.sections (parent_id);

CREATE TABLE med.chunks (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES med.documents(id) ON DELETE CASCADE,
  section_id text NOT NULL REFERENCES med.sections(id) ON DELETE CASCADE,
  section_ids text[] NOT NULL DEFAULT '{}',
  ord integer NOT NULL,
  text text NOT NULL,
  oversized boolean NOT NULL DEFAULT false,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('russian'::regconfig, text)) STORED,
  content_hash text NOT NULL,
  start_char integer NOT NULL,
  end_char integer NOT NULL CHECK (end_char > start_char),
  embedding halfvec(2560),
  embedding_model text,
  embedding_hash text,
  UNIQUE (document_id, ord),
  CHECK ((embedding IS NULL) = (embedding_model IS NULL))
);
CREATE INDEX chunks_document ON med.chunks (document_id);
CREATE INDEX chunks_section ON med.chunks (section_id);
CREATE INDEX chunks_section_ids ON med.chunks USING gin (section_ids);
CREATE INDEX chunks_tsv ON med.chunks USING gin (tsv);
CREATE INDEX chunks_embedding ON med.chunks USING hnsw (embedding halfvec_cosine_ops);

CREATE TABLE med.effects (
  id text PRIMARY KEY,
  name text NOT NULL,
  category text,
  status text NOT NULL DEFAULT 'review-required' CHECK (status = 'review-required'),
  raw_json jsonb NOT NULL,
  embedding halfvec(2560),
  embedding_model text,
  embedding_hash text,
  CHECK ((embedding IS NULL) = (embedding_model IS NULL))
);
CREATE INDEX effects_name_trgm ON med.effects USING gin (lower(name) gin_trgm_ops);
CREATE INDEX effects_embedding ON med.effects USING hnsw (embedding halfvec_cosine_ops);

CREATE TABLE med.effect_aliases (
  effect_id text NOT NULL REFERENCES med.effects(id) ON DELETE CASCADE,
  alias text NOT NULL,
  normalized text NOT NULL,
  PRIMARY KEY (effect_id, alias)
);
CREATE INDEX effect_aliases_normalized ON med.effect_aliases (normalized);
CREATE INDEX effect_aliases_trgm ON med.effect_aliases USING gin (normalized gin_trgm_ops);

CREATE TABLE med.blocks (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES med.documents(id) ON DELETE CASCADE,
  raw_json jsonb NOT NULL
);
CREATE INDEX blocks_document ON med.blocks (document_id);

CREATE TABLE med.source_mentions (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES med.documents(id) ON DELETE CASCADE,
  raw_json jsonb NOT NULL
);
CREATE INDEX source_mentions_document ON med.source_mentions (document_id);

CREATE TABLE med.effect_links (
  id text PRIMARY KEY,
  effect_id text NOT NULL REFERENCES med.effects(id) ON DELETE CASCADE,
  document_id text NOT NULL REFERENCES med.documents(id) ON DELETE CASCADE,
  block_id text NOT NULL REFERENCES med.blocks(id) ON DELETE CASCADE,
  frequency text NOT NULL,
  context text NOT NULL,
  raw_term text NOT NULL,
  raw_json jsonb NOT NULL
);
CREATE INDEX effect_links_lookup ON med.effect_links (effect_id, document_id);
CREATE INDEX effect_links_document ON med.effect_links (document_id);
CREATE INDEX effect_links_block ON med.effect_links (block_id);
CREATE INDEX effect_links_term_trgm ON med.effect_links USING gin (lower(raw_term) gin_trgm_ops);

-- Связка с каталогом приложения (SQLite): по нормализованному МНН, без JOIN между СУБД.
CREATE TABLE med.drug_map (
  inn_name_norm text NOT NULL,
  document_id text NOT NULL REFERENCES med.documents(id) ON DELETE CASCADE,
  PRIMARY KEY (inn_name_norm, document_id)
);
CREATE INDEX drug_map_document ON med.drug_map (document_id);

CREATE INDEX documents_label_trgm ON med.documents USING gin (lower(drug_label) gin_trgm_ops);
CREATE INDEX documents_inn_trgm ON med.documents USING gin (lower(inn) gin_trgm_ops);
CREATE INDEX documents_trade_trgm ON med.documents USING gin (lower(trade_name) gin_trgm_ops);
CREATE INDEX documents_inn ON med.documents (lower(inn));
