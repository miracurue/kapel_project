'use strict';

// W2.E: заключения клинического психолога. Шаблон — заглушка (review-required), клинических формулировок нет.
// Версионирование: подписанная версия неизменяема (триггер в БД), правка подписанного = новая версия с причиной.

const crypto = require('crypto');
const db = require('../db');
const catalog = require('../instruments_catalog');
const { INSTRUMENTS } = require('../instruments');
const outputFilter = require('../ai/outputFilter');

const SIGN_NOTICE = 'Внутренняя отметка сервиса, не квалифицированная электронная подпись.';
const REVIEW_NOTE = 'Структура и названия разделов — заглушка (review-required): требуют утверждения клиническим владельцем.';
const DRAFT_LABEL = 'ЧЕРНОВИК';
const FIELD_MAX = 20000;
const TITLE_MAX = 200;

// Названия разделов — нейтральные заглушки. Содержимое пустое: автогенерируемых формулировок нет.
const SECTIONS = Object.freeze([
  { key: 'reason', label: 'Основание и цель обследования', hint: 'Свободный текст.' },
  { key: 'conditions', label: 'Условия и ход обследования', hint: 'Сеансы, длительность, поведение при обследовании — по вашим наблюдениям.' },
  { key: 'protocols', label: 'Использованные методики и внесённые данные', hint: 'Подставляется из протоколов; полностью редактируется.', auto: true },
  { key: 'findings', label: 'Описание результатов', hint: 'Свободный текст.' },
  { key: 'summary', label: 'Заключение психолога', hint: 'Свободный текст психолога.' },
  { key: 'recommendations', label: 'Рекомендации', hint: 'Свободный текст психолога.' },
]);
const SECTION_KEYS = SECTIONS.map((s) => s.key);

// Подсказки по структуре — только напоминания, не содержание; проходят пост-фильтр REQ-AIP-010.
const REMINDERS = Object.freeze([
  'Проверьте, что все проведённые методики отражены в разделе о методиках.',
  'Отделяйте наблюдаемое поведение от вашей интерпретации.',
  'Заключение психолога не заменяет решение врача; формулировки выбирает специалист.',
  'Перед подписью перечитайте текст: после подписи он блокируется, правка создаёт новую версию.',
]);
const remindersSafe = () => REMINDERS.filter((t) => outputFilter.check(t).ok);

function nowIso() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
const clip = (v, n) => String(v == null ? '' : v).replace(/\r\n/g, '\n').slice(0, n);

function parse(s, fb) { try { return JSON.parse(s); } catch { return fb; } }

function cleanSections(input = {}) {
  const out = {};
  for (const k of SECTION_KEYS) out[k] = clip(input[k], FIELD_MAX);
  return out;
}

/** Контрольная сумма версии: SHA-256 по каноническому JSON (id, номер, заголовок, разделы, ссылки, причина). */
function checksumOf(v) {
  const sections = v.sections && typeof v.sections === 'object' ? v.sections : parse(v.sections_json, {});
  const refs = v.refs || parse(v.protocol_refs_json, []);
  const canon = JSON.stringify({
    c: Number(v.conclusion_id), v: Number(v.version), t: v.title || '',
    s: SECTION_KEYS.map((k) => [k, sections[k] || '']), r: refs, why: v.reason || '',
  });
  return crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
}

function hydrate(row) {
  if (!row) return null;
  return { ...row, sections: cleanSections(parse(row.sections_json, {})), refs: parse(row.protocol_refs_json, []) };
}

// ---------- протоколы для подстановки ----------

function instrumentTitle(code) {
  const e = catalog.getEntry(code);
  return e ? e.title : (INSTRUMENTS[code] ? INSTRUMENTS[code].title : code);
}

