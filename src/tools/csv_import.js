'use strict';

/**
 * Импорт офлайн-результатов из CSV (REQ-TLS-003). Только закреплённые за врачом пациенты; диапазоны шкал проверяются;
 * ячейки с формульными символами (= + - @) не принимаются, в заметках получают префикс '. Записи создаются так же, как ручной
 * ввод очного результата (offline_results / catalog_protocols + comparison_pairs). Партия откатывается в течение 24 часов.
 * Кризисный путь не ослаблен: BDI-II п.9 через evaluateCrisisTier создаёт эскалацию, как при ручном вводе (откат её не удаляет).
 */

const db = require('../db');
const { INSTRUMENTS } = require('../instruments');
const catalog = require('../instruments_catalog');
const comparison = require('../comparison');
const assignments = require('../assignments');
const crisisProtocol = require('../crisisProtocol');
const escalation = require('../escalation');
const { csvCell } = require('../research_export');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 1000;
const ROLLBACK_HOURS = 24;
const DRAFT_TTL_MIN = 60;
const NOTE_MAX = 500;
const CSV_SCALES = ['phq9', 'gad7', 'hads', 'who5', 'bdi2', 'stai', 'mmpi'];

// поле -> варианты заголовков (нижний регистр, без пробелов по краям)
const FIELDS = [
  { key: 'patient_id', label: 'ID пациента', syn: ['patient_id', 'id', 'id пациента', 'код пациента', 'пациент'] },
  { key: 'scale', label: 'Шкала', syn: ['scale', 'шкала', 'методика', 'тест', 'instrument'] },
  { key: 'date', label: 'Дата', syn: ['date', 'дата', 'дата теста', 'test_date'] },
  { key: 'score', label: 'Балл (итог)', syn: ['score', 'балл', 'баллы', 'сумма', 'итог', 'total'] },
  { key: 'item9', label: 'Пункт 9', syn: ['item9', 'пункт 9', 'п9', 'item_9'] },
  { key: 'subscale_a', label: 'HADS-A', syn: ['subscale_a', 'hads_a', 'hads-a', 'тревога (hads)'] },
  { key: 'subscale_d', label: 'HADS-D', syn: ['subscale_d', 'hads_d', 'hads-d', 'депрессия (hads)'] },
  { key: 'stai_state', label: 'STAI ситуативная', syn: ['stai_state', 'stai реактивная', 'реактивная'] },
  { key: 'stai_trait', label: 'STAI личностная', syn: ['stai_trait', 'stai личностная', 'личностная'] },
  { key: 'mmpi_2', label: 'СМИЛ шкала 2 (T)', syn: ['mmpi_2', 'смил 2', 'mmpi2'] },
  { key: 'mmpi_7', label: 'СМИЛ шкала 7 (T)', syn: ['mmpi_7', 'смил 7', 'mmpi7'] },
  { key: 'mmpi_9', label: 'СМИЛ шкала 9 (T)', syn: ['mmpi_9', 'смил 9', 'mmpi9'] },
  { key: 'note', label: 'Заметка', syn: ['note', 'заметка', 'комментарий', 'notes'] },
];
const REQUIRED = ['patient_id', 'scale', 'date'];

// ---------- декодирование и разбор ----------

/** UTF-8 (с BOM или без), иначе Windows-1251 (Excel). */
function decode(buf) {
  let b = buf;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'UTF-8' };
  } catch {
    return { text: new TextDecoder('windows-1251').decode(b), encoding: 'Windows-1251' };
  }
}

function detectDelimiter(text) {
  const first = text.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#')) || '';
  const cnt = (ch) => first.split(ch).length - 1;
  const cands = [';', ',', '\t'].map((d) => [d, cnt(d)]).sort((a, b) => b[1] - a[1]);
  return cands[0][1] > 0 ? cands[0][0] : ';';
}

