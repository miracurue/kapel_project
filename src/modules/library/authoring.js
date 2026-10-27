'use strict';

/**
 * Библиотека как рабочее место специалиста: психиатр и психолог пишут материалы, вставляют картинки,
 * генерируют черновик ИИ по основным мыслям и публикуют под своим именем (решение владельца 2026-10-19:
 * публикация без проверки администратором, с подписью автора и пометкой; снять материал может автор или админ).
 * Пути — вне замороженного /api/v1: /work/api/library*, картинки — /library/img/:id.
 * Материалы пишутся в те же library_items/library_versions, поэтому пациент читает их через обычный /api/v1/library.
 * Теги: «препарат:<МНН>» и «тема:<тема>» — по ним в карточке лекарства подбираются статьи.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { reindexFts } = require('./seed');

const TITLE_MAX = 200;
const SUMMARY_MAX = 400;
const BODY_MAX = 100000;
const THOUGHTS_MAX = 3000;
const FRAGMENT_MAX = 3000;
const INSTRUCTION_MAX = 500;
const CONTEXT_MAX = 1000;
const AUDIENCES = ['patient', 'specialist'];
// Журнал для пациентов и журнал для специалистов пишутся по разным задачам каталога (админка → Настройки → Промпт → Задачи).
const DRAFT_PROMPT = { patient: 'task.article_patient', specialist: 'task.article_specialist' };
const AUDIENCE_LABEL = { patient: 'пациенты', specialist: 'специалисты' };
const SOURCE = 'Авторский материал специалиста';
const ROLE_TITLE = { psychiatrist: 'психиатр', psychologist: 'психолог' };

// Тег: буквы, цифры, пробел, дефис, двоеточие; «препарат:» и «тема:» — служебные префиксы.
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

const normInn = (name) =>
  String(name || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е');

/**
 * Опубликованные статьи по препарату: тег «препарат:<МНН>» (статьи именно об этом препарате)
 * и общие статьи с тегом «тема:…» без тега препарата (подходят любому). Для карточки лекарства пациента.
 */
function articlesForInn(db, innName) {
  const key = `препарат:${normInn(innName)}`;
  const rows = db
    .prepare(
      `SELECT li.id, li.tags_json, lv.title, lv.summary, lv.author, lv.cover_file_id, lv.cover_url, lv.ai_assisted, lv.is_stand_in
       FROM library_items li JOIN library_versions lv ON lv.item_id=li.id AND lv.version=li.current_version
       WHERE li.status='published' AND li.hidden_at IS NULL AND li.media='read' AND li.audience='patient' ORDER BY li.id`,
    )
    .all();
  const view = (r, tags) => ({
    id: r.id,
    title: r.title,
    summary: r.summary || '',
    author: r.author,
    tags,
    cover_url: r.cover_file_id ? `/library/img/${r.cover_file_id}` : r.cover_url || null,
    ai_assisted: Boolean(r.ai_assisted),
    stand_in: Boolean(r.is_stand_in),
  });
  const specific = [];
  const general = [];
  for (const r of rows) {
    const tags = JSON.parse(r.tags_json || '[]');
    if (tags.includes(key)) specific.push(view(r, tags));
    else if (!tags.some((t) => t.startsWith('препарат:')) && tags.some((t) => t.startsWith('тема:')))
      general.push(view(r, tags));
  }
  return { specific, general };
}

