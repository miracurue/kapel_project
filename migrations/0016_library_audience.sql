-- «Мои статьи»: две аудитории журнала. patient — журнал для пациентов (как было до сих пор),
-- specialist — журнал для специалистов (психиатры и психологи). Пациенту отдаются только статьи patient.
-- Все существующие материалы остаются в журнале для пациентов. Только добавление колонки и индекса.

ALTER TABLE library_items ADD COLUMN audience TEXT NOT NULL DEFAULT 'patient' CHECK (audience IN ('patient','specialist'));

CREATE INDEX idx_library_audience ON library_items(audience, status);
