'use strict';

/**
 * Клинические шкалы и батарея психолога (RES-2, документы «Шкалы пациента
 * и патопсихологическая батарея психолога» + «Кризисный протокол»).
 *
 * Два класса методик:
 *  - patientSelfTest: true  — пациент сам проходит онлайн (PHQ-9, GAD-7,
 *    HADS, WHO-5, C-SSRS Screen) — используют scoreInstrument(answers).
 *  - patientSelfTest: false — очная батарея психолога (BDI-II, STAI, MMPI/
 *    СМИЛ) — психолог вводит итоговый балл/T-баллы вручную, система не
 *    воспроизводит сами пункты лицензируемых методик (BDI-II — Pearson,
 *    MMPI/СМИЛ — лицензируемый тест). Используют scoreClinicianEntry(fields).
 *
 * Пороги риска вынесены в riskRules.js (конфигурация, не хардкод здесь).
 */

const { RISK_RULES } = require('./riskRules');

const FREQ_OPTIONS = [
  { value: 0, label: 'Совсем не беспокоит' },
  { value: 1, label: 'Несколько дней' },
  { value: 2, label: 'Более половины дней' },
  { value: 3, label: 'Почти каждый день' },
];

const HADS_OPTIONS = [
  { value: 0, label: '0' },
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
];

const WHO5_OPTIONS = [
  { value: 0, label: 'Никогда' },
  { value: 1, label: 'Иногда' },
  { value: 2, label: 'Менее половины времени' },
  { value: 3, label: 'Более половины времени' },
  { value: 4, label: 'Большую часть времени' },
  { value: 5, label: 'Всё время' },
];

const YES_NO_OPTIONS = [
  { value: 0, label: 'Нет' },
  { value: 1, label: 'Да' },
];

