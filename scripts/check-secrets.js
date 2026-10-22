#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const tracked = spawnSync('git', ['ls-files'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
const badNames = tracked.filter(
  (name) => /(^|\/)\.env($|\.)|(^|\/)data\/.+\.(sqlite3|db)(-|$)/.test(name) && name !== '.env.example',
);
const patterns = /(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{32,})/;
const badContent = [];
for (const file of tracked) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (_) {
    continue;
  }
  if (patterns.test(content)) badContent.push(file);
}
if (badNames.length || badContent.length) {
  console.error([...badNames, ...badContent].join('\n'));
  process.exit(1);
}
console.log('secrets: no forbidden tracked files or known token shapes');
