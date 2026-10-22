#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');

const files = [
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
  'package.json',
  '.prettierrc',
  'tsconfig.json',
];
const result = spawnSync('prettier', ['--check', ...files], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
