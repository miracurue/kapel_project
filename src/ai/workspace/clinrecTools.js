'use strict';

/**
 * Инструменты ИИ-агента по клиническим рекомендациям (чат специалиста без пациента, этап 2 плана агента).
 * Схема — «поиск плюс оглавление» (эксперимент 10, лучший на сложных вопросах): модель ищет по сходству, при
 * необходимости смотрит оглавление найденной рекомендации и дочитывает разделы целиком. Знание рекомендации даёт
 * заметный прирост (эксперимент 09), поэтому у поиска есть фильтр clinrec_id, а каталог стоит в карточке запроса.
 *
 *  search_clinrec(query, clinrec_id?)            — фрагменты (гибрид: лексический + векторный, без реранкера);
 *  get_clinrec_outline(clinrec_id, section?)      — оглавление: номер раздела, название, размер;
 *  read_clinrec_section(clinrec_id, sections[])   — разделы целиком, не больше READ_BUDGET знаков за вызов;
 *  search_drug_instructions(query, inn?)         — фрагменты инструкций по применению (этап 5), если загружены.
 *
 * Каждый показанный модели фрагмент получает номер источника [n] (один счётчик на ответ); по номерам сервер собирает
 * список источников с разделом (section_id), который открывается в правой панели. Наружу (эмбеддинги GigaChat) уходит
 * только очищенная поисковая строка (publicReferenceTerm): без меток #ТИП-N# и длинных чисел. Данных пациента у этих
 * инструментов нет: набор создаётся только для чата без закреплённого пациента.
 */

const { publicReferenceTerm } = require('../../modules/knowledge/service');
const { searchClinrec, getClinrecSection } = require('../../modules/knowledge/search_clinrec');
const { citedNumbers, stripUnknown } = require('./sources');
const { namedWithoutInstructions } = require('../../modules/drugs/instructions');

const SEARCH_K = 6;
const FRAGMENT_MAX = 1500;
const DRUG_FRAGMENT_MAX = 2400; // фрагмент инструкции может включать продолжение оборванного раздела
const READ_BUDGET = 15000;
const READ_MAX_SECTIONS = 4;
const UNIT = 4000; // раздел не больше этого в оглавлении не раскрывается: его читают целиком
const OUTLINE_DEPTH = 3;
const OUTLINE_MAX_LINES = 160;
const SKIP_TITLES = /^(оглавление|список литературы)$/i;

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/gu;
// Qwen иногда вставляет в запрос иероглифы («дифференциальная诊断»): для русского корпуса они только мешают поиску.
const cleanArgs = (raw) =>
  Object.fromEntries(
    Object.entries(raw || {}).map(([k, v]) => [k, typeof v === 'string' ? v.replace(CJK, '').replace(/ {2,}/g, ' ').trim() : v]),
  );
const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, '')}…`);
// Цитата для карточки источника: текст фрагмента без разметки Markdown, одной строкой.
const plain = (text, max = 260) =>
  clip(
    String(text || '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<\/?[a-z][^>]*>/gi, ' ')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/[*_`~#>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    max,
  );
