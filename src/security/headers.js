'use strict';

/**
 * Заголовки безопасности (W2.S, REQ-SEC-005, REQ-SEC-014). Ресурсов с других источников нет:
 * скрипты и стили только из файлов `public/` (inline-скриптов и style="" в шаблонах нет),
 * поэтому CSP без 'unsafe-inline' и без nonce. Cache-Control: no-store задаётся в app.js (W0.6).
 */

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function middleware(req, res, next) {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  next();
}

module.exports = { middleware, CSP };
