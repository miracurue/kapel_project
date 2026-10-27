-- Поведение пациента в чате с ИИ (решение владелицы 2026-10-27): метки заигрывания/грубости и статус ТРОЛЛЬ.
--
-- patient_chat_marks — события: модель поставила пометку [[GAME]] (заигрывание, проверка «на слабо») или [[RUDE]]
-- (грубость к чату). Текста сообщений здесь нет; кризисный разговор меток не создаёт. Только добавление.
-- patient_chat_blocks — пауза чата: три метки любого вида за 3 часа включают её на 1 час (blocked_until);
-- cleared_at/cleared_by — снятие администратором вручную. Пауза хранится на сервере и проверяется при отправке.
-- Обе таблицы с patient_id стираются целиком при стирании данных пациента (белый список фактов не нужен).

CREATE TABLE patient_chat_marks (
 id INTEGER PRIMARY KEY,
 patient_id INTEGER NOT NULL REFERENCES users(id),
 thread_id INTEGER,
 kind TEXT NOT NULL CHECK(kind IN ('GAME','RUDE')),
 created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_chat_marks_patient ON patient_chat_marks(patient_id, created_at);
CREATE TRIGGER chat_marks_no_update BEFORE UPDATE ON patient_chat_marks BEGIN SELECT RAISE(ABORT,'append-only'); END;

CREATE TABLE patient_chat_blocks (
 id INTEGER PRIMARY KEY,
 patient_id INTEGER NOT NULL REFERENCES users(id),
 started_at TEXT NOT NULL,
 blocked_until TEXT NOT NULL,
 cleared_at TEXT,
 cleared_by INTEGER REFERENCES users(id)
) STRICT;
CREATE INDEX idx_chat_blocks_patient ON patient_chat_blocks(patient_id, started_at);
