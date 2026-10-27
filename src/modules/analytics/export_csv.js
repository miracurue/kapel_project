'use strict';

/**
 * CSV для Excel на русском: UTF-8 с BOM, разделитель «;», десятичная запятая, строки через CRLF.
 * Ячейки, начинающиеся с = + - @ табуляции или возврата каретки, экранируются апострофом (CSV-инъекция).
 * Строки отчётов собираются здесь из уже готовых отчётов (cohort.js, insights/report.js): скрытые значения
 * остаются пустыми, как на экране; идентификаторов в отчётах нет.
 */

const { t } = require('../../i18n');

const BOM = '﻿';
const DELIMITER = ';';
const FORMULA_START = /^[=+\-@\t\r\n]/;

const fill = (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
const tt = (key, vars) => fill(t(key), vars);

/** Одна ячейка: число — с десятичной запятой, текст — с защитой от формул и кавычками по необходимости. */
function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).replace('.', ',') : '';
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[;"\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Файл целиком: BOM и строки через CRLF. */
function toCsv(rows) {
  return `${BOM}${rows.map((row) => row.map(cell).join(DELIMITER)).join('\r\n')}\r\n`;
}

const COLUMNS = ['section', 'metric', 'value', 'unit', 'people', 'note'].map((k) =>
  tt(`msg.analytics.export.col.${k}`),
);

/** Дневник когорты (diaryReport): строки, полосы настроения, недели. */
function diaryRows(report) {
  const hidden = tt('msg.analytics.export.note.hidden', { min: report.min_group });
  const section = tt('msg.analytics.export.section.diary');
  const rows = report.rows.map((r) => [
    section,
    r.label,
    r.suppressed ? null : r.value,
    r.unit,
    r.suppressed ? null : r.n_patients,
    r.suppressed ? hidden : '',
  ]);
  const people = tt('msg.analytics.export.unit.people');
  for (const b of report.mood_bands || [])
    rows.push([
      tt('msg.analytics.export.section.diary_bands'),
      b.label,
      b.suppressed ? null : b.n_patients,
      people,
      b.suppressed ? null : b.n_patients,
      b.suppressed ? hidden : '',
    ]);
  for (const w of report.weekly || [])
    rows.push([
      tt('msg.analytics.export.section.diary_weeks'),
      tt('msg.analytics.export.week', { week: w.week }),
      w.suppressed ? null : w.mood_mean,
      tt('msg.analytics.export.unit.mood'),
      w.suppressed ? null : w.n_patients,
      w.suppressed ? hidden : '',
    ]);
  return rows;
}

/** Отчёт по диагнозу (buildReport): только показанные значения, скрытые ячейки пусты. */
function insightsRows(report) {
  const rows = [];
  const unit = (k) => tt(`msg.analytics.export.unit.${k}`);
  const sections = Object.fromEntries(report.sections.map((s) => [s.key, s]));
  const add = (key, name, value, u = '', note = '') => {
    const empty = value === null || value === undefined;
    rows.push([
      sections[key].title,
      name,
      empty ? null : value,
      u,
      null,
      empty ? tt('msg.analytics.export.note.no_data') : note,
    ]);
  };
  const each = (key, list, row, valueField, u) => {
    for (const item of list || []) add(key, row(item), item[valueField], u);
  };
  const row = (key, vars) => (item) => tt(`msg.analytics.export.row.${key}`, vars(item));
  const label = (item) => ({ label: item.label ?? item.title });

  if (sections.who) {
    add('who', tt('msg.analytics.export.row.patients'), sections.who.n_patients, unit('people'));
    each(
      'who',
      sections.who.dynamics,
      row('started', (d) => ({ month: d.month })),
      'n_patients',
      unit('people'),
    );
  }
  if (sections.clinicians) {
    const s = sections.clinicians;
    each('clinicians', s.specialties, row('specialty', label), 'n_patients', unit('patients'));
    each('clinicians', s.org_kinds, row('org_kind', label), 'n_patients', unit('patients'));
    each('clinicians', s.regions, row('region', label), 'n_patients', unit('patients'));
    each('clinicians', s.organizations, row('organization', label), 'n_patients', unit('patients'));
  }
  if (sections.doctors) {
    each('doctors', sections.doctors.journals, row('journal', label), 'n_doctors', unit('doctors'));
    each('doctors', sections.doctors.conferences, row('conference', label), 'n_doctors', unit('doctors'));
  }
  if (sections.prescribed) {
    each('prescribed', sections.prescribed.by_inn, row('drug', label), 'n_patients', unit('patients'));
    each('prescribed', sections.prescribed.duration, row('duration', label), 'n', unit('orders'));
  }
  if (sections.reality) {
    for (const f of sections.reality.funnel || []) add('reality', f.label, f.n_patients, unit('patients'));
    each('reality', sections.reality.adherence, row('adherence', label), 'n_patients', unit('patients'));
  }
  if (sections.outcomes)
    for (const m of sections.outcomes.measures || []) {
      add(
        'outcomes',
        tt('msg.analytics.export.row.measure_n', { label: m.label }),
        m.n_patients,
        unit('people'),
        m.cut_text,
      );
      add(
        'outcomes',
        tt('msg.analytics.export.row.measure_improved', { label: m.label }),
        m.share_improved,
        unit('percent'),
      );
      add('outcomes', tt('msg.analytics.export.row.measure_median', { label: m.label }), m.median_days, unit('days'));
    }
  if (sections.cost) {
    add('cost', tt('msg.analytics.export.row.reporters'), sections.cost.n_reporters, unit('people'));
    each('cost', sections.cost.complaints, row('complaint', label), 'n_patients', unit('patients'));
  }
  return rows;
}

/** Готовый файл: две строки-заголовка с периодом и оговоркой, шапка колонок, данные. */
function buildCsv({ scope, period, minGroup, formulaVersion, rows }) {
  const title = tt('msg.analytics.export.head.title', {
    scope: tt(`msg.analytics.export.scope.${scope}`),
    from: period.from,
    to: period.to,
  });
  const note = tt('msg.analytics.export.head.note', { version: formulaVersion, min: minGroup });
  return toCsv([[`# ${title}`], [`# ${note}`], COLUMNS, ...rows]);
}

const fileName = (day) => `clinical-compass-analytics-${day}.csv`;

module.exports = { cell, toCsv, diaryRows, insightsRows, buildCsv, fileName };
