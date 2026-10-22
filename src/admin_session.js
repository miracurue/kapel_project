'use strict';

/**
 * Сессии и обязательная смена пароля (REQ-ADM-002/003/004, REQ-SEC-012) + счётчики меню админа.
 *
 * На каждом запросе сверяем сессию с БД:
 *  - пользователь удалён/деактивирован/не active -> сессия завершается;
 *  - сессия выдана раньше users.sessions_valid_from (сброс пароля админом, смена пароля,
 *    деактивация) -> завершается;
 *  - must_change_password = 1 -> доступна только страница смены пароля и выход.
 */

const db = require('./db');

const ALLOWED_WHEN_MUST_CHANGE = new Set(['/account/password', '/logout']);

function middleware(req, res, next) {
  const su = req.session && req.session.user;
  if (!su) return next();
  let row;
  try {
    row = db
      .prepare('SELECT id, role, account_status, deactivated_at, must_change_password, sessions_valid_from FROM users WHERE id = ?')
      .get(su.id);
  } catch (e) {
    return next(e);
  }
  let reason = null;
  if (!row || row.role !== su.role) reason = 'Сессия завершена. Войдите снова.';
  else if (row.deactivated_at) reason = 'Учётная запись отключена администратором.';
  else if (row.account_status !== 'active') reason = 'Учётная запись недоступна.';
  else if (row.sessions_valid_from && String(su.at || '') < row.sessions_valid_from) {
    reason = 'Сессия завершена: пароль был изменён или сброшен. Войдите снова.';
  }
  if (reason) {
    req.session.user = null;
    req.session.flash = { message: reason, kind: 'error' };
    return res.redirect('/login');
  }
  if (row.must_change_password && !ALLOWED_WHEN_MUST_CHANGE.has(req.path)) {
    req.session.flash = { message: 'Перед работой задайте новый пароль: временный пароль действует только для первого входа.', kind: 'info' };
    return res.redirect('/account/password');
  }
  res.locals.mustChangePassword = !!row.must_change_password;
  if (su.role === 'admin') {
    try {
      const adminQueue = require('./admin_queue');
      res.locals.adminNobodyCount = adminQueue.countOpen();
      res.locals.adminDeletionCount = require('./admin_deletion').pendingCount();
    } catch (e) {
      console.error('admin counters failed', e);
    }
  }
  next();
}

module.exports = { middleware };
