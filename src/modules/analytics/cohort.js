'use strict';

// Когорты: только представления без идентификаторов (analytics_cohort_*, analytics_program_*) и
// отдельное соединение «только чтение» (BUILD_RULES §4). К таблицам и patient_id этот файл не обращается —
// это проверяет tests/regression/analytics_layers.test.js.

const Database = require('better-sqlite3');
const { METRICS } = require('./metrics');
const { suppressCells } = require('./interpret');

const readers = new Map(); // по файлу базы: в работе он один, в тестах их несколько
function readOnly(mainDb) {
  let ro = readers.get(mainDb.name);
  if (!ro || !ro.open) {
    ro = new Database(mainDb.name, { readonly: true, fileMustExist: true });
    readers.set(mainDb.name, ro);
  }
  return ro;
}

const SCOPES = {
  clinician: {
    facts: 'analytics_cohort_facts',
    members: 'analytics_cohort_members',
    filter: 'clinician_id = ?',
    label: 'Ваши пациенты',
    basis: 'закреплённые за вами пациенты',
  },
  program: {
    facts: 'analytics_program_facts',
    members: 'analytics_program_members',
    filter: '1 = 1',
    label: 'Согласившиеся на обезличенную аналитику',
    basis: 'пациенты с действующим согласием на обезличенные данные для исследований и улучшения сервиса',
  },
};

const pct = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : null);
const mean = (list) => (list.length ? Math.round((list.reduce((s, x) => s + x, 0) / list.length) * 100) / 100 : null);

/**
 * @param {object} p {scope:'clinician'|'program', clinicianId?, from, to, minGroup}
 * @returns отчёт: строки с определением, знаменателем и датой обновления; малые группы скрыты.
 */
