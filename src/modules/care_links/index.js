'use strict';

// Минимальная маршрутизация: связь специалистов по пациенту (вопрос пациенту, снятие связи,
// блок «данные другого специалиста» и канал сообщений в карточке пациента).
// Контракт: docs/openapi.yaml. Операции, которых нет в замороженном operations.json, проверяют роль и CSRF здесь.

const { createService } = require('./service');

const OPS = {
  patient: { roles: [{ role: 'R-02', scope: 'С' }] },
  clinician: {
    roles: [
      { role: 'R-03', scope: 'С' },
      { role: 'R-04', scope: 'С' },
    ],
  },
};

function create({ db, P, config, now, access, action }) {
  const service = createService({ db, P, config, now });

  const guard =
    (op, { mutating = false } = {}) =>
    (req, res, next) => {
      if (mutating && (!req.session || req.headers['x-csrf-token'] !== req.session.data.csrf))
        return P.sendError(req, res, 403, 'E-CSRF');
      if (!req.user?.id) return P.sendError(req, res, 401, 'E-SESSION-EXPIRED');
      if (!access.isAllowed(op, req.user)) return P.sendError(req, res, 403, 'E-ACCESS');
      return next();
    };

  const num = (value) => (/^\d+$/.test(String(value)) ? Number(value) : NaN);

  function install(app) {
    app.get('/api/v1/me/care-links', guard(OPS.patient), (req, res) => res.json(service.patientView(req.user.id)));

    app.post('/api/v1/me/care-links/answer', guard(OPS.patient, { mutating: true }), (req, res) => {
      const ids = req.body?.clinician_ids;
      const promptId = num(req.body?.prompt_id);
      if (
        !Number.isInteger(promptId) ||
        !Array.isArray(ids) ||
        ids.length > 10 ||
        ids.some((x) => !Number.isInteger(x))
      )
        return P.sendError(req, res, 422, 'E-VALIDATION');
      const result = service.answer(req.user.id, promptId, ids);
      if (!result) return P.sendError(req, res, 404, 'E-NOT-FOUND');
      if (result.error) return P.sendError(req, res, 422, 'E-VALIDATION');
      for (const id of result.created) action(req.user, 'care.link.created', 'care_link', id);
      return res.json({ linked: result.created.length, ...service.patientView(req.user.id) });
    });

    app.post('/api/v1/me/care-links/:id/end', guard(OPS.patient, { mutating: true }), (req, res) => {
      const id = num(req.params.id);
      if (!Number.isInteger(id) || !service.endLink(req.user.id, id, req.user.id))
        return P.sendError(req, res, 404, 'E-NOT-FOUND');
      action(req.user, 'care.link.ended', 'care_link', id);
      return res.json({ ended: true });
    });

    app.get('/api/v1/patients/:patientId/colleagues', guard(OPS.clinician), (req, res) => {
      const patientId = num(req.params.patientId);
      const tag = P.sha(req.session.sid_hash).slice(0, 16);
      const audit = (section) =>
        db
          .prepare(
            "INSERT INTO phi_access_log(actor_id,actor_role,patient_id,section,action,decision,basis,session_tag) VALUES (?,?,?,?,'view','allow','assignment',?)",
          )
          .run(req.user.id, req.user.role, patientId, section, tag);
      const items = Number.isInteger(patientId) ? service.colleagueView(req.user, patientId, audit) : null;
      if (!items) return P.sendError(req, res, 404, 'E-NOT-FOUND');
      return res.json({ items });
    });

    app.post(
      '/api/v1/patients/:patientId/colleagues/:linkId/messages',
      guard(OPS.clinician, { mutating: true }),
      (req, res) => {
        const patientId = num(req.params.patientId);
        const linkId = num(req.params.linkId);
        const text = String(req.body?.text || '').trim();
        if (!text || text.length > 2000) return P.sendError(req, res, 422, 'E-VALIDATION');
        const done =
          Number.isInteger(patientId) && Number.isInteger(linkId)
            ? service.postMessage(req.user, patientId, linkId, text)
            : null;
        if (!done) return P.sendError(req, res, 404, 'E-NOT-FOUND');
        action(req.user, 'care.link.message', 'care_link', linkId);
        return res.status(201).json({ id: done.id });
      },
    );
  }

  return { service, install };
}

module.exports = create;
