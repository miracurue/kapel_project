'use strict';
// Бланк теста для печати: пустой, без баллов и ключей — специалист даёт его пациенту заполнить от руки,
// а ответы потом вносит в «Методики» → «Внести очный результат». Стили — /print.css, без встроенных скриптов (CSP).
const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

function question(q) {
  const choice = ['single', 'multi', 'multiple'].includes(q.type) && q.options.length;
  const body = choice
    ? `<ul class="opts">${q.options.map((o) => `<li><span class="box" aria-hidden="true"></span>${esc(o.label)}</li>`).join('')}</ul>`
    : '<div class="lines"><span></span><span></span></div>';
  const hint =
    q.type === 'multi' || q.type === 'multiple' ? '<p class="hint">Можно отметить несколько вариантов</p>' : '';
  return `<li class="q"><p class="qt">${esc(q.text)}</p>${hint}${body}</li>`;
}

function render({ title, preview }) {
  const qs = preview.questions || [];
  const columns =
    qs.length > 12 &&
    qs.every((q) => q.options.length && q.options.length <= 5 && q.options.length === qs[0].options.length);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)} — бланк</title><link rel="stylesheet" href="/print.css"></head><body>
<div class="bar no-print"><button type="button" data-print>Распечатать</button><a href="javascript:history.back()" data-back>Назад</a><span>Бланк без ответов — для заполнения вручную</span></div>
<main class="sheet${columns ? ' compact' : ''}"><h1>${esc(title)}</h1>
<div class="who"><p>Имя или номер: <span class="line"></span></p><p>Дата: <span class="line short"></span></p></div>
${preview.instruction ? `<p class="instr">${esc(preview.instruction)}</p>` : ''}${preview.question_title ? `<p class="instr"><b>${esc(preview.question_title)}</b></p>` : ''}
<ol class="qs">${qs.map(question).join('')}</ol>
<p class="foot">Бланк заполняется самостоятельно. Баллы и выводы специалист считает сам. Это не диагноз.</p></main>
<script src="/js/print_page.js" defer></script></body></html>`;
}

module.exports = { render };
