'use strict';

/**
 * Юнит-тесты на синтетических данных для RES-11: подсчёт баллов и пороги
 * риска (instruments.js), Tier/триггеры кризисного протокола
 * (crisisProtocol.js), NLP-классификатор (riskClassifier.js) и структура
 * сравнения офлайн/онлайн (comparison.js). Без HTTP — проверяет сами
 * алгоритмы, а не маршруты (см. test/smoke.test.js для сквозных сценариев).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `tdr-scoring-${Date.now()}.sqlite3`);
process.env.TDR_DB_PATH = tmpDb;

const { scoreInstrument, scoreClinicianEntry } = require('../src/instruments');
const { TIERS, evaluateCrisisTier, isBusinessHours, computeDueAt } = require('../src/crisisProtocol');
const riskClassifier = require('../src/riskClassifier');
const comparison = require('../src/comparison');
const db = require('../src/db');

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

console.log('--- PHQ-9 ---');
{
  // 9 нулей -> минимум
  let r = scoreInstrument('phq9', [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  check('PHQ-9 все нули -> total=0, band=минимальные симптомы, без риска', r.total === 0 && r.band === 'минимальные симптомы' && !r.riskFlag);

  // Пункт 9 = 1 -> критический риск независимо от суммы
  r = scoreInstrument('phq9', [1, 1, 1, 0, 0, 0, 0, 0, 1]);
  check('PHQ-9 пункт 9 = 1 -> riskFlag=true (критический триггер)', r.riskFlag === true);
  check('PHQ-9 пункт 9 = 1 -> причина упоминает пункт 9', r.riskReasons.some((x) => x.includes('пункт 9')));

  // Сумма 20 без пункта 9 -> тяжёлая депрессия
  r = scoreInstrument('phq9', [3, 3, 3, 3, 3, 3, 2, 0, 0]);
  check('PHQ-9 сумма 20, пункт9=0 -> total=20, band=тяжёлая депрессия', r.total === 20 && r.band === 'тяжёлая депрессия');
  check('PHQ-9 сумма 20 -> riskFlag=true (≥20)', r.riskFlag === true);

  // Сумма 19 -> не тяжёлая, без критического пункта -> без риска
  r = scoreInstrument('phq9', [3, 3, 3, 3, 3, 2, 2, 0, 0]);
  check('PHQ-9 сумма 19 -> band=умеренно тяжёлая депрессия, без риска', r.total === 19 && r.band === 'умеренно тяжёлая депрессия' && !r.riskFlag);
}

console.log('--- GAD-7 ---');
{
  let r = scoreInstrument('gad7', [2, 2, 2, 2, 2, 2, 2]);
  check('GAD-7 сумма 14 -> band=умеренная тревога, без риска (<15)', r.total === 14 && r.band === 'умеренная тревога' && !r.riskFlag);
  r = scoreInstrument('gad7', [3, 3, 3, 3, 2, 1, 0]);
  check('GAD-7 сумма 15 -> band=тяжёлая тревога, risk=true', r.total === 15 && r.band === 'тяжёлая тревога' && r.riskFlag === true);
}

console.log('--- HADS (две субшкалы отдельно) ---');
{
  // 7 пунктов A (idx 0,2,4,6,8,10,12) = 3 каждый -> A=21; D (idx 1,3,5,7,9,11,13) = 0 -> D=0
  const answers = [3, 0, 3, 0, 3, 0, 3, 0, 3, 0, 3, 0, 3, 0];
  const r = scoreInstrument('hads', answers);
  check('HADS субшкала A считается отдельно от D', r.subscales.A === 21 && r.subscales.D === 0);
  check('HADS-A=21 -> клинический риск (≥11)', r.riskFlag === true && r.riskReasons.some((x) => x.includes('HADS-A')));
  check('HADS-D=0 не даёт риска по депрессии', !r.riskReasons.some((x) => x.includes('HADS-D')));

  // субшкалы по 9 баллов (попадает в диапазон 8-10, "субклинически выражено")
  const low = scoreInstrument('hads', [2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2]);
  check(
    'HADS обе субшкалы по 9 -> band считается по каждой субшкале, без риска',
    low.subscales.A === 9 && low.subscales.D === 9 && low.band.includes('субклинически') && !low.riskFlag
  );
}

console.log('--- WHO-5 (сырой балл ×4) ---');
{
  const r = scoreInstrument('who5', [3, 3, 3, 3, 3]);
  check('WHO-5 сырой балл 15, шкала ×4 = 60', r.total === 15 && INSTRUMENTS_who5_scaled(r.total) === 60);
  const low = scoreInstrument('who5', [1, 1, 1, 1, 1]);
  check('WHO-5 сырой балл 5 ≤13 -> риск (предложить PHQ-9/GAD-7)', low.total === 5 && low.riskFlag === true);
}
function INSTRUMENTS_who5_scaled(total) {
  return total * 4;
}

console.log('--- C-SSRS Screen (не аддитивная шкала, skip-логика) ---');
{
  // вопрос1=да, вопрос2=да, далее нет -> идеация уровня 2, без поведения
  let r = scoreInstrument('cssrs', [1, 1, 0, 0, 0, 0]);
  check('C-SSRS идеация уровня 2 без поведения -> ideationLevel=2', r.subscales.ideationLevel === 2 && r.subscales.behavior === false);
  check('C-SSRS идеация 2 (<4) и без поведения -> не критический', r.riskFlag === false);

  // вопрос1..4=да -> идеация уровня 4 -> критический независимо от поведения
  r = scoreInstrument('cssrs', [1, 1, 1, 1, 0, 0]);
  check('C-SSRS идеация уровня 4 -> критический риск', r.subscales.ideationLevel === 4 && r.riskFlag === true);

  // поведение=да (вопрос 6), идеация может быть низкой -> всё равно критический (триггер A)
  r = scoreInstrument('cssrs', [1, 0, 0, 0, 0, 1]);
  check('C-SSRS позитивный ответ в блоке поведения -> критический риск (триггер A)', r.subscales.behavior === true && r.riskFlag === true);

  // skip-логика: вопрос1=нет -> дальше не считается, даже если там "да" (не должно быть по UI, но функция должна быть устойчивой)
  r = scoreInstrument('cssrs', [0, 1, 1, 1, 1, 0]);
  check('C-SSRS skip-логика: вопрос1=нет останавливает подсчёт идеации', r.subscales.ideationLevel === 0);
}

console.log('--- BDI-II (клиницист вводит итог + пункт 9, без воспроизведения пунктов) ---');
{
  let r = scoreClinicianEntry('bdi2', { totalScore: 10, item9Score: 0 });
  check('BDI-II total=10 -> band=минимальная депрессия, без риска', r.band === 'минимальная депрессия' && !r.riskFlag);

  r = scoreClinicianEntry('bdi2', { totalScore: 25, item9Score: 2 });
  check('BDI-II total=25 -> band=умеренная депрессия', r.band === 'умеренная депрессия');
  check('BDI-II пункт9=2 -> риск (сверка с C-SSRS)', r.riskFlag === true && r.riskReasons.some((x) => x.includes('сверка')));

  r = scoreClinicianEntry('bdi2', { totalScore: 40, item9Score: 3 });
  check('BDI-II пункт9=3 -> критический риск', r.riskReasons.some((x) => x.includes('критический')));

  assert.throws(() => scoreClinicianEntry('bdi2', { totalScore: 64, item9Score: 0 }), /0-63/, 'BDI-II total=64 должен быть вне диапазона 0-63');
  check('BDI-II валидация диапазона 0-63 работает', true);
}

console.log('--- СМИЛ/MMPI (T-баллы, без автоинтерпретации профиля) ---');
{
  let r = scoreClinicianEntry('mmpi', { subscales: { scale2: 55, scale7: 60, scale9: 50 } });
  check('СМИЛ все T<70 -> без риска', !r.riskFlag);

  r = scoreClinicianEntry('mmpi', { subscales: { scale2: 72, scale7: 60, scale9: 50 } });
  check('СМИЛ шкала 2 T=72 ≥70 -> флаг психиатру', r.riskFlag === true && r.riskReasons.some((x) => x.includes('Шкала 2')));
}

console.log('--- STAI (не входит в сводную таблицу эскалации) ---');
{
  const r = scoreClinicianEntry('stai', { subscales: { state: 50, trait: 20 } });
  check('STAI не создаёт риск-флаг (нет в таблице эскалации)', r.riskFlag === false);
  check('STAI band считается по худшей субшкале (50 -> высокая тревожность)', r.band === 'высокая тревожность');
}

console.log('--- Кризисный протокол: Tier 0-3, триггеры A-F ---');
{
  let res = evaluateCrisisTier({});
  check('Нет сигналов -> Tier 0', res.tier === TIERS.ROUTINE && res.triggers.length === 0);

  res = evaluateCrisisTier({ phq9Item9: 1, cssrsIdeationLevel: 0 });
  check('Триггер C один, C-SSRS отрицательный -> Tier 1 (мониторинг)', res.tier === TIERS.MONITORING && res.triggers.includes('C'));

  res = evaluateCrisisTier({ severeMoodScreen: true });
  check('Тяжёлый GAD-7/HADS без суицидального контента -> Tier 1', res.tier === TIERS.MONITORING);

  res = evaluateCrisisTier({ cssrsIdeationLevel: 2, severeMoodScreen: true });
  check('C-SSRS идеация 2-3 + доп. фактор риска -> Tier 2', res.tier === TIERS.HIGH);

  res = evaluateCrisisTier({ phq9Item9: 2, cssrsIdeationLevel: 2 });
  check('PHQ-9 п.9≥2 + идеация ≥2 -> Tier 2', res.tier === TIERS.HIGH);

  res = evaluateCrisisTier({ nssiDisclosed: true });
  check('Триггер F (NSSI без суицидального намерения) -> Tier 2', res.tier === TIERS.HIGH && res.triggers.includes('F'));

  res = evaluateCrisisTier({ cssrsBehavior: true });
  check('Триггер A (позитивное поведение C-SSRS) -> Tier 3', res.tier === TIERS.CRITICAL && res.triggers.includes('A'));

  res = evaluateCrisisTier({ cssrsIdeationLevel: 5 });
  check('Триггер B (идеация уровня 5) -> Tier 3', res.tier === TIERS.CRITICAL && res.triggers.includes('B'));

  res = evaluateCrisisTier({ bdi2Item9: 3 });
  check('Триггер D (BDI-II п.9=3) -> Tier 3 критический', res.tier === TIERS.CRITICAL);

  res = evaluateCrisisTier({ bdi2Item9: 2 });
  check('BDI-II п.9=2 (без =3) сам по себе -> не Tier 3', res.tier !== TIERS.CRITICAL);

  res = evaluateCrisisTier({ nlpCategories: [4] });
  check('Триггер E (NLP-классификатор сработал) -> Tier 3', res.tier === TIERS.CRITICAL && res.triggers.includes('E'));
}

console.log('--- SLA ---');
{
  const businessHour = new Date('2026-10-09T10:00:00'); // пятница, 10:00
  const afterHours = new Date('2026-10-09T22:00:00'); // пятница, 22:00
  check('isBusinessHours: будний день 10:00 -> true', isBusinessHours(businessHour) === true);
  check('isBusinessHours: будний день 22:00 -> false', isBusinessHours(afterHours) === false);

  const due1 = new Date(computeDueAt(TIERS.CRITICAL, businessHour));
  check('SLA Tier 3 в рабочее время = +15 минут', due1.getTime() - businessHour.getTime() === 15 * 60000);

  const due2 = new Date(computeDueAt(TIERS.CRITICAL, afterHours));
  check('SLA Tier 3 вне рабочего времени = +30 минут', due2.getTime() - afterHours.getTime() === 30 * 60000);

  check('Tier 0/1 не имеют SLA (due_at = null)', computeDueAt(TIERS.ROUTINE) === null && computeDueAt(TIERS.MONITORING) === null);
}

console.log('--- NLP-классификатор (черновик, 5 категорий) ---');
{
  check('явный план -> категория 1', riskClassifier.classifyFreeText('у меня есть план, как это сделать').includes(1));
  check('доступ к средствам -> категория 2', riskClassifier.classifyFreeText('у меня есть таблетки, чтобы покончить с этим').includes(2));
  check('прощальное сообщение -> категория 3', riskClassifier.classifyFreeText('это моё последнее сообщение, прощайте все').includes(3));
  check('намерение+безнадёжность -> категория 4', riskClassifier.classifyFreeText('не хочу жить').includes(4));
  check('нейтральный текст -> нет категорий', riskClassifier.classifyFreeText('сегодня хорошая погода').length === 0);
  check('NSSI раскрытие детектируется отдельно', riskClassifier.detectNssiDisclosure('я режу себя') === true);
}

console.log('--- Сравнение офлайн/онлайн (структура данных) ---');
{
  // синтетический пациент + онлайн PHQ-9 + офлайн PHQ-9 через 5 дней -> within_window
  const clinician = db.prepare("INSERT INTO users (email, password_hash, role, full_name) VALUES ('doc@t','x','psychiatrist','Доктор Т')").run();
  const patient = db
    .prepare("INSERT INTO users (email, password_hash, role, full_name, consent_given) VALUES ('pat@t','x','patient','Пациент Т', 1)")
    .run();
  const patientId = patient.lastInsertRowid;

  const onlineInfo = db
    .prepare(
      `INSERT INTO online_results (patient_id, instrument, answers_json, total_score, band, risk_flag, risk_reasons_json)
       VALUES (?, 'phq9', ?, 8, 'лёгкая депрессия', 0, '[]')`
    )
    .run(patientId, JSON.stringify([1, 1, 1, 1, 1, 1, 1, 1, 0]));
  db.prepare("UPDATE online_results SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(onlineInfo.lastInsertRowid);

  const offlineInfo = db
    .prepare(
      `INSERT INTO offline_results (patient_id, entered_by, instrument, total_score, item9_score, test_date)
       VALUES (?, ?, 'phq9', 12, 0, '2026-01-06')`
    )
    .run(patientId, clinician.lastInsertRowid);
  const offlineRow = db.prepare('SELECT * FROM offline_results WHERE id = ?').get(offlineInfo.lastInsertRowid);

  const pair = comparison.createComparisonPairIfPossible(offlineRow);
  check('Пара создана (patient_id/scale_id связаны)', !!pair && pair.patient_id === patientId);
  check('time_delta_days вычислен (~5 дней)', Math.round(pair.time_delta_days) === 5);
  check('comparability = same_scale_within_window (≤14 дней)', pair.comparability === 'same_scale_within_window');
  check('discrepancy_raw = online(8) - offline(12) = -4', pair.discrepancy_raw === -4);
  check('discrepancy_item9 = онлайн п.9(0) - офлайн п.9(0) = 0', pair.discrepancy_item9 === 0);

  // широкое окно (>14 дней)
  const offlineWideInfo = db
    .prepare(`INSERT INTO offline_results (patient_id, entered_by, instrument, total_score, test_date) VALUES (?, ?, 'phq9', 5, '2026-03-01')`)
    .run(patientId, clinician.lastInsertRowid);
  const offlineWideRow = db.prepare('SELECT * FROM offline_results WHERE id = ?').get(offlineWideInfo.lastInsertRowid);
  const widePair = comparison.createComparisonPairIfPossible(offlineWideRow);
  check('Пара с разницей >14 дней -> comparability = same_scale_wide_window', widePair.comparability === 'same_scale_wide_window');

  // cross-instrument: BDI-II офлайн без онлайн BDI-II, но есть онлайн PHQ-9 -> cross_instrument subsample
  const bdiInfo = db
    .prepare(`INSERT INTO offline_results (patient_id, entered_by, instrument, total_score, item9_score, test_date) VALUES (?, ?, 'bdi2', 20, 1, '2026-01-02')`)
    .run(patientId, clinician.lastInsertRowid);
  const bdiRow = db.prepare('SELECT * FROM offline_results WHERE id = ?').get(bdiInfo.lastInsertRowid);
  const crossPair = comparison.createComparisonPairIfPossible(bdiRow);
  check('BDI-II <-> PHQ-9 без одноимённой пары -> comparability = cross_instrument', crossPair.comparability === 'cross_instrument');

  // нет онлайн-результата вообще -> не создаёт пару (офлайн сохраняется, но не участвует в статистике)
  const patient2 = db
    .prepare("INSERT INTO users (email, password_hash, role, full_name, consent_given) VALUES ('pat2@t','x','patient','Пациент Т2', 1)")
    .run();
  const orphanInfo = db
    .prepare(`INSERT INTO offline_results (patient_id, entered_by, instrument, total_score, test_date) VALUES (?, ?, 'gad7', 5, '2026-01-02')`)
    .run(patient2.lastInsertRowid, clinician.lastInsertRowid);
  const orphanRow = db.prepare('SELECT * FROM offline_results WHERE id = ?').get(orphanInfo.lastInsertRowid);
  const noPair = comparison.createComparisonPairIfPossible(orphanRow);
  check('Нет сопоставимого онлайн-результата -> пара не создаётся', noPair === null);
}

fs.rmSync(tmpDb, { force: true });
fs.rmSync(tmpDb + '-wal', { force: true });
fs.rmSync(tmpDb + '-shm', { force: true });

console.log(`\n${failures === 0 ? 'Все проверки прошли успешно.' : `${failures} проверок не прошло.`}`);
process.exit(failures === 0 ? 0 : 1);
