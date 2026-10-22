-- Цветок и капельки пациента (награды за действия). Баланс и рост выводятся из журнала:
-- капельки = SUM(amount), шаги роста = SUM(steps). Отдельного счётчика нет, поэтому расхождений не бывает.
-- Журнал только дописывается (UPDATE запрещён). Удаление строк нужно только для стирания данных пациента (PD-12).
CREATE TABLE flower_state (
 patient_id INTEGER PRIMARY KEY REFERENCES users(id),
 started_at TEXT NOT NULL,   -- с этого дня считаются действия: прошлое задним числом не награждается
 synced_at TEXT NOT NULL    -- когда в последний раз просматривали источники начислений
) STRICT, WITHOUT ROWID;

CREATE TABLE flower_ledger (
 id INTEGER PRIMARY KEY,
 patient_id INTEGER NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('earn','spend')),
 action TEXT NOT NULL,                  -- ключ правила (src/modules/flower/rules.js) или 'water'
 amount INTEGER NOT NULL,               -- earn: >=0 (0 = упёрлись в дневной предел, ключ занят), spend: <0
 steps INTEGER NOT NULL DEFAULT 0,      -- шаги роста (только для spend)
 idem_key TEXT NOT NULL,                -- ключ идемпотентности: одно событие — одно начисление
 source TEXT NOT NULL DEFAULT '',       -- откуда событие: таблица:номер, без текста пациента
 day TEXT NOT NULL CHECK(length(day)=10 AND date(day)=day),
 created_at TEXT NOT NULL,
 CHECK((kind='earn' AND amount>=0 AND steps=0) OR (kind='spend' AND amount<0 AND steps>0)),
 UNIQUE(patient_id, idem_key)
) STRICT;
CREATE INDEX idx_flower_ledger_day ON flower_ledger(patient_id, day, action);
CREATE TRIGGER flower_ledger_append_only BEFORE UPDATE ON flower_ledger
BEGIN SELECT RAISE(ABORT, 'flower ledger is append-only'); END;

-- Для аналитики: начисления без идентификаторов (только случайный код субъекта). Пороги малых групп
-- применяет читатель (см. analytics/cohort.js), как для остальных представлений.
CREATE VIEW analytics_flower_events AS
SELECT s.subject_code, l.day, l.action, l.kind, l.amount, l.steps
FROM flower_ledger l JOIN analytics_subjects s ON s.patient_id = l.patient_id
JOIN users u ON u.id = l.patient_id WHERE u.status <> 'tombstone';
