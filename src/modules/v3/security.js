'use strict';

const { isFullyAssigned } = require('../../access/assignment');

// Shared guards for the synchronous V3 operations. Replays recheck current access;
// only identifiers, status and hashes enter the idempotency store.
function create(app, { db, P, config, now, auditPatient, baseConsentGiven, crisis, activeSetting }) {
  const iso = () => P.iso(now(config));
  const assigned = (actor, patient, signal = false) => isFullyAssigned(db, patient, actor, { signal });
  const safe = (value) => {
    if (Array.isArray(value)) return value.map(safe);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !['quote', 'name'].includes(key))
        .map(([key, item]) => [key, safe(item)]),
    );
  };
  const hydrate = (value) => {
    if (value.signal?.taken_by?.id)
      value.signal.taken_by.name = db
        .prepare('SELECT full_name FROM users WHERE id=?')
        .get(value.signal.taken_by.id)?.full_name;
    return value;
  };
  const result = {};
  for (const method of ['get', 'post', 'put', 'patch'])
    result[method] = (path, ...handlers) =>
      app[method](path, (req, res) => {
        const write = method !== 'get';
        let patient = Number(req.params.patientId) || null;
        let object;
        if (req.params.signalId) {
          object = db.prepare('SELECT * FROM crisis_escalations WHERE id=?').get(Number(req.params.signalId));
          patient = object?.patient_id;
        } else if (req.params.aeId) {
          object = db.prepare('SELECT * FROM adverse_events WHERE id=?').get(Number(req.params.aeId));
          patient = object?.patient_id;
          if (object && (['cancelled', 'draft'].includes(object.status) || object.visible_from > iso()))
            return P.sendError(req, res, 404, 'E-NOT-FOUND');
        } else if (req.params.visitId) {
          object = db.prepare('SELECT * FROM visits WHERE id=?').get(Number(req.params.visitId));
          patient = object?.patient_id;
        }
        if ((req.params.signalId || req.params.aeId || req.params.visitId) && !object)
          return P.sendError(req, res, 404, 'E-NOT-FOUND');
        if (req.path.endsWith('/messages/read')) {
          const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
          for (const id of ids) {
            const message = db.prepare('SELECT * FROM care_messages WHERE id=?').get(Number(id));
            if (
              !message ||
              message.status !== 'sent' ||
              message.visible_from > iso() ||
              (req.user.role === 'patient'
                ? message.patient_id !== req.user.id
                : !assigned(req.user.id, message.patient_id) ||
                  !require('../files/service').messageParticipant(db, req.user.id, message, iso()))
            )
              return P.sendError(req, res, 404, 'E-NOT-FOUND');
          }
        }
        const clinician = ['psychiatrist', 'psychologist'].includes(req.user.role);
        const reserve = Boolean(
          req.params.signalId &&
            object?.escalated_to_backup_at &&
            (activeSetting('crisis.backup').value || []).map(Number).includes(req.user.id),
        );
        if (patient && clinician && !reserve && !assigned(req.user.id, patient, Boolean(req.params.signalId))) {
          try {
            auditPatient(req, patient, 'deny', 'v3');
          } catch (_) {
            /* deny stays closed */
          }
          return P.sendError(req, res, 404, 'E-NOT-FOUND');
        }
        if (patient && req.user.role === 'patient' && patient !== req.user.id)
          return P.sendError(req, res, 404, 'E-NOT-FOUND');
        if (write && req.user.role === 'patient') {
          const text = req.body.answers
            ? Object.values(req.body.answers).flat().join(' ')
            : // Свободное название препарата из опроса о побочном эффекте тоже проходит кризисную проверку.
              [req.body.text, req.body.med && req.body.med.name].filter((x) => typeof x === 'string').join(' ');
          req.crisisResult = crisis(
            text,
            req.body.answers ? 'previsit' : req.path.includes('messages') ? 'message' : 'ae',
            req.user.id,
          );
        }
        if (req.crisisResult) {
          const deliver = res.json;
          res.json = function (body) {
            return deliver.call(this, { ...body, crisis: req.crisisResult });
          };
        }
        if (req.params.visitId && req.user.role === 'patient') {
          const days = Number(activeSetting('previsit.days_before').value?.days || 14);
          if (!object.previsit_enabled || object.status !== 'scheduled' || object.visible_from > iso())
            return P.sendError(req, res, 409, 'E-ASSIGNMENT-CLOSED');
          if (
            new Date(object.starts_at) < now(config) ||
            new Date(object.starts_at).getTime() - now(config).getTime() > days * 86400000
          )
            return P.sendError(req, res, 409, 'E-STATUS');
        }
        if (
          write &&
          !req.path.endsWith('/messages/read') &&
          !req.params.signalId &&
          // F-45: удаление собственного черновика не требует согласия на новую
          // клиническую запись (это не создание данных, а отказ от них).
          !(req.body && req.body.discard === true && Number(req.body.draft_id)) &&
          !baseConsentGiven(patient || req.user.id)
        ) {
          if (req.crisisResult) return res.status(200).json({ crisis: req.crisisResult, saved: false });
          return P.sendError(req, res, 403, 'E-CONSENT-REQUIRED');
        }
        if (patient && clinician) {
          try {
            auditPatient(
              req,
              patient,
              'allow',
              req.params.aeId ? 'ae' : req.params.visitId ? 'visits' : 'v3',
              reserve ? 'crisis' : 'assignment',
            );
          } catch (_) {
            return P.sendError(req, res, 500, 'E-INTERNAL');
          }
        }
        const key = req.headers['idempotency-key'];
        const hash = P.sha(JSON.stringify({ method: req.method, path: req.path, body: req.body }));
        if (write && key) {
          const existing = db.prepare('SELECT * FROM idempotency_keys WHERE user_id=? AND key=?').get(req.user.id, key);
          if (existing) {
            if (existing.body_sha256 !== hash) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
            const stored = JSON.parse(existing.response_json);
            return res.status(stored.http_status).json(hydrate(stored.result));
          }
        }
        const original = res.json;
        const originalSend = res.send;
        try {
          // All handlers in this module are synchronous. Record result and mutation
          // in one transaction, and only send the response after commit.
          let payload;
          let binaryPayload;
          let status;
          res.send = function (body) {
            binaryPayload = body;
            status = res.statusCode;
            return res;
          };
          res.json = function (body) {
            payload = body;
            status = res.statusCode;
            return res;
          };
          db.transaction(() => {
            let index = 0;
            const run = () => {
              const handler = handlers[index++];
              if (handler) handler(req, res, run);
            };
            run();
            if (write && key && payload && status < 400)
              db.prepare('INSERT INTO idempotency_keys(user_id,key,body_sha256,response_json) VALUES (?,?,?,?)').run(
                req.user.id,
                key,
                hash,
                JSON.stringify({ http_status: status, result: safe(payload) }),
              );
          }).immediate();
          res.json = original;
          res.send = originalSend;
          if (binaryPayload !== undefined) return res.status(status).send(binaryPayload);
          if (payload !== undefined) return res.status(status).json(payload);
        } catch (_) {
          res.json = original;
          res.send = originalSend;
          return P.sendError(req, res, 500, 'E-INTERNAL');
        }
      });
  return result;
}
module.exports = { create };
