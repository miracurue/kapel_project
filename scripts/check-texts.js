#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const texts = require('../locales/ru.json');
const roots = ['src', 'public'];
const files = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full);
    else if (/\.(js|ejs|html)$/.test(name)) files.push(full);
  }
}
for (const root of roots) walk(root);
const missing = new Set();
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/data-testid=["']([^"'${}]+)["']/g))
    if (!Object.hasOwn(texts, match[1])) missing.add(`${match[1]} (${file})`);
}
if (missing.size) {
  console.error([...missing].join('\n'));
  process.exit(1);
}
console.log(`texts: ${Object.keys(texts).length} keys; static data-testid values are declared`);
