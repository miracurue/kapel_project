'use strict';

/**
 * Журнал: страницы /journal и /journal/:id, подгрузка ленты /journal/feed, лайк PUT /journal/api/:id/like,
 * управление статьями в админке /admin/api/journal*. Вне замороженного /api/v1: журнал — отдельный раздел демо.
 * Чтение — пациент, психиатр, психолог (пациент видит только журнал для пациентов, см. store.audiencesFor);
 * правка и удаление — администратор. Каждое изменение админом пишется в action_log.
 */

const { create, audiencesFor } = require('./store');
const view = require('./page');
const { reindexFts } = require('../library/seed');
const { errorPage } = require('../../pages');

const READERS = ['patient', 'psychiatrist', 'psychologist'];
const AUDIENCES = ['patient', 'specialist'];
const TITLE_MAX = 200;
const SUMMARY_MAX = 400;
const BODY_MAX = 100000;
const TAG_RE = /^[a-zа-яё0-9 _:-]{1,40}$/i;

function cleanTags(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const tag = String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/ё/g, 'е');
    if (tag && TAG_RE.test(tag) && !out.includes(tag)) out.push(tag);
    if (out.length >= 12) break;
  }
  return out;
}

function install(app, { db, P, config, now, action, flower }) {
  const store = create(db, () => now(config).getTime());
  const nowIso = () => P.iso(now(config));
  const csrfOk = (req) => req.session && req.headers['x-csrf-token'] === req.session.data.csrf;
  const invalid = (req, res, field) =>
    P.sendError(req, res, 422, 'E-VALIDATION', { fields: [{ field, key: 'err.e-validation' }] });

  function page(req, res, render) {
    if (!req.user) return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
    if (!READERS.includes(req.user.role))
      return res.status(404).send(errorPage({ user: req.user, demo: config.demoMode }));
    return render();
  }

  app.get('/journal', (req, res) =>
    page(req, res, () => {
      const allowed = audiencesFor(req.user);
      const asked = String(req.query.aud || '');
      // Психиатр и психолог по умолчанию попадают в журнал для специалистов, пациент — в журнал для пациентов.
      const audience = allowed.includes(asked) ? asked : allowed.length > 1 ? 'specialist' : 'patient';
      const topic = String(req.query.topic || '').slice(0, 60);
      const data = store.feed(req.user, { audience, page: 1, topic });
      return res.send(view.renderFeed({ user: req.user, audience, data, topic }));
    }),
  );

  app.get('/journal/feed', (req, res) => {
    if (!req.user || !READERS.includes(req.user.role)) return P.sendError(req, res, 401, 'E-SESSION-EXPIRED');
    const data = store.feed(req.user, {
      audience: String(req.query.aud || ''),
      page: Math.min(200, Math.max(1, Number(req.query.page) || 1)),
      topic: String(req.query.topic || '').slice(0, 60),
    });
    if (!data) return P.sendError(req, res, 403, 'E-ACCESS');
    return res.json({ html: view.cards(data.items, false), page: data.page, has_more: data.has_more });
  });

  app.get('/journal/:id(\\d+)', (req, res) =>
    page(req, res, () => {
      const item = store.article(req.user, req.params.id);
      if (!item) return res.status(404).send(errorPage({ user: req.user, demo: config.demoMode }));
      // Прочтение статьи пациентом — одна награда за статью (ключ), с дневным пределом (flower/rules.js).
      if (req.user.role === 'patient') flower?.award(req.user.id, 'article', `article:${item.id}`, 'journal');
      return res.send(view.renderArticle({ user: req.user, item, related: store.related(req.user, item) }));
    }),
  );

  app.put('/journal/api/:id(\\d+)/like', (req, res) => {
    if (!req.user || !READERS.includes(req.user.role)) return P.sendError(req, res, 401, 'E-SESSION-EXPIRED');
    if (!csrfOk(req)) return P.sendError(req, res, 403, 'E-CSRF');
    const liked = req.body && req.body.liked;
    if (typeof liked !== 'boolean') return invalid(req, res, 'liked');
    const out = store.setLike(req.user, req.params.id, liked);
    if (!out) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    return res.json(out);
  });

  // --- Админка: все статьи журнала, правка, снятие, удаление -------------------------------------

  function admin(req, res, mutating) {
    if (!req.user) {
      P.sendError(req, res, 401, 'E-SESSION-EXPIRED');
      return false;
    }
    if (req.user.role !== 'admin') {
      P.sendError(req, res, 403, 'E-ACCESS');
      return false;
    }
    if (mutating && !csrfOk(req)) {
      P.sendError(req, res, 403, 'E-CSRF');
      return false;
    }
    return true;
  }

  app.get('/admin/api/journal', (req, res) => {
    if (!admin(req, res, false)) return undefined;
    return res.json({ items: store.adminList() });
  });

  app.get('/admin/api/journal/:id(\\d+)', (req, res) => {
    if (!admin(req, res, false)) return undefined;
    const item = store.adminGet(req.params.id);
    return item ? res.json(item) : P.sendError(req, res, 404, 'E-NOT-FOUND');
  });

  app.put('/admin/api/journal/:id(\\d+)', (req, res) => {
    if (!admin(req, res, true)) return undefined;
    const b = req.body || {};
    const f = {};
    if (b.title !== undefined) {
      f.title = String(b.title).trim().slice(0, TITLE_MAX);
      if (!f.title) return invalid(req, res, 'title');
    }
    if (b.summary !== undefined) f.summary = String(b.summary).trim().slice(0, SUMMARY_MAX);
    if (b.body_md !== undefined) {
      f.body_md = String(b.body_md).replace(/\r\n?/g, '\n').slice(0, BODY_MAX);
      if (!f.body_md.trim()) return invalid(req, res, 'body_md');
    }
    if (b.tags !== undefined) f.tags = cleanTags(b.tags);
    if (b.audience !== undefined) {
      if (!AUDIENCES.includes(b.audience)) return invalid(req, res, 'audience');
      f.audience = b.audience;
    }
    const out = store.adminEdit(req.user.id, req.params.id, f, nowIso());
    if (!out) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    reindexFts(db);
    action(req.user, 'journal.admin.edit', 'library_item', out.id);
    return res.json(out);
  });

  for (const [name, status] of [
    ['publish', 'published'],
    ['unpublish', 'withdrawn'],
  ]) {
    app.post(`/admin/api/journal/:id(\\d+)/${name}`, (req, res) => {
      if (!admin(req, res, true)) return undefined;
      const out = store.adminSetStatus(req.params.id, status, nowIso());
      if (!out) return P.sendError(req, res, 404, 'E-NOT-FOUND');
      reindexFts(db);
      action(req.user, `journal.admin.${name}`, 'library_item', out.id);
      return res.json(out);
    });
  }

  app.delete('/admin/api/journal/:id(\\d+)', (req, res) => {
    if (!admin(req, res, true)) return undefined;
    if (!store.adminDelete(req.params.id)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    reindexFts(db);
    action(req.user, 'journal.admin.delete', 'library_item', req.params.id);
    return res.json({ ok: true });
  });

  return { store };
}

module.exports = { install };
