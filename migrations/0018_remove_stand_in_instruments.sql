-- Фейковые методики (STAND-IN PHQ-9, GAD-7, WHO-5, «проверка типов») выводятся из оборота.
-- Настоящие методики вносятся по одной и получают новую версию (сид в src/modules/clinical).
-- Результаты и кризисные записи не удаляются: журналы только дописываются.
UPDATE instrument_assignments
   SET status = 'cancelled', cancelled_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), cancel_reason = 'stand_in_removed'
 WHERE status IN ('pending','in_progress','waiting_entry')
   AND instrument IN (SELECT instrument_code FROM instrument_versions WHERE is_stand_in = 1);
UPDATE instruments
   SET status = 'withdrawn', online_allowed = 0, self_service = 0
 WHERE status = 'stand_in'
   AND code IN (SELECT instrument_code FROM instrument_versions WHERE is_stand_in = 1);
UPDATE instrument_versions SET status = 'superseded' WHERE is_stand_in = 1;
