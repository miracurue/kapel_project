'use strict';

/**
 * Каталог методик: единый реестр для назначения и ввода результатов (W0.4).
 *
 * Два источника записей:
 *  1. Реальные шкалы из src/instruments.js (PHQ-9, GAD-7, HADS, WHO-5, C-SSRS,
 *     BDI-II, STAI, СМИЛ). Подсчёт, пороги и кризисные правила остаются там и
 *     не дублируются: запись каталога только ссылается на них (status 'implemented').
 *  2. Заглушки (status 'stub', review_required true) — демонстрационные записи
 *     российской психиатрии и патопсихологии. Это НЕ клинически валидные версии:
 *     пункты — оригинальные демо-формулировки, пороги и ключи не выдуманы
 *     (band всегда «демо», без risk_flag и кризисных триггеров).
 *
 * mode:
 *  - 'online'          — реальная шкала, пациент проходит сам (подсчёт в instruments.js)
 *  - 'online_stub'     — демо-заглушка, пациент проходит универсальным экраном
 *  - 'clinician_entered' — врач вводит протокол (время/ошибки/наблюдения/баллы)
 *
 * Как добавить заглушку: добавьте строку в STUB_DEFS ниже (см. комментарий).
 */

const { INSTRUMENTS, scoreInstrument } = require('./instruments');

const STUB_DISCLAIMER = 'Демонстрационная заглушка, не клинически валидная версия.';
const STUB_BAND = 'демо';

const DOMAINS = {
  depression: 'Депрессия',
  anxiety: 'Тревога',
  mania: 'Мания',
  sleep: 'Сон',
  addiction: 'Зависимости',
  cognition: 'Когнитивные функции',
  ocd: 'ОКР',
  trauma: 'Травма и ПТСР',
  fatigue: 'Утомляемость',
  wellbeing: 'Благополучие',
  suicide_risk: 'Суицидальный риск',
  memory: 'Память',
  thinking: 'Мышление',
  attention: 'Внимание и работоспособность',
  self_esteem: 'Самооценка',
  personality: 'Личность',
  projective: 'Проективные методики',
};

const KINDS = {
  scale: 'Шкала',
  pathopsych_experiment: 'Патопсихологический эксперимент',
  projective: 'Проективная методика',
  questionnaire: 'Опросник',
};

const MODES = {
  online: 'Онлайн (пациент)',
  online_stub: 'Онлайн (демо-заглушка)',
  clinician_entered: 'Ввод врачом',
};

// Универсальная форма протокола для clinician_entered (поля общие для всех).
const PROTOCOL_FIELDS = [
  { name: 'duration_sec', label: 'Время выполнения, сек', type: 'number', min: 0 },
  { name: 'errors', label: 'Ошибки, количество', type: 'number', min: 0 },
  { name: 'score', label: 'Баллы (по протоколу врача)', type: 'number', min: 0 },
  { name: 'observations', label: 'Наблюдения', type: 'textarea' },
];

const DEMO_OPTIONS = [
  { value: 0, label: 'Совсем нет' },
  { value: 1, label: 'Иногда' },
  { value: 2, label: 'Часто' },
  { value: 3, label: 'Почти всегда' },
];

// Тексты пунктов заглушек — нейтральные плейсхолдеры (REQ-CAT-004, review-required): формулировок
// реальных опросников и тематических пересказов здесь нет, их добавляет владелец после клинического ревью.
const DEMO_ITEM_COUNT = 4;
function demoItems() {
  return Array.from({ length: DEMO_ITEM_COUNT }, (_, i) => `Демонстрационный вопрос ${i + 1} — текст будет заменён после клинического ревью`);
}

/**
 * Определения заглушек: [code, title, domain, kind, mode, demoItemsDomain|null].
 * Для online_stub берутся 3-4 демо-пункта по ключу области; для
 * clinician_entered пункты не нужны (универсальная форма протокола).
 */
