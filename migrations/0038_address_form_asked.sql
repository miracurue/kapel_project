-- Форма обращения: отвечал ли пациент на вопрос «как к тебе обращаться» (чат, решение владелицы 2026-10-26).
-- Значение по умолчанию «n» не отличает ответ «нейтрально» от «не спрашивали», поэтому ответ помечается отдельно.
ALTER TABLE user_prefs ADD COLUMN address_form_set INTEGER NOT NULL DEFAULT 0 CHECK (address_form_set IN (0,1));
UPDATE user_prefs SET address_form_set = 1 WHERE address_form <> 'n';