/** RFC 4180: кавычки, удвоенные кавычки, переводы строк внутри кавычек. Возвращает [{line, cells}]. */
function parseCsv(text, delimiter) {
  const rows = [];
  let cells = [];
  let cur = '';
  let inQ = false;
  let line = 1;
  let startLine = 1;
  const pushRow = () => { cells.push(cur); rows.push({ line: startLine, cells }); cells = []; cur = ''; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else { if (ch === '\n') line++; cur += ch; }
    } else if (ch === '"' && cur === '') inQ = true;
    else if (ch === delimiter) { cells.push(cur); cur = ''; }
    else if (ch === '\n') { pushRow(); line++; startLine = line; }
    else if (ch === '\r') { /* CRLF */ }
    else cur += ch;
  }
  if (cur !== '' || cells.length) pushRow();
  return rows;
}

function autoMap(header) {
  const map = {};
  const norm = header.map((h) => String(h).trim().toLowerCase());
  for (const f of FIELDS) {
    const i = norm.findIndex((h) => f.syn.includes(h));
    if (i >= 0) map[f.key] = i;
  }
  return map;
}

// ---------- проверка строк ----------

const INT_RE = /^\d{1,4}$/;
const isFormula = (s) => /^[=+\-@\t\r]/.test(s);

function parseDate(s) {
  let y; let m; let d;
  let mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (mt) { y = +mt[1]; m = +mt[2]; d = +mt[3]; } else if ((mt = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s))) { d = +mt[1]; m = +mt[2]; y = +mt[3]; } else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function scaleCode(raw) {
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (CSV_SCALES.includes(s)) return s;
  const e = catalog.getEntry(s);
  if (e && e.status === 'stub') return e.code;
  for (const c of CSV_SCALES) if (INSTRUMENTS[c].title.toLowerCase().startsWith(s + ' ')) return c;
  return null;
}

function selfMax(code) {
  const d = INSTRUMENTS[code];
  return d.items ? d.items.length * d.maxPerItem : null;
}

function numberIn(raw, label, min, max, errors, { required = true } = {}) {
  const s = String(raw === undefined ? '' : raw).trim();
  if (s === '') { if (required) errors.push(`${label}: не указано`); return null; }
  if (isFormula(s)) { errors.push(`${label}: значение начинается с формульного символа`); return null; }
  if (!INT_RE.test(s)) { errors.push(`${label}: нужно целое число без знака`); return null; }
  const n = Number(s);
  if (n < min || n > max) { errors.push(`${label}: ${n} вне диапазона ${min}-${max}`); return null; }
  return n;
}

function sanitizeNote(s) {
  let t = String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, NOTE_MAX);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return t;
}

function existsDup(patientId, code, date, total, isProtocol) {
  if (isProtocol) {
    const rows = db.prepare("SELECT protocol_json FROM catalog_protocols WHERE patient_id = ? AND instrument = ? AND test_date = ? AND invalid_at IS NULL").all(patientId, code, date);
    return rows.some((r) => { try { return JSON.parse(r.protocol_json).score === total; } catch { return false; } });
  }
  return !!db.prepare('SELECT 1 FROM offline_results WHERE patient_id = ? AND instrument = ? AND test_date = ? AND total_score IS ? AND invalid_at IS NULL').get(patientId, code, date, total);
}

