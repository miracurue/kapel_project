'use strict';

/**
 * Детерминированный кризисный шлюз для свободного текста пациента (REQ-AIP-006/007, REQ-CRI-011).
 * Переиспользуется каждым свободным вводом до согласий, лимитов и ИИ.
 */
const db = require('../db');
const chatbot = require('../chatbot');
const riskClassifier = require('../riskClassifier');
const crisisProtocol = require('../crisisProtocol');
const escalation = require('../escalation');

function screen(text) {
  const t = String(text || '');
  const intent = chatbot.detectIntent(t);
  let nlpCategories = riskClassifier.classifyFreeText(t);
  const nssiDisclosed = riskClassifier.detectNssiDisclosure(t);
  if (intent === 'crisis' && nlpCategories.length === 0)
    nlpCategories = [riskClassifier.CATEGORIES.INTENT_HOPELESSNESS];
  if (nlpCategories.length === 0 && !nssiDisclosed)
    return {
      crisis: false,
      tier: crisisProtocol.TIERS.ROUTINE,
      triggers: [],
      nlpCategories,
      nssiDisclosed,
    };
  const { tier, triggers } = crisisProtocol.evaluateCrisisTier({ nlpCategories, nssiDisclosed });
  return {
    crisis: tier > crisisProtocol.TIERS.ROUTINE,
    tier,
    triggers,
    nlpCategories,
    nssiDisclosed,
  };
}

function hasClinician(patientId) {
  return !!db.prepare('SELECT 1 FROM care_assignments WHERE patient_id = ?').get(patientId);
}

function handleText({ patientId, text, source = 'chatbot', label = 'Кризисная фраза в чат-боте' }) {
  const s = screen(text);
  if (!s.crisis)
    return {
      ...s,
      escalationId: null,
      hasClinician: hasClinician(patientId),
      delivered: false,
    };
  const clinician = hasClinician(patientId);
  try {
    const reasons = [`${label}: "${String(text).slice(0, 200)}"`];
    const args = {
      patientId,
      instrument: source,
      reasons,
      tier: s.tier,
      triggers: s.triggers,
    };
    const escalationId = escalation.mergeIntoOpen(args) || escalation.createEscalation(args);
    return { ...s, escalationId, hasClinician: clinician, delivered: true };
  } catch (e) {
    console.error('crisisGate: escalation failed', e && e.message);
    return { ...s, escalationId: null, hasClinician: clinician, delivered: false };
  }
}

// Адаптеры для контрактного API В3: та же чистая классификация, отдельная
// запись события в новой схеме и единая карточка экстренной помощи.
function detect(text) {
  return screen(text).crisis;
}

function card(delivered = true) {
  return {
    contacts: [{ title: 'Экстренные службы', phone: '112' }],
    signal_delivered: delivered,
  };
}

module.exports = { screen, handleText, hasClinician, detect, card };
