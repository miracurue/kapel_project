'use strict';

/**
 * Серверные подсказки чату пациента до вызова модели (модель сама не всегда вызывает инструменты):
 *  - вопрос про лекарство или его приём: ищем статью журнала и подкладываем её текст; ссылка возвращается по факту подкладки;
 *  - жалоба на тревогу, напряжение, сон: код подбирает методику самопомощи (по suits/caution) и подкладывает как предложенную;
 *  - из ответа убираются обещания «карточку приложил», если карточки нет.
 * Кризис сюда не доходит: кризисная проверка идёт раньше (src/ai/crisisGate.js), в кризисном треде этот путь не вызывается.
 * Формулировки подсказок — review-required (prompts/tools/patient_self).
 */

const techniques = require('../modules/techniques/catalog');

const ARTICLE_CHARS = 3500;
const MIN_NAME = 4;
const INTAKE_RE =
  /принима|приём|прием|пропуст|пропуск|запива|запить|таблетк|капсул|\bдоз|побочн|до еды|после еды|натощак/i;
const INTAKE_MIN_HITS = 5; // без названия препарата статья должна совпасть заметно, а не по одному слову

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replaceAll('ё', 'е');

/** Названия препаратов из текста (МНН и торговые); склонения ловятся включением названия в слово. */
function drugNames(db, text) {
  const t = norm(text);
  const rows = [
    ...db.prepare("SELECT name_norm n FROM inn WHERE status='in_catalog'").all(),
    ...db.prepare('SELECT trade_name_norm n FROM drug_products').all(),
  ];
  const found = new Set();
  for (const r of rows) {
    const n = norm(r.n).trim();
    if (n.length >= MIN_NAME && t.includes(n)) found.add(n);
  }
  return [...found];
}

/**
 * @returns {{block: string, ids: number[]}} block пуст, если подходящей статьи нет
 */
function journalBlock({ db, journal, user, text }) {
  const names = drugNames(db, text);
  const intake = INTAKE_RE.test(text);
  if (!names.length && !intake) return { block: '', ids: [] };
  let found = [];
  for (const name of names) {
    found = journal.search(user, name, 1);
    if (found.length) break;
  }
  if (!found.length && intake) found = journal.search(user, text, 1, { minHits: INTAKE_MIN_HITS });
  const item = found.length ? journal.article(user, found[0].id) : null;
  if (!item || item.audience !== 'patient') return { block: '', ids: [] };
  const body = String(item.body_md || '');
  const block = [
    'Материал журнала по теме вопроса (подобран сервером; ответ строй только на нём, ссылку на статью сервер приложит сам):',
    `«${item.title}»`,
    body.length > ARTICLE_CHARS ? `${body.slice(0, ARTICLE_CHARS)}\n… (дальше в статье)` : body,
  ].join('\n');
  return { block, ids: [item.id] };
}

const COMPLAINT_RE =
  /тревож|тревог|паник|волну|волнен|напряж|накрыва|нервнича|страшно|не могу успокои|сердце колотит|бессонн|не могу (?:за)?снуть|не сплю|плохо сплю|зажат|нет сил|ничего не хочется|апати/i;
const NOT_NOW_RE = /выговориться|не надо совет|без советов|не хочу упражнени|не помогает дыхани/i;
const HEART_LUNG_RE = /сердц|лёгк|легки|астм|давлени|одышк/i;

/**
 * Подбор методики по тексту жалобы. null — подсказывать нечего.
 * @param {{text: string, alreadyOffered?: boolean}} o
 */
function pickTechnique({ text, alreadyOffered = false }) {
  const t = norm(text);
  if (alreadyOffered || !COMPLAINT_RE.test(t) || NOT_NOW_RE.test(t)) return null;
  // Вопрос про лекарство и приём: отвечаем по теме, методику не навязываем.
  if (INTAKE_RE.test(t)) return null;
  const breathHold = HEART_LUNG_RE.test(t);
  let slug = 'grounding-54321';
  if (/сон|заснуть|уснуть|бессонн|не сплю|плохо сплю/.test(t)) slug = breathHold ? 'pmr' : 'breathing-478';
  else if (/напряж|зажат|мышц|плеч|челюст/.test(t)) slug = 'pmr';
  else if (/нет сил|ничего не хочется|апати/.test(t)) slug = 'activation';
  else if (/успокои|нервнича|волну|волнен/.test(t) && !breathHold) slug = 'breathing-box';
  return techniques.bySlug(slug);
}

function techniqueBlock(item) {
  return [
    'Подсказка сервера: собеседник описывает тревогу или напряжение. Подходящая методика самопомощи:',
    `«${item.title}» (${item.minutes}). ${item.purpose}`,
    `Подходит: ${item.suits} Осторожно: ${item.caution}`,
    'Сначала коротко отзовись на его слова, затем мягко предложи её одной-двумя фразами. Карточку со ссылкой на упражнение сервер приложит сам: ссылку не пиши и упражнение не пересказывай.',
  ].join('\n');
}

const CARD_WORD_RE = /карточк|кнопк/i;
const CARD_PROMISE_RE = /приложил|прикрепил|добавил|показал|ниже|внизу|под (?:этим )?(?:сообщением|ответом)/i;

/** Убирает предложения вида «карточку приложил», если карточки в ответе нет. */
function stripCardPromises(text) {
  const parts = String(text || '').split(/(?<=[.!?…])\s+/);
  const kept = parts.filter((p) => !(CARD_WORD_RE.test(p) && CARD_PROMISE_RE.test(p)));
  return kept.length === parts.length || !kept.length ? String(text || '') : kept.join(' ');
}

module.exports = { journalBlock, pickTechnique, techniqueBlock, stripCardPromises, drugNames, INTAKE_RE };
