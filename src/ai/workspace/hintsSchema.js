'use strict';

/**
 * Схема ответа модели для диагностических гипотез (F-34, W-35, назначение
 * diagnostic_hints через шлюз F-26). Ответ модели — черновик «на экспертной
 * проверке»: в карточку пациента ничего не пишется, ссылки на объекты вне
 * прикреплённого контекста вырезаются. Формат и словари — review-required.
 */

const REF_TYPES = new Set([
  'result',
  'diary_entry',
  'plan_item',
  'visit',
  'adverse_event',
  'patient_med',
  'purchase',
  'file',
  'library_item',
]);

function isStr(v, max) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function isRefArray(v) {
  return (
    Array.isArray(v) &&
    v.length <= 10 &&
    v.every((r) => r && typeof r === 'object' && REF_TYPES.has(r.type) && Number.isInteger(r.id) && r.id > 0)
  );
}

function isStrArray(v, max, len) {
  return Array.isArray(v) && v.length <= max && v.every((x) => isStr(x, len));
}

/**
 * Проверка схемы аргументов tool-call diagnostic_hints.
 * @returns {{ ok: boolean, hypotheses?: Array<object> }}
 */
function validate(args) {
  if (!args || typeof args !== 'object' || !Array.isArray(args.hypotheses) || !args.hypotheses.length || args.hypotheses.length > 8)
    return { ok: false };
  for (const h of args.hypotheses) {
    if (!h || typeof h !== 'object') return { ok: false };
    if (!isStr(h.text, 600)) return { ok: false };
    if (h.for !== undefined && !isRefArray(h.for)) return { ok: false };
    if (h.against !== undefined && !isRefArray(h.against)) return { ok: false };
    for (const key of ['missing', 'somatic', 'questions']) {
      if (h[key] !== undefined && !isStrArray(h[key], 20, 300)) return { ok: false };
    }
    if (h.sources !== undefined && !isStrArray(h.sources, 10, 300)) return { ok: false };
  }
  return { ok: true, hypotheses: args.hypotheses };
}

/** Ссылки на объекты вне прикреплённого контекста вырезаются (T-136). */
function filterOutsideRefs(hypotheses, attachedRefs) {
  const known = new Set(attachedRefs.map((r) => `${r.type}:${r.id}`));
  const cut = (list) => (Array.isArray(list) ? list.filter((r) => known.has(`${r.type}:${r.id}`)) : list);
  return hypotheses.map((h) => ({ ...h, for: cut(h.for), against: cut(h.against) }));
}

module.exports = { REF_TYPES, validate, filterOutsideRefs };