/** Протоколы пациента (без ошибочных): [{kind, id, code, title, date, line}] */
function protocolsOf(patientId) {
  const out = [];
  for (const r of db.prepare('SELECT * FROM catalog_protocols WHERE patient_id = ? AND invalid_at IS NULL ORDER BY test_date, id').all(patientId)) {
    const p = parse(r.protocol_json, {});
    const bits = [];
    if (p.duration_sec != null) bits.push(`время ${p.duration_sec} сек`);
    if (p.errors != null) bits.push(`ошибок ${p.errors}`);
    if (p.score != null) bits.push(`балл ${p.score}${catalog.isStub(r.instrument) ? ' (демо-балл, заглушка)' : ''}`);
    if (p.observations) bits.push(`наблюдения: ${clip(p.observations, 300)}`);
    out.push({ kind: 'protocol', id: r.id, code: r.instrument, title: instrumentTitle(r.instrument), date: r.test_date, status: r.status,
      line: `• ${instrumentTitle(r.instrument)}, ${r.test_date}${r.status === 'draft' ? ' [протокол не завершён]' : ''}${bits.length ? ': ' + bits.join('; ') : ''}` });
  }
  for (const r of db.prepare('SELECT * FROM offline_results WHERE patient_id = ? AND invalid_at IS NULL ORDER BY test_date, id').all(patientId)) {
    out.push({ kind: 'offline', id: r.id, code: r.instrument, title: instrumentTitle(r.instrument), date: r.test_date,
      line: `• ${instrumentTitle(r.instrument)} (очно, бланк), ${r.test_date}: итог ${r.total_score}` });
  }
  return out;
}

function protocolsText(list) {
  return list.length ? list.map((p) => p.line).join('\n') : '';
}

// ---------- CRUD ----------

function latestVersion(conclusionId) {
  return hydrate(db.prepare('SELECT * FROM conclusion_versions WHERE conclusion_id = ? ORDER BY version DESC LIMIT 1').get(conclusionId));
}
function lastSigned(conclusionId) {
  return hydrate(db.prepare("SELECT * FROM conclusion_versions WHERE conclusion_id = ? AND status = 'signed' ORDER BY version DESC LIMIT 1").get(conclusionId));
}
function getVersion(conclusionId, n) {
  return hydrate(db.prepare('SELECT * FROM conclusion_versions WHERE conclusion_id = ? AND version = ?').get(conclusionId, Number(n)));
}
function versions(conclusionId) {
  return db.prepare('SELECT v.*, u.full_name AS creator FROM conclusion_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.conclusion_id = ? ORDER BY v.version DESC').all(conclusionId).map(hydrate);
}
function getConclusion(id) {
  return db.prepare('SELECT * FROM conclusions WHERE id = ?').get(Number(id)) || null;
}

function create(patientId, author, { title } = {}) {
  const list = protocolsOf(patientId);
  const sections = cleanSections({ protocols: protocolsText(list) });
  const refs = list.map((p) => ({ kind: p.kind, id: p.id }));
  return db.transaction(() => {
    const c = db.prepare('INSERT INTO conclusions (patient_id, author_id, title) VALUES (?, ?, ?)').run(patientId, author.id, clip(title, TITLE_MAX) || null);
    const id = Number(c.lastInsertRowid);
    db.prepare('INSERT INTO conclusion_versions (conclusion_id, patient_id, version, status, title, sections_json, protocol_refs_json, created_by) VALUES (?, ?, 1, ?, ?, ?, ?, ?)')
      .run(id, patientId, 'draft', clip(title, TITLE_MAX) || null, JSON.stringify(sections), JSON.stringify(refs), author.id);
    return id;
  })();
}

/** Сохранение черновика. Ничего не обязательно. Подписанная версия — отказ (locked). */
function saveDraft(conclusionId, { title, sections }) {
  const v = latestVersion(conclusionId);
  if (!v) return { ok: false, code: 404 };
  if (v.status === 'signed') return { ok: false, code: 409, locked: true };
  const clean = cleanSections({ ...v.sections, ...(sections || {}) });
  const t = title === undefined ? v.title : clip(title, TITLE_MAX) || null;
  db.prepare("UPDATE conclusion_versions SET title = ?, sections_json = ?, updated_at = datetime('now') WHERE id = ?").run(t, JSON.stringify(clean), v.id);
  db.prepare("UPDATE conclusions SET title = ?, updated_at = datetime('now') WHERE id = ?").run(t, conclusionId);
  return { ok: true, version: v.version };
}

