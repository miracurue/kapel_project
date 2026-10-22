'use strict';

/**
 * W-41 (этап 14, веха В5 «Админка»): API рабочих настроек — F-97 (версии,
/**
 * W-41 (этап 14, веха В5 «Админка»): API рабочих настроек — F-97 (версии,
 * откат, перенос), F-98 («Кто утвердил», очередь согласований КО), F-117
 * (выключатели возможностей S-57 и режим обслуживания S-58). Маршруты и
 * ошибки — по docs/openapi.yaml (тег admin-settings). Доступ: роль проверяет
 * контрактный контроль доступа в src/server.js (R-05/R-06; ведущему
 * демонстрации — чтение и запись только demo.route), хост-ограничение записи
 * продублировано здесь. Настройка действует сразу: сохранение сбрасывает кеш
 * действующей версии; ранний перехватчик ниже подключает действующие
 * значения к /me (S-57), прямым запросам STT (S-57), загрузке файлов (S-25)
 * и режиму обслуживания (S-58).
 */

const crisisProtocol = require('../../crisisProtocol');
const platform = require('../../platform');
const { t } = require('../../i18n');

// Роли, которые входят при режиме обслуживания (S-58: только администраторы).
const MAINTENANCE_ROLES = ['admin', 'bootstrap_admin', 'host'];
// Адреса, доступные всем в режиме обслуживания (S-58: 112 и справка).
const MAINTENANCE_OPEN = new Set([
  '/api/v1/crisis/contacts',
  '/api/v1/help',
  '/api/v1/auth/logout',
  '/api/v1/csrf',
  '/healthz',
  '/readyz',
]);

function knownKey(registry, key) {
  return !!registry.matchValidator(key) || key === 'crisis.rules' || key === 'data_mode';
}

function groupOf(key) {
  if (/^retention\./.test(key)) return 'retention';
  if (/^(ai\.|hints\.)/.test(key)) return 'ai';
  if (/^(crisis\.|triage\.|pv\.|course_support\.|ae\.)/.test(key)) return 'clinic';
  if (/^lists\./.test(key)) return 'lists';
  if (/^demo\./.test(key)) return 'demo';
  if (/^(service\.|auth\.)/.test(key)) return 'service';
  if (/^(pii\.|pseudonym)/.test(key)) return 'pii';
  return 'work';
}

function fail(res, req, P, r, fallback) {
  const status = r.status || 422;
  const code = r.code || fallback || 'E-SETTING-INVALID';
  const extra = {};
  if (r.field) extra.fields = [{ field: r.field, key: `err.${code.toLowerCase()}` }];
  if (r.extra) extra.details = r.extra;
  return P.sendError(req, res, status, code, Object.keys(extra).length ? extra : undefined);
}

