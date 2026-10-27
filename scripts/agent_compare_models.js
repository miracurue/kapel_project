#!/usr/bin/env node
'use strict';

/**
 * Сравнение моделей в роли агента психиатра (чат специалиста с поиском по клинрекам и инструкциям).
 * Одни и те же вопросы идут через настоящий шлюз (gateway.run) с теми же промптами и инструментами, что в приложении;
 * меняется только основная модель, запасной нет, чтобы сбой не маскировался.
 *
 * Рабочая база не меняется: привязки переключаются на временной копии. Модель OpenRouter берётся из реестра
 * (миграция 0036, исключение из L-11 на этапе разработки, DATA_MODE=synthetic). Наружу уходят только вопросы из набора
 * ниже (синтетические, без данных пациентов) и публичные выдержки инструкций.
 *
 *   node --env-file=.env scripts/agent_compare_models.js [--models giga-max,giga-pro,qwen] [--only id,id] [--repeat 3] [--out file.json]
 * Нужны KNOWLEDGE_DATABASE_URL, GIGACHAT_AUTH_KEY, OPENROUTER_API_KEY, NODE_EXTRA_CA_CERTS (сертификат Минцифры).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { loadConfig, now } = require('../src/config');
const { createGateway } = require('../src/ai/gateway');
const { createPii } = require('../src/ai/pii');
const { createRegistry } = require('../src/ai/registry');
const { createClinrecTools } = require('../src/ai/workspace/clinrecTools');
const { getKnowledge, closeKnowledge } = require('../src/modules/knowledge/service');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};

const QWEN_IDENT = process.env.QWEN_MODEL || 'qwen/qwen3.8-flash';

// Проверки по тексту: must — все должны встретиться, mustNot — ни одного; tool — какой инструмент ожидаем.
const QUESTIONS = [
  {
    id: 'avi_indications',
    q: 'расскажи, при каких диагнозах применяют авиандр',
    tool: 'search_drug_instructions',
    must: [/тревожн/i, /генерализован/i],
    mustNot: [/шизофрен/i, /психоз/i, /мани/i, /фенотиазин/i],
  },
  {
    id: 'avi_dose',
    q: 'как дозировать авиандр при генерализованном тревожном расстройстве?',
    tool: 'search_drug_instructions',
    must: [/20\s*мг/i, /2 раза/i],
    mustNot: [/фенотиазин/i],
  },
  {
    id: 'avi_contra',
    q: 'какие у авиандра противопоказания',
    tool: 'search_drug_instructions',
    must: [/\[\d+\]/],
    mustNot: [/фенотиазин/i],
  },
  {
    id: 'unknown_drug',
    q: 'при каких диагнозах применяют зельвакс?',
    tool: 'search_drug_instructions',
    must: [/не найден|не нашл|не нашёл|нет (информации|сведений|данных)|отсутству/i],
    mustNot: [/показан к применению/i, /применяется при/i],
  },
  {
    id: 'clinrec_gtr',
    q: 'какие препараты рекомендованы при генерализованном тревожном расстройстве по клиническим рекомендациям?',
    tool: 'search_clinrec',
    must: [/\[\d+\]/],
    mustNot: [],
  },
];

const MODELS = {
  'giga-max': { ident: 'GigaChat-2-Max' },
  'giga-pro': { ident: 'GigaChat-2-Pro' },
  qwen: { ident: QWEN_IDENT },
};

async function main() {
  const wanted = arg('models', 'giga-max,giga-pro,qwen').split(',');
  const only = arg('only', '');
  const repeat = Number(arg('repeat', 1));
  const knowledge = getKnowledge();
  if (!knowledge.enabled) throw new Error('нужен KNOWLEDGE_DATABASE_URL');
  if (wanted.includes('qwen') && !process.env.OPENROUTER_API_KEY) throw new Error('нужен OPENROUTER_API_KEY');

  const config = loadConfig();
  if (config.dataMode === 'real') throw new Error('сравнение только при DATA_MODE=synthetic');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-compare-'));
  const copy = path.join(tmp, 'tdr.sqlite3');
  const src = new Database(config.dbPath, { readonly: true });
  await src.backup(copy);
  src.close();
  const db = new Database(copy);

  const activeSetting = (key) => {
    const row = db.prepare("SELECT * FROM setting_versions WHERE key=? AND status='active' ORDER BY version DESC LIMIT 1").get(key);
    return row ? { version: row.version, value: JSON.parse(row.value_json) } : { value: null };
  };
  const registry = createRegistry({ db, config, now, activeSetting });
  const pii = createPii({ db, config, ml: null });
  const gateway = createGateway({ db, config, now, registry, pii, settings: activeSetting });

  const modelId = (m) => {
    const row = db.prepare('SELECT id FROM ai_models WHERE model_ident = ?').get(m.ident);
    if (!row) throw new Error(`модели ${m.ident} нет в реестре`);
    return row.id;
  };
  const bind = (id) => {
    const v = db.prepare("SELECT max(version) v FROM ai_binding_versions WHERE purpose='clinician_chat'").get().v || 0;
    db.prepare("UPDATE ai_binding_versions SET status='previous' WHERE purpose='clinician_chat' AND status='active'").run();
    db.prepare(
      "INSERT INTO ai_binding_versions(purpose, version, primary_model_id, fallback_model_id, status, comment) VALUES ('clinician_chat', ?, ?, NULL, 'active', 'сравнение моделей')",
    ).run(v + 1, id);
    registry.invalidate();
  };
  const psy = db.prepare("SELECT id, role FROM users WHERE role='psychiatrist' ORDER BY id LIMIT 1").get();

  const results = [];
  for (const key of wanted) {
    const m = MODELS[key];
    if (!m) throw new Error(`неизвестная модель ${key}`);
    bind(modelId(m));
    for (const item of QUESTIONS.filter((x) => !only || only.split(',').includes(x.id)))
     for (let rep = 1; rep <= repeat; rep += 1) {
      const tools = await createClinrecTools({ knowledge, db, nextNo: null });
      const called = [];
      const wrapped = {
        ...tools,
        execute: async (name, args) => {
          const entry = { name, args };
          called.push(entry);
          entry.result = await tools.execute(name, args);
          return entry.result;
        },
      };
      const t0 = Date.now();
      const row = { model: key, question: item.id, run: rep, q: item.q };
      try {
        const out = await gateway.run({
          purpose: 'clinician_chat',
          user: { id: psy.id, role: psy.role },
          tools: wrapped,
          text: [tools.card, `Сообщение врача: ${item.q}`].filter(Boolean).join('\n'),
          history: [],
        });
        const text = String(out.text || '');
        const cited = [...new Set([...text.matchAll(/\[(\d{1,3})\]/g)].map((x) => Number(x[1])))];
        const known = new Set(tools.sources().map((s) => s.n));
        Object.assign(row, {
          ok: true,
          text,
          tool_calls: called.length,
          tools: called.map((c) => `${c.name}(${JSON.stringify(c.args)})`),
          results: called.map((c) => String(c.result || '').slice(0, 1500)),
          used_expected_tool: called.some((c) => c.name === item.tool),
          must_ok: item.must.every((re) => re.test(text)),
          mustnot_ok: !item.mustNot.some((re) => re.test(text)),
          bad_citations: cited.filter((n) => !known.has(n)),
          tokens_in: out.tokensIn ?? null,
          tokens_out: out.tokensOut ?? null,
          status: out.status,
          ms: Date.now() - t0,
        });
      } catch (e) {
        Object.assign(row, { ok: false, error: String(e && (e.code || e.message)), ms: Date.now() - t0 });
      }
      results.push(row);
      const mark = row.ok ? (row.must_ok && row.mustnot_ok && !row.bad_citations.length ? 'OK ' : 'BAD') : 'ERR';
      console.log(
        `${mark} ${key.padEnd(9)} ${item.id.padEnd(16)} #${rep} tools=${row.tool_calls ?? '-'} exp=${row.used_expected_tool ?? '-'} ` +
          `must=${row.must_ok ?? '-'} not=${row.mustnot_ok ?? '-'} badcite=${row.bad_citations ? row.bad_citations.length : '-'} ` +
          `${row.ms}ms${row.error ? ` ${row.error}` : ''}`,
      );
    }
  }
  const outFile = arg('out', path.join(tmp, 'compare.json'));
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`\nрезультаты: ${outFile}`);
  db.close();
  await closeKnowledge();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
