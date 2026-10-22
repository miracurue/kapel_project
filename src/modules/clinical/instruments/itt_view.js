'use strict';

// Блок результата ИТТ для специалиста: применённая группа норм (и почему), общий показатель и пять субшкал
// со станайнами по обеим группам (переключение на клиенте без пересчёта на сервере), тексты интерпретации,
// сравнение СТ-Л и СТ-С, динамика. Станайны всегда считаются из сырых значений по таблицам itt_norms.js.
// Порог «высокие = 7–9» — допущение демо. Слов «норма/патология/диагноз» нет. Всё review-required.
const N = require('./itt_norms');
const { SCALES } = require('./itt');

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch (_) {
    return fallback;
  }
};
const stanines = (rows, value) => Object.fromEntries(N.GROUPS.map((g) => [g.key, N.stanineOf(rows(g.key), value)]));

function summary(result, sub) {
  return {
    result_id: result.id,
    instrument: result.instrument,
    scale: sub.scale,
    created_at: result.created_at,
    total: { raw: sub.total.raw, stanine: stanines((g) => N.TOTAL[g], sub.total.raw) },
    subscales: Object.fromEntries(
      SCALES.map((s) => [
        s.code,
        { raw: sub.subscales[s.code].raw, stanine: stanines((g) => N.SUBSCALES[g][s.code], sub.subscales[s.code].raw) },
      ]),
    ),
  };
}

// results — все результаты ИТТ (обе шкалы) пациента, видимые специалисту, от новых к старым.
function buildView(result, results) {
  const sub = parseJson(result.subscales_json, null);
  if (!sub || !sub.total || !sub.subscales) return null;
  const own = summary(result, sub);
  const rows = SCALES.map((s) => ({
    code: s.code,
    title: N.SUBSCALE_TITLES[s.code],
    items: s.items,
    raw: own.subscales[s.code].raw,
    max: N.SUBSCALE_MAX[s.code],
    stanine: own.subscales[s.code].stanine,
    interpretation: N.INTERPRETATIONS[s.code],
  }));
  const summaries = results
    .map((r) => {
      const s = parseJson(r.subscales_json, null);
      return s && s.total && s.subscales ? summary(r, s) : null;
    })
    .filter(Boolean);
  const pair = summaries.find((x) => x.scale !== sub.scale) || null;
  const history = summaries
    .filter((x) => x.result_id !== result.id && x.scale === sub.scale && x.created_at <= result.created_at)
    .slice(0, 5);
  return {
    result_id: result.id,
    instrument: result.instrument,
    scale: sub.scale,
    created_at: result.created_at,
    instrument_version: result.instrument_version,
    groups: N.GROUPS,
    applied_group: sub.norm_group,
    applied_reason: sub.norm_group_reason,
    high_from: N.HIGH_FROM,
    total: { raw: own.total.raw, max: N.TOTAL_MAX, stanine: own.total.stanine },
    rows,
    pair,
    history,
    note_key: 'msg.itt.disclaimer',
  };
}

module.exports = { buildView };