const STUB_DEFS = [
  // шкалы психиатрии
  ['hdrs17', 'HDRS-17 (шкала депрессии Гамильтона)', 'depression', 'scale', 'clinician_entered'],
  ['hars', 'HARS (шкала тревоги Гамильтона)', 'anxiety', 'scale', 'clinician_entered'],
  ['madrs', 'MADRS (шкала депрессии Монтгомери–Асберг)', 'depression', 'scale', 'clinician_entered'],
  ['bai', 'BAI (шкала тревоги Бека)', 'anxiety', 'scale', 'online_stub', 'anxiety'],
  ['zung_sds', 'Шкала депрессии Цунга (SDS)', 'depression', 'scale', 'online_stub', 'depression'],
  ['zung_sas', 'Шкала тревоги Цунга (SAS)', 'anxiety', 'scale', 'online_stub', 'anxiety'],
  ['ymrs', 'YMRS (шкала мании Янга)', 'mania', 'scale', 'clinician_entered'],
  ['isi', 'ISI (индекс тяжести бессонницы)', 'sleep', 'scale', 'online_stub', 'sleep'],
  ['audit', 'AUDIT (употребление алкоголя)', 'addiction', 'scale', 'online_stub', 'addiction'],
  ['mfi20', 'MFI-20 (многомерная шкала усталости)', 'fatigue', 'scale', 'online_stub', 'fatigue'],
  ['moca', 'MoCA (Монреальская шкала когнитивной оценки)', 'cognition', 'scale', 'clinician_entered'],
  ['mmse', 'MMSE (краткая шкала оценки психического статуса)', 'cognition', 'scale', 'clinician_entered'],
  ['ybocs', 'Y-BOCS (шкала навязчивостей и компульсий Йеля–Брауна)', 'ocd', 'scale', 'clinician_entered'],
  ['pcl5', 'PCL-5 (чек-лист симптомов ПТСР)', 'trauma', 'scale', 'online_stub', 'trauma'],
  // патопсихологические эксперименты
  ['luria10', '«10 слов» Лурия', 'memory', 'pathopsych_experiment', 'clinician_entered'],
  ['pictogram', 'Пиктограммы', 'memory', 'pathopsych_experiment', 'clinician_entered'],
  ['classification', 'Классификация предметов', 'thinking', 'pathopsych_experiment', 'clinician_entered'],
  ['exclusion', 'Исключение предметов', 'thinking', 'pathopsych_experiment', 'clinician_entered'],
  ['concept_compare', 'Сравнение понятий', 'thinking', 'pathopsych_experiment', 'clinician_entered'],
  ['proverbs', 'Пословицы и метафоры', 'thinking', 'pathopsych_experiment', 'clinician_entered'],
  ['schulte', 'Таблицы Шульте', 'attention', 'pathopsych_experiment', 'clinician_entered'],
  ['kraepelin', 'Счёт по Крепелину', 'attention', 'pathopsych_experiment', 'clinician_entered'],
  ['bourdon', 'Корректурная проба Бурдона', 'attention', 'pathopsych_experiment', 'clinician_entered'],
  ['toulouse_pieron', 'Тулуз–Пьерон', 'attention', 'pathopsych_experiment', 'clinician_entered'],
  ['assoc_experiment', 'Ассоциативный эксперимент', 'thinking', 'pathopsych_experiment', 'clinician_entered'],
  ['shchur_ladder', 'Лестница (Щур)', 'self_esteem', 'pathopsych_experiment', 'clinician_entered'],
  ['dembo_rubinstein', 'Самооценка Дембо–Рубинштейн', 'self_esteem', 'pathopsych_experiment', 'online_stub', 'self_esteem'],
  // личностные и проективные
  ['epi', 'Опросник Айзенка (EPI)', 'personality', 'questionnaire', 'online_stub', 'personality'],
  ['cattell16pf', 'Опросник Кеттелла (16PF)', 'personality', 'questionnaire', 'online_stub', 'personality'],
  ['leonhard', 'Опросник Леонгарда–Шмишека', 'personality', 'questionnaire', 'online_stub', 'personality'],
  ['ito', 'ИТО (индивидуально-типологический опросник)', 'personality', 'questionnaire', 'online_stub', 'personality'],
  ['rorschach', 'Тест Роршаха', 'projective', 'projective', 'clinician_entered'],
  ['tat', 'ТАТ (тематический апперцептивный тест)', 'projective', 'projective', 'clinician_entered'],
  ['nonexistent_animal', '«Несуществующее животное»', 'projective', 'projective', 'clinician_entered'],
  ['draw_a_person', 'Рисунок человека', 'projective', 'projective', 'clinician_entered'],
  ['rosenzweig', 'Тест Розенцвейга', 'projective', 'projective', 'clinician_entered'],
  ['luscher', 'Тест Люшера', 'projective', 'projective', 'clinician_entered'],
];

function buildStub([code, title, domain, kind, mode, itemsKey]) {
  const stub = {
    code,
    title,
    domain,
    kind,
    mode,
    status: 'stub',
    review_required: true,
    source_note:
      `${STUB_DISCLAIMER} Оригинальные пункты, ключи и нормы методики «${title}» не воспроизведены; ` +
      'требуется клиническая проверка и проверка лицензионных условий до любого использования.',
    disclaimer: STUB_DISCLAIMER,
    patientSelfTest: false,
  };
  if (mode === 'online_stub') {
    stub.items = demoItems();
    stub.options = DEMO_OPTIONS;
    stub.maxPerItem = 3;
    stub.scoring = { type: 'sum', band: STUB_BAND, note: 'Демо-подсчёт: простая сумма, порогов нет.' };
  } else {
    stub.items = [];
    stub.protocolFields = PROTOCOL_FIELDS;
    stub.scoring = { type: 'protocol', band: STUB_BAND, note: 'Баллы вводит врач; автоматической интерпретации нет.' };
  }
  return stub;
}

