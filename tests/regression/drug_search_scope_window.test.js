'use strict';
// covers: поиск по инструкциям: сужение до названного препарата (торговое название и МНН, склонения) и
// дополнение чанка продолжением раздела, оборванного границей чанка.
const test = require('node:test');
const assert = require('node:assert/strict');
const { documentsNamedIn, cutSection } = require('../../src/modules/knowledge/service');

const DOCS = [
  { id: 'D01', drug_label: 'Авиандр', inn: 'Маритупирдин', trade_name: null },
  { id: 'D03', drug_label: 'Дальхимфарм', inn: 'Амитриптилин', trade_name: null },
  { id: 'D02', drug_label: 'Амитриптилин-АЛСИ', inn: 'Амитриптилин', trade_name: null },
  { id: 'D12', drug_label: 'Эсциталопрам-АЛСИ', inn: 'Эсциталопрам', trade_name: null },
  { id: 'D10', drug_label: 'Ципрамил', inn: 'Циталопрам', trade_name: null },
];

test('торговое название в запросе сужает поиск до его инструкции', () => {
  assert.deepEqual(documentsNamedIn('Авиандр показания', DOCS), ['D01']);
});

test('склонённое название и МНН тоже узнаются', () => {
  assert.deepEqual(documentsNamedIn('дозировка авиандра при тревоге', DOCS), ['D01']);
  assert.deepEqual(documentsNamedIn('маритупирдин противопоказания', DOCS), ['D01']);
  assert.deepEqual(documentsNamedIn('амитриптилин и седативный эффект', DOCS).sort(), ['D02', 'D03']);
});

test('циталопрам не принимается за эсциталопрам и наоборот', () => {
  assert.deepEqual(documentsNamedIn('эсциталопрам показания', DOCS), ['D12']);
  assert.deepEqual(documentsNamedIn('циталопрам показания', DOCS), ['D10']);
});

test('без названия препарата область не сужается', () => {
  assert.deepEqual(documentsNamedIn('показания при тревожном расстройстве', DOCS), []);
  assert.deepEqual(documentsNamedIn('', DOCS), []);
});

test('оборванный раздел: начинается внутри чанка, заканчивается за его концом', () => {
  const chunk = { start_offset: 0, end_offset: 1207 };
  const sections = [
    { id: 'D01:s5', start_char: 1071, end_char: 16024 },
    { id: 'D01:s6', start_char: 1097, end_char: 1434 },
    { id: 'D01:s1', start_char: 21, end_char: 25398 },
  ];
  assert.equal(cutSection(chunk, sections).id, 'D01:s6');
  assert.equal(cutSection({ start_offset: 0, end_offset: 2000 }, [sections[1]]), null);
  assert.equal(cutSection({ start_offset: 1207, end_offset: 2444 }, [sections[1]]), null);
});
