'use strict';
// covers: DB hardening, upgrade, privacy, WAL restore, F-39 F-52 F-53.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const svc = require('../../src/modules/diary/service');
const storage = require('../../src/modules/diary/storage');
const visibility = require('../../src/modules/diary/visibility');
const root = path.resolve(__dirname, '../..');
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-db-hardening-'));
  const file = path.join(dir, 'a.sqlite3');
  execFileSync(process.execPath, [path.join(root, 'scripts/migrate.js')], {
    env: { ...process.env, DB_PATH: file },
    stdio: 'pipe',
  });
  const db = new Database(file);
  db.pragma('foreign_keys=ON');
  db.prepare("INSERT INTO users(id,service_no,role,full_name) VALUES (901,'DB-901','patient','Synthetic')").run();
  return {
    db,
    file,
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('typed habits reject wrong values and maintain choice ordinal and bounds', () => {
  for (const [h, value] of [
    [{ type: 'count' }, -1],
    [{ type: 'count' }, 1.5],
    [{ type: 'time' }, 1440],
    [{ type: 'scale', minimum: 1, maximum: 5 }, 6],
    [{ type: 'check' }, 9],
    [{ type: 'choice', choices: ['a', 'b'] }, 3],
  ]) {
    const s = svc.empty();
    s.habits = [{ id: 'h', name: 'h', shared: false, ...h }];
    s.entries = { h: { '2026-10-21': [value] } };
    assert.throws(() => svc.normalize(s));
  }
  const s = svc.empty();
  s.habits = [{ id: 'h', name: 'h', shared: false, type: 'choice', choices: ['a', 'b'] }];
  s.entries = { h: { '2026-10-21': [2] } };
  assert.doesNotThrow(() => svc.normalize(s));
});
test('measurements preserve IDs and hidden revision history; archive, versions and export retain data', () => {
  const f = fixture();
  try {
    const store = svc.create(f.db);
    let s = svc.empty();
    s.habits = [{ id: 'water', name: 'Water', shared: false, type: 'measure', unit: 'ml' }];
    s.entries = { water: { '2026-10-21': [100, 200] } };
    s.dayNotes = [{ id: 'n', day: '2026-10-21', text: 'first', shared: false }];
    let r = store.save(901, 0, s, '2026-10-21', '2026-10-21T01:00:00Z');
    const first = f.db.prepare('SELECT * FROM diary_habit_values ORDER BY id').all();
    r.state.entries.water['2026-10-21'].push(300);
    r.state.dayNotes[0].text = 'second';
    r.state.habits[0].name = 'Water renamed';
    r = store.save(901, r.revision, r.state, '2026-10-21', '2026-10-21T02:00:00Z');
    assert.equal(f.db.prepare('SELECT id,recorded_at FROM diary_habit_values WHERE ordinal=0').get().id, first[0].id);
    assert.equal(f.db.prepare('SELECT count(*) n FROM diary_habit_versions').get().n, 2);
    assert.equal(f.db.prepare('SELECT text FROM diary_note_revisions').get().text, 'first');
    assert.throws(() => f.db.prepare("UPDATE diary_habit_versions SET definition_json='{}'").run(), /immutable/);
    r.state.entries.water['2026-10-21'][1] = 250;
    r = store.save(901, r.revision, r.state, '2026-10-21', '2026-10-21T03:00:00Z');
    assert.equal(
      f.db.prepare('SELECT value_number FROM diary_habit_values WHERE hidden_at IS NOT NULL').get().value_number,
      200,
    );
    r.state.habits = [];
    r.state.entries = {};
    store.save(901, r.revision, r.state, '2026-10-21', '2026-10-21T04:00:00Z');
    assert.equal(store.read(901).state.habits.length, 0);
    assert.equal(storage.exportData(f.db, 901).measurements.length, 4);
    assert.equal(f.db.pragma('foreign_key_check').length, 0);
  } finally {
    f.close();
  }
});
test('hidden wellbeing never returns from JSON and missing preferences deny specialist notes', () => {
  const f = fixture();
  try {
    const s = svc.empty();
    s.wellbeings['2026-10-21'] = { mood: 5 };
    svc.create(f.db).save(901, 0, s, '2026-10-21', '2026-10-21T01:00:00Z');
    f.db.prepare("UPDATE mood_entries SET hidden_at='2026-10-21T02:00:00Z' WHERE patient_id=901").run();
    assert.deepEqual(svc.create(f.db).read(901).state.wellbeings, {});
    const stale = svc.create(f.db).save(901, 1, s, '2026-10-21', '2026-10-21T03:00:00Z');
    assert.equal(stale.conflict, 2, 'legacy hide invalidates stale workspace revision');
    assert.equal(visibility.notesVisible(f.db, 901, { id: 2, role: 'psychiatrist' }), false);
  } finally {
    f.close();
  }
});
test('migration rerun consistent backup includes committed WAL and restores integrity', () => {
  const f = fixture();
  try {
    f.db.pragma('journal_mode=WAL');
    f.db.pragma('wal_autocheckpoint=0');
    f.db.prepare("UPDATE users SET full_name='WAL_LAST_VALUE' WHERE id=901").run();
    // Force a pending migration without modifying the checksum-protected source file.
    f.db.prepare('DELETE FROM schema_migrations WHERE version=25').run();
    // Create a disposable copy of runner/migrations with one harmless migration.
    const runner = path.join(f.file + '.runner');
    fs.mkdirSync(path.join(runner, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(runner, 'migrations'));
    fs.copyFileSync(path.join(root, 'scripts/migrate.js'), path.join(runner, 'scripts/migrate.js'));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(runner, 'node_modules'), 'dir');
    // Next free number after the real migrations, so new migrations never collide with the probe.
    const probe = String(
      Math.max(...fs.readdirSync(path.join(root, 'migrations')).map((name) => Number(name.slice(0, 4)))) + 1,
    ).padStart(4, '0');
    fs.writeFileSync(
      path.join(runner, `migrations/${probe}_probe.sql`),
      'CREATE TABLE backup_probe(id INTEGER PRIMARY KEY) STRICT;',
    );
    execFileSync(process.execPath, [path.join(runner, 'scripts/migrate.js')], {
      env: { ...process.env, DB_PATH: f.file },
      stdio: 'pipe',
    });
    const restored = new Database(f.file + `.before-${probe}.bak`);
    assert.equal(restored.prepare('SELECT full_name FROM users WHERE id=901').get().full_name, 'WAL_LAST_VALUE');
    assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(restored.pragma('foreign_key_check'), []);
    restored.close();
  } finally {
    f.close();
  }
});

test('upgrade transfers more than 500 ordered values and private notes without inventing measurement times', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-diary-upgrade-'));
  const db = new Database(path.join(dir, 'upgrade.sqlite3'));
  try {
    db.pragma('foreign_keys=ON');
    for (const file of fs
      .readdirSync(path.join(root, 'migrations'))
      .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= 23)
      .sort())
      db.exec(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
    db.prepare("INSERT INTO users(id,service_no,role,full_name) VALUES (901,'DB-901','patient','Synthetic')").run();
    const state = svc.empty();
    state.habits = [{ id: 'water', name: 'Water', shared: false, type: 'measure', unit: 'ml' }];
    state.entries.water = {};
    for (let i = 0; i < 600; i += 1) {
      const day = new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10);
      state.entries.water[day] = [100, 200, 300];
      state.dayNotes.push({ id: `note-${i}`, day, text: `private-${i}`, shared: false });
    }
    db.prepare('INSERT INTO diary_workspaces(patient_id,revision,state_json,updated_at) VALUES (901,42,?,?)').run(
      JSON.stringify(state),
      '2026-10-21T00:00:00Z',
    );
    db.transaction(() => require('../../migrations/0024_normalized_diary')(db))();
    const r = svc.create(db).read(901);
    assert.equal(r.revision, 42);
    assert.deepEqual(r.state.entries, state.entries);
    assert.deepEqual(r.state.dayNotes, state.dayNotes);
    assert.equal(db.prepare('SELECT count(*) n FROM diary_habit_values WHERE measured_at IS NULL').get().n, 1800);
    assert.equal(db.prepare('SELECT count(*) n FROM diary_habit_values WHERE value_number IS NOT NULL').get().n, 1800);
    assert.equal(storage.exportData(db, 901).measurements.length, 1800);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bounded workspace merges preserve history larger than whole-state API limits', () => {
  const f = fixture();
  try {
    const store = svc.create(f.db);
    const state = svc.empty();
    state.habits = [{ id: 'h', name: 'h', type: 'measure', unit: 'ml', shared: false }];
    state.entries.h = {};
    let before = store.save(901, 0, state, '2026-10-21', '2026-10-21T00:00:00Z');
    const insert = f.db.prepare('INSERT INTO diary_day_notes(patient_id,note_id,day,text,shared) VALUES (901,?,?,?,0)');
    f.db.transaction(() => {
      for (let i = 0; i < 5100; i += 1) insert.run(`old-${i}`, '2020-01-01', 'x'.repeat(200));
    })();
    before = store.read(901);
    assert.throws(() => svc.normalize(before.state));
    const incoming = svc.normalize(svc.windowState(before.state, '2026-07-24', '2026-10-21'));
    incoming.entries.h = { '2026-10-21': [123] };
    const merged = svc.mergeWindow(before.state, incoming, '2026-07-24', '2026-10-21');
    store.save(901, before.revision, merged, '2026-10-21', '2026-10-21T01:00:00Z');
    assert.equal(f.db.prepare('SELECT count(*) n FROM diary_day_notes').get().n, 5100);
    assert.equal(store.read(901).state.entries.h['2026-10-21'][0], 123);
  } finally {
    f.close();
  }
});
