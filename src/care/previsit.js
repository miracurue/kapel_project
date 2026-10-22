'use strict';

// Опросник перед приёмом (REQ-PAT-025): включает врач, заполняет пациент, ответы идут в «К приёму». Всё необязательно.
const db = require('../db');
const { QUESTIONS } = require('../content/previsit');

const MAX_TEXT = 1000;

function openFor(patientId) {
  return db.prepare("SELECT * FROM previsit_forms WHERE patient_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(patientId) || null;
}

function request(patientId, clinicianId) {
  const ex = openFor(patientId);
  if (ex) return { id: ex.id, existed: true };
  return { id: db.prepare('INSERT INTO previsit_forms (patient_id, requested_by) VALUES (?, ?)').run(patientId, clinicianId).lastInsertRowid };
}

function cancel(patientId) {
  return db.prepare("UPDATE previsit_forms SET status = 'cancelled' WHERE patient_id = ? AND status = 'open'").run(patientId).changes;
}

/** Нормализация ответов по определению вопросов; пустые отбрасываются. Возвращает {answers, texts}. */
function parseAnswers(body) {
  const answers = {};
  const texts = [];
  for (const q of QUESTIONS) {
    const raw = String(body[q.id] === undefined ? '' : body[q.id]).trim();
    if (!raw) continue;
    if (q.type === 'scale') {
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= 10) answers[q.id] = n;
    } else if (q.type === 'choice') {
      if (q.options.some((o) => o.v === raw)) answers[q.id] = raw;
    } else {
      answers[q.id] = raw.slice(0, MAX_TEXT);
      texts.push(answers[q.id]);
    }
  }
  return { answers, texts };
}

function submit(patientId, answers) {
  const f = openFor(patientId);
  if (!f) return null;
  db.prepare("UPDATE previsit_forms SET status = 'submitted', answers_json = ?, submitted_at = ? WHERE id = ?").run(JSON.stringify(answers), new Date().toISOString(), f.id);
  return f.id;
}

function skip(patientId) {
  return db.prepare("UPDATE previsit_forms SET status = 'skipped' WHERE patient_id = ? AND status = 'open'").run(patientId).changes;
}

/** Для врача: последний отправленный опросник и открытый запрос. */
function forClinician(patientId) {
  const last = db.prepare("SELECT * FROM previsit_forms WHERE patient_id = ? AND status = 'submitted' ORDER BY id DESC LIMIT 1").get(patientId);
  let rows = [];
  if (last) {
    const a = JSON.parse(last.answers_json || '{}');
    rows = QUESTIONS.filter((q) => a[q.id] !== undefined).map((q) => ({
      q: q.text, a: q.type === 'choice' ? q.options.find((o) => o.v === a[q.id]).t : String(a[q.id]),
    }));
  }
  return { open: openFor(patientId), last: last ? { at: last.submitted_at, rows } : null };
}

module.exports = { openFor, request, cancel, parseAnswers, submit, skip, forClinician };