const INSTRUMENTS = {
  phq9: {
    code: 'phq9',
    title: 'PHQ-9 (скрининг депрессии)',
    patientSelfTest: true,
    options: FREQ_OPTIONS,
    items: [
      'Снижение интереса или удовольствия от обычных дел',
      'Подавленность, депрессия или чувство безнадёжности',
      'Проблемы со сном (засыпание, прерывистый сон, пересыпание)',
      'Усталость или упадок сил',
      'Плохой аппетит или переедание',
      'Негативная самооценка — ощущение неудачи, вины перед собой или семьёй',
      'Трудности с концентрацией (чтение, просмотр ТВ)',
      'Замедленность или, наоборот, двигательное беспокойство, заметные окружающим',
      'Мысли о том, что было бы лучше умереть, или мысли о причинении себе вреда',
    ],
    // индекс (с 0) пункта о суицидальных мыслях — отдельный критерий кризиса
    criticalItemIndex: 8,
    maxPerItem: 3,
    bands: [
      { max: 4, label: 'минимальные симптомы' },
      { max: 9, label: 'лёгкая депрессия' },
      { max: 14, label: 'умеренная депрессия' },
      { max: 19, label: 'умеренно тяжёлая депрессия' },
      { max: 27, label: 'тяжёлая депрессия' },
    ],
    computeRisk(answers, total) {
      const rule = RISK_RULES.phq9;
      const reasons = [];
      if (answers[this.criticalItemIndex] >= rule.criticalItemMin) {
        reasons.push(`PHQ-9 пункт 9 ≥${rule.criticalItemMin} (мысли о причинении себе вреда) — ${rule.criticalItemAction}`);
      }
      if (total >= rule.severeTotalMin) {
        reasons.push(`PHQ-9 суммарный балл ${total} ≥ ${rule.severeTotalMin} (тяжёлая депрессия) — ${rule.severeAction}`);
      }
      return reasons;
    },
  },
  gad7: {
    code: 'gad7',
    title: 'GAD-7 (скрининг тревоги)',
    patientSelfTest: true,
    options: FREQ_OPTIONS,
    items: [
      'Чувство нервозности, тревоги или на взводе',
      'Невозможность остановить или контролировать беспокойство',
      'Чрезмерное беспокойство по разным поводам',
      'Трудно расслабиться',
      'Беспокойство настолько сильное, что трудно усидеть на месте',
      'Лёгкая раздражительность',
      'Ощущение, что вот-вот случится что-то ужасное',
    ],
    criticalItemIndex: null,
    maxPerItem: 3,
    bands: [
      { max: 4, label: 'минимальная тревога' },
      { max: 9, label: 'лёгкая тревога' },
      { max: 14, label: 'умеренная тревога' },
      { max: 21, label: 'тяжёлая тревога' },
    ],
    computeRisk(answers, total) {
      const rule = RISK_RULES.gad7;
      const reasons = [];
      if (total >= rule.severeTotalMin) {
        reasons.push(`GAD-7 суммарный балл ${total} ≥ ${rule.severeTotalMin} (тяжёлая тревога) — ${rule.severeAction}`);
      }
      return reasons;
    },
  },
  hads: {
    code: 'hads',
    title: 'HADS (тревога и депрессия)',
    patientSelfTest: true,
    options: HADS_OPTIONS,
    // 14 пунктов = 2 субшкалы по 7 (HADS-A тревога, HADS-D депрессия), чередование
    items: [
      { text: 'Я испытываю напряжение, мне не по себе', subscale: 'A' },
      { text: 'То, что раньше приносило удовольствие, и сейчас вызывает такое же чувство', subscale: 'D' },
      { text: 'Я испытываю страх, кажется, что вот-вот случится что-то ужасное', subscale: 'A' },
      { text: 'Я способен рассмеяться и увидеть смешное в том или ином событии', subscale: 'D' },
      { text: 'Беспокойные мысли крутятся у меня в голове', subscale: 'A' },
      { text: 'Я испытываю бодрость', subscale: 'D' },
      { text: 'Я легко могу сесть и расслабиться', subscale: 'A' },
      { text: 'Мне кажется, что я стал всё делать очень медленно', subscale: 'D' },
      { text: 'Я испытываю внутреннее напряжение или дрожь', subscale: 'A' },
      { text: 'Я не слежу за своей внешностью', subscale: 'D' },
      { text: 'Я испытываю неусидчивость, мне постоянно нужно двигаться', subscale: 'A' },
      { text: 'Я с удовольствием жду предстоящих событий', subscale: 'D' },
      { text: 'У меня бывают внезапные приступы паники', subscale: 'A' },
      { text: 'Я могу получить удовольствие от хорошей книги, радио- или телепрограммы', subscale: 'D' },
    ],
    criticalItemIndex: null,
    maxPerItem: 3,
    // пороги задаются на каждую субшкалу (0-21), не на сумму A+D
    bands: [
      { max: 7, label: 'норма' },
      { max: 10, label: 'субклинически выражено' },
      { max: 14, label: 'клинически выраженная тревога/депрессия' },
      { max: 21, label: 'тяжёлая тревога/депрессия' },
    ],
    computeSubscales(answers) {
      const sub = { A: 0, D: 0 };
      this.items.forEach((item, idx) => {
        sub[item.subscale] += answers[idx];
      });
      return sub;
    },
    computeRisk(answers, total, subscales) {
      const rule = RISK_RULES.hads;
      const reasons = [];
      if (subscales.A >= rule.subscaleClinicalMin) reasons.push(`HADS-A (тревога) ${subscales.A} ≥ ${rule.subscaleClinicalMin} — ${rule.subscaleAction}`);
      if (subscales.D >= rule.subscaleClinicalMin) reasons.push(`HADS-D (депрессия) ${subscales.D} ≥ ${rule.subscaleClinicalMin} — ${rule.subscaleAction}`);
      return reasons;
    },
  },
  who5: {
    code: 'who5',
    title: 'WHO-5 (индекс благополучия, еженедельный самомониторинг)',
    patientSelfTest: true,
    options: WHO5_OPTIONS,
    items: [
      'Я чувствовал(а) себя бодрым(ой) и в хорошем настроении',
      'Я чувствовал(а) себя спокойным(ой) и расслабленным(ой)',
      'Я чувствовал(а) себя активным(ой) и энергичным(ой)',
      'Я чувствовал(а) себя отдохнувшим(ой) после сна',
      'Моя повседневная жизнь была наполнена вещами, которые меня интересуют',
    ],
    criticalItemIndex: null,
    maxPerItem: 5,
    // сырой балл 0-25; интерпретационных «band»-диапазонов ВОЗ не задаёт —
    // используется только порог риска (см. computeRisk), band отражает его
    bands: [
      { max: 13, label: 'низкое благополучие (риск)' },
      { max: 25, label: 'в пределах нормы' },
    ],
    computeRisk(answers, total) {
      const rule = RISK_RULES.who5;
      const reasons = [];
      if (total <= rule.rawLowMax) {
        reasons.push(`WHO-5 сырой балл ${total} ≤ ${rule.rawLowMax} — ${rule.action}`);
      }
      return reasons;
    },
    // доп. представление: шкала 0-100 (сырой балл × 4), только для отображения
    scaledScore(total) {
      return total * 4;
    },
  },
  cssrs: {
    code: 'cssrs',
    title: 'C-SSRS Screen (скринер суицидального риска)',
    patientSelfTest: true,
    options: YES_NO_OPTIONS,
    // источник: Columbia Lighthouse Project, свободное использование с
    // указанием источника (RES-2 "crisis-protocol-clinical-draft" §1).
    // Вопросы предъявляются последовательно; если ответ «нет» — следующие
    // не задаются (skip-логика на уровне UI), но для простоты хранения
    // пациент отвечает на все 6 — custom-скорер игнорирует пункты после
    // первого «нет» согласно правилу «следующий вопрос только если да».
    items: [
      'Хотелось, чтобы вы были мёртвы, или хотелось заснуть и не проснуться?',
      'Были реальные мысли о том, чтобы покончить с собой?',
      'Думали о том, как вы могли бы это сделать (способ), без намерения это сделать?',
      'Были такие мысли и при этом какое-то намерение действовать, а не просто мысли?',
      'Начинали продумывать конкретный план, как именно и когда это сделать, с намерением его выполнить?',
      'За последние 3 месяца совершали какие-либо действия, готовились к попытке причинить себе вред, или была прерванная/остановленная попытка?',
    ],
    criticalItemIndex: null,
    maxPerItem: 1,
    bands: [
      { max: 0, label: 'риска не выявлено' },
      { max: 1, label: 'уровень 1 — пассивная идеация' },
      { max: 3, label: 'уровень 2-3 — идеация без намерения действовать' },
      { max: 5, label: 'уровень 4-5 — критический риск' },
    ],
    // не аддитивная сумма: вычисляем уровень идеации (индекс последнего
    // «да» среди вопросов 1-5) и факт поведения (вопрос 6)
    customScore(answers) {
      let ideationLevel = 0;
      for (let i = 0; i < 5; i += 1) {
        if (answers[i] === 1) ideationLevel = i + 1;
        else break; // skip-логика: следующий вопрос задаётся только если предыдущий «да»
      }
      const behavior = answers[5] === 1;
      return { ideationLevel, behavior };
    },
    computeRisk(answers, customResult) {
      const rule = RISK_RULES.cssrs;
      const reasons = [];
      if (rule.behaviorTriggersCritical && customResult.behavior) {
        reasons.push(`C-SSRS: позитивный ответ в блоке суицидального поведения — ${rule.action}`);
      }
      if (customResult.ideationLevel >= rule.ideationCriticalMin) {
        reasons.push(`C-SSRS: идеация уровня ${customResult.ideationLevel} ≥ ${rule.ideationCriticalMin} — ${rule.action}`);
      }
      return reasons;
    },
  },

  // ---------- Патопсихологическая батарея психолога (очный ввод) ----------

  bdi2: {
    code: 'bdi2',
    title: 'BDI-II (опросник депрессии Бека, вводит психолог)',
    patientSelfTest: false,
    // лицензируемая методика (Pearson) — система не воспроизводит пункты,
    // только принимает итоговый балл (0-63) и ответ на пункт 9 (0-3)
    totalRange: [0, 63],
    item9Range: [0, 3],
    bands: [
      { max: 13, label: 'минимальная депрессия' },
      { max: 19, label: 'лёгкая депрессия' },
      { max: 28, label: 'умеренная депрессия' },
      { max: 63, label: 'тяжёлая депрессия' },
    ],
    computeRisk({ item9Score }) {
      const rule = RISK_RULES.bdi2;
      const reasons = [];
      if (item9Score !== null && item9Score !== undefined) {
        if (item9Score === rule.criticalItemCriticalValue) {
          reasons.push(`BDI-II пункт 9 = ${rule.criticalItemCriticalValue} — ${rule.criticalAction}`);
        } else if (item9Score >= rule.criticalItemMin) {
          reasons.push(`BDI-II пункт 9 ≥ ${rule.criticalItemMin} — ${rule.criticalItemCheckAction}`);
        }
      }
      return reasons;
    },
  },
  stai: {
    code: 'stai',
    title: 'STAI / Спилбергер-Ханин (реактивная и личностная тревожность, вводит психолог)',
    patientSelfTest: false,
    // Первое приближение: психолог вводит уже подсчитанные суммы по
    // субшкалам (20-80 каждая). Официальный ключ обратных пунктов для
    // адаптации Ханина не зафиксирован в доступных материалах RES-2 —
    // пункт для подтверждения у ClinicalLead перед переходом на ввод по
    // сырым пунктам с автоматическим обратным подсчётом.
    subscales: ['state', 'trait'],
    subscaleRange: [20, 80],
    bands: [
      { max: 30, label: 'низкая тревожность' },
      { max: 44, label: 'умеренная тревожность' },
      { max: 80, label: 'высокая тревожность' },
    ],
    computeRisk() {
      // STAI не входит в сводную таблицу порогов движка эскалации (RES-2
      // "scales-and-battery" §3) — только интерпретация band, без флага риска
      return [];
    },
  },
  mmpi: {
    code: 'mmpi',
    title: 'MMPI/СМИЛ — релевантные шкалы (T-баллы, вводит психолог)',
    patientSelfTest: false,
    // лицензируемый тест — только T-баллы по шкалам 2 (D), 7 (Pt), 9 (Ma),
    // без автоинтерпретации профиля (это задача психолога)
    scales: RISK_RULES.mmpi.scales,
    scaleLabels: { scale2: 'Шкала 2 (депрессия, D)', scale7: 'Шкала 7 (психастения/тревога, Pt)', scale9: 'Шкала 9 (гипомания, Ma)' },
    tRange: [0, 120],
    computeRisk(subscales) {
      const rule = RISK_RULES.mmpi;
      const reasons = [];
      for (const scale of rule.scales) {
        const t = subscales[scale];
        if (typeof t === 'number' && t >= rule.tScoreMin) {
          reasons.push(`СМИЛ ${this.scaleLabels[scale]}: T=${t} ≥ ${rule.tScoreMin} — ${rule.action}`);
        }
      }
      return reasons;
    },
  },
};

