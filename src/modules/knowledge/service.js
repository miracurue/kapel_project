'use strict';

/**
 * Служба знаний для приложения: ленивый пул Postgres (KNOWLEDGE_DATABASE_URL), клиент эмбеддингов,
 * поиск по инструкциям лекарств, оглавление и разделы, состояние для /readyz.
 *
 * Если KNOWLEDGE_DATABASE_URL не задан — служба выключена (`enabled === false`), приложение работает как раньше.
 * Любой сбой Postgres/эмбеддингов наружу не пробрасывается как падение процесса: вызывающий получает
 * ошибку с `code`, а поиск при недоступных эмбеддингах сам переходит на lexical (fallback в ответе).
 * Во внешний эмбеддинг-API уходит только очищенная поисковая строка (publicReferenceTerm), без контекста.
 */

const pg = require('./pg');
const med = require('./search_med');
const { normalizeText } = require('./rrf');

const EMBED_TIMEOUT_MS = 8000;
const MARK_PAGE_MAX = 60000; // первая страница раздела с подсвеченным фрагментом не больше этого
const EMBED_COOLDOWN_MS = 30000;
const STATUS_TTL_MS = 10000;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('embedding timeout'), { code: 'timeout' })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Строка, которая может уйти наружу как поисковый термин: без управляющих символов, ключей #ТИП-N# и длинных чисел. */
function publicReferenceTerm(value, max = 200) {
  let s = String(value || '')
    .replace(/#[A-Za-zА-Яа-яЁё_]+-\d+#/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\+?\d{4,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) {
    s = s.slice(0, max);
    const cut = s.lastIndexOf(' ');
    if (cut > max * 0.6) s = s.slice(0, cut);
    s = s.trim();
  }
  return s;
}

const NAMES_TTL_MS = 60000;
const NAME_MIN = 5;

/** Слова названия (торговое, МНН), по которым препарат узнаётся в тексте; короткие и служебные отбрасываются. */
function nameStems(row) {
  const out = new Set();
  for (const v of [row.drug_label, row.inn, row.trade_name]) {
    for (const w of normalizeText(v || '').split(/[^a-zа-я0-9]+/)) if (w.length >= NAME_MIN) out.add(w);
  }
  return out;
}

/** Слово текста — форма названия: совпадает или отличается окончанием («авиандра», «авиандре»). */
function sameName(word, name) {
  if (word === name) return true;
  const stem = name.slice(0, Math.max(NAME_MIN - 1, name.length - 2));
  return word.length >= stem.length && word.length <= name.length + 3 && word.startsWith(stem);
}

/**
 * Какие инструкции из списка docs ({id, drug_label, inn, trade_name}) названы в тексте. Пусто — ни одна не названа.
 * Используется, чтобы сузить поиск до названного препарата, а не искать по всему корпусу.
 */
function documentsNamedIn(text, docs) {
  const words = normalizeText(text || '')
    .split(/[^a-zа-я0-9]+/)
    .filter((w) => w.length >= NAME_MIN);
  if (!words.length) return [];
  return docs.filter((d) => [...nameStems(d)].some((n) => words.some((w) => sameName(w, n)))).map((d) => d.id);
}

/**
 * Раздел, оборванный границей чанка: начинается внутри чанка, а заканчивается дальше его конца
 * (типично: заголовок «Показания» и фраза «…для лечения:» в одном чанке, сам перечень в следующем).
 * Возвращает последний такой раздел или null.
 */
function cutSection(chunk, sections) {
  let cut = null;
  for (const s of sections) {
    if (s.start_char >= chunk.start_offset && s.start_char < chunk.end_offset && s.end_char > chunk.end_offset) {
      if (!cut || s.start_char >= cut.start_char) cut = s;
    }
  }
  return cut;
}

