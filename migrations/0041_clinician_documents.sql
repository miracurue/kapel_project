-- Документы специалиста по пациенту (вкладка «Шаблоны и документы», .agents/tasks/2026-10-26-templates-and-documents.md):
-- заполненный экземпляр формы (сейчас — извещение о нежелательной реакции для Росздравнадзора) для закреплённого пациента.
-- Отдельная таблица, а не ae_notice_versions: тот требует adverse_event_id и хранит версию на каждое сохранение,
-- а «Готово» должно быть общим для всех типов документов. patient_documents (DB-80) занято документами W-49.
-- fields_enc — типизированный JSON полей под полевым шифрованием (F-80). status 'ready' неизменяем (триггер);
-- version — счётчик сохранений для проверки конфликта; supersedes_id — «исправленная версия» готового документа.
CREATE TABLE clinician_documents (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  template_key TEXT NOT NULL,
  ae_id INTEGER REFERENCES adverse_events(id),
  fields_enc TEXT NOT NULL,                  -- [ЧПД] поля формы (JSON → AEAD)
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready')),
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_id INTEGER REFERENCES clinician_documents(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;
CREATE INDEX idx_clindocs_owner ON clinician_documents(owner_id, patient_id, id DESC);
CREATE INDEX idx_clindocs_ae ON clinician_documents(ae_id);
CREATE INDEX idx_clindocs_supersedes ON clinician_documents(supersedes_id);
CREATE TRIGGER clinician_documents_ready_immutable BEFORE UPDATE ON clinician_documents WHEN OLD.status = 'ready'
BEGIN SELECT RAISE(ABORT,'ready document is immutable'); END;
