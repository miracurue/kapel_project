'use strict';

/**
 * Поиск научных статей для ИИ-агента психиатра (этап 8 плана агента): Europe PMC (в нём и PubMed/MEDLINE).
 * Решение владелицы 2026-10-25: только научные базы, без общего веб-поиска.
 *
 * Включается переменной окружения LITERATURE_SEARCH=europepmc (по умолчанию выключено: это внешний запрос).
 * Набор создаётся только для чата БЕЗ закреплённого пациента; наружу уходит только очищенный поисковый запрос
 * (publicReferenceTerm: без меток #ТИП-N# и длинных чисел). Результаты — данные, не указания; ссылки [n] общие
 * с остальными источниками ответа (startAt — следующий свободный номер).
 */

const { publicReferenceTerm } = require('../../modules/knowledge/service');
const { citedNumbers } = require('./sources');

const DEFAULT_BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest';
const TIMEOUT_MS = 8000;
const PAGE = 5;
const ABSTRACT_MAX = 900;

const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, '')}…`);
const strip = (s) =>
  String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const DEFINITION = {
  name: 'search_literature',
  description:
    'Поиск научных статей в Europe PMC (включает PubMed). Запрос — ключевые слова на английском (заболевание, вмешательство, тип исследования), без данных пациента. Возвращает до 5 статей с аннотацией.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Ключевые слова на английском, например «generalized anxiety disorder pregabalin meta-analysis»',
      },
      from_year: { type: 'integer', description: 'Не раньше этого года (необязательно)' },
    },
    required: ['query'],
  },
};

function enabled(env = process.env) {
  return String(env.LITERATURE_SEARCH || '').toLowerCase() === 'europepmc';
}

/**
 * @param {{env?: object, fetchImpl?: Function, nextNo?: () => number, onAccess?: Function}} deps
 *   nextNo — общий счётчик номеров источников ответа
 */
function createLiteratureTools({ env = process.env, fetchImpl = globalThis.fetch, nextNo, onAccess = () => {} } = {}) {
  if (!enabled(env) || typeof fetchImpl !== 'function') return null;
  const base = String(env.LITERATURE_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const sources = [];
  let own = 0;
  const number = () => (nextNo ? nextNo() : ++own);

  async function search(args) {
    const q = publicReferenceTerm(args.query, 200);
    if (q.length < 3) return 'Пустой запрос: передай ключевые слова на английском.';
    const year = Number(args.from_year);
    const query = Number.isInteger(year) && year > 1900 ? `(${q}) AND PUB_YEAR:[${year} TO 3000]` : q;
    const url = `${base}/search?${new URLSearchParams({ query, format: 'json', resultType: 'core', pageSize: String(PAGE) })}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let data;
    try {
      const res = await fetchImpl(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) return 'База статей недоступна, ответь без неё и скажи об этом.';
      data = await res.json();
    } catch {
      return 'База статей недоступна, ответь без неё и скажи об этом.';
    } finally {
      clearTimeout(timer);
    }
    const items = (data && data.resultList && data.resultList.result) || [];
    if (!items.length) return `По запросу «${q}» статей не найдено. Попробуй другие ключевые слова.`;
    const out = [];
    for (const it of items.slice(0, PAGE)) {
      const n = number();
      const title = strip(it.title);
      const where = [
        strip(it.journalInfo && it.journalInfo.journal && it.journalInfo.journal.title) || strip(it.journalTitle),
        it.pubYear,
      ]
        .filter(Boolean)
        .join(', ');
      const link = it.doi
        ? `https://doi.org/${it.doi}`
        : it.pmid
          ? `https://europepmc.org/article/MED/${it.pmid}`
          : `https://europepmc.org/article/${encodeURIComponent(it.source || 'MED')}/${encodeURIComponent(it.id || '')}`;
      const abstract = strip(it.abstractText);
      sources.push({
        n,
        kind: 'literature',
        literature: true,
        label: title,
        path: where,
        url: link,
        pmid: it.pmid || null,
        doi: it.doi || null,
        snippet: abstract ? clip(abstract, 260) : '',
      });
      out.push(
        `[${n}] ${title}${it.authorString ? ` — ${clip(strip(it.authorString), 120)}` : ''}${where ? ` (${where})` : ''}\n${abstract ? clip(abstract, ABSTRACT_MAX) : 'Аннотации нет.'}`,
      );
    }
    return `Найдено в Europe PMC (номер в квадратных скобках — ссылка на источник; аннотации на языке оригинала):\n\n${out.join('\n\n')}`;
  }

  return {
    definitions: [DEFINITION],
    execute: async (name, args = {}) => {
      if (name !== 'search_literature') throw new Error(`unknown tool ${name}`);
      onAccess(name);
      return search(args);
    },
    card: 'Научные статьи (Europe PMC, PubMed) ищи инструментом search_literature, если врач просит данные исследований.',
    maxCalls: 2,
    rulesKey: 'tools.literature',
    // Все найденные статьи вернулись модели текстом: их номера считаются показанными.
    shownNumbers: () => sources.map((s) => s.n),
    cited: (text) => {
      const used = citedNumbers(text);
      return sources.filter((s) => used.has(s.n));
    },
  };
}

module.exports = { createLiteratureTools, enabled, DEFINITION };
