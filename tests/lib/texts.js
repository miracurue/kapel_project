'use strict';

// Словарь ru.json: data-testid элемента = ключ текста (12, «Как тесты находят элементы»),
// ключ ошибки = `err.<код в нижнем регистре>`.

const fs = require('fs');
const { ruJsonPath } = require('./paths');

let cache = null;

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function dictionary() {
  if (!cache) cache = flatten(JSON.parse(fs.readFileSync(ruJsonPath(), 'utf8')));
  return cache;
}

function has(key) {
  return Object.prototype.hasOwnProperty.call(dictionary(), key);
}

function text(key) {
  if (!has(key)) throw new Error(`ключа ${key} нет в ru.json — тест опирается только на утверждённые ключи`);
  return dictionary()[key];
}

function errKey(code) {
  return `err.${String(code).toLowerCase()}`;
}

module.exports = { dictionary, has, text, errKey };
