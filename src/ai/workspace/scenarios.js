'use strict';

// Сценарии-подсказки ИИ-пространства врача (REQ-AID-004). Тексты шаблонов в stub.js — REVIEW-REQUIRED.
// Кнопка отправляет в тред сообщение-заголовок сценария; заглушка собирает ответ из данных сервиса и шаблонов.

const SCENARIOS = [
  { key: 'summary', title: 'Сводка к приёму', needsPatient: true, hint: 'Данные сервиса по пациенту: результаты, динамика, дневник.' },
  { key: 'dynamics', title: 'Сравнить динамику за период', needsPatient: true, hint: 'Изменение баллов по шкалам и оценок дневника.', period: true },
  { key: 'recommendations', title: 'Черновик рекомендаций пациенту', needsPatient: true, hint: 'Нейтральный текст для пациента без лекарств и доз.' },
  { key: 'referral', title: 'Черновик направления / выписки', needsPatient: true, hint: 'Шаблон документа с полями для заполнения врачом.' },
  { key: 'questions', title: 'Что уточнить на приёме', needsPatient: false, hint: 'Перечень вопросов; точнее — если выбран пациент или есть материалы.' },
  { key: 'hypotheses', title: 'Гипотезы для дифдиагностики (не диагноз)', needsPatient: false, hint: 'Направления для клинической проверки, не диагноз.' },
  { key: 'retest', title: 'План повторного тестирования', needsPatient: true, hint: 'Какие шкалы и когда стоит пройти повторно.' },
];

const BY_KEY = new Map(SCENARIOS.map((s) => [s.key, s]));
const BY_TITLE = new Map(SCENARIOS.map((s) => [s.title, s]));

const PERIODS = [
  { days: 30, label: '30 дней' },
  { days: 90, label: '3 месяца' },
  { days: 180, label: '6 месяцев' },
  { days: 365, label: 'год' },
];

function get(key) {
  return BY_KEY.get(String(key || '')) || null;
}

function byTitle(title) {
  return BY_TITLE.get(String(title || '')) || null;
}

function period(days) {
  const n = Number(days);
  return PERIODS.find((p) => p.days === n) || null;
}

module.exports = { SCENARIOS, PERIODS, get, byTitle, period };
