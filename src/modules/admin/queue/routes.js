'use strict';

// W-38: маршруты очереди запросов администратора (F-82, F-83, F-85) и запросов субъекта
// (F-84, F-55, F-22). Права объявлены в docs/openapi.yaml (fn/perm), роль проверяет
// контрактный слой; здесь — повторная проверка роли и отображение кодов ошибок на HTTP.

const { QueueService } = require('./queueService');

const STATUS_BY_CODE = {
  'E-QUEUE-TAKEN': 409,
  'E-NO-CANDIDATE': 409,
  'E-ALREADY-DONE': 409,
  'E-ALREADY-REQUESTED': 409,
  'E-CRISIS-OPEN': 409,
  'E-VALIDATION': 422,
  'E-NOT-FOUND': 404,
  'E-RATE-LIMIT': 429,
};

function install(app, deps) {
  // Все записи очереди — через соединение src/db.js (как admin_core/admin_deletion):
  // вложенные вызовы журналов внутри транзакции остаются на одном соединении
  // (запись в чужое соединение внутри BEGIN IMMEDIATE даёт SQLITE_BUSY).
  const svc = new QueueService({ ...deps, db: require('../../../db') });
  const { P } = deps;
  const send = (req, res, e) => {
    const code = e.code || e.message;
    const status = STATUS_BY_CODE[code] || 500;
    P.sendError(req, res, status, status === 500 ? 'E-INTERNAL' : code);
  };
  const adminAction = (handler) => (req, res) => {
    if (!req.user || req.user.role !== 'admin') return P.sendError(req, res, 403, 'E-ACCESS');
    try {
      return res.json(handler(req));
    } catch (e) {
      return send(req, res, e);
    }
  };
  const patientAction = (handler) => (req, res) => {
    if (!req.user || req.user.role !== 'patient') return P.sendError(req, res, 403, 'E-ACCESS');
    try {
      return res.json(handler(req));
    } catch (e) {
      return send(req, res, e);
    }
  };

  // --- очередь администратора ---
  app.get('/api/v1/admin/requests', (req, res) => {
    if (!req.user || req.user.role !== 'admin') return P.sendError(req, res, 403, 'E-ACCESS');
    return res.json(svc.listRequests({ userId: req.user.id, filter: String(req.query.filter || 'open') }));
  });
  app.get('/api/v1/admin/requests/:id', (req, res) => {
    if (!req.user || req.user.role !== 'admin') return P.sendError(req, res, 403, 'E-ACCESS');
    const q = svc.getRequest(req.params.id);
    if (!q) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    return res.json(q);
  });
  app.post(
    '/api/v1/admin/requests/:id/take',
    adminAction((req) => svc.takeRequest({ requestId: req.params.id, userId: req.user.id })),
  );
  app.post(
    '/api/v1/admin/requests/:id/assign-clinician',
    adminAction((req) =>
      svc.assignSpecialist({
        requestId: req.params.id,
        adminId: req.user.id,
        specialistId: req.body.clinician_id,
        mode: req.body.mode,
      }),
    ),
  );
  app.post(
    '/api/v1/admin/requests/:id/clinician-change',
    adminAction((req) =>
      svc.clinicianChange({
        requestId: req.params.id,
        adminId: req.user.id,
        newClinicianId: req.body.new_clinician_id,
        mode: req.body.mode || 'replace',
      }),
    ),
  );
  app.post(
    '/api/v1/admin/requests/:id/answer',
    adminAction((req) =>
      svc.answerSubject({
        requestId: req.params.id,
        adminId: req.user.id,
        decision: req.body.decision,
        templateKey: req.body.template_key,
      }),
    ),
  );
  app.post(
    '/api/v1/admin/requests/:id/execute-erasure',
    adminAction((req) =>
      svc.executeErasure({
        requestId: req.params.id,
        adminId: req.user.id,
        confirmServiceNo: req.body.confirm_service_no,
      }),
    ),
  );
  app.post(
    '/api/v1/admin/requests/:id/close',
    adminAction((req) =>
      svc.closeRequest({ requestId: req.params.id, adminId: req.user.id, resultCode: req.body.result_code }),
    ),
  );

  // --- запросы субъекта ---
  app.post(
    '/api/v1/me/data/access-log/:entry_id/strange',
    patientAction((req) =>
      svc.createDispute({ patientId: req.user.id, accessLogId: req.params.entry_id, comment: req.body.comment }),
    ),
  );
  app.post(
    '/api/v1/me/clinician-change',
    patientAction((req) =>
      svc.createClinicianChange({
        patientId: req.user.id,
        clinicianId: req.body.clinician_id,
        reason: req.body.reason,
      }),
    ),
  );

  return svc;
}

module.exports = { install };
