'use strict';

/**
 * Правила цветка и капелек в одном месте. Значения условные (демо), утверждает владелица.
 * Никаких штрафов, серий и «пропусков»: капельки только прибавляются, цветок не вянет.
 * drops — сколько капелек за одно событие; dailyCap — не больше капелек в день за это действие;
 * once — событие награждается один раз за всё время; backdated — можно ли награждать запись за прошлые дни
 * (нельзя: запись «задним числом» дальше вчерашнего дня капелек не даёт, чтобы не накручивать).
 */
const RULES = {
  diary: { drops: 3, dailyCap: 3, backdated: false },
  habit: { drops: 1, dailyCap: 3, backdated: false },
  med: { drops: 1, dailyCap: 3, backdated: false },
  test: { drops: 2, dailyCap: 4 },
  note: { drops: 1, dailyCap: 2, backdated: false },
  ai: { drops: 1, dailyCap: 2 },
  article: { drops: 1, dailyCap: 2 },
  plan: { drops: 2, dailyCap: 4 },
  visit: { drops: 3, dailyCap: 3 },
  start: { drops: 2, dailyCap: 2, once: true },
};

// Общий дневной предел. Часть событий в день может остаться без капелек — это не ошибка, они просто сверх нормы.
const DAILY_MAX = 15;

// Рост: один шаг стоит STEP_PRICE капелек, всего шагов столько же, сколько в прототипе (420 = 12 ветвей, 120 листьев, 12 цветов).
const STEP_PRICE = 2;
const MAX_STEPS = 420;
const WATER_MAX_STEPS = 20; // за один полив
// Этапы по числу шагов: «Росток» → «Пышная крона» (с 15% роста, как в прототипе) → «Цветение» (первый цветок — 193-й шаг).
const STAGES = [
  { key: 'sprout', from: 0 },
  { key: 'crown', from: 63 },
  { key: 'bloom', from: 193 },
];

module.exports = { RULES, DAILY_MAX, STEP_PRICE, MAX_STEPS, WATER_MAX_STEPS, STAGES };
