'use strict';

/**
 * Шаблоны документов врача (REQ-TLS-002): памятки, рекомендации, направление.
 * Встроенные тексты — ЗАГЛУШКИ review-required: структура без клинического содержания, содержательные части
 * помечены [в квадратных скобках] и заполняются врачом. Свои шаблоны — таблица tool_templates (личные, по владельцу).
 * Плейсхолдеры [ФИО], [дата], [врач] подставляются врачом при выгрузке; данные пациента подставляются только
 * вручную или по явному выбору пациента из закреплённых. Экспорт переиспользует src/ai/workspace/export.js (W1.C2).
 */

const db = require('../db');
const exporter = require('../ai/workspace/export');
const { canAccessPatient } = require('../permissions');

const REVIEW_NOTE = 'Текст-заглушка: ожидает клинического ревью, не является утверждённой памяткой или рекомендацией.';
const TITLE_MAX = 120;
const BODY_MAX = 10000;

const BUILTIN = [
  {
    id: 'b-visit',
    title: 'Памятка пациенту: следующий приём',
    review: true,
    body: [
      'Памятка пациенту',
      '',
      'Пациент: [ФИО]',
      'Дата: [дата]',
      'Врач: [врач]',
      '',
      'Следующий приём: [дата и время приёма]',
      'Место / формат: [кабинет, адрес или ссылка]',
      'Что взять с собой: [перечень по решению врача]',
      '',
      'Если состояние резко ухудшилось или есть мысли о причинении себе вреда — не ждите приёма: звоните 112.',
      'Контакт клиники: [телефон клиники]',
    ].join('\n'),
  },
  {
    id: 'b-service',
    title: 'Памятка пациенту: как пользоваться сервисом',
    review: true,
    body: [
      'Памятка: тесты и дневник в сервисе',
      '',
      'Пациент: [ФИО]',
      'Дата: [дата]',
      '',
      'Назначенные врачом тесты находятся в разделе «Тесты». Проходить их можно в удобное время, в своём темпе.',
      'Дневник ведётся по желанию. Врач видит только то, чем вы решили поделиться.',
      'Сервис — демонстрационный: он не ставит диагноз и не заменяет приём врача.',
      'Срочная помощь: 112.',
      '',
      '[дополнения врача]',
    ].join('\n'),
  },
  {
    id: 'b-recs',
    title: 'Рекомендации пациенту (заготовка)',
    review: true,
    body: [
      'Рекомендации',
      '',
      'Пациент: [ФИО]',
      'Дата: [дата]',
      'Врач: [врач]',
      '',
      '[текст рекомендаций — вносит врач]',
      '',
      'Повторный визит / повторное тестирование: [срок по решению врача]',
      'При ухудшении состояния: 112 или контакт [телефон клиники].',
    ].join('\n'),
  },
  {
    id: 'b-referral',
    title: 'Направление (заготовка)',
    review: true,
    body: [
      'Направление',
      '',
      'Пациент: [ФИО]',
      'Дата: [дата]',
      'Направляет: [врач]',
      'Кому / куда: [специалист или организация]',
      'Цель направления: [цель]',
      'Краткие сведения для получателя: [вносит врач]',
      '',
      'Подпись: ______________  [врач]',
    ].join('\n'),
  },
];

const PLACEHOLDER_RE = /\[[^\[\]\n]{1,60}\]/g;

function placeholders(body) {
  return [...new Set(String(body || '').match(PLACEHOLDER_RE) || [])];
}

function fill(body, values) {
  let out = String(body || '');
  for (const [k, v] of Object.entries(values || {})) {
    if (v === undefined || v === null || String(v).trim() === '') continue; // пустое поле оставляет плейсхолдер
    out = out.split(k).join(String(v));
  }
  return out;
}

// ---------- свои шаблоны ----------

const clean = (s, max) => String(s || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);

function listFor(ownerId) {
  const own = db.prepare('SELECT id, title, body, created_at, updated_at FROM tool_templates WHERE owner_id = ? ORDER BY title').all(ownerId)
    .map((r) => ({ ...r, id: `u${r.id}`, own: true, review: false }));
  return { builtin: BUILTIN.map((b) => ({ ...b, own: false })), own };
}

function find(ownerId, id) {
  const sid = String(id || '');
  const b = BUILTIN.find((x) => x.id === sid);
  if (b) return { ...b, own: false };
  const m = /^u(\d+)$/.exec(sid);
  if (!m) return null;
  const r = db.prepare('SELECT * FROM tool_templates WHERE id = ? AND owner_id = ?').get(Number(m[1]), ownerId);
  return r ? { id: sid, title: r.title, body: r.body, own: true, review: false } : null;
}

function create(ownerId, title, body) {
  const t = clean(title, TITLE_MAX).trim();
  const b = clean(body, BODY_MAX).trim();
  if (!t || !b) return { ok: false, error: 'Укажите название и текст шаблона.' };
  const info = db.prepare('INSERT INTO tool_templates (owner_id, title, body) VALUES (?, ?, ?)').run(ownerId, t, b);
  return { ok: true, id: `u${info.lastInsertRowid}` };
}

function update(ownerId, id, title, body) {
  const m = /^u(\d+)$/.exec(String(id));
  if (!m) return { ok: false, error: 'Встроенные шаблоны не редактируются: сделайте копию.' };
  const t = clean(title, TITLE_MAX).trim();
  const b = clean(body, BODY_MAX).trim();
  if (!t || !b) return { ok: false, error: 'Укажите название и текст шаблона.' };
  const r = db.prepare("UPDATE tool_templates SET title = ?, body = ?, updated_at = datetime('now') WHERE id = ? AND owner_id = ?").run(t, b, Number(m[1]), ownerId);
  return r.changes ? { ok: true } : { ok: false, error: 'Шаблон не найден.' };
}

function remove(ownerId, id) {
  const m = /^u(\d+)$/.exec(String(id));
  if (!m) return false;
  return db.prepare('DELETE FROM tool_templates WHERE id = ? AND owner_id = ?').run(Number(m[1]), ownerId).changes > 0;
}

// ---------- выгрузка ----------

/** Документ для exporter: шапка без ФИО в имени файла, метка «черновик» обязательна. */
function toDoc(tpl, text) {
  return {
    title: tpl ? tpl.title : 'Документ',
    draftLabel: tpl && tpl.review ? 'ЧЕРНОВИК · текст-заглушка, ожидает клинического ревью' : 'ЧЕРНОВИК · проверьте перед выдачей',
    disclaimer: tpl && tpl.review ? REVIEW_NOTE : 'Документ подготовлен врачом из шаблона; сервис не проверял его содержание.',
    items: [{ text }],
  };
}

function fileBase(fmt, d = new Date()) {
  return exporter.fileName(fmt, d);
}

/** Выбранный пациент (по явному выбору врача) -> ФИО для подстановки; null, если не закреплён. */
function patientNameFor(user, patientId) {
  const pid = Number(patientId);
  if (!pid || !canAccessPatient(user, pid, db)) return null;
  const r = db.prepare('SELECT full_name FROM users WHERE id = ?').get(pid);
  return r ? r.full_name : null;
}

module.exports = { BUILTIN, REVIEW_NOTE, placeholders, fill, listFor, find, create, update, remove, toDoc, fileBase, patientNameFor, TITLE_MAX, BODY_MAX };
