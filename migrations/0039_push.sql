-- Пуш-уведомления (Web Push) о напоминаниях пациента; решение владелицы 2026-10-26.
-- Подписка устройства: endpoint выдаёт браузер, ключи нужны для шифрования; на одного пользователя — несколько устройств.
CREATE TABLE push_subscriptions (
 id INTEGER PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id),
 endpoint TEXT NOT NULL UNIQUE CHECK(length(endpoint) BETWEEN 20 AND 600),
 p256dh TEXT NOT NULL,
 auth TEXT NOT NULL,
 created_at TEXT NOT NULL,
 last_ok_at TEXT,
 fail_count INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);

-- Что уже отправлено: одно напоминание в сутки (day = дата пациента) или один раз за всё время (day = '').
-- Текст пуша нейтральный и в журнал не пишется: на заблокированном экране не должно быть сведений о здоровье.
CREATE TABLE push_deliveries (
 id INTEGER PRIMARY KEY,
 patient_id INTEGER NOT NULL REFERENCES users(id),
 reminder_key TEXT NOT NULL,
 day TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('sent','dry','failed')),
 devices INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 UNIQUE(patient_id, reminder_key, day)
) STRICT;