function realEntry(code, domain, kind) {
  const def = INSTRUMENTS[code];
  return {
    code,
    title: def.title,
    domain,
    kind,
    mode: def.patientSelfTest ? 'online' : 'clinician_entered',
    status: 'implemented',
    review_required: true, // как и прежде: клинические шкалы — на проверке владельцем
    source_note: 'Реальная шкала из src/instruments.js; подсчёт и пороги — там.',
    patientSelfTest: !!def.patientSelfTest,
    legacyOffline: !def.patientSelfTest, // ввод через прежнюю форму офлайн-результатов
  };
}

const CATALOG = [
  realEntry('phq9', 'depression', 'scale'),
  realEntry('gad7', 'anxiety', 'scale'),
  realEntry('hads', 'anxiety', 'scale'),
  realEntry('who5', 'wellbeing', 'scale'),
  realEntry('cssrs', 'suicide_risk', 'scale'),
  realEntry('bdi2', 'depression', 'scale'),
  realEntry('stai', 'anxiety', 'questionnaire'),
  realEntry('mmpi', 'personality', 'questionnaire'),
  ...STUB_DEFS.map(buildStub),
];

const BY_CODE = new Map(CATALOG.map((e) => [e.code, e]));

const getEntry = (code) => BY_CODE.get(String(code)) || null;
const isStub = (code) => !!getEntry(code) && getEntry(code).status === 'stub';
const isOnlineAssignable = (code) => {
  const e = getEntry(code);
  return !!e && (e.mode === 'online' || e.mode === 'online_stub');
};

function listCatalog(filter = {}) {
  return CATALOG.filter((e) => (!filter.mode || e.mode === filter.mode) && (!filter.status || e.status === filter.status));
}

// Для формы выбора: [{ domain, label, kinds: [{ kind, label, entries: [...] }] }]
function groupedCatalog(predicate = () => true) {
  const out = [];
  for (const [domain, label] of Object.entries(DOMAINS)) {
    const inDomain = CATALOG.filter((e) => e.domain === domain && predicate(e));
    if (!inDomain.length) continue;
    const kinds = Object.keys(KINDS)
      .map((kind) => ({ kind, label: KINDS[kind], entries: inDomain.filter((e) => e.kind === kind) }))
      .filter((k) => k.entries.length);
    out.push({ domain, label, kinds });
  }
  return out;
}

/** Универсальный демо-подсчёт для online_stub: сумма, band «демо», без риска. */
function scoreStub(code, answers) {
  const e = getEntry(code);
  if (!e || e.mode !== 'online_stub') throw new Error(`Unknown online stub: ${code}`);
  if (!Array.isArray(answers) || answers.length !== e.items.length) {
    throw new Error(`${code}: expected ${e.items.length} answers`);
  }
  answers.forEach((a, i) => {
    if (!Number.isInteger(a) || a < 0 || a > e.maxPerItem) throw new Error(`${code}: answer[${i}]=${a} out of range 0-${e.maxPerItem}`);
  });
  return { total: answers.reduce((s, a) => s + a, 0), subscales: null, band: STUB_BAND, riskReasons: [], riskFlag: false };
}

/** Определение методики для экрана прохождения (реальная или заглушка). */
function getTakeable(code) {
  if (INSTRUMENTS[code] && INSTRUMENTS[code].patientSelfTest) return INSTRUMENTS[code];
  const e = getEntry(code);
  return e && e.mode === 'online_stub' ? e : null;
}

/** Подсчёт любого онлайн-прохождения: реальные шкалы — прежний scoreInstrument. */
function scoreAny(code, answers) {
  if (INSTRUMENTS[code]) return scoreInstrument(code, answers);
  return scoreStub(code, answers);
}

/** Валидация и нормализация универсального протокола врача. */
function normalizeProtocol(body) {
  const num = (v, label) => {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${label}: неотрицательное число`);
    return n;
  };
  return {
    duration_sec: num(body.duration_sec, 'Время'),
    errors: num(body.errors, 'Ошибки'),
    score: num(body.score, 'Баллы'),
    observations: body.observations ? String(body.observations).slice(0, 4000) : null,
  };
}

module.exports = {
  CATALOG,
  DOMAINS,
  KINDS,
  MODES,
  PROTOCOL_FIELDS,
  STUB_DISCLAIMER,
  STUB_BAND,
  getEntry,
  isStub,
  isOnlineAssignable,
  listCatalog,
  groupedCatalog,
  scoreStub,
  scoreAny,
  getTakeable,
  normalizeProtocol,
};
