'use strict';

/**
 * Журнал: выборка, ранжирование и лайки статей. Статьи лежат в library_items/library_versions (media='read'),
 * аудитория — library_items.audience: patient или specialist. Пациент видит только журнал для пациентов,
 * психиатр и психолог — оба.
 *
 * Ранжирование (простой вариант, решение владельца): вес = (1 + лайки) / 2^(возраст_в_днях / 21).
 * Свежие и понравившиеся статьи выше; полураспад — три недели. При равенстве — более новая статья.
 */

const PAGE_SIZE = 6;
const HALF_LIFE_DAYS = 21;
const TOPICS_MAX = 10;
const ROLE_TITLE = { psychiatrist: 'психиатр', psychologist: 'психолог' };
const CLINICIANS = ['psychiatrist', 'psychologist'];

const audiencesFor = (user) => (user && CLINICIANS.includes(user.role) ? ['patient', 'specialist'] : ['patient']);

const topicOf = (tags) => tags.filter((x) => x.startsWith('тема:')).map((x) => x.slice(5).replace(/-/g, ' '));
const minutesOf = (body) =>
  Math.max(
    1,
    Math.round(
      String(body || '')
        .split(/\s+/)
        .filter(Boolean).length / 180,
    ),
  );

function create(db, nowMs) {
  const ROWS = `
    SELECT li.id, li.audience, li.tags_json, li.published_at, li.updated_at, li.status,
           lv.title, lv.summary, lv.body_md, lv.author, lv.cover_file_id, lv.cover_url, lv.ai_assisted,
           au.role AS author_role,
           (SELECT count(*) FROM journal_likes jl WHERE jl.item_id = li.id) AS likes,
           EXISTS (SELECT 1 FROM journal_likes jl WHERE jl.item_id = li.id AND jl.user_id = ?) AS liked
    FROM library_items li
    JOIN library_versions lv ON lv.item_id = li.id AND lv.version = li.current_version
    LEFT JOIN users au ON au.id = li.owner_user_id`;

  function view(row, withBody = false) {
    const tags = JSON.parse(row.tags_json || '[]');
    const out = {
      id: row.id,
      audience: row.audience,
      title: row.title,
      summary: row.summary || '',
      author: row.author,
      author_role: ROLE_TITLE[row.author_role] || null,
      cover_url: row.cover_file_id ? `/library/img/${row.cover_file_id}` : row.cover_url || null,
      tags,
      topics: topicOf(tags),
      minutes: minutesOf(row.body_md),
      published_at: row.published_at || row.updated_at,
      likes: row.likes,
      liked: Boolean(row.liked),
      ai_assisted: Boolean(row.ai_assisted),
    };
    if (withBody) out.body_md = row.body_md || '';
    return out;
  }

  const published = (user, audience) =>
    db
      .prepare(`${ROWS} WHERE li.status='published' AND li.hidden_at IS NULL AND li.media='read' AND li.audience = ?`)
      .all(user.id, audience);

  function score(row) {
    const ageDays = Math.max(0, (nowMs() - Date.parse(row.published_at || row.updated_at)) / 86400000);
    return (1 + row.likes) / 2 ** (ageDays / HALF_LIFE_DAYS);
  }

  /** Страница ленты: { items, page, has_more, topics } — topics для рубрик считаются по всей аудитории. */
  function feed(user, { audience, page = 1, topic = '' }) {
    if (!audiencesFor(user).includes(audience)) return null;
    const all = published(user, audience);
    // Рубрики: десять самых частых тем аудитории.
    const count = new Map();
    for (const r of all)
      for (const x of topicOf(JSON.parse(r.tags_json || '[]'))) count.set(x, (count.get(x) || 0) + 1);
    const topics = [...count.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
      .slice(0, TOPICS_MAX)
      .map(([x]) => x);
    const rows = (topic ? all.filter((r) => topicOf(JSON.parse(r.tags_json || '[]')).includes(topic)) : all)
      .map((r) => ({ r, s: score(r) }))
      .sort((a, b) => b.s - a.s || b.r.id - a.r.id)
      .map((x) => x.r);
    const from = (Math.max(1, page) - 1) * PAGE_SIZE;
    return {
      items: rows.slice(from, from + PAGE_SIZE).map((r) => view(r)),
      page: Math.max(1, page),
      has_more: from + PAGE_SIZE < rows.length,
      total: rows.length,
      topics,
    };
  }

  function article(user, id) {
    const row = db
      .prepare(`${ROWS} WHERE li.id = ? AND li.status='published' AND li.hidden_at IS NULL AND li.media='read'`)
      .get(user.id, Number(id));
    if (!row || !audiencesFor(user).includes(row.audience)) return null;
    return view(row, true);
  }

  /** «Читайте также»: та же аудитория, общие теги; при нехватке — самые популярные. */
  function related(user, item, limit = 3) {
    const mine = new Set(item.tags);
    const rows = published(user, item.audience).filter((r) => r.id !== item.id);
    return rows
      .map((r) => ({ r, common: JSON.parse(r.tags_json || '[]').filter((x) => mine.has(x)).length, s: score(r) }))
      .sort((a, b) => b.common - a.common || b.s - a.s)
      .slice(0, limit)
      .map((x) => view(x.r));
  }

  /** Поставить или снять лайк. Возвращает null, если статьи нет или она недоступна читателю. */
  function setLike(user, id, liked) {
    const item = article(user, id);
    if (!item) return null;
    if (liked)
      db.prepare('INSERT OR IGNORE INTO journal_likes(item_id,user_id,created_at) VALUES (?,?,?)').run(
        item.id,
        user.id,
        new Date(nowMs()).toISOString().replace(/\.\d+Z$/, 'Z'),
      );
    else db.prepare('DELETE FROM journal_likes WHERE item_id=? AND user_id=?').run(item.id, user.id);
    const likes = db.prepare('SELECT count(*) n FROM journal_likes WHERE item_id=?').get(item.id).n;
    return { liked: Boolean(liked), likes };
  }

  // --- Админка: все статьи, правка, снятие, удаление ---------------------------------------------

  function adminList() {
    return db
      .prepare(
        `SELECT li.id, li.status, li.audience, li.tags_json, li.published_at, li.updated_at, lv.title, lv.author,
                (SELECT count(*) FROM journal_likes jl WHERE jl.item_id = li.id) AS likes
         FROM library_items li
         JOIN library_versions lv ON lv.item_id = li.id AND lv.version = CASE WHEN li.status='published' THEN li.current_version ELSE (SELECT max(version) FROM library_versions WHERE item_id = li.id) END
         WHERE li.media = 'read' ORDER BY coalesce(li.published_at, li.updated_at) DESC, li.id DESC`,
      )
      .all()
      .map((r) => ({
        id: r.id,
        status: r.status,
        audience: r.audience,
        title: r.title,
        author: r.author,
        likes: r.likes,
        tags: JSON.parse(r.tags_json || '[]'),
        published_at: r.published_at,
      }));
  }

  function adminGet(id) {
    const row = db
      .prepare(
        `SELECT li.id, li.status, li.audience, li.tags_json, li.published_at, li.updated_at, li.current_version,
                lv.title, lv.summary, lv.body_md, lv.author, lv.cover_file_id, lv.cover_url, lv.version
         FROM library_items li
         JOIN library_versions lv ON lv.item_id = li.id AND lv.version = CASE WHEN li.status='published' THEN li.current_version ELSE (SELECT max(version) FROM library_versions WHERE item_id = li.id) END
         WHERE li.id = ? AND li.media = 'read'`,
      )
      .get(Number(id));
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      audience: row.audience,
      title: row.title,
      summary: row.summary || '',
      body_md: row.body_md || '',
      author: row.author,
      tags: JSON.parse(row.tags_json || '[]'),
      cover_url: row.cover_file_id ? `/library/img/${row.cover_file_id}` : row.cover_url || null,
      version: row.version,
    };
  }

  /** Правка админом — новая версия, автор не меняется. Опубликованная статья обновляется сразу. */
  function adminEdit(adminId, id, f, nowIsoValue) {
    const item = db.prepare("SELECT * FROM library_items WHERE id=? AND media='read'").get(Number(id));
    if (!item) return null;
    const prev = db
      .prepare(
        "SELECT * FROM library_versions WHERE item_id=? AND version=CASE WHEN ?='published' THEN ? ELSE (SELECT max(version) FROM library_versions WHERE item_id=?) END",
      )
      .get(item.id, item.status, item.current_version, item.id);
    const hasAuthorDraft =
      item.status === 'published' && item.draft_version && item.draft_version !== item.current_version;
    db.transaction(() => {
      const next = db.prepare('SELECT max(version)+1 n FROM library_versions WHERE item_id=?').get(item.id).n;
      db.prepare(
        'INSERT INTO library_versions(item_id,version,title,summary,body_md,author,source,review_date,cover_file_id,cover_url,ai_assisted,is_stand_in,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        item.id,
        next,
        f.title ?? prev.title,
        (f.summary ?? prev.summary) || null,
        f.body_md ?? prev.body_md,
        prev.author,
        prev.source,
        nowIsoValue.slice(0, 10),
        prev.cover_file_id,
        f.cover_url !== undefined ? f.cover_url : prev.cover_url,
        prev.ai_assisted,
        prev.is_stand_in,
        adminId,
        nowIsoValue,
      );
      if (!hasAuthorDraft)
        db.prepare('UPDATE library_items SET draft_version=?, draft_tags_json=? WHERE id=?').run(
          next,
          f.tags ? JSON.stringify(f.tags) : item.tags_json,
          item.id,
        );
      db.prepare('UPDATE library_items SET tags_json=?, audience=?, current_version=?, updated_at=? WHERE id=?').run(
        f.tags ? JSON.stringify(f.tags) : item.tags_json,
        f.audience || item.audience,
        item.status === 'published' ? next : item.current_version,
        nowIsoValue,
        item.id,
      );
    })();
    return adminGet(item.id);
  }

  function adminSetStatus(id, status, nowIsoValue) {
    const item = db.prepare("SELECT * FROM library_items WHERE id=? AND media='read'").get(Number(id));
    if (!item) return null;
    if (status === 'published') {
      const latest = db.prepare('SELECT max(version) m FROM library_versions WHERE item_id=?').get(item.id).m;
      db.prepare(
        "UPDATE library_items SET status='published', current_version=?, hidden_at=NULL, updated_at=?, published_at=COALESCE(published_at, ?) WHERE id=?",
      ).run(latest, nowIsoValue, nowIsoValue, item.id);
    } else {
      db.prepare("UPDATE library_items SET status='withdrawn', hidden_at=?, updated_at=? WHERE id=?").run(
        nowIsoValue,
        nowIsoValue,
        item.id,
      );
    }
    return adminGet(item.id);
  }

  function adminDelete(id) {
    const item = db.prepare("SELECT id FROM library_items WHERE id=? AND media='read'").get(Number(id));
    if (!item) return false;
    db.transaction(() => {
      for (const table of ['journal_likes', 'library_chat', 'library_positions', 'library_versions'])
        db.prepare(`DELETE FROM ${table} WHERE item_id=?`).run(item.id);
      db.prepare('DELETE FROM library_items WHERE id=?').run(item.id);
    })();
    return true;
  }

  return { feed, article, related, setLike, adminList, adminGet, adminEdit, adminSetStatus, adminDelete };
}

module.exports = { create, PAGE_SIZE, audiencesFor, topicOf };
