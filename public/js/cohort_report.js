'use strict';

/**
 * Отчёт по когорте из общей аналитики (src/modules/analytics): строки с определением и знаменателем,
 * скрытые малые группы показываются как «мало данных». Один отрисовщик для специалиста (/work?tab=analytics)
 * и администратора (/admin?tab=program). Данные приходят уже без идентификаторов и с подавлением.
 */
(function () {
  const esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const fmt = (n) => String(n).replace('.', ',');
  const row = (r) =>
    `<div class="crow${r.suppressed ? ' hidden' : ''}"><div class="grow"><b>${esc(r.label)}</b>${
      r.suppressed ? '' : `<small>${esc(r.definition)}</small>`
    }</div><div class="cval">${
      r.suppressed
        ? '<span class="muted">мало данных</span>'
        : `<b>${fmt(r.value ?? '—')}</b> <small>${esc(r.unit || '')}</small><small>из ${r.denominator} · ${r.n_patients} чел.</small>`
    }</div></div>`;

  // Ссылка на CSV с теми же цифрами: обычный GET, без скрипта; подпись и ключ текста передаёт страница.
  const csvLink = (csv) =>
    csv && csv.url
      ? `<p><a class="btn sm" data-cohort-csv data-testid="${esc(csv.testid)}" href="${esc(csv.url)}" download>${esc(csv.label)}</a></p>`
      : '';

  function html(report, csv) {
    if (!report) return '<p class="muted">Цифры сейчас недоступны.</p>';
    const note = report.suppressed
      ? `<p class="sub" data-testid="msg.analytics.small">Недостаточно данных: в группе меньше ${report.min_group} человек, цифры скрыты, чтобы нельзя было узнать пациента.</p>`
      : '';
    const weeks = (report.weekly || []).filter((w) => !w.suppressed);
    return (
      note +
      `<div class="clist">${(report.rows || []).map(row).join('')}</div>` +
      (weeks.length
        ? `<p class="dlabel">По неделям</p><div class="clist">${weeks
            .map(
              (w) =>
                `<div class="crow"><div class="grow"><b>Неделя с ${esc(w.week)}</b></div><div class="cval"><b>${fmt(w.mood_mean ?? '—')}</b> <small>настроение из 5</small><small>${w.n_patients} чел.</small></div></div>`,
            )
            .join('')}</div>`
        : '') +
      `<p class="muted small">${esc(report.scope_label || '')}, период ${esc(report.period.from)} — ${esc(report.period.to)}${
        report.updated_at ? `, обновлено ${esc(String(report.updated_at).slice(0, 10))}` : ''
      }. Это не рейтинг пациентов и специалистов.</p>` +
      csvLink(csv)
    );
  }
  window.CCCohort = { html };
})();
