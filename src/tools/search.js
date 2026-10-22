'use strict';

/**
 * Глобальный поиск врача (REQ-TLS-007) по своим заметкам, своим материалам ИИ-пространства и шаблонам. Видно только
 * содержимое, доступное автору: заметки — только свои и только по ещё закреплённым пациентам; материалы и диалоги — свои.
 */

const db = require('../db');
const docs = require('./documents');
const context = require('../ai/workspace/context');
const { norm } = require('../triage_data');

const MAX = 30;

function snippet(text, q) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const i = norm(t).indexOf(q);
  if (i < 0) return t.slice(0, 140);
  const from = Math.max(0, i - 50);
  return (from ? '…' : '') + t.slice(from, from + 160) + (from + 160 < t.length ? '…' : '');
}

function search(user, rawQ) {
  const q = norm(String(rawQ || '').slice(0, 100));
  const out = { q, notes: [], materials: [], threads: [], templates: [] };
  if (q.length < 2) return out;
  for (const n of db.prepare(
    `SELECT n.id, n.patient_id, n.body, n.tags, n.note_date, n.created_at, u.full_name
     FROM clinician_notes n JOIN care_assignments ca ON ca.patient_id = n.patient_id AND ca.clinician_id = n.author_id
     JOIN users u ON u.id = n.patient_id WHERE n.author_id = ? ORDER BY n.id DESC LIMIT 3000`).all(user.id)) {
    if (out.notes.length >= MAX) break;
    if (norm(`${n.body || ''} ${n.tags || ''}`).includes(q)) out.notes.push({ patientId: n.patient_id, patient: n.full_name, date: n.note_date || String(n.created_at).slice(0, 10), text: snippet(n.body || n.tags, q) });
  }
  const hasTable = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
  if (hasTable('ai_attachments')) {
    for (const a of db.prepare('SELECT id, thread_id, patient_id, name, text_extracted FROM ai_attachments WHERE owner_user_id = ? ORDER BY id DESC LIMIT 500').all(user.id)) {
      if (out.materials.length >= MAX) break;
      if (context.threadLocked(user, a.patient_id)) continue; // M-6: привязанные к пациенту без закрепления не ищем
      if (norm(`${a.name} ${a.text_extracted || ''}`).includes(q)) out.materials.push({ name: a.name, threadId: a.thread_id, text: snippet(a.text_extracted, q) });
    }
  }
  if (hasTable('ai_threads')) {
    const cols = db.prepare('PRAGMA table_info(ai_threads)').all().map((c) => c.name);
    if (cols.includes('owner_user_id') && cols.includes('title')) {
      for (const t of db.prepare('SELECT id, title, patient_id FROM ai_threads WHERE owner_user_id = ? ORDER BY id DESC LIMIT 500').all(user.id)) {
        if (out.threads.length >= MAX) break;
        if (context.threadLocked(user, t.patient_id)) continue;
        if (norm(t.title || '').includes(q)) out.threads.push({ id: t.id, title: t.title });
      }
    }
  }
  const all = docs.listFor(user.id);
  for (const t of [...all.own, ...all.builtin]) {
    if (norm(`${t.title} ${t.body}`).includes(q)) out.templates.push({ id: t.id, title: t.title, own: t.own, text: snippet(t.body, q) });
  }
  out.total = out.notes.length + out.materials.length + out.threads.length + out.templates.length;
  return out;
}

module.exports = { search };
