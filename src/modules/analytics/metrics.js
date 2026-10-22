'use strict';

// Реестр метрик: что лежит в analytics_facts и как это читать. Без свободного текста.
// Новый источник (тесты, приём лекарств, НЯ) добавляет сюда метрики и пишет факты — читатели менять не нужно.

const METRICS = {
  diary_entry: {
    label: 'День с записью',
    source: 'diary',
    unit: 'день',
    definition: 'За день есть хотя бы одна запись дневника.',
  },
  mood: {
    label: 'Настроение',
    source: 'diary',
    unit: 'балл 1–5',
    definition: 'Настроение по шкале 1–5 (1 — плохо, 5 — отлично); если записей за день несколько, берётся последняя.',
  },
  sleep_score: {
    label: 'Сон',
    source: 'diary',
    unit: 'балл 0–2',
    definition: 'Сон: 0 — плохо, 1 — нормально, 2 — хорошо.',
  },
  anxiety_score: {
    label: 'Тревога',
    source: 'diary',
    unit: 'балл 0–2',
    definition: 'Тревога: 0 — нет, 1 — немного, 2 — сильная.',
  },
  sleep_hours: {
    label: 'Продолжительность сна',
    source: 'mood_entries',
    unit: 'hour',
    definition: 'Часы сна, отдельно от субъективного качества сна; пропуски не равны нулю.',
  },
  test_score: {
    label: 'Результат теста',
    source: 'online_results/offline_results',
    unit: 'score',
    definition:
      'Каждое действительное прохождение; группировать только одинаковые instrument/version/mode. Неизвестная offline-версия не приравнивается к online.',
  },
  test_completed: {
    label: 'Завершённый тест',
    source: 'online_results/offline_results',
    unit: 'completion',
    definition: 'Факт завершения, без баллов и клинического толкования для пациента.',
  },
  medication_status: {
    label: 'Отметка приёма',
    source: 'med_log',
    unit: 'mark',
    definition:
      'Фактически внесённая отметка taken/skipped/later; назначение не означает приём. Отсутствие отметки неизвестно.',
  },
  adverse_event: {
    label: 'Сообщение о НЯ',
    source: 'adverse_events',
    unit: 'report',
    definition: 'Отправленное неотменённое сообщение; не подтверждение причинной связи с лекарством.',
  },
  visit: {
    label: 'Визит',
    source: 'visits',
    unit: 'visit',
    definition: 'Отдельные scheduled/done/no_show; назначенный визит не означает состоявшийся.',
  },
  habit_value: {
    label: 'Отметка привычки',
    source: 'diary_habit_values',
    unit: 'definition_version',
    definition:
      'Отдельное значение с версией определения и единицей. Личные привычки не сопоставляются между пациентами по имени. Нечисловое значение не преобразуется в ноль.',
  },
  note_present: {
    label: 'Есть заметка',
    source: 'diary',
    unit: 'да',
    definition: 'К записи есть текстовая заметка. Сам текст в аналитику не попадает.',
  },
};

// Аудитории: кто и что может читать. patient и clinician читают факты конкретного пациента по праву доступа,
// cohort и program — только агрегаты из представлений без идентификаторов, с подавлением малых групп.
const AUDIENCES = ['patient', 'clinician', 'cohort', 'program'];

for (const metric of Object.values(METRICS)) {
  metric.definition_version = '1';
  metric.missing_policy = 'unknown_not_zero';
}

module.exports = { METRICS, AUDIENCES };
