-- W-13: HADS must never be published or offered in the demo catalogue.
DELETE FROM instrument_versions WHERE instrument_code = 'hads';
DELETE FROM instruments WHERE code = 'hads';
