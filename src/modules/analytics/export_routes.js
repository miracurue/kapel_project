'use strict';

/**
 * Выгрузка аналитики в CSV (вкладка «Аналитика» психиатра, психолога и администратора).
 *   GET /api/v1/analytics/export?section=diary|insights|all&dx=&from=&to=
 * Источники те же, что у экрана: дневник когорты (cohort.js) и отчёт по диагнозу (insights), то есть
 * представления без идентификаторов и соединение «только чтение»; малые группы скрыты как на экране.
 * Роли и право analytics.export задаёт контракт (docs/openapi.yaml, src/access). В журнал пишутся
 * раздел, период и число строк, без содержимого.
 */

const { diaryReport } = require('./cohort');
const { shiftDay } = require('./facts');
const { loadInsights } = require('../insights/data');
const { buildReport } = require('../insights/report');
const { diaryRows, insightsRows, buildCsv, fileName } = require('./export_csv');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN_DAYS = 730;
const SECTIONS = ['diary', 'insights', 'all'];
const DEFAULT_DAYS = { diary: 90, insights: 180, all: 180 };

function install(app, { db, P, config, now, activeSetting }) {
  const today = () => P.iso(now(config)).slice(0, 10);
  const minGroup = () => Math.max(10, Number(activeSetting('analytics.min_group').value) || 10);
  const diagnoses = () => db.prepare('SELECT code,label,grp FROM diagnosis_catalog ORDER BY sort').all();

  const valid = (s) => DAY_RE.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  function period(req, section) {
    const to = req.query.to === undefined ? today() : String(req.query.to);
    const from = req.query.from === undefined ? shiftDay(to, 1 - DEFAULT_DAYS[section]) : String(req.query.from);
    if (!valid(from) || !valid(to)) return null;
    const span = (Date.parse(to) - Date.parse(from)) / 86400000;
    return span < 0 || span > MAX_SPAN_DAYS ? null : { from, to };
  }
  function dxParam(req) {
    const dx = String(req.query.dx || 'all');
    if (dx === 'all' || dx === 'unknown') return dx;
    return diagnoses().some((d) => d.code === dx) ? dx : null;
  }

  app.get('/api/v1/analytics/export', (req, res) => {
    const role = req.user.role;
    const isAdmin = role === 'admin';
    if (!isAdmin && role !== 'psychiatrist' && role !== 'psychologist') return P.sendError(req, res, 403, 'E-ACCESS');
    const section = String(req.query.section ?? 'all');
    if (!SECTIONS.includes(section)) return P.sendError(req, res, 422, 'E-VALIDATION');
    const range = period(req, section);
    const dx = dxParam(req);
    if (!range || !dx) return P.sendError(req, res, 422, 'E-VALIDATION');

    const stamp = P.iso(now(config));
    const min = minGroup();
    const rows = [];
    let formulaVersion = 'diary_cohort_v2_inclusive_days';
    if (section !== 'insights') {
      const diary = diaryReport(db, {
        scope: isAdmin ? 'program' : 'clinician',
        clinicianId: req.user.id,
        ...range,
        minGroup: min,
      });
      rows.push(...diaryRows(diary));
    }
    if (section !== 'diary') {
      const data = loadInsights(db, {
        scope: isAdmin ? 'program' : 'current',
        clinicianId: req.user.id,
        ...range,
        now: stamp,
      });
      const report = buildReport(data, {
        audience: role,
        dx,
        diagnoses: diagnoses(),
        ...(isAdmin ? { minGroup: min } : {}),
        ...range,
      });
      rows.push(...insightsRows(report));
      formulaVersion = section === 'all' ? `${formulaVersion}; ${report.formula_version}` : report.formula_version;
    }

    const csv = buildCsv({
      scope: isAdmin ? 'program' : 'clinician',
      period: range,
      minGroup: min,
      formulaVersion,
      rows,
    });
    const filter = { section, dx, ...range };
    db.prepare(
      'INSERT INTO action_log(actor_id,actor_role,action,target_type,new_safe_json,created_at) VALUES (?,?,?,?,?,?)',
    ).run(req.user.id, role, 'analytics.export', 'analytics', JSON.stringify({ ...filter, rows: rows.length }), stamp);
    if (isAdmin)
      db.prepare(
        "INSERT INTO export_log(actor_id,kind,filter_json,row_count,recipient_class,created_at) VALUES (?,'program',?,?,'sponsor_aggregate',?)",
      ).run(req.user.id, JSON.stringify({ kind: 'analytics', ...filter }), rows.length, stamp);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(today())}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(csv);
  });
}

module.exports = { install };
