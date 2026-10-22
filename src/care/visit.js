'use strict';

// Блок «К приёму» от модуля «уход» (опросник, приём по плану, непрочитанные). Только чтение, с учётом согласий.
const care = require('./index');

function forVisit(patientId, user, consentOk) {
  const out = { previsit: null, previsitOpen: false, adherenceLine: '', unread: 0, text: '' };
  if (!consentOk) return out;
  const pv = care.previsit.forClinician(patientId);
  out.previsit = pv.last;
  out.previsitOpen = !!pv.open;
  if (user.role === 'psychiatrist') {
    const v = care.meds.clinicianView(patientId, consentOk);
    if (v.adherence && v.adherence.expected > 0) {
      const a = v.adherence;
      out.adherenceLine = `Отметки приёма по плану за ${a.days} дн.: принято ${a.taken} из ${a.expected}, пропущено ${a.skipped}, без отметки ${a.unlogged + a.later} (отметки самого пациента, не контроль).`;
    }
  }
  out.unread = require('../db').prepare("SELECT COUNT(*) AS n FROM care_messages WHERE patient_id = ? AND clinician_id = ? AND sender_role = 'patient' AND read_at IS NULL").get(patientId, user.id).n;
  const L = [''];
  if (out.previsit) {
    L.push(`Анкета перед приёмом (${String(out.previsit.at).slice(0, 10)}):`);
    if (!out.previsit.rows.length) L.push('  - без ответов');
    for (const r of out.previsit.rows) L.push(`  - ${r.q} ${r.a}`);
  }
  if (out.adherenceLine) L.push(out.adherenceLine);
  if (out.unread) L.push(`Непрочитанных сообщений от пациента: ${out.unread}.`);
  out.text = L.length > 1 ? L.join('\n') + '\n' : '';
  return out;
}

module.exports = { forVisit };
