'use strict';

/**
 * Конфигурация порогов для движка эскалации — транслитерация «Сводной
 * таблицы порогов» из RES-2, документ «Шкалы пациента и патопсихологическая
 * батарея психолога», раздел 3. Это чистые данные, не привязанные к UI —
 * instruments.js читает их для computeRisk(), а не дублирует числа.
 *
 * Статус клинического содержания: v1, готово к реализации (см. источник).
 * Если ClinicalLead присылает финальную/изменённую версию — правится здесь,
 * остальной код (instruments.js, crisisProtocol.js) не трогается.
 */

const RISK_RULES = {
  phq9: {
    criticalItemIndex: 8,
    criticalItemMin: 1,
    criticalItemAction: 'обязательное назначение C-SSRS Screen, флаг психиатру',
    severeTotalMin: 20,
    severeAction: 'флаг «тяжёлая депрессия», уведомление психиатру в течение 48ч',
  },
  gad7: {
    severeTotalMin: 15,
    severeAction: 'флаг «тяжёлая тревога»',
  },
  hads: {
    subscaleClinicalMin: 11,
    subscaleAction: 'флаг «клинически выраженная тревога/депрессия»',
  },
  who5: {
    // сырой балл (0-25), не шкала 0-100
    rawLowMax: 13,
    action: 'предложить PHQ-9/GAD-7, если давно не проходил',
  },
  cssrs: {
    behaviorTriggersCritical: true,
    ideationCriticalMin: 4,
    action: 'критический, см. Кризисный протокол',
  },
  bdi2: {
    criticalItemMin: 2,
    criticalItemCheckAction: 'сверка с C-SSRS',
    criticalItemCriticalValue: 3,
    criticalAction: 'критический',
  },
  mmpi: {
    tScoreMin: 70,
    scales: ['scale2', 'scale7', 'scale9'],
    action: 'флаг психиатру для интерпретации профиля',
  },
};

module.exports = { RISK_RULES };
