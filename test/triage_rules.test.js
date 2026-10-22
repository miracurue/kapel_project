'use strict';

// W1.B1: юнит-тесты правил светофора (src/triage_rules.js) на таблице кейсов.
// Пороги в тестах — значения по умолчанию из конфига (review-required, OQ-8).

const assert = require('assert');
const rules = require('../src/triage_rules');

const NOW = new Date('2026-10-10T12:00:00.000Z');
const ago = (days) => new Date(NOW.getTime() - days * 86400000).toISOString();
const HADS_BANDS = [{ max: 7 }, { max: 10 }, { max: 14 }, { max: 21 }];
const PHQ_BANDS = [{ max: 4 }, { max: 9 }, { max: 14 }, { max: 19 }, { max: 27 }];

const base = (over = {}) => ({
  consent: { clinical: true, active: true },
  openEscalations: [],
  results: [{ id: 'o1', instrument: 'phq9', total: 10, at: ago(3), bands: PHQ_BANDS, stub: false }],
  pending: [],
  assignedInWindow: 0,
  completedInWindow: 0,
  lastActivityAt: ago(2),
  ...over,
});
const phq = (id, total, days, extra = {}) => ({ id, instrument: 'phq9', total, at: ago(days), bands: PHQ_BANDS, stub: false, ...extra });

