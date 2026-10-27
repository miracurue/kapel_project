#!/usr/bin/env node
'use strict';

/**
 * Оценка поиска агента по клинрекам на наборе knowledge/clinrecs/eval (этап 9 плана агента), без модели:
 * какую долю эталонных фактов (gold.json) закрывает инструмент search_clinrec (6 результатов с родителями/окнами)
 *   A — по всему корпусу, B — с фильтром по нужной рекомендации (clinrec_id, как если модель выбрала её верно),
 *   C — B плюс чтение целиком разделов, где лежат найденные фрагменты (верхняя граница схемы «поиск + чтение раздела»).
 * Факт найден, если хотя бы один его эталонный чанк попал в контекст. Это проверка поиска, а не ответа: какие разделы
 * на самом деле дочитает модель, покажет только прогон с GigaChat.
 *
 *   node --env-file=.env scripts/agent_eval.js [--k 6] [--mode hybrid|lexical] [--json out.json]
 * Нужен KNOWLEDGE_DATABASE_URL; для hybrid — ключ эмбеддингов GigaChat (иначе поиск сам перейдёт на lexical).
 */

const fs = require('node:fs');
const path = require('node:path');
const { getKnowledge, closeKnowledge } = require('../src/modules/knowledge/service');
const { searchClinrec } = require('../src/modules/knowledge/search_clinrec');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const K = Number(arg('k', 6));
const MODE = arg('mode', 'hybrid');
const GOLD = path.join(__dirname, '..', 'knowledge', 'clinrecs', 'eval', 'gold.json');

async function main() {
  const knowledge = getKnowledge();
  if (!knowledge.enabled) throw new Error('нужен KNOWLEDGE_DATABASE_URL');
  const pool = knowledge.pool();
  const gold = JSON.parse(fs.readFileSync(GOLD, 'utf8')).questions.filter((q) => q.status === 'gold' && q.facts.length);
  const parentOf = new Map(
    (await pool.query('SELECT id, parent_id, section_id FROM clinrec.chunks')).rows.map((r) => [r.id, r]),
  );
  const sectionsOf = async (docId, sectionIds) => {
    if (!sectionIds.length) return new Set();
    const { rows } = await pool.query(
      `WITH RECURSIVE t AS (SELECT id FROM clinrec.sections WHERE id = ANY($1::text[]) AND document_id = $2
         UNION ALL SELECT s.id FROM clinrec.sections s JOIN t ON s.parent_id = t.id)
       SELECT c.id FROM clinrec.chunks c JOIN t ON t.id = c.section_id OR c.metadata->'section_ids' ? t.id`,
      [sectionIds, docId],
    );
    return new Set(rows.map((r) => r.id));
  };

  const covered = (results) => {
    const ids = new Set();
    const parents = new Set();
    for (const r of results) {
      for (const m of r.matched_chunks || []) ids.add(m.chunk_id);
      for (const p of r.parts || []) {
        if (p.chunk_id) ids.add(p.chunk_id);
        if (p.parent_id) parents.add(p.parent_id);
      }
    }
    for (const [id, c] of parentOf) if (c.parent_id && parents.has(c.parent_id)) ids.add(id);
    return ids;
  };
  const score = (q, ids) => {
    let found = 0;
    for (const f of q.facts) if (f.chunks.some((c) => ids.has(`${c.doc}.c.${c.chunk}`))) found += 1;
    return found;
  };

  const rows = [];
  let usedMode = MODE;
  for (const q of gold) {
    const run = async (scope) => {
      try {
        return await searchClinrec(pool, q.question, {
          mode: MODE,
          limit: K,
          client: MODE === 'lexical' ? undefined : knowledge.embeddingClient(),
          ...(scope ? { scope: { documentIds: scope } } : {}),
        });
      } catch {
        usedMode = 'lexical';
        return searchClinrec(pool, q.question, {
          mode: 'lexical',
          limit: K,
          ...(scope ? { scope: { documentIds: scope } } : {}),
        });
      }
    };
    const a = await run(null);
    if (a.fallback) usedMode = 'lexical';
    const b = await run(q.docs);
    const idsB = covered(b.results);
    const secIds = [...new Set(b.results.map((r) => r.section_id).filter(Boolean))];
    const idsC = new Set([...idsB, ...(await sectionsOf(q.docs[0], secIds))]);
    rows.push({
      id: q.id,
      type: q.type,
      facts: q.facts.length,
      a: score(q, covered(a.results)),
      b: score(q, idsB),
      c: score(q, idsC),
    });
  }
  const total = rows.reduce((s, r) => s + r.facts, 0);
  const pct = (key) => Math.round((1000 * rows.reduce((s, r) => s + r[key], 0)) / total) / 10;
  const report = {
    schema: 'agent-eval/1',
    mode: usedMode,
    k: K,
    questions: rows.length,
    facts: total,
    recall: { all_corpus: pct('a'), known_clinrec: pct('b'), known_clinrec_plus_sections: pct('c') },
    rows,
  };
  console.log(
    `поиск ${usedMode}, k=${K}, вопросов ${rows.length}, фактов ${total}\n` +
      `A весь корпус: ${report.recall.all_corpus}%\nB своя рекомендация: ${report.recall.known_clinrec}%\n` +
      `C своя рекомендация + чтение найденных разделов: ${report.recall.known_clinrec_plus_sections}%`,
  );
  const out = arg('json', null);
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
  await closeKnowledge();
}

main().catch(async (e) => {
  console.error(`ошибка: ${e.message}`);
  await closeKnowledge();
  process.exit(1);
});
