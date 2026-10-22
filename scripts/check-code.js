#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');

for (const [command, args] of [
  [
    'eslint',
    [
      'src/access/index.js',
      'src/config.js',
      'src/i18n.js',
      'src/pages.js',
      'src/platform.js',
      'src/server.js',
      'public/shell.js',
      'public/v2.js',
      'src/modules/v3/*.js',
      'src/modules/files/*.js',
      'scripts/{migrate,admin-create,seed-demo,check-*}.js',
    ],
  ],
  ['tsc', ['--project', 'tsconfig.json']],
]) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
