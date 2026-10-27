-- Опрос о побочном эффекте в чате и запись врачом/психологом (план .agents/tasks/2026-10-23-ae-intake.md).
-- Таблица не пересоздаётся, CHECK не меняются: источник остаётся 'ai_chat' | 'form', автор — reported_by.
-- reported_by    — кто внёс запись (пациент, психиатр или психолог);
-- med_text_enc   — свободное название препарата, если он не из плана ([ЧПД], хранится как description_enc);
-- thread_id      — ИИ-чат, откуда пришла запись (без внешнего ключа: тред стирается по сроку хранения).
ALTER TABLE adverse_events ADD COLUMN reported_by INTEGER;
ALTER TABLE adverse_events ADD COLUMN med_text_enc TEXT;
ALTER TABLE adverse_events ADD COLUMN thread_id INTEGER;
