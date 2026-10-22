'use strict';

/**
 * Кризисный протокол — Tier 0-3, триггеры A-F, SLA подтверждения и
 * эскалация по цепочке дежурства (RES-2, документ «Кризисный протокол»,
 * разделы 2-3). ИИ-слой здесь только детектирует триггер и уведомляет
 * специалиста — решение о мерах всегда принимает психиатр/психолог.
 *
 * Триггеры (раздел 2, любой запускает протокол):
 *  A — C-SSRS: позитивный ответ в блоке суицидального поведения
 *  B — C-SSRS: идеация уровня 4 или 5
 *  C — PHQ-9 пункт 9 ≥1 (под-триггер: сам по себе не критический, но
 *      обязательно назначает C-SSRS Screen)
 *  D — BDI-II пункт 9 ≥2 (сверка с C-SSRS; =3 — критический)
 *  E — свободный текст классифицирован NLP-классификатором риска
 *      (см. riskClassifier.js)
 *  F — раскрытие текущего/недавнего самоповреждения без сопутствующего
 *      суицидального намерения (NSSI)
 */

const TIERS = Object.freeze({ ROUTINE: 0, MONITORING: 1, HIGH: 2, CRITICAL: 3 });

/**
 * signal:
 *  - phq9Item9: 0-3 | null
 *  - cssrsIdeationLevel: 0-5 | null
 *  - cssrsBehavior: boolean | null
 *  - bdi2Item9: 0-3 | null
 *  - nlpCategories: number[] (категории 1-5 риск-классификатора, если сработали)
 *  - nssiDisclosed: boolean (триггер F из C-SSRS-блока поведения без идеации, либо из текста)
 *  - severeMoodScreen: boolean (PHQ-9 ≥20 / GAD-7 ≥15 / HADS субшкала ≥11 — «тяжёлый
 *    диапазон», используется для Tier 1 без суицидального контента и как
 *    «доп. фактор риска» для Tier 2)
 */
function evaluateCrisisTier(signal = {}) {
  const {
    phq9Item9 = null,
    cssrsIdeationLevel = null,
    cssrsBehavior = null,
    bdi2Item9 = null,
    nlpCategories = [],
    nssiDisclosed = false,
    severeMoodScreen = false,
  } = signal;

  const triggers = [];
  if (cssrsBehavior === true) triggers.push('A');
  if (typeof cssrsIdeationLevel === 'number' && cssrsIdeationLevel >= 4) triggers.push('B');
  if (typeof phq9Item9 === 'number' && phq9Item9 >= 1) triggers.push('C');
  if (typeof bdi2Item9 === 'number' && bdi2Item9 >= 2) triggers.push('D');
  if (Array.isArray(nlpCategories) && nlpCategories.length > 0) triggers.push('E');
  if (nssiDisclosed) triggers.push('F');

  // Tier 3 — критический риск: A, B, D(=3), E
  if (triggers.includes('A') || triggers.includes('B') || bdi2Item9 === 3 || triggers.includes('E')) {
    return { tier: TIERS.CRITICAL, triggers };
  }

  // Tier 2 — высокий риск: идеация 2-3 + доп. фактор, PHQ-9 п.9 ≥2 + идеация ≥2, либо F (NSSI)
  const ideation2or3 = typeof cssrsIdeationLevel === 'number' && cssrsIdeationLevel >= 2 && cssrsIdeationLevel <= 3;
  const phq9WithIdeation = typeof phq9Item9 === 'number' && phq9Item9 >= 2 && typeof cssrsIdeationLevel === 'number' && cssrsIdeationLevel >= 2;
  if ((ideation2or3 && severeMoodScreen) || triggers.includes('F') || phq9WithIdeation) {
    return { tier: TIERS.HIGH, triggers };
  }

  // Tier 1 — повышенное внимание: PHQ-9 п.9 = 1 при отрицательном C-SSRS, либо
  // тяжёлый диапазон GAD-7/HADS без суицидального контента
  const passiveIdeationOnly = triggers.includes('C') && (cssrsIdeationLevel === null || cssrsIdeationLevel === 0);
  if (passiveIdeationOnly || (severeMoodScreen && triggers.length === 0)) {
    return { tier: TIERS.MONITORING, triggers };
  }

  return { tier: TIERS.ROUTINE, triggers };
}

// W-41 (S-18, S-30): срок реакции и рабочие часы берутся из действующих версий
// настроек (модуль settings передаёт провайдер при старте). Без провайдера —
// прежние встроенные значения, поведение не меняется.
let settingsProvider = null;

function setSettingsProvider(fn) {
  settingsProvider = fn;
}

function settingValue(key, fallback) {
  try {
    const s = settingsProvider ? settingsProvider(key) : null;
    return s && s.value != null ? s.value : fallback;
  } catch (_) {
    return fallback;
  }
}

function isBusinessHours(date = new Date()) {
  const cfg = settingValue('org.timezone_hours', null) || {};
  const timezone = cfg.timezone || 'Europe/Moscow';
  const days = Array.isArray(cfg.days) ? cfg.days : [1, 2, 3, 4, 5];
  const from = String(cfg.work_from || '09:00');
  const to = String(cfg.work_to || '18:00');
  const holidays = Array.isArray(cfg.holidays) ? cfg.holidays.map((d) => String(d).slice(0, 10)) : [];
  // Локальное время организации в её поясе (S-30).
  const local = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
  if (holidays.includes(local.toISOString().slice(0, 10))) return false;
  if (!days.includes(local.getDay())) return false; // 0=вс…6=сб
  const minutes = local.getHours() * 60 + local.getMinutes();
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  return minutes >= fh * 60 + fm && minutes < th * 60 + tm;
}

/**
 * SLA подтверждения эскалации (раздел 3): сроки — настройка S-18 crisis.sla
 * (рабочее / нерабочее время; по умолчанию 15 и 30 минут — как в коде раньше).
 * Tier 0/1 не требуют немедленного ack — due_at не выставляется.
 */
function computeDueAt(tier, now = new Date()) {
  if (tier < TIERS.HIGH) return null;
  const sla = settingValue('crisis.sla', null) || {};
  const work = Number.isFinite(Number(sla.work_minutes)) ? Number(sla.work_minutes) : 15;
  const off = Number.isFinite(Number(sla.off_minutes)) ? Number(sla.off_minutes) : 30;
  const slaMinutes = isBusinessHours(now) ? work : off;
  return new Date(now.getTime() + slaMinutes * 60000).toISOString();
}

module.exports = { TIERS, evaluateCrisisTier, isBusinessHours, computeDueAt, setSettingsProvider };
