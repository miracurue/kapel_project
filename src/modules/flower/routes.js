'use strict';

/**
 * Цветок и капельки пациента: состояние, полив, «+N» после действий.
 * Только свои данные: patient_id берётся из сессии. Начисления идут не из отдельных вызовов в каждом
 * маршруте, а просмотром источников после любой успешной записи пациента (service.sync), поэтому новые
 * способы записи (дневник, тесты, привычки, лекарства, чат) не требуют правки правил в нескольких местах.
 */

const service = require('./service');
const phrases = require('./phrases');
const techniques = require('../techniques/catalog');

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function install(app, { db, P, config, now, activeSetting, idemCached, saveIdem }) {
  const timezone = () => activeSetting?.('org.timezone_hours')?.value?.timezone || 'Europe/Moscow';
  const today = () =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now(config));
  const hour = () =>
    Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: timezone(), hour: '2-digit', hourCycle: 'h23' }).format(now(config)),
    );
  const svc = service.create(db, { now: () => P.iso(now(config)), today, hour });

  // После успешной записи пациента просматриваем источники и сообщаем «+N» заголовком: тело ответа не меняется.
  app.use((req, res, next) => {
    if (req.user?.role !== 'patient' || !WRITE.has(req.method)) return next();
    if (!req.path.startsWith('/api/v1/') || req.path.startsWith('/api/v1/me/flower')) return next();
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 400) {
        const { gained, items } = svc.sync(req.user.id);
        res.set('X-Flower-Gain', String(gained));
        // Какие действия принесли капельки: по ним клиент просит тёплую фразу (одну, самую важную).
        res.set('X-Flower-Actions', [...new Set(items.map((x) => x.action))].join(','));
        res.set('X-Flower-Balance', String(svc.balance(req.user.id)));
      }
      return json(body);
    };
    return next();
  });

  app.get('/api/v1/me/flower', (req, res) => {
    const fresh = svc.sync(req.user.id);
    // Первый вход за день: вместе с капельками приходит приветствие (если режим фраз и пределы позволяют).
    const greeting = fresh.items.some((x) => x.action === 'login')
      ? svc.message(req.user.id, 'login', 'greeting')
      : null;
    res.json({ ...svc.state(req.user.id), fresh: { gained: fresh.gained, items: fresh.items }, greeting });
  });

  // «Я выполнил(а) методику»: раз в день на методику, капельки начисляются сразу.
  app.post('/api/v1/me/flower/technique', (req, res) => {
    const slug = req.body?.slug;
    if (typeof slug !== 'string' || !techniques.bySlug(slug))
      return P.sendError(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'slug', key: 'err.e-validation' }] });
    const result = svc.technique(req.user.id, slug);
    return res.json({ gained: result.gained, ...svc.state(req.user.id) });
  });

  // Тёплая фраза для окошка под капелькой: пределы и подбор на сервере, текст по форме обращения пациента.
  app.post('/api/v1/me/flower/message', (req, res) => {
    const action = req.body?.action;
    if (typeof action !== 'string' || !phrases.ACTIONS.includes(action))
      return P.sendError(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'action', key: 'err.e-validation' }] });
    return res.json({ message: svc.message(req.user.id, action, 'bubble') });
  });

  app.post('/api/v1/me/flower/water', (req, res) => {
    const raw = req.body?.steps;
    const steps = raw === undefined ? 0 : raw;
    if (!Number.isInteger(steps) || steps < 0 || steps > 20)
      return P.sendError(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'steps', key: 'err.e-validation' }] });
    const idem = idemCached(req, req.user.id);
    if (idem.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (idem.cached) return res.json(idem.cached);
    svc.sync(req.user.id);
    const result = svc.water(req.user.id, steps, idem.key);
    if (result.error) return P.sendError(req, res, 409, 'E-STATUS', { reason: result.error });
    const body = { watered: { steps: result.steps, drops: result.drops }, ...svc.state(req.user.id) };
    saveIdem(req.user.id, idem, body);
    return res.json(body);
  });

  return svc;
}

module.exports = { install };
