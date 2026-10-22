'use strict';

// Загрузка строк для отчёта. Как и cohort.js: только представления insights_* и соединение «только чтение»;
// к таблицам пациентов и к patient_id этот файл не обращается (проверяет tests/regression/insights.test.js).

const { readOnly } = require('../analytics/cohort');

/**
 * @param {object} p {scope:'program'|'current', clinicianId?, from, to, now (ISO)}
 */
function loadInsights(mainDb, p) {
  const ro = readOnly(mainDb);
  const own = p.scope === 'current';
  const members = ro
    .prepare(
      `SELECT DISTINCT subject_code FROM insights_members WHERE scope = ? AND (? = 'program' OR clinician_id = ?)`,
    )
    .all(p.scope, p.scope, p.clinicianId || null);
  const inScope = `subject_code IN (SELECT subject_code FROM insights_members WHERE scope = @scope AND (@scope = 'program' OR clinician_id = @clinician))`;
  const args = { scope: p.scope, clinician: p.clinicianId || null };
  const rows = (view, extra = '') => ro.prepare(`SELECT * FROM ${view} WHERE ${inScope}${extra}`).all(args);

  const data = {
    members,
    patients: rows('insights_patients'),
    links: own ? [] : rows('insights_patient_clinicians'),
    interests: own ? [] : ro.prepare('SELECT * FROM insights_clinician_interests').all(),
    plan: rows('insights_plan_items'),
    purchases: rows('insights_purchases'),
    marks: rows('insights_med_marks'),
    tests: rows('insights_tests'),
    mood: rows('insights_mood'),
    // Врач видит сообщения о побочных эффектах только своего получателя и после времени показа (как в карточке пациента).
    adverse: own
      ? ro
          .prepare(
            `SELECT * FROM insights_adverse WHERE ${inScope} AND clinician_id = @clinician AND (visible_from IS NULL OR visible_from <= @now)`,
          )
          .all({ ...args, now: p.now })
      : rows('insights_adverse'),
  };
  return data;
}

module.exports = { loadInsights };
