#!/usr/bin/env node
'use strict';

/**
 * Живой прогон агента психиатра на эталонном наборе knowledge/clinrecs/eval (этап 9 плана агента).
 * Вопросы идут через настоящий шлюз (gateway.run) с теми же промптами и инструментами, что в приложении.
 * Считается:
 *  — траектория: какие инструменты, сколько шагов, токены, время;
 *  — «дошёл до эталона»: цитата эталонного чанка встретилась в результатах инструментов;
 *  — факты в ответе: судья (glm через OpenRouter) отвечает yes/partial/no по каждому эталонному факту;
 *  — ссылки [n] без источника, ответ без единого вызова инструмента, уточняющий вопрос вместо поиска.
 * Рабочая база не меняется: привязка модели переключается на временной копии. Только DATA_MODE=synthetic;
 * наружу уходят синтетические вопросы и публичный текст клинреков.
 *
 *   NODE_EXTRA_CA_CERTS=deploy/certs/russian_trusted_root_ca.pem node --env-file=.env scripts/agent_live_eval.js --model qwen|giga-ultra|giga-max|giga-pro [--only Q01,Q02] [--par 3] [--out file.json] [--no-judge]
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
const GOLD = path.join(__dirname, '..', 'knowledge', 'clinrecs', 'eval', 'gold.json');
const MODELS = {
  qwen: process.env.QWEN_MODEL || 'qwen/qwen3.8-flash',
  'giga-max': 'GigaChat-2-Max',
  'giga-pro': 'GigaChat-2-Pro',
  'giga-ultra': 'GigaChat-3-Ultra',
};
const JUDGE_ID = 'z-ai/glm-5.3-flash';
const JUDGE_SYSTEM = [
  'Ты проверяешь, содержит ли ответ врачу заданные сведения. Тебе дают вопрос, ответ и пронумерованный список сведений (фактов).',
  'Для каждого факта реши, утверждает ли ответ его по смыслу (формулировка может отличаться; числа, дозы, сроки и условия должны совпадать):',
  '— "yes": факт утверждается полностью; — "partial": названа только часть факта или пропущено существенное условие, число, оговорка;',
  '— "contradicted": в ответе сказано обратное; — "no": факта в ответе нет.',
  'Не оценивай, правилен ли факт, и не используй знания вне ответа.',
  'Ответ — ТОЛЬКО валидный JSON без markdown: {"facts": [{"n": 1, "verdict": "yes|partial|contradicted|no"}]}',
].join('\n');

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

async function judge(question, answer, facts) {
  const user = `Вопрос: ${question}\n\nОтвет:\n${answer}\n\nФакты:\n${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: JUDGE_ID,
      temperature: 0,
      max_tokens: 6000,
      messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(240000),
  });
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content;
  if (!r.ok || !text) throw new Error(`judge ${r.status}`);
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  const v = JSON.parse(text.slice(a, b + 1));
  return facts.map((_, i) => (v.facts.find((x) => Number(x.n) === i + 1) || {}).verdict || 'no');
}

async function main() {
  const key = arg('model', 'qwen');
  const ident = MODELS[key];
  if (!ident) throw new Error(`неизвестная модель ${key}`);
  const only = arg('only', '') ? new Set(arg('only').split(',')) : null;
  const par = Number(arg('par', 3));
  const noJudge = process.argv.includes('--no-judge');
  const knowledge = getKnowledge();
  if (!knowledge.enabled) throw new Error('нужен KNOWLEDGE_DATABASE_URL');
  // Без сертификата Минцифры (NODE_EXTRA_CA_CERTS задаётся только в окружении запуска, --env-file не помогает)
  // векторизация запроса падает, и поиск молча становится лексическим: прогон не имеет смысла.
  const { searchClinrec } = require('../src/modules/knowledge/search_clinrec');
  const probe = await searchClinrec(knowledge.pool(), 'тревожное расстройство', { mode: 'hybrid', limit: 1, client: knowledge.embeddingClient() });
  if (probe.fallback) throw new Error(`гибридный поиск не работает (${probe.reason}); запусти с NODE_EXTRA_CA_CERTS=deploy/certs/russian_trusted_root_ca.pem`);
  const config = loadConfig();
  if (config.dataMode === 'real') throw new Error('прогон только при DATA_MODE=synthetic');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-live-'));
  const copy = path.join(tmp, 'tdr.sqlite3');
  const src = new Database(config.dbPath, { readonly: true });
  await src.backup(copy);
  src.close();
  const db = new Database(copy);
  // Рабочая настройка ai.timeouts (60 с на вызов) мала для агента с 40–70 тыс. токенов: в прогоне подменяем.
  const tmo = Number(arg('timeout', 120));
  const activeSetting = (k) => {
    if (k === 'ai.timeouts') {
      const row = db.prepare("SELECT * FROM setting_versions WHERE key=? AND status='active' ORDER BY version DESC LIMIT 1").get(k);
      return { version: 0, value: { ...(row ? JSON.parse(row.value_json) : {}), clinician_chat: tmo } };
    }
    const row = db.prepare("SELECT * FROM setting_versions WHERE key=? AND status='active' ORDER BY version DESC LIMIT 1").get(k);
    return row ? { version: row.version, value: JSON.parse(row.value_json) } : { value: null };
  };
  const registry = createRegistry({ db, config, now, activeSetting });
  registry.bootstrap(); // подхватывает новые версии промптов из prompts/ (v003 и далее)
  const pii = createPii({ db, config, ml: null });
  const gateway = createGateway({ db, config, now, registry, pii, settings: activeSetting });
  const model = db.prepare('SELECT id FROM ai_models WHERE model_ident = ?').get(ident);
  if (!model) throw new Error(`модели ${ident} нет в реестре`);
  const v = db.prepare("SELECT max(version) v FROM ai_binding_versions WHERE purpose='clinician_chat'").get().v || 0;
  db.prepare("UPDATE ai_binding_versions SET status='previous' WHERE purpose='clinician_chat' AND status='active'").run();
  db.prepare(
    "INSERT INTO ai_binding_versions(purpose, version, primary_model_id, fallback_model_id, status, comment) VALUES ('clinician_chat', ?, ?, NULL, 'active', 'живой прогон')",
  ).run(v + 1, model.id);
  registry.invalidate();
  const psy = db.prepare("SELECT id, role FROM users WHERE role='psychiatrist' ORDER BY id LIMIT 1").get();

  const questions = JSON.parse(fs.readFileSync(GOLD, 'utf8')).questions.filter(
    (q) => q.status === 'gold' && q.facts.length && (!only || only.has(q.id)),
  );
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < questions.length) {
      const q = questions[next++];
      const tools = await createClinrecTools({ knowledge, db, nextNo: null });
      const called = [];
      const wrapped = {
        ...tools,
        execute: async (name, args) => {
          const e = { name, args };
          called.push(e);
          e.result = await tools.execute(name, args);
          return e.result;
        },
      };
      const row = { id: q.id, type: q.type, behavior: q.expected_behavior, question: q.question, model: key };
      const t0 = Date.now();
      try {
        const out = await gateway.run({
          purpose: 'clinician_chat',
          user: { id: psy.id, role: psy.role },
          tools: wrapped,
          text: [tools.card, `Сообщение врача: ${q.question}`].filter(Boolean).join('\n'),
          history: [],
        });
        const text = String(out.text || '');
        const seen = norm(called.map((c) => c.result).join(' '));
        const reached = q.facts.map((f) =>
          (f.chunks || []).some((c) => c.quote && seen.includes(norm(c.quote).split(' ').slice(0, 10).join(' '))),
        );
        const cited = [...new Set([...text.matchAll(/\[(\d{1,3})\]/g)].map((x) => Number(x[1])))];
        const known = new Set(tools.sources().map((s) => s.n));
        Object.assign(row, {
          ok: true,
          text,
          steps: called.map((c) => c.name),
          args: called.map((c) => c.args),
          no_tools: called.length === 0,
          asked_back: called.length === 0 && /\?\s*$/.test(text.trim()),
          docs_ok: (q.docs || []).length ? called.some((c) => (q.docs || []).includes(c.args && c.args.clinrec_id)) : null,
          reached_facts: reached.filter(Boolean).length,
          n_facts: q.facts.length,
          bad_citations: cited.filter((n) => !known.has(n)),
          n_citations: cited.length,
          tokens_in: out.tokensIn ?? null,
          tokens_out: out.tokensOut ?? null,
          status: out.status,
          ms: Date.now() - t0,
        });
        if (!noJudge) {
          for (let attempt = 1; !row.verdicts; attempt += 1) {
            try {
              row.verdicts = await judge(q.question, text, q.facts.map((f) => f.fact));
            } catch (e) {
              if (attempt >= 3) throw e;
            }
          }
          row.yes = row.verdicts.filter((x) => x === 'yes').length;
          row.partial = row.verdicts.filter((x) => x === 'partial').length;
        }
      } catch (e) {
        Object.assign(row, { ok: false, error: String(e && (e.code || e.message)), steps: called.map((c) => c.name), args: called.map((c) => c.args), ms: Date.now() - t0 });
      }
      results.push(row);
      console.log(
        `${row.ok ? 'ok ' : 'ERR'} ${q.id} ${String(q.type).slice(0, 12).padEnd(12)} steps=${row.steps ? row.steps.length : '-'} ` +
          `reach=${row.reached_facts ?? '-'}/${row.n_facts ?? q.facts.length} yes=${row.yes ?? '-'} part=${row.partial ?? '-'} ` +
          `badcite=${row.bad_citations ? row.bad_citations.length : '-'} ${row.ms}ms${row.error ? ` ${row.error}` : ''}`,
      );
    }
  };
  await Promise.all(Array.from({ length: par }, worker));
  results.sort((a, b) => a.id.localeCompare(b.id));
  const outFile = arg('out', path.join(tmp, `live_${key}.json`));
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));

  const good = results.filter((r) => r.ok);
  const sum = (f) => good.reduce((a, r) => a + (f(r) || 0), 0);
  const facts = sum((r) => r.n_facts);
  console.log(`\nмодель ${key}: вопросов ${results.length}, ошибок ${results.length - good.length}`);
  console.log(`шагов в среднем ${(sum((r) => r.steps.length) / (good.length || 1)).toFixed(1)}, без инструментов ${good.filter((r) => r.no_tools).length}`);
  console.log(`факты: дошёл до эталона ${((100 * sum((r) => r.reached_facts)) / facts).toFixed(0)}%` +
    (noJudge ? '' : `, в ответе yes ${((100 * sum((r) => r.yes)) / facts).toFixed(0)}% (+partial ${((100 * sum((r) => r.partial)) / facts).toFixed(0)}%)`));
  console.log(`битые ссылки: ${sum((r) => r.bad_citations.length)}; токены вход/выход в среднем ${Math.round(sum((r) => r.tokens_in) / (good.length || 1))}/${Math.round(sum((r) => r.tokens_out) / (good.length || 1))}`);
  console.log(`результаты: ${outFile}`);
  db.close();
  await closeKnowledge();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
