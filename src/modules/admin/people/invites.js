'use strict';

/**
 * Аудит H4, Т-3: приглашения в админке (F-95) — /api/v1/admin/invites.
 * Список без открытых кодов (в базе их нет, только хэш), создание кода для выбранного специалиста
 * (код показывается один раз), отзыв. Роль и CSRF проверяет контрактный контроль (src/access).
 */

const crypto = require('crypto');
const express = require('express');

const db = require('../../../db');
const P = require('../../../platform');
const core = require('../../../admin_core');

const router = express.Router();
const err = (req, res, status, code, extra) => P.sendError(req, res, status, code, extra);
const adminOnly = (req, res, next) =>
  ['admin', 'bootstrap_admin'].includes(req.user?.role) ? next() : err(req, res, 403, 'E-ACCESS');

const TTL_MS = 7 * 86400000;
const HOURLY_LIMIT = 30;
const inviteHash = (code) => P.sha(String(code).trim().toUpperCase());

router.get('/invites', adminOnly, (req, res) => {
  const nowIso = new Date().toISOString();
  const items = db
    .prepare(
      `SELECT i.id,i.status,i.expires_at,i.created_at,i.used_at,i.revoked_at,i.clinician_id,
              u.full_name AS clinician_name, u.role AS clinician_role
         FROM invite_codes i LEFT JOIN users u ON u.id=i.clinician_id
        ORDER BY i.id DESC LIMIT 200`,
    )
    .all()
    .map((row) => ({ ...row, status: row.status === 'active' && row.expires_at < nowIso ? 'expired' : row.status }));
  res.json({ items });
});

router.post('/invites', adminOnly, (req, res) => {
  const clinician = core.getUser((req.body || {}).clinician_id);
  if (!Number.isInteger(Number((req.body || {}).clinician_id)) || !clinician)
    return err(req, res, 422, 'E-VALIDATION', { fields: [{ field: 'clinician_id', key: 'err.e-validation' }] });
  if (!['psychiatrist', 'psychologist'].includes(clinician.role) || !core.isActiveAccount(clinician))
    return err(req, res, 409, 'E-NO-CANDIDATE');
  const current = new Date();
  const recent = db
    .prepare('SELECT count(*) n FROM invite_codes WHERE created_by=? AND created_at>=?')
    .get(req.user.id, P.iso(new Date(current.getTime() - 3600000))).n;
  if (recent >= HOURLY_LIMIT) return err(req, res, 429, 'E-RATE-LIMIT', { details: { retry_after_s: 60 } });
  const code = `CC-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const expires = P.iso(new Date(current.getTime() + TTL_MS));
  const info = db
    .prepare(
      "INSERT INTO invite_codes(code_hash,clinician_id,created_by,status,expires_at,created_at) VALUES (?,?,?,'active',?,?)",
    )
    .run(inviteHash(code), clinician.id, req.user.id, expires, P.iso(current));
  core.logAdmin(req.user.id, 'invite_create', clinician.id, { invite_id: Number(info.lastInsertRowid) });
  res.status(201).json({
    id: Number(info.lastInsertRowid),
    code,
    status: 'active',
    expires_at: expires,
    clinician_id: clinician.id,
  });
});

router.post('/invites/:id/revoke', adminOnly, (req, res) => {
  const invite = db.prepare('SELECT * FROM invite_codes WHERE id=?').get(Number(req.params.id));
  if (!invite) return err(req, res, 404, 'E-NOT-FOUND');
  if (invite.status !== 'active') return err(req, res, 409, 'E-STATUS');
  db.prepare("UPDATE invite_codes SET status='revoked',revoked_at=? WHERE id=?").run(P.iso(new Date()), invite.id);
  core.logAdmin(req.user.id, 'invite_revoke', invite.clinician_id, { invite_id: invite.id });
  res.json({ ok: true });
});

module.exports = router;