function createKnowledgeService({ env = process.env, poolFactory = pg.createPool, embeddingFactory } = {}) {
  const enabled = Boolean(env.KNOWLEDGE_DATABASE_URL);
  let pool = null;
  let poolError = null;
  let embedding; // undefined = ещё не создан, null = недоступен
  let embedDownUntil = 0;
  let statusCache = null;
  let closed = false;

  function getPool() {
    if (!enabled || closed) return null;
    if (!pool && !poolError) {
      try {
        pool = poolFactory({}, env);
      } catch (e) {
        poolError = e;
      }
    }
    return pool;
  }

  function rawEmbeddingClient() {
    if (embedding !== undefined) return embedding;
    embedding = null;
    try {
      if (embeddingFactory) {
        embedding = embeddingFactory(env) || null;
      } else if (env.NODE_ENV === 'test' && env.KNOWLEDGE_EMBEDDING_STUB) {
        // Тестовый хук: модуль экспортирует клиент { model, embed(texts) }.
        embedding = require(env.KNOWLEDGE_EMBEDDING_STUB);
      } else if (env.GIGACHAT_AUTH_KEY || env.GIGACHAT_ACCESS_TOKEN) {
        embedding = require('../medication_knowledge/embeddings').createEmbeddingClient({
          env,
          timeoutMs: 6000,
          maxRetries: 1,
        });
      }
    } catch {
      embedding = null;
    }
    return embedding;
  }

  // Обёртка с таймаутом и «остыванием» после сбоя: недоступный GigaChat не тормозит каждый запрос.
  let wrapped;
  function embeddingClient() {
    const raw = rawEmbeddingClient();
    if (!raw) return null;
    if (!wrapped)
      wrapped = {
        model: raw.model,
        async embed(texts) {
          if (Date.now() < embedDownUntil) throw Object.assign(new Error('embedding cooldown'), { code: 'cooldown' });
          try {
            return await withTimeout(raw.embed(texts), EMBED_TIMEOUT_MS);
          } catch (e) {
            embedDownUntil = Date.now() + (Number(env.KNOWLEDGE_EMBED_COOLDOWN_MS) || EMBED_COOLDOWN_MS);
            throw e;
          }
        },
      };
    return wrapped;
  }

  const unavailable = () => Object.assign(new Error('knowledge unavailable'), { code: 'knowledge_unavailable' });

  /** Нормализованное МНН -> id документов (для проверок принадлежности и списка). */
  async function documentsForInn(innName) {
    const p = getPool();
    if (!p) throw unavailable();
    const { rows } = await p.query(
      `SELECT d.id, d.drug_label AS label, d.trade_name,
              (SELECT count(*)::int FROM med.sections s WHERE s.document_id = d.id) AS sections,
              (SELECT count(*)::int FROM med.chunks c WHERE c.document_id = d.id) AS chunks
       FROM med.documents d JOIN med.drug_map m ON m.document_id = d.id
       WHERE m.inn_name_norm = $1 ORDER BY d.drug_label, d.id`,
      [normalizeText(innName)],
    );
    return rows;
  }

  async function toc(innName, documentId) {
    const p = getPool();
    if (!p) throw unavailable();
    const r = await med.getToc(p, { documentId, scope: { innNorm: innName } });
    return {
      document: { id: r.document.id, label: r.document.label },
      items: r.sections.map((s) => ({
        id: s.id,
        level: s.level,
        title: s.title,
        path: s.path,
        page: pageNumber(s.page_start),
      })),
    };
  }

  async function section(innName, documentId, sectionId, cursor) {
    const p = getPool();
    if (!p) throw unavailable();
    const r = await med.readSection(p, {
      documentId,
      sectionId,
      cursor,
      maxChars: 12000,
      scope: { innNorm: innName },
    });
    return { title: r.title, path: r.path, text: r.text, nextCursor: r.nextCursor, hasMore: r.hasMore };
  }

  /** Оглавление инструкции по коду документа (источник ответа ИИ открывает документ целиком, МНН не нужен). */
  async function documentToc(documentId) {
    const p = getPool();
    if (!p) throw unavailable();
    const r = await med.getToc(p, { documentId, scope: {} });
    const { rows } = await p.query('SELECT trade_name FROM med.documents WHERE id = $1', [documentId]);
    return {
      document: { id: r.document.id, label: r.document.label, trade_name: (rows[0] && rows[0].trade_name) || null },
      items: r.sections.map((s) => ({
        id: s.id,
        parent_id: s.parent_id,
        level: s.level,
        title: s.title,
        path: s.path,
        page: pageNumber(s.page_start),
      })),
    };
  }

  /**
   * Раздел инструкции с потомками постранично. chunkId — фрагмент, найденный поиском: если он лежит в разделе, ответ
   * содержит mark {start, end} (знаки от начала раздела), а первая страница доходит до конца фрагмента.
   */
  async function documentSection(documentId, sectionId, cursor, { chunkId = null } = {}) {
    const p = getPool();
    if (!p) throw unavailable();
    const read = (maxChars) => med.readSection(p, { documentId, sectionId, cursor, maxChars, scope: {} });
    let r = await read(12000);
    let mark = null;
    if (chunkId) {
      const { rows } = await p.query(
        'SELECT start_char, end_char FROM med.chunks WHERE id = $1 AND document_id = $2',
        [chunkId, documentId],
      );
      const c = rows[0];
      if (c) {
        // Фрагмент может выходить за границы раздела: берём пересечение.
        const start = Math.max(0, c.start_char - r.start_offset);
        const end = Math.min(r.total, c.end_char - r.start_offset);
        if (end > start) {
          mark = { start, end };
          if (cursor === 0 && end > r.cursor + 12000) r = await read(Math.min(end + 400, MARK_PAGE_MAX));
        }
      }
    }
    return {
      title: r.title,
      path: r.path,
      text: r.text,
      offset: r.cursor,
      total: r.total,
      nextCursor: r.nextCursor,
      hasMore: r.hasMore,
      ...(mark ? { mark } : {}),
    };
  }

  /**
   * Hybrid-поиск по инструкциям. innName — жёсткая область по МНН (null = весь корпус). semantic:false —
   * только lexical, без внешних вызовов. Возвращает { results, total, hasMore, fallback }.
   */
  async function search({
    query,
    innName = null,
    limit = 10,
    offset = 0,
    semantic = true,
    withInn = false,
    includeText = false,
    drugIds,
  }) {
    const p = getPool();
    if (!p) throw unavailable();
    const q = publicReferenceTerm(query);
    if (!normalizeText(q)) return { results: [], total: 0, hasMore: false, fallback: null };
    const options = {
      query: q,
      limit,
      offset,
      mode: semantic ? 'hybrid' : 'lexical',
      client: semantic ? embeddingClient() : undefined,
      scope: innName ? { innNorm: innName } : {},
      ...(drugIds && drugIds.length ? { drugIds } : {}),
    };
    const r = await med.searchText(p, options);
    if (includeText) await extendCutSections(p, r.results);
    const ids = [...new Set(r.results.map((x) => x.section_id))];
    const pages = new Map();
    if (ids.length) {
      const { rows } = await p.query('SELECT id, page, path FROM med.sections WHERE id = ANY($1::text[])', [ids]);
      for (const row of rows) pages.set(row.id, { page: pageNumber(row.page), path: row.path });
    }
    const results = r.results.map((x) => {
      const sec = pages.get(x.section_id) || {};
      const path = sec.path || (x.section_paths && x.section_paths[0] ? x.section_paths[0] : []).join(' / ');
      const item = {
        document_id: x.document_id,
        label: x.label,
        section_id: x.section_id,
        path,
        page: sec.page ?? null,
        snippet: snippetOf(x.content),
        score: x.score,
        match_type: x.match_type,
      };
      if (withInn) item.inn = x.inn;
      if (includeText) {
        item.text = x.content;
        item.chunk_id = x.id; // фрагмент, который нашёл поиск: источник ответа подсвечивает его в разделе
      }
      return item;
    });
    return {
      results,
      total: r.total,
      hasMore: r.hasMore,
      fallback: semantic ? r.fallback : 'lexical',
    };
  }

  let namesCache = null;
  /** Инструкции, чьё торговое название или МНН названо в тексте (кэш списка на минуту). Без службы — пусто. */
  async function documentsNamed(text) {
    const p = getPool();
    if (!p) return [];
    if (!namesCache || Date.now() - namesCache.at > NAMES_TTL_MS) {
      const { rows } = await p.query('SELECT id, drug_label, inn, trade_name FROM med.documents');
      namesCache = { at: Date.now(), rows };
    }
    return documentsNamedIn(text, namesCache.rows);
  }

  /**
   * Чанк, на границе которого оборван раздел, дополняется началом следующего чанка до конца раздела;
   * раздел источника — оборванный (а не первый из попавших в чанк, например «Преамбула»).
   */
  async function extendCutSections(p, results) {
    const ids = [...new Set(results.flatMap((x) => x.section_ids || []))];
    if (!ids.length) return;
    const { rows } = await p.query('SELECT id, start_char, end_char, path FROM med.sections WHERE id = ANY($1::text[])', [
      ids,
    ]);
    const byId = new Map(rows.map((s) => [s.id, s]));
    for (const x of results) {
      const cut = cutSection(x, (x.section_ids || []).map((id) => byId.get(id)).filter(Boolean));
      if (!cut) continue;
      const next = (
        await p.query('SELECT text, start_char FROM med.chunks WHERE document_id = $1 AND ord = $2', [
          x.document_id,
          x.ordinal + 1,
        ])
      ).rows[0];
      if (!next) continue;
      x.content = x.content + next.text.slice(0, Math.max(0, cut.end_char - next.start_char));
      x.section_id = cut.id;
      x.section_paths = [[cut.path].flat().filter(Boolean)];
      x.extended = true;
    }
  }

  /** Состояние для /readyz: ok | degraded | down | disabled. Кэш 10 с. */
  async function status() {
    if (!enabled) return { configured: false, status: 'disabled' };
    const nowMs = Date.now();
    if (statusCache && nowMs - statusCache.at < STATUS_TTL_MS) return statusCache.value;
    let value;
    const p = getPool();
    if (!p) value = { configured: true, status: 'down', error: 'config' };
    else {
      const health = await pg.healthcheck(p);
      if (!health.ok) value = { configured: true, status: 'down', ms: health.ms, error: health.error || 'schema' };
      else {
        try {
          const { rows } = await p.query(
            `SELECT (SELECT count(*)::int FROM med.documents) AS documents,
                    (SELECT count(*)::int FROM med.chunks) AS chunks,
                    (SELECT count(*)::int FROM med.chunks WHERE embedding IS NOT NULL) AS vectors`,
          );
          const r = rows[0];
          value = {
            configured: true,
            status: r.documents > 0 && r.vectors > 0 ? 'ok' : 'degraded',
            ms: health.ms,
            ...r,
            embeddings: rawEmbeddingClient() ? 'configured' : 'missing',
          };
        } catch (e) {
          value = { configured: true, status: 'down', error: e.code || e.name };
        }
      }
    }
    statusCache = { at: nowMs, value };
    return value;
  }

  async function close() {
    closed = true;
    const p = pool;
    pool = null;
    if (p) await pg.close(p).catch(() => {});
  }

  return {
    enabled,
    documentsForInn,
    toc,
    section,
    documentToc,
    documentSection,
    search,
    documentsNamed,
    status,
    close,
    pool: getPool,
    embeddingClient,
  };
}

/** Страница: целое число или null (в источнике это текст). */
function pageNumber(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Текст без Markdown-разметки для сниппета. */
function stripMarkdown(text) {
  return String(text || '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, ' ')
    .replace(/[*_`~#>|]+/g, ' ');
}

function snippetOf(text, max = 400) {
  const s = stripMarkdown(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

let shared = null;
/** Общий экземпляр процесса (создаётся при первом обращении из окружения). */
function getKnowledge() {
  if (!shared) shared = createKnowledgeService();
  return shared;
}
async function closeKnowledge() {
  if (shared) {
    const s = shared;
    shared = null;
    await s.close();
  }
}

module.exports = {
  createKnowledgeService,
  getKnowledge,
  closeKnowledge,
  publicReferenceTerm,
  documentsNamedIn,
  cutSection,
};
