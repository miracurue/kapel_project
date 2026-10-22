'use strict';

/**
 * Данные для вкладки «Лекарства» пациента (раскладка «список — детали»), вне замороженного /api/v1:
 *  GET /app/api/med-articles?inn=…  — статьи журнала по препарату (тег «препарат:<МНН>») и общие по теме;
 *  GET /app/api/meds/history        — прежние назначения: закончились или заменены в действующем плане.
 * Только пациент; статьи общие и данных пациента не содержат, история — только свои назначения.
 */

const { articlesForInn } = require('./authoring');

function install(app, { db, P, nowIso }) {
  const guard = (req, res) => {
    if (!req.user) {
      P.sendError(req, res, 401, 'E-SESSION-EXPIRED');
      return null;
    }
    if (req.user.role !== 'patient') {
      P.sendError(req, res, 403, 'E-ACCESS');
      return null;
    }
    return req.user;
  };

  app.get('/app/api/med-articles', (req, res) => {
    if (!guard(req, res)) return undefined;
    const inn = String(req.query.inn || '')
      .trim()
      .slice(0, 80);
    if (!inn)
      return P.sendError(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'inn', key: 'err.e-validation' }] });
    return res.json(articlesForInn(db, inn));
  });

  app.get('/app/api/meds/history', (req, res) => {
    const user = guard(req, res);
    if (!user) return undefined;
    const now = nowIso();
    const today = now.slice(0, 10);
    // Последняя видимая версия каждого пункта плана; «прежние» — не действующие или с прошедшей датой окончания.
    const rows = db
      .prepare(
        `SELECT pi.item_key, pi.status, pi.dose_value dose, pi.dose_unit unit, pi.start_date, pi.end_date, i.name inn_name
         FROM plan_items pi JOIN plan_versions pv ON pv.id=pi.plan_version_id JOIN inn i ON i.id=pi.inn_id
         WHERE pv.patient_id=? AND pv.status='published' AND (pv.visible_from IS NULL OR pv.visible_from<=?)
           AND pv.version=(SELECT max(v2.version) FROM plan_versions v2 JOIN plan_items p2 ON p2.plan_version_id=v2.id
                           WHERE v2.patient_id=pv.patient_id AND v2.status='published' AND (v2.visible_from IS NULL OR v2.visible_from<=?) AND p2.item_key=pi.item_key)
         ORDER BY COALESCE(pi.end_date, pi.start_date) DESC, pi.id DESC`,
      )
      .all(user.id, now, now)
      .filter((r) => r.status !== 'active' || (r.end_date && r.end_date < today));
    return res.json({
      items: rows.map((r) => ({
        item_key: r.item_key,
        inn_name: r.inn_name,
        dose: r.dose,
        unit: r.unit,
        start_date: r.start_date || null,
        end_date: r.end_date || null,
      })),
    });
  });
}

module.exports = { install };
