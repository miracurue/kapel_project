'use strict';

/**
 * Сравнение офлайн/онлайн результатов одного пациента (RES-2, документ
 * «Обзор литературы и методология», раздел 2). Создаёт запись пары
 * автоматически при сохранении офлайн-результата (§2.5) — без
 * дополнительных действий специалиста.
 */

const db = require('./db');

const COMPARABILITY_WINDOW_DAYS = 14;

// §2.3 п.1: единственная задокументированная cross-instrument пара в MVP —
// PHQ-9 (онлайн, пациент) <-> BDI-II (офлайн, психолог) — обе измеряют
// тяжесть депрессии, но это разные шкалы.
const CROSS_INSTRUMENT_PARTNER = { phq9: 'bdi2', bdi2: 'phq9' };

function daysBetween(dateA, dateB) {
  return Math.abs(new Date(dateA) - new Date(dateB)) / 86400000;
}

function onlineItem9(onlineResult) {
  if (!onlineResult || onlineResult.instrument !== 'phq9') return null;
  const answers = JSON.parse(onlineResult.answers_json);
  return answers[8];
}

/**
 * Вызывается сразу после INSERT в offline_results. Ищет последний
 * сопоставимый онлайн-результат пациента (сначала та же шкала, затем —
 * если задокументирована — cross-instrument партнёр) и создаёт пару.
 * Если сопоставимого онлайн-результата нет — ничего не делает (офлайн-
 * результат просто не участвует в статистике расхождений, §2.5 п.4).
 */
function createComparisonPairIfPossible(offlineResult) {
  const { patient_id: patientId, instrument, test_date: testDate } = offlineResult;

  const sameScale = db
    .prepare('SELECT * FROM online_results WHERE patient_id = ? AND instrument = ? ORDER BY created_at DESC LIMIT 1')
    .get(patientId, instrument);

  let onlineResult = sameScale;
  let crossInstrument = false;
  if (!onlineResult && CROSS_INSTRUMENT_PARTNER[instrument]) {
    onlineResult = db
      .prepare('SELECT * FROM online_results WHERE patient_id = ? AND instrument = ? ORDER BY created_at DESC LIMIT 1')
      .get(patientId, CROSS_INSTRUMENT_PARTNER[instrument]);
    crossInstrument = !!onlineResult;
  }

  if (!onlineResult) return null;

  const timeDeltaDays = daysBetween(testDate, onlineResult.created_at);
  const comparability = crossInstrument
    ? 'cross_instrument'
    : timeDeltaDays <= COMPARABILITY_WINDOW_DAYS
    ? 'same_scale_within_window'
    : 'same_scale_wide_window';

  const discrepancyRaw = onlineResult.total_score - offlineResult.total_score;
  const onlineI9 = onlineItem9(onlineResult);
  const offlineI9 = offlineResult.item9_score;
  const discrepancyItem9 =
    onlineI9 !== null && onlineI9 !== undefined && offlineI9 !== null && offlineI9 !== undefined ? onlineI9 - offlineI9 : null;

  const info = db
    .prepare(
      `INSERT OR IGNORE INTO comparison_pairs
         (patient_id, online_result_id, offline_result_id, online_scale, offline_scale, comparability, time_delta_days, discrepancy_raw, discrepancy_item9)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      patientId,
      onlineResult.id,
      offlineResult.id,
      onlineResult.instrument,
      instrument,
      comparability,
      timeDeltaDays,
      discrepancyRaw,
      discrepancyItem9
    );

  // discrepancy_item9: любое "онлайн п.9 ≥1, офлайн не зафиксировал риск" (или
  // наоборот) — не просто точка в статистике, а отдельный клинический сигнал
  // для ретроспективного safety review психиатром (§2.4), независимо от
  // объёма выборки. Здесь он только помечается (видно через discrepancy_item9
  // != null и |discrepancy_item9| > 0 в карточке пациента) — сам ретроспективный
  // просмотр делает специалист, не система.
  return info.lastInsertRowid ? db.prepare('SELECT * FROM comparison_pairs WHERE id = ?').get(info.lastInsertRowid) : null;
}

function listComparisonPairs(patientId) {
  return db
    .prepare(
      `SELECT cp.*, o.total_score AS online_total, o.created_at AS online_at,
              f.total_score AS offline_total, f.test_date AS offline_at
       FROM comparison_pairs cp
       JOIN online_results o ON o.id = cp.online_result_id
       JOIN offline_results f ON f.id = cp.offline_result_id
       WHERE cp.patient_id = ? AND f.invalid_at IS NULL
       ORDER BY cp.created_at DESC`
    )
    .all(patientId);
}

module.exports = { createComparisonPairIfPossible, listComparisonPairs, COMPARABILITY_WINDOW_DAYS, CROSS_INSTRUMENT_PARTNER };
