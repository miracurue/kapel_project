-- Conversation belongs to the reusable template, never to a patient-filled copy.
ALTER TABLE tool_templates ADD COLUMN messages_json TEXT NOT NULL DEFAULT '[]';
