'use strict';

// Блок результата SCL-90-R для специалиста: шкалы рядом с опубликованными нормами, критические пункты,
// пункты с оценкой >= 3 и динамика. Сравнение с нормой РФ — только арифметика со средним нормы
// (значение округляется до 2 знаков, как в источнике): выше / в пределах (равно) / ниже. Порогов и
// диагностических слов нет. Всё review-required.
const def = require('./scl90r');
const { GROUPS, NORMS, INTERPRETATIONS } = require('./scl90r_norms');

const round2 = (x) => (x === null || x === undefined ? null : Math.round(x * 100) / 100);
const compare = (value, mean) => {
  if (value === null || value === undefined || mean === null || mean === undefined) return null;
  const v = round2(value);
  return v > mean ? 'above' : v < mean ? 'below' : 'within';
};
const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch (_) {
    return fallback;
  }
};

function rowFor(code, title, value, extra) {
  const n = NORMS[code];
  return {
    code,
    title,
    value,
    value_rounded: round2(value),
    compare_ru: n ? compare(value, n.ru.mean) : null,
    norms: n ? Object.fromEntries(GROUPS.map((g) => [g.key, n[g.key]])) : null,
    interpretation: INTERPRETATIONS[code] || null,
    ...extra,
  };
}

// results — все результаты scl90r пациента, видимые специалисту, от новых к старым.
function buildView(result, results) {
  const sub = parseJson(result.subscales_json, null);
  if (!sub || !sub.scales) return null;
  const answers = parseJson(result.answers_json, {});
  const itemRow = (n) => ({ item: n, text: def.items[n - 1], value: Number(answers[`q${n}`]) });
  const rows = def.scales.map((s) => rowFor(s.code, s.title, sub.scales[s.code].mean, { items_count: s.items.length }));
  rows.push(rowFor('GSI', 'GSI', sub.gsi), rowFor('PSI', 'PSI', sub.psi), rowFor('PDSI', 'PDSI', sub.pdsi));
  const history = results
    .filter((r) => r.id !== result.id && r.created_at <= result.created_at)
    .map((r) => {
      const s = parseJson(r.subscales_json, null);
      if (!s || !s.scales) return null;
      return {
        result_id: r.id,
        created_at: r.created_at,
        gsi: s.gsi,
        psi: s.psi,
        pdsi: s.pdsi,
        scales: Object.fromEntries(Object.entries(s.scales).map(([k, v]) => [k, v.mean])),
      };
    })
    .filter(Boolean)
    .slice(0, 5);
  return {
    result_id: result.id,
    created_at: result.created_at,
    instrument_version: result.instrument_version,
    groups: GROUPS,
    crisis_items: def.crisisItems.map(itemRow),
    rows,
    high_items: Array.from({ length: 90 }, (_x, i) => itemRow(i + 1)).filter((x) => x.value >= 3),
    history,
    key_deviation: def.meta.key_deviation.status,
    note_key: 'msg.scl90r.disclaimer',
  };
}

module.exports = { buildView, compare, round2 };
