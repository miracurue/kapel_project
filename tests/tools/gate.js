#!/usr/bin/env node
'use strict';

// Запуск тестов этапа 13, которые должны быть зелёными к данной вехе или задаче плана 12.
// Задача теста — в названии: `T-101 [W-24] …`. Веха включает свои задачи и все задачи прошлых вех.
//
//   node tests/tools/gate.js --upto В2                 API-тесты вех В1–В2
//   node tests/tools/gate.js --upto В3 --kind all      API и приёмочные тесты вех В1–В3
//   node tests/tools/gate.js --tasks W-14,W-19         только тесты этих задач
//   node tests/tools/gate.js --list                    таблица «задача → тесты»
//
// В `npm run ci` подставляется текущая веха (см. отчёт 13, раздел «Run»), например `npm run test:gate -- --upto В2`.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MILESTONES = { 'В1': [1, 12], 'В2': [13, 22], 'В3': [23, 28], 'В4': [29, 36], 'В5': [37, 47], 'В6': [48, 55], 'В7': [56, 58] };
const DIRS = { api: ['tests/api'], acceptance: ['tests/acceptance'], perf: ['tests/performance'] };

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }

function testFiles(kind) {
  const dirs = kind === 'all' ? [...DIRS.api, ...DIRS.acceptance] : DIRS[kind];
  const files = [];
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(ROOT, d))) if (/\.(test|spec)\.js$/.test(f)) files.push(path.join(d, f));
  }
  return files.sort();
}

function testsIn(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return [...text.matchAll(/test\('(T-\d{3}) \[(W-\d{2})\]/g)].map((m) => ({ t: m[1], w: m[2], file }));
}

function wanted() {
  const upto = arg('--upto');
  const tasks = arg('--tasks');
  if (tasks) return new Set(tasks.split(',').map((s) => s.trim()));
  if (!upto || !MILESTONES[upto]) { console.error('укажите --upto В1…В7 или --tasks W-xx,…'); process.exit(2); }
  const last = MILESTONES[upto][1];
  return new Set(Array.from({ length: last }, (_, i) => `W-${String(i + 1).padStart(2, '0')}`));
}

const kind = arg('--kind') || 'api';
if (process.argv.includes('--list')) {
  const rows = testFiles('all').concat(testFiles('perf')).flatMap(testsIn);
  const byTask = {};
  for (const r of rows) (byTask[r.w] = byTask[r.w] || []).push(r.t);
  for (const w of Object.keys(byTask).sort()) console.log(`${w}: ${byTask[w].join(', ')}`);
  process.exit(0);
}

const set = wanted();
const selected = testFiles(kind).flatMap(testsIn).filter((r) => set.has(r.w));
if (!selected.length) { console.log('для выбранных задач тестов нет'); process.exit(0); }
const files = [...new Set(selected.map((r) => r.file))];
const pattern = `^(${selected.map((r) => r.t).join('|')}) `;
console.log(`тестов: ${selected.length}, файлов: ${files.length}`);
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', `--test-name-pattern=${pattern}`, ...files], { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
