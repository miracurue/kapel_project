'use strict';

/**
 * Аналитика (W-52, F-71, F-74): когорты специалиста и общие цифры администратора.
 * Читает только представления без идентификаторов через соединение «только чтение» (cohort.js);
 * группы меньше analytics.min_group скрыты (S-22, PD-19). Доступ по роли — контрактный контроль доступа.
 */

const { diaryReport } = require('./cohort');
const { shiftDay } = require('./facts');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN_DAYS = 731;

function install(app, { db, P, config, now, activeSetting }) {
  const today = () => P.iso(now(config)).slice(0, 10);
  const minGroup = () => {
    const v = Number(activeSetting('analytics.min_group').value);
    return Number.isInteger(v) && v >= 10 ? v : 10;
  };
  function period(req) {
    const to = req.query.to === undefined ? today() : String(req.query.to);
    const from = req.query.from === undefined ? shiftDay(to, -89) : String(req.query.from);
    if (
      !DAY_RE.test(from) ||
      !DAY_RE.test(to) ||
      Number.isNaN(Date.parse(from)) ||
      Number.isNaN(Date.parse(to)) ||
      new Date(from).toISOString().slice(0, 10) !== from ||
      new Date(to).toISOString().slice(0, 10) !== to
    )
      return null;
    const span = (Date.parse(to) - Date.parse(from)) / 86400000;
    return span < 0 || span > MAX_SPAN_DAYS ? null : { from, to };
  }

  // Срезы, источник которых ещё не пишет факты в общее место: честный пустой ответ, а не выдуманные цифры.
  const pending = (by, min) => ({ by, min_group: min, suppressed: true, rows: [], note: 'not_available' });

  app.get('/api/v1/analytics/my-patients', (req, res) => {
    const range = period(req);
    if (!range) return P.sendError(req, res, 422, 'E-VALIDATION');
    const by = String(req.query.by || 'diary');
    const min = minGroup();
    if (by !== 'diary') return res.json(pending(by, min));
    return res.json({
      by,
      ...diaryReport(db, { scope: 'clinician', clinicianId: req.user.id, ...range, minGroup: min }),
    });
  });

  // Администратор: цифры по участникам программы (согласие 'program'). Другие срезы метрик добавляет W-47.
  app.get('/api/v1/admin/metrics', (req, res, next) => {
    if (String(req.query.by || '') !== 'diary') return next();
    const range = period(req);
    if (!range) return P.sendError(req, res, 422, 'E-VALIDATION');
    return res.json({ by: 'diary', ...diaryReport(db, { scope: 'program', ...range, minGroup: minGroup() }) });
  });
}

module.exports = { install };