function diaryReport(mainDb, p) {
  const scope = SCOPES[p.scope];
  const ro = readOnly(mainDb);
  const args = scope.filter === '1 = 1' ? [] : [p.clinicianId];
  const members = ro
    .prepare(`SELECT COUNT(DISTINCT subject_code) AS n FROM ${scope.members} WHERE ${scope.filter}`)
    .get(...args).n;
  const facts = ro
    .prepare(
      `SELECT subject_code, day, week, metric, value, computed_at FROM ${scope.facts} WHERE ${scope.filter} AND day BETWEEN ? AND ?`,
    )
    .all(...args, p.from, p.to);
  const updatedAt = facts.reduce((m, f) => (f.computed_at > m ? f.computed_at : m), '') || null;
  const perSubject = (metric) => {
    const map = new Map();
    for (const f of facts)
      if (f.metric === metric)
        (map.get(f.subject_code) || map.set(f.subject_code, []).get(f.subject_code)).push(f.value);
    return map;
  };
  const entry = perSubject('diary_entry');
  const mood = perSubject('mood');
  const anxiety = perSubject('anxiety_score');
  const sleep = perSubject('sleep_score');
  const weeks = Math.max(1, (Date.parse(p.to) - Date.parse(p.from) + 86400000) / (7 * 86400000));
  const tooSmall = members < p.minGroup;
  const make = (key, label, definition, denominator, n, value, unit) => {
    const hide = tooSmall || n < p.minGroup;
    return {
      key,
      label,
      definition,
      denominator: hide ? null : denominator,
      n_patients: hide ? null : n,
      value: hide ? null : value,
      unit,
      suppressed: hide,
      updated_at: updatedAt,
    };
  };
  const meansOf = (map) => [...map.values()].map((v) => v.reduce((s, x) => s + x, 0) / v.length);
  const flat = (map) => [...map.values()].flat();
  const rows = [
    make(
      'diary_active_share',
      'Ведут дневник',
      `Доля пациентов, у которых за период есть хотя бы один день с записью. Основа: ${scope.basis}.`,
      members,
      entry.size,
      pct(entry.size, members),
      '%',
    ),
    make(
      'diary_days_per_week',
      'Дней с записью в неделю',
      'Среднее число дней с записью в неделю у тех, кто вёл дневник в этот период.',
      entry.size,
      entry.size,
      entry.size ? mean([...entry.values()].map((v) => v.length / weeks)) : null,
      'дн./нед.',
    ),
    make(
      'mood_mean',
      METRICS.mood.label,
      `Среднее настроение по пациентам (у каждого свой средний балл, все пациенты равны). ${METRICS.mood.definition}`,
      mood.size,
      mood.size,
      mean(meansOf(mood)),
      'из 5',
    ),
    make(
      'anxiety_strong_share',
      'Дни с сильной тревогой',
      'Доля дней с сильной тревогой среди дней, где тревога отмечена.',
      anxiety.size,
      anxiety.size,
      pct(flat(anxiety).filter((v) => v === 2).length, flat(anxiety).length),
      '%',
    ),
    make(
      'sleep_good_share',
      'Дни с хорошим сном',
      'Доля дней с хорошим сном среди дней, где сон отмечен.',
      sleep.size,
      sleep.size,
      pct(flat(sleep).filter((v) => v === 2).length, flat(sleep).length),
      '%',
    ),
  ];
  const observationCounts = {
    diary_active_share: [entry.size, members],
    diary_days_per_week: [flat(entry).length, entry.size * weeks],
    mood_mean: [meansOf(mood).reduce((sum, value) => sum + value, 0), mood.size],
    anxiety_strong_share: [flat(anxiety).filter((value) => value === 2).length, flat(anxiety).length],
    sleep_good_share: [flat(sleep).filter((value) => value === 2).length, flat(sleep).length],
  };
  for (const row of rows) {
    row.formula_version = 'diary_cohort_v2_inclusive_days';
    row.numerator = row.suppressed ? null : observationCounts[row.key][0];
    row.observation_denominator = row.suppressed ? null : observationCounts[row.key][1];
    row.missing_policy = 'absent_measurements_are_unknown_not_zero';
  }
  // Полосы настроения: пациенты по среднему баллу. Ячейки дают итог, поэтому подавляем с дополнением.
  const band = (v) => (v < 2.5 ? 'low' : v <= 3.5 ? 'mid' : 'high');
  const counts = { low: 0, mid: 0, high: 0 };
  for (const v of meansOf(mood)) counts[band(v)] += 1;
  const bandLabels = { low: 'Низкое (до 2,5)', mid: 'Среднее (2,5–3,5)', high: 'Хорошее (выше 3,5)' };
  const bands = suppressCells(
    Object.keys(counts).map((key) => ({ key, n: counts[key] })),
    p.minGroup,
  ).map((c) => ({
    key: c.key,
    label: bandLabels[c.key],
    n_patients: tooSmall || c.suppressed ? null : c.n,
    suppressed: tooSmall || c.suppressed,
  }));
  // По неделям: у каждой недели свои пациенты, ячейки не складываются в итог, поэтому вычесть нечего.
  const weekly = [...new Set(facts.filter((f) => f.metric === 'diary_entry').map((f) => f.week))].sort().map((week) => {
    const inWeek = facts.filter((f) => f.week === week);
    const active = new Set(inWeek.filter((f) => f.metric === 'diary_entry').map((f) => f.subject_code)).size;
    const bySubject = new Map();
    for (const f of inWeek)
      if (f.metric === 'mood')
        (bySubject.get(f.subject_code) || bySubject.set(f.subject_code, []).get(f.subject_code)).push(f.value);
    const hide = tooSmall || active < p.minGroup || bySubject.size < p.minGroup;
    return {
      week,
      n_patients: hide ? null : active,
      mood_mean: hide ? null : mean(meansOf(bySubject)),
      suppressed: hide,
    };
  });
  // Уровень 1 (служебные счётчики) для администратора: по всем пациентам, без согласия; малые числа скрыты.
  let service = null;
  if (p.scope === 'program') {
    const total = ro.prepare('SELECT COUNT(*) AS n FROM analytics_service_members').get().n;
    const writers = ro
      .prepare(
        "SELECT COUNT(DISTINCT subject_code) AS n FROM analytics_service_facts WHERE metric = 'diary_entry' AND day BETWEEN ? AND ?",
      )
      .get(p.from, p.to).n;
    service = {
      level: 1,
      patients: total < p.minGroup ? null : total,
      diary_writers: total < p.minGroup || writers < p.minGroup ? null : writers,
    };
  }
  return {
    scope: p.scope,
    scope_label: scope.label,
    service,
    period: { from: p.from, to: p.to },
    min_group: p.minGroup,
    members_suppressed: tooSmall,
    suppressed: rows.every((r) => r.suppressed),
    rows,
    mood_bands: bands,
    weekly,
    updated_at: updatedAt,
  };
}

module.exports = { diaryReport, readOnly };
