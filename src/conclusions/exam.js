'use strict';

// W2.E (REQ-PSY-002): сеансы обследования и протоколы методик, вносимые частями. Ни одно поле не обязательно.

const db = require('../db');
const catalog = require('../instruments_catalog');
const assignments = require('../assignments');
const { parse } = require('./index');

const TEXT_MAX = 20000;
const OBS_MAX = 4000;
const today = () => new Date().toISOString().slice(0, 10);

/** Методики, которые врач вносит протоколом (заглушки clinician_entered). */
function pickable() {
  return catalog.groupedCatalog((e) => e.status === 'stub' && e.mode === 'clinician_entered');
}
const isPickable = (code) => { const e = catalog.getEntry(code); return !!e && e.status === 'stub' && e.mode === 'clinician_entered'; };

function numOrNull(v, label) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label}: неотрицательное число`);
  return n;
}

/** Нормализация протокола с частичным вводом: возвращает {protocol, hasContent}. */
function normalize(body) {
  const protocol = {
    duration_sec: numOrNull(body.duration_sec, 'Время'),
    errors: numOrNull(body.errors, 'Ошибки'),
    score: numOrNull(body.score, 'Баллы'),
    timer_sec: numOrNull(body.timer_sec, 'Секундомер'),
    observations: body.observations ? String(body.observations).replace(/\r\n/g, '\n').slice(0, OBS_MAX) : null,
    verbatim: body.verbatim ? String(body.verbatim).replace(/\r\n/g, '\n').slice(0, TEXT_MAX) : null,
  };
  const hasContent = Object.values(protocol).some((v) => v !== null && v !== '');
  return { protocol, hasContent };
}

function createSession(patientId, author, { date, title } = {}) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : today();
  const info = db.prepare('INSERT INTO exam_sessions (patient_id, author_id, session_date, title, plan_json) VALUES (?, ?, ?, ?, ?)')
    .run(patientId, author.id, d, String(title || '').slice(0, 120) || null, '[]');
  return Number(info.lastInsertRowid);
}

function getSession(id) {
  const s = db.prepare('SELECT * FROM exam_sessions WHERE id = ?').get(Number(id));
  return s ? { ...s, plan: parse(s.plan_json, []) } : null;
}

function listSessions(patientId, authorId) {
  return db.prepare('SELECT * FROM exam_sessions WHERE patient_id = ? AND author_id = ? ORDER BY session_date DESC, id DESC').all(patientId, authorId)
    .map((s) => { const withPlan = { ...s, plan: parse(s.plan_json, []) }; return { ...withPlan, progress: progress(withPlan) }; });
}

function setPlan(session, codes) {
  const plan = [...new Set(codes.filter(isPickable))];
  db.prepare("UPDATE exam_sessions SET plan_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(plan), session.id);
}

function addToPlan(session, code) {
  if (!isPickable(code)) return false;
  if (!session.plan.includes(code)) setPlan(session, [...session.plan, code]);
  return true;
}
function removeFromPlan(session, code) {
  setPlan(session, session.plan.filter((c) => c !== code));
}

function protocolRow(sessionId, code) {
  return db.prepare('SELECT * FROM catalog_protocols WHERE session_id = ? AND instrument = ? AND invalid_at IS NULL ORDER BY id DESC LIMIT 1').get(sessionId, code) || null;
}

/** «Внесено N из M»: внесено = есть содержимое или отмечено «готово». Не блокирует ничего. */
function progress(session) {
  const rows = db.prepare('SELECT instrument, protocol_json, status FROM catalog_protocols WHERE session_id = ? AND invalid_at IS NULL').all(session.id);
  const entered = new Set();
  for (const r of rows) {
    if (!session.plan.includes(r.instrument)) continue;
    const { hasContent } = normalize(parse(r.protocol_json, {}));
    if (hasContent || r.status === 'ready') entered.add(r.instrument);
  }
  return { entered: entered.size, total: session.plan.length };
}

function sessionView(session) {
  const items = session.plan.map((code) => {
    const e = catalog.getEntry(code);
    const row = protocolRow(session.id, code);
    return { code, title: e ? e.title : code, row, p: row ? parse(row.protocol_json, {}) : {}, ready: !!row && row.status === 'ready' };
  });
  return { items, progress: progress(session) };
}

/** Upsert протокола методики в сеансе. Пустой черновик не создаёт строку. */
function saveProtocol(session, author, code, body, { ready = false } = {}) {
  if (!isPickable(code)) return { ok: false, code: 400 };
  let norm;
  try { norm = normalize(body); } catch (e) { return { ok: false, code: 400, message: e.message }; }
  if (!session.plan.includes(code)) addToPlan(session, code);
  const existing = protocolRow(session.id, code);
  const json = JSON.stringify(norm.protocol);
  let id;
  if (existing) {
    id = existing.id;
    db.prepare('UPDATE catalog_protocols SET protocol_json = ?, status = ? WHERE id = ?').run(json, ready ? 'ready' : existing.status, id);
  } else if (norm.hasContent || ready) {
    id = Number(db.prepare("INSERT INTO catalog_protocols (patient_id, entered_by, instrument, test_date, protocol_json, status, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(session.patient_id, author.id, code, session.session_date, json, ready ? 'ready' : 'draft', session.id).lastInsertRowid);
  } else {
    return { ok: true, saved: false };
  }
  if (ready) assignments.completeWaiting(session.patient_id, code, id);
  else assignments.linkDraft(session.patient_id, code, id);
  db.prepare("UPDATE exam_sessions SET updated_at = datetime('now') WHERE id = ?").run(session.id);
  return { ok: true, saved: true, id };
}

function updateNote(session, note) {
  db.prepare("UPDATE exam_sessions SET note = ?, updated_at = datetime('now') WHERE id = ?").run(String(note || '').slice(0, TEXT_MAX) || null, session.id);
}

module.exports = { TEXT_MAX, OBS_MAX, pickable, isPickable, normalize, createSession, getSession, listSessions, addToPlan, removeFromPlan, progress, sessionView, saveProtocol, updateNote, protocolRow };
