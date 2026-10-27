'use strict';

/**
 * Аналитика рассказом: выбор диагноза → кто они → кто их ведёт → чем живут врачи → что назначают →
 * что реально происходит → что получается → какова цена. Один отрисовщик для администратора
 * (/admin?tab=analytics) и специалиста (/work?tab=analytics). Данные приходят уже без идентификаторов и с подавлением
 * малых групп (src/modules/insights); здесь только рисуем. Графики — свой SVG, цвета в CSS (CSP без style=).
 */
(function () {
  const esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const fmt = (n) => (n === null || n === undefined ? '—' : String(n).replace('.', ','));
  const HIDDEN = '<span class="ins-hidden">мало данных</span>';
  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const monthName = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
  const CAT = { regular: 'regular', partial: 'partial', rare: 'rare', no_marks: 'none', not_active: 'none' };
  const CAT_LABEL = {
    regular: 'регулярно',
    partial: 'частично',
    rare: 'редко',
    no_marks: 'отметок нет',
    not_active: 'не действует',
  };
  const PERIODS = [
    [90, '3 месяца'],
    [180, '6 месяцев'],
    [365, '12 месяцев'],
  ];

  /** Горизонтальная полоса: ширина — атрибут SVG, а не style (CSP). */
  function bar(value, max, tone) {
    const w = max > 0 && value !== null ? Math.max(1.5, Math.min(100, (value / max) * 100)) : 0;
    return `<svg class="ins-bar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="ins-track" width="100" height="8"/><rect class="ins-fill ${tone || ''}" width="${w.toFixed(1)}" height="8"/></svg>`;
  }
  function row(label, value, max, valueHtml, opts = {}) {
    const hidden = value === null || value === undefined;
    return `<div class="ins-row${hidden ? ' is-hidden' : ''}"><span class="ins-l">${esc(label)}${opts.sub ? `<small>${esc(opts.sub)}</small>` : ''}</span>${hidden ? '' : bar(value, max, opts.tone)}<span class="ins-v">${hidden ? HIDDEN : valueHtml}</span></div>`;
  }
  const maxOf = (list, key) => Math.max(0, ...list.map((x) => x[key] ?? 0));
  // Скрытые малые группы сворачиваются в одну строку, чтобы список не пестрел «мало данных».
  const rows = (list, key, label, valueFn, optsFn) => {
    const shown = list.filter((x) => x[key] !== null && x[key] !== undefined);
    const hidden = list.length - shown.length;
    const max = maxOf(shown, key);
    return (
      shown.map((x) => row(label(x), x[key], max, valueFn(x), optsFn ? optsFn(x) : {})).join('') +
      (hidden ? `<p class="ins-empty">Ещё ${hidden} — мало данных, скрыто.</p>` : '')
    );
  };
  const how = (s) => `<details class="ins-how"><summary>Как считали</summary><p>${esc(s.how)}</p></details>`;
  const block = (title, inner) => `<div class="ins-block"><h4>${esc(title)}</h4>${inner}</div>`;
  const empty = (text) => `<p class="ins-empty">${esc(text)}</p>`;

  function who(s) {
    if (s.suppressed) return '';
    const cols = s.dynamics;
    const max = Math.max(1, ...cols.map((c) => c.n_patients ?? 0));
    const W = 56;
    const H = 96;
    const step = cols.length > 8 ? 2 : 1;
    const words = cols
      .map((c) => `${monthName(c.month)} — ${c.n_patients === null ? 'мало данных' : c.n_patients}`)
      .join('; ');
    const svg = cols.length
      ? `<svg class="ins-cols" width="${cols.length * W}" height="${H + 44}" viewBox="0 0 ${cols.length * W} ${H + 44}" role="img" aria-label="Новые пациенты по месяцам: ${esc(words)}"><line class="ins-grid" x1="0" x2="${cols.length * W}" y1="${20 + H}" y2="${20 + H}"/>${cols
          .map((c, i) => {
            const h = c.n_patients === null ? 0 : Math.max(2, (c.n_patients / max) * H);
            const label =
              i % step === 0
                ? `<text class="ins-t2" x="${i * W + W / 2}" y="${H + 40}" text-anchor="middle">${esc(monthName(c.month))}</text>`
                : '';
            return `<g><title>${esc(monthName(c.month))}: ${c.n_patients === null ? 'мало данных' : `${c.n_patients} чел.`}</title>${
              c.n_patients === null
                ? `<rect class="ins-hole" x="${i * W + 10}" y="${20 + H - 16}" width="${W - 20}" height="16"/>`
                : `<rect class="ins-fill" x="${i * W + 10}" y="${20 + H - h}" width="${W - 20}" height="${h.toFixed(1)}" rx="4"/>${cols.length <= 8 ? `<text class="ins-t" x="${i * W + W / 2}" y="${20 + H - h - 6}" text-anchor="middle">${c.n_patients}</text>` : ''}`
            }${label}</g>`;
          })
          .join('')}</svg>`
      : '';
    return `<div class="ins-big"><b>${fmt(s.n_patients)}</b><span>пациентов</span></div>${block('Начали наблюдение по месяцам', svg || empty('Нет данных по месяцам.'))}`;
  }

  function clinicians(s) {
    const set = (list, title) =>
      list.length
        ? block(
            title,
            rows(
              list,
              'n_patients',
              (x) => x.label,
              (x) => `${fmt(x.n_patients)} <small>пац. · ${fmt(x.n_doctors)} спец.</small>`,
            ),
          )
        : '';
    return (
      (s.n_doctors !== null
        ? `<p class="ins-note">Специалистов в выборке: <b>${fmt(s.n_doctors)}</b>${s.profile_share !== null ? `, профиль заполнили ${s.profile_share}%` : ''}.</p>`
        : '') +
      set(s.specialties, 'Специальности') +
      set(s.org_kinds, 'Тип организации') +
      set(s.regions, 'Регионы') +
      set(s.organizations, 'Организации')
    );
  }

  function doctors(s) {
    const list = (items, title) =>
      block(
        title,
        items.length
          ? rows(
              items,
              'n_doctors',
              (x) => x.title,
              (x) => `${fmt(x.n_doctors)} <small>спец. · ${fmt(x.share)}%</small>`,
            )
          : empty('Названия появятся, когда их укажут не меньше трёх специалистов.'),
      );
    return (
      (s.n_doctors_declared !== null
        ? `<p class="ins-note">Заполнили профиль: <b>${fmt(s.n_doctors_declared)}</b> специалистов.</p>`
        : '') +
      list(s.journals, 'Журналы') +
      list(s.conferences, 'Конференции')
    );
  }

  function prescribed(s) {
    if (s.suppressed) return '';
    const dur = s.duration;
    const durMax = maxOf(dur, 'n');
    return (
      `<div class="ins-big"><b>${fmt(s.share_with_plan ?? s.n_with_plan)}${s.share_with_plan !== null ? '%' : ''}</b><span>${s.share_with_plan !== null ? 'пациентов с назначением' : 'пациентов с назначением'}</span></div>` +
      block(
        'Группы препаратов',
        rows(
          s.by_group,
          'n_patients',
          (x) => x.label,
          (x) => `${fmt(x.n_patients)} <small>пац.${x.share !== null ? ` · ${x.share}%` : ''}</small>`,
        ),
      ) +
      block(
        'Препараты (МНН)',
        rows(
          s.by_inn,
          'n_patients',
          (x) => x.label,
          (x) => `${fmt(x.n_patients)} <small>пац.${x.share !== null ? ` · ${x.share}%` : ''}</small>`,
          (x) => ({ sub: x.group }),
        ),
      ) +
      block(
        `Срок назначения${s.duration_median_days !== null ? ` · медиана ${Math.round(s.duration_median_days)} дн.` : ''}`,
        dur
          .map((d) =>
            row(d.label, d.n, durMax, `${fmt(d.n)} <small>назнач.</small>`, {
              tone: d.key === 'none' ? 'neutral' : '',
            }),
          )
          .join(''),
      )
    );
  }

  function reality(s) {
    if (s.suppressed) return '';
    return (
      block(
        'От назначения до приёма',
        s.funnel
          .map((f) =>
            row(
              f.label,
              f.n_patients === null ? null : f.share,
              100,
              `${fmt(f.share)}% <small>${fmt(f.n_patients)} чел.</small>`,
            ),
          )
          .join(''),
      ) +
      block(
        'Как отмечают приём',
        s.adherence
          .filter((a) => a.key !== 'not_active' || a.n_patients)
          .map((a) =>
            row(a.label, a.n_patients, maxOf(s.adherence, 'n_patients'), `${fmt(a.n_patients)} <small>чел.</small>`, {
              tone: `c-${CAT[a.key]}`,
            }),
          )
          .join(''),
      ) +
      (s.purchases.length
        ? block(
            'Покупки по препаратам',
            rows(
              s.purchases,
              'n_patients',
              (x) => x.label,
              (x) =>
                `${fmt(x.n_patients)} <small>чел.${x.share_of_prescribed !== null ? ` · ${x.share_of_prescribed}% от назначенных` : ''}</small>`,
            ),
          )
        : '')
    );
  }

  function curve(m) {
    const W = 420;
    const H = 150;
    const x = (d) => 36 + (d / 84) * (W - 120);
    const y = (p) => 12 + (1 - p / 100) * (H - 36);
    const pts = [[0, 0], ...m.curve.map((c) => [c.day, c.share])];
    const last = pts[pts.length - 1];
    const words = m.curve.map((c) => `к ${c.day} дн. — ${c.share}%`).join('; ');
    return `<svg class="ins-curve" width="${W}" height="${H + 14}" viewBox="0 0 ${W} ${H + 14}" role="img" aria-label="Накопленная доля улучшившихся, ${esc(m.label)}: ${esc(words)}">
      <rect class="ins-band" x="36" width="${W - 120}" y="${y(50)}" height="${y(0) - y(50)}"/>
      ${[0, 50, 100].map((p) => `<line class="ins-grid" x1="36" x2="${W - 84}" y1="${y(p)}" y2="${y(p)}"/><text class="ins-t2" x="30" y="${y(p) + 4}" text-anchor="end">${p}%</text>`).join('')}
      ${[0, 28, 56, 84].map((d) => `<text class="ins-t2" x="${x(d)}" y="${H + 6}" text-anchor="middle">${d} дн.</text>`).join('')}
      <polyline class="ins-line" points="${pts.map(([d, p]) => `${x(d).toFixed(1)},${y(p).toFixed(1)}`).join(' ')}"/>
      ${pts
        .slice(1)
        .map(
          ([d, p]) =>
            `<circle class="ins-dot" cx="${x(d).toFixed(1)}" cy="${y(p).toFixed(1)}" r="4"><title>${d} дн.: ${p}%</title></circle>`,
        )
        .join('')}
      <text class="ins-t ins-lab" x="${x(last[0]).toFixed(1)}" y="${(y(last[1]) - 10).toFixed(1)}" text-anchor="end">улучшились</text>
    </svg>`;
  }
  function outcomes(s) {
    return s.measures
      .map((m) =>
        block(
          m.label,
          m.suppressed
            ? empty(
                'Данных недостаточно: пациентов с повторным измерением слишком мало. Цифры появятся, когда повторные измерения будут не меньше чем у 10 пациентов, обычно через 4–8 недель наблюдения.',
              )
            : `<div class="ins-meas"><div class="ins-kpis"><div><b>${fmt(m.n_patients)}</b><small>в расчёте</small></div><div><b>${fmt(m.share_improved)}%</b><small>достигли улучшения</small></div><div><b${m.median_reached ? '' : ' class="is-text"'}>${m.median_reached ? `${m.median_days} дн.` : 'не достигнута'}</b><small>медиана времени</small></div></div>${curve(m)}<p class="ins-cap">Накопленная доля улучшившихся. К 2 неделям ${m.share_by[14]}%, к 4 неделям ${m.share_by[28]}%, к 8 неделям ${m.share_by[56]}%. Улучшение: ${esc(m.cut_text)}.</p></div>`,
        ),
      )
      .join('');
  }

  function cost(s) {
    if (s.suppressed) return '';
    const sev = s.severity;
    return (
      `<div class="ins-big"><b>${fmt(s.n_reporters)}</b><span>${s.n_reports !== null ? `сообщили (${s.n_reports} сообщ.)` : 'сообщили'}</span></div>` +
      block(
        'Какие именно',
        rows(
          s.complaints,
          'n_patients',
          (x) => x.label,
          (x) =>
            `${fmt(x.n_patients)} <small>чел.${x.share_of_reporters !== null ? ` · ${x.share_of_reporters}%` : ''}</small>`,
        ),
      ) +
      block(
        'Насколько мешало',
        sev
          .map((x) => row(x.label, x.n_reports, maxOf(sev, 'n_reports'), `${fmt(x.n_reports)} <small>сообщ.</small>`))
          .join(''),
      ) +
      (s.by_inn.length
        ? block(
            'По препаратам, которые указали',
            rows(
              s.by_inn,
              'n_patients',
              (x) => x.label,
              (x) => `${fmt(x.n_patients)} <small>чел.</small>`,
            ),
          )
        : '')
    );
  }

  const RENDER = { who, clinicians, doctors, prescribed, reality, outcomes, cost };

  function patientsTable(report) {
    const list = report.patients || [];
    if (!list.length) return '';
    const tests = (p) =>
      p.tests.length ? p.tests.map((t) => `${esc(t.instrument)} ${t.first} → <b>${t.last}</b>`).join('<br>') : '—';
    const mood = (p) => (p.mood ? `${fmt(p.mood.first)} → <b>${fmt(p.mood.last)}</b>` : '—');
    return `<section class="vcard ins-card ins-wide"><h3>Ваши пациенты по отдельности</h3><div class="ins-scroll"><table class="vtable tbl--dense"><thead><tr><th>Пациент</th><th>Тесты</th><th>Самочувствие</th><th>Приём</th><th>Побочные</th><th>Назначено</th></tr></thead><tbody>${list
      .map(
        (p) =>
          `<tr><td><a href="/work/patients/${p.id}">${esc(p.name)}</a></td><td>${tests(p)}</td><td>${mood(p)}</td><td>${p.adherence ? esc(CAT_LABEL[p.adherence.category]) + (p.adherence.ratio !== null ? ` · ${p.adherence.ratio}%` : '') : '—'}${p.bought ? ' · купил(а)' : ''}</td><td>${p.ae_reports || '—'}</td><td>${p.drugs.length ? esc(p.drugs.join(', ')) : '—'}</td></tr>`,
      )
      .join(
        '',
      )}</tbody></table></div><p class="muted small">Тесты — первый и последний результат онлайн, самочувствие — среднее первых и последних пяти записей. Показаны только данные, которыми пациент делится с вами.</p></section>`;
  }

  function render(root, report, state) {
    const own = report.scope === 'own';
    const dxs = report.diagnosis.options;
    const chips = [
      { code: 'all', label: 'Все диагнозы', n_patients: undefined },
      ...dxs.filter((d) => !(own && d.n_patients === 0)),
    ]
      .map(
        (d) =>
          `<button type="button" class="choice${d.code === report.diagnosis.selected.code ? ' on' : ''}" data-dx="${esc(d.code)}"${d.suppressed ? ' disabled' : ''}>${esc(d.label)}${d.n_patients != null ? ` <small>${d.n_patients}</small>` : d.suppressed ? ' <small>мало данных</small>' : ''}</button>`,
      )
      .join('');
    const periods = PERIODS.map(
      ([days, label]) =>
        `<button type="button" class="pill${days === state.days ? ' on' : ''}" data-days="${days}" aria-pressed="${days === state.days}">${label}</button>`,
    ).join('');
    const cards = report.sections
      .map((s, i) => {
        const inner = (RENDER[s.key] || (() => ''))(s);
        const badge =
          s.status === 'hidden'
            ? '<span class="st-pill warn"><svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-warning"/></svg> данных недостаточно</span>'
            : s.status === 'low'
              ? '<span class="st-pill"><svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-info"/></svg> мало наблюдений</span>'
              : '<span class="st-pill"><svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-info"/></svg> предварительно</span>';
        return `<section class="vcard ins-card" data-step="${s.key}"><div class="ins-step"><span class="ins-no">${i + 1}</span><h3 class="ins-title">${esc(s.title)}</h3>${badge}</div><p class="ins-headline">${esc(s.headline)}</p>${inner}${how(s)}</section>`;
      })
      .join('');
    root.innerHTML =
      `<div class="ins-top ins-wide"><div class="ins-filters" role="group" aria-label="Диагноз">${chips}</div><div class="seg seg--sm ins-periods" role="group" aria-label="Период">${periods}</div></div>` +
      `<section class="vcard ins-card ins-summary ins-wide"><h3>${own ? 'Коротко о ваших пациентах' : 'Главное для заказчика'}</h3>${
        report.summary.length
          ? `<ul>${report.summary.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`
          : empty(own ? 'Пока нет данных для выводов.' : 'Данных пока недостаточно для выводов.')
      }<p class="muted small">${esc(report.diagnosis.selected.label)}, период ${esc(report.period.from)} — ${esc(report.period.to)}. ${esc(report.disclaimer)}</p><a class="btn sm" data-ins-csv data-testid="msg.analytics.export.csv_insights" href="/api/v1/analytics/export?section=insights&dx=${encodeURIComponent(report.diagnosis.selected.code)}&from=${report.period.from}&to=${report.period.to}" download>${esc(tx('msg.analytics.export.csv_insights', 'Скачать CSV'))}</a></section>` +
      cards +
      (own
        ? patientsTable(report) +
          '<p class="footnote left ins-wide">Это не рейтинг пациентов и не оценка вашей работы.</p>'
        : '<p class="footnote left ins-wide">Только агрегаты: групп меньше порога нет, идентификаторов пациентов и специалистов нет.</p>');
  }

  // Тексты из locales/ru.json (общий словарь страниц); без него кнопка получает запасную подпись.
  let TX = {};
  const tx = (key, fallback) => TX[key] || fallback || key;

  async function mount(root, opts) {
    if (!Object.keys(TX).length) {
      try {
        const r = await fetch('/assets/ru.json');
        if (r.ok) TX = await r.json();
      } catch (_) {
        TX = {};
      }
    }
    const state = { dx: opts.dx || 'all', days: 180 };
    root.classList.add('ins-root');
    if (root.parentElement) root.parentElement.classList.add('ins-host');
    async function load() {
      root.innerHTML = '<p class="muted ins-wide">Считаю…</p>';
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - (state.days - 1) * 86400000).toISOString().slice(0, 10);
      try {
        const r = await fetch(`${opts.url}?dx=${encodeURIComponent(state.dx)}&from=${from}&to=${to}`, {
          credentials: 'same-origin',
        });
        if (!r.ok) throw new Error(String(r.status));
        const report = await r.json();
        render(root, report, state);
      } catch (_) {
        root.innerHTML = '<p class="muted ins-wide">Не получилось загрузить аналитику. Обновите страницу.</p>';
      }
    }
    root.addEventListener('click', (e) => {
      const dx = e.target.closest('[data-dx]');
      const days = e.target.closest('[data-days]');
      if (dx && !dx.disabled) state.dx = dx.dataset.dx;
      else if (days) state.days = Number(days.dataset.days);
      else return;
      load();
    });
    await load();
  }

  // Диагноз пациента в шапке карточки: необязателен, ставит только психиатр; нужен для аналитики по диагнозу.
  async function diagnosisPicker() {
    const card = document.getElementById('v2-card');
    const host = document.querySelector('[data-pstatus]');
    const role = document.body.dataset.role;
    if (!card || !host || (role !== 'R-03' && role !== 'R-04')) return;
    const id = card.dataset.patientId;
    let r;
    try {
      const res = await fetch(`/api/v1/patients/${id}/diagnosis`, { credentials: 'same-origin' });
      if (!res.ok) return;
      r = await res.json();
    } catch (_) {
      return;
    }
    const canSet = role === 'R-03';
    const cur = r.current && r.current.code;
    if (!canSet && !r.current) return;
    const wrap = document.createElement('div');
    wrap.className = 'dx-pick';
    wrap.innerHTML = canSet
      ? `<label>Диагноз (необязательно) <select data-dx-pick><option value="">не указан</option>${r.options
          .map(
            (o) =>
              `<option value="${esc(o.code)}"${o.code === cur ? ' selected' : ''}>${esc(o.code)} ${esc(o.label)}</option>`,
          )
          .join('')}</select></label><small data-dx-out aria-live="polite"></small>`
      : `Диагноз: ${esc(r.current.code)} ${esc(r.current.label)}`;
    host.after(wrap);
    const sel = wrap.querySelector('[data-dx-pick]');
    if (!sel) return;
    sel.addEventListener('change', async () => {
      const out = wrap.querySelector('[data-dx-out]');
      try {
        const token = (await (await fetch('/api/v1/csrf')).json()).token;
        const res = await fetch(`/api/v1/patients/${id}/diagnosis`, {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': token,
            'idempotency-key': crypto.randomUUID(),
          },
          body: JSON.stringify({ code: sel.value || null }),
        });
        out.textContent = res.ok ? 'сохранено' : 'не получилось сохранить';
      } catch (_) {
        out.textContent = 'не получилось сохранить';
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', diagnosisPicker);
  else diagnosisPicker();

  window.CCInsights = { mount };
})();
