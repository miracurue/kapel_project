'use strict';

const service = require('./service');
const { isFullyAssigned } = require('../../access/assignment');
const crisisGate = require('../../ai/crisisGate');
const analytics = require('../analytics/facts');

function install(
  app,
  { db, P, config, now, baseConsentGiven, recordCrisis, auditPatient, getMedications, activeSetting },
) {
  const store = service.create(db);
  const today = () =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: activeSetting?.('org.timezone_hours').value?.timezone || 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now(config));
  const fail = (req, res, status, code) => P.sendError(req, res, status, code);
  const response = (patientId, result) => ({
    ...result,
    today: today(),
    sharedState: {
      ...service.shared(result.state),
      wellbeings:
        db.prepare('SELECT share_diary_scores FROM user_prefs WHERE user_id=?').get(patientId)?.share_diary_scores === 0
          ? {}
          : result.state.wellbeings,
    },
    shared_scores:
      db.prepare('SELECT share_diary_scores FROM user_prefs WHERE user_id=?').get(patientId)?.share_diary_scores !== 0,
    analytics: analytics.patientInsights(db, patientId, today()),
    medications: getMedications ? getMedications(patientId) : [],
    medications_shared:
      db.prepare('SELECT share_med_log FROM user_prefs WHERE user_id=?').get(patientId)?.share_med_log !== 0,
  });
  function own(req, res) {
    if (!req.user) {
      fail(req, res, 401, 'E-SESSION-EXPIRED');
      return false;
    }
    if (req.user.role !== 'patient') {
      fail(req, res, 403, 'E-ACCESS');
      return false;
    }
    return true;
  }
  app.get('/api/v1/me/diary-workspace', (req, res) => {
    if (!own(req, res)) return;
    const result = store.read(req.user.id);
    if (req.query.from !== undefined || req.query.to !== undefined) {
      const from = String(req.query.from || ''),
        to = String(req.query.to || '');
      const valid = (d) =>
        /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
      const span = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
      if (!valid(from) || !valid(to) || span < 1 || span > 90 || to > today())
        return fail(req, res, 422, 'E-VALIDATION');
      result.state = service.windowState(result.state, from, to);
      return res.json({ ...response(req.user.id, result), window: { from, to }, read_only: to !== today() });
    }
    if (req.query.window === '90') {
      const from = analytics.shiftDay(today(), -89),
        to = today();
      result.state = service.windowState(result.state, from, to);
      return res.json({ ...response(req.user.id, result), window: { from, to } });
    }
    res.json(response(req.user.id, result));
  });
  app.put('/api/v1/me/diary-workspace', (req, res) => {
    if (!own(req, res)) return;
    if (req.headers['x-csrf-token'] !== req.session?.data?.csrf) return fail(req, res, 403, 'E-CSRF');
    const previousStrings = new Set(service.strings(store.read(req.user.id).state));
    const text = service
      .strings(req.body?.state)
      .filter((v) => !previousStrings.has(v))
      .join('\n');
    const detected = crisisGate.detect(text);
    const signal = detected ? recordCrisis(req.user.id, 'diary', text) : null;
    const crisis = detected ? crisisGate.card(Boolean(signal?.delivered)) : null;
    const send = (body) => {
      if (req.body.window && body.state) {
        body.state = service.windowState(body.state, req.body.window.from, req.body.window.to);
        body.sharedState = service.shared(body.state);
        if (
          db.prepare('SELECT share_diary_scores FROM user_prefs WHERE user_id=?').get(req.user.id)
            ?.share_diary_scores === 0
        )
          body.sharedState.wellbeings = {};
        body.window = req.body.window;
      }
      return res.json(
        crisis ? { ...body, crisis } : /тошнит|побоч|таблетк/i.test(text) ? { ...body, ae_suggestion: true } : body,
      );
    };
    if (!baseConsentGiven(req.user.id)) {
      if (crisis) return send({ saved: false });
      return fail(req, res, 403, 'E-CONSENT-REQUIRED');
    }
    if (!db.prepare('SELECT 1 FROM care_episodes WHERE patient_id=? AND ended_at IS NULL').get(req.user.id))
      return fail(req, res, 409, 'E-ARCHIVED');
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key || key.length > 200) return fail(req, res, 422, 'E-VALIDATION');
    const hash = P.sha(JSON.stringify({ path: req.path, body: req.body }));
    const cached = db
      .prepare('SELECT body_sha256,response_json FROM idempotency_keys WHERE user_id=? AND key=?')
      .get(req.user.id, key);
    if (cached) {
      if (cached.body_sha256 !== hash) return fail(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
      return send(response(req.user.id, store.read(req.user.id)));
    }
    let state;
    try {
      state = service.normalize(req.body?.state);
      if (req.body.window) {
        const { from, to } = req.body.window;
        if (
          typeof from !== 'string' ||
          typeof to !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
          analytics.shiftDay(to, -89) !== from ||
          to !== today()
        )
          throw new Error('validation');
        state = service.mergeWindow(store.read(req.user.id).state, state, from, to);
        const changes = req.body.noteSharing || [];
        if (!Array.isArray(changes) || changes.length > 100) throw new Error('validation');
        for (const change of changes) {
          if (
            !change ||
            typeof change.id !== 'string' ||
            typeof change.shared !== 'boolean' ||
            Object.keys(change).some((key) => !['id', 'shared'].includes(key))
          )
            throw new Error('validation');
          const note = state.dayNotes.find((n) => n.id === change.id);
          if (!note) throw new Error('validation');
          note.shared = change.shared;
        }
      }
    } catch (_) {
      return fail(req, res, 422, 'E-VALIDATION');
    }
    if (!Number.isInteger(req.body.revision) || req.body.revision < 0) return fail(req, res, 422, 'E-VALIDATION');
    let result;
    try {
      result = db
        .transaction(() => {
          const saved = store.save(req.user.id, req.body.revision, state, today(), P.iso(now(config)));
          if ('conflict' in saved) return saved;
          // Only a revision is cached: free text is never copied into runtime/audit logs.
          db.prepare('INSERT INTO idempotency_keys(user_id,key,body_sha256,response_json) VALUES (?,?,?,?)').run(
            req.user.id,
            key,
            hash,
            JSON.stringify({ revision: saved.revision }),
          );
          P.safeEvent(db, req.session, 'diary.saved');
          return saved;
        })
        .immediate();
    } catch (error) {
      if (error.message === 'history') return fail(req, res, 409, 'E-CONFLICT');
      throw error;
    }
    if ('conflict' in result)
      return P.sendError(req, res, 409, 'E-CONFLICT', { details: { revision: result.conflict } });
    return send(response(req.user.id, result));
  });
  app.get('/api/v1/patients/:patient_id/diary-workspace', (req, res) => {
    if (!req.user) return fail(req, res, 401, 'E-SESSION-EXPIRED');
    if (!['psychiatrist', 'psychologist'].includes(req.user.role)) return fail(req, res, 403, 'E-ACCESS');
    const patientId = Number(req.params.patient_id);
    const assigned = isFullyAssigned(db, patientId, req.user.id);
    if (!assigned) {
      auditPatient(req, patientId, 'deny', 'diary');
      return fail(req, res, 404, 'E-NOT-FOUND');
    }
    if (!baseConsentGiven(patientId)) return fail(req, res, 403, 'E-CONSENT-REQUIRED');
    auditPatient(req, patientId, 'allow', 'diary');
    const result = store.read(patientId);
    return res.json({
      revision: result.revision,
      state: {
        ...service.shared(result.state),
        wellbeings:
          db.prepare('SELECT share_diary_scores FROM user_prefs WHERE user_id=?').get(patientId)?.share_diary_scores ===
          0
            ? {}
            : result.state.wellbeings,
      },
      today: today(),
      read_only: true,
    });
  });
  return store;
}
module.exports = { install, collectText: (body) => service.strings(body).join('\n') };
