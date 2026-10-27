'use strict';

/**
 * Схема «план и исполнение» для чата психиатра без закреплённого пациента (этап 10 плана агента; выбрана владелицей
 * 2026-10-26 по эксперименту experiments/15_план_и_исполнение, там же эталон поведения и цифры):
 *   1. ПЛАН — один вызов модели без рассуждения: пункты ответа и 1–2 коротких запроса на пункт, с кодом рекомендации
 *      из каталога или пометкой source:"drug" (инструкции к лекарствам);
 *   2. ПОИСК — код, параллельно: по каждому запросу гибридный поиск по 3 фрагмента;
 *   3. ПРОВЕРКА ПОЛНОТЫ — один вызов модели: какие пункты не подтверждены, до 3 новых запросов; код доискивает один раз;
 *   4. ОТВЕТ — вызов основной модели без инструментов (его делает шлюз) по найденным фрагментам с номерами [n].
 * Здесь шаги 1–3 и сборка запроса для шага 4. Вызовы модели идут через шлюз (аудит, журнал шагов агента); поиск —
 * через те же источники и счётчик номеров, что у инструментов (clinrecTools.js), поэтому ссылки [n] и правая панель
 * работают как раньше. Любая неудача плана (нет знаний, ошибка модели, пустой план, ничего не найдено) — null:
 * шлюз откатывается на прежний цикл инструментов. Ошибка проверки полноты = «всё покрыто».
 * Данных пациента нет (режим только без пациента); наружу уходят только очищенные поисковые строки.
 */

const PER_QUERY = 3; // фрагментов на подвопрос
const MAX_QUERIES = 6;
const MAX_MISSING = 3;
const PREVIEW_CHARS = 500; // длина фрагмента в запросе проверки полноты
const TOTAL_CHARS = 36000; // потолок текста найденного в запросе на ответ
const HISTORY_MESSAGES = 4; // предыдущих реплик беседы для планировщика
const HISTORY_CHARS = 600;
const SEARCH_BUDGET_MS = 45000; // после этого проверка полноты пропускается
const EMBED_PARALLEL = 2; // ключ векторизации принимает мало одновременных запросов (HTTP 429)

const KEYS = { plan: 'tools.clinrec_plan', coverage: 'tools.clinrec_coverage', answer: 'tools.clinrec_answer' };

const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, '')}…`);

/** JSON из ответа модели: от первой «{» до последней «}». Не разобрался — null. */
function parseJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(s.slice(a, b + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Клиент векторизации на один ответ: не больше EMBED_PARALLEL запросов одновременно, один и тот же текст
 * векторизуется один раз. Сбой не кэшируется; общая пауза после сбоя — у обёртки knowledge.embeddingClient().
 */
function limitedClient(base) {
  if (!base) return null;
  const memo = new Map();
  const waiting = [];
  let active = 0;
  const slot = async () => {
    if (active >= EMBED_PARALLEL) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
  };
  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };
  const one = (text) => {
    if (!memo.has(text)) {
      const p = (async () => {
        await slot();
        try {
          const r = await base.embed([text]);
          return r.vectors[0];
        } finally {
          release();
        }
      })();
      p.catch(() => memo.delete(text));
      memo.set(text, p);
    }
    return memo.get(text);
  };
  return {
    model: base.model,
    async embed(texts) {
      return { model: base.model, vectors: await Promise.all(texts.map(one)) };
    },
  };
}

/** Подвопросы из плана: не больше MAX_QUERIES, без повторов; неизвестный код рекомендации отбрасывается. */
function collectQueries(plan, known, drugsLoaded) {
  const out = [];
  const seen = new Set();
  const add = (point, q) => {
    if (!q || typeof q !== 'object' || typeof q.query !== 'string') return;
    const query = q.query.trim();
    if (query.length < 2 || out.length >= MAX_QUERIES) return;
    const drug = drugsLoaded && q.source === 'drug';
    const doc = !drug && known.has(q.clinrec_id) ? q.clinrec_id : null;
    const inn = drug && typeof q.inn === 'string' && q.inn.trim() ? q.inn.trim() : null;
    const key = `${drug ? 'd' : 'c'}|${doc || ''}|${query.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ point: String(point || '').trim(), query, doc, drug, inn });
  };
  for (const s of Array.isArray(plan.sections) ? plan.sections : []) {
    if (!s || typeof s !== 'object') continue;
    for (const q of Array.isArray(s.queries) ? s.queries : []) add(s.point, q);
  }
  return out;
}

/**
 * @param {{clinrec: {retrieval: object}, embeddingClient: () => object|null, question: string, lead?: string,
 *   answerReasoning?: object|null}} deps
 *   clinrec — набор createClinrecTools; question — вопрос врача (уже псевдонимизирован); lead — всё, что в прежнем
 *   режиме шло в запрос до вопроса (контекст чипов, выдержки из инструкций); answerReasoning — параметр глубины рассуждения для ответа, например {effort:'medium'}
 * @returns {{answerKey: string, promptKeys: string[], execute: Function}}
 */
