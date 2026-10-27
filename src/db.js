'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.TDR_DB_PATH || path.join(DATA_DIR, 'tdr.sqlite3');
const db = new Database(DB_PATH, { timeout: 15000 });
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// удалённые строки (ПД, физическое удаление по запросу) затираются нулями, а не остаются в свободных страницах файла БД
db.pragma('secure_delete = ON');

// Схема базы целиком описана миграциями (migrations/, scripts/migrate.js). Раньше этот модуль
// при каждом старте сам создавал таблицы и колонки первой версии приложения; они перенесены
// в миграцию 0031_legacy_schema.js. Здесь остаётся только соединение для старых модулей.

module.exports = db;

// Реестр таблиц/полей, классифицированных как специальная категория
// персональных данных (152-ФЗ ст.10, данные о здоровье) и/или врачебная
// тайна (323-ФЗ ст.13). Используется для документации и как единая точка
// правды для access-логирования и для того, что НИКОГДА не должно попасть
// в научный экспорт в текстовом/построчном виде.
module.exports.SPECIAL_CATEGORY_TABLES = {
  online_results: { classification: 'special_category_health_data', freeTextFields: [] },
  offline_results: { classification: 'special_category_health_data', freeTextFields: ['notes'] },
  catalog_protocols: { classification: 'special_category_health_data', freeTextFields: ['protocol_json'] },
  crisis_escalations: { classification: 'special_category_health_data', freeTextFields: ['reasons_json'] },
  mood_entries: { classification: 'special_category_health_data', freeTextFields: ['note', 'triggers'] },
  assignment_drafts: { classification: 'special_category_health_data', freeTextFields: ['answers_json'] },
  patient_appeals: { classification: 'special_category_health_data', freeTextFields: ['message'] },
  chatbot_messages: { classification: 'special_category_health_data', freeTextFields: ['text'] },
  ai_threads: { classification: 'special_category_health_data', freeTextFields: ['title'] },
  ai_messages: { classification: 'special_category_health_data', freeTextFields: ['text', 'flags_json'] },
  ai_attachments: { classification: 'special_category_health_data', freeTextFields: ['name', 'text_extracted', 'note'] },
  patient_contact_requests: { classification: 'special_category_health_data', freeTextFields: ['text'] },
  instrument_assignments: { classification: 'linked_to_health_data', freeTextFields: [] },
  crisis_incident_log: { classification: 'special_category_health_data', freeTextFields: ['detail_json'] },
  comparison_pairs: { classification: 'special_category_health_data', freeTextFields: ['clinician_note'] },
  clinician_notes: { classification: 'special_category_health_data', freeTextFields: ['body', 'tags'] },
  treatment_items: { classification: 'special_category_health_data', freeTextFields: ['body'] },
  tool_import_drafts: { classification: 'special_category_health_data', freeTextFields: ['content'] },
  tool_templates: { classification: 'free_text_clinician_authored', freeTextFields: ['title', 'body'] },
  exam_sessions: { classification: 'special_category_health_data', freeTextFields: ['title', 'note'] },
  conclusions: { classification: 'special_category_health_data', freeTextFields: ['title'] },
  conclusion_versions: { classification: 'special_category_health_data', freeTextFields: ['title', 'sections_json', 'reason'] },
  med_items: { classification: 'special_category_health_data', freeTextFields: ['name', 'how_text'] },
  med_log: { classification: 'special_category_health_data', freeTextFields: [] },
  care_messages: { classification: 'special_category_health_data', freeTextFields: ['body'] },
  previsit_forms: { classification: 'special_category_health_data', freeTextFields: ['answers_json'] },
  psychoed_progress: { classification: 'linked_to_health_data', freeTextFields: [] },
  psychoed_assignments: { classification: 'linked_to_health_data', freeTextFields: [] },
};
