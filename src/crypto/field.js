'use strict';

/**
 * Шифрование отдельных полей уровня приложения (F-80, PD-05): AES-256-GCM.
 * Формат: `v1:<key_id>:<base64(nonce[12] | шифротекст | тег[16])>`.
 * Ключ приходит из переменных окружения (PII_ENC_KEY и т. п.), в базе не хранится.
 * key_id вычисляется из самого ключа, поэтому ротация ключа меняет идентификатор версии.
 * decrypt не бросает исключений: при чужом/сменённом ключе возвращает { ok: false } —
 * вызывающий показывает ключи вместо значений и предупреждение E-PSEUDO-DECRYPT.
 */

const crypto = require('crypto');

function keyBytes(key) {
  const buf = Buffer.from(String(key || ''), 'base64');
  if (buf.length === 32) return buf;
  return crypto.createHash('sha256').update(String(key || '')).digest();
}

function keyIdFor(key) {
  return crypto.createHash('sha256').update(String(key || '')).digest('hex').slice(0, 8);
}

/** @returns {string} `v1:<key_id>:<base64>` */
function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(key), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const body = Buffer.concat([iv, enc, tag]).toString('base64');
  return `v1:${keyIdFor(key)}:${body}`;
}

/** @returns {{ok: true, value: string} | {ok: false, error: string}} */
function decrypt(key, stored) {
  try {
    const parts = String(stored || '').split(':');
    if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) return { ok: false, error: 'format' };
    const raw = Buffer.from(parts[2], 'base64');
    if (raw.length < 12 + 16) return { ok: false, error: 'format' };
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const enc = raw.subarray(12, raw.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(key), iv);
    decipher.setAuthTag(tag);
    const value = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: 'decrypt' };
  }
}

module.exports = { encrypt, decrypt, keyIdFor };
