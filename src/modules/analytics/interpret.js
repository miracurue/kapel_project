'use strict';

// Толкование: из одних и тех же чисел разные тексты для пациента и для специалиста.
// Чистые функции, без обращений к базе. Пороги и формулировки — review-required (клинический владелец).

const MS_DAY = 86400000;
const dayNum = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / MS_DAY);
const mean = (list) => (list.length ? list.reduce((s, x) => s + x, 0) / list.length : null);
const round1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

const THRESHOLDS = {
  windowDays: 14,
  trendDelta: 0.4, // разница среднего между половинами окна, балла
  trendMinEntries: 4, // меньше записей — о динамике не говорим
  sleepDelta: 0.5, // разница настроения после хорошего и остального сна
  sleepMinEach: 2,
  anxietyRun: 3, // дней подряд с сильной тревогой
  recentDays: 3, // серия считается «текущей», если закончилась не раньше, дней назад
  lowMoodRun: 3, // дней подряд с настроением 1–2
};

/**
 * @param {Array<{day:string, mood?:number, sleep_score?:number, anxiety_score?:number, note_present?:number}>} days
 *   записи по дням, по возрастанию; не больше одной на день
 * @param {string} today YYYY-MM-DD
 */
function analyse(days, today, windowDays = THRESHOLDS.windowDays) {
  const t = dayNum(today);
  const win = days.filter((d) => dayNum(d.day) > t - windowDays && dayNum(d.day) <= t);
  const moods = win.filter((d) => d.mood != null);
  const half = Math.floor(moods.length / 2);
  const first = mean(moods.slice(0, half).map((d) => d.mood));
  const second = mean(moods.slice(half).map((d) => d.mood));
  let trend = null;
  if (moods.length >= THRESHOLDS.trendMinEntries && first !== null && second !== null) {
    const delta = second - first;
    trend = {
      direction: delta > THRESHOLDS.trendDelta ? 'up' : delta < -THRESHOLDS.trendDelta ? 'down' : 'flat',
      first: round1(first),
      second: round1(second),
    };
  }
  const slept = moods.filter((d) => d.sleep_score != null);
  const good = slept.filter((d) => d.sleep_score === 2).map((d) => d.mood);
  const other = slept.filter((d) => d.sleep_score !== 2).map((d) => d.mood);
  let sleepEffect = null;
  if (good.length >= THRESHOLDS.sleepMinEach && other.length >= THRESHOLDS.sleepMinEach) {
    const diff = mean(good) - mean(other);
    if (Math.abs(diff) >= THRESHOLDS.sleepDelta)
      sleepEffect = { good: round1(mean(good)), other: round1(mean(other)), better: diff > 0 };
  }
  // Последняя серия подряд идущих календарных дней, где выполняется условие.
  const runOf = (pick) => {
    let run = null;
    let prev = null;
    for (const d of win) {
      const n = dayNum(d.day);
      if (!pick(d)) {
        prev = n;
        continue;
      }
      run =
        run && prev === n - 1 && run.endDay === prev ? { length: run.length + 1, endDay: n } : { length: 1, endDay: n };
      prev = n;
    }
    return run && { length: run.length, endedDaysAgo: t - run.endDay };
  };
  const anxietyRun = runOf((d) => d.anxiety_score === 2);
  const lowRun = runOf((d) => d.mood != null && d.mood <= 2);
  const recent = (run, min) => (run && run.length >= min && run.endedDaysAgo <= THRESHOLDS.recentDays ? run : null);
  return {
    windowDays,
    recorded: win.length,
    mean_mood: round1(mean(moods.map((d) => d.mood))),
    trend,
    sleepEffect,
    anxietyStreak: recent(anxietyRun, THRESHOLDS.anxietyRun),
    lowMoodStreak: recent(lowRun, THRESHOLDS.lowMoodRun),
    notes: win.filter((d) => d.note_present).length,
  };
}

const num = (x) => String(x).replace('.', ',');
const dayWord = (n) =>
  n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
    ? 'дня'
    : n % 10 === 1 && n % 100 !== 11
      ? 'день'
      : 'дней';

