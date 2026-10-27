'use strict';

const { createService, CONTENT_OF } = require('./service');
const { createPages } = require('./pages');
const { createRoutes } = require('./routes');

const STAFF = ['psychiatrist', 'psychologist', 'admin'];
// Пока обязательное согласие пациента устарело, работают только эти адреса (кризисная помощь — всегда).
const STALE_OK = [
  /^\/api\/v1\/(consents|auth|csrf|crisis|docs)(\/|$)/,
  /^\/api\/v1\/me\/(deletion-request|exports|password)(\/|$)/,
];
const PAGE_FREE = [
  /^\/(login|register|blocked|password|legal|terms|onboarding|account\/help|account\/legal)(\/|$)/,
  /^\/$/,
];

function create(deps) {
  const { db, P, config, shell, t, esc } = deps;
  const service = createService(deps);
  const pages = createPages({ shell, t, config, service });
  const routes = createRoutes({ ...deps, service });
  const termsGate = process.env.STAFF_TERMS_GATE ? process.env.STAFF_TERMS_GATE === '1' : config.env !== 'test';
  const wantsHtml = (req) => req.method === 'GET' && /text\/html/.test(req.headers.accept || '');

  /** Повторное согласие пациента (P0-5) и принятие соглашения сотрудниками (Т-6). */
  function gate(req, res, next) {
    const user = req.user;
    if (!user?.id) return next();
    if (!req.path.startsWith('/api/') && !wantsHtml(req)) return next();
    if (req.path.startsWith('/js/') || req.path.startsWith('/css/')) return next();
    try {
      if (user.role === 'patient') {
        const r = service.renewal(user.id);
        if (req.path.startsWith('/api/')) {
          if (
            r.blocking &&
            !(req.method === 'GET' && req.path.startsWith('/api/v1/me')) &&
            !STALE_OK.some((re) => re.test(req.path))
          )
            return P.sendError(req, res, 403, 'E-CONSENT-REQUIRED');
          return next();
        }
        if (req.path === '/app' || req.path.startsWith('/app/')) {
          if (r.blocking || (r.kinds.length && !req.session?.data?.reconsent_later))
            return res.redirect(302, '/onboarding/consent');
        }
      } else if (
        termsGate &&
        STAFF.includes(user.role) &&
        !(config.demoMode && user.is_demo) &&
        wantsHtml(req) &&
        !req.path.startsWith('/api/')
      ) {
        if (!PAGE_FREE.some((re) => re.test(req.path)) && service.staffTermsMissing(user.id))
          return res.redirect(302, `/terms/accept?next=${encodeURIComponent(req.originalUrl)}`);
      }
    } catch (_) {
      /* сбой проверки не должен закрывать кризисную помощь */
    }
    return next();
  }

  function installPages(app) {
    const notFound = (req, res) =>
      res.status(404).send(require('../../pages').errorPage({ user: req.user, demo: config.demoMode }));
    app.get('/register', (req, res) => {
      // QR и ссылка врача: уже вошедший пациент попадает в профиль с подставленным кодом.
      if (req.user?.role === 'patient' && /^[A-Za-z0-9-]{1,32}$/.test(String(req.query.code || '')))
        return res.redirect(`/account?link=${encodeURIComponent(req.query.code)}`);
      return res.send(pages.registerPage(req.query.as === 'specialist' ? 'specialist' : 'patient'));
    });
    app.get('/legal/consent/:kind', (req, res) =>
      ['base', 'ai', 'research', 'program', 'staff_pd'].includes(req.params.kind)
        ? res.send(pages.docPage(req.user, req.params.kind))
        : notFound(req, res),
    );
    app.get('/legal/privacy', (req, res) => res.send(pages.docPage(req.user, 'privacy')));
    app.get('/legal/agreement', (req, res) => res.send(pages.docPage(req.user, 'agreement')));
    app.get('/onboarding/consent/later', (req, res) => {
      if (req.session && req.user?.id) {
        const data = { ...req.session.data, reconsent_later: true };
        db.prepare('UPDATE sessions SET data=? WHERE sid_hash=?').run(JSON.stringify(data), req.session.sid_hash);
        req.session.data = data;
      }
      return res.redirect(302, '/app');
    });
    app.get('/onboarding/consent/:step?', (req, res) => {
      if (req.user?.role !== 'patient') return res.redirect(302, '/login');
      const step = Number(req.params.step) || 0;
      if (req.params.step && !(step >= 1 && step <= pages.RENEW_STEPS.length)) return notFound(req, res);
      return res.send(pages.renewPage(req.user, step));
    });
    app.get('/terms/accept', (req, res) => {
      if (!req.user?.id || !STAFF.includes(req.user.role)) return res.redirect(302, '/login');
      const next = /^\/[^/\\]/.test(String(req.query.next || ''))
        ? String(req.query.next)
        : req.user.role === 'admin'
          ? '/admin'
          : '/work';
      return res.send(pages.termsPage(req.user, next));
    });
  }

  return {
    service,
    pages,
    gate,
    install(app) {
      routes.install(app);
      installPages(app);
    },
    applicationForLogin: routes.applicationForLogin,
    applicationPage: pages.applicationPage,
    esc,
    CONTENT_OF,
  };
}

module.exports = create;
