'use strict';

// W-40: маршруты замещения со стороны специалиста (F-70): предложить, посмотреть свои, отменить.

const { SubstitutionService } = require('./service');

function install(app, deps) {
  const svc = new SubstitutionService(deps);
  const { P } = deps;
  const clinicianAction = (handler) => (req, res) => {
    if (!req.user || !['psychiatrist', 'psychologist'].includes(req.user.role))
      return P.sendError(req, res, 403, 'E-ACCESS');
    try {
      return res.json(handler(req));
    } catch (e) {
      const code = e.code || e.message;
      const status = { 'E-VALIDATION': 422, 'E-NOT-FOUND': 404, 'E-STATUS': 409 }[code] || 500;
      return P.sendError(req, res, status, status === 500 ? 'E-INTERNAL' : code);
    }
  };

  app.get(
    '/api/v1/me/substitutions',
    clinicianAction((req) => ({ items: svc.listMine(req.user.id) })),
  );
  app.get(
    '/api/v1/me/substitutions/candidates',
    clinicianAction((req) => ({
      items: deps.db
        .prepare(
          "SELECT id, full_name AS name FROM users WHERE role = ? AND id <> ? AND status = 'active' ORDER BY full_name",
        )
        .all(req.user.role, req.user.id),
    })),
  );
  app.post(
    '/api/v1/me/substitutions',
    clinicianAction((req) =>
      svc.propose(req.user, {
        substitute_id: req.body.substitute_id,
        from: req.body.from,
        to: req.body.to,
        all_patients: req.body.all_patients,
        patient_ids: req.body.patient_ids,
      }),
    ),
  );
  app.delete(
    '/api/v1/me/substitutions/:substitution_id',
    clinicianAction((req) => svc.cancel(req.user.id, req.params.substitution_id)),
  );

  return svc;
}

module.exports = { install };