function bandFor(instrument, total) {
  const band = instrument.bands.find((b) => total <= b.max);
  return band ? band.label : instrument.bands[instrument.bands.length - 1].label;
}

/**
 * Для patientSelfTest-инструментов: answers — массив целых, один на пункт,
 * по порядку. Возвращает { total, subscales, band, riskReasons, riskFlag }.
 * Для C-SSRS total/band вычисляются из customScore(), не аддитивно.
 */
function scoreInstrument(code, answers) {
  const instrument = INSTRUMENTS[code];
  if (!instrument || !instrument.patientSelfTest) throw new Error(`Unknown patient self-test instrument: ${code}`);
  const expectedLen = instrument.items.length;
  if (!Array.isArray(answers) || answers.length !== expectedLen) {
    throw new Error(`${code}: expected ${expectedLen} answers, got ${Array.isArray(answers) ? answers.length : typeof answers}`);
  }
  answers.forEach((a, idx) => {
    if (!Number.isInteger(a) || a < 0 || a > instrument.maxPerItem) {
      throw new Error(`${code}: answer[${idx}]=${a} out of range 0-${instrument.maxPerItem}`);
    }
  });

  if (code === 'cssrs') {
    const custom = instrument.customScore(answers);
    const total = custom.ideationLevel + (custom.behavior ? 1 : 0);
    const riskReasons = instrument.computeRisk(answers, custom);
    return {
      total,
      subscales: { ideationLevel: custom.ideationLevel, behavior: custom.behavior },
      band: bandFor(instrument, custom.ideationLevel),
      riskReasons,
      riskFlag: riskReasons.length > 0,
    };
  }

  const total = answers.reduce((s, a) => s + a, 0);
  let subscales = null;
  let riskReasons;
  let band;
  if (code === 'hads') {
    subscales = instrument.computeSubscales(answers);
    riskReasons = instrument.computeRisk(answers, total, subscales);
    // пороги HADS задаются на каждую субшкалу отдельно, не на сумму A+D
    // (RES-2 "scales-and-battery" §1.3) — band отражает более выраженную субшкалу
    band = `A: ${bandFor(instrument, subscales.A)}; D: ${bandFor(instrument, subscales.D)}`;
  } else {
    riskReasons = instrument.computeRisk(answers, total);
    band = bandFor(instrument, total);
  }

  return {
    total,
    subscales,
    band,
    riskReasons,
    riskFlag: riskReasons.length > 0,
  };
}