/** Разбор ответа модели; если формат не соблюдён, весь текст становится телом. */
function parseDraft(text, fallbackTitle) {
  const raw = String(text || '')
    .replace(/\r\n?/g, '\n')
    .trim();
  const field = (name) => {
    const m = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(raw);
    return m ? m[1].trim() : '';
  };
  const split = raw.indexOf('\n---');
  const body = (split >= 0 ? raw.slice(split + 4) : raw).trim();
  // Нет строки «ЗАГОЛОВОК:» — берём заголовок ## из текста или первое предложение.
  const guessed = (/^#{1,3}\s+(.+)$/m.exec(body) || [])[1] || body.split(/(?<=[.!?])\s|\n/)[0] || '';
  const title =
    field('ЗАГОЛОВОК') ||
    fallbackTitle ||
    guessed
      .replace(/[#*_`]/g, '')
      .trim()
      .slice(0, 80);
  const tags = cleanTags(field('ТЕГИ').split(','));
  const words = body.split(/\s+/).filter(Boolean).length;
  return {
    title: title.slice(0, TITLE_MAX),
    summary: field('КРАТКО').slice(0, SUMMARY_MAX),
    tags,
    body_md: body.slice(0, BODY_MAX),
    minutes: Math.max(1, Math.round(words / 180)),
  };
}

function install(app, h) {
  const { db, P, config, pii, gateway, nowIso } = h;

  const guard = (req, res, mutating) => {
    const user = req.user;
    if (!user) {
      P.sendError(req, res, 401, 'E-SESSION-EXPIRED');
      return null;
    }
    if (!['psychiatrist', 'psychologist'].includes(user.role)) {
      P.sendError(req, res, 403, 'E-ACCESS');
      return null;
    }
    if (mutating && (!req.session || req.headers['x-csrf-token'] !== req.session.data.csrf)) {
      P.sendError(req, res, 403, 'E-CSRF');
      return null;
    }
    return user;
  };
  const invalid = (req, res, field) =>
    P.sendError(req, res, 422, 'E-VALIDATION', { fields: [{ field, key: 'err.e-validation' }] });

  const ownItem = (user, id) =>
    db.prepare('SELECT * FROM library_items WHERE id=? AND owner_user_id=?').get(Number(id), user.id);
  const latestVersion = (itemId) =>
    db
      .prepare(
        'SELECT * FROM library_versions WHERE item_id=? AND version=COALESCE((SELECT draft_version FROM library_items WHERE id=?),(SELECT max(version) FROM library_versions WHERE item_id=?))',
      )
      .get(itemId, itemId, itemId);

  const view = (item, ver, user) => ({
    id: item.id,
    status: item.status,
    audience: item.audience,
    title: ver.title,
    summary: ver.summary || '',
    body_md: ver.body_md || '',
    tags: JSON.parse(item.draft_tags_json || item.tags_json || '[]'),
    has_unpublished_changes: item.status === 'published' && ver.version !== item.current_version,
    cover_url: ver.cover_file_id ? `/library/img/${ver.cover_file_id}` : ver.cover_url || null,
    cover_file_id: ver.cover_file_id || null,
    ai_assisted: Boolean(ver.ai_assisted),
    version: ver.version,
    updated_at: item.updated_at,
    author: { name: user.full_name || '', role: ROLE_TITLE[user.role] || '' },
  });

  // Поля из тела запроса; undefined — «не менять».
  function fields(body) {
    const b = body || {};
    const out = {};
    if (b.title !== undefined) out.title = String(b.title).trim().slice(0, TITLE_MAX);
    if (b.summary !== undefined) out.summary = String(b.summary).trim().slice(0, SUMMARY_MAX);
    if (b.body_md !== undefined) out.body_md = String(b.body_md).replace(/\r\n?/g, '\n').slice(0, BODY_MAX);
    if (b.tags !== undefined) out.tags = cleanTags(b.tags);
    if (b.audience !== undefined) out.audience = AUDIENCES.includes(b.audience) ? b.audience : null;
    if (b.ai_assisted !== undefined) out.ai_assisted = b.ai_assisted ? 1 : 0;
    if (b.cover_file_id !== undefined) out.cover_file_id = b.cover_file_id === null ? null : Number(b.cover_file_id);
    return out;
  }

  // Обложка — только картинка, которую этот автор уже прикрепил к этому материалу.
  const coverOk = (user, item, fileId) =>
    fileId === null ||
    Boolean(
      db
        .prepare(
          "SELECT 1 FROM stored_files WHERE id=? AND owner_user_id=? AND purpose='library_media' AND linked_type='library_item' AND linked_id=? AND mime LIKE 'image/%' AND status='linked'",
        )
        .get(fileId, user.id, item.id),
    );

  function writeVersion(user, item, f) {
    const prev = latestVersion(item.id);
    const next = db.prepare('SELECT COALESCE(max(version),0)+1 n FROM library_versions WHERE item_id=?').get(item.id).n;
    const t = nowIso();
    const merged = {
      title: f.title ?? prev?.title ?? '',
      summary: f.summary ?? prev?.summary ?? '',
      body_md: f.body_md ?? prev?.body_md ?? '',
      ai_assisted: f.ai_assisted ?? prev?.ai_assisted ?? 0,
      cover_file_id: f.cover_file_id !== undefined ? f.cover_file_id : (prev?.cover_file_id ?? null),
    };
    db.prepare(
      'INSERT INTO library_versions(item_id,version,title,summary,body_md,author,source,review_date,cover_file_id,cover_url,ai_assisted,is_stand_in,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)',
    ).run(
      item.id,
      next,
      merged.title || 'Без названия',
      merged.summary || null,
      merged.body_md,
      user.full_name || '',
      SOURCE,
      t.slice(0, 10),
      merged.cover_file_id,
      merged.cover_file_id ? null : (prev?.cover_url ?? null),
      merged.ai_assisted,
      user.id,
      t,
    );
    const tags = f.tags !== undefined ? JSON.stringify(f.tags) : item.draft_tags_json || item.tags_json;
    db.prepare('UPDATE library_items SET draft_tags_json=?, draft_version=?, updated_at=? WHERE id=?').run(
      tags,
      next,
      t,
      item.id,
    );
    return next;
  }

  app.get('/work/api/library', (req, res) => {
    const user = guard(req, res, false);
    if (!user) return undefined;
    const mine = db
      .prepare(
        `SELECT li.id, li.status, li.audience, li.tags_json, li.draft_tags_json, li.updated_at, lv.title, lv.cover_file_id, lv.cover_url
         FROM library_items li JOIN library_versions lv ON lv.item_id=li.id AND lv.version=COALESCE(li.draft_version,(SELECT max(version) FROM library_versions WHERE item_id=li.id))
         WHERE li.owner_user_id=? ORDER BY li.updated_at DESC, li.id DESC`,
      )
      .all(user.id)
      .map((r) => ({
        id: r.id,
        status: r.status,
        audience: r.audience,
        title: r.title,
        tags: JSON.parse(r.draft_tags_json || r.tags_json || '[]'),
        updated_at: r.updated_at,
        cover_url: r.cover_file_id ? `/library/img/${r.cover_file_id}` : r.cover_url || null,
      }));
    return res.json({ mine });
  });

  // «Чего не хватает»: препараты в действующих планах пациентов специалиста, по которым нет опубликованной статьи.
  app.get('/work/api/library/gaps', (req, res) => {
    const user = guard(req, res, false);
    if (!user) return undefined;
    const rows = db
      .prepare(
        `SELECT i.name, count(DISTINCT ca.patient_id) n
         FROM care_assignments ca
         JOIN plan_versions pv ON pv.patient_id=ca.patient_id AND pv.status='published'
           AND pv.version=(SELECT max(version) FROM plan_versions WHERE patient_id=ca.patient_id AND status='published')
         JOIN plan_items pi ON pi.plan_version_id=pv.id AND pi.status='active'
         JOIN inn i ON i.id=pi.inn_id
         WHERE ca.clinician_id=? AND ca.ended_at IS NULL GROUP BY i.name ORDER BY n DESC, i.name`,
      )
      .all(user.id);
    const gaps = rows
      .filter((r) => articlesForInn(db, r.name).specific.length === 0)
      .map((r) => ({ inn: r.name, patients: r.n }));
    return res.json({ gaps });
  });

  app.get('/work/api/library/:id', (req, res) => {
    const user = guard(req, res, false);
    if (!user) return undefined;
    const item = ownItem(user, req.params.id);
    if (!item) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    return res.json(view(item, latestVersion(item.id), user));
  });

  // Беседа с ИИ по статье: реплики автора (с обратной подстановкой имён) и отметки об ответах ИИ — сам текст ответа
  // уже лежит в статье, в ленте он не повторяется.
  app.get('/work/api/library/:id/chat', (req, res) => {
    const user = guard(req, res, false);
    if (!user) return undefined;
    const item = ownItem(user, req.params.id);
    if (!item) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const scope = { scopeType: 'thread', scopeId: -user.id };
    const rows = db
      .prepare('SELECT role, text, status, created_at FROM library_chat WHERE item_id=? ORDER BY id')
      .all(item.id);
    return res.json({
      messages: rows.map((r) => ({
        role: r.role,
        text: r.role === 'user' ? pii.reveal(r.text, scope).text : '',
        status: r.status,
        created_at: r.created_at,
      })),
    });
  });

  app.post('/work/api/library', (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const f = fields(req.body);
    if (f.cover_file_id) return invalid(req, res, 'cover_file_id'); // картинка прикрепляется к уже созданному материалу
    if (f.audience === null) return invalid(req, res, 'audience');
    const t = nowIso();
    const id = db.transaction(() => {
      const info = db
        .prepare(
          "INSERT INTO library_items(slug,media,status,current_version,tags_json,owner_user_id,audience,created_at,updated_at) VALUES (?,'read','draft',0,?,?,?,?,?)",
        )
        .run(
          `mat-${crypto.randomBytes(6).toString('hex')}`,
          JSON.stringify(f.tags || []),
          user.id,
          f.audience || 'patient',
          t,
          t,
        );
      const item = db.prepare('SELECT * FROM library_items WHERE id=?').get(Number(info.lastInsertRowid));
      writeVersion(user, item, { ...f, tags: undefined });
      return item.id;
    })();
    const item = db.prepare('SELECT * FROM library_items WHERE id=?').get(id);
    return res.status(201).json(view(item, latestVersion(id), user));
  });

  app.put('/work/api/library/:id', (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const item = ownItem(user, req.params.id);
    if (!item) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const f = fields(req.body);
    if (f.cover_file_id !== undefined && !coverOk(user, item, f.cover_file_id))
      return invalid(req, res, 'cover_file_id');
    if (f.audience === null) return invalid(req, res, 'audience');
    // Опубликованную статью нельзя незаметно перенести в другой журнал: сначала снять с публикации.
    if (f.audience !== undefined && f.audience !== item.audience && item.status === 'published')
      return P.sendError(req, res, 409, 'E-STATUS');
    db.transaction(() => {
      if (f.audience !== undefined && f.audience !== item.audience)
        db.prepare('UPDATE library_items SET audience=? WHERE id=?').run(f.audience, item.id);
      writeVersion(user, item, f);
    })();
    const fresh = db.prepare('SELECT * FROM library_items WHERE id=?').get(item.id);
    return res.json(view(fresh, latestVersion(item.id), user));
  });

  app.post('/work/api/library/:id/publish', (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const item = ownItem(user, req.params.id);
    if (!item) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const ver = latestVersion(item.id);
    if (!ver || !ver.title.trim() || ver.title === 'Без названия' || !String(ver.body_md || '').trim())
      return invalid(req, res, 'body_md');
    db.prepare(
      "UPDATE library_items SET status='published', tags_json=COALESCE(draft_tags_json,tags_json), current_version=?, hidden_at=NULL, updated_at=?, published_at=COALESCE(published_at, ?) WHERE id=?",
    ).run(ver.version, nowIso(), nowIso(), item.id);
    reindexFts(db);
    return res.json({ id: item.id, status: 'published', version: ver.version });
  });

  app.post('/work/api/library/:id/unpublish', (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const item = ownItem(user, req.params.id);
    if (!item) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    if (item.status !== 'published') return P.sendError(req, res, 409, 'E-STATUS');
    const t = nowIso();
    db.prepare("UPDATE library_items SET status='withdrawn', hidden_at=?, updated_at=? WHERE id=?").run(t, t, item.id);
    reindexFts(db);
    return res.json({ id: item.id, status: 'withdrawn' });
  });

  // Картинка: файл сначала грузится обычным POST /api/v1/uploads (очистка EXIF, проверка сигнатуры),
  // затем прикрепляется к материалу и становится постоянным.
  app.post('/work/api/library/:id/image', (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const item = ownItem(user, req.params.id);
    if (!item) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const file = db
      .prepare("SELECT * FROM stored_files WHERE id=? AND owner_user_id=? AND status='temp' AND mime LIKE 'image/%'")
      .get(Number(req.body && req.body.upload_id), user.id);
    if (!file) return P.sendError(req, res, 415, 'E-FILE-TYPE');
    db.prepare(
      "UPDATE stored_files SET purpose='library_media', status='linked', linked_type='library_item', linked_id=?, expires_at=NULL WHERE id=?",
    ).run(item.id, file.id);
    return res
      .status(201)
      .json({ file_id: file.id, url: `/library/img/${file.id}`, markdown: `![](/library/img/${file.id})` });
  });

  // Отдача картинки: опубликованный материал — любой роли с доступом к библиотеке; черновик — только автору.
  app.get('/library/img/:fileId', (req, res) => {
    const user = req.user;
    if (!user) return P.sendError(req, res, 401, 'E-SESSION-EXPIRED');
    if (!['patient', 'psychiatrist', 'psychologist'].includes(user.role))
      return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const file = db
      .prepare(
        "SELECT * FROM stored_files WHERE id=? AND status='linked' AND purpose='library_media' AND linked_type='library_item' AND mime LIKE 'image/%'",
      )
      .get(Number(req.params.fileId));
    const item = file && db.prepare('SELECT * FROM library_items WHERE id=?').get(file.linked_id);
    const publishedVersion =
      item &&
      db
        .prepare('SELECT cover_file_id, body_md FROM library_versions WHERE item_id=? AND version=?')
        .get(item.id, item.current_version);
    const referenced =
      publishedVersion &&
      (publishedVersion.cover_file_id === file.id ||
        String(publishedVersion.body_md || '').includes(`/library/img/${file.id})`));
    const visible =
      item &&
      referenced &&
      item.status === 'published' &&
      !item.hidden_at &&
      (item.audience === 'patient' || user.role !== 'patient');
    if (!item || !(visible || item.owner_user_id === user.id)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    const filePath = path.join(config.dataDir, 'files', file.storage_name);
    if (!fs.existsSync(filePath)) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    res.setHeader('Content-Type', file.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.send(fs.readFileSync(filePath));
  });

  // Кнопка «ИИ»: основные мысли автора → заголовок, краткое, теги и текст. Данных пациентов в запросе нет;
  // мысли проходят псевдонимизацию F-80, ответ — пост-фильтр шлюза.
  app.post('/work/api/library/ai', async (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const thoughts = String((req.body && req.body.thoughts) || '')
      .replace(/\r\n?/g, '\n')
      .trim()
      .slice(0, THOUGHTS_MAX);
    if (!thoughts) return invalid(req, res, 'thoughts');
    const audience = req.body && req.body.audience === undefined ? 'patient' : req.body && req.body.audience;
    if (!AUDIENCES.includes(audience)) return invalid(req, res, 'audience');
    // Беседа привязана к статье: вся прежняя переписка этой статьи уходит модели вместе с новой репликой.
    let item = null;
    if (req.body.item_id !== undefined && req.body.item_id !== null) {
      item = ownItem(user, req.body.item_id);
      if (!item) return P.sendError(req, res, 404, 'E-NOT-FOUND');
    }
    const draftNow = req.body.current || (item ? latestVersion(item.id) : {}) || {};
    const curTitle = String(draftNow.title || '')
      .trim()
      .slice(0, TITLE_MAX);
    const curBody = String(draftNow.body_md || '')
      .replace(/\r\n?/g, '\n')
      .trim()
      .slice(0, BODY_MAX);
    let attemptId = null;
    try {
      const scope = { scopeType: 'thread', scopeId: -user.id };
      const ner = await pii.nerDetect(thoughts);
      const pseudo = pii.pseudonymize(thoughts, scope, { nerEntities: ner.entities, nerOk: ner.ok });
      // Текущий текст статьи (если есть) идёт отдельным полем: тогда ИИ правит его по реплике автора.
      let message = pseudo.text;
      if (curBody) {
        const articleText = `${curTitle}\n\n${curBody}`;
        const nerBody = await pii.nerDetect(articleText);
        const body = pii.pseudonymize(articleText, scope, {
          nerEntities: nerBody.entities,
          nerOk: nerBody.ok,
        });
        message = `ТЕКУЩИЙ ТЕКСТ СТАТЬИ (заголовок и текст):\n${body.text}\n\nСООБЩЕНИЕ АВТОРА: ${pseudo.text}`;
      }
      const history = item
        ? db
            .prepare(
              "SELECT role, text FROM (SELECT id, role, text FROM library_chat WHERE item_id=? AND status='done' ORDER BY id DESC LIMIT 20) ORDER BY id",
            )
            .all(item.id)
        : [];
      if (item) {
        attemptId = Number(
          db
            .prepare("INSERT INTO library_chat(item_id,role,text,status,created_at) VALUES (?,'user',?,'pending',?)")
            .run(item.id, pseudo.text, nowIso()).lastInsertRowid,
        );
      }
      const finish = (status) => {
        if (attemptId) db.prepare('UPDATE library_chat SET status=? WHERE id=?').run(status, attemptId);
      };
      const out = await gateway.run({
        purpose: 'document_draft',
        promptKey: DRAFT_PROMPT[audience],
        user,
        history,
        text: message,
        question: thoughts,
        piiCounts: pseudo.counts || {},
        piiMode: pseudo.mode,
      });
      // Нецелевой запрос (слой guard.scope_clinician): сообщение в чате, статья и её версии не меняются, попытка не сохраняется.
      if (out.offTopic) {
        if (attemptId) db.prepare('DELETE FROM library_chat WHERE id=?').run(attemptId);
        return res.json({ off_topic: true, message: out.text });
      }
      if (out.status === 'filtered') {
        finish('error');
        return P.sendError(req, res, 502, 'E-AI-UNAVAILABLE');
      }
      const draft = parseDraft(pii.reveal(out.text, scope).text, String((req.body && req.body.title) || '').trim());
      if (!draft.body_md) {
        finish('error');
        return P.sendError(req, res, 502, 'E-AI-EMPTY');
      }
      if (item) {
        const add = db.prepare('INSERT INTO library_chat(item_id,role,text,created_at) VALUES (?,?,?,?)');
        db.transaction(() => {
          finish('done');
          writeVersion(user, item, { ...draft, ai_assisted: 1 });
          add.run(item.id, 'assistant', out.text, nowIso());
        })();
      }
      return res.json({ ...draft, audience, ai_assisted: true });
    } catch (e) {
      if (attemptId) db.prepare("UPDATE library_chat SET status='error' WHERE id=?").run(attemptId);
      if (h.isGatewayError(e)) return h.sendGatewayError(res, e);
      throw e;
    }
  });

  // Правка выделенного фрагмента: автор выделил слово/абзац и (необязательно) написал задание. Данных пациентов в запросе
  // нет; все поля проходят псевдонимизацию F-80 одним текстом, инструкция берётся из каталога промптов (article_rewrite).
  app.post('/work/api/library/ai/rewrite', async (req, res) => {
    const user = guard(req, res, true);
    if (!user) return undefined;
    const b = req.body || {};
    const norm = (v, max) =>
      String(v || '')
        .replace(/\r\n?/g, '\n')
        .slice(0, max);
    const fragment = norm(b.fragment, FRAGMENT_MAX).trim();
    if (!fragment) return invalid(req, res, 'fragment');
    const audience = b.audience === undefined ? 'patient' : b.audience;
    if (!AUDIENCES.includes(audience)) return invalid(req, res, 'audience');
    const instruction = norm(b.instruction, INSTRUCTION_MAX).trim();
    // Контекст — хвост текста перед фрагментом и начало после него.
    const before = norm(b.context_before, 100000).slice(-CONTEXT_MAX).trim();
    const after = norm(b.context_after, CONTEXT_MAX).trim();
    const message = [
      `АУДИТОРИЯ: ${AUDIENCE_LABEL[audience]}`,
      instruction && `ЗАДАНИЕ: ${instruction}`,
      before && `ПЕРЕД ФРАГМЕНТОМ: ${before}`,
      after && `ПОСЛЕ ФРАГМЕНТА: ${after}`,
      `ФРАГМЕНТ: ${fragment}`,
    ]
      .filter(Boolean)
      .join('\n');
    try {
      const scope = { scopeType: 'thread', scopeId: -user.id };
      const ner = await pii.nerDetect(message);
      const pseudo = pii.pseudonymize(message, scope, { nerEntities: ner.entities, nerOk: ner.ok });
      const out = await gateway.run({
        purpose: 'document_draft',
        promptKey: 'task.article_rewrite',
        user,
        text: pseudo.text,
        piiCounts: pseudo.counts || {},
        piiMode: pseudo.mode,
      });
      if (out.offTopic) return res.json({ off_topic: true, message: out.text });
      if (out.status === 'filtered') return P.sendError(req, res, 502, 'E-AI-UNAVAILABLE');
      const text = pii
        .reveal(out.text, scope)
        .text.replace(/^\s*ФРАГМЕНТ:\s*/i, '')
        .trim()
        .slice(0, FRAGMENT_MAX * 2);
      if (!text) return P.sendError(req, res, 502, 'E-AI-EMPTY');
      return res.json({ text, ai_assisted: true });
    } catch (e) {
      if (h.isGatewayError(e)) return h.sendGatewayError(res, e);
      throw e;
    }
  });
}

module.exports = { install, articlesForInn, cleanTags, parseDraft };
