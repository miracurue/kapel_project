'use strict';

/**
 * Каталог промптов ИИ: четыре слоя, из которых шлюз собирает системную инструкцию запроса.
 *
 *   role   — один универсальный промпт на роль (пациент, психиатр, психолог): кто собеседник и как с ним говорить,
 *            границы и безопасность. Подключается ко всем задачам этой роли.
 *   tools  — общие правила работы с инструментами и описание каждого инструмента (уходит в его определение).
 *   skill  — навык: типовая операция со своей инструкцией; в системном промпте модель видит только его описание и
 *            вызывает навык через use_skill. Режим (`mode`) задан здесь: `function` — тело грузится в подзапрос со схемой
 *            функции (src/ai/skills.js); `instructions` — тело возвращается в диалог, `flag` ставится в результат шлюза.
 *   task   — задача: промпт сценария (чат, статья, шаблон документа…), привязан к экрану или действию.
 *   guard  — защита от нецелевых обращений: отдельный слой, который шлюз добавляет после задачи (см. guardFor);
 *            модель сама решает по смыслу, служебные метки в её ответе разбирает шлюз.
 *
 * Ключ промпта — `<слой>.<имя>`, начальный текст лежит в prompts/<слой>/<имя>/v001.md. Здесь же названия и описания
 * для админки: это справка людям, в промпт модели они не попадают.
 */

const CATEGORIES = [
  {
    id: 'role',
    title: 'Роли',
    description:
      'Один системный промпт на роль: кто собеседник, как с ним говорить, границы и безопасность. Подключается ко всем задачам этой роли. У навыков роли нет.',
  },
  {
    id: 'tools',
    title: 'Инструменты',
    description:
      'Как ИИ читает данные пациента и клинические рекомендации. Правила набора («Общие правила» для данных пациента, «Правила поиска по клинрекам») добавляются к запросу, где есть его инструменты; описание каждого инструмента уходит в его определение, по нему модель решает, когда вызывать.',
  },
  {
    id: 'skill',
    title: 'Навыки',
    description:
      'Типовые операции со своей инструкцией. В запросе модель видит только описание навыка (строка «description»). Режим «function»: инструкцию получает подзапрос, ответ — вызов функции по схеме (src/ai/skills.js). Режим «instructions»: тело навыка возвращается в диалог как результат use_skill, а сервер может получить флаг ответа.',
  },
  {
    id: 'task',
    title: 'Задачи',
    description:
      'Промпт сценария, привязанный к экрану или действию: чат, статья, шаблон документа. Добавляется после роли и инструментов.',
  },
  {
    id: 'guard',
    title: 'Защита',
    description:
      'Отдельные слои, регламентирующие нецелевые обращения. Подключаются шлюзом после задачи и только там, где указано; модель решает по смыслу, без словарей. Метки в ответе ([[OFFTOPIC]], [[GAME]], [[RUDE]]) служебные: шлюз вырезает их до показа и сохранения.',
  },
];

