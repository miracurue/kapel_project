-- Очный бланк, который врач заполняет на приёме в той же методике, что и онлайн: ответы по пунктам хранятся
-- рядом с баллом, чтобы результат в карточке можно было открыть и сверить (как online_results.answers_json).
ALTER TABLE offline_results ADD COLUMN answers_json TEXT;
