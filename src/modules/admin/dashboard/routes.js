'use strict';

/**
 *   GET /api/v1/admin/dashboard — обзор администратора: главы с выводами, плитками и графиками (service.js).
 * Только агрегаты: пациенты — участники программы, без идентификаторов, малые группы скрыты (analytics.min_group).
 */

const { build } = require('./service');
const { customerChapter } = require('./customer');
const { loadInsights } = require('../../insights/data');
const { buildReport } = require('../../insights/report');
const { narrate } = require('../../insights/story');
const { shiftDay } = require('../../analytics/facts');

const PERIODS = [30, 90, 180, 365];

function install(app, { db, P, config, now, activeSetting }) {
  const minGroup = () => Math.max(10, Number(activeSetting('analytics.min_group').value) || 10);

  app.get('/api/v1/admin/dashboard', (req, res) => {
    const days = req.query.days === undefined ? 90 : Number(req.query.days);
    if (!PERIODS.includes(days)) return P.sendError(req, res, 422, 'E-VALIDATION');
    const diagnoses = db.prepare('SELECT code,label,grp FROM diagnosis_catalog ORDER BY sort').all();
    const dx = String(req.query.dx || 'all');
    if (dx !== 'all' && dx !== 'unknown' && !diagnoses.some((d) => d.code === dx))
      return P.sendError(req, res, 422, 'E-VALIDATION');
    const stamp = P.iso(now(config));
    const to = stamp.slice(0, 10);
    const range = { from: shiftDay(to, -(days - 1)), to };
    // Глава для программы: тот же расчёт, что у вкладки «Аналитика» (малые группы там уже скрыты).
    let program = null;
    try {
      const report = narrate(
        buildReport(loadInsights(db, { scope: 'program', ...range, now: stamp }), {
          audience: 'admin',
          dx,
          minGroup: minGroup(),
          diagnoses,
          ...range,
        }),
      );
      program = customerChapter(report);
    } catch (e) {
      console.warn('admin dashboard program chapter', e.message);
    }
    return res.json(build(db, { ...range, minGroup: minGroup(), now: stamp, program }));
  });
}

module.exports = { install };
