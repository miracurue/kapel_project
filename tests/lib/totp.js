'use strict';

// TOTP по RFC 6238 (SHA-1, 30 с, 6 цифр) — тест сам считает код второго фактора (F-96), как приложение-аутентификатор.

const crypto = require('crypto');

function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = s.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = '';
  for (const ch of clean) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function secretFromUri(uri) {
  const m = String(uri).match(/[?&]secret=([A-Z2-7=]+)/i);
  if (!m) throw new Error('в otpauth-ссылке нет secret');
  return m[1];
}

function totp(secret, atMs = Date.now(), step = 30, digits = 6) {
  const counter = Math.floor(atMs / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits).toString().padStart(digits, '0');
  return code;
}

module.exports = { totp, secretFromUri };
