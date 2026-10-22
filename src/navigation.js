'use strict';

// Боковая навигация по ролям — данными. Чтобы добавить раздел, достаточно
// добавить объект в нужную роль (или снять `soon: true`, когда маршрут готов).
//
// Поля пункта:
//   key    — стабильный идентификатор;
//   label  — подпись в меню;
//   href   — ссылка (для `soon: true` не выводится: пункт disabled, без ссылки);
//   match  — префиксы пути, при которых пункт считается активным;
//   exact  — совпадение по match только точное (для /dashboard);
//   soon   — раздела ещё нет: показывается неактивным с пометкой «скоро».
//
// Права доступа здесь НЕ определяются — это только отображение меню.
// Реальные проверки — requireRole / (позже) src/permissions.js.

const CLINICIAN = [
  { key: 'summary', label: 'Сводка', href: '/dashboard', match: ['/dashboard'], exact: true },
  { key: 'patients', label: 'Пациенты', href: '/patients', match: ['/patients'] },
  { key: 'assignments', label: 'Назначения', href: '/assignments', match: ['/assignments'] },
  { key: 'invites', label: 'Приглашения', href: '/invites', match: ['/invites'] },
  { key: 'conclusions', label: 'Заключения', href: '/conclusions', match: ['/conclusions'] },
  { key: 'inbox', label: 'Сообщения', href: '/inbox', match: ['/inbox'], badge: 'careMsgUnread', badgeClass: 'badge-info' },
  { key: 'crisis', label: 'Кризисная очередь', href: '/crisis', match: ['/crisis'] },
  { key: 'ai', label: 'ИИ-пространство', href: '/ai', match: ['/ai'] },
  { key: 'tools', label: 'Инструменты', href: '/tools', match: ['/tools'] },
  { key: 'export', label: 'Экспорт', href: '/export', match: ['/export'] },
];

const NAVIGATION = {
  patient: [
    { key: 'home', label: 'Главная', href: '/dashboard', match: ['/dashboard'], exact: true },
    { key: 'tests', label: 'Тесты', href: '/tests', match: ['/tests', '/assignments'] },
    { key: 'chat', label: 'ИИ-помощник', href: '/chat', match: ['/chat'] },
    { key: 'diary', label: 'Дневник', href: '/diary', match: ['/diary', '/mood'] },
    { key: 'meds', label: 'Лечение', href: '/meds', match: ['/meds'] },
    { key: 'messages', label: 'Сообщения врачу', href: '/messages', match: ['/messages'], badge: 'careMsgUnread', badgeClass: 'badge-info' },
    { key: 'learn', label: 'Обучение', href: '/learn', match: ['/learn'] },
    { key: 'previsit', label: 'Перед приёмом', href: '/previsit', match: ['/previsit'] },
    { key: 'reminders', label: 'Напоминания', href: '/reminders', match: ['/reminders'] },
    { key: 'conclusions', label: 'Заключения', href: '/my-conclusions', match: ['/my-conclusions'] },
    { key: 'share', label: 'Поделиться с врачом', href: '/share', match: ['/share'] },
    { key: 'privacy', label: 'Приватность', href: '/privacy', match: ['/privacy', '/onboarding'] },
    { key: 'profile', label: 'Профиль', href: '/profile', match: ['/profile'] },
  ],
  psychiatrist: CLINICIAN,
  psychologist: CLINICIAN,
  admin: [
    { key: 'summary', label: 'Требует решения', href: '/dashboard', match: ['/dashboard', '/admin'], exact: true },
    { key: 'nobody', label: 'Без врача', href: '/admin/nobody', match: ['/admin/nobody'], badge: 'adminNobodyCount' },
    { key: 'deletion-requests', label: 'Запросы на удаление', href: '/admin/deletion', match: ['/admin/deletion'], badge: 'adminDeletionCount' },
    { key: 'users', label: 'Пользователи', href: '/admin/users', match: ['/admin/users', '/admin/credentials'] },
    { key: 'assignments', label: 'Привязки', href: '/admin/assignments', match: ['/admin/assignments'] },
    { key: 'invites', label: 'Приглашения', href: '/admin/invites', match: ['/admin/invites'] },
    { key: 'audit', label: 'Журналы', href: '/admin/audit', match: ['/admin/audit'] },
    { key: 'consents', label: 'Согласия', href: '/admin/consents', match: ['/admin/consents'] },
    { key: 'system', label: 'Система', href: '/admin/system', match: ['/admin/system'] },
  ],
};

function isActive(item, currentPath) {
  if (item.soon || !item.match) return false;
  return item.match.some((p) => (item.exact ? currentPath === p : currentPath === p || currentPath.startsWith(p + '/')));
}

function navFor(role, currentPath = '/') {
  const items = NAVIGATION[role] || [];
  return items.map((item) => ({ ...item, active: isActive(item, currentPath) }));
}

function middleware(req, res, next) {
  const role = req.session && req.session.user ? req.session.user.role : null;
  res.locals.navItems = role ? navFor(role, req.path) : [];
  next();
}

module.exports = { NAVIGATION, navFor, middleware };
