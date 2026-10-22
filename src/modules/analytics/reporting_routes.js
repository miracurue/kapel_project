'use strict';

const { patientReport, cohortReport, productReport } = require('./reporting');
const { shiftDay } = require('./facts');

function install(app, { db, P, config, now, activeSetting, baseConsentGiven, auditPatient }) {
  function range(req) {
    const to = String(req.query.to || P.iso(now(config)).slice(0, 10));
    const valid = (s) =>
      /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
    if (!valid(to)) return null;
    const from = String(req.query.from || shiftDay(to, -89));
    if (!valid(from)) return null;
    const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
    return days >= 1 && days <= 731 ? { from, to } : null;
  }
  const minGroup = () => Math.max(10, Number(activeSetting('analytics.min_group').value) || 10);
  app.get('/api/v1/me/analytics', (req, res) => {
    const period = range(req);
    if (!period) return P.sendError(req, res, 422, 'E-VALIDATION');
    if (!baseConsentGiven(req.user.id)) return P.sendError(req, res, 403, 'E-ACCESS');
    return res.json(patientReport(db, req.user.id, period, 'patient'));
  });
  app.get('/api/v1/analytics/patients/:patient_id', (req, res) => {
    const period = range(req);
    if (!period) return P.sendError(req, res, 422, 'E-VALIDATION');
    const id = Number(req.params.patient_id);
    if (!baseConsentGiven(id)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    auditPatient(req, id, 'allow', 'analytics');
    return res.json(patientReport(db, id, period, req.user, P.iso(now(config))));
  });
  app.get('/api/v1/analytics/reports', (req, res) => {
    const period = range(req);
    if (!period) return P.sendError(req, res, 422, 'E-VALIDATION');
    const scope = String(req.query.scope || (req.user.role === 'admin' ? 'program' : 'current'));
    if (!['current', 'historical', 'program'].includes(scope)) return P.sendError(req, res, 422, 'E-VALIDATION');
    if ((req.user.role === 'admin') !== (scope === 'program')) return P.sendError(req, res, 403, 'E-ACCESS');
    return res.json(
      cohortReport(db, { scope, clinicianId: req.user.id, actorRole: req.user.role, ...period, minGroup: minGroup() }),
    );
  });
  app.get('/api/v1/admin/analytics/users', (req, res) => {
    const period = range(req);
    if (!period) return P.sendError(req, res, 422, 'E-VALIDATION');
    return res.json(productReport(db, { ...period, minGroup: minGroup() }));
  });
}

module.exports = { install };