/**
 * Для clinician-entered инструментов (bdi2, stai, mmpi): психолог вводит
 * уже подсчитанный итог (а не сырые пункты лицензируемой методики).
 * fields: { totalScore, item9Score, subscales }
 */
function scoreClinicianEntry(code, fields) {
  const instrument = INSTRUMENTS[code];
  if (!instrument || instrument.patientSelfTest) throw new Error(`Unknown clinician-entered instrument: ${code}`);

  const { totalScore = null, item9Score = null, subscales = null } = fields;

  if (code === 'bdi2') {
    if (!Number.isInteger(totalScore) || totalScore < instrument.totalRange[0] || totalScore > instrument.totalRange[1]) {
      throw new Error(`bdi2: total_score должен быть целым числом ${instrument.totalRange[0]}-${instrument.totalRange[1]}`);
    }
    if (item9Score !== null && (!Number.isInteger(item9Score) || item9Score < instrument.item9Range[0] || item9Score > instrument.item9Range[1])) {
      throw new Error(`bdi2: item9_score должен быть целым числом ${instrument.item9Range[0]}-${instrument.item9Range[1]}`);
    }
    const riskReasons = instrument.computeRisk({ item9Score });
    return { total: totalScore, subscales: null, band: bandFor(instrument, totalScore), riskReasons, riskFlag: riskReasons.length > 0 };
  }

  if (code === 'stai') {
    const sub = subscales || {};
    for (const key of instrument.subscales) {
      const v = sub[key];
      if (!Number.isInteger(v) || v < instrument.subscaleRange[0] || v > instrument.subscaleRange[1]) {
        throw new Error(`stai: subscale "${key}" должна быть целым числом ${instrument.subscaleRange[0]}-${instrument.subscaleRange[1]}`);
      }
    }
    const riskReasons = instrument.computeRisk();
    // band считается отдельно по каждой субшкале; для сводной total_score
    // берём большую из двух (ситуативная/личностная) как ориентир серьёзности
    const worst = Math.max(sub.state, sub.trait);
    return { total: worst, subscales: sub, band: bandFor(instrument, worst), riskReasons, riskFlag: riskReasons.length > 0 };
  }

  if (code === 'mmpi') {
    const sub = subscales || {};
    for (const key of instrument.scales) {
      const v = sub[key];
      if (v !== null && v !== undefined && (!Number.isInteger(v) || v < instrument.tRange[0] || v > instrument.tRange[1])) {
        throw new Error(`mmpi: T-балл "${key}" должен быть целым числом ${instrument.tRange[0]}-${instrument.tRange[1]}`);
      }
    }
    const riskReasons = instrument.computeRisk(sub);
    const maxT = Math.max(...instrument.scales.map((k) => (typeof sub[k] === 'number' ? sub[k] : 0)));
    return { total: maxT || null, subscales: sub, band: null, riskReasons, riskFlag: riskReasons.length > 0 };
  }

  throw new Error(`scoreClinicianEntry: unsupported instrument ${code}`);
}

function listInstruments({ patientSelfTest } = {}) {
  return Object.values(INSTRUMENTS)
    .filter((i) => patientSelfTest === undefined || i.patientSelfTest === patientSelfTest)
    .map((i) => ({ code: i.code, title: i.title, patientSelfTest: i.patientSelfTest }));
}

module.exports = { INSTRUMENTS, scoreInstrument, scoreClinicianEntry, listInstruments };
