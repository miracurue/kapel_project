'use strict';

/**
 * Схемы функций навыков ИИ (режим `function` в каталоге, src/ai/promptCatalog.js).
 *
 * Модель вернёт вызов функции только если её определение передано в запросе (GigaChat — `functions`,
 * OpenAI-совместимые — `tools`). Определения лежат здесь, в одном месте: шлюз подставляет их и при прямом вызове
 * навыка из кода (`gateway.run({ purpose: 'ae_extraction' })`), и при вызове через `use_skill`.
 * Имя функции = `tool.name` результата; поля = `tool.arguments`, их читает вызывающий код:
 *   report_adverse_event — src/ai/patientEndpoints.js (aeSuggestion);
 *   order_parse          — src/modules/plan/parse.js (validateModel);
 *   diagnostic_hints     — src/ai/workspace/hintsSchema.js (validate).
 * Формат и словари review-required; инструкцию навыка (что и как извлекать) задаёт prompts/skill/<имя>/v001.md.
 */

const refList = {
  type: 'array',
  maxItems: 10,
  description: 'Ссылки на данные из переданного контекста',
  items: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['result', 'diary_entry', 'plan_item', 'visit', 'adverse_event', 'patient_med', 'purchase', 'file', 'library_item'],
        description: 'Тип объекта',
      },
      id: { type: 'integer', description: 'Идентификатор объекта из контекста' },
    },
    required: ['type', 'id'],
  },
};
const strList = (description, maxItems) => ({ type: 'array', maxItems, description, items: { type: 'string' } });

const FUNCTIONS = {
  ae_extraction: {
    name: 'report_adverse_event',
    description:
      'Передать признаки возможной нежелательной реакции на лекарство, найденные в тексте. Вызывай только если признаки есть; это черновик для проверки человеком.',
    parameters: {
      type: 'object',
      properties: {
        symptoms: strList('Симптомы своими словами человека, коротко', 5),
        severity: { type: 'integer', enum: [1, 2, 3], description: 'Выраженность по тексту: 1 лёгкая, 2 заметная, 3 тяжёлая' },
        related: {
          type: 'string',
          enum: ['likely', 'possible', 'unlikely', 'unknown'],
          description: 'Связь с лекарством по словам человека; если не ясно — unknown',
        },
        med: { type: 'string', description: 'Название препарата из текста или «не знаю»' },
      },
      required: ['symptoms'],
    },
  },
  order_parse: {
    name: 'order_parse',
    description:
      'Передать разобранную формулировку назначения: препарат (МНН), дозу, единицу, время приёма, дату. Поля, которых нет в тексте, опусти.',
    parameters: {
      type: 'object',
      properties: {
        inn_name: { type: 'string', description: 'Международное непатентованное название препарата' },
        dose: { type: 'number', description: 'Разовая доза, число больше нуля' },
        unit: { type: 'string', enum: ['мг', 'мкг', 'мл'], description: 'Единица дозы' },
        times: {
          type: 'array',
          description: 'Время приёма',
          items: { type: 'string', enum: ['утро', 'день', 'вечер', 'на ночь'] },
        },
        date: { type: 'string', description: 'Дата в формате ГГГГ-ММ-ДД, не в прошлом' },
      },
    },
  },
  diagnostic_hints: {
    name: 'diagnostic_hints',
    description: 'Передать список диагностических гипотез для проверки врачом, каждую с основанием из данных пациента.',
    parameters: {
      type: 'object',
      properties: {
        hypotheses: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          description: 'Гипотезы для проверки врачом (не диагнозы)',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Гипотеза одним предложением с основанием из данных' },
              for: { ...refList, description: 'Данные «за»' },
              against: { ...refList, description: 'Данные «против»' },
              missing: strList('Чего не хватает для проверки', 20),
              somatic: strList('Соматические причины, которые стоит исключить', 20),
              questions: strList('Вопросы пациенту для уточнения', 20),
              sources: strList('Источники (клинические рекомендации и т.п.)', 10),
            },
            required: ['text'],
          },
        },
      },
      required: ['hypotheses'],
    },
  },
};

/** Определение функции навыка по его имени (`ae_extraction`) или ключу каталога (`skill.ae_extraction`). */
function functionOf(skill) {
  const name = String(skill || '').replace(/^skill\./, '');
  return FUNCTIONS[name] || null;
}

module.exports = { FUNCTIONS, functionOf };
