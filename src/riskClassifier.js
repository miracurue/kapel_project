'use strict';

/**
 * NLP/keyword-классификатор риска по свободному тексту (RES-2, документ
 * «Кризисный протокол», раздел 2, подраздел «Категории риск-классификатора»)
 * — триггер E кризисного протокола.
 *
 * ⚠️ СТАТУС ФОРМУЛИРОВОК: ЧЕРНОВИК, НЕ УТВЕРЖДЁН. Задача RES-11 прямо
 * запрещает финализировать точные ключевые фразы инженеру — это зона
 * ClinicalLead (клиническая точность) и ComplianceCounsel (юридические
 * риски формулировок). Списки ниже — минимальный рабочий набор для
 * демонстрации архитектуры на синтетических данных, НЕ для продакшена.
 * Перед реальным использованием — обязательное ревью ClinicalLead +
 * ComplianceCounsel и замена DRAFT_KEYWORDS на утверждённый словарь.
 *
 * Категории (минимальный набор по документу):
 *  1 — явное указание на план (способ + время/место)
 *  2 — указание на доступ к средствам (лекарства в дозе, оружие и т.п.)
 *  3 — прощальные формулировки / приведение дел в порядок ради уход
 *  4 — намерение «покончить с собой» / «не хочу жить» + безнадёжность
 *  5 — сообщение о текущем самоповреждении «прямо сейчас» / «только что»
 */

const CATEGORIES = Object.freeze({
  PLAN: 1,
  MEANS_ACCESS: 2,
  FAREWELL: 3,
  INTENT_HOPELESSNESS: 4,
  CURRENT_SELF_HARM: 5,
});

// DRAFT — не финализировано, см. предупреждение выше.
const DRAFT_KEYWORDS = {
  [CATEGORIES.PLAN]: ['у меня есть план, как', 'решил(а), как это сделаю', 'сделаю это сегодня вечером', 'знаю, как и когда'],
  [CATEGORIES.MEANS_ACCESS]: ['у меня есть таблетки, чтобы', 'собрал(а) достаточно таблеток', 'есть оружие дома и я', 'купил(а) веревку чтобы'],
  [CATEGORIES.FAREWELL]: ['прощайте все', 'это моё последнее сообщение', 'раздаю свои вещи', 'написал(а) прощальное письмо'],
  [CATEGORIES.INTENT_HOPELESSNESS]: ['покончить с собой', 'не хочу жить', 'незачем жить', 'нет смысла жить', 'убить себя', 'хочу умереть'],
  [CATEGORIES.CURRENT_SELF_HARM]: ['режу себя прямо сейчас', 'только что порезал(а) себя', 'сейчас причиняю себе боль'],
};

// Коды триггеров S-55 → категории классификатора (имена как в настройке).
const CATEGORY_BY_NAME = {
  PLAN: CATEGORIES.PLAN,
  MEANS_ACCESS: CATEGORIES.MEANS_ACCESS,
  FAREWELL: CATEGORIES.FAREWELL,
  INTENT_HOPELESSNESS: CATEGORIES.INTENT_HOPELESSNESS,
  CURRENT_SELF_HARM: CATEGORIES.CURRENT_SELF_HARM,
};

// W-41 (S-55): действующий словарь задаётся настройкой crisis.rules. Пока версия
// не включена, работает встроенный черновой набор; после «Включить» — словарь
// из настройки, сразу и без перезапуска (setActiveRules вызывает модуль settings).
let activeRules = null;

function phrasesOf(rules) {
  if (!rules || typeof rules !== 'object') return [];
  if (Array.isArray(rules.phrases)) return rules.phrases;
  if (Array.isArray(rules.dictionary)) return rules.dictionary;
  return [];
}

function categoryOfPhrase(phrase) {
  const byName = CATEGORY_BY_NAME[String(phrase.code || '').trim().toUpperCase()];
  if (byName) return byName;
  if (Number.isInteger(phrase.category) && phrase.category >= 1 && phrase.category <= 5) return phrase.category;
  return CATEGORIES.INTENT_HOPELESSNESS; // уровень «high» по умолчанию — намерение/безнадёжность
}

// Чистая проверка текста по конкретному словарю (нужна проверке регрессии S-55).
function classifyWithRules(rules, text) {
  const t = String(text || '').toLowerCase();
  if (!t) return [];
  const hit = [];
  for (const phrase of phrasesOf(rules)) {
    const needle = String(phrase.text || '').toLowerCase();
    if (needle && t.includes(needle)) {
      const category = categoryOfPhrase(phrase);
      if (!hit.includes(category)) hit.push(category);
    }
  }
  return hit;
}

function setActiveRules(rules) {
  activeRules = rules && phrasesOf(rules).length ? rules : null;
}

/**
 * Возвращает список сработавших категорий (1-5) в свободном тексте.
 * Возвращает [] если ничего не сработало — вызывающий код трактует
 * непустой список как триггер E кризисного протокола.
 */
function classifyFreeText(text) {
  if (!text) return [];
  if (activeRules) return classifyWithRules(activeRules, text);
  const t = text.toLowerCase();
  const hit = [];
  for (const [category, phrases] of Object.entries(DRAFT_KEYWORDS)) {
    if (phrases.some((p) => t.includes(p))) hit.push(Number(category));
  }
  return hit;
}

// Триггер F (NSSI — раскрытие самоповреждения без суицидального намерения):
// отдельный, более узкий список — DRAFT, та же оговорка про финализацию.
const NSSI_DRAFT_KEYWORDS = ['режу себя', 'наношу себе порезы', 'я себя порезал(а)', 'причиняю себе боль', 'самоповреждение'];

function detectNssiDisclosure(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return NSSI_DRAFT_KEYWORDS.some((p) => t.includes(p));
}

module.exports = { CATEGORIES, classifyFreeText, classifyWithRules, setActiveRules, detectNssiDisclosure, phrasesOf, DRAFT_KEYWORDS };