/** Проверка одной строки: возвращает {status:'ok'|'error'|'duplicate', errors, warnings, data}. */
function validateRow(clinician, get, seen, today) {
  const errors = [];
  const warnings = [];
  const pidRaw = String(get('patient_id') || '').trim();
  let pid = null;
  if (isFormula(pidRaw)) errors.push('ID пациента: значение начинается с формульного символа');
  else if (!/^\d{1,9}$/.test(pidRaw)) errors.push('ID пациента: нужно число (ID виден в адресе карточки пациента)');
  else {
    pid = Number(pidRaw);
    const mine = db.prepare('SELECT 1 FROM care_assignments ca JOIN users u ON u.id = ca.patient_id WHERE ca.patient_id = ? AND ca.clinician_id = ? AND u.role = ?').get(pid, clinician.id, 'patient');
    if (!mine) { errors.push('Пациент не закреплён за вами или не существует'); pid = null; }
    else if (assignments.writeBlocked(pid).blocked) { errors.push('Пациент отозвал согласие или запросил удаление данных: запись недоступна'); pid = null; }
  }
  const scaleRaw = String(get('scale') || '').trim();
  const code = isFormula(scaleRaw) ? null : scaleCode(scaleRaw);
  if (!code) errors.push(`Шкала «${scaleRaw.slice(0, 30)}» не поддерживается (см. шаблон)`);
  const dateRaw = String(get('date') || '').trim();
  const date = dateRaw && !isFormula(dateRaw) ? parseDate(dateRaw) : null;
  if (!date) errors.push('Дата: нужен формат ГГГГ-ММ-ДД или ДД.ММ.ГГГГ (существующая дата)');
  else if (date > today) errors.push('Дата в будущем');
  else if (date < '2000-01-01') errors.push('Дата раньше 2000 года');
  const noteRaw = String(get('note') || '');
  const note = sanitizeNote(noteRaw);
  if (note !== noteRaw.trim().slice(0, NOTE_MAX) && note.startsWith("'")) warnings.push("Заметка начиналась с формульного символа: добавлен префикс '");

  const d = { patient_id: pid, code, date, note, kind: 'offline', total: null, subscales: null, item9: null, band: null, riskReasons: [], riskFlag: false, tier: 0 };
  if (code) {
    const stub = catalog.isStub(code);
    if (stub) {
      d.kind = 'protocol';
      d.total = numberIn(get('score'), 'Балл', 0, 1000, errors);
      d.band = null;
    } else if (code === 'hads') {
      const a = numberIn(get('subscale_a'), 'HADS-A', 0, 21, errors);
      const dd = numberIn(get('subscale_d'), 'HADS-D', 0, 21, errors);
      if (a !== null && dd !== null) {
        const def = INSTRUMENTS.hads;
        const bandFor = (t) => (def.bands.find((b) => t <= b.max) || def.bands[def.bands.length - 1]).label;
        d.subscales = { A: a, D: dd };
        d.total = a + dd;
        d.riskReasons = def.computeRisk(null, null, d.subscales);
        d.band = `A: ${bandFor(a)}; D: ${bandFor(dd)}`;
      }
    } else if (code === 'stai') {
      const s = numberIn(get('stai_state'), 'STAI ситуативная', 20, 80, errors);
      const t = numberIn(get('stai_trait'), 'STAI личностная', 20, 80, errors);
      if (s !== null && t !== null) {
        const def = INSTRUMENTS.stai;
        d.subscales = { state: s, trait: t };
        d.total = Math.max(s, t);
        d.band = (def.bands.find((b) => d.total <= b.max) || def.bands[def.bands.length - 1]).label;
      }
    } else if (code === 'mmpi') {
      const sub = {};
      let any = false;
      for (const [k, f] of [['scale2', 'mmpi_2'], ['scale7', 'mmpi_7'], ['scale9', 'mmpi_9']]) {
        const v = numberIn(get(f), `СМИЛ ${k.slice(5)}`, 0, 120, errors, { required: false });
        sub[k] = v; if (v !== null) any = true;
      }
      if (!any && !errors.length) errors.push('СМИЛ: укажите хотя бы одну T-оценку');
      if (any) {
        const def = INSTRUMENTS.mmpi;
        d.subscales = sub;
        d.riskReasons = def.computeRisk(sub);
        d.total = Math.max(...def.scales.map((k) => (typeof sub[k] === 'number' ? sub[k] : 0))) || null;
      }
    } else {
      const def = INSTRUMENTS[code];
      const max = code === 'bdi2' ? def.totalRange[1] : selfMax(code);
      d.total = numberIn(get('score'), 'Балл', 0, max, errors);
      if (code === 'phq9' || code === 'bdi2') d.item9 = numberIn(get('item9'), 'Пункт 9', 0, 3, errors, { required: false });
      if (d.total !== null) {
        d.band = (def.bands.find((b) => d.total <= b.max) || def.bands[def.bands.length - 1]).label;
        if (code === 'bdi2') d.riskReasons = def.computeRisk({ item9Score: d.item9 });
        else if (code === 'phq9') d.riskReasons = def.computeRisk([...Array(8).fill(0), d.item9 === null ? 0 : d.item9], d.total);
        else d.riskReasons = def.computeRisk(null, d.total);
      }
    }
    d.riskFlag = d.riskReasons.length > 0;
    if (code === 'bdi2' && d.item9 !== null && !errors.length) {
      const { tier, triggers } = crisisProtocol.evaluateCrisisTier({ bdi2Item9: d.item9 });
      if (tier > crisisProtocol.TIERS.ROUTINE) { d.tier = tier; d.triggers = triggers; warnings.push(`BDI-II п.9 = ${d.item9}: при импорте будет создана кризисная эскалация (${require('../labels').tierLabel(tier)}), как при ручном вводе`); }
    }
  }
  if (errors.length) return { status: 'error', errors, warnings, data: d };
  const key = `${pid}|${code}|${date}|${d.total}`;
  if (seen.has(key) || existsDup(pid, code, date, d.total, d.kind === 'protocol')) {
    return { status: 'duplicate', errors: [], warnings: ['Такой результат уже есть (повтор строки или повторный импорт) — будет пропущен'], data: d };
  }
  seen.add(key);
  return { status: 'ok', errors: [], warnings, data: d };
}

