'use strict';

/**
 * Обзор администратора рассказом (/admin?tab=dashboard): вводная строка, плитки с изменением к прошлому периоду,
 * затем главы — вывод словами и под ним графики. Данные приходят готовыми и уже без идентификаторов
 * (src/modules/admin/dashboard); здесь только рисуем. Графики — свой SVG, размеры задаются атрибутами,
 * цвета — классами из public/css/dashboard.css (CSP запрещает style=). У каждого рисунка role="img" и описание словами.
 */
(function () {
  const esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const PERIODS = [
    [30, '30 дней'],
    [90, '3 месяца'],
    [180, '6 месяцев'],
    [365, 'Год'],
  ];
  const HIDDEN = '<span class="dsh-hidden">мало данных</span>';
  const nf = new Intl.NumberFormat('ru-RU');
  const fmt = (v) => {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'string') return v;
    return Number.isInteger(v) ? nf.format(v) : nf.format(Math.round(v * 100) / 100);
  };
  const dayLabel = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
  const monthLabel = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
  const pointLabel = (l) => (/^\d{4}-\d{2}-\d{2}$/.test(l) ? dayLabel(l) : /^\d{4}-\d{2}$/.test(l) ? monthLabel(l) : l);
  // Числа в выводах выделяются жирным, чтобы глаз цеплялся за главное.
  const emph = (text) => esc(text).replace(/(\d[\d ]*(?:,\d+)?\s?%?)/g, '<b>$1</b>');

  // ---------- блоки ----------
  function tiles(b) {
    return `<div class="dsh-tiles">${b.items
      .map(
        (t) =>
          `<div class="dsh-tile${t.tone ? ` is-${t.tone}` : ''}"><span class="dsh-num">${t.value === null || t.value === undefined ? '—' : esc(fmt(t.value))}${t.unit ? `<small> ${esc(t.unit)}</small>` : ''}</span><span class="dsh-cap">${esc(t.label)}</span>${t.hint ? `<span class="dsh-hint">${esc(t.hint)}</span>` : t.value === null ? `<span class="dsh-hint">${'мало данных'}</span>` : ''}${t.link ? `<a class="dsh-more" href="${esc(t.link)}">Открыть</a>` : ''}</div>`,
      )
      .join('')}</div>`;
  }

  /** Горизонтальные полосы; ширина — атрибут rect, поэтому CSP не мешает. */
  function bars(b) {
    const shown = b.items.filter((i) => i.value !== null && i.value !== undefined);
    if (!b.items.length) return `<p class="dsh-empty">Пока нечего показывать.</p>`;
    const max = Math.max(0, ...shown.map((i) => i.value));
    // Несколько скрытых строк сворачиваются в одну, чтобы список не пестрел «мало данных».
    const hiddenN = b.items.length - shown.length;
    const collapse = hiddenN >= 2 && !b.keepHidden;
    const rows = (collapse ? shown : b.items)
      .map((i) => {
        const hidden = i.value === null || i.value === undefined;
        const w = hidden || max <= 0 ? 0 : Math.max(i.value > 0 ? 1.5 : 0, (i.value / max) * 100);
        const tone = i.tone ? ` t-${i.tone}` : '';
        return `<div class="dsh-row${hidden ? ' is-hidden' : ''}"><span class="dsh-l">${esc(i.label)}${i.extra ? `<small>${esc(i.extra)}</small>` : ''}</span>${
          hidden
            ? `<span class="dsh-v">${HIDDEN}</span>`
            : `<svg class="dsh-bar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="dsh-track" width="100" height="8"/><rect class="dsh-fill${tone}" width="${w.toFixed(1)}" height="8"/></svg><span class="dsh-v">${esc(fmt(i.value))}${i.people !== null && i.people !== undefined ? `<small>${esc(fmt(i.people))} чел.</small>` : ''}</span>`
        }</div>`;
      })
      .join('');
    const more = collapse ? `<p class="dsh-note">Ещё ${hiddenN} — мало данных, цифры скрыты.</p>` : '';
    return `<div class="dsh-rows">${rows}</div>${more}`;
  }

  /** Целое, разрезанное на доли: одна полоса и подписи. */
  function stack(b) {
    const parts = b.segments.filter((s) => s.value !== null && s.value > 0);
    const hiddenN = b.segments.filter((s) => s.value === null).length;
    let x = 0;
    const rects = parts
      .map((s) => {
        const w = Math.max(0.5, s.value);
        const r = `<rect class="dsh-seg t-${s.tone || 'mid'}" x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="14"><title>${esc(s.label)}: ${esc(fmt(s.value))}%</title></rect>`;
        x += s.value;
        return r;
      })
      .join('');
    const words = b.segments.map((s) => `${s.label} — ${s.value === null ? 'мало данных' : `${s.value}%`}`).join('; ');
    const legend = b.segments
      .map(
        (s) =>
          `<li><svg class="dsh-sw" viewBox="0 0 10 10" aria-hidden="true"><rect class="dsh-seg t-${s.tone || 'mid'}" width="10" height="10" rx="3"/></svg><span>${esc(s.label)}</span><b>${s.value === null ? HIDDEN : `${esc(fmt(s.value))}%`}</b></li>`,
      )
      .join('');
    return `<svg class="dsh-stack" viewBox="0 0 100 14" preserveAspectRatio="none" role="img" aria-label="${esc(`${b.title}: ${words}`)}"><rect class="dsh-track" width="100" height="14"/>${rects}</svg><ul class="dsh-legend">${legend}</ul>${hiddenN ? '<p class="dsh-note">Доли, где людей слишком мало, скрыты.</p>' : ''}`;
  }

  /** Воронка: каждый шаг — полоса от первого; рядом доля от предыдущего шага. */
  function funnel(b) {
    const first = b.steps.find((s) => s.value !== null && s.value !== undefined);
    const max = first ? first.value : 0;
    return `<ol class="dsh-funnel">${b.steps
      .map((s) => {
        const hidden = s.value === null || s.value === undefined;
        const w = hidden || !max ? 0 : Math.max(s.value > 0 ? 1.5 : 0, (s.value / max) * 100);
        const conv = !hidden && max > 0 ? Math.round((s.value / max) * 100) : null;
        return `<li><span class="dsh-l">${esc(s.label)}</span>${
          hidden
            ? `<span class="dsh-v">${HIDDEN}</span>`
            : `<svg class="dsh-bar dsh-bar--lg" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect class="dsh-track" width="100" height="10"/><rect class="dsh-fill" width="${w.toFixed(1)}" height="10"/></svg><span class="dsh-v">${esc(fmt(s.value))}${conv !== null ? `<small>${conv}% от первого шага</small>` : ''}</span>`
        }</li>`;
      })
      .join('')}</ol>`;
  }

  /** Ряд по времени: линия с заливкой или столбцы; малые группы — пустые кружки на оси, неполный период — штрих. */
  function series(b, wide) {
    const pts = b.points;
    if (!pts.length) return `<p class="dsh-empty">Пока нечего показывать.</p>`;
    if (pts.every((p) => p.value === 0)) return `<p class="dsh-empty">За период не было ни одного.</p>`;
    const W = wide ? 960 : 600;
    const H = wide ? 240 : 260;
    const L = 44;
    const R = 14;
    const T = 22;
    const B = 30;
    const plotW = W - L - R;
    const plotH = H - T - B;
    const vals = pts.map((p) => p.value).filter((v) => v !== null && v !== undefined);
    const lo = b.domain ? b.domain[0] : 0;
    let hi = b.domain ? b.domain[1] : Math.max(1, ...vals) * 1.1;
    if (!b.domain) {
      // «круглый» шаг сетки: 1, 2, 2.5, 5, 10 × степень десяти; три деления
      const raw = hi / 3;
      const mag = Math.pow(10, Math.floor(Math.log10(raw)));
      const stepNice = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw);
      hi = stepNice * 3;
    }
    if (hi === lo) hi = lo + 1;
    const columns = b.kind === 'columns';
    const step = plotW / pts.length;
    const xAt = (i) =>
      L + (columns ? step * i + step / 2 : pts.length === 1 ? plotW / 2 : (plotW / (pts.length - 1)) * i);
    const yAt = (v) => T + plotH - ((v - lo) / (hi - lo)) * plotH;
    const parts = b.domain ? (hi - lo <= 4 ? hi - lo : 4) : 3;
    const ticks = Array.from({ length: parts + 1 }, (_, k) => lo + ((hi - lo) / parts) * k);
    const grid = ticks
      .map(
        (v) =>
          `<line class="dsh-grid" x1="${L}" x2="${W - R}" y1="${yAt(v).toFixed(1)}" y2="${yAt(v).toFixed(1)}"/><text class="dsh-t2" x="${L - 6}" y="${(yAt(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmt(Math.round(v * 10) / 10))}</text>`,
      )
      .join('');
    const every = Math.max(1, Math.ceil(pts.length / 8));
    const labels = pts
      .map((p, i) =>
        i % every === 0 || i === pts.length - 1
          ? `<text class="dsh-t2" x="${xAt(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(pointLabel(p.label))}</text>`
          : '',
      )
      .join('');
    let body = '';
    const tip = (p) =>
      `${pointLabel(p.label)}${p.partial ? ' (период не закончен)' : ''}: ${p.value === null || p.value === undefined ? 'мало данных' : `${fmt(p.value)} ${b.unit || ''}`}`.trim();
    if (columns) {
      const bw = Math.min(40, step * 0.62);
      body = pts
        .map((p, i) => {
          const x = xAt(i) - bw / 2;
          if (p.value === null || p.value === undefined)
            return `<g><title>${esc(tip(p))}</title><rect class="dsh-hole" x="${x.toFixed(1)}" y="${(T + plotH - 14).toFixed(1)}" width="${bw.toFixed(1)}" height="14" rx="3"/></g>`;
          const h = Math.max(p.value > 0 ? 2 : 0, plotH - (yAt(p.value) - T));
          return `<g><title>${esc(tip(p))}</title><rect class="dsh-col${p.partial ? ' is-partial' : ''}" x="${x.toFixed(1)}" y="${(T + plotH - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="4"/></g>`;
        })
        .join('');
    } else {
      // непрерывные куски линии между скрытыми точками
      const runs = [];
      let cur = [];
      pts.forEach((p, i) => {
        if (p.value === null || p.value === undefined) {
          if (cur.length) runs.push(cur);
          cur = [];
        } else cur.push([xAt(i), yAt(p.value), p]);
      });
      if (cur.length) runs.push(cur);
      body = runs
        .map((run) => {
          const solid = run.filter((r) => !r[2].partial);
          const d = (list) => list.map((r, k) => `${k ? 'L' : 'M'}${r[0].toFixed(1)} ${r[1].toFixed(1)}`).join('');
          const area =
            run.length > 1
              ? `<path class="dsh-area" d="${d(run)}L${run[run.length - 1][0].toFixed(1)} ${(T + plotH).toFixed(1)}L${run[0][0].toFixed(1)} ${(T + plotH).toFixed(1)}Z"/>`
              : '';
          const tail =
            run.length > 1 && run[run.length - 1][2].partial
              ? `<path class="dsh-line is-partial" d="${d(run.slice(-2))}"/>`
              : '';
          return `${area}<path class="dsh-line" d="${d(solid.length ? solid : run)}"/>${tail}`;
        })
        .join('');
      body += pts
        .map((p, i) =>
          p.value === null || p.value === undefined
            ? `<g><title>${esc(tip(p))}</title><circle class="dsh-hole" cx="${xAt(i).toFixed(1)}" cy="${(T + plotH).toFixed(1)}" r="4.5"/></g>`
            : `<g><title>${esc(tip(p))}</title><circle class="dsh-dot${p.partial ? ' is-partial' : ''}" cx="${xAt(i).toFixed(1)}" cy="${yAt(p.value).toFixed(1)}" r="${pts.length > 30 ? 2 : 4}"/></g>`,
        )
        .join('');
    }
    // подписи у самой высокой и последней точек: читать график можно без наведения
    const shown = pts.map((p, i) => ({ p, i })).filter((x) => x.p.value !== null && x.p.value !== undefined);
    const maxPt = shown.reduce((m, x) => (!m || x.p.value > m.p.value ? x : m), null);
    const lastPt = shown[shown.length - 1];
    const tags = [...new Set([maxPt, lastPt].filter(Boolean))]
      .map(
        (x) =>
          `<text class="dsh-t" x="${xAt(x.i).toFixed(1)}" y="${(yAt(x.p.value) - 9).toFixed(1)}" text-anchor="${x.i > pts.length - 3 ? 'end' : x.i < 2 ? 'start' : 'middle'}">${esc(fmt(x.p.value))}</text>`,
      )
      .join('');
    const summary = shown.length
      ? `от ${fmt(Math.min(...shown.map((x) => x.p.value)))} до ${fmt(Math.max(...shown.map((x) => x.p.value)))} ${b.unit || ''}, последнее значение ${fmt(lastPt.p.value)}`
      : 'данных нет или группы слишком малы';
    const skipped = pts.length - shown.length;
    return `<div class="dsh-scroll" tabindex="0" role="group" aria-label="${esc(b.title)}: график, прокручивается по горизонтали"><svg class="dsh-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${b.title}: ${summary}`)}">${grid}${body}${labels}${tags}</svg></div>${
      skipped ? `<p class="dsh-note">Пустые кружки — периоды, где людей слишком мало: цифра скрыта.</p>` : ''
    }`;
  }

  function heading(b) {
    return `<h3 class="dsh-sub">${esc(b.text)}${b.hint ? `<small>${esc(b.hint)}</small>` : ''}</h3>`;
  }

  const RENDER = { tiles, bars, stack, funnel, series, heading };
  const FULL = new Set(['funnel', 'tiles', 'heading']);

  /**
   * Раскладка главы. Порядок задаёт сервер (рассказ), клиент его не меняет: плитки, подзаголовки, воронки и карточки
   * с span:'full' — на всю строку, остальные — парами в том порядке, как пришли. Если в промежутке между такими
   * карточками осталась нечётная, она растягивается на строку, чтобы справа не было пустого места.
   */
  function plan(blocks) {
    const empty = (b) => b.type === 'bars' && b.items.length <= 2 && b.items.every((i) => i.value === null);
    const list = blocks.filter((b) => RENDER[b.type] && !empty(b));
    const out = list.map((b) => ({ b, wide: FULL.has(b.type) || b.span === 'full' }));
    let run = [];
    const flush = () => {
      if (run.length % 2 === 1) {
        // растягиваем график, если он есть в промежутке, иначе последнюю
        const pick = run.find((x) => x.b.type === 'series') || run[run.length - 1];
        pick.wide = true;
      }
      run = [];
    };
    for (const x of out) {
      if (x.wide) flush();
      else run.push(x);
    }
    flush();
    return out;
  }

  function block(b, idx, wide) {
    const fn = RENDER[b.type];
    if (!fn) return '';
    if (b.type === 'heading') return heading(b);
    const cls = `dsh-block dsh-b-${b.type}${wide ? ' dsh-wide' : ''}`;
    const head = b.title
      ? `<div class="dsh-bh"><h3>${esc(b.title)}</h3>${b.unit ? `<span class="dsh-unit">${esc(b.unit)}</span>` : ''}</div>`
      : '';
    const foot = [
      b.note ? `<p class="dsh-note">${esc(b.note)}</p>` : '',
      b.link ? `<a class="dsh-more" href="${esc(b.link)}">Открыть раздел</a>` : '',
    ]
      .filter(Boolean)
      .join('');
    return `<div class="${cls}">${head}${fn(b, wide)}${foot}</div>`;
  }

  function delta(k) {
    if (k.delta === null || k.delta === undefined) return '';
    const up = k.delta > 0;
    const flat = k.delta === 0;
    return `<span class="dsh-delta ${flat ? 'is-flat' : up ? 'is-up' : 'is-down'}" title="Было ${esc(fmt(k.prev))} в предыдущем таком же периоде"><svg class="dsh-arrow" viewBox="0 0 10 10" aria-hidden="true"><path d="${flat ? 'M1 5h8' : up ? 'M5 9V2M2 5l3-3 3 3' : 'M5 1v7M2 5l3 3 3-3'}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>${up ? '+' : ''}${esc(fmt(k.delta))}%<span class="sr"> к предыдущему периоду</span></span>`;
  }

  function hero(d) {
    const kp = d.kpis
      .map(
        (k) =>
          `<div class="dsh-kpi${k.tone ? ` is-${k.tone}` : ''}"><span class="dsh-cap">${esc(k.label)}</span><span class="dsh-num">${k.value === null || k.value === undefined ? '—' : esc(fmt(k.value))}</span><span class="dsh-kfoot">${delta(k)}${k.hint ? `<span class="dsh-hint">${esc(k.hint)}</span>` : k.value === null ? '<span class="dsh-hint">мало данных</span>' : ''}</span>${k.link ? `<a class="dsh-more" href="${esc(k.link)}">Открыть</a>` : ''}</div>`,
      )
      .join('');
    return `<section class="dsh-hero card" aria-labelledby="dsh-lead"><p class="dsh-eyebrow">Капель · ${esc(dayLabel(d.period.from))} — ${esc(dayLabel(d.period.to))} ${esc(d.period.to.slice(0, 4))}</p><p class="dsh-lead" id="dsh-lead">${emph(d.lead)}</p><div class="dsh-kpis">${kp}</div></section>`;
  }

  function dxPicker(c) {
    if (!c.dx) return '';
    return `<div class="dsh-dx" role="group" aria-label="Диагноз">${c.dx.options
      .map(
        (o) =>
          `<button type="button" class="choice" data-dx="${esc(o.code)}" aria-pressed="${o.code === c.dx.selected ? 'true' : 'false'}">${esc(o.label)}</button>`,
      )
      .join('')}</div>`;
  }

  function chapter(c, i) {
    const blocks = plan(c.blocks)
      .map((x, j) => block(x.b, j, x.wide))
      .join('');
    return `<section class="dsh-ch" id="ch-${esc(c.key)}" aria-labelledby="ch-${esc(c.key)}-h" data-chapter="${esc(c.key)}"><header class="dsh-chh"><span class="dsh-no" aria-hidden="true">${i + 1}</span><div><p class="dsh-kicker">${esc(c.kicker || '')}</p><h2 id="ch-${esc(c.key)}-h">${esc(c.title)}</h2></div></header>${dxPicker(c)}<p class="dsh-story">${emph(c.headline)}</p><div class="dsh-grid-b">${blocks || '<p class="dsh-empty">Раздел сейчас недоступен.</p>'}</div></section>`;
  }

  function render(host, d, days) {
    const nav = d.chapters
      .map(
        (c, i) =>
          `<a href="#ch-${esc(c.key)}" data-ch="${esc(c.key)}"><span>${i + 1}</span>${esc(c.kicker || c.title)}</a>`,
      )
      .join('');
    const periods = PERIODS.map(
      ([n, label]) =>
        `<button type="button" class="choice" data-days="${n}" aria-pressed="${n === days ? 'true' : 'false'}">${esc(label)}</button>`,
    ).join('');
    host.innerHTML = `<div class="dsh">
      <div class="dsh-top"><div class="dsh-periods" role="group" aria-label="Период">${periods}</div><a class="btn ghost sm" href="/admin?tab=analytics">Аналитика по диагнозам</a></div>
      ${hero(d)}
      <nav class="dsh-nav" aria-label="Главы обзора">${nav}</nav>
      ${d.chapters.map(chapter).join('')}
      <p class="dsh-disclaimer">${esc(d.disclaimer)} Сравнение — с предыдущим периодом такой же длины (${esc(dayLabel(d.previous.from))} — ${esc(dayLabel(d.previous.to))}).</p>
    </div>`;
  }

  function spy(host) {
    const links = [...host.querySelectorAll('.dsh-nav a')];
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          for (const a of links) {
            if (a.dataset.ch === e.target.dataset.chapter) a.setAttribute('aria-current', 'true');
            else a.removeAttribute('aria-current');
          }
        }
      },
      { rootMargin: '-20% 0px -70% 0px' },
    );
    host.querySelectorAll('.dsh-ch').forEach((el) => io.observe(el));
  }

  async function mount(host, { url = '/api/v1/admin/dashboard' } = {}) {
    const fromUrl = Number(new URLSearchParams(location.search).get('days'));
    let days = PERIODS.some(([n]) => n === fromUrl) ? fromUrl : 90;
    let dx = new URLSearchParams(location.search).get('dx') || 'all';
    async function load() {
      host.setAttribute('aria-busy', 'true');
      host.innerHTML = '<p class="muted" role="status">Собираю обзор…</p>';
      let data = null;
      try {
        const r = await fetch(`${url}?days=${days}&dx=${encodeURIComponent(dx)}`, {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        });
        if (r.ok) data = await r.json();
      } catch (_) {
        data = null;
      }
      host.removeAttribute('aria-busy');
      if (!data) {
        host.innerHTML = '<p class="muted">Не получилось собрать обзор. Обновите страницу чуть позже.</p>';
        return;
      }
      render(host, data, days);
      spy(host);
      host.querySelectorAll('[data-dx]').forEach((btn) =>
        btn.addEventListener('click', () => {
          dx = btn.dataset.dx;
          const u = new URL(location.href);
          u.searchParams.set('dx', dx);
          history.replaceState(null, '', u);
          load();
        }),
      );
      host.querySelectorAll('[data-days]').forEach((btn) =>
        btn.addEventListener('click', () => {
          days = Number(btn.dataset.days);
          const u = new URL(location.href);
          u.searchParams.set('days', String(days));
          history.replaceState(null, '', u);
          load();
        }),
      );
    }
    await load();
  }

  window.CCDashboard = { mount };
})();
