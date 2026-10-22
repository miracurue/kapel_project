'use strict';

/**
 * «Связаться с человеком» (REQ-AIP-005, REQ-CRI-005): обращение пациента к врачу.
 * Это НЕ Tier-эскалация и не обещание оповещения: запись видна врачу в кабинете (очередь «обращения пациента»,
 * показывает W1.B1) либо, если врача нет, — администратору. Внешних уведомлений нет.
 * Текст обращения тоже проходит кризисный шлюз (REQ-CRI-011).
 */

const db = require('../db');
const gate = require('./crisisGate');
const threads = require('./threads');
const texts = require('./texts');

const MAX_LEN = 2000;
const DEFAULT_TEXT = 'Мне сейчас тяжело. Прошу связаться со мной, когда сможете.';

function primaryClinicianId(patientId) {
  const row = db.prepare('SELECT clinician_id FROM care_assignments WHERE patient_id = ? ORDER BY id ASC LIMIT 1').get(patientId);
  return row ? row.clinician_id : null;
}

function createContactRequest({ user, text, threadId = null }) {
  const body = String(text || '').trim();
  if (!body) return { status: 400, error: texts.EMPTY, draft: '' };
  if (body.length > MAX_LEN) return { status: 422, error: texts.TOO_LONG(MAX_LEN), draft: body };
  const clinicianId = primaryClinicianId(user.id);
  const thread = threadId ? threads.getThread(user.id, threadId, 'patient') : null;
  // W1.A: единая таблица обращений patient_appeals (её читает кабинет врача); patient_contact_requests больше не пишется
  const appeal = require('../appeals').createAppeal({ patientId: user.id, message: body });
  const info = { lastInsertRowid: appeal.id };
  const g = gate.handleText({ patientId: user.id, text: body, source: 'contact_request', label: 'Кризисная фраза в обращении к врачу' });
  threads.audit({ userId: user.id, role: user.role, threadId: thread ? thread.id : null, event: 'contact_request', crisis: g.crisis });
  return {
    status: 200,
    id: info.lastInsertRowid,
    toAdmin: appeal.routedTo === 'admin',
    crisis: g.crisis,
    message: appeal.routedTo === 'clinician' ? texts.CONTACT_SENT_WITH_CLINICIAN : texts.CONTACT_SENT_NO_CLINICIAN,
  };
}

module.exports = { createContactRequest, DEFAULT_TEXT, primaryClinicianId, MAX_LEN };
