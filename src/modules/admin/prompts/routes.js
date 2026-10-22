'use strict';

/**
 * Каталог промптов ИИ для администратора (F-101). Контракт — docs/openapi.yaml:
 *   GET  /api/v1/admin/ai/prompts/{key}/versions               — все версии ключа
 *   POST /api/v1/admin/ai/prompts/{key}/versions               — новая версия (черновик)
 *   GET  /api/v1/admin/ai/prompts/{key}/diff?from=&to=         — построчное сравнение версий
 *   POST /api/v1/admin/ai/prompts/{key}/versions/{n}/activate  — сделать версию активной (откат — то же действие)
 * Активация действует на ответы ИИ сразу: шлюз читает активный промпт при каждом вызове.
 */

const { createPromptService } = require('./service');

function install(app, { db, P, keys }) {
  const svc = createPromptService({ db, keys });
  const adminOnly = (req, res) => {
    if (!req.user) {
      P.sendError(req, res, 401, 'E-SESSION-EXPIRED');
      return false;
    }
    if (req.user.role !== 'admin') {
      P.sendError(req, res, 403, 'E-ACCESS');
      return false;
    }
    return true;
  };
  const fail = (req, res, out) =>
    P.sendError(req, res, out.code === 'E-NOT-FOUND' ? 404 : out.code === 'E-VALIDATION' ? 422 : 409, out.code, out.fields ? { fields: out.fields } : undefined);

  app.get('/api/v1/admin/ai/prompts/:key/versions', (req, res) => {
    if (!adminOnly(req, res)) return undefined;
    if (!svc.known(req.params.key)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    return res.json({ items: svc.versions(req.params.key) });
  });

  app.post('/api/v1/admin/ai/prompts/:key/versions', (req, res) => {
    if (!adminOnly(req, res)) return undefined;
    const out = svc.createVersion(req.params.key, req.body || {}, req.user.id);
    if (!out.ok) return fail(req, res, out);
    svc.logAction(req.user, req.requestId, 'prompt.version.create', req.params.key, { version: out.version, length: out.length });
    return res.status(201).json(svc.version(req.params.key, out.version));
  });

  app.get('/api/v1/admin/ai/prompts/:key/diff', (req, res) => {
    if (!adminOnly(req, res)) return undefined;
    const out = svc.diff(req.params.key, req.query.from, req.query.to);
    return out ? res.json(out) : P.sendError(req, res, 404, 'E-NOT-FOUND');
  });

  app.post('/api/v1/admin/ai/prompts/:key/versions/:version/activate', (req, res) => {
    if (!adminOnly(req, res)) return undefined;
    const out = svc.activate(req.params.key, Number(req.params.version), req.user.id);
    if (!out.ok) return fail(req, res, out);
    svc.logAction(req.user, req.requestId, 'prompt.version.activate', req.params.key, { version: out.version, previous: out.previous });
    return res.json(svc.version(req.params.key, out.version));
  });
}

module.exports = { install };
