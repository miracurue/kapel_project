'use strict';

// Общие middleware и хелперы, перенесены из app.js без изменения логики.
// requireRole централизован здесь, чтобы W0.2 (src/permissions.js) и следующие
// волны могли заменить проверку прав в одном месте.

function locals(req, res, next) {
  res.locals.user = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  next();
}

function flash(req, message, kind = 'info') {
  req.session.flash = { message, kind };
}

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).render('error', { message: 'Недостаточно прав для этого раздела.' });
    }
    next();
  };
}

const isClinician = (role) => role === 'psychiatrist' || role === 'psychologist';

module.exports = { locals, flash, requireLogin, requireRole, isClinician };
