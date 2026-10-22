'use strict';

// Синтетические методики ТОЛЬКО для автотестов: проверяют механику (типы ответов, обратный пункт,
// кризисный пункт 9, пакеты). В системе их нет — рабочие методики вносятся по одной настоящими текстами.
// Код phq9/who5 здесь — лишь имя для механики; клинического содержания у них нет.
const path = require('node:path');

const scale = (count, reverse = false) =>
  Array.from({ length: count }, (_x, n) => ({
    id: `q${n + 1}`,
    type: 'single',
    required: true,
    text: `Синтетический вопрос ${n + 1}`,
    reverse: reverse && n === 0,
    options: [0, 1, 2, 3].map((x) => ({ value: String(x), label: String(x), score: x })),
  }));

const DEFS = [
  { code: 'phq9', title: 'ТЕСТ-МЕТОДИКА (9 пунктов, только автотесты)', self: 1, questions: scale(9) },
  {
    code: 'who5',
    title: 'ТЕСТ-МЕТОДИКА (5 пунктов, обратный первый, только автотесты)',
    self: 0,
    questions: scale(5, true),
  },
  {
    code: 'demo_types',
    title: 'ТЕСТ-МЕТОДИКА (все типы ответов, только автотесты)',
    self: 0,
    questions: [
      {
        id: 'single',
        type: 'single',
        required: true,
        text: 'Один вариант',
        options: [
          { value: 'a', label: 'A', score: 0 },
          { value: 'b', label: 'B', score: 1 },
        ],
      },
      {
        id: 'multi',
        type: 'multi',
        required: false,
        text: 'Несколько',
        max_select: 2,
        exclusive: ['none'],
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
          { value: 'none', label: 'Ничего' },
        ],
      },
      { id: 'number', type: 'number', required: false, text: 'Число', min: 0, max: 10 },
      { id: 'scale', type: 'scale', required: false, text: 'Шкала', min: 1, max: 5 },
      { id: 'short', type: 'text_short', required: false, text: 'Коротко' },
      { id: 'long', type: 'text_long', required: false, text: 'Подробно' },
      { id: 'date', type: 'date', required: false, text: 'Дата' },
      { id: 'yes', type: 'yes_no', required: false, text: 'Да или нет' },
    ],
  },
];

function installSyntheticInstruments(dbPath) {
  const Database = require(path.join(__dirname, '..', '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath);
  try {
    const putInstrument = db.prepare(
      "INSERT OR IGNORE INTO instruments(code,title,kind,status,online_allowed,self_service,current_version) VALUES (?,?, 'scale','stand_in',1,?,1)",
    );
    const putVersion = db.prepare(
      "INSERT OR IGNORE INTO instrument_versions(instrument_code,version,schema_json,scoring_json,bands_json,is_stand_in,status) VALUES (?,1,?,'{}','[]',1,'published')",
    );
    for (const def of DEFS) {
      putInstrument.run(def.code, def.title, def.self);
      putVersion.run(def.code, JSON.stringify({ questions: def.questions }));
    }
  } finally {
    db.close();
  }
}

module.exports = { installSyntheticInstruments };
