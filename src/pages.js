'use strict';

const { roleNumber } = require('./access');
const { t } = require('./i18n');

const NAV = {
  patient: [
    ['msg.nav.patient.chat', 'chat'],
    ['msg.nav.patient.diary', 'diary'],
    ['msg.nav.patient.tests', 'tests'],
    ['msg.nav.patient.meds', 'meds'],
    ['msg.nav.patient.doctor', 'doctor'],
  ],
  psychiatrist: [
    ['msg.nav.clinician.chat', 'chat'],
    ['msg.nav.clinician.patients', 'patients'],
    ['msg.nav.clinician.signals', 'signals'],
    ['msg.nav.clinician.tests', 'tools'],
    ['msg.nav.psychiatrist.docs', 'docs'],
    ['msg.nav.clinician.blog', 'library'],
    ['msg.shell.more', 'more'],
  ],
  psychologist: [
    ['msg.nav.clinician.chat', 'chat'],
    ['msg.nav.clinician.patients', 'patients'],
    ['msg.nav.clinician.signals', 'signals'],
    ['msg.nav.clinician.tests', 'tools'],
    ['msg.nav.psychologist.conclusions', 'docs'],
    ['msg.nav.clinician.blog', 'library'],
    ['msg.shell.more', 'more'],
  ],
  admin: [
    ['msg.nav.admin.chat', 'chat'],
    ['msg.nav.admin.requests', 'requests'],
    ['msg.nav.admin.people', 'people'],
    ['msg.nav.admin.settings', 'settings'],
    ['msg.nav.admin.log', 'log'],
    ['msg.shell.more', 'more'],
  ],
  demo_host: [
    ['msg.nav.host.route', 'route'],
    ['msg.nav.host.data', 'data'],
  ],
};

// Значки Phosphor Regular из спрайта /icons.svg (Этап 7, спецификация 06 §7); цвет — currentColor.
const ic = (name, size = '') =>
  `<svg class="i${size ? ` i--${size}` : ''}" aria-hidden="true" focusable="false"><use href="/icons.svg#i-${name}"/></svg>`;
const TAB_ICON = {
  chat: 'chat-circle',
  diary: 'notebook',
  tests: 'clipboard-text',
  tools: 'clipboard-text',
  meds: 'pill',
  doctor: 'user-circle',
  patients: 'users',
  signals: 'warning',
  docs: 'file-text',
  library: 'note-pencil',
  requests: 'receipt',
  people: 'users',
  settings: 'gear-six',
  log: 'shield-check',
  route: 'play',
  data: 'receipt',
  more: 'dots-three-vertical',
};
const MARK = `<svg class="mark" viewBox="12 0 40 66" aria-hidden="true" focusable="false"><path d="M25.5 61 C25.5 53 32 49 32 43 A13.5 13.5 0 0 1 18.5 29.5 C18.5 21 27 14 32 5 C37 14 45.5 21 45.5 29.5 A13.5 13.5 0 0 1 32 43" fill="none" stroke="currentColor" stroke-width="6.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M29.4 53 C31.5 47.5 37.5 44.5 46 44.5 C44.5 50.5 38 54.5 29.4 53Z" fill="currentColor" stroke="currentColor" stroke-linejoin="round" stroke-width="2.4"/></svg>`;

const ROLE_LABEL = {
  patient: 'Пациент',
  psychiatrist: 'Психиатр',
  psychologist: 'Психолог',
  admin: 'Администратор',
  host: 'Ведущий демонстрации',
};

