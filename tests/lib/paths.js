'use strict';

// Пути, которыми пользуются все тесты этапа 13. Тесты читают УТВЕРЖДЁННЫЕ
// описания (контракт API и словарь текстов), а не то, что сейчас лежит в коде.

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const AGENTS = path.join(ROOT, '.agents', 'web-developer', 'files');

// Словарь текстов: рабочая копия разработки (W-06) или утверждённый оригинал этапа 10.
function ruJsonPath() {
  const repo = path.join(ROOT, 'locales', 'ru.json');
  return fs.existsSync(repo) ? repo : path.join(AGENTS, '10-texts', 'ru.json');
}

module.exports = {
  ROOT,
  AGENTS,
  CONTRACT: path.join(ROOT, 'tests', 'api', 'contract', 'operations.json'),
  FIXTURES: path.join(ROOT, 'tests', 'fixtures'),
  SERVER_ENTRY: path.join(ROOT, 'src', 'server.js'),
  MIGRATE: path.join(ROOT, 'scripts', 'migrate.js'),
  ruJsonPath,
};