const kz = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}к` : `${n}`);
const spanSize = (span) => {
  const s = Number(span && span.start);
  const e = Number(span && span.end);
  return Number.isFinite(s) && Number.isFinite(e) && e > s ? e - s : 0;
};

const DEFINITIONS = [
  {
    name: 'search_clinrec',
    description:
      'Поиск фрагментов клинических рекомендаций по смыслу и словам. Передай короткий поисковый запрос (термины, без данных пациента). Если понятно, какая рекомендация нужна, передай clinrec_id из каталога.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Поисковый запрос: термины, препараты, симптомы; без имён и данных пациента',
        },
        clinrec_id: { type: 'string', description: 'Код рекомендации из каталога (необязательно)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_clinrec_outline',
    description:
      'Оглавление одной клинической рекомендации: номер раздела, название, размер в знаках. Без section — основные разделы; с section — подразделы этого раздела.',
    parameters: {
      type: 'object',
      properties: {
        clinrec_id: { type: 'string', description: 'Код рекомендации из каталога' },
        section: { type: 'string', description: 'Номер раздела из оглавления, например 6.2 (необязательно)' },
      },
      required: ['clinrec_id'],
    },
  },
  {
    name: 'read_clinrec_section',
    description: `Прочитать разделы рекомендации целиком (вместе с подразделами). До ${READ_MAX_SECTIONS} номеров за вызов, всего не больше ${READ_BUDGET} знаков; если больше — вернётся оглавление раздела, выбери подразделы.`,
    parameters: {
      type: 'object',
      properties: {
        clinrec_id: { type: 'string', description: 'Код рекомендации из каталога' },
        sections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Номера разделов из оглавления или из результата поиска, например ["6.2", "6.3"]',
        },
      },
      required: ['clinrec_id', 'sections'],
    },
  },
];

const DRUG_DEFINITION = {
  name: 'search_drug_instructions',
  description:
    'Поиск по официальным инструкциям по применению лекарств: показания, дозы, противопоказания, побочные действия, взаимодействия. Передай короткий запрос и, если известно, МНН.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Поисковый запрос: что ищем в инструкции; без данных пациента' },
      inn: { type: 'string', description: 'МНН препарата, например «сертралин» (необязательно)' },
    },
    required: ['query'],
  },
};
const DRUG_K = 5;

/**
 * @param {{knowledge: object, db?: object, nextNo?: () => number, onAccess?: (name: string) => void}} deps — nextNo —
 *   общий счётчик номеров источников ответа (с поиском статей); db (SQLite приложения) нужен,
 *   чтобы источник-инструкция открывался в карточке препарата (id МНН каталога)
 * @returns {Promise<{definitions: object[], execute: Function, card: string, maxCalls: number, rulesKey: string,
 *   sources: () => object[], cited: (text: string) => object[]}|null>} null — знания недоступны
 */
async function createClinrecTools({ knowledge, db = null, nextNo = null, onAccess = () => {} }) {
  if (!knowledge || !knowledge.enabled) return null;
  const pool = knowledge.pool();
  if (!pool) return null;
  let docs = [];
  try {
    docs = (await pool.query('SELECT id, title, version FROM clinrec.documents ORDER BY title')).rows;
  } catch {
    docs = [];
  }
  const byId = new Map(docs.map((d) => [d.id, d]));
  const prefix = (docId) => `${docId}.n.`;
  const shortNo = (docId, sectionId) =>
    sectionId && sectionId.startsWith(prefix(docId)) ? sectionId.slice(prefix(docId).length) : sectionId || '';
  const fullId = (docId, no) => {
    const s = String(no || '').trim();
    return s.startsWith(prefix(docId)) ? s : `${prefix(docId)}${s.replace(/^n\./, '')}`;
  };

  // Источники ответа: один номер на раздел рекомендации. chunk_id — фрагмент (чанк), который нашёл поиск: по нему
  // правая панель подсвечивает место в разделе; snippet — короткая цитата для карточки.
  const sources = [];
  // Номера, которые модель действительно увидела (текст фрагмента попал в её запрос). Только по ним строятся карточки.
  const shown = new Set();
  // Полный текст показанных фрагментов по номерам: для проверки, что препарат из ответа назван в источнике.
  const fragments = new Map();
  const keep = (n, text) => fragments.set(n, `${fragments.get(n) || ''}\n${text || ''}`);
  const sourceNo = (doc, sectionId, path, found = {}) => {
    const key = `${doc.id}|${sectionId || path}`;
    let s = sources.find((x) => x.key === key);
    if (!s) {
      s = {
        key,
        n: nextNo ? nextNo() : sources.length + 1,
        kind: 'clinrec',
        clinrec: true,
        document_id: doc.id,
        label: doc.title,
        path,
        section_id: sectionId || null,
        section_no: shortNo(doc.id, sectionId),
        chunk_id: null,
        snippet: '',
        page: null,
      };
      sources.push(s);
    }
    if (!s.chunk_id && found.chunkId) s.chunk_id = found.chunkId;
    if (!s.snippet && found.text) s.snippet = plain(found.text);
    return s.n;
  };

  // Инструкции к лекарствам: инструмент есть, только если корпус med загружен.
  let drugsLoaded = false;
  try {
    drugsLoaded = (await pool.query('SELECT 1 FROM med.documents LIMIT 1')).rows.length > 0;
  } catch {
    drugsLoaded = false;
  }
  const innId = (name) => {
    if (!db || !name) return null;
    try {
      const norm = String(name).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
      const row = db.prepare("SELECT id FROM inn WHERE status='in_catalog' AND name_norm=?").get(norm);
      return row ? row.id : null;
    } catch {
      return null;
    }
  };
  const drugSourceNo = (r) => {
    const key = `med|${r.document_id}|${r.section_id}`;
    let s = sources.find((x) => x.key === key);
    if (!s) {
      s = {
        key,
        n: nextNo ? nextNo() : sources.length + 1,
        kind: 'drug',
        drug: true,
        document_id: r.document_id,
        label: r.label,
        section_id: r.section_id,
        chunk_id: r.chunk_id || null,
        snippet: plain(r.text || r.snippet),
        path: r.path || '',
        page: r.page || null,
        inn_id: innId(r.inn),
      };
      sources.push(s);
    }
    if (!s.chunk_id && r.chunk_id) s.chunk_id = r.chunk_id;
    return s.n;
  };
  if (!docs.length && !drugsLoaded) return null;
  /** Фрагменты инструкций: блоки с номерами источников (для инструмента и для схемы «план и исполнение»). */
  async function drugBlocks(args, limit = DRUG_K) {
    const q = publicReferenceTerm(args.query, 200);
    if (q.length < 2) return { q, inn: null, blocks: [], empty: 'Пустой поисковый запрос: передай, что искать в инструкции.' };
    const inn = args.inn ? publicReferenceTerm(args.inn, 80) : null;
    // Названный в запросе препарат (торговое название или МНН) сужает поиск до его инструкций: остальные отбрасываются.
    // Название препарата в запросе надёжнее МНН от модели: торговое название в области по МНН не работает.
    let named = [];
    try {
      named = knowledge.documentsNamed ? await knowledge.documentsNamed(`${inn || ''} ${q}`) : [];
    } catch {
      named = [];
    }
    // Назван препарат каталога, для которого инструкции нет: чужие инструкции не подставляем.
    if (!named.length && db && (await namedWithoutInstructions({ db, knowledge, text: `${inn || ''} ${q}` })))
      return { q, inn, blocks: [], empty: null };
    const r = await knowledge.search({
      query: q,
      innName: named.length ? null : inn,
      drugIds: named,
      limit,
      semantic: true,
      withInn: true,
      includeText: true,
    });
    const blocks = [];
    for (const x of r.results) {
      if (!x.text) continue;
      const n = drugSourceNo(x);
      keep(n, x.text);
      blocks.push({
        n,
        key: `${n}|${String(x.text).slice(0, 80)}`,
        text: `[${n}] Инструкция: ${x.label}${x.path ? ` · ${x.path}` : ''}${x.page ? ` · стр. ${x.page}` : ''}\n${clip(String(x.text).replace(/\s+/g, ' ').trim(), DRUG_FRAGMENT_MAX)}`,
      });
    }
    return { q, inn, blocks, empty: null };
  }
  async function searchDrugs(args) {
    const r = await drugBlocks(args);
    if (r.empty) return r.empty;
    if (!r.blocks.length)
      return `В инструкциях по запросу «${r.q}»${r.inn ? ` (МНН ${r.inn})` : ''} ничего не найдено.`;
    r.blocks.forEach((b) => shown.add(b.n));
    return `Найдено в инструкциях (номер в квадратных скобках — ссылка на источник):\n\n${r.blocks.map((b) => b.text).join('\n\n')}`;
  }

  const outlineCache = new Map();
  async function sectionsOf(docId) {
    if (!outlineCache.has(docId)) {
      const { rows } = await pool.query(
        'SELECT id, parent_id, level, ord, title, path, span FROM clinrec.sections WHERE document_id = $1 ORDER BY ord',
        [docId],
      );
      const kids = new Map();
      for (const r of rows) {
        r.size = spanSize(r.span);
        if (!kids.has(r.parent_id)) kids.set(r.parent_id, []);
        kids.get(r.parent_id).push(r);
      }
      outlineCache.set(docId, { rows, kids, byId: new Map(rows.map((r) => [r.id, r])) });
    }
    return outlineCache.get(docId);
  }

  const docOf = (args) => {
    const doc = byId.get(String((args && args.clinrec_id) || '').trim());
    return doc || null;
  };
  const unknownDoc = () => `Нет такой рекомендации. Коды: ${docs.map((d) => d.id).join(', ')}.`;

  async function outlineText(doc, sectionNo) {
    const o = await sectionsOf(doc.id);
    const lines = [];
    const line = (r, depth) => {
      const n = (o.kids.get(r.id) || []).length;
      lines.push(
        `${'  '.repeat(depth)}${shortNo(doc.id, r.id)} ${clip(r.title, 120)} [${kz(r.size)}${n ? `; внутри ${n}` : ''}]`,
      );
    };
    const walk = (r, depth, maxDepth) => {
      if (lines.length >= OUTLINE_MAX_LINES) return;
      line(r, depth);
      if (depth + 1 >= maxDepth || r.size <= UNIT) return;
      for (const k of o.kids.get(r.id) || []) walk(k, depth + 1, maxDepth);
    };
    if (sectionNo) {
      const root = o.byId.get(fullId(doc.id, sectionNo));
      if (!root) return `Раздела ${sectionNo} нет в оглавлении «${doc.title}».`;
      lines.push(`Подразделы раздела ${shortNo(doc.id, root.id)} «${clip(root.title, 120)}»:`);
      for (const k of o.kids.get(root.id) || []) walk(k, 0, 2);
      if (lines.length === 1) lines.push('(подразделов нет — читай раздел целиком)');
      return lines.join('\n');
    }
    const top = o.rows.filter((r) => r.level === 2);
    const cut = top.findIndex((r) => /^список литературы$/i.test(r.title.trim()));
    const main = (cut >= 0 ? top.slice(0, cut) : top).filter((r) => !SKIP_TITLES.test(r.title.trim()));
    const apps = (cut >= 0 ? top.slice(cut + 1) : []).filter((r) => /^приложение/i.test(r.title.trim()));
    lines.push(`Оглавление «${doc.title}»: номер, название [размер в знаках; число подразделов].`);
    for (const r of main) walk(r, 0, OUTLINE_DEPTH);
    if (apps.length)
      lines.push(`Приложения: ${apps.map((r) => `${shortNo(doc.id, r.id)} ${clip(r.title, 70)}`).join('; ')}.`);
    if (lines.length >= OUTLINE_MAX_LINES) lines.push('… оглавление сокращено, открой нужный раздел по номеру.');
    return lines.join('\n');
  }

  /** Фрагменты рекомендаций: блоки с номерами источников; client — клиент векторизации (по умолчанию общий). */
  async function clinrecBlocks({ q, doc, limit = SEARCH_K, client }) {
    const run = (mode) =>
      searchClinrec(pool, q, {
        mode,
        limit,
        client: mode === 'lexical' ? undefined : client === undefined ? knowledge.embeddingClient() : client,
        ...(doc ? { scope: { documentIds: [doc.id] } } : {}),
      });
    let found;
    try {
      found = await run('hybrid');
    } catch {
      found = await run('lexical');
    }
    const blocks = [];
    for (const r of found.results) {
      if (!r.context) continue;
      const d = byId.get(r.document.id) || { id: r.document.id, title: r.document.title };
      const path = (r.heading_path || []).slice(1).join(' / ');
      const n = sourceNo(d, r.section_id, path, {
        chunkId: r.matched_chunks && r.matched_chunks[0] && r.matched_chunks[0].chunk_id,
        text: r.context,
      });
      const no = shortNo(d.id, r.section_id);
      keep(n, r.context);
      blocks.push({
        n,
        key: `${n}|${String(r.context).slice(0, 80)}`,
        text: `[${n}] ${d.title} (${d.id})${no ? `, раздел ${no}` : ''}${path ? ` · ${path}` : ''}\n${clip(String(r.context).replace(/\s+/g, ' ').trim(), FRAGMENT_MAX)}`,
      });
    }
    return blocks;
  }

  async function search(args) {
    const q = publicReferenceTerm(args.query, 200);
    if (q.length < 2) return 'Пустой поисковый запрос: передай термины по вопросу.';
    let doc = null;
    if (args.clinrec_id) {
      doc = docOf(args);
      if (!doc) return unknownDoc();
    }
    const blocks = await clinrecBlocks({ q, doc });
    if (!blocks.length)
      return `По запросу «${q}» ничего не найдено${doc ? ` в «${doc.title}»` : ''}. Попробуй другие слова или оглавление.`;
    blocks.forEach((b) => shown.add(b.n));
    return `Найдено (фрагменты; номер в квадратных скобках — ссылка на источник):\n\n${blocks.map((b) => b.text).join('\n\n')}`;
  }

  async function read(args) {
    const doc = docOf(args);
    if (!doc) return unknownDoc();
    // Часть моделей (Qwen) передаёт массив строкой с JSON: '["5.1","5.2"]'.
    let list = args.sections;
    if (typeof list === 'string' && list.trim().startsWith('[')) {
      try {
        list = JSON.parse(list);
      } catch {
        /* остаётся как есть: один номер */
      }
    }
    const wanted = (Array.isArray(list) ? list : [list])
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .slice(0, READ_MAX_SECTIONS);
    if (!wanted.length) return 'Не указаны номера разделов.';
    const o = await sectionsOf(doc.id);
    const picked = [];
    const missing = [];
    for (const no of wanted) {
      const r = o.byId.get(fullId(doc.id, no));
      if (r) picked.push(r);
      else missing.push(no);
    }
    if (!picked.length) return `Разделов ${missing.join(', ')} нет в «${doc.title}». Посмотри оглавление.`;
    const total = picked.reduce((a, r) => a + r.size, 0);
    if (total > READ_BUDGET) {
      const parts = [];
      for (const r of picked) parts.push(await outlineText(doc, shortNo(doc.id, r.id)));
      return `Слишком много текста (${kz(total)} знаков, можно ${kz(READ_BUDGET)}). Выбери подразделы:\n\n${parts.join('\n\n')}`;
    }
    const out = [];
    for (const r of picked) {
      const sec = await getClinrecSection(pool, { documentId: doc.id, sectionId: r.id, maxChars: READ_BUDGET });
      const path = String(r.path || '')
        .split(' > ')
        .slice(1)
        .join(' / ');
      const n = sourceNo(doc, r.id, path, { text: sec.text });
      shown.add(n);
      keep(n, sec.text);
      out.push(
        `[${n}] ${doc.title}, раздел ${shortNo(doc.id, r.id)} · ${path}\n${sec.text}${sec.hasMore ? '\n…' : ''}`,
      );
    }
    if (missing.length) out.push(`Разделов ${missing.join(', ')} нет в оглавлении.`);
    return out.join('\n\n');
  }

  async function execute(name, rawArgs = {}) {
    onAccess(name);
    const args = cleanArgs(rawArgs);
    if (name === 'search_clinrec' && docs.length) return search(args);
    if (name === 'get_clinrec_outline') {
      const doc = docOf(args);
      return doc ? outlineText(doc, args.section ? String(args.section) : null) : unknownDoc();
    }
    if (name === 'read_clinrec_section') return read(args);
    if (name === 'search_drug_instructions' && drugsLoaded) return searchDrugs(args);
    throw new Error(`unknown tool ${name}`);
  }

  const card = [
    docs.length
      ? 'Клинические рекомендации (каталог: код — название). Ищи и читай их инструментами search_clinrec, get_clinrec_outline, read_clinrec_section.\n' +
        docs.map((d) => `- ${d.id} — ${d.title}`).join('\n')
      : '',
    drugsLoaded ? 'Инструкции по применению лекарств ищи инструментом search_drug_instructions.' : '',
  ]
    .filter(Boolean)
    .join('\n');

  const view = ({ key: _k, ...s }) => s;
  return {
    definitions: [...(docs.length ? DEFINITIONS : []), ...(drugsLoaded ? [DRUG_DEFINITION] : [])],
    execute,
    card,
    maxCalls: 6,
    rulesKey: 'tools.clinrec',
    /**
     * Прямой поиск для схемы «план и исполнение» (clinrecPlan.js): те же источники и номера [n], что у инструментов,
     * но без цикла модели. Возвращает блоки {n, key, text}; ошибки поиска бросает вызывающему.
     */
    retrieval: {
      docs: docs.map((d) => ({ id: d.id, title: d.title })),
      drugsLoaded,
      async searchClinrec({ query, clinrecId = null, limit = 3, client }) {
        onAccess('search_clinrec');
        const q = publicReferenceTerm(cleanArgs({ q: query }).q, 200);
        if (q.length < 2) return [];
        const doc = clinrecId ? byId.get(String(clinrecId)) || null : null;
        return clinrecBlocks({ q, doc, limit, client });
      },
      async searchDrugs({ query, inn = null, limit = 3 }) {
        onAccess('search_drug_instructions');
        const args = cleanArgs({ query, inn });
        const r = await drugBlocks(args, limit);
        // МНН от модели может не совпасть с каталогом (латиницей, другая форма) и сузить поиск до пустоты: повтор без него.
        if (!r.blocks.length && args.inn) return (await drugBlocks({ query: args.query }, limit)).blocks;
        return r.blocks;
      },
    },
    /** Все источники, номера которых получила модель. */
    sources: () => sources.filter((s) => shown.has(s.n)).map(view),
    /** Текст фрагментов источника n, которые получила модель (для проверки привязки). */
    fragmentText: (n) => fragments.get(n) || '',
    /** Номера источников, которые модель видела в этом ответе. */
    shownNumbers: () => [...shown],
    /** Фрагменты, вошедшие в запрос на ответ (схема «план и исполнение»), считаются показанными. */
    markShown: (numbers) => (numbers || []).forEach((n) => shown.add(n)),
    /**
     * Выдержка инструкции, найденная сервером до ответа (pre-retrieval): тот же номер, что у такого же раздела в
     * поиске, и сразу «показана». Возвращает номер источника [n].
     */
    registerDrug: (r) => {
      const n = drugSourceNo(r);
      keep(n, r.text);
      shown.add(n);
      return n;
    },
    /** Источники, на которые ответ ссылается [n] или [n, m]; номера, которых модель не видела, отбрасываются. */
    cited: (text) => {
      const used = citedNumbers(text);
      return sources.filter((s) => shown.has(s.n) && used.has(s.n)).map(view);
    },
    /** Текст без меток с номерами, которых нет среди показанных источников. */
    sanitize: (text) => stripUnknown(text, new Set(shown)),
  };
}

module.exports = { createClinrecTools, DEFINITIONS, DRUG_DEFINITION, READ_BUDGET };