const ENTRIES = [
  // роли
  { key: 'role.patient', title: 'Пациент', description: 'Помощник пациента: простой язык, доброжелательный тон, не врач, кризис → врач и 112.', where: 'Все задачи, где ИИ говорит с пациентом (чат помощника).' },
  { key: 'role.psychiatrist', title: 'Психиатр', description: 'Помощник психиатра: профессиональный тон, гипотезы вместо диагнозов, справка о препаратах допустима, решения за врачом.', where: 'Все задачи, где работает врач-психиатр: чат, статьи, шаблоны, лекарства.' },
  { key: 'role.psychologist', title: 'Психолог', description: 'Помощник психолога: интерпретация методик, без назначений, вопросы о препаратах — к врачу пациента.', where: 'Все задачи, где работает психолог.' },
  // инструменты
  { key: 'tools.common', title: 'Общие правила инструментов', description: 'Когда и как вызывать инструменты, как относиться к результату, как ссылаться на источник и дату.', where: 'Добавляется ко всем запросам, где предложены инструменты (чат специалиста по закреплённому пациенту).' },
  { key: 'tools.patient_self', title: 'Правила инструментов чата пациента', description: 'Когда читать дневник, лекарства по плану, тесты и журнал для пациентов; нельзя называть баллы и дозы, не оценивать состояние, как предлагать статьи.', where: 'Чат пациента (вместо общих правил инструментов).' },
  { key: 'tools.crisis', title: 'Правила оценки в кризисном разговоре', description: 'Как заполнять заметку для врача assess_crisis: уровни, неизвестные поля, при сомнении более тяжёлый уровень. Оценка не отменяет сигнал.', where: 'Кризисный режим чата пациента (вместо общих правил инструментов).' },
  { key: 'tools.get_overview', title: 'get_overview — сводка', description: 'Описание инструмента «сводка по пациенту».', where: 'Определение инструмента для чата специалиста.' },
  { key: 'tools.get_diary', title: 'get_diary — дневник', description: 'Описание инструмента «дневник пациента за период».', where: 'Определение инструмента для чата специалиста.' },
  { key: 'tools.get_results', title: 'get_results — результаты тестов', description: 'Описание инструмента «результаты тестов и шкал».', where: 'Определение инструмента для чата специалиста.' },
  { key: 'tools.get_plan', title: 'get_plan — план лечения', description: 'Описание инструмента «план лечения» (только психиатр).', where: 'Определение инструмента для психиатра.' },
  { key: 'tools.get_visits', title: 'get_visits — визиты', description: 'Описание инструмента «визиты пациента».', where: 'Определение инструмента для чата специалиста.' },
  { key: 'tools.get_adverse_events', title: 'get_adverse_events — нежелательные явления', description: 'Описание инструмента «нежелательные явления» (только психиатр).', where: 'Определение инструмента для психиатра.' },
  { key: 'tools.clinrec', title: 'Правила поиска по клинрекам', description: 'Как агент понимает запрос, ищет и читает клинические рекомендации, когда уточняет вопрос, как ссылается на источник [n], помечает собственные знания [0] («Знания модели»), не рассказывает врачу о ходе поиска; короткий первый ответ и предложение углубиться.', where: 'Чат психиатра без закреплённого пациента (вместо общих правил инструментов пациента).' },
  { key: 'tools.clinrec_plan', title: 'План поиска по клинрекам', description: 'Служебный промпт планировщика: по вопросу врача и каталогу рекомендаций возвращает JSON с пунктами плана и короткими поисковыми запросами (схема «план и исполнение», эксперимент 15). Врачу не отвечает.', where: 'Чат психиатра без закреплённого пациента, режим CLINICIAN_AGENT_MODE=plan (по умолчанию).' },
  { key: 'tools.clinrec_coverage', title: 'Проверка полноты поиска', description: 'Служебный промпт контролёра: по плану и найденным фрагментам указывает неподтверждённые пункты и новые запросы (JSON). Врачу не отвечает.', where: 'Чат психиатра без закреплённого пациента, режим «план и исполнение».' },
  { key: 'tools.clinrec_answer', title: 'Правила ответа по найденному', description: 'Как отвечать по фрагментам, найденным сервером: только приложенный текст, ссылки [n], собственные знания модели с пометкой [0] (отдельный источник «Знания модели»), проверка утверждений, ответ без рассказа о том, что приложено и чего не нашлось, короткий первый ответ с предложением углубиться. Без правил вызова инструментов.', where: 'Чат психиатра без закреплённого пациента, режим «план и исполнение» (вместо «Правил поиска по клинрекам»).' },
  { key: 'tools.search_clinrec', title: 'search_clinrec — поиск по клинрекам', description: 'Описание инструмента «поиск фрагментов клинических рекомендаций».', where: 'Определение инструмента для чата психиатра.' },
  { key: 'tools.get_clinrec_outline', title: 'get_clinrec_outline — оглавление клинрека', description: 'Описание инструмента «оглавление клинической рекомендации».', where: 'Определение инструмента для чата психиатра.' },
  { key: 'tools.read_clinrec_section', title: 'read_clinrec_section — чтение раздела', description: 'Описание инструмента «прочитать разделы клинической рекомендации целиком».', where: 'Определение инструмента для чата психиатра.' },
  { key: 'tools.search_drug_instructions', title: 'search_drug_instructions — поиск по инструкциям', description: 'Описание инструмента «поиск по инструкциям по применению лекарств».', where: 'Определение инструмента для чата психиатра (если загружены инструкции).' },
  { key: 'tools.literature', title: 'Правила поиска статей', description: 'Когда искать научные статьи, как составить запрос без данных пациента, как пересказывать аннотации и ссылаться [n].', where: 'Чат психиатра без пациента, если включён поиск статей (LITERATURE_SEARCH=europepmc).' },
  { key: 'tools.search_literature', title: 'search_literature — поиск статей', description: 'Описание инструмента «поиск научных статей в Europe PMC».', where: 'Определение инструмента для чата психиатра (если включён поиск статей).' },
  // навыки
  { key: 'skill.ae_extraction', title: 'Признаки нежелательной реакции', description: 'Извлекает из текста симптомы, тяжесть и препарат для черновика карточки НЯ. Результат — подсказка, оценку делает человек.', where: 'Чат пациента (предложение оформить НЯ); навык use_skill.', purpose: 'ae_extraction', mode: 'function' },
  { key: 'skill.ae_offer', title: 'Предложение рассказать о побочном действии', description: 'Инструкция поведения: если в реплике пациента похоже на побочное действие лекарства, мягко предложить рассказать подробнее, чтобы передать врачу. Диагноза и советов по лечению нет.', where: 'Чат пациента: основная модель вызывает навык через use_skill; сервер получает флаг ae_offer и показывает карточку после согласия пациента.', purpose: 'patient_assistant', mode: 'instructions', flag: 'ae_offer' },
  { key: 'skill.ae_offer_clinician', title: 'Предложение оформить побочное действие (психиатр)', description: 'Инструкция поведения: если врач описывает возможную побочную реакцию на лекарство у закреплённого пациента, коротко отметить это и сказать, что запись можно оформить кнопкой. Запись не создаётся, решение за врачом.', where: 'Чат психиатра о закреплённом пациенте: основная модель вызывает навык через use_skill; сервер получает флаг ae_offer и показывает кнопку под ответом.', purpose: 'clinician_chat', mode: 'instructions', flag: 'ae_offer' },
  { key: 'skill.ae_offer_psychologist', title: 'Предложение передать психиатру о побочном действии (психолог)', description: 'Инструкция поведения: если психолог пишет, что пациент рассказал о возможной реакции на лекарство, отметить, что сказанное можно зафиксировать и передать психиатру. Препараты и их связь не обсуждаются.', where: 'Чат психолога о закреплённом пациенте: основная модель вызывает навык через use_skill; сервер получает флаг ae_offer и показывает кнопку под ответом.', purpose: 'clinician_chat', mode: 'instructions', flag: 'ae_offer' },
  { key: 'skill.crisis_signal', title: 'Кризисный сигнал из обычного чата', description: 'Инструкция поведения: если собеседник говорит о смерти, нежелании жить, самоубийстве или самоповреждении, сразу вызвать инструмент raise_crisis_signal: сигнал врачу, телефоны экстренной помощи вверху чата и кризисный режим. Ничего не объяснять и не предлагать упражнений.', where: 'Чат пациента (всегда доступен): основная модель вызывает навык через use_skill; сервер получает флаг crisis_signal и включает кризисный режим так же, как при кризисной фразе.', purpose: 'patient_assistant', mode: 'instructions', flag: 'crisis_signal' },
  { key: 'skill.history_summary', title: 'Сжатие длинной беседы', description: 'Краткое содержание ранней части беседы специалиста с ИИ, когда история не помещается в окно модели. Вызывается кодом, модель его не выбирает.', where: 'Чат специалиста: длинные беседы (размер окна — параметр модели context_tokens).', purpose: 'clinician_chat', mode: 'instructions' },
  { key: 'skill.order_parse', title: 'Разбор назначения', description: 'Разбирает формулировку назначения в препарат, дозу, единицу и кратность.', where: 'План лечения: поле «формулировка назначения».', purpose: 'order_parse', mode: 'function' },
  { key: 'skill.diagnostic_hints', title: 'Диагностические гипотезы', description: 'Список гипотез для проверки врачом, каждая с основанием из данных.', where: 'Рабочее место специалиста: «Гипотезы».', purpose: 'diagnostic_hints', mode: 'function' },
  // задачи
  { key: 'task.patient_chat', title: 'Чат пациента', description: 'Помощь пациенту в вопросах лечения и самочувствия, до 200 слов.', where: 'Кабинет пациента → ИИ-помощник.', purpose: 'patient_assistant' },
  { key: 'task.patient_crisis', title: 'Кризисный разговор пациента', description: 'Режим чата пациента после кризисного сигнала: уточнить, не случайность ли это, поддержать, заземлить, не оставить одного до ответа врача; заметка врачу через assess_crisis.', where: 'Кабинет пациента → чат после кризисной фразы или кнопки «Мне нужна помощь».', purpose: 'patient_assistant' },
  { key: 'task.clinician_chat', title: 'Чат специалиста', description: 'Рабочий чат специалиста, в том числе по данным закреплённого пациента.', where: 'Рабочее место специалиста → чат.', purpose: 'clinician_chat' },
  { key: 'task.drug_chat', title: 'Вопрос по препарату', description: 'Справочные ответы специалисту по одному препарату.', where: 'Рабочее место → Лекарства → чат по препарату.', purpose: 'clinician_chat' },
  { key: 'task.clinrec_chat', title: 'Вопрос по клинической рекомендации', description: 'Ответы специалисту только по выдержкам из одной клинической рекомендации.', where: 'Рабочее место → Лекарства → чат по клинреку.', purpose: 'clinician_chat' },
  { key: 'task.visit_document', title: 'Черновик документа по приёму', description: 'Черновик документа по данным пациента за период, проверяет врач.', where: 'Рабочее место → документы пациента.', purpose: 'document_draft' },
  { key: 'task.document_template', title: 'Шаблон документа', description: 'Заготовка типового документа (выписка, справка, направление) с метками вместо данных пациента.', where: 'Рабочее место → Документы → «✦ ИИ».', purpose: 'document_draft' },
  { key: 'task.article_patient', title: 'Статья для пациентов', description: 'Статья простым языком из мыслей автора: заголовок, кратко, теги, текст.', where: 'Мои статьи → журнал для пациентов.', purpose: 'document_draft' },
  { key: 'task.article_specialist', title: 'Статья для специалистов', description: 'Научно-популярная статья из мыслей автора для специалистов смежных областей.', where: 'Мои статьи → журнал для специалистов.', purpose: 'document_draft' },
  { key: 'task.article_rewrite', title: 'Правка фрагмента статьи', description: 'Переписывает только выделенный фрагмент по заданию автора.', where: 'Мои статьи → правка выделенного.', purpose: 'document_draft' },
  // защита
  { key: 'guard.scope_clinician', title: 'Тема обращений специалиста', description: 'Если вопрос специалиста бессмыслен или не относится к психиатрии, психологии и его работе, модель отвечает меткой [[OFFTOPIC]], шлюз показывает стандартное сообщение, а шаблон или статья не создаются.', where: 'Чат специалиста, чат клинрека, чат лекарств, ИИ-шаблон документа, статьи и правка фрагмента.' },
  { key: 'guard.patient_conduct', title: 'Поведение в чате пациента', description: 'Не вестись на заигрывание и проверки («слабо?») — метка [[GAME]]; спокойно отвечать на грубость — метка [[RUDE]]; тепло возвращать разговор, если просят совсем постороннее (рецепты, огород, политика).', where: 'Чат пациента (обычный режим; кризисный режим слой не получает).' },
];

