'use strict';

/**
 * Быстрая заметка: свободный текст -> структурированный ЧЕРНОВИК (REQ-CLN-016). Всё локально и шаблонно: текст врача
 * только раскладывается по разделам по явным меткам («Жалобы:», «План:» ...) и ключевым словам; ничего не сочиняется,
 * не оценивается и не интерпретируется. Что не отнесено — остаётся в «Прочее». Это не ИИ-модель.
 */

const SECTIONS = [
  { key: 'complaints', label: 'Жалобы и состояние со слов пациента', marks: ['жалобы', 'ж'], words: ['жалуется', 'жалобы', 'настроение', 'тревог', 'сон', 'засып', 'аппетит', 'устал', 'самочувств'] },
  { key: 'observed', label: 'Наблюдения на приёме', marks: ['наблюдения', 'объективно', 'о'], words: ['контакт', 'речь', 'внешне', 'мимика', 'отмечается', 'наблюда'] },
  { key: 'dynamics', label: 'Динамика', marks: ['динамика', 'д'], words: ['динамик', 'лучше', 'хуже', 'без изменений', 'улучшени', 'ухудшени'] },
  { key: 'therapy', label: 'Терапия и приём препаратов (со слов врача)', marks: ['терапия', 'лечение', 'т'], words: ['препарат', 'доз', ' мг', 'приём', 'принимает', 'побочн'] },
  { key: 'plan', label: 'План', marks: ['план', 'рекомендации', 'п'], words: ['план', 'рекоменд', 'повторн', 'назначить', 'явка', 'контроль', 'следующий приём'] },
];
const OTHER = { key: 'other', label: 'Прочее (не отнесено к разделам)' };
const MAX_CHARS = 8000;
const LABEL = 'ЧЕРНОВИК · разложено по разделам локальным шаблоном, ИИ не использовался; проверьте и отредактируйте.';

function structure(raw) {
  const text = String(raw || '').replace(/\r\n?/g, '\n').slice(0, MAX_CHARS);
  const buckets = Object.fromEntries([...SECTIONS, OTHER].map((s) => [s.key, []]));
  // разбиение на фрагменты: строки; длинные строки — по предложениям
  const pieces = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/^[^:]{1,20}:/.test(t)) { pieces.push(t); continue; }
    for (const s of t.split(/(?<=[.!?])\s+/)) if (s.trim()) pieces.push(s.trim());
  }
  let current = null;
  for (const p of pieces) {
    const m = /^([^:]{1,20}):\s*(.*)$/.exec(p);
    if (m) {
      const mark = m[1].trim().toLowerCase();
      const sec = SECTIONS.find((s) => s.marks.includes(mark));
      if (sec) { current = sec.key; if (m[2]) buckets[sec.key].push(m[2]); continue; }
    }
    const low = ` ${p.toLowerCase()}`;
    const sec = SECTIONS.find((s) => s.words.some((w) => low.includes(w)));
    buckets[sec ? sec.key : (current || OTHER.key)].push(p);
  }
  const sections = [...SECTIONS, OTHER].map((s) => ({ key: s.key, label: s.label, lines: buckets[s.key] })).filter((s) => s.lines.length);
  const draft = sections.map((s) => `${s.label}:\n${s.lines.map((l) => `- ${l}`).join('\n')}`).join('\n\n');
  return { sections, draft, label: LABEL, empty: sections.length === 0 };
}

module.exports = { structure, LABEL, MAX_CHARS };
