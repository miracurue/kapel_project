'use strict';
const fs = require('node:fs');
const path = require('node:path');
function migrate(db, filename) {
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  const version = db.pragma('user_version', { simple: true });
  if (version > 1) throw new Error('Unsupported knowledge database version');
  if (version === 1) return;
  if (filename && filename !== ':memory:' && fs.existsSync(filename) && fs.statSync(filename).size > 0)
    db.prepare('VACUUM INTO ?').run(`${filename}-backup-v0001-${Date.now()}`);
  db.transaction(() => {
    db.exec(fs.readFileSync(path.join(__dirname, 'migrations/0001_knowledge.sql'), 'utf8'));
    db.pragma('user_version = 1');
  }).immediate();
}
module.exports = { migrate };