// Роль пользователя -> ключ промпта роли. Администратор и служебные роли слоя роли не имеют.
const ROLE_KEY = { patient: 'role.patient', psychiatrist: 'role.psychiatrist', psychologist: 'role.psychologist' };

// Промпт по умолчанию для назначения: вызовы без явного promptKey.
const DEFAULT_KEY_BY_PURPOSE = {
  patient_assistant: 'task.patient_chat',
  clinician_chat: 'task.clinician_chat',
  document_draft: 'task.visit_document',
  diagnostic_hints: 'skill.diagnostic_hints',
  ae_extraction: 'skill.ae_extraction',
  order_parse: 'skill.order_parse',
};

// Защитные слои: какие задачи и роли их получают. Кризисный разговор пациента (task.patient_crisis) слоя не получает.
const GUARD_CLINICIAN = 'guard.scope_clinician';
const GUARD_PATIENT = 'guard.patient_conduct';
const GUARDED_CLINICIAN_TASKS = [
  'task.clinician_chat',
  'task.drug_chat',
  'task.clinrec_chat',
  'task.document_template',
  'task.article_patient',
  'task.article_specialist',
  'task.article_rewrite',
];
/** Ключ защитного слоя для задачи и роли или null. */
function guardFor(promptKey, userRole) {
  if (['psychiatrist', 'psychologist'].includes(userRole) && GUARDED_CLINICIAN_TASKS.includes(promptKey))
    return GUARD_CLINICIAN;
  if (userRole === 'patient' && promptKey === 'task.patient_chat') return GUARD_PATIENT;
  return null;
}

