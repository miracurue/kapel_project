'use strict';

/**
 * Источники ответа ИИ специалиста: разбор меток [n] в тексте и проверка их по списку источников, которые модель
 * действительно видела. Номер 0 зарезервирован под «Знания модели» (утверждение без источника в базе).
 *
 * Правила сопоставления (чат психиатра):
 *  - карточку создаёт только метка, номер которой есть среди показанных модели источников этого ответа;
 *  - метка с неизвестным номером (выдуманная, из прошлой реплики беседы, источник найден, но модели не показан)
 *    удаляется из текста, карточки у неё нет;
 *  - номер 0 всегда допустим и даёт отдельный источник «Знания модели».
 */

const MODEL_NO = 0;
// [3], [1, 2], [1;2]: метка из одного или нескольких номеров.
const CITE = /\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\]/g;

const MODEL_SOURCE = Object.freeze({
  n: MODEL_NO,
  kind: 'model',
  model_knowledge: true,
  label: 'Знания модели',
  snippet:
    'Утверждение опирается на общие знания языковой модели, а не на клинические рекомендации или инструкции из базы. Проверяйте по первоисточникам.',
});

const numbersOf = (inner) =>
  String(inner)
    .split(/[,;]/)
    .map((x) => Number(x.trim()));

/** Номера, на которые ссылается текст (в том числе внутри [1, 2]). */
function citedNumbers(text) {
  const used = new Set();
  for (const m of String(text || '').matchAll(CITE)) for (const n of numbersOf(m[1])) used.add(n);
  return used;
}

/**
 * Текст без меток с неизвестными номерами. [1, 99] превращается в [1]; метка, в которой не осталось известных
 * номеров, удаляется вместе с пробелом перед ней. known — Set номеров; MODEL_NO допустим всегда.
 */
function stripUnknown(text, known) {
  const ok = (n) => n === MODEL_NO || known.has(n);
  return String(text || '').replace(/[ \t]?\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\]/g, (whole, inner) => {
    const nums = numbersOf(inner);
    const keep = nums.filter(ok);
    if (keep.length === nums.length) return whole;
    if (!keep.length) return '';
    return `${whole.startsWith(' ') || whole.startsWith('\t') ? whole[0] : ''}[${keep.join(', ')}]`;
  });
}

/**
 * Источники, на которые ссылается текст: из списка показанных (по одному на номер) и, если есть метка [0], «Знания
 * модели» первым. Остальные порядком номеров.
 */
function sourcesFor(text, shown) {
  const used = citedNumbers(text);
  const out = (shown || []).filter((s) => s.n !== MODEL_NO && used.has(s.n)).sort((a, b) => a.n - b.n);
  return used.has(MODEL_NO) ? [{ ...MODEL_SOURCE }, ...out] : out;
}

/** Метки [n] убираются из реплики, которая идёт модели как история беседы: номера прошлого ответа не действуют. */
function stripMarkers(text) {
  return String(text || '').replace(/[ \t]?\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\]/g, '');
}

// Обороты, которыми ответ рассказывает врачу о ходе поиска («не удалось найти», «в предоставленных фрагментах», «в
// материалах»). Предложение с таким оборотом убирается; если после этого текста не осталось, ответ не меняется.
const META = new RegExp(
  [
    'не удалось (?:найти|обнаружить)',
    'не наш[её]л',
    'не нашлось',
    'в предоставленн\\p{L}+ (?:фрагмент|материал|текст|источник|выдержк|документ|данн)\\p{L}*',
    'в найденн\\p{L}+ (?:фрагмент|материал|текст|источник|выдержк|документ)\\p{L}*',
    'в приложенн\\p{L}+ (?:фрагмент|материал|текст|источник|выдержк|документ)\\p{L}*',
    'в материалах',
    'в базе (?:нет|не найден|отсутств)',
    'источники противоречив',
  ].join('|'),
  'iu',
);

function stripMeta(text) {
  const src = String(text || '');
  const kept = src.split('\n').map((line) =>
    line
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => !META.test(sentence))
      .join(' '),
  );
  const out = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out || src;
}

/** Цитата для карточки: текст без разметки Markdown, одной строкой, не длиннее max. */
function snippetOf(text, max = 260) {
  const s = String(text || '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_`~#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length <= max ? s : `${s.slice(0, max).replace(/\s+\S*$/, '')}…`;
}

/**
 * Нумерация источников одного ответа для чатов по одному документу (клинрек, препарат): add(key, source) -> n (один
 * номер на ключ), finish(text) -> {text, sources}: метки с чужими номерами убраны, карточки только у процитированных.
 */
function createNumbering() {
  const items = [];
  const byKey = new Map();
  return {
    add(key, source) {
      if (!byKey.has(key)) {
        const item = { ...source, n: items.length + 1 };
        byKey.set(key, item);
        items.push(item);
      }
      return byKey.get(key).n;
    },
    finish(text) {
      const clean = stripMeta(stripUnknown(text, new Set(items.map((i) => i.n))));
      return { text: clean, sources: sourcesFor(clean, items) };
    },
  };
}

const normText = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е');

/**
 * Проверка привязки уровней доказательности: в предложении с УУР/УДД и меткой [n] названный препарат должен
 * встречаться в тексте источника n. inns — названия МНН каталога (функция по тексту предложения), textOf(n) — текст
 * фрагментов источника. Возвращает [{n, drug}] для случаев, когда препарата в источнике нет. Ответ не меняется.
 */
function attributionWarnings(text, { innsIn, textOf }) {
  const out = [];
  const level = /УУР|УДД|уровень (?:убедительности|достоверности)|достоверности/i;
  for (const sentence of String(text || '').split(/(?<=[.!?])\s+|\n/)) {
    if (!level.test(sentence)) continue;
    const nums = [...citedNumbers(sentence)].filter((n) => n !== MODEL_NO);
    if (!nums.length) continue;
    for (const drug of innsIn(sentence)) {
      const term = normText(drug);
      const stem = term.slice(0, Math.max(4, term.length - 2));
      for (const n of nums) {
        const src = textOf(n);
        if (src && !normText(src).includes(stem)) out.push({ n, drug });
      }
    }
  }
  return out;
}

module.exports = {
  attributionWarnings,
  MODEL_NO,
  MODEL_SOURCE,
  citedNumbers,
  stripUnknown,
  sourcesFor,
  stripMarkers,
  stripMeta,
  snippetOf,
  createNumbering,
};