/** Пациенту: мягко, без оценок и советов менять лечение. */
function forPatient(f) {
  const observations = [];
  if (f.trend) {
    observations.push({
      key: 'trend',
      text:
        f.trend.direction === 'up'
          ? `Вторая половина периода лучше первой: в среднем ${num(f.trend.second)} из 5 против ${num(f.trend.first)}.`
          : f.trend.direction === 'down'
            ? `Вторая половина периода тяжелее первой: в среднем ${num(f.trend.second)} из 5 против ${num(f.trend.first)}.`
            : `Настроение держится ровно, в среднем ${num(f.mean_mood)} из 5.`,
    });
  }
  if (f.sleepEffect) {
    observations.push({
      key: 'sleep',
      text: f.sleepEffect.better
        ? `После хорошего сна настроение выше: ${num(f.sleepEffect.good)} против ${num(f.sleepEffect.other)}.`
        : `После хорошего сна настроение не выше: ${num(f.sleepEffect.good)} против ${num(f.sleepEffect.other)}.`,
    });
  }
  if (f.recorded >= 5)
    observations.push({
      key: 'coverage',
      text: `Вы записали ${f.recorded} дней из ${f.windowDays}. Пропуски не страшны, важна общая картина.`,
    });
  const flag =
    f.anxietyStreak || f.lowMoodStreak
      ? {
          key: f.anxietyStreak ? 'anxiety_streak' : 'low_mood_streak',
          text: f.anxietyStreak
            ? `Сильная тревога была ${f.anxietyStreak.length} ${dayWord(f.anxietyStreak.length)} подряд. Если это продолжается, лучше сообщить специалисту.`
            : `Настроение было низким ${f.lowMoodStreak.length} ${dayWord(f.lowMoodStreak.length)} подряд. Если это продолжается, лучше сообщить специалисту.`,
          action: 'message_clinician',
        }
      : null;
  return { window_days: f.windowDays, observations, flag };
}

/** Специалисту: числа и факты без рекомендаций. */
function forClinician(f) {
  const lines = [];
  lines.push({
    key: 'coverage',
    text: `Дневник: ${f.recorded} записей за ${f.windowDays} дней${f.notes ? `, заметок ${f.notes}` : ''}.`,
  });
  if (f.mean_mood !== null) lines.push({ key: 'mean', text: `Среднее настроение ${num(f.mean_mood)} из 5.` });
  if (f.trend)
    lines.push({
      key: 'trend',
      text: `Динамика настроения: ${num(f.trend.first)} → ${num(f.trend.second)} (${f.trend.direction === 'up' ? 'рост' : f.trend.direction === 'down' ? 'снижение' : 'без заметных изменений'}).`,
    });
  if (f.sleepEffect)
    lines.push({
      key: 'sleep',
      text: `Настроение после хорошего сна ${num(f.sleepEffect.good)}, после остального ${num(f.sleepEffect.other)}.`,
    });
  if (f.anxietyStreak)
    lines.push({
      key: 'anxiety_streak',
      tone: 'warn',
      text: `Сильная тревога ${f.anxietyStreak.length} ${dayWord(f.anxietyStreak.length)} подряд${f.anxietyStreak.endedDaysAgo ? `, последний раз ${f.anxietyStreak.endedDaysAgo} дн. назад` : ', включая сегодня'}.`,
    });
  if (f.lowMoodStreak)
    lines.push({
      key: 'low_mood_streak',
      tone: 'warn',
      text: `Настроение 1–2 балла ${f.lowMoodStreak.length} ${dayWord(f.lowMoodStreak.length)} подряд.`,
    });
  return { window_days: f.windowDays, lines };
}

/**
 * Подавление малых групп (S-22, PD-19). cells: [{key, n}] — ячейки, которые в сумме дают итог
 * (например, число пациентов по полосам). Скрываем те, где n < min; если скрыта ровно одна —
 * скрываем ещё наименьшую из оставшихся, чтобы её нельзя было вычесть из итога.
 */
function suppressCells(cells, min) {
  const hidden = new Set(cells.filter((c) => c.n < min).map((c) => c.key));
  if (hidden.size === 1) {
    const rest = cells.filter((c) => !hidden.has(c.key)).sort((a, b) => a.n - b.n)[0];
    if (rest) hidden.add(rest.key);
  }
  return cells.map((c) => ({ ...c, suppressed: hidden.has(c.key) }));
}

module.exports = { analyse, forPatient, forClinician, suppressCells, THRESHOLDS };