const KEYS = ENTRIES.map((e) => e.key);
const categoryOf = (key) => String(key).split('.')[0];
const nameOf = (key) => String(key).slice(String(key).indexOf('.') + 1);
const entryOf = (key) => ENTRIES.find((e) => e.key === key) || null;
/** Режим навыка из каталога: `function` (подзапрос со схемой функции) или `instructions` (тело как результат use_skill). */
const skillMode = (key) => {
  const e = entryOf(key);
  return e && categoryOf(key) === 'skill' ? e.mode || 'function' : null;
};

/** Тело версии: шапка `---\ndescription: …\n---` (у навыков) отделяется, HTML-комментарии для людей убираются. */
function parseBody(raw) {
  let text = String(raw || '').replace(/\r\n?/g, '\n');
  let description = '';
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    const d = m[1].match(/^description:\s*(.+)$/m);
    description = d ? d[1].trim() : '';
    text = text.slice(m[0].length);
  }
  text = text.replace(/<!--[\s\S]*?-->\s*/g, '').trim();
  return { description, text };
}

/** Имя навыка для use_skill: ключ без слоя. */
function skillName(key) {
  return nameOf(key);
}

/**
 * Сборка системной инструкции из слоёв: роль, общие правила инструментов, список навыков, задача.
 * @param {(key: string) => ({version: number, body: string}|null)} activePrompt
 * @returns {{system: string, layers: {key: string, version: number}[], missing: string[]}}
 */
