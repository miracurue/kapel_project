'use strict';

/**
 * Дополнительный слой распознавания кризисных высказываний в свободном тексте пациента.
 *
 * Зачем: словарь src/riskClassifier.js ищет точные подстроки в нижнем регистре. Он не видел «готов умереть»,
 * «покончу с собой», «жить не хочу», «ё/е», опечаток, лишних пробелов и фраз про способ (аудит 2026-10-26).
 * Этот слой работает ВМЕСТЕ со словарём (результаты объединяются в classifyFreeText), поэтому он только усиливает
 * защиту: даже если администратор включил свой словарь (настройка crisis.rules), эти формулировки остаются.
 *
 * Как устроен:
 *  - fold(): нижний регистр, ё→е, латиница и цифры внутри русских слов («ум3реть») → буквы, повторы букв
 *    («жииить») → одна, знаки препинания → пробел;
 *  - REGEX_RULES: шаблоны по свёрнутому тексту; SQUASHED: те же ядра без пробелов («не хочу жи ть»);
 *  - FUZZY_RULES: последовательности слов с допуском одной опечатки (расстояние Дамерау — Левенштейна);
 *  - английские фразы — отдельным коротким списком.
 *
 * ⚠️ СТАТУС ФОРМУЛИРОВОК: ЧЕРНОВИК, review-required (клинический владелец + юрист), как и словарь классификатора.
 * Лучше лишний сигнал врачу, чем пропущенный: при сомнении слой срабатывает, разбор («случайность или нет») дальше
 * ведёт кризисный разговор (src/ai/crisisFlow.js).
 */

// Номера совпадают с riskClassifier.CATEGORIES (модуль не импортируется, чтобы не было цикла).
const CAT = Object.freeze({ PLAN: 1, MEANS_ACCESS: 2, FAREWELL: 3, INTENT: 4, CURRENT: 5 });

const HOMOGLYPH = {
  a: 'а',
  c: 'с',
  e: 'е',
  o: 'о',
  p: 'р',
  x: 'х',
  y: 'у',
  k: 'к',
  m: 'м',
  t: 'т',
  h: 'н',
  b: 'в',
  0: 'о',
  3: 'е',
  6: 'б',
};