// Сигнатура типа файла по содержимому части multipart (S-25). Неизвестное —
// null: обычная проверка типов на маршруте загрузки останется прежней.
function sniffType(data) {
  if (!Buffer.isBuffer(data)) return null;
  const headEnd = data.indexOf(Buffer.from('\r\n\r\n'));
  const content = headEnd >= 0 ? data.subarray(headEnd + 4) : data;
  if (content.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpeg';
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (content.subarray(0, 5).toString() === '%PDF-') return 'pdf';
  if (content.subarray(0, 4).toString() === 'PK\x03\x04') return 'docx';
  if (
    content.subarray(4, 8).toString() === 'ftyp' &&
    /^(heic|heix|heim|mif1|msf1)/.test(content.subarray(8, 12).toString())
  )
    return 'heic';
  return null;
}

// Страница входа при режиме обслуживания: телефон 112 доступен всем (S-58).
function maintenancePage(messageKey) {
  const kind = messageKey === 'unplanned' ? 'unplanned' : 'planned';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${t('msg.maintenance.title')}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main data-page="P-02" data-standin="maintenance"><h1 data-testid="msg.maintenance.title">${t('msg.maintenance.title')}</h1><p data-testid="msg.maintenance.text">${t('msg.maintenance.text')}</p><p><a href="tel:112" data-testid="msg.help.call_112">112</a></p><p data-testid="msg.maintenance.kind.${kind}">${t(`msg.maintenance.kind.${kind}`)}</p></main></body></html>`;
}

function install(app, { db, P, config, now, settings }) {
  const registry = settings.registry;
  const err = (req, res, status, code, extra) => P.sendError(req, res, status, code, extra);

  // ---------- провайдеры действующих значений (S-18, S-30, S-40) ----------
  crisisProtocol.setSettingsProvider((key) => settings.effective(key));
  platform.setTimeoutsProvider(() => settings.effective('auth.session_timeouts').value);
  // Начальные значения (S-01…S-66) — идемпотентно, единожды на базу.
  settings.seedDefaults();

  // ---------- ранний перехватчик: S-58, S-57, S-25 ----------
  app.use((req, res, next) => {
    const user = req.user || null;
    const isAdmin = !!user && MAINTENANCE_ROLES.includes(user.role);
    const maintenance = settings.maintenanceState();
    if (maintenance.on && !isAdmin) {
      if (req.method === 'GET' && req.path === '/login')
        return res.status(503).send(maintenancePage(maintenance.message_key));
      if (req.method === 'POST' && req.path === '/api/v1/auth/login') {
        const email = String((req.body || {}).email || '')
          .trim()
          .toLowerCase();
        const u = email ? db.prepare('SELECT role FROM users WHERE lower(email) = ?').get(email) : null;
        if (!u || !MAINTENANCE_ROLES.includes(u.role))
          return err(req, res, 503, 'E-MAINTENANCE', {
            details: maintenance.until ? { until: maintenance.until } : undefined,
          });
      } else if (!MAINTENANCE_OPEN.has(req.path)) {
        return err(req, res, 503, 'E-MAINTENANCE', {
          details: maintenance.until ? { until: maintenance.until } : undefined,
        });
      }
    }
    // S-57: выключенная возможность — прямой запрос «возможность выключена».
    if (req.method === 'POST' && req.path === '/api/v1/stt' && settings.effective('features.voice').value === false)
      return err(req, res, 403, 'E-ACCESS', { details: { feature: 'voice' } });
    // S-25: пределы файлов действуют сразу (размер и известный тип).
    if (req.method === 'POST' && req.path === '/api/v1/uploads') {
      const limits = settings.effective('files.limits').value || {};
      const maxBytes = Number(limits.max_mb) > 0 ? Number(limits.max_mb) * 1024 * 1024 : 10 * 1024 * 1024;
      if (Buffer.isBuffer(req.body) && req.body.length > maxBytes) return err(req, res, 413, 'E-FILE-SIZE');
      const type = sniffType(req.body);
      if (type && Array.isArray(limits.types) && limits.types.length && !limits.types.includes(type))
        return err(req, res, 415, 'E-FILE-TYPE');
    }
    // S-57: действующие возможности в /me.
    if (req.method === 'GET' && req.path === '/api/v1/me') {
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        if (body && typeof body === 'object' && !Array.isArray(body) && !body.features)
          body.features = settings.featuresAll();
        return originalJson(body);
      };
    }
    return next();
  });

  app.get('/api/v1/admin/settings', (req, res) => {
    const keys = new Set(Object.keys(registry.DEFAULTS));
    for (const f of registry.FEATURES) keys.add(`features.${f}`);
    for (const k of Object.keys(registry.RETENTION_RANGES)) keys.add(k);
    keys.add('crisis.rules');
    const items = [...keys].sort().map((key) => {
      const row = settings.activeRow(key);
      const a = settings.active(key);
      return {
        key,
        group: groupOf(key),
        version: a.version,
        value: a.value,
        status: row ? row.status : 'default',
        review_required: !!registry.CLINICAL(key),
      };
    });
    const group = String(req.query.group || '');
    return res.json({ items: group ? items.filter((x) => x.group === group) : items });
  });

  app.get('/api/v1/admin/settings-export', (_req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="settings.json"');
    return res.json(settings.exportAll());
  });

  app.post('/api/v1/admin/settings-import', (req, res) => {
    const uploadId = Number((req.body || {}).upload_id);
    if (!Number.isInteger(uploadId) || uploadId <= 0)
      return err(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'upload_id', key: 'err.e-validation' }] });
    const opts = { authorId: req.user.id };
    const r = (req.body || {}).apply ? settings.importApply(uploadId, opts) : settings.importPreview(uploadId);
    if (!r.ok) return fail(res, req, P, r, 'E-IMPORT-FORMAT');
    return res.json({ ok: true, diff: r.diff, applied: r.applied || undefined });
  });

  app.put('/api/v1/admin/features/:feature', (req, res) => {
    const body = req.body || {};
    if (typeof body.enabled !== 'boolean')
      return err(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'enabled', key: 'err.e-validation' }] });
    const r = settings.setFeature(req.params.feature, body.enabled, {
      authorId: req.user.id,
      comment: body.comment,
      approvedBy: body.approved_by,
      basis: body.basis,
    });
    if (!r.ok) return fail(res, req, P, r, 'E-NOT-FOUND');
    return res.json({ ok: true, feature: r.feature, enabled: r.enabled, version: r.version });
  });

  app.get('/api/v1/admin/settings/:key', (req, res) => {
    if (!knownKey(registry, req.params.key)) return err(req, res, 404, 'E-NOT-FOUND');
    return res.json(settings.full(req.params.key));
  });

  app.put('/api/v1/admin/settings/:key', (req, res) => {
    const key = req.params.key;
    if (req.user.role === 'host' && key !== 'demo.route') return err(req, res, 403, 'E-ACCESS');
    const body = req.body || {};
    if (!knownKey(registry, key)) return err(req, res, 404, 'E-NOT-FOUND');
    if (!('value' in body))
      return err(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'value', key: 'err.e-validation' }] });
    // Правка по устаревшей версии — конфликт (E-CONFLICT), как в редакторе форм.
    const cur = settings.activeRow(key);
    if (body.base_version != null && Number(body.base_version) !== (cur ? cur.version : 0))
      return err(req, res, 409, 'E-CONFLICT');
    const r = settings.set(key, body.value, {
      authorId: req.user.id,
      comment: body.comment,
      approvedBy: body.approved_by,
      basis: body.basis,
    });
    if (!r.ok) return fail(res, req, P, r);
    return res.json({
      key,
      current: { version: r.version, value: body.value, status: r.status, review_required: r.review_required },
      version: r.version,
      status: r.status,
      review_required: r.review_required,
      unchanged: !!r.unchanged,
    });
  });

  app.post('/api/v1/admin/settings/:key/rollback', (req, res) => {
    const key = req.params.key;
    if (req.user.role === 'host') return err(req, res, 403, 'E-ACCESS');
    const body = req.body || {};
    if (!Number.isInteger(Number(body.to_version)))
      return err(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'to_version', key: 'err.e-validation' }] });
    const r = settings.rollback(key, Number(body.to_version), {
      authorId: req.user.id,
      comment: body.comment,
      approvedBy: body.approved_by,
      basis: body.basis,
    });
    if (!r.ok) return fail(res, req, P, r, 'E-NOT-FOUND');
    return res.json({
      key,
      version: r.version,
      value: settings.active(key).value,
      status: r.status,
      review_required: r.review_required,
    });
  });
  // ---------- F-117/S-58: режим обслуживания ----------
  app.put('/api/v1/admin/maintenance', (req, res) => {
    const body = req.body || {};
    if (typeof body.on !== 'boolean')
      return err(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'on', key: 'err.e-validation' }] });
    const r = settings.setMaintenance(body, { authorId: req.user.id, comment: body.comment, basis: body.basis });
    if (!r.ok) return fail(res, req, P, r, 'E-SETTING-INVALID');
    return res.json({ ok: true, on: r.on, until: r.until, message_key: r.message_key, version: r.version });
  });

  // ---------- F-98: очередь согласований КО (P-51, при real) ----------
  app.get('/api/v1/approvals', (req, res) => res.json({ items: settings.approvalsList() }));

  app.post('/api/v1/approvals/:approval_id/approve', (req, res) => {
    const r = settings.decide(req.params.approval_id, { decideBy: req.user.id, approve: true });
    if (!r.ok) return err(req, res, r.status || 404, r.code || 'E-NOT-FOUND');
    return res.json({ ok: true, status: r.status });
  });

  app.post('/api/v1/approvals/:approval_id/reject', (req, res) => {
    const r = settings.decide(req.params.approval_id, {
      decideBy: req.user.id,
      approve: false,
      reason: (req.body || {}).reason,
    });
    if (!r.ok)
      return err(
        req,
        res,
        r.status || 404,
        r.code || 'E-NOT-FOUND',
        r.field ? { fields: [{ field: r.field, key: 'err.e-validation' }] } : undefined,
      );
    return res.json({ ok: true, status: r.status });
  });
}

module.exports = { install, groupOf, knownKey };