/**
 * Полный разбор: buf или text -> { fatal?, encoding, delimiter, header, mapping, rows:[{line,status,errors,warnings,data,cells}], counts }.
 * mapping — необязательное переопределение {field: columnIndex|null}.
 */
function analyze(clinician, input, mappingOverride, now = new Date()) {
  let text; let encoding = 'UTF-8';
  if (input && typeof input === 'object' && !Buffer.isBuffer(input)) {
    text = String(input.text);
    encoding = input.encoding || 'UTF-8';
  } else if (Buffer.isBuffer(input)) {
    if (input.length > MAX_BYTES) return { fatal: 'Файл больше 2 МБ.' };
    ({ text, encoding } = decode(input));
  } else text = String(input);
  const delimiter = detectDelimiter(text);
  const all = parseCsv(text, delimiter).filter((r) => r.cells.some((c) => c.trim() !== '') && !String(r.cells[0]).trim().startsWith('#'));
  if (!all.length) return { fatal: 'В файле нет данных. Скачайте шаблон и заполните его.' };
  const header = all[0].cells;
  const dataRows = all.slice(1);
  if (dataRows.length > MAX_ROWS) return { fatal: `Больше ${MAX_ROWS} строк данных (в файле ${dataRows.length}). Разбейте файл на части.` };
  const mapping = { ...autoMap(header) };
  if (mappingOverride) {
    for (const f of FIELDS) {
      if (!(f.key in mappingOverride)) continue;
      const v = mappingOverride[f.key];
      if (v === null || v === '' || v === undefined) delete mapping[f.key];
      else if (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) < header.length) mapping[f.key] = Number(v);
    }
  }
  const missing = REQUIRED.filter((k) => mapping[k] === undefined);
  const base = { encoding, delimiter, header, mapping, missing, text };
  if (missing.length) return { ...base, rows: [], counts: { ok: 0, error: 0, duplicate: 0 }, fatal: null };
  const today = now.toISOString().slice(0, 10);
  const seen = new Set();
  const rows = dataRows.map((r) => {
    const get = (k) => (mapping[k] === undefined ? '' : r.cells[mapping[k]] === undefined ? '' : r.cells[mapping[k]]);
    return { line: r.line, cells: r.cells, ...validateRow(clinician, get, seen, today) };
  });
  const counts = { ok: 0, error: 0, duplicate: 0 };
  rows.forEach((r) => { counts[r.status] += 1; });
  return { ...base, rows, counts, fatal: null };
}

// ---------- черновики между шагами ----------

