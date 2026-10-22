-- «Принять» назначение: пациент может указать свою дозировку, если она отличается от назначенной врачом.
-- Только добавление колонок. NULL — пациент принимает как назначено.

ALTER TABLE plan_item_acceptance ADD COLUMN patient_dose_value REAL;
ALTER TABLE plan_item_acceptance ADD COLUMN patient_dose_unit TEXT;