function createPlanSpec({ clinrec, embeddingClient, question, lead = '', answerReasoning = null }) {
  const r = clinrec.retrieval;
  const known = new Set(r.docs.map((d) => d.id));
  const catalog = r.docs.map((d) => `- ${d.id} — ${d.title}`).join('\n');

  /**
   * @param {{ask: Function, step: Function, progress: Function, history: object[]}} io — ask({key,text,name}) -> текст
   *   ответа модели (через шлюз, с записью в журнал); step(s) — шаг журнала агента; progress({phase}) — ход ответа
   * @returns {Promise<{text: string, queries: number, missing: number}|{offTopic: true}|null>} запрос на ответ, {offTopic} — нецелевой вопрос или null — откат на цикл
   */
  async function execute({ ask, step, progress, history = [] }) {
    const t0 = Date.now();
    if (!r.docs.length && !r.drugsLoaded) return null;

    // 1. План.
    progress({ phase: 'plan' });
    const recent = history
      .slice(-HISTORY_MESSAGES)
      .map(
        (m) =>
          `${m.role === 'assistant' ? 'ИИ' : 'Врач'}: ${clip(String(m.text || '').replace(/\s+/g, ' '), HISTORY_CHARS)}`,
      );
    const planText = await ask({
      key: KEYS.plan,
      name: 'plan',
      text: `${recent.length ? `Предыдущие реплики беседы:\n${recent.join('\n')}\n\n` : ''}Вопрос врача: ${question}\n\nКаталог рекомендаций:\n${catalog || '(пусто)'}`,
    });
    const plan = parseJson(planText);
    // Планировщик (tools.clinrec_plan v002) счёл вопрос бессмысленным или посторонним: поиск не нужен (guard.scope_clinician).
    if (plan && plan.offtopic === true) return { offTopic: true };
    if (!plan || !Array.isArray(plan.sections)) return null;
    const subs = collectQueries(plan, known, r.drugsLoaded);
    if (!subs.length) return null;

    // 2. Поиск.
    progress({ phase: 'search' });
    const client = limitedClient(embeddingClient());
    let drugChain = Promise.resolve(); // запросы в инструкции — по одному: у них свой клиент векторизации
    const search = async (sub, stage) => {
      const s0 = Date.now();
      let blocks = [];
      let status = 'ok';
      let error;
      try {
        if (sub.drug) {
          const run = drugChain.then(() => r.searchDrugs({ query: sub.query, inn: sub.inn, limit: PER_QUERY }));
          drugChain = run.catch(() => {});
          blocks = await run;
        } else {
          blocks = await r.searchClinrec({ query: sub.query, clinrecId: sub.doc, limit: PER_QUERY, client });
        }
      } catch (e) {
        status = 'error';
        error = e && e.message;
      }
      step({
        kind: 'tool',
        name: sub.drug ? 'search_drug_instructions' : 'search_clinrec',
        args: sub.drug
          ? { query: sub.query, ...(sub.inn ? { inn: sub.inn } : {}) }
          : { query: sub.query, ...(sub.doc ? { clinrec_id: sub.doc } : {}) },
        result: blocks.length ? blocks.map((b) => b.text).join('\n\n') : 'ничего не найдено',
        durationMs: Date.now() - s0,
        status,
        error,
        reason: `${stage}: ${sub.point}`,
      });
      return blocks;
    };
    const found = (await Promise.all(subs.map((s) => search(s, 'подвопрос')))).flat();
    const unique = () => {
      const seen = new Set();
      return found.filter((b) => (seen.has(b.key) ? false : seen.add(b.key)));
    };
    if (!unique().length) return null;

    // 3. Проверка полноты и однократное доискивание. Любой сбой — «всё покрыто».
    const points = [...new Set(subs.map((s) => s.point).filter(Boolean))];
    let missing = 0;
    if (Date.now() - t0 < SEARCH_BUDGET_MS) {
      progress({ phase: 'check' });
      try {
        const preview = unique()
          .map((b) => clip(b.text.replace(/\s+/g, ' '), PREVIEW_CHARS))
          .join('\n\n');
        const covText = await ask({
          key: KEYS.coverage,
          name: 'coverage',
          text: `Вопрос врача: ${question}\n\nПлан ответа:\n${points.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nКаталог рекомендаций:\n${catalog || '(пусто)'}\n\n=== НАЙДЕННЫЕ ФРАГМЕНТЫ ===\n${preview}\n=== КОНЕЦ ===`,
        });
        const cov = parseJson(covText);
        const more = [];
        for (const m of (Array.isArray(cov && cov.missing) ? cov.missing : []).slice(0, MAX_MISSING)) {
          const [sub] = collectQueries({ sections: [{ point: m && m.point, queries: [m] }] }, known, r.drugsLoaded);
          if (sub) more.push(sub);
        }
        missing = more.length;
        if (more.length) found.push(...(await Promise.all(more.map((s) => search(s, 'доискивание')))).flat());
      } catch {
        /* проверка не удалась: идём с тем, что найдено */
      }
    }

    // 4. Запрос на ответ.
    let used = 0;
    const shown = [];
    for (const b of unique()) {
      if (used + b.text.length > TOTAL_CHARS && shown.length) break;
      shown.push(b);
      used += b.text.length;
    }
    // Источником в ответе станет только то, что модель действительно получила: найденное, но не вошедшее в запрос
    // (потолок TOTAL_CHARS, превью проверки полноты), номера не получает.
    clinrec.markShown(shown.map((b) => b.n));
    const text = [
      lead,
      question ? `Сообщение врача: ${question}` : '',
      points.length
        ? `План поиска (подсказка, что хотел узнать врач):\n${points.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
        : '',
      `Найденные фрагменты (номер источника в квадратных скобках):\n\n${shown.map((b) => b.text).join('\n\n')}\n=== конец фрагментов ===`,
    ]
      .filter(Boolean)
      .join('\n\n');
    return { text, queries: subs.length, missing };
  }

  return { answerKey: KEYS.answer, promptKeys: [KEYS.plan, KEYS.coverage, KEYS.answer], answerReasoning, execute };
}

module.exports = { createPlanSpec, limitedClient, parseJson, collectQueries, KEYS };
