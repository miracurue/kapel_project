-- Геймификация: форма обращения и режим фраз, «сделал методику», что и когда показывали.
-- Форма обращения отдельно от users.sex: это не медицинский пол, а только род в тёплых фразах.
ALTER TABLE user_prefs ADD COLUMN address_form TEXT NOT NULL DEFAULT 'n' CHECK (address_form IN ('f','m','n'));
ALTER TABLE user_prefs ADD COLUMN praise_mode TEXT NOT NULL DEFAULT 'normal' CHECK (praise_mode IN ('normal','quiet','off'));

-- Методика самопомощи, выполненная до конца: одна запись на методику в день (раз в день гарантирует база).
CREATE TABLE technique_runs (
 id INTEGER PRIMARY KEY,
 patient_id INTEGER NOT NULL REFERENCES users(id),
 slug TEXT NOT NULL,
 day TEXT NOT NULL CHECK(length(day)=10 AND date(day)=day),
 created_at TEXT NOT NULL,
 UNIQUE(patient_id, slug, day)
) STRICT;

-- Какие тёплые окошки показывали: для пределов («не чаще…») и чтобы фразы не повторялись подряд. Без текста пациента.
CREATE TABLE flower_message_log (
 id INTEGER PRIMARY KEY,
 patient_id INTEGER NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('bubble','greeting')),
 phrase_key TEXT NOT NULL,
 day TEXT NOT NULL CHECK(length(day)=10 AND date(day)=day),
 created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_flower_message_log ON flower_message_log(patient_id, id DESC);