function purgeDrafts() {
  db.prepare("DELETE FROM tool_import_drafts WHERE created_at < datetime('now', ?)").run(`-${DRAFT_TTL_MIN} minutes`);
}
function saveDraft(clinicianId, text, encoding) {
  purgeDrafts();
  db.prepare('DELETE FROM tool_import_drafts WHERE clinician_id = ?').run(clinicianId);
  return Number(db.prepare('INSERT INTO tool_import_drafts (clinician_id, content, encoding) VALUES (?, ?, ?)').run(clinicianId, text, encoding || 'UTF-8').lastInsertRowid);
}
function getDraft(clinicianId, id) {
  purgeDrafts();
  return db.prepare('SELECT * FROM tool_import_drafts WHERE id = ? AND clinician_id = ?').get(Number(id), clinicianId) || null;
}
function dropDraft(id) {
  db.prepare('DELETE FROM tool_import_drafts WHERE id = ?').run(Number(id));
}

// ---------- применение и откат ----------

function apply(clinician, analysis) {
  const okRows = analysis.rows.filter((r) => r.status === 'ok');
  const out = { batchId: null, created: 0, escalations: 0 };
  const tx = db.transaction(() => {
    const b = db.prepare('INSERT INTO tool_import_batches (clinician_id, rows_total, rows_ok, rows_skipped) VALUES (?, ?, ?, ?)')
      .run(clinician.id, analysis.rows.length, okRows.length, analysis.rows.length - okRows.length);
    const batchId = Number(b.lastInsertRowid);
    out.batchId = batchId;
    const patients = new Set();
    for (const r of okRows) {
      const d = r.data;
      // повторная проверка принадлежности на момент записи
      if (!db.prepare('SELECT 1 FROM care_assignments WHERE patient_id = ? AND clinician_id = ?').get(d.patient_id, clinician.id)) continue;
      if (assignments.writeBlocked(d.patient_id).blocked) continue; // L-5: согласие могло быть отозвано между разбором и подтверждением
      const noteText = `${d.note ? d.note + ' · ' : ''}импорт CSV, партия ${batchId}`;
      let rid; let waiting = null;
      if (d.kind === 'protocol') {
        rid = Number(db.prepare("INSERT INTO catalog_protocols (patient_id, entered_by, instrument, test_date, protocol_json, status) VALUES (?, ?, ?, ?, ?, 'ready')")
          .run(d.patient_id, clinician.id, d.code, d.date, JSON.stringify({ score: d.total, observations: noteText })).lastInsertRowid);
        waiting = assignments.completeWaiting(d.patient_id, d.code, rid);
      } else {
        rid = Number(db.prepare(
          `INSERT INTO offline_results (patient_id, entered_by, instrument, total_score, subscales_json, item9_score, band, risk_flag, risk_reasons_json, test_date, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(d.patient_id, clinician.id, d.code, d.total, d.subscales ? JSON.stringify(d.subscales) : null, d.item9, d.band, d.riskFlag ? 1 : 0, JSON.stringify(d.riskReasons), d.date, noteText).lastInsertRowid);
        comparison.createComparisonPairIfPossible(db.prepare('SELECT * FROM offline_results WHERE id = ?').get(rid));
        waiting = assignments.completeWaiting(d.patient_id, d.code, null);
        if (d.code === 'bdi2' && d.tier) {
          escalation.createEscalation({ patientId: d.patient_id, instrument: 'bdi2', reasons: d.riskReasons, tier: d.tier, triggers: d.triggers });
          out.escalations += 1;
        }
      }
      db.prepare('INSERT INTO tool_import_items (batch_id, kind, result_id, waiting_assignment_id) VALUES (?, ?, ?, ?)').run(batchId, d.kind, rid, waiting);
      patients.add(d.patient_id);
      out.created += 1;
    }
    for (const pid of patients) db.prepare('INSERT INTO phi_access_log (actor_id, patient_id, action) VALUES (?, ?, ?)').run(clinician.id, pid, 'tools_csv_import');
    db.prepare('UPDATE tool_import_batches SET rows_ok = ? WHERE id = ?').run(out.created, batchId);
  });
  tx();
  return out;
}

function batchView(b, now = new Date()) {
  const created = new Date(String(b.created_at).replace(' ', 'T') + 'Z');
  const left = ROLLBACK_HOURS * 3600000 - (now.getTime() - created.getTime());
  return { ...b, canRollback: !b.rolled_back_at && left > 0, hoursLeft: Math.max(0, Math.ceil(left / 3600000)) };
}

function listBatches(clinicianId, now = new Date()) {
  return db.prepare('SELECT * FROM tool_import_batches WHERE clinician_id = ? ORDER BY id DESC LIMIT 20').all(clinicianId).map((b) => batchView(b, now));
}

function rollback(clinician, batchId, now = new Date()) {
  const row = db.prepare('SELECT * FROM tool_import_batches WHERE id = ? AND clinician_id = ?').get(Number(batchId), clinician.id);
  if (!row) return { ok: false, error: 'Партия не найдена.' };
  const v = batchView(row, now);
  if (row.rolled_back_at) return { ok: false, error: 'Партия уже отменена.' };
  if (!v.canRollback) return { ok: false, error: `Откат возможен в течение ${ROLLBACK_HOURS} часов после импорта.` };
  let removed = 0;
  db.transaction(() => {
    const items = db.prepare('SELECT * FROM tool_import_items WHERE batch_id = ?').all(row.id);
    const patients = new Set();
    for (const it of items) {
      if (it.kind === 'offline') {
        const r = db.prepare('SELECT patient_id FROM offline_results WHERE id = ?').get(it.result_id);
        if (r) patients.add(r.patient_id);
        db.prepare('DELETE FROM comparison_pairs WHERE offline_result_id = ?').run(it.result_id);
        removed += db.prepare('DELETE FROM offline_results WHERE id = ?').run(it.result_id).changes;
      } else {
        const r = db.prepare('SELECT patient_id FROM catalog_protocols WHERE id = ?').get(it.result_id);
        if (r) patients.add(r.patient_id);
        removed += db.prepare('DELETE FROM catalog_protocols WHERE id = ?').run(it.result_id).changes;
      }
      if (it.waiting_assignment_id) {
        db.prepare("UPDATE instrument_assignments SET status = 'waiting_entry', completed_at = NULL, entry_protocol_id = NULL WHERE id = ? AND status = 'completed'").run(it.waiting_assignment_id);
      }
    }
    db.prepare("UPDATE tool_import_batches SET rolled_back_at = datetime('now') WHERE id = ?").run(row.id);
    for (const pid of patients) db.prepare('INSERT INTO phi_access_log (actor_id, patient_id, action) VALUES (?, ?, ?)').run(clinician.id, pid, 'tools_csv_rollback');
  })();
  return { ok: true, removed };
}

// ---------- шаблон файла ----------

function templateCsv() {
  const L = [];
  const head = FIELDS.map((f) => f.key);
  L.push(head.join(';'));
  L.push(`# Строки, начинающиеся с #, игнорируются. ID пациента виден в адресе его карточки (/patients/<ID>). Только ваши пациенты.`);
  L.push(`# Шкала: ${CSV_SCALES.join(', ')} или код шкалы-заглушки каталога (баллы без толкования). Дата: ГГГГ-ММ-ДД или ДД.ММ.ГГГГ.`);
  const rng = CSV_SCALES.map((c) => {
    if (c === 'hads') return 'hads: subscale_a и subscale_d 0-21';
    if (c === 'stai') return 'stai: stai_state и stai_trait 20-80';
    if (c === 'mmpi') return 'mmpi: mmpi_2, mmpi_7, mmpi_9 (T) 0-120';
    const max = c === 'bdi2' ? INSTRUMENTS.bdi2.totalRange[1] : selfMax(c);
    return `${c}: score 0-${max}${c === 'phq9' || c === 'bdi2' ? ', item9 0-3 (необязательно)' : ''}`;
  });
  L.push(`# Диапазоны: ${rng.join('; ')}.`);
  return '﻿' + L.map((l) => (l.startsWith('#') ? csvCell(l.replace(/^#/, '#')) : l)).join('\r\n') + '\r\n';
}

module.exports = {
  FIELDS, REQUIRED, MAX_BYTES, MAX_ROWS, ROLLBACK_HOURS, decode, detectDelimiter, parseCsv, autoMap, analyze,
  saveDraft, getDraft, dropDraft, apply, rollback, listBatches, templateCsv, sanitizeNote,
};
