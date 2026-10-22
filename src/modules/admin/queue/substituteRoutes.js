'use strict';

// W-40: административные маршруты замещения и передачи пациентов (F-87, F-86).
// Отдельный файл: файлы задачи W-38 (queueService.js, routes.js) не изменяются.

const { SubstitutionService } = require('../../substitutions/service');

function install(app, deps) {
  const svc = new SubstitutionService(deps);
  const { P } = deps;
  const adminAction = (handler) => (req, res) => {
    if (!req.user || req.user.role !== 'admin') return P.sendError(req, res, 403, 'E-ACCESS');
    try {
      return res.json(handler(req));
    } catch (e) {
      const code = e.code || e.message;
      const status = { 'E-VALIDATION': 422, 'E-NOT-FOUND': 404, 'E-STATUS': 409 }[code] || 500;
      return P.sendError(req, res, status, status === 500 ? 'E-INTERNAL' : code);
    }
  };

  app.get('/api/v1/admin/substitutions', (req, res) => {
    if (!req.user || req.user.role !== 'admin') return P.sendError(req, res, 403, 'E-ACCESS');
    return res.json({ items: svc.listForAdmin(), page: 1, page_size: 50, total: svc.listForAdmin().length });
  });
  app.post(
    '/api/v1/admin/substitutions',
    adminAction((req) => {
      const absent = deps.core.getUser(req.body.absent_id);
      if (!absent || !['psychiatrist', 'psychologist'].includes(absent.role)) {
        const e = new Error('E-VALIDATION');
        e.code = 'E-VALIDATION';
        throw e;
      }
      return svc.propose(absent, {
        substitute_id: req.body.substitute_id,
        from: req.body.from,
        to: req.body.to,
        all_patients: req.body.all_patients,
        patient_ids: req.body.patient_ids,
      });
    }),
  );
  app.post(
    '/api/v1/admin/substitutions/:substitution_id/confirm',
    adminAction((req) => svc.confirm(req.user.id, req.params.substitution_id)),
  );
  app.post(
    '/api/v1/admin/transfers',
    adminAction((req) =>
      svc.transfer(req.user.id, {
        from_clinician_id: req.body.from_clinician_id,
        to_clinician_id: req.body.to_clinician_id,
        all_patients: req.body.all_patients,
        patient_ids: req.body.patient_ids,
      }),
    ),
  );

  return svc;
}

module.exports = { install };
