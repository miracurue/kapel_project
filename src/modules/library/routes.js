'use strict';

/**
 * W-48 (этап 14, веха В6): библиотека психообразования (F-50) и публикация
 * материалов в админке (F-109). Маршруты и коды ошибок — по замороженному
 * контракту docs/openapi.yaml:
 *   GET  /api/v1/library                      — опубликованное, поиск/фильтры
 *   GET  /api/v1/library/{item_id}            — карточка материала
 *   GET  /api/v1/library/{item_id}/media      — медиафайл, отдача частями (Range)
 *   PUT  /api/v1/library/{item_id}/position   — личная позиция «Продолжить»
 *   GET/POST /api/v1/admin/library            — список/создание (черновик)
 *   PUT  /api/v1/admin/library/{item_id}      — новая версия (E-CONFLICT по version)
 *   POST /api/v1/admin/library/{item_id}/publish|withdraw
 *
 * Роли и права проверяет контрактный контроль доступа в src/server.js
 * (library.read: пациент/психиатр/психолог; admin.content: R-05/R-06).
 * Назначений материалов нет — решение владельца (T-195). Позиция «Продолжить»
 * личная, в аналитику не идёт (DB-64, PD-02).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { reindexFts } = require('./seed');

// kind фильтра: «слушать/смотреть/читать» из контракта; синонимы audio/video/article
// совпадают с перечислением LibraryItem и используются замороженными тестами (T-195/T-196).
const KIND_TO_MEDIA = {
  audio: 'listen',
  video: 'watch',
  article: 'read',
  read: 'read',
  listen: 'listen',
  watch: 'watch',
};
const MEDIA_TO_KIND = { listen: 'audio', watch: 'video', read: 'article' };

function install(app, { db, P, config, now, idemCached, saveIdem }) {
  const currentIso = () => P.iso(now(config));

  const SELECT_PUBLISHED = [
    'SELECT li.id, li.media, li.current_version, li.sponsor_caption, li.tags_json,',
    '       lv.title, lv.summary, lv.body_md, lv.author, lv.source, lv.review_date,',
    '       lv.file_id, lv.duration_s, lv.is_stand_in, lv.version, lv.cover_file_id, lv.cover_url, lv.ai_assisted, li.owner_user_id, li.audience,',
    '       au.role AS author_role, li.updated_at,',
    '       lp.position_s, lp.version AS position_version',
    'FROM library_items li',
    'CROSS JOIN (SELECT ? AS uid) me', // единственный позиционный параметр — id читающего
    'JOIN library_versions lv ON lv.item_id = li.id AND lv.version = li.current_version',
    'LEFT JOIN users au ON au.id = li.owner_user_id',
    'LEFT JOIN library_positions lp ON lp.item_id = li.id AND lp.user_id = me.uid',
    "WHERE li.status = 'published' AND li.hidden_at IS NULL",
    // Журнал для специалистов: пациенту статьи с audience='specialist' не отдаются ни списком, ни по id, ни медиа.
    "AND (li.audience = 'patient' OR EXISTS (SELECT 1 FROM users vu WHERE vu.id = me.uid AND vu.role IN ('psychiatrist','psychologist')))",
  ].join('\n');

  function toItem(row) {
    return {
      id: row.id,
      title: row.title,
      kind: MEDIA_TO_KIND[row.media] || row.media,
      summary: row.summary || '',
      duration_s: row.duration_s ?? null,
      source: row.source,
      author: row.author,
      version: row.version,
      review_date: row.review_date,
      stand_in: Boolean(row.is_stand_in),
      sponsor_note: row.sponsor_caption || null,
      tags: JSON.parse(row.tags_json || '[]'),
      author_role: { psychiatrist: 'психиатр', psychologist: 'психолог' }[row.author_role] || null,
      cover_url: row.cover_file_id ? `/library/img/${row.cover_file_id}` : row.cover_url || null,
      ai_assisted: Boolean(row.ai_assisted),
      audience: row.audience,
      published_at: row.updated_at || null,
      position_s: row.position_version === row.current_version && row.position_s != null ? row.position_s : null,
    };
  }

  // --- Пациент и клиницисты: общий каталог ---------------------------------

  app.get('/api/v1/library', (req, res) => {
    const kindRaw = String(req.query.kind || '');
    const media = kindRaw ? KIND_TO_MEDIA[kindRaw] : null;
    if (kindRaw && !media) return P.sendError(req, res, 422, 'E-VALIDATION');
    const q = String(req.query.q || '')
      .trim()
      .slice(0, 50);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = 50;
    const args = [req.user.id];
    const conds = [];
    if (media) {
      conds.push('li.media = ?');
      args.push(media);
    }
    if (q) {
      conds.push('li.id IN (SELECT rowid FROM library_fts WHERE library_fts MATCH ?)');
      args.push('"' + q.replace(/"/g, '""') + '"');
    }
    const where = conds.length ? ' AND ' + conds.join(' AND ') : '';
    const total = db.prepare('SELECT count(*) n FROM (' + SELECT_PUBLISHED + where + ')').get(...args).n;
    const rows = db
      .prepare(SELECT_PUBLISHED + where + ' ORDER BY li.id LIMIT ? OFFSET ?')
      .all(...args, pageSize, (page - 1) * pageSize);
    return res.json({ items: rows.map(toItem), page, page_size: pageSize, total });
  });

  app.get('/api/v1/library/:item_id', (req, res) => {
    const row = db.prepare(SELECT_PUBLISHED + ' AND li.id = ?').get(req.user.id, Number(req.params.item_id));
    if (!row) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const item = toItem(row);
    if (row.media === 'read') item.body_md = row.body_md || '';
    else item.media_ready = Boolean(row.file_id);
    return res.json(item);
  });

  app.put('/api/v1/library/:item_id/position', (req, res) => {
    const position = Number(req.body && req.body.position_s);
    if (!Number.isInteger(position) || position < 0) return P.sendError(req, res, 422, 'E-VALIDATION');
    const row = db.prepare(SELECT_PUBLISHED + ' AND li.id = ?').get(req.user.id, Number(req.params.item_id));
    if (!row) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    db.prepare(
      'INSERT INTO library_positions(user_id,item_id,version,position_s,updated_at) VALUES (?,?,?,?,?) ' +
        'ON CONFLICT(user_id,item_id) DO UPDATE SET version=excluded.version, position_s=excluded.position_s, updated_at=excluded.updated_at',
    ).run(req.user.id, row.id, row.current_version, position, currentIso());
    return res.json({ ok: true, position_s: position });
  });

  // --- Медиа с отдачей частями (Range, файлы до 200 МБ) ---------------------

  app.get('/api/v1/library/:item_id/media', (req, res) => {
    const row = db.prepare(SELECT_PUBLISHED + ' AND li.id = ?').get(req.user.id, Number(req.params.item_id));
    if (!row) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (!row.file_id) return P.sendError(req, res, 404, 'E-MEDIA');
    const file = db.prepare("SELECT * FROM stored_files WHERE id=? AND status<>'deleted'").get(row.file_id);
    if (!file) return P.sendError(req, res, 404, 'E-MEDIA');
    const filePath = path.join(config.dataDir, 'files', file.storage_name);
    if (!fs.existsSync(filePath)) return P.sendError(req, res, 404, 'E-MEDIA');
    const size = fs.statSync(filePath).size;
    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range && size > 0) {
      let start = range[1] === '' ? null : Number(range[1]);
      let end = range[2] === '' ? null : Number(range[2]);
      if (start === null && end !== null) {
        start = Math.max(0, size - end);
        end = size - 1;
      }
      if (end === null || end >= size) end = size - 1;
      if (start === null || start > end || start >= size) {
        res.setHeader('Content-Range', 'bytes */' + size);
        return res.status(416).end();
      }
      res.status(206);
      res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + size);
      res.setHeader('Content-Length', String(end - start + 1));
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
    res.setHeader('Content-Length', String(size));
    return fs.createReadStream(filePath).pipe(res);
  });

  // --- Админка: материалы и публикация (F-109) ------------------------------

  function validLibraryBody(body) {
    const title = String(body.title || '').trim();
    const kind = String(body.kind || '');
    if (!title || title.length > 200) return { error: 'E-VALIDATION', field: 'title' };
    if (!['audio', 'video', 'article'].includes(kind)) return { error: 'E-VALIDATION', field: 'kind' };
    const markdown = body.markdown === undefined ? null : String(body.markdown);
    if (markdown && markdown.length > 100000) return { error: 'E-VALIDATION', field: 'markdown' };
    if (kind === 'article' && !markdown) return { error: 'E-VALIDATION', field: 'markdown' };
    if (kind !== 'article' && !Number.isInteger(body.upload_id)) return { error: 'E-VALIDATION', field: 'upload_id' };
    const author = body.author === undefined ? '' : String(body.author).slice(0, 200);
    const source = body.source === undefined ? '' : String(body.source).slice(0, 500);
    const sponsor = body.sponsor_note === undefined ? null : String(body.sponsor_note).slice(0, 200) || null;
    const tags = Array.isArray(body.tags) ? body.tags.map(String).slice(0, 20) : [];
    let revision = String(body.revision_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(revision)) revision = currentIso().slice(0, 10);
    return { ok: { title, kind, markdown, author, source, sponsor, tags, revision, upload_id: body.upload_id } };
  }

  app.get('/api/v1/admin/library', (req, res) => {
    const status = String(req.query.status || '');
    if (status && !['draft', 'review', 'published', 'withdrawn'].includes(status))
      return P.sendError(req, res, 422, 'E-VALIDATION');
    const where = status ? 'WHERE li.status = ?' : '';
    const args = status ? [status] : [];
    const total = db.prepare('SELECT count(*) n FROM library_items li ' + where).get(...args).n;
    const rows = db
      .prepare(
        'SELECT li.id, li.slug, li.media, li.status, li.audience, li.current_version, li.sponsor_caption, li.tags_json, li.updated_at, ' +
          'lv.version AS latest_version, lv.title, lv.author, lv.source, lv.review_date, lv.file_id ' +
          'FROM library_items li ' +
          'LEFT JOIN library_versions lv ON lv.item_id = li.id ' +
          'AND lv.version = (SELECT max(version) FROM library_versions WHERE item_id = li.id) ' +
          where +
          ' ORDER BY li.updated_at DESC, li.id DESC',
      )
      .all(...args);
    return res.json({
      items: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        kind: MEDIA_TO_KIND[r.media] || r.media,
        status: r.status,
        audience: r.audience,
        current_version: r.current_version,
        latest_version: r.latest_version,
        author: r.author,
        source: r.source,
        review_date: r.review_date,
        has_media: Boolean(r.file_id),
        tags: JSON.parse(r.tags_json || '[]'),
      })),
      page: 1,
      page_size: 50,
      total,
    });
  });

  app.post('/api/v1/admin/library', (req, res) => {
    const state = idemCached(req, req.user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) return res.status(201).json(state.cached);
    const check = validLibraryBody(req.body || {});
    if (check.error)
      return P.sendError(req, res, 422, check.error, { fields: [{ field: check.field, key: 'err.e-validation' }] });
    const v = check.ok;
    let upload = null;
    if (v.kind !== 'article') {
      upload = db
        .prepare(
          "SELECT * FROM stored_files WHERE id=? AND owner_user_id=? AND purpose='library_media' AND status='temp'",
        )
        .get(v.upload_id, req.user.id);
      if (!upload) return P.sendError(req, res, 415, 'E-FILE-TYPE');
    }
    const current = currentIso();
    const slug = 'mat-' + crypto.randomBytes(6).toString('hex');
    const itemId = db.transaction(() => {
      const info = db
        .prepare(
          "INSERT INTO library_items(slug,media,status,current_version,tags_json,sponsor_caption,created_at,updated_at) VALUES (?,?,'draft',0,?,?,?,?)",
        )
        .run(slug, KIND_TO_MEDIA[v.kind], JSON.stringify(v.tags), v.sponsor, current, current);
      const ver = db
        .prepare(
          'INSERT INTO library_versions(item_id,version,title,summary,body_md,author,source,review_date,file_id,is_stand_in,created_by,created_at) ' +
            'VALUES (?,1,?,?,?,?,?,?,?,0,?,?)',
        )
        .run(
          Number(info.lastInsertRowid),
          v.title,
          null,
          v.markdown,
          v.author,
          v.source,
          v.revision,
          upload ? upload.id : null,
          req.user.id,
          current,
        );
      if (upload)
        db.prepare(
          "UPDATE stored_files SET status='linked', linked_type='library_version', linked_id=?, expires_at=NULL WHERE id=?",
        ).run(Number(ver.lastInsertRowid), upload.id);
      return Number(info.lastInsertRowid);
    })();
    const item = db
      .prepare(
        'SELECT li.id, li.media, lv.title, lv.author, lv.source, lv.review_date FROM library_items li ' +
          'JOIN library_versions lv ON lv.item_id=li.id AND lv.version=1 WHERE li.id=?',
      )
      .get(itemId);
    const response = toItem({
      ...item,
      current_version: 0,
      sponsor_caption: v.sponsor,
      tags_json: JSON.stringify(v.tags),
      summary: null,
      body_md: v.markdown,
      file_id: upload ? upload.id : null,
      duration_s: null,
      is_stand_in: 0,
      version: 1,
      position_s: null,
      position_version: null,
    });
    saveIdem(req.user.id, state, response);
    return res.status(201).json(response);
  });

  app.put('/api/v1/admin/library/:item_id', (req, res) => {
    const item = db.prepare('SELECT * FROM library_items WHERE id=?').get(Number(req.params.item_id));
    if (!item) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const body = req.body || {};
    if (body.version !== undefined && Number(body.version) !== item.current_version)
      return P.sendError(req, res, 409, 'E-CONFLICT');
    const state = idemCached(req, req.user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) return res.json(state.cached);
    const check = validLibraryBody({ ...body, kind: body.kind || MEDIA_TO_KIND[item.media] });
    if (check.error)
      return P.sendError(req, res, 422, check.error, { fields: [{ field: check.field, key: 'err.e-validation' }] });
    const v = check.ok;
    const current = currentIso();
    let upload = null;
    if (v.kind !== 'article') {
      upload = db
        .prepare(
          "SELECT * FROM stored_files WHERE id=? AND owner_user_id=? AND purpose='library_media' AND status IN ('temp','linked')",
        )
        .get(v.upload_id, req.user.id);
      if (!upload) return P.sendError(req, res, 415, 'E-FILE-TYPE');
    }
    const latest = db.transaction(() => {
      const nextVersion = db.prepare('SELECT max(version) m FROM library_versions WHERE item_id=?').get(item.id).m + 1;
      const ver = db
        .prepare(
          'INSERT INTO library_versions(item_id,version,title,summary,body_md,author,source,review_date,file_id,is_stand_in,created_by,created_at) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,0,?,?)',
        )
        .run(
          item.id,
          nextVersion,
          v.title,
          null,
          v.markdown,
          v.author,
          v.source,
          v.revision,
          upload ? upload.id : null,
          req.user.id,
          current,
        );
      if (upload)
        db.prepare(
          "UPDATE stored_files SET status='linked', linked_type='library_version', linked_id=?, expires_at=NULL WHERE id=?",
        ).run(Number(ver.lastInsertRowid), upload.id);
      db.prepare('UPDATE library_items SET sponsor_caption=?, tags_json=?, updated_at=? WHERE id=?').run(
        v.sponsor,
        JSON.stringify(v.tags),
        current,
        item.id,
      );
      return nextVersion;
    })();
    const response = {
      ok: true,
      item: {
        id: item.id,
        status: item.status,
        current_version: item.current_version,
        latest_version: latest,
        kind: MEDIA_TO_KIND[item.media] || item.media,
      },
    };
    saveIdem(req.user.id, state, response);
    return res.json(response);
  });

  app.post('/api/v1/admin/library/:item_id/publish', (req, res) => {
    const item = db.prepare('SELECT * FROM library_items WHERE id=?').get(Number(req.params.item_id));
    if (!item) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const state = idemCached(req, req.user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) return res.json(state.cached);
    if (item.status === 'published') return P.sendError(req, res, 409, 'E-STATUS');
    const latest = db.prepare('SELECT max(version) m FROM library_versions WHERE item_id=?').get(item.id).m;
    if (!latest) return P.sendError(req, res, 409, 'E-STATUS');
    const current = currentIso();
    db.prepare(
      "UPDATE library_items SET status='published', current_version=?, hidden_at=NULL, updated_at=?, published_at=COALESCE(published_at, ?) WHERE id=?",
    ).run(latest, current, current, item.id);
    reindexFts(db);
    const response = { ok: true, item: { id: item.id, status: 'published', current_version: latest } };
    saveIdem(req.user.id, state, response);
    return res.json(response);
  });

  app.post('/api/v1/admin/library/:item_id/withdraw', (req, res) => {
    const item = db.prepare('SELECT * FROM library_items WHERE id=?').get(Number(req.params.item_id));
    if (!item) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const state = idemCached(req, req.user.id);
    if (state.mismatch) return P.sendError(req, res, 409, 'E-IDEMPOTENCY-MISMATCH');
    if (state.cached) return res.json(state.cached);
    if (item.status !== 'published') return P.sendError(req, res, 409, 'E-STATUS');
    const current = currentIso();
    db.prepare("UPDATE library_items SET status='withdrawn', hidden_at=?, updated_at=? WHERE id=?").run(
      current,
      current,
      item.id,
    );
    reindexFts(db);
    const response = { ok: true, item: { id: item.id, status: 'withdrawn' } };
    saveIdem(req.user.id, state, response);
    return res.json(response);
  });

  // Хелперы для страниц сервера (вкладка «Библиотека», страница специалиста).
  return { currentIso, SELECT_PUBLISHED, toItem, KIND_TO_MEDIA, MEDIA_TO_KIND };
}

module.exports = { install, KIND_TO_MEDIA, MEDIA_TO_KIND };
