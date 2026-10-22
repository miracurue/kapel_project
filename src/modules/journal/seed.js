'use strict';

/**
 * Демо-наполнение журнала (STAND-IN): статьи из articles.js с картинками из public/journal-img и лайками демо-пользователей.
 * Идемпотентно по slug «journal-<ключ>»: уже внесённые статьи не трогаются, админские правки сохраняются.
 * Авторы — первые активные психиатр и психолог; если их нет, статьи подписываются без привязки к пользователю.
 */

const { PATIENT, SPECIALIST } = require('./articles');
const { reindexFts } = require('../library/seed');

const IMG = {
  'anxiety-window': 'anxiety-window',
  breathing: 'breathing',
  sleep: 'sleep-dusk',
  diary: 'diary-desk',
  'first-weeks': 'first-weeks',
  walk: 'walk-forest',
  'doctor-visit': 'doctor-visit',
  support: 'support-talk',
  food: 'food',
  'red-flags': 'road',
  morning: 'sunrise',
  rumination: 'tree-water',
  yoga: 'yoga',
  loneliness: 'pier',
  night: 'stars',
  gad7: 'laptop',
  'diary-adherence': 'pen',
  'side-effects': 'notebook',
  'remote-limits': 'mountains',
  burnout: 'sunset-figure',
  mi: 'river',
  'benzo-caution': 'field',
  team: 'team',
};
const MED_COVERS = ['meadow', 'first-weeks', 'doctor-visit', 'food', 'sunrise', 'walk-forest', 'sleep-dusk'];
const SOURCE = 'Авторский материал специалиста';
const FALLBACK_AUTHORS = ['Демо Психиатр', 'Демо Психолог'];

function ensureJournalSeed(db, P, nowDate) {
  const doctors = db
    .prepare("SELECT id, full_name FROM users WHERE role IN ('psychiatrist','psychologist') AND status='active' ORDER BY id")
    .all();
  const voters = db
    .prepare("SELECT id FROM users WHERE role IN ('patient','psychiatrist','psychologist') AND status='active' ORDER BY id")
    .all();
  const authorOf = (index) => doctors[index % Math.max(1, doctors.length)] || null;
  const have = new Set(db.prepare("SELECT slug FROM library_items WHERE slug LIKE 'journal-%'").all().map((r) => r.slug));
  let added = 0;
  const insertItem = db.prepare(
    "INSERT INTO library_items(slug,media,status,current_version,tags_json,owner_user_id,audience,published_at,created_at,updated_at) VALUES (?,'read','published',1,?,?,?,?,?,?)",
  );
  const insertVersion = db.prepare(
    'INSERT INTO library_versions(item_id,version,title,summary,body_md,author,source,review_date,cover_url,is_stand_in,created_by,created_at) VALUES (?,1,?,?,?,?,?,?,?,1,?,?)',
  );
  const like = db.prepare('INSERT OR IGNORE INTO journal_likes(item_id,user_id,created_at) VALUES (?,?,?)');
  db.transaction(() => {
    for (const [audience, list] of [
      ['patient', PATIENT],
      ['specialist', SPECIALIST],
    ]) {
      for (const a of list) {
        const slug = `journal-${audience}-${a.key}`;
        if (have.has(slug)) continue;
        const owner = authorOf(a.author);
        const when = P.iso(new Date(nowDate.getTime() - a.days * 86400000));
        const info = insertItem.run(slug, JSON.stringify(a.tags), owner ? owner.id : null, audience, when, when, when);
        const id = Number(info.lastInsertRowid);
        insertVersion.run(
          id,
          a.title,
          a.summary,
          a.body,
          owner ? owner.full_name : FALLBACK_AUTHORS[a.author % 2],
          SOURCE,
          when.slice(0, 10),
          `/journal-img/${IMG[a.key]}.jpg`,
          owner ? owner.id : null,
          when,
        );
        // Лайки ставят первые N демо-пользователей, у каждой статьи свой сдвиг — чтобы набор лайкнувших отличался.
        for (let i = 0; i < Math.min(a.likes, voters.length); i += 1)
          like.run(id, voters[(i + id) % voters.length].id, when);
        added += 1;
      }
    }
    // Другие опубликованные статьи (примеры о препаратах и пр.) пришли без картинок — даём им обложки из каталога журнала.
    const bare = db
      .prepare(
        "SELECT lv.id FROM library_items li JOIN library_versions lv ON lv.item_id=li.id AND lv.version=li.current_version WHERE li.media='read' AND li.status='published' AND lv.cover_url IS NULL AND lv.cover_file_id IS NULL ORDER BY li.id",
      )
      .all();
    bare.forEach((row, i) =>
      db.prepare('UPDATE library_versions SET cover_url=? WHERE id=?').run(`/journal-img/${MED_COVERS[i % MED_COVERS.length]}.jpg`, row.id),
    );
    if (added) reindexFts(db);
  })();
  return added;
}

module.exports = { ensureJournalSeed };
