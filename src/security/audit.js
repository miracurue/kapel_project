'use strict';

/** Запись событий безопасности в журнал действий (admin_action_log, только INSERT). Паролей и e-mail в записи нет. */

const crypto = require('crypto');
const core = require('../admin_core');

function shortHash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
}

/**
 * scope: 'login' | 'password' | 'sign' | 'invite_code' | 'cancel_deletion'.
 * actorId — пользователь, чьим паролем/действием вызвана блокировка (если известен), иначе null.
 */
function lockout(scope, { actorId = null, targetUserId = null, key = '', retryAfterMs = 0 } = {}) {
  try {
    core.logAdmin(actorId, `${scope}_lockout`, targetUserId, { scope, lock_s: Math.round(retryAfterMs / 1000), key_hash: shortHash(key) });
  } catch (e) {
    console.error('security audit failed:', e && e.message);
  }
}

module.exports = { lockout, shortHash };
