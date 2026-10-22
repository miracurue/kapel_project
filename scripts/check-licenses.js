#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const allowed =
  /^(MIT|MIT-0|ISC|MPL-2\.0|BSD(?:-2-Clause|-3-Clause)?|Apache-2\.0|BlueOak-1\.0\.0|0BSD|Python-2\.0)( OR (MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0))*$/;
const failures = [];
const packageDirs = fs.readdirSync('node_modules').flatMap((entry) => {
  if (entry.startsWith('.')) return [];
  if (!entry.startsWith('@')) return [path.join('node_modules', entry)];
  const scope = path.join('node_modules', entry);
  return fs.readdirSync(scope).map((name) => path.join(scope, name));
});
for (const dir of packageDirs) {
  const file = path.join(dir, 'package.json');
  if (!fs.existsSync(file)) continue;
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const license = typeof pkg.license === 'string' ? pkg.license : '';
  // Legal policy permits the unchanged dynamically loaded libvips bundled by sharp.
  const sharpVips =
    /^@img\/sharp-libvips-(linux|darwin|win32|linuxmusl)-[a-z0-9]+$/.test(pkg.name) &&
    license === 'LGPL-3.0-or-later' &&
    fs.existsSync(path.join(dir, 'versions.json'));
  if (!allowed.test(license) && !sharpVips)
    failures.push(`${pkg.name}@${pkg.version}: ${license || 'license missing'}`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('licenses: allowed');