function assemble({ promptKey, userRole, withTools = false, toolsKey = 'tools.common', skills = [], activePrompt, facts = '' }) {
  const layers = [];
  const parts = [];
  const missing = [];
  const add = (key) => {
    const row = activePrompt(key);
    if (!row) {
      missing.push(key);
      return null;
    }
    layers.push({ key, version: row.version });
    return parseBody(row.body);
  };

  if (categoryOf(promptKey) === 'skill') {
    const p = add(promptKey);
    if (p) parts.push(p.text);
    return { system: parts.join('\n\n'), layers, missing };
  }

  const roleKey = ROLE_KEY[userRole];
  if (roleKey) {
    const p = add(roleKey);
    if (p) parts.push(p.text);
  }
  // Факты о собеседнике (не промпт, в журнал версий не попадают): после роли, до правил инструментов.
  if (roleKey && facts) parts.push(facts);
  if (withTools) {
    for (const key of Array.isArray(toolsKey) ? toolsKey : [toolsKey]) {
      const p = add(key);
      if (p) parts.push(p.text);
    }
  }
  if (skills.length) {
    const lines = [];
    for (const key of skills) {
      const p = add(key);
      if (p) lines.push(`- ${skillName(key)}: ${p.description || p.text.split('\n')[0]}`);
    }
    if (lines.length) {
      parts.push(
        `Доступные навыки (вызывай функцией use_skill(name, input), где input — текст для обработки навыком):\n${lines.join('\n')}`,
      );
    }
  }
  const task = add(promptKey);
  if (task) parts.push(task.text);
  const guardKey = guardFor(promptKey, userRole);
  if (guardKey) {
    const g = add(guardKey);
    if (g) parts.push(g.text);
  }
  return { system: parts.join('\n\n'), layers, missing };
}

/** Каталог для админки: слои с описаниями и записями (версии подставляет вызывающий). */
function describe() {
  return CATEGORIES.map((c) => ({ ...c, items: ENTRIES.filter((e) => categoryOf(e.key) === c.id) }));
}

module.exports = {
  CATEGORIES,
  ENTRIES,
  KEYS,
  ROLE_KEY,
  DEFAULT_KEY_BY_PURPOSE,
  GUARD_CLINICIAN,
  GUARD_PATIENT,
  guardFor,
  categoryOf,
  nameOf,
  entryOf,
  skillMode,
  parseBody,
  skillName,
  assemble,
  describe,
};