function fold(text) {
  let t = String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е');
  t = t.replace(/[\p{L}\p{N}]+/gu, (w) => (/[а-я]/.test(w) ? w.replace(/[a-z0-9]/g, (ch) => HOMOGLYPH[ch] || ch) : w));
  t = t.replace(/(.)\1{2,}/gu, '$1');
  return t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const B = '(?<![а-я])'; // начало слова (\b не работает с кириллицей)
const E = '(?![а-я])'; // конец слова
const S = '\\s+';
const rule = (category, src) => ({ category, re: new RegExp(`${B}(?:${src})${E}`, 'u') });

const MODAL =
  '(?:хочу|хотел[аи]?|хочется|хотелось|готов[аы]?|собираюсь|решил[аи]?|пора|надо|мечтаю|скорее бы|быстрее бы|лучше бы|лучше мне|пусть)';
const DEATH = '(?:умереть|умирать|сдохнуть|подохнуть|исчезнуть навсегда|не проснуться|не просыпаться|не существовать)';

const REGEX_RULES = [
  // намерение / безнадёжность
  rule(CAT.INTENT, `покон(?:чу|чить|чил|чила|чим|чаю|чать)${S}(?:с${S})?(?:собой|собою|жизнью|всем|этим)`),
  rule(CAT.INTENT, `(?:убь[юе]т?|убить|убил[аи]?|убива[а-я]*|прикон[а-я]*|удав[а-я]*)${S}себя`),
  rule(CAT.INTENT, `себя${S}(?:убь[юе]|убить|убив[а-я]*|прикон[а-я]*)`),
  rule(CAT.INTENT, `не${S}(?:хочу|хочется|хотелось|буду|охота)${S}(?:больше${S})?(?:так${S})?жить`),
  rule(CAT.INTENT, `не${S}могу${S}больше${S}(?:так${S})?жить`),
  rule(CAT.INTENT, `жить${S}(?:не${S}(?:хочу|хочется|буду|стоит|для${S}чего)|незачем|больше${S}не)`),
  rule(CAT.INTENT, `(?:устал[аи]?|надоело|надоела)${S}(?:мне${S})?(?:от${S})?жить`),
  rule(
    CAT.INTENT,
    `(?:незачем|нет${S}смысла|не${S}вижу${S}смысла|смысла${S}нет|зачем)${S}(?:мне${S})?(?:больше${S})?(?:жить|в${S}жизни|жизнь)`,
  ),
  rule(
    CAT.INTENT,
    `${MODAL}${S}(?:\\S+${S}){0,3}?${DEATH}(?!${S}(?:со${S}смеху|от${S}(?:смеха|скуки|стыда|жары|усталости|голода)))`,
  ),
  rule(CAT.INTENT, `лучше${S}бы${S}(?:я${S})?(?:умер|умерла|не${S}родился|не${S}родилась)`),
  rule(CAT.INTENT, `не${S}хочу${S}(?:больше${S})?просыпаться`),
  rule(CAT.INTENT, `(?:уйти|уйду|уходить)${S}из${S}жизни`),
  rule(CAT.INTENT, `свести${S}счет[а-я]*${S}с${S}жизнью`),
  rule(CAT.INTENT, `(?:наложить|наложу)${S}на${S}себя${S}руки`),
  rule(CAT.INTENT, `лишить${S}себя${S}жизни|покинуть${S}этот${S}мир`),
  rule(CAT.INTENT, 'суицид[а-я]*|самоубийств[а-я]*|самоубит[а-я]*|самоубива[а-я]*'),
  // способ / план
  rule(
    CAT.PLAN,
    `повешусь|повеситься|повесился|повесилась|вешаться|удавлюсь|удавиться|застрелюсь|застрелиться|утоплюсь|утопиться|отравлюсь|отравиться|сброшусь|выброшусь|выпрыгну|спрыгну|броситься${S}под|брошусь${S}под|вскрою${S}(?:себе${S})?вены|вскрыть${S}вены|перережу${S}(?:себе${S})?(?:вены|горло)|наглотаюсь|напьюсь${S}таблеток|выпью${S}(?:все|горсть)${S}(?:таблет[а-я]*|лекарств[а-я]*)|(?:прыгну|шагну)${S}(?:с|из)${S}(?:окна|крыши|балкона|моста|высотки|этажа)`,
  ),
  rule(CAT.PLAN, `(?:сегодня|сейчас|вечером|ночью|завтра)${S}(?:\\S+${S}){0,3}?(?:покончу|убью${S}себя|умру)`),
  // сейчас происходит
  rule(
    CAT.CURRENT,
    `(?:выпил[аи]?|наглотал(?:ся|ась|ись))${S}(?:все${S}|горсть${S}|много${S})?(?:таблет[а-я]*|лекарств[а-я]*)|порезал[аи]?${S}(?:себе${S})?(?:вены|руки|запястья)|режу${S}(?:себе${S})?вены`,
  ),
  // прощание
  rule(
    CAT.FAREWELL,
    `прощайте|прощаюсь${S}(?:со${S}всеми|с${S}вами)|простите${S}меня${S}за${S}все|не${S}поминайте|последнее${S}(?:мое${S})?(?:сообщение|прощание)|предсмертн[а-я]*`,
  ),
];

// Ядра без пробелов: ловят «не хочу жи ть», «по кончить с собой».
const SQUASHED = [
  [
    CAT.INTENT,
    [
      'нехочужить',
      'нехочубольшежить',
      'жизненехочу',
      'покончитьссобой',
      'покончуссобой',
      'убьюсебя',
      'убитьсебя',
      'хочуумереть',
      'готовумереть',
      'готоваумереть',
      'уйтиизжизни',
    ],
  ],
];

const EN_RULES = [
  [
    CAT.INTENT,
    /\b(?:kill\s+myself|want\s+to\s+die|end\s+my\s+(?:own\s+)?life|commit(?:ting)?\s+suicide|suicid\w*|don'?t\s+want\s+to\s+(?:live|be\s+alive))\b/i,
  ],
];

// ---- опечатки ----
function distance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

// Слово из словаря с допуском опечатки: короткие слова точно, 4–5 букв — одна ошибка при той же первой букве,
// длиннее — одна ошибка (от 9 букв две).
function sameWord(token, word) {
  if (token === word) return true;
  if (word.length <= 3) return false;
  const limit = word.length >= 9 ? 2 : 1;
  if (word.length === 4 && token[0] !== word[0]) return false;
  return distance(token, word, limit) <= limit;
}

// Последовательность групп слов: между соседними — не больше `gap` посторонних слов.
const FUZZY_RULES = [
  {
    category: CAT.INTENT,
    gap: 1,
    groups: [
      ['покончить', 'покончу', 'покончил', 'покончила'],
      ['собой', 'собою', 'жизнью'],
    ],
  },
  {
    category: CAT.INTENT,
    gap: 3,
    groups: [
      ['хочу', 'хотела', 'хотел', 'готов', 'готова', 'лучше', 'мечтаю', 'пора', 'собираюсь', 'решил', 'решила'],
      ['умереть', 'умирать', 'сдохнуть', 'подохнуть'],
    ],
    notAfter: ['со', 'от'],
  },
  { category: CAT.INTENT, gap: 1, groups: [['не'], ['хочу', 'хочется', 'буду'], ['жить']] },
  {
    category: CAT.INTENT,
    gap: 0,
    groups: [['суицид', 'суицидальные', 'самоубийство', 'самоубийства', 'самоубийством', 'самоубийцей']],
  },
];

function fuzzyMatch(tokens, rule) {
  const { groups, gap, notAfter = [] } = rule;
  for (let start = 0; start < tokens.length; start += 1) {
    if (!groups[0].some((w) => sameWord(tokens[start], w))) continue;
    let at = start;
    let ok = true;
    for (let g = 1; g < groups.length && ok; g += 1) {
      let found = -1;
      for (let k = at + 1; k <= Math.min(tokens.length - 1, at + 1 + gap); k += 1)
        if (groups[g].some((w) => sameWord(tokens[k], w))) {
          found = k;
          break;
        }
      if (found < 0) ok = false;
      else at = found;
    }
    if (ok && !(notAfter.length && notAfter.includes(tokens[at + 1]))) return true;
  }
  return false;
}

/** Категории (1–5, как в riskClassifier.CATEGORIES), найденные в тексте; [] если ничего. */
function detect(text) {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const hit = new Set();
  const lower = raw.toLowerCase();
  for (const [category, re] of EN_RULES) if (re.test(lower)) hit.add(category);
  const folded = fold(raw);
  for (const r of REGEX_RULES) if (r.re.test(folded)) hit.add(r.category);
  const squashed = folded.replace(/\s+/g, '');
  for (const [category, cores] of SQUASHED) if (cores.some((c) => squashed.includes(c))) hit.add(category);
  const tokens = folded.split(' ').filter(Boolean);
  for (const r of FUZZY_RULES) if (fuzzyMatch(tokens, r)) hit.add(r.category);
  return [...hit].sort();
}

/** Предложение с сигналом (для цитаты врачу); null, если сигнала нет или он только в склейке предложений. */
function sentenceWithSignal(text) {
  const parts = String(text || '').match(/[^.!?\n]+[.!?]*/g) || [];
  return parts.find((s) => detect(s).length > 0) || null;
}

module.exports = { fold, detect, sentenceWithSignal, distance };
