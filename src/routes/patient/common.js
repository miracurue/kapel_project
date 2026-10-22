'use strict';

// Общие хелперы кабинета пациента.

const db = require('../../db');
const { INSTRUMENTS } = require('../../instruments');
const catalog = require('../../instruments_catalog');

// Страница кабинета пациента: без сессии — на вход, не пациент — 403.
function patientPage(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'patient') {
    return res.status(403).render('error', { message: 'Недостаточно прав для этого раздела.' });
  }
  next();
}

// Возврат только на относительный путь внутри сайта (REQ-SEC-016).
function safeLocal(target, fallback) {
  if (typeof target !== 'string') return fallback;
  if (!/^\/(?!\/)[^\\:\s]*$/.test(target)) return fallback;
  return target;
}

function notFound(res, message = 'Не найдено.') {
  return res.status(404).render('error', { message });
}

// Критический ответ, при котором на самой странице нужен блок поддержки (REQ-PAT-009).
// PHQ-9: пункт 9 > 0; C-SSRS: любое «да»; для остальных методик критических пунктов нет.
function criticalHit(code, answers) {
  const ins = INSTRUMENTS[code];
  if (!ins) return false;
  if (code === 'cssrs') return Object.values(answers).some((v) => Number(v) > 0);
  if (ins.criticalItemIndex !== null && ins.criticalItemIndex !== undefined) {
    return Number(answers[ins.criticalItemIndex]) > 0;
  }
  return false;
}

function criticalIndexes(code) {
  const ins = INSTRUMENTS[code];
  if (!ins) return [];
  if (code === 'cssrs') return ins.items.map((_, i) => i);
  return ins.criticalItemIndex !== null && ins.criticalItemIndex !== undefined ? [ins.criticalItemIndex] : [];
}

function itemText(item) {
  return typeof item === 'string' ? item : item.text;
}

function clinicianLink(patientId) {
  return db
    .prepare(
      `SELECT ca.clinician_id, u.full_name, u.role FROM care_assignments ca JOIN users u ON u.id = ca.clinician_id
       WHERE ca.patient_id = ? ORDER BY ca.id ASC`
    )
    .all(patientId);
}

function todayStr(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

module.exports = { patientPage, safeLocal, notFound, criticalHit, criticalIndexes, itemText, clinicianLink, todayStr, catalog };
