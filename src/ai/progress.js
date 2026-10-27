'use strict';

/**
 * Ход ответа ИИ для интерфейса: «смотрю инструкции…», «читаю клинические рекомендации…».
 * Клиент присылает progress_id вместе с вопросом и опрашивает GET /work/api/chat-progress/:id.
 * Только подписи этапов (без текста вопроса и данных пациента), хранится в памяти и недолго.
 */

const TTL_MS = 10 * 60 * 1000;
const MAX_STAGES = 30;
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const runs = new Map();

function sweep(now) {
  for (const [k, v] of runs) if (now - v.at > TTL_MS) runs.delete(k);
}

const TOOL_LABELS = {
  search_clinrec: 'Ищу в клинических рекомендациях',
  get_clinrec_outline: 'Просматриваю оглавление клинической рекомендации',
  read_clinrec_section: 'Читаю раздел клинической рекомендации',
  search_drug_instructions: 'Смотрю инструкции к лекарствам',
  search_literature: 'Ищу научные статьи',
  get_overview: 'Смотрю сводку по пациенту',
  get_diary: 'Смотрю дневник пациента',
  get_results: 'Смотрю результаты шкал и анализов',
  get_plan: 'Смотрю план лечения',
  get_visits: 'Смотрю визиты',
  get_adverse_events: 'Смотрю нежелательные явления',
  // Чат пациента (src/ai/patientSelfTools.js, src/ai/crisisMode.js): подписи говорят «ты», без данных.
  get_my_diary: 'Смотрю твой дневник',
  get_my_medications: 'Смотрю лекарства по плану и отметки приёма',
  get_my_tests: 'Смотрю тесты',
  get_my_visits: 'Смотрю визиты',
  get_visit_prep: 'Собираю сведения для подготовки к визиту',
  propose_diary_entry: 'Готовлю запись в дневник',
  propose_visit_note: 'Составляю список к визиту',
  list_techniques: 'Подбираю упражнения',
  offer_technique: 'Готовлю упражнение',
  search_journal: 'Ищу в журнале',
  read_journal_article: 'Читаю статью журнала',
  assess_crisis: 'Думаю, как лучше ответить',
};

function toolLabel(name) {
  if (String(name).startsWith('use_skill')) return 'Применяю специальный навык';
  return TOOL_LABELS[name] || 'Собираю нужные данные';
}

// Этапы схемы «план и исполнение» (чат психиатра без пациента).
const PHASE_LABELS = {
  plan: 'Планирую поиск',
  search: 'Ищу в клинических рекомендациях и инструкциях',
  check: 'Проверяю, всё ли найдено',
};

function phaseLabel(phase) {
  return PHASE_LABELS[phase] || 'Обдумываю';
}

/** Создаёт приёмник этапов для запроса; без корректного id возвращает пустышку. */
function start(userId, id) {
  const noop = () => {};
  if (typeof id !== 'string' || !ID_RE.test(id)) return { push: noop, thread: noop, done: noop };
  const now = Date.now();
  sweep(now);
  const run = { userId, at: now, stages: [], done: false, threadId: null };
  runs.set(id, run);
  return {
    push(label) {
      const last = run.stages[run.stages.length - 1];
      if (!label || (last && last.label === label) || run.stages.length >= MAX_STAGES) return;
      run.stages.push({ label, at: Date.now() });
      run.at = Date.now();
    },
    // Номер треда сообщается сразу: если страницу обновили во время ожидания, она вернётся в этот тред.
    thread(threadId) {
      run.threadId = threadId;
    },
    done() {
      run.done = true;
      run.at = Date.now();
    },
  };
}

function read(userId, id) {
  const run = runs.get(id);
  if (!run || run.userId !== userId) return null;
  return { stages: run.stages.map((s) => s.label), done: run.done, thread_id: run.threadId };
}

// Подписи этапов для чата пациента (без слов о клинических рекомендациях). Первое обдумывание — «Думаю над ответом»,
// каждое следующее (после просмотра данных) — «Готовлю ответ», чтобы список не повторял одну и ту же строку.
function patientLabeler() {
  let thinks = 0;
  return (ev) => {
    if (ev && ev.phase === 'tool') return toolLabel(ev.name);
    if (ev && ev.phase === 'answer') return 'Формулирую ответ';
    thinks += 1;
    return thinks === 1 ? 'Думаю над ответом' : 'Готовлю ответ';
  };
}

module.exports = { start, read, toolLabel, phaseLabel, patientLabeler };
