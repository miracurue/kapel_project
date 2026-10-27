'use strict';

/**
 * Объединение наборов инструментов ИИ специалиста (этап 6 плана агента): данные закреплённого пациента
 * (patientTools) и знания (clinrecTools) в одном запросе. Каждый набор приносит свои определения, карточку
 * и слой правил; шлюз подключает все слои правил (tools.rulesKey — массив). Имена инструментов не пересекаются.
 */

const { stripUnknown } = require('./sources');

function combineTools(...sets) {
  const parts = sets.filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  const owner = new Map();
  for (const p of parts) for (const d of p.definitions) owner.set(d.name, p);
  const rules = parts.flatMap((p) => (Array.isArray(p.rulesKey) ? p.rulesKey : [p.rulesKey || 'tools.common']));
  return {
    definitions: parts.flatMap((p) => p.definitions),
    execute: (name, args) => {
      const p = owner.get(name);
      if (!p) throw new Error(`unknown tool ${name}`);
      return p.execute(name, args);
    },
    card: parts
      .map((p) => p.card)
      .filter(Boolean)
      .join('\n'),
    maxCalls: Math.min(
      8,
      parts.reduce((a, p) => a + (p.maxCalls || 4), 0),
    ),
    rulesKey: [...new Set(rules)],
    cited: (text) => parts.flatMap((p) => (p.cited ? p.cited(text) : [])),
    // Номера источников, полученные моделью, со всех наборов: по ним из ответа убираются выдуманные метки [n].
    shownNumbers: () => parts.flatMap((p) => (p.shownNumbers ? p.shownNumbers() : [])),
    sanitize: (text) =>
      parts.some((p) => p.shownNumbers)
        ? stripUnknown(text, new Set(parts.flatMap((p) => (p.shownNumbers ? p.shownNumbers() : []))))
        : text,
    // Выдержки инструкций, найденные сервером до ответа, получают номера в общей нумерации.
    registerDrug: (r) => {
      const p = parts.find((x) => x.registerDrug);
      return p ? p.registerDrug(r) : null;
    },
  };
}

module.exports = { combineTools };
