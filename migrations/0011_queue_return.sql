-- W-38: служебная очередь — возврат взятого запроса в общую очередь (F-82, T-251).
-- Статус «возвращено в очередь» — 'open': взятый и не закрытый запрос по сроку S-63
-- возвращается администратору как доступный для взятия. CHECK в 0001 не содержит 'open',
-- поэтому таблица пересоздаётся (SQLite не умеет менять CHECK у существующей таблицы).
-- Данные переносятся полностью, индексы восстанавливаются (частичный уникальный индекс
-- расширен на 'open', чтобы returned-запрос не дублировался с новым по той же ссылке).

CREATE TABLE service_queue_w38 (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('crisis_no_clinician','crisis_manual_review','ae_no_psychiatrist','message_no_clinician',
     'erasure','subject_info','stop_processing','dispute_access','change_clinician','substitution','patient_without_clinician',
     'mail_failed','job_failed','ai_budget','correction_overdue','catalog_review')),
  patient_id INTEGER REFERENCES users(id),
  ref_type TEXT, ref_id INTEGER,
  priority INTEGER NOT NULL DEFAULT 5,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','taken','open','done','rejected','waiting')),
  taken_by INTEGER REFERENCES users(id), taken_at TEXT,
  closed_by INTEGER REFERENCES users(id), closed_at TEXT, result_code TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;

INSERT INTO service_queue_w38 SELECT * FROM service_queue;

DROP TABLE service_queue;
ALTER TABLE service_queue_w38 RENAME TO service_queue;

CREATE INDEX idx_queue_open ON service_queue(status, priority, due_at);
CREATE INDEX idx_queue_ref ON service_queue(ref_type, ref_id);
CREATE UNIQUE INDEX uq_queue_open_ref ON service_queue(kind, ref_type, ref_id) WHERE status IN ('new','taken','waiting','open');