function initials(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '·';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

// Пункты вкладки «Ещё ▾» (спецификация 8.1): редкие разделы по ролям; в меню попадают и вкладки, не поместившиеся в шапку.
function moreItems(user) {
  if (user?.role === 'admin')
    return [
      ['/admin?tab=content', 'msg.nav.admin.more.content', 'Контент'],
      ['/admin?tab=analytics', 'msg.nav.admin.more.analytics', 'Аналитика'],
      ['/admin?tab=program', 'msg.nav.admin.more.program', 'Программа'],
      ['/admin?tab=service', 'msg.nav.admin.more.service', 'Сервис'],
    ];
  if (user?.role !== 'psychiatrist' && user?.role !== 'psychologist') return [];
  const items = [
    ['/work?tab=analytics', 'msg.nav.clinician.more.analytics', 'Аналитика'],
    ['/account/library', 'msg.nav.avatar.library', 'Аудио и видео'],
    ['/work?tab=tools#offline', 'msg.nav.clinician.more.offline', 'Внести очный результат'],
  ];
  if (user.role === 'psychiatrist' && user.flag_clinical_lead)
    items.splice(1, 0, ['/work/approvals', 'msg.nav.psychiatrist.more.approvals', 'Утверждения']);
  return items;
}

function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function button(key, text, attrs = '') {
  return `<button type="button" data-testid="${key}" ${attrs}>${esc(text)}</button>`;
}

// Верх оболочки: демо-строка, шапка с вкладками, меню. Общий для новых и старых серверных страниц.
function shellTop(user) {
  const role = user?.role === 'host' ? 'demo_host' : user?.role;
  const workspace = {
    patient: '/app',
    psychiatrist: '/work',
    psychologist: '/work',
    admin: '/admin',
    demo_host: '/demo',
  }[role];
  const nav = (NAV[role] || [])
    .map(([key, tab], i) => {
      const label = esc(t(key, tab));
      const caret = tab === 'more' ? ic('caret-down', '16') : '';
      return `<a href="${workspace}?tab=${tab}" data-testid="${key}" data-tab="${tab}" class="tab nav-${i + 1}"><span class="ic">${ic(TAB_ICON[tab] || 'dots-three-vertical')}</span><span class="lbl">${label}</span>${caret}</a>`;
    })
    .join('');
  const crisis =
    role === 'patient'
      ? `<a class="help hard" href="/account/help" data-testid="msg.shell.crisis_link">${ic('phone-call')}<span>${esc(t('msg.shell.crisis_link', 'Мне нужна помощь · 112'))}</span></a>`
      : '';
  const more = moreItems(user);
  const moreMenu = more.length
    ? `<div class="menu more-menu" data-menu="more" hidden>${more.map(([href, key, text]) => `<a href="${href}"${key === 'msg.nav.clinician.more.offline' ? '' : ` data-testid="${key}"`}>${esc(t(key, text))}</a>`).join('')}</div>`
    : '';
  const name = user?.full_name || '';
  const journal = ['patient', 'psychiatrist', 'psychologist', 'admin'].includes(user?.role)
    ? `<a class="jbtn journal-btn" href="/journal" data-testid="msg.shell.journal" aria-label="${esc(t('msg.journal.title'))}">${ic('newspaper')}<span>${esc(t('msg.journal.title'))}</span></a>`
    : '';
  const drops =
    role === 'patient'
      ? `<button type="button" class="drops drops-btn" data-flower-counter data-testid="msg.flower.counter" aria-expanded="false" aria-controls="flower-panel" aria-label="${esc(t('msg.flower.counter'))}"><svg class="drop drop--m" aria-hidden="true" focusable="false"><use href="/icons.svg#drop"/></svg><b data-flower-balance>·</b><span class="drops-gain drops-pop" data-flower-gain aria-hidden="true" hidden></span></button>`
      : '';
  const accountActions = user
    ? `<div class="right shell-actions bar-end">${crisis}${drops}${journal}<span class="bell-wrap"><button type="button" class="round bell icon-btn" aria-label="Уведомления" data-testid="msg.shell.bell">${ic('bell')}</button></span><button type="button" class="avatar" aria-label="${esc(initials(name))} — меню профиля" data-testid="msg.shell.avatar">${esc(initials(name))}</button></div>`
    : '';
  const menuLink = (href, text, key = '') => `<a href="${href}"${key ? ` data-testid="${key}"` : ''}>${esc(text)}</a>`;
  const accountMenu = user
    ? `<div class="menu avatar-menu" hidden><div class="who"><b>${esc(name || ROLE_LABEL[user.role] || '')}</b>${esc(ROLE_LABEL[user.role] || '')} · демо</div>${menuLink('/account', 'Профиль и безопасность', 'msg.profile.title')}${user.role === 'patient' ? menuLink('/account/data', 'Мои данные и согласия', 'msg.mydata.title') : ''}${menuLink('/notifications', 'Уведомления')}${menuLink('/account/help', 'Справка', 'msg.nav.avatar.help')}${menuLink('/account/legal', t('msg.nav.avatar.legal', 'Правовая информация'))}<hr><a href="/">Сменить роль</a>${button('msg.nav.avatar.logout', 'Выйти')}</div>`
    : '';
  return `<a class="skip-link" href="#main-content" data-testid="msg.shell.skip_link">Перейти к содержимому</a>
  <div class="demo demo-strip" data-testid="msg.demo.strip">Демо · синтетические данные, не медицинская помощь<span class="d-long"> · тексты и шкалы — заглушки, требуют проверки специалистом</span> · <a href="/">сменить роль</a></div>
  <header class="top bar"><a class="brand" href="/" aria-label="${esc(t('msg.brand.name', 'Капель'))} — на главную" data-testid="msg.shell.brand">${MARK}<span class="brand-text"><span class="brand-name">${esc(t('msg.brand.name', 'Капель'))}</span><span class="brand-tag">${esc(t('msg.brand.tagline', 'По капле в день'))}</span></span></a><nav class="tabs" aria-label="Разделы">${nav}</nav>${accountActions}${accountMenu}${moreMenu}</header>`;
}

// Областные таблицы стилей: после app.css, каждая своего раздела (assets/build/SHARED.md).
const AREA_CSS = ['patient', 'work', 'studio', 'insights', 'admin']
  .map((n) => `<link rel="stylesheet" href="/css/${n}.css">`)
  .join('');

function shell({
  page = 'P-28',
  title = 'Капель',
  user = null,
  body = '',
  onboarding = false,
  layout = '',
  styles = [],
  scripts = [],
}) {
  const intro = onboarding
    ? `<section class="modal onboarding" data-testid="msg.onboarding.patient.1" role="dialog" aria-modal="true"><h2>Короткое знакомство</h2><p>Здесь можно вести дневник и связаться со специалистом.</p>${user?.role === 'patient' ? `<p>${esc(t('msg.onboarding.flower'))}</p>` : ''}<form action="/onboarding/done" method="post"><button type="submit" data-testid="msg.onboarding.skip">Пропустить</button></form></section>`
    : '';
  const app = layout === 'app';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="preload" href="/fonts/Nunito-400-800-cyrillic.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="/fonts/MPLUSRounded1c-800-cyrillic.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css">${AREA_CSS}${user?.role === 'patient' ? '<link rel="stylesheet" href="/flower.css">' : ''}${styles.map((href) => `<link rel="stylesheet" href="${esc(href)}">`).join('')}</head><body class="${app ? 'app-layout' : user ? 'page-scroll' : 'page-scroll auth'}" data-role="${roleNumber(user)}">
  ${shellTop(user)}
  <main id="main-content" tabindex="-1" class="${app ? 'app-main' : 'page-wrap'}" data-page="${page}">${intro}${body}</main><script src="/shell.js" defer></script><script src="/js/rx.js" defer></script><script src="/v2.js" defer></script><script src="/charts.js" defer></script><script src="/js/cohort_report.js" defer></script><script src="/js/insights.js" defer></script><script src="/js/patient_overview.js" defer></script><script src="/views.js" defer></script>${user?.role === 'patient' ? '<script src="/js/flower_plant.js" defer></script><script src="/js/flower.js" defer></script>' : ''}${scripts.map((src) => `<script src="${esc(src)}" defer></script>`).join('')}</body></html>`;
}

function errorPage({ user, demo }) {
  return shell({
    page: 'P-28',
    title: 'Страница недоступна',
    user,
    demo,
    body: `<h1 data-testid="msg.error.404.title">Страница недоступна</h1><p>Проверьте адрес или вернитесь на главную.</p><div class="page-actions"><a href="/" data-testid="msg.error.home">На главную</a>${user?.role === 'patient' ? '<a href="/account/help" data-testid="msg.error.patient_help">112</a>' : ''}</div>`,
  });
}

module.exports = { shell, shellTop, errorPage, button, esc, NAV };