const CASES = [
  ['нет данных вообще -> серый', base({ results: [], lastActivityAt: null }), 'gray', /недостаточно данных/],
  ['только результат заглушки -> серый (заглушки не учитываются)',
    base({ results: [phq('o1', 20, 1, { instrument: 'isi', stub: true })], lastActivityAt: null }), 'gray', /заглушк/],
  ['нет клинического согласия -> серый с причиной', base({ consent: { clinical: false, active: true } }), 'gray', /согласи/],
  ['аккаунт не активен -> серый', base({ consent: { clinical: true, active: false } }), 'gray', /согласи/],
  ['стабильный, свежая активность -> зелёный', base({ results: [phq('o1', 10, 20), phq('o2', 10, 2)] }), 'green', /Нет признаков/],
  ['улучшение -> зелёный', base({ results: [phq('o1', 14, 20), phq('o2', 8, 2)] }), 'green', /Нет признаков/],
  ['рост PHQ-9 на 1 в том же уровне (сид-шум 5→6) -> зелёный', base({ results: [phq('o1', 5, 20), phq('o2', 6, 2)] }), 'green', /Нет признаков/],
  ['рост PHQ-9 на 4 в том же уровне (10→14) -> зелёный, порог 5', base({ results: [phq('o1', 10, 20), phq('o2', 14, 2)] }), 'green', /Нет признаков/],
  ['рост PHQ-9 на 5 с переходом уровня (10→15) -> жёлтый', base({ results: [phq('o1', 10, 20), phq('o2', 15, 2)] }), 'yellow', /Ухудшение по PHQ9: 10 → 15 \(более тяжёлый/],
  ['GAD-7 без смены уровня: +3 -> зелёный', base({ results: [phq('o1', 5, 20, { instrument: 'gad7', bands: null }), phq('o2', 8, 2, { instrument: 'gad7', bands: null })] }), 'green', /Нет признаков/],
  ['GAD-7 без смены уровня: +4 -> жёлтый (порог 4)', base({ results: [phq('o1', 5, 20, { instrument: 'gad7', bands: null }), phq('o2', 9, 2, { instrument: 'gad7', bands: null })] }), 'yellow', /GAD7: 5 → 9/],
  ['HADS-A +2 в том же уровне -> зелёный', base({ results: [phq('o1', 10, 20, { instrument: 'hads', bands: HADS_BANDS, subscales: { A: 4, D: 5 } }), phq('o2', 12, 2, { instrument: 'hads', bands: HADS_BANDS, subscales: { A: 6, D: 5 } })] }), 'green', /Нет признаков/],
  ['HADS-A +1 со сменой уровня (7→8) -> жёлтый', base({ results: [phq('o1', 10, 20, { instrument: 'hads', bands: HADS_BANDS, subscales: { A: 7, D: 3 } }), phq('o2', 11, 2, { instrument: 'hads', bands: HADS_BANDS, subscales: { A: 8, D: 3 } })] }), 'yellow', /HADS-A: 7 → 8 \(более тяжёл/],
  ['HADS-D +3 -> жёлтый (подшкала, порог 3)', base({ results: [phq('o1', 10, 20, { instrument: 'hads', bands: null, subscales: { A: 5, D: 5 } }), phq('o2', 13, 2, { instrument: 'hads', bands: null, subscales: { A: 5, D: 8 } })] }), 'yellow', /HADS-D: 5 → 8/],
  ['переход в более тяжёлый уровень -> жёлтый',
    base({ results: [phq('o1', 9, 20), phq('o2', 10, 2)] }), 'yellow', /более тяжёл/],
  ['WHO-5: падение на 12 = ухудшение', base({ results: [phq('o1', 22, 20, { instrument: 'who5', bands: null }), phq('o2', 10, 2, { instrument: 'who5', bands: null })] }), 'yellow', /WHO5: 22 → 10/],
  ['WHO-5: падение на 1 (сид-шум 12→11) -> зелёный', base({ results: [phq('o1', 12, 20, { instrument: 'who5', bands: null }), phq('o2', 11, 2, { instrument: 'who5', bands: null })] }), 'green', /Нет признаков/],
  ['WHO-5: падение на 9 -> зелёный (порог 10)', base({ results: [phq('o1', 20, 20, { instrument: 'who5', bands: null }), phq('o2', 11, 2, { instrument: 'who5', bands: null })] }), 'green', /Нет признаков/],
  ['ухудшение старше окна не считается', base({ results: [phq('o1', 10, 80), phq('o2', 16, 60)], lastActivityAt: ago(2) }), 'green', /Нет признаков/],
  ['ухудшение только заглушки не считается', base({ results: [phq('o1', 3, 20, { stub: true, instrument: 'isi' }), phq('o2', 20, 2, { stub: true, instrument: 'isi' }), phq('o3', 5, 4)] }), 'green', /Нет признаков/],
  ['нет активности 14 дней -> жёлтый', base({ lastActivityAt: ago(14) }), 'yellow', /Нет активности 14 дн/],
  ['нет активности 13 дней -> зелёный', base({ lastActivityAt: ago(13) }), 'green', /Нет признаков/],
  ['тест не пройден 14 дней -> жёлтый', base({ pending: [{ id: 5, instrument: 'phq9', assigned_at: ago(14), stub: false }] }), 'yellow', /PHQ9 не пройден 14 дн/],
  ['тест заглушки не пройден -> не влияет', base({ pending: [{ id: 5, instrument: 'isi', assigned_at: ago(40), stub: true }] }), 'green', /Нет признаков/],
  ['низкая приверженность -> жёлтый', base({ assignedInWindow: 4, completedInWindow: 1 }), 'yellow', /пройдено 1 из 4/],
  ['мало назначений — приверженность не оценивается', base({ assignedInWindow: 2, completedInWindow: 0 }), 'green', /Нет признаков/],
  ['открытая Tier 1 -> жёлтый', base({ openEscalations: [{ id: 1, tier: 1, kind: 'tier', due_at: null }] }), 'yellow', /уровня 1/],
  ['открытая Tier 2 в срок -> красный', base({ openEscalations: [{ id: 2, tier: 2, kind: 'tier', due_at: new Date(NOW.getTime() + 600000).toISOString() }] }), 'red', /Уровень 2.*осталось 10 мин/],
  ['Tier 3 просрочена -> красный с «просрочено»', base({ openEscalations: [{ id: 3, tier: 3, kind: 'tier', due_at: new Date(NOW.getTime() - 420000).toISOString() }] }), 'red', /просрочено на 7 мин/],
  ['нет резерва -> красный, «разбор вручную»', base({ openEscalations: [{ id: 3, tier: 2, kind: 'tier', unresolved: 1, due_at: ago(1) }] }), 'red', /разбор вручную/],
  ['обращение пациента -> красный, метка «Обращение пациента»', base({ openEscalations: [{ id: 9, tier: 2, kind: 'appeal', due_at: new Date(NOW.getTime() + 300000).toISOString() }] }), 'red', /Обращение пациента/],
  ['красный выше жёлтого и серого', base({ consent: { clinical: false, active: true }, openEscalations: [{ id: 3, tier: 2, kind: 'tier', due_at: ago(0.01) }] }), 'red', /Уровень 2/],
  ['кризис виден и без согласия (OQ-6)', base({ consent: { clinical: false, active: true }, openEscalations: [{ id: 3, tier: 3, kind: 'tier', due_at: null }] }), 'red', /Уровень 3/],
];

let ok = 0;
for (const [name, snap, color, why] of CASES) {
  const v = rules.evaluate(snap, NOW);
  assert.strictEqual(v.color, color, `${name}: цвет ${v.color}, why=${v.why}`);
  assert.ok(why.test(v.why), `${name}: текст «почему» не совпал: ${v.why}`);
  assert.ok(v.word && v.icon, `${name}: слово и значок обязательны`);
  assert.ok(v.oneLine.length > 0, `${name}: одна строка причины`);
  ok++;
  console.log('OK  ', name);
}

// слова и значки различны у всех четырёх цветов (не только цвет)
const words = Object.values(rules.COLORS).map((c) => c.word);
const icons = Object.values(rules.COLORS).map((c) => c.icon);
assert.strictEqual(new Set(words).size, 4);
assert.strictEqual(new Set(icons).size, 4);
assert.deepStrictEqual(words.sort(), ['Внимание', 'Кризис', 'Мало данных', 'Спокойно'].sort());
ok++;
console.log('OK   у каждого цвета своё слово и значок');

// порядок важности
assert.deepStrictEqual(['red', 'yellow', 'gray', 'green'].map((c) => rules.COLORS[c].rank), [0, 1, 2, 3]);
ok++;
console.log('OK   порядок сортировки: красные -> жёлтые -> серые -> зелёные');

// изменение числа в конфиге меняет результат без правки кода
{
  const snap = base({ lastActivityAt: ago(10) });
  assert.strictEqual(rules.evaluate(snap, NOW).color, 'green');
  const v = rules.evaluate(snap, NOW, { inactivityDays: 7 });
  assert.strictEqual(v.color, 'yellow');
  assert.match(v.why, /порог 7/);
  const noise = base({ results: [phq('o1', 10, 20), phq('o2', 11, 2)] });
  assert.strictEqual(rules.evaluate(noise, NOW).color, 'green');
  assert.strictEqual(rules.evaluate(noise, NOW, { worseningMinDelta: 1 }).color, 'yellow'); // одно число = для всех шкал
  assert.strictEqual(rules.evaluate(noise, NOW, { worseningMinDelta: { phq9: 1, default: 1 } }).color, 'yellow');
  assert.strictEqual(rules.evaluate(noise, NOW, { worseningMinDelta: { phq9: 3 } }).color, 'green');
  assert.deepStrictEqual({ ...rules.CONFIG.worseningMinDelta }, { phq9: 5, gad7: 4, hads: 3, who5: 10, default: 1 });
  ok++;
  console.log('OK   порог из конфига меняет результат; текст «почему» показывает порог');
}

// несколько причин: одна строка + счётчик, все причины в why
{
  const v = rules.evaluate(base({ lastActivityAt: ago(30), pending: [{ id: 1, instrument: 'gad7', assigned_at: ago(20), stub: false }] }), NOW);
  assert.strictEqual(v.color, 'yellow');
  assert.strictEqual(v.reasons.length, 2);
  assert.match(v.oneLine, /\(\+1\)$/);
  ok++;
  console.log('OK   несколько причин: «(+N)» в строке, полный список в reasons');
}

// SLA-текст
{
  assert.strictEqual(rules.slaText(new Date(NOW.getTime() + 12 * 60000).toISOString(), NOW).text, 'осталось 12 мин');
  assert.strictEqual(rules.slaText(new Date(NOW.getTime() - 7 * 60000).toISOString(), NOW).text, 'просрочено на 7 мин');
  assert.strictEqual(rules.slaText(null, NOW).overdue, false);
  ok++;
  console.log('OK   SLA: «осталось 12 мин» / «просрочено на 7 мин»');
}

console.log(`triage_rules: ${ok} OK, 0 FAIL`);
console.log('Все проверки светофора прошли успешно.');