/** Заново подставить протоколы в раздел о методиках (текст раздела заменяется, ссылки обновляются). */
function refillProtocols(conclusionId, patientId) {
  const v = latestVersion(conclusionId);
  if (!v || v.status === 'signed') return { ok: false, code: 409 };
  const list = protocolsOf(patientId);
  db.prepare("UPDATE conclusion_versions SET sections_json = ?, protocol_refs_json = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify({ ...v.sections, protocols: protocolsText(list) }), JSON.stringify(list.map((p) => ({ kind: p.kind, id: p.id }))), v.id);
  return { ok: true, count: list.length };
}

function sign(conclusionId, user, method) {
  const v = latestVersion(conclusionId);
  if (!v) return { ok: false, code: 404 };
  if (v.status === 'signed') return { ok: false, code: 409 };
  const at = nowIso();
  const sum = checksumOf(v);
  db.prepare("UPDATE conclusion_versions SET status = 'signed', signed_by = ?, signed_name = ?, signed_at = ?, sign_method = ?, checksum = ? WHERE id = ?")
    .run(user.id, user.full_name, at, method, sum, v.id);
  db.prepare("UPDATE conclusions SET updated_at = datetime('now') WHERE id = ?").run(conclusionId);
  return { ok: true, version: v.version, checksum: sum, signed_at: at };
}

/** Правка подписанного: новая версия-черновик с причиной (обязательна). */
function revise(conclusionId, user, reason) {
  const v = latestVersion(conclusionId);
  if (!v) return { ok: false, code: 404 };
  if (v.status !== 'signed') return { ok: false, code: 409, message: 'Последняя версия ещё не подписана — её можно просто править.' };
  const why = clip(reason, 1000).trim();
  if (!why) return { ok: false, code: 400, message: 'Укажите причину правки: она сохраняется в истории версий.' };
  db.prepare('INSERT INTO conclusion_versions (conclusion_id, patient_id, version, status, title, sections_json, protocol_refs_json, reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(conclusionId, v.patient_id, v.version + 1, 'draft', v.title, v.sections_json, v.protocol_refs_json, why, user.id);
  db.prepare("UPDATE conclusions SET released_to_patient = 0, updated_at = datetime('now') WHERE id = ?").run(conclusionId);
  return { ok: true, version: v.version + 1 };
}

function setRelease(conclusionId, on) {
  if (on && !lastSigned(conclusionId)) return { ok: false, code: 409 };
  db.prepare('UPDATE conclusions SET released_to_patient = ?, released_at = ? WHERE id = ?').run(on ? 1 : 0, on ? nowIso() : null, conclusionId);
  return { ok: true };
}

/** Проверка целостности подписанной версии. */
function integrityOk(v) {
  return v.status === 'signed' && !!v.checksum && checksumOf(v) === v.checksum;
}

// ---------- списки/поиск ----------

function listFor(user, { patientId = null, q = '', status = '', from = '', to = '' } = {}) {
  const rows = db.prepare(`
    SELECT c.*, p.full_name AS patient_name, a.full_name AS author_name
    FROM conclusions c JOIN users p ON p.id = c.patient_id JOIN users a ON a.id = c.author_id
    WHERE c.patient_id IN (SELECT patient_id FROM care_assignments WHERE clinician_id = ?) ${patientId ? 'AND c.patient_id = ?' : ''}
    ORDER BY COALESCE(c.updated_at, c.created_at) DESC, c.id DESC`).all(...(patientId ? [user.id, patientId] : [user.id]));
  const needle = String(q || '').toLowerCase().replace(/ё/g, 'е').trim();
  const out = [];
  for (const c of rows) {
    const latest = latestVersion(c.id);
    const signed = lastSigned(c.id);
    // любой закреплённый клиницист читает и черновики (только чтение; пишет и подписывает автор-психолог)
    const mine = c.author_id === user.id;
    if (!mine && user.role !== 'psychiatrist' && !signed) continue;
    const shown = (mine || user.role === 'psychiatrist') ? latest : signed;
    const st = latest.status === 'draft' ? (signed ? 'revision' : 'draft') : 'signed';
    if (status === 'draft' && st === 'signed') continue;
    if (status === 'signed' && !signed) continue;
    const day = String((shown.signed_at || shown.created_at) || '').slice(0, 10);
    if (from && day < from) continue;
    if (to && day > to) continue;
    if (needle) {
      const hay = `${shown.title || ''} ${Object.values(shown.sections).join(' ')} ${c.patient_name}`.toLowerCase().replace(/ё/g, 'е');
      if (!hay.includes(needle)) continue;
    }
    out.push({ ...c, mine, state: st, latest: shown, signed, versionsCount: latest.version });
  }
  return out;
}

/** Поиск по протоколам своих пациентов: текст, методика, дата (REQ-PSY-009). */
function searchProtocols(user, { q = '', from = '', to = '' } = {}) {
  const needle = String(q || '').toLowerCase().replace(/ё/g, 'е').trim();
  if (!needle && !from && !to) return [];
  const rows = db.prepare(`
    SELECT cp.*, p.full_name AS patient_name FROM catalog_protocols cp JOIN users p ON p.id = cp.patient_id
    WHERE cp.invalid_at IS NULL AND cp.entered_by = ? AND cp.patient_id IN (SELECT patient_id FROM care_assignments WHERE clinician_id = ?)
    ORDER BY cp.test_date DESC, cp.id DESC LIMIT 300`).all(user.id, user.id);
  return rows.filter((r) => {
    if (from && r.test_date < from) return false;
    if (to && r.test_date > to) return false;
    if (!needle) return true;
    const p = parse(r.protocol_json, {});
    return `${instrumentTitle(r.instrument)} ${r.instrument} ${p.observations || ''} ${p.verbatim || ''} ${r.test_date}`.toLowerCase().replace(/ё/g, 'е').includes(needle);
  }).slice(0, 50).map((r) => ({ id: r.id, patient_id: r.patient_id, patient_name: r.patient_name, title: instrumentTitle(r.instrument), date: r.test_date, session_id: r.session_id }));
}

// ---------- документ для экспорта ----------

function exportDoc(conclusion, v, patientName, authorName) {
  const signed = v.status === 'signed';
  const items = [{ who: 'Пациент', text: patientName }];
  for (const s of SECTIONS) items.push({ who: s.label, text: v.sections[s.key] || '—' });
  if (signed) {
    items.push({ who: 'Подпись', text: `Психолог: ${v.signed_name}   ______________________\nПодписано: ${v.signed_at} (UTC), версия ${v.version}\nКонтрольная сумма SHA-256: ${v.checksum}\n${SIGN_NOTICE}` });
  } else {
    items.push({ who: 'Статус', text: `${DRAFT_LABEL}: не подписано, версия ${v.version}. Психолог: ${authorName}   ______________________` });
  }
  return {
    title: v.title ? `Заключение психолога: ${v.title}` : 'Заключение клинического психолога',
    label: signed ? `ПОДПИСАНО · версия ${v.version} · ${SIGN_NOTICE}` : `${DRAFT_LABEL} · версия ${v.version} · не подписано`,
    disclaimer: 'Документ сформирован сервисом Clinical Compass (демо). Шаблон — заглушка, требует клинического ревью. Не диагноз; решение за врачом.',
    watermark: signed ? '' : DRAFT_LABEL,
    date: (v.signed_at || v.updated_at || v.created_at || '').slice(0, 10),
    items,
  };
}

module.exports = {
  SECTIONS, SECTION_KEYS, REMINDERS, SIGN_NOTICE, REVIEW_NOTE, DRAFT_LABEL, FIELD_MAX, remindersSafe,
  checksumOf, protocolsOf, instrumentTitle, create, saveDraft, refillProtocols, sign, revise, setRelease, integrityOk,
  latestVersion, lastSigned, getVersion, versions, getConclusion, listFor, searchProtocols, exportDoc, cleanSections, parse,
};
