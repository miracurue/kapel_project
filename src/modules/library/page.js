'use strict';

/**
 * W-48: серверный рендер вкладки «Библиотека» (P-15, F-50). Одинаковый список
 * у пациента, психиатра и психолога (S-50); назначений нет (решение владельца).
 * Раскладка — как в прототипе v5: поиск, фильтры «Слушать · Смотреть · Читать»,
 * «Продолжить», карточки с плеером. Аудио — отдача файла частями и личная
 * позиция «Продолжить» (DB-64). Материалы STAND-IN помечены.
 */

const { t } = require('../../i18n');

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const FILTERS = [
  ['', 'msg.library.filter.all', 'all'],
  ['listen', 'msg.library.filter.listen', 'listen'],
  ['watch', 'msg.library.filter.watch', 'watch'],
  ['read', 'msg.library.filter.read', 'read'],
];
const KIND_ALIAS = { audio: 'listen', video: 'watch', article: 'read' };

const ICON = {
  audio:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/></svg>',
  article:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/></svg>',
  sparkle:
    '<svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-sparkle"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5l12 7.5-12 7.5z"/></svg>',
  pause:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
};

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const minutes = (item) => {
  if (item.duration_s) return Math.max(1, Math.round(item.duration_s / 60));
  const words = String(item.body_md || item.summary || '')
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 180));
};

function kindLine(item) {
  const n = minutes(item);
  const key =
    item.kind === 'audio'
      ? 'msg.library.kind.audio'
      : item.kind === 'video'
        ? 'msg.library.kind.video'
        : 'msg.library.kind.article';
  return t(key).replace('{n}', String(n));
}

function player(item) {
  const dur = Number(item.duration_s) || 0;
  const pos = Number(item.position_s) || 0;
  return `<div class="player" data-lib-player>
      <audio preload="none" src="/api/v1/library/${item.id}/media" data-lib-audio data-item="${item.id}" data-position="${pos}" data-duration="${dur}"></audio>
      <button type="button" class="pp" data-lib-toggle data-testid="msg.library.play" aria-label="${esc(t('msg.library.play'))}">${ICON.play}</button>
      <div class="bar" role="slider" tabindex="0" data-lib-seek data-testid="msg.library.seek" aria-label="${esc(t('msg.library.seek'))}" aria-valuemin="0" aria-valuemax="${dur}" aria-valuenow="${pos}"><i data-lib-fill></i></div>
      <time data-lib-time>${mmss(pos)} / ${mmss(dur)}</time>
    </div>`;
}

function card(item, { ask }) {
  const standIn = item.stand_in ? `<span class="soon" data-standin>${esc(t('msg.library.stand_in'))}</span>` : '';
  const meta = `<p class="lib-meta small muted">${esc(item.author)} · ${esc(item.source)} · ${esc(t('msg.library.revision'))}: ${esc(item.review_date)}</p>`;
  const thumb =
    item.kind === 'article' ? `<div class="thumb">${ICON.article}</div>` : `<div class="thumb">${ICON.audio}</div>`;
  const body =
    item.kind === 'article'
      ? `<div class="acts"><button type="button" class="btn" data-lib-read>${esc(t('msg.library.read'))}</button></div><div class="article-text lib-body" hidden>${esc(item.body_md || '')}</div>`
      : player(item);
  const star = ask
    ? `<a class="ask" href="/app?tab=chat&ask=library_item:${item.id}" aria-label="${esc(t('msg.library.ask'))}" data-testid="msg.ask.star" data-object-type="library_item" data-object-id="${item.id}">${ICON.sparkle}</a>`
    : '';
  return `<article class="card lib-card" data-lib-item="${item.id}" data-kind="${esc(item.kind)}" data-search="${esc(`${item.title} ${item.summary} ${(item.tags || []).join(' ')}`.toLowerCase())}">${star}<div class="media">${thumb}<div class="grow"><h3>${esc(item.title)}${standIn}</h3><div class="sub">${esc(kindLine(item))}${item.summary ? ` · ${esc(item.summary)}` : ''}</div>${meta}</div></div>${body}</article>`;
}

function renderLibrary({ items, q = '', kind = '', base = '/app' }) {
  const active = KIND_ALIAS[kind] || kind;
  const query = q ? `&q=${encodeURIComponent(q)}` : '';
  const ask = base === '/app';
  const filters = FILTERS.filter(([value]) => !(base === '/app' && value === 'read')).map(
    ([value, key, id]) =>
      `<a class="pill${active === value ? ' on' : ''}" href="${base}?tab=library${value ? `&kind=${value}` : ''}${query}"${
        active === value ? ' aria-current="true"' : ''
      } data-testid="msg.library.filter.${id}">${esc(t(key))}</a>`,
  ).join('');
  const resumable = items.filter((i) => i.kind !== 'article' && Number(i.position_s) > 0);
  const rest = items.filter((i) => !resumable.includes(i));
  const list = items.length
    ? `${
        resumable.length
          ? `<p class="sec-label" data-testid="msg.library.continue">${esc(t('msg.library.continue'))}</p>${resumable.map((i) => card(i, { ask })).join('')}`
          : ''
      }<p class="sec-label">${esc(resumable.length ? t('msg.library.all') : t('msg.library.all'))}</p><section class="lib-list">${rest.map((i) => card(i, { ask })).join('')}</section>`
    : `<p data-testid="msg.library.empty">${esc(t('msg.library.empty'))}</p>`;
  return `<div class="pt-lib"><h1 data-testid="msg.library.title">${esc(t('msg.library.title'))}</h1>
    <form class="lib-search" method="get" action="${base}">
      <input type="hidden" name="tab" value="library">
      <input type="search" name="q" value="${esc(q)}" maxlength="50" placeholder="${esc(t('msg.library.search'))}" data-testid="msg.library.search" aria-label="${esc(t('msg.library.search'))}">
      <button type="submit" class="sr" data-testid="msg.library.search.submit">${esc(t('msg.library.search.submit'))}</button>
    </form>
    <nav class="lib-filters" aria-label="${esc(t('msg.library.filters'))}">${filters}</nav>
    ${list}
    <p class="muted" data-testid="msg.library.empty_search" hidden>${esc(t('msg.library.empty_search'))}</p>
    <p class="footnote" data-testid="msg.library.provenance">${esc(t('msg.library.provenance'))}</p>
    ${ask ? `<a class="ask-line" href="/app?tab=chat">${esc(t('msg.library.ask'))}</a>` : ''}
    <script src="/library.js" defer></script></div>`;
}

module.exports = { renderLibrary, card, FILTERS, KIND_ALIAS };
