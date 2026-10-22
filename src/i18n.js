'use strict';

const texts = require('../locales/ru.json');

function t(key, fallback = key) {
  if (typeof texts[key] === 'string') return texts[key];
  const parts = key.split('.');
  let value = texts;
  for (const part of parts) value = value && value[part];
  return typeof value === 'string' ? value : fallback;
}

module.exports = { t, texts };
