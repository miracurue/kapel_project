'use strict';

// Статичные прототипы растения (public/plant-*): без внешних ресурсов, версии не мешают друг другу.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', '..', 'public');
const read = (f) => fs.readFileSync(path.join(pub, f), 'utf8');
const FILES = ['plant-demo.html', 'plant-demo.css', 'plant-demo.js', 'plant-volume.html', 'plant-volume.css', 'plant-volume.js'];

test('растение: нет внешних ресурсов (L-11)', () => {
  for (const f of FILES) assert.ok(!/(?:src|href)\s*=\s*["']https?:\/\/|@import\s+url\(["']?https?:|https?:\/\/[^\s"']+\.(?:js|css|woff2?)/i.test(read(f)), f);
});

test('растение: объёмная версия берёт стили плоской и хранит прогресс под отдельным ключом', () => {
  assert.match(read('plant-volume.css'), /@import\s+(?:url\()?["']?\.?\/?plant-demo\.css/);
  const flat = read('plant-demo.js').match(/clinical-compass-plant-prototype[\w-]*/)[0];
  const vol = read('plant-volume.js').match(/clinical-compass-plant-prototype-volume-v1/);
  assert.ok(vol, 'ключ объёмной версии');
  assert.notEqual(flat, 'clinical-compass-plant-prototype-volume-v1');
});

test('растение: прототипы не подключены к основному приложению', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
  assert.ok(!/plant-(?:demo|volume)/.test(server));
});
