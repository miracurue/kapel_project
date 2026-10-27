-- Минимальная маршрутизация: связь двух специалистов вокруг одного пациента (.agents/tasks: «Система маршрутизации»).
-- Пациент сам выбирает, с кем из уже подключённых специалистов соединить нового (care_link_prompts → care_links).
-- Связь даёт канал между специалистами (care_link_messages) и чтение «чужого» среза в карточке пациента
-- (психиатру — результаты тестов психолога, психологу — назначения психиатра); закрепления она не меняет.
-- clinician_a < clinician_b: пара хранится один раз. Все три таблицы с patient_id стираются вместе с пациентом.
CREATE TABLE care_links (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  clinician_a INTEGER NOT NULL REFERENCES users(id),
  clinician_b INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  ended_at TEXT,
  ended_by INTEGER REFERENCES users(id),
  CHECK (clinician_a < clinician_b)
) STRICT;
CREATE UNIQUE INDEX uq_care_link_active ON care_links(patient_id, clinician_a, clinician_b) WHERE ended_at IS NULL;
CREATE INDEX idx_care_link_clin_a ON care_links(clinician_a, ended_at);
CREATE INDEX idx_care_link_clin_b ON care_links(clinician_b, ended_at);

-- Вопрос пациенту после подключения нового специалиста: показывается, пока answered_at пуст.
CREATE TABLE care_link_prompts (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES users(id),
  new_clinician_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  answered_at TEXT
) STRICT;
CREATE INDEX idx_care_link_prompt_patient ON care_link_prompts(patient_id, answered_at);

-- Сообщения между связанными специалистами по пациенту (виден только им; пациент и админ не читают).
CREATE TABLE care_link_messages (
  id INTEGER PRIMARY KEY,
  link_id INTEGER NOT NULL REFERENCES care_links(id),
  patient_id INTEGER NOT NULL REFERENCES users(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,                        -- [ЧПД]
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
) STRICT;
CREATE INDEX idx_care_link_msg ON care_link_messages(link_id, id);
