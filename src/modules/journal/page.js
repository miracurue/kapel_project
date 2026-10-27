'use strict';

/**
 * Журнал: общая шапка сервиса (shell из src/pages.js), свой тёплый фон и один большой белый лист (public/journal.css).
 * Лента (первая страница рендерится на сервере, остальные добавляет кнопка «Показать ещё»), страница статьи с лайком
 * и «Спросить ИИ», переключатель «для специалистов / для пациентов» у психиатра и психолога. Тексты — ключами locales/ru.json.
 */

const { t } = require('../../i18n');
const { shell } = require('../../pages');

const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];
const dateLabel = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const ic = (name, size = '') =>
  `<svg class="i${size ? ` i--${size}` : ''}" aria-hidden="true" focusable="false"><use href="/icons.svg#i-${name}"/></svg>`;

// Размеры фото (атрибуты width/height держат место до загрузки): главное 3:2, карточки 4:3.
const SIZE = { hero: [900, 600], card: [400, 300], article: [960, 640] };

function cover(item, kind, lazy = true) {
  const [w, h] = SIZE[kind];
  return item.cover_url
    ? `<img src="${esc(item.cover_url)}" alt="${esc(item.title)}" width="${w}" height="${h}"${lazy ? ' loading="lazy"' : ''}>`
    : `<span class="j-ph" role="img" aria-label="${esc(item.title)}">${ic('image', '32')}</span>`;
}

const topicLine = (item) => {
  const topics = item.topics.slice(0, 2);
  return topics.length ? `<p class="small j-topics">${topics.map((x) => esc(cap(x))).join(' · ')}</p>` : '';
};

const by = (item) => `${esc(item.author)}${item.author_role ? `, ${esc(item.author_role)}` : ''}`;
const meta = (item) =>
  `${esc(dateLabel(item.published_at))} · ${esc(t('msg.journal.min').replace('{n}', String(item.minutes)))}`;

function likeButton(item, big = false) {
  return `<button type="button" class="btn${big ? '' : ' sm'} j-like${item.liked ? ' on' : ''}" data-like="${item.id}" aria-pressed="${item.liked ? 'true' : 'false'}" aria-label="${esc(t('msg.journal.like'))}" data-testid="msg.journal.like">${ic('thumbs-up')}${big ? `<span>${esc(t('msg.journal.like'))}</span>` : ''}<b data-like-n>${item.likes}</b></button>`;
}

function card(item, hero = false) {
  const head = `<a class="j-img" href="/journal/${item.id}" tabindex="-1" aria-hidden="true">${cover(item, hero ? 'hero' : 'card', !hero)}</a>`;
  if (hero)
    return `<article class="j-card feat" data-id="${item.id}">${head}
    <div class="j-body">${topicLine(item)}<h2><a href="/journal/${item.id}">${esc(item.title)}</a></h2>
      ${item.summary ? `<p class="lead">${esc(item.summary)}</p>` : ''}
      <p class="small j-meta">${by(item)} · ${meta(item)}</p>
      <div class="j-actions">${likeButton(item)}</div></div></article>`;
  return `<article class="j-card" data-id="${item.id}">${head}
    <div class="j-body">${topicLine(item)}<h3><a href="/journal/${item.id}">${esc(item.title)}</a></h3>
      <p class="small j-meta">${by(item)} · ${meta(item)}</p>
      <div class="j-actions">${likeButton(item)}</div></div></article>`;
}

const cards = (items, first) => items.map((it, i) => card(it, first && i === 0)).join('');

// Общая оболочка сервиса (шапка, вкладки) + тёплый фон и «Журнал» нажат в шапке; вкладки без текущей (journal.js).
function chrome({ user, title, main, description = '' }) {
  const html = shell({
    page: 'J-01',
    title,
    user,
    body: main,
    styles: ['/journal.css'],
    scripts: ['/js/md.js', '/journal.js'],
  });
  return html
    .replace('<body class="page-scroll"', '<body class="page-scroll journal-page"')
    .replace('class="jbtn journal-btn" href="/journal"', 'class="jbtn journal-btn" href="/journal" aria-current="page"')
    .replace(
      '<meta name="robots"',
      `${description ? `<meta name="description" content="${esc(description)}">` : ''}<meta name="robots"`,
    );
}

