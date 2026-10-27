#!/usr/bin/env node
'use strict';
// Канбан-доска из .agents/BOARD.md -> .agents/board.html (локальный файл, в Git не хранится).
// Запуск: node scripts/board-html.js   Открыть: файл .agents/board.html в браузере (автообновление 60 с).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const boardPath = path.join(root, '.agents', 'BOARD.md');
const outPath = path.join(root, '.agents', 'board.html');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const git = (args) => {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (e) { return ''; }
};

const rows = fs.readFileSync(boardPath, 'utf8').split('\n')
  .filter((l) => /^\| (PM-|W\d)/.test(l))
  .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
  .map(([id, wave, deps, status, model, branch, heartbeat, attempts, note]) =>
    ({ id, wave, deps, status, model, branch, heartbeat, attempts, note }));

const columns = [
  ['todo', 'К выполнению'], ['running', 'В работе'], ['review', 'Ревью / приёмка'],
  ['blocked', 'Заблокировано'], ['done', 'Готово'],
];

for (const r of rows) {
  const last = r.branch && r.branch !== 'integration'
    ? git(['log', '-1', '--format=%cr · %s', r.branch]) : '';
  r.last = last;
  r.hasReport = fs.existsSync(path.join(root, '.agents', 'tasks', `${r.id}.md`));
}

const stats = columns.map(([k]) => rows.filter((r) => r.status === k).length);
const total = rows.length;
const donePct = total ? Math.round((stats[4] / total) * 100) : 0;
const supHb = path.join(root, '.agents', '.supervisor.heartbeat');
const supAge = fs.existsSync(supHb) ? Math.round((Date.now() - fs.statSync(supHb).mtimeMs) / 60000) : null;
const integ = git(['log', '-3', '--format=%h %s']).split('\n').map(esc).join('<br>');

const card = (r) => `<div class="card s-${esc(r.status)}">
  <div class="id">${esc(r.id)} <span class="wave">волна ${esc(r.wave)}</span></div>
  <div class="note">${esc(r.note)}</div>
  <div class="meta">${r.branch ? '⎇ ' + esc(r.branch) : ''}${r.model ? ' · ' + esc(r.model) : ''}${r.attempts ? ' · попыток ' + esc(r.attempts) : ''}</div>
  ${r.deps && r.deps !== '—' ? `<div class="meta">зависит от: ${esc(r.deps)}</div>` : ''}
  ${r.last ? `<div class="meta">последний коммит: ${esc(r.last)}</div>` : ''}
  ${r.hasReport ? '<div class="meta">отчёт: .agents/tasks/' + esc(r.id) + '.md</div>' : ''}
</div>`;

const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="60"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clinical Compass — доска</title><style>
body{font-family:system-ui,sans-serif;margin:0;background:#f6f7fb;color:#1b1e2b}
header{padding:12px 20px;background:#1b1e2b;color:#fff;display:flex;gap:20px;flex-wrap:wrap;align-items:center}
header h1{font-size:1.1rem;margin:0 auto 0 0}
.bar{height:8px;background:#e7e9f2;border-radius:99px;overflow:hidden;width:220px}.bar i{display:block;height:100%;background:#2e9e5b;width:${donePct}%}
.board{display:grid;grid-template-columns:repeat(5,minmax(200px,1fr));gap:12px;padding:16px;overflow-x:auto}
.col{background:#eceef6;border-radius:10px;padding:10px;min-height:120px}.col h2{font-size:.95rem;margin:0 0 8px}
.card{background:#fff;border-radius:8px;padding:10px;margin-bottom:8px;box-shadow:0 1px 3px rgba(0,0,0,.1);border-left:4px solid #9aa}
.s-running{border-left-color:#2a6fdb}.s-review{border-left-color:#c58b00}.s-blocked{border-left-color:#8a1313}.s-done{border-left-color:#2e9e5b}
.id{font-weight:700}.wave{font-weight:400;color:#5a5f72;font-size:.8rem}.note{margin:4px 0}.meta{color:#5a5f72;font-size:.78rem;word-break:break-word}
footer{padding:0 16px 16px;color:#5a5f72;font-size:.85rem}
</style></head><body>
<header><h1>Clinical Compass — доска задач</h1>
<div>Готово ${stats[4]} из ${total} (${donePct}%)</div><div class="bar"><i></i></div>
<div>Супервизор: ${supAge === null ? 'нет heartbeat' : supAge + ' мин назад'}</div></header>
<div class="board">${columns.map(([k, title], i) => `<section class="col"><h2>${title} (${stats[i]})</h2>${rows.filter((r) => r.status === k).map(card).join('')}</section>`).join('')}</div>
<footer>Обновлено ${new Date().toLocaleString('ru-RU')} · страница сама обновляется раз в минуту. Последние коммиты integration:<br>${integ}</footer>
</body></html>`;

fs.writeFileSync(outPath, html);
console.log('board written:', outPath);
