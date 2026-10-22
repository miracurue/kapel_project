'use strict';

// Предпросмотр методики для специалиста («Тесты» → карточка): назначение, инструкция, вопросы,
// шкалы с составом и толкованием, диапазоны. Читает опубликованную версию из БД, толкования — из модулей норм.
const scl = require('./scl90r_norms');
const itt = require('./itt_norms');

const INTERPRETATIONS = { scl90r: scl.INTERPRETATIONS, itt_l: itt.INTERPRETATIONS, itt_s: itt.INTERPRETATIONS };

function preview(db, code) {
  const row = db
    .prepare(
      'SELECT v.schema_json,v.scoring_json,v.bands_json,v.version FROM instruments i JOIN instrument_versions v ON v.instrument_code=i.code AND v.version=i.current_version WHERE i.code=?',
    )
    .get(code);
  if (!row) return null;
  const schema = JSON.parse(row.schema_json || '{}');
  const scoring = JSON.parse(row.scoring_json || '{}');
  const questions = schema.questions || [];
  const meta = schema.meta || {};
  const titles = code === 'scl90r' ? {} : itt.SUBSCALE_TITLES;
  const scales = (scoring.scales || scoring.subscales || []).map((s) => ({
    code: s.code,
    title: s.title || titles[s.code] || s.code,
    items: s.items || [...(s.direct || []), ...(s.reverse || [])].sort((a, b) => a - b),
    direct: s.direct || null,
    reverse: s.reverse || null,
    offset: s.offset ?? null,
    interpretation: (INTERPRETATIONS[code] || {})[s.code] || null,
  }));
  return {
    version: row.version,
    mode: meta.mode || 'assignable',
    expected_question_count: meta.expected_question_count || questions.length,
    review_required: true,
    purpose: meta.purpose || null,
    instruction: meta.instruction || null,
    question_title: meta.question_title || null,
    note: meta.note || null,
    sources: meta.sources || [],
    question_count: questions.length,
    questions: questions.map((q, n) => ({ n: n + 1, text: q.text || '' })),
    options: ((questions[0] || {}).options || []).map((o) => ({ label: o.label, score: o.score })),
    scales,
    bands: JSON.parse(row.bands_json || '[]'),
    max_total: Number.isFinite(scoring.max) ? scoring.max : null,
  };
}

module.exports = { preview };