function renderFeed({ user, audience, data, topic }) {
  const clinician = user.role !== 'patient';
  const href = (value) => `/journal?aud=${audience}${value ? `&topic=${encodeURIComponent(value)}` : ''}`;
  const topicLink = (value, label) =>
    `<a class="chip${topic === value ? ' is-on' : ''}" href="${href(value)}"${topic === value ? ' aria-current="true"' : ''}>${esc(label)}</a>`;
  const switcher = clinician
    ? `<nav class="seg j-seg" aria-label="${esc(t('msg.journal.audience'))}">${['specialist', 'patient']
        .map(
          (a) =>
            `<a href="/journal?aud=${a}"${audience === a ? ' aria-current="true"' : ''} data-testid="msg.journal.aud.${a}">${esc(t(`msg.journal.aud.${a}`))}</a>`,
        )
        .join('')}</nav>`
    : '';
  const mine = clinician
    ? `<a class="btn" href="/work?tab=library" data-testid="msg.journal.mine">${esc(t('msg.journal.mine'))}</a>`
    : '';
  const main = `<div class="journal" data-journal>
  <header class="j-head"><div><h1 class="j-title">${esc(t('msg.journal.title'))}</h1><p class="lead">${esc(t(`msg.journal.lead.${audience}`))}</p></div>${clinician ? `<div class="j-tools">${switcher}${mine}</div>` : ''}</header>
  ${data.topics.length ? `<nav class="chips j-chips" aria-label="${esc(t('msg.journal.topics'))}">${topicLink('', t('msg.journal.topic.all'))}${data.topics.map((x) => topicLink(x, cap(x))).join('')}</nav>` : '<div class="j-chips-gap"></div>'}
  ${
    data.items.length
      ? `<div class="j-grid" data-feed data-aud="${esc(audience)}" data-topic="${esc(topic)}" data-page="${data.page}" data-more="${data.has_more ? '1' : '0'}">${cards(data.items, true)}</div>
  <div class="j-more"><button type="button" class="btn" data-more-btn${data.has_more ? '' : ' hidden'}>${esc(t('msg.journal.more'))}</button>
  <p class="small muted" data-end${data.has_more ? ' hidden' : ''}>${esc(t('msg.journal.end'))}</p></div>`
      : `<div class="empty" data-testid="msg.journal.empty">${ic('newspaper', '32')}<p>${esc(t('msg.journal.empty'))}</p>${clinician ? `<a class="btn" href="/work?tab=library">${esc(t('msg.journal.write'))}</a>` : ''}</div>`
  }
  <p class="small muted j-note">${esc(t('msg.journal.disclaimer'))} ${esc(t('msg.journal.demo'))}</p></div>`;
  return chrome({
    user,
    title: `${t('msg.journal.title')} — ${t(`msg.journal.h1.${audience}`)}`,
    main,
    description: t(`msg.journal.lead.${audience}`),
  });
}

function renderArticle({ user, item, related }) {
  const clinician = user.role !== 'patient';
  const topics = item.topics.slice(0, 3);
  const ask = `${clinician ? '/work' : '/app'}?tab=chat&ask=library_item:${item.id}`;
  const main = `<article class="journal" data-journal data-id="${item.id}">
  <div class="read j-art-head">
    <a class="btn ghost j-back" href="/journal?aud=${esc(item.audience)}" data-testid="msg.journal.back">${ic('arrow-left', '16')}${esc(t('msg.journal.title'))}</a>
    ${topics.length ? `<p class="small j-topics">${topics.map((x) => esc(cap(x))).join(' · ')}</p>` : ''}
    <h1 class="display">${esc(item.title)}</h1>
    ${item.summary ? `<p class="lead">${esc(item.summary)}</p>` : ''}
    <p class="small j-meta">${by(item)} · ${meta(item)}${item.ai_assisted ? ` · <span class="j-ai">${esc(t('msg.mag.ai'))}</span>` : ''}<button type="button" class="j-print" data-print-article aria-label="Распечатать статью" title="Распечатать">${ic('printer', '16')}</button></p>
  </div>
  ${item.cover_url ? `<figure class="j-hero">${cover(item, 'article', false)}</figure>` : ''}
  <div class="read">
    <div class="prose j-text" data-md="${esc(item.body_md)}">${esc(item.body_md)}</div>
    <div class="j-actions j-endrow">${likeButton(item, true)}<a class="btn" href="${ask}" data-testid="msg.journal.ask">${ic('sparkle')}${esc(t('msg.journal.ask'))}</a></div>
    <p class="small muted">${esc(t('msg.mag.disclaimer'))}</p>
  </div>
  ${
    related.length
      ? `<section class="j-related"><h2>${esc(t('msg.journal.related'))}</h2><div class="j-grid">${cards(related, false)}</div></section>`
      : ''
  }</article>`;
  return chrome({
    user,
    title: `${item.title} — ${t('msg.journal.title')}`,
    main,
    description: item.summary,
  });
}

module.exports = { renderFeed, renderArticle, cards };
