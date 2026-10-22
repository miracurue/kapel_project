'use strict';

/**
 * Данные карточки пациента клинициста (W1.B2): вкладки, аудит просмотров (REQ-CLN-025),
 * «Что изменилось» (REQ-CLN-009), ряды результатов для графика (REQ-CLN-011), журнал (REQ-CLN-018),
 * справка «К приёму» (REQ-PSA-002). Только чтение; клинических порогов здесь нет
 * (направление «хуже» берётся из triage_rules.CONFIG).
 */

const db = require('./db');
const catalog = require('./instruments_catalog');
const { INSTRUMENTS } = require('./instruments');
const rules = require('./triage_rules');
const { instrumentLabel, formatDate } = require('./format');

const { parseTs, DAY } = rules;

// Текст — константа в одном месте, review-required (REQ-ALL-007).
const CLINICAL_DISCLAIMER = 'Справочная информация: риск или гипотеза, не диагноз и не заключение; решение остаётся за врачом.';
const AUDIT_WINDOW_MIN = 5;
const FIRST_VIEW_DAYS = 14;
const CHANGES_MAX_ROWS = 8;

const TABS = Object.freeze([
  { key: 'overview', label: 'Обзор', path: '' },
  { key: 'scales', label: 'Шкалы и динамика', path: '/scales' },
  { key: 'offline', label: 'Офлайн-ввод и сравнение', path: '/offline' },
  { key: 'diary', label: 'Дневник', path: '/diary' },
  { key: 'treatment', label: 'Лечение', path: '/treatment' },
  { key: 'notes', label: 'Заметки', path: '/notes' },
  { key: 'conclusions', label: 'Заключения', path: '/conclusions' },
  { key: 'materials', label: 'Материалы', path: '/materials' },
  { key: 'journal', label: 'Журнал', path: '/journal' },
]);
const TAB_KEYS = TABS.map((t) => t.key);

// ---------- аудит ----------

const actionFor = (tab) => (tab === 'overview' ? 'view_patient_detail' : `view_patient_tab:${tab}`);

/** Одна запись на действие/вкладку в окне 5 минут (REQ-CLN-025): F5 не множит записи. */
function logView(actorId, patientId, action) {
  const dup = db
    .prepare("SELECT 1 FROM phi_access_log WHERE actor_id = ? AND patient_id = ? AND action = ? AND created_at >= datetime('now', ?)")
    .get(actorId, patientId, action, `-${AUDIT_WINDOW_MIN} minutes`);
  if (dup) return false;
  db.prepare('INSERT INTO phi_access_log (actor_id, patient_id, action) VALUES (?, ?, ?)').run(actorId, patientId, action);
  return true;
}

/** W3.K (M-5): списки с ПД нескольких пациентов — по записи (кто, какой пациент, какой раздел) на каждого; без текстов. */
function logViewMany(actorId, patientIds, action) {
  let n = 0;
  for (const pid of new Set((patientIds || []).map(Number).filter(Number.isInteger))) if (logView(actorId, pid, action)) n += 1;
  return n;
}

/**
 * Время «последнего просмотра» карточки этим врачом — из phi_access_log, без новой отметки.
 * Если последняя запись ещё в окне дедупликации (это та же сессия), берётся предыдущая.
 */
function lastView(actorId, patientId, now = new Date()) {
  const rows = db
    .prepare("SELECT created_at FROM phi_access_log WHERE actor_id = ? AND patient_id = ? AND action = 'view_patient_detail' ORDER BY created_at DESC, id DESC LIMIT 2")
    .all(actorId, patientId);
  if (!rows.length) return null;
  const newest = parseTs(rows[0].created_at);
  if (newest && now.getTime() - newest.getTime() < AUDIT_WINDOW_MIN * 60000 && rows.length > 1) return parseTs(rows[1].created_at);
  if (newest && now.getTime() - newest.getTime() < AUDIT_WINDOW_MIN * 60000) return null;
  return newest;
}

// ---------- базовое ----------

function patientBase(patientId) {
  return db
    .prepare('SELECT id, full_name, email, clinical_consent_given, account_status, consent_revoked_at FROM users WHERE id = ?')
    .get(patientId);
}

function coClinicians(patientId, clinicianId) {
  return db
    .prepare(
      `SELECT u.full_name, u.role FROM care_assignments ca JOIN users u ON u.id = ca.clinician_id
       WHERE ca.patient_id = ? AND ca.clinician_id != ? ORDER BY u.full_name`
    )
    .all(patientId, clinicianId);
}

const sqlTime = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
const isoDate = (d) => d.toISOString().slice(0, 10);

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parseJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// ---------- результаты ----------

/**
 * Единый ряд результатов: онлайн (если есть согласие), очные (offline_results) и числовые баллы протоколов.
 * kind: online | offline | protocol. invalid — «ошибочный ввод» (исключается из динамики).
 */
function gatherResults(patientId, { consentOk = true, includeInvalid = false } = {}) {
  const out = [];
  if (consentOk) {
    for (const r of db.prepare('SELECT * FROM online_results WHERE patient_id = ?').all(patientId)) {
      out.push({
        id: `o${r.id}`, rid: r.id, kind: 'online', instrument: r.instrument, total: r.total_score,
        subscales: parseJson(r.subscales_json, null), band: r.band, risk: !!r.risk_flag, at: r.created_at, atMs: parseTs(r.created_at)?.getTime() || 0,
        stub: catalog.isStub(r.instrument), invalid: false,
      });
    }
  }
  for (const r of db.prepare('SELECT * FROM offline_results WHERE patient_id = ?').all(patientId)) {
    if (r.invalid_at && !includeInvalid) continue;
    const at = `${String(r.test_date).slice(0, 10)} 12:00:00`;
    out.push({
      id: `f${r.id}`, rid: r.id, kind: 'offline', instrument: r.instrument, total: r.total_score,
      subscales: parseJson(r.subscales_json, null), band: r.band, risk: !!r.risk_flag, at, date: String(r.test_date).slice(0, 10), atMs: parseTs(at)?.getTime() || 0,
      stub: false, invalid: !!r.invalid_at, invalidReason: r.invalid_reason, notes: r.notes,
    });
  }
  for (const r of db.prepare('SELECT * FROM catalog_protocols WHERE patient_id = ?').all(patientId)) {
    if (r.invalid_at && !includeInvalid) continue;
    const p = parseJson(r.protocol_json, {});
    const at = `${String(r.test_date).slice(0, 10)} 12:00:00`;
    out.push({
      id: `p${r.id}`, rid: r.id, kind: 'protocol', instrument: r.instrument, total: numOrNull(p.score), subscales: null, band: null,
      risk: false, at, date: String(r.test_date).slice(0, 10), atMs: parseTs(at)?.getTime() || 0, stub: catalog.isStub(r.instrument),
      invalid: !!r.invalid_at, invalidReason: r.invalid_reason, status: r.status, protocol: p,
    });
  }
  return out.sort((a, b) => a.atMs - b.atMs || String(a.id).localeCompare(String(b.id)));
}

const SOURCE_LABEL = { online: 'Онлайн', offline: 'Очно (бланк)', protocol: 'Протокол врача' };

function worseSign(code) {
  if (rules.CONFIG.lowerIsWorse.includes(code)) return -1;
  if (rules.CONFIG.higherIsWorse.includes(code)) return 1;
  return 0;
}

/** Текст дельты к предыдущему значению той же шкалы: «+3 к 14, хуже» (слово, не только цвет). */
function deltaInfo(code, prev, last) {
  if (prev === null || prev === undefined || last === null || last === undefined) return null;
  const d = last - prev;
  const sign = worseSign(code);
  const word = d === 0 ? 'без изменений' : sign === 0 ? (d > 0 ? 'выше' : 'ниже') : d * sign > 0 ? 'хуже' : 'лучше';
  const arrow = d === 0 ? '→' : d > 0 ? '↑' : '↓';
  return { delta: d, word, arrow, text: `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d)} к ${prev}, ${word}`, worse: word === 'хуже' };
}

// ---------- график (SVG) ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function markerSvg(kind, x, y, stub, cls) {
  const common = `class="pc-mark pc-mark--${kind}${stub ? ' is-demo' : ''} ${cls}"`;
  if (kind === 'offline') return `<rect ${common} x="${(x - 4.5).toFixed(1)}" y="${(y - 4.5).toFixed(1)}" width="9" height="9"/>`;
  if (kind === 'protocol') return `<polygon ${common} points="${x.toFixed(1)},${(y - 6).toFixed(1)} ${(x + 6).toFixed(1)},${y.toFixed(1)} ${x.toFixed(1)},${(y + 6).toFixed(1)} ${(x - 6).toFixed(1)},${y.toFixed(1)}"/>`;
  return `<circle ${common} cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5"/>`;
}

/** Ряды для шкалы: HADS — две линии (подшкалы A и D), остальные — одна по total. */
function seriesFor(code, results) {
  const mine = results.filter((r) => r.instrument === code);
  if (code === 'hads') {
    return ['A', 'D'].map((k, i) => ({
      key: k, label: k === 'A' ? 'HADS-A (тревога)' : 'HADS-D (депрессия)', dash: i === 1,
      points: mine.filter((r) => r.subscales && typeof r.subscales[k] === 'number').map((r) => ({ ...r, v: r.subscales[k] })),
    })).filter((s) => s.points.length);
  }
  const pts = mine.filter((r) => typeof r.total === 'number').map((r) => ({ ...r, v: r.total }));
  return pts.length ? [{ key: 'total', label: instrumentLabel(code), dash: false, points: pts }] : [];
}

function yMaxFor(code, series) {
  const def = INSTRUMENTS[code];
  if (def && def.bands) return def.bands[def.bands.length - 1].max;
  const max = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.v)));
  return Math.ceil(max * 1.15);
}

/** SVG-график динамики одной шкалы. Форма маркера = источник; полый маркер = демо-заглушка. */
function renderChart(code, series, { width = 640, height = 240 } = {}) {
  const all = series.flatMap((s) => s.points);
  if (!all.length) return '';
  const pad = { l: 36, r: 14, t: 12, b: 28 };
  const ymax = yMaxFor(code, series);
  const t0 = Math.min(...all.map((p) => p.atMs));
  const t1 = Math.max(...all.map((p) => p.atMs));
  const span = Math.max(t1 - t0, 1);
  const X = (t) => (all.length === 1 || t1 === t0 ? pad.l + (width - pad.l - pad.r) / 2 : pad.l + ((t - t0) / span) * (width - pad.l - pad.r));
  const Y = (v) => pad.t + (1 - Math.min(v, ymax) / ymax) * (height - pad.t - pad.b);
  let g = '';
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = Math.round((ymax * i) / steps);
    g += `<line class="pc-grid" x1="${pad.l}" x2="${width - pad.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="pc-axis" x="${pad.l - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`;
  }
  g += `<text class="pc-axis" x="${pad.l}" y="${height - 8}" text-anchor="start">${esc(formatDate(new Date(t0).toISOString().slice(0, 10)))}</text>`;
  if (t1 !== t0) g += `<text class="pc-axis" x="${width - pad.r}" y="${height - 8}" text-anchor="end">${esc(formatDate(new Date(t1).toISOString().slice(0, 10)))}</text>`;
  series.forEach((s, si) => {
    const pts = s.points.map((p) => `${X(p.atMs).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
    if (s.points.length > 1) g += `<polyline class="pc-line${s.dash ? ' pc-line--dash' : ''}" points="${pts}"/>`;
    for (const p of s.points) {
      g += `<g class="pc-point s${si}">${markerSvg(p.kind, X(p.atMs), Y(p.v), p.stub, s.dash ? 'is-alt' : '')}<title>${esc(`${s.label}: ${p.v}, ${formatDate(p.date || String(p.at).slice(0, 10))}, ${SOURCE_LABEL[p.kind]}${p.stub ? ', демо-балл' : ''}`)}</title></g>`;
    }
  });
  const label = `График: ${instrumentLabel(code)}, ${all.length} точек. Таблица с теми же значениями ниже.`;
  return `<svg class="pc-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid meet">${g}</svg>`;
}

function sparkline(values, { width = 96, height = 26 } = {}) {
  if (values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const rng = max - min || 1;
  const pts = values.map((v, i) => `${(2 + (i / (values.length - 1)) * (width - 4)).toFixed(1)},${(height - 3 - ((v - min) / rng) * (height - 6)).toFixed(1)}`).join(' ');
  return `<svg class="pc-spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="Мини-график, ${values.length} точек: ${values.join(', ')}"><polyline class="pc-line" points="${pts}"/></svg>`;
}

const PERIODS = [{ key: '4', label: '4 недели', days: 28 }, { key: '12', label: '12 недель', days: 84 }, { key: '26', label: '26 недель', days: 182 }, { key: 'all', label: 'всё время', days: null }];

/** Вкладка «Шкалы и динамика»: выбранная шкала и период + таблица-альтернатива. */
function scalesView(patientId, { scale, period }, consentOk, now = new Date()) {
  const results = gatherResults(patientId, { consentOk });
  const invalidCount = db.prepare('SELECT (SELECT COUNT(*) FROM offline_results WHERE patient_id = ? AND invalid_at IS NOT NULL) + (SELECT COUNT(*) FROM catalog_protocols WHERE patient_id = ? AND invalid_at IS NOT NULL) AS n').get(patientId, patientId).n;
  const codes = [...new Set(results.filter((r) => typeof r.total === 'number' || r.subscales).map((r) => r.instrument))];
  // реальные шкалы первыми, заглушки в конце
  codes.sort((a, b) => Number(catalog.isStub(a)) - Number(catalog.isStub(b)) || instrumentLabel(a).localeCompare(instrumentLabel(b), 'ru'));
  const code = codes.includes(scale) ? scale : codes[0] || null;
  const per = PERIODS.find((p) => p.key === period) || PERIODS[1];
  let shown = code ? results.filter((r) => r.instrument === code) : [];
  if (per.days) shown = shown.filter((r) => r.atMs >= now.getTime() - per.days * DAY);
  const series = code ? seriesFor(code, shown) : [];
  const chart = code ? renderChart(code, series) : '';
  const rows = [...shown].sort((a, b) => b.atMs - a.atMs);
  const excluded = consentOk ? gatherResults(patientId, { consentOk, includeInvalid: true }).filter((r) => r.invalid) : gatherResults(patientId, { consentOk, includeInvalid: true }).filter((r) => r.invalid);
  return { codes, code, per, periods: PERIODS, chart, rows, hasStub: shown.some((r) => r.stub), kinds: [...new Set(shown.map((r) => r.kind))], invalidCount, excluded, sourceLabel: SOURCE_LABEL, isHads: code === 'hads' };
}

// ---------- обзор ----------

const KEY_SCALES = ['phq9', 'gad7', 'who5', 'hads', 'bdi2'];

function keyScores(patientId, consentOk) {
  const results = gatherResults(patientId, { consentOk }).filter((r) => !r.stub);
  const out = [];
  for (const code of KEY_SCALES) {
    const list = results.filter((r) => r.instrument === code && (typeof r.total === 'number' || r.subscales));
    if (!list.length) continue;
    const last = list[list.length - 1];
    const prev = list.length > 1 ? list[list.length - 2] : null;
    let value; let delta = null;
    if (code === 'hads' && last.subscales) {
      value = `A ${last.subscales.A} · D ${last.subscales.D}`;
      if (prev && prev.subscales) {
        const da = deltaInfo(code, prev.subscales.A, last.subscales.A);
        const dd = deltaInfo(code, prev.subscales.D, last.subscales.D);
        delta = { text: `A: ${da.text}; D: ${dd.text}`, worse: da.worse || dd.worse, arrow: '' };
      }
    } else {
      value = String(last.total);
      delta = prev ? deltaInfo(code, prev.total, last.total) : null;
    }
    const spark = sparkline(list.slice(-8).map((r) => (code === 'hads' && r.subscales ? Math.max(r.subscales.A, r.subscales.D) : r.total)));
    out.push({ code, title: instrumentLabel(code), value, band: last.band, date: last.date || String(last.at).slice(0, 10), kind: last.kind, delta, spark, risk: last.risk });
  }
  return out;
}

function openEscalations(patientId, now = new Date()) {
  const out = db.prepare("SELECT * FROM crisis_escalations WHERE patient_id = ? AND status = 'open' ORDER BY tier DESC, created_at").all(patientId).map((e) => ({
    ref: String(e.id), kind: 'tier', tier: e.tier, label: `Эскалация: ${require('./labels').tierLabel(e.tier)}`, at: e.created_at, sla: e.due_at && e.tier >= 2 ? rules.slaText(e.due_at, now) : null,
  }));
  const hasAppeals = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='patient_appeals'").get();
  if (hasAppeals) {
    for (const a of db.prepare("SELECT * FROM patient_appeals WHERE patient_id = ? AND status = 'open' AND (routed_to IS NULL OR routed_to = 'clinician')").all(patientId)) {
      out.push({ ref: `a${a.id}`, kind: 'appeal', tier: 2, label: 'Обращение пациента', at: a.created_at, sla: rules.slaText(require('./crisis_queue').appealDueAt(a.created_at), now) });
    }
  }
  return out;
}

function diaryTrend(patientId, now = new Date()) {
  // REQ-PAT-017: только то, чем пациент делится (src/sharing.js, W1.A)
  const rows = require('./sharing').diaryForClinician(patientId, 500).entries
    .map((r) => ({ mood_score: r.mood_score, created_at: r.entry_date || r.created_at }))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const inRange = (from, to) => rows.filter((r) => { const t = parseTs(r.created_at)?.getTime() || 0; return t >= now.getTime() - from * DAY && t < now.getTime() - to * DAY; });
  const cur = inRange(7, 0);
  const prev = inRange(14, 7);
  const avg = (a) => (a.length ? a.reduce((s, r) => s + r.mood_score, 0) / a.length : null);
  return { count: rows.length, cur: avg(cur), prev: avg(prev), curN: cur.length, prevN: prev.length, last: rows.length ? rows[rows.length - 1].created_at : null };
}

const fmt1 = (n) => (Math.round(n * 10) / 10).toString().replace('.', ',');

/** «Что изменилось» (REQ-CLN-009): ≤ 8 строк, всегда с явным «Без изменений с <дата>», если пусто. */
function changes(patientId, actorId, { consentOk = true, now = new Date(), since: forcedSince } = {}) {
  const lv = forcedSince === undefined ? lastView(actorId, patientId, now) : forcedSince;
  const first = !lv;
  const since = lv || new Date(now.getTime() - FIRST_VIEW_DAYS * DAY);
  const sinceMs = since.getTime();
  const rows = [];
  const add = (icon, word, text, href) => rows.push({ icon, word, text, href });

  // 1. открытые эскалации (всегда видны, OQ-6)
  for (const e of openEscalations(patientId, now)) {
    (e.tier >= 2 ? add('⚠', 'Кризис', `${e.label}, ждёт подтверждения${e.sla ? ` (${e.sla.text})` : ''}`, `/crisis/${e.ref}`) : add('◐', 'Внимание', `${e.label} (повышенное внимание), ждёт подтверждения`, `/crisis/${e.ref}`));
  }

  if (consentOk) {
    // 2. новые результаты с дельтой к предыдущему результату той же шкалы
    const all = gatherResults(patientId, { consentOk });
    const fresh = all.filter((r) => r.atMs > sinceMs && (typeof r.total === 'number' || r.subscales));
    const shownFresh = fresh.slice(-4).reverse();
    for (const r of shownFresh) {
      const earlier = all.filter((x) => x.instrument === r.instrument && x.atMs < r.atMs && typeof x.total === 'number');
      const prev = earlier.length ? earlier[earlier.length - 1] : null;
      const d = prev && typeof r.total === 'number' ? deltaInfo(r.instrument, prev.total, r.total) : null;
      const what = r.subscales && r.instrument === 'hads' ? `A ${r.subscales.A} · D ${r.subscales.D}` : r.total;
      add(d && d.worse ? '↑' : d && d.word === 'лучше' ? '↓' : '•', d ? (d.worse ? 'Хуже' : d.word === 'лучше' ? 'Лучше' : 'Новое') : 'Новое',
        `${instrumentLabel(r.instrument)}${r.stub ? ' (демо-балл)' : ''}: ${what}${d ? ` (${d.text})` : ' — первый результат'} · ${formatDate(r.date || String(r.at).slice(0, 10))}${r.kind === 'online' ? '' : `, ${SOURCE_LABEL[r.kind].toLowerCase()}`}`);
    }
    if (fresh.length > shownFresh.length) add('•', 'Ещё', `и ещё ${fresh.length - shownFresh.length} новых результатов — во вкладке «Шкалы и динамика»`, `/patients/${patientId}/scales`);

    // 3. тренд дневника
    const tr = diaryTrend(patientId, now);
    if (tr.cur !== null && tr.prev !== null && Math.abs(tr.cur - tr.prev) >= 1) {
      const down = tr.cur < tr.prev;
      add(down ? '↓' : '↑', down ? 'Ниже' : 'Выше', `Дневник: среднее настроение за 7 дней ${fmt1(tr.cur)} из 10 (неделей ранее ${fmt1(tr.prev)})`, `/patients/${patientId}/diary`);
    }

    // 4. пропуски назначений (нейтрально, не «красное»)
    const missed = db
      .prepare("SELECT instrument, assigned_at, due_date FROM instrument_assignments WHERE patient_id = ? AND status = 'pending' ORDER BY assigned_at")
      .all(patientId)
      .filter((a) => {
        const days = Math.floor((now.getTime() - (parseTs(a.assigned_at)?.getTime() || now.getTime())) / DAY);
        return (a.due_date && a.due_date < isoDate(now)) || days >= 7;
      });
    if (missed.length) {
      add('○', 'Не пройдено', `Не пройдено назначенное: ${missed.slice(0, 3).map((a) => `${instrumentLabel(a.instrument)} (с ${formatDate(String(a.assigned_at).slice(0, 10))})`).join('; ')}${missed.length > 3 ? ` и ещё ${missed.length - 3}` : ''}`);
    }

    // 5. новые сообщения пациента врачу
    const sinceSql = sqlTime(since);
    const msgs = db.prepare("SELECT COUNT(*) AS n FROM patient_contact_requests WHERE patient_id = ? AND created_at > ? AND (clinician_id IS NULL OR clinician_id = ?)").get(patientId, sinceSql, actorId).n;
    if (msgs) add('✉', 'Сообщение', `Новых обращений пациента: ${msgs}`);
  }

  // 6. ждёт ввода врача
  const waiting = db.prepare("SELECT instrument FROM instrument_assignments WHERE patient_id = ? AND status = 'waiting_entry' ORDER BY id").all(patientId);
  if (waiting.length) add('✎', 'Ждёт ввода', `Ждёт вашего ввода: ${waiting.slice(0, 3).map((w) => instrumentLabel(w.instrument)).join(', ')}${waiting.length > 3 ? ` и ещё ${waiting.length - 3}` : ''}`, `/patients/${patientId}/offline#waiting`);

  const capped = rows.slice(0, CHANGES_MAX_ROWS);
  const sinceText = first ? `за ${FIRST_VIEW_DAYS} дней (первый просмотр)` : `с вашего последнего просмотра ${formatDate(sqlTime(since).slice(0, 16))}`;
  return {
    sinceText, first, since, rows: capped, truncated: rows.length - capped.length,
    empty: capped.length === 0, unchangedText: `Без изменений с ${formatDate(sqlTime(since).slice(0, 10))}`,
  };
}

// ---------- журнал ----------

const JOURNAL_TYPES = { assignment: 'Назначения', result: 'Результаты', crisis: 'Эскалации и обращения', view: 'Просмотры' };

function viewLabel(action) {
  const t = require('./labels').actionLabel(action);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function journal(patientId, { type, from, to } = {}, consentOk = true) {
  const ev = [];
  const name = (id) => { const u = db.prepare('SELECT full_name FROM users WHERE id = ?').get(id); return u ? u.full_name : '—'; };
  const push = (t, at, text) => ev.push({ type: t, at, atMs: parseTs(at)?.getTime() || 0, text });
  for (const a of db.prepare('SELECT * FROM instrument_assignments WHERE patient_id = ?').all(patientId)) {
    const lbl = instrumentLabel(a.instrument);
    push('assignment', a.assigned_at, `Назначено: ${lbl}${a.auto_assigned ? ' (автоматически по кризисному протоколу)' : ` — ${name(a.assigned_by)}`}${a.status === 'waiting_entry' || a.entry_protocol_id ? ' · ждёт ввода врачом' : ''}${a.due_date ? ` · срок ${formatDate(a.due_date)}` : ''}`);
    if (a.completed_at) push('assignment', a.completed_at, `Выполнено: ${lbl}`);
    if (a.cancelled_at) push('assignment', a.cancelled_at, `Отменено назначение: ${lbl} — ${name(a.cancelled_by)}${a.cancel_reason ? `, причина: ${a.cancel_reason}` : ''}`);
  }
  if (consentOk) {
    for (const r of db.prepare('SELECT instrument, total_score, created_at FROM online_results WHERE patient_id = ?').all(patientId)) {
      push('result', r.created_at, `Результат (онлайн): ${instrumentLabel(r.instrument)}, балл ${r.total_score}${catalog.isStub(r.instrument) ? ' (демо-балл)' : ''}`);
    }
  }
  for (const r of db.prepare('SELECT * FROM offline_results WHERE patient_id = ?').all(patientId)) {
    push('result', r.created_at, `Результат (очно): ${instrumentLabel(r.instrument)}${r.total_score !== null ? `, балл ${r.total_score}` : ''} — ${name(r.entered_by)}${r.invalid_at ? ' · помечен как ошибочный ввод' : ''}`);
    if (r.invalid_at) push('result', r.invalid_at, `Помечено «ошибочный ввод»: ${instrumentLabel(r.instrument)} — ${name(r.invalid_by)}${r.invalid_reason ? `, причина: ${r.invalid_reason}` : ''}`);
  }
  for (const r of db.prepare('SELECT * FROM catalog_protocols WHERE patient_id = ?').all(patientId)) {
    push('result', r.created_at, `Протокол врача: ${instrumentLabel(r.instrument)} (${r.status === 'ready' ? 'готово' : 'черновик'}) — ${name(r.entered_by)}`);
    if (r.invalid_at) push('result', r.invalid_at, `Помечено «ошибочный ввод»: протокол ${instrumentLabel(r.instrument)} — ${name(r.invalid_by)}${r.invalid_reason ? `, причина: ${r.invalid_reason}` : ''}`);
  }
  for (const e of db.prepare('SELECT * FROM crisis_escalations WHERE patient_id = ?').all(patientId)) {
    push('crisis', e.created_at, `Эскалация: ${require('./labels').tierLabel(e.tier)} (${instrumentLabel(e.instrument)})`);
    if (e.acknowledged_at) push('crisis', e.acknowledged_at, `Эскалация (${require('./labels').tierLabel(e.tier)}) подтверждена — ${name(e.acknowledged_by)}${e.ack_outcome ? `, исход: ${e.ack_outcome}` : ''}`);
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='patient_appeals'").get()) {
    for (const a of db.prepare('SELECT * FROM patient_appeals WHERE patient_id = ?').all(patientId)) {
      push('crisis', a.created_at, 'Обращение пациента «Мне сейчас тяжело»');
      if (a.acknowledged_at) push('crisis', a.acknowledged_at, `Обращение пациента подтверждено — ${name(a.acknowledged_by)}`);
    }
  }
  for (const c of db.prepare('SELECT created_at FROM patient_contact_requests WHERE patient_id = ?').all(patientId)) {
    push('crisis', c.created_at, 'Пациент попросил связаться (через ИИ-помощника)');
  }
  for (const v of db.prepare('SELECT * FROM phi_access_log WHERE patient_id = ?').all(patientId)) {
    push('view', v.created_at, `${viewLabel(v.action)} — ${name(v.actor_id)}`);
  }
  let out = ev;
  if (type && JOURNAL_TYPES[type]) out = out.filter((e) => e.type === type);
  if (from) out = out.filter((e) => String(e.at).slice(0, 10) >= from);
  if (to) out = out.filter((e) => String(e.at).slice(0, 10) <= to);
  out.sort((a, b) => b.atMs - a.atMs);
  return { events: out.slice(0, 300), total: out.length, types: JOURNAL_TYPES };
}

// ---------- справка «К приёму» ----------

function visitSummary(patientId, actor, now = new Date()) {
  const p = patientBase(patientId);
  const consentOk = !!p.clinical_consent_given && p.account_status === 'active' && !p.consent_revoked_at;
  const ch = changes(patientId, actor.id, { consentOk, now });
  const adherence = db.prepare("SELECT status FROM instrument_assignments WHERE patient_id = ? AND status IN ('pending','completed') AND assigned_at >= ?").all(patientId, sqlTime(new Date(now.getTime() - rules.CONFIG.adherenceWindowDays * DAY)));
  const tr = diaryTrend(patientId, now);
  const waiting = db.prepare("SELECT instrument FROM instrument_assignments WHERE patient_id = ? AND status = 'waiting_entry'").all(patientId).map((w) => instrumentLabel(w.instrument));
  const v = require('./triage_data').verdictFor(actor.id, patientId, now);
  return {
    patient: p, consentOk, changes: ch, scores: consentOk ? keyScores(patientId, consentOk) : [], escalations: openEscalations(patientId, now),
    diary: consentOk ? tr : null, adherence: consentOk ? { done: adherence.filter((a) => a.status === 'completed').length, total: adherence.length, days: rules.CONFIG.adherenceWindowDays } : null,
    waiting, verdict: v ? v.verdict : null, generatedAt: now, disclaimer: CLINICAL_DISCLAIMER,
  };
}

function visitText(s) {
  const L = [];
  L.push(`СПРАВКА К ПРИЁМУ — ${s.patient.full_name}`);
  L.push(`Сформировано: ${formatDate(sqlTime(s.generatedAt).slice(0, 16))}`);
  L.push(s.disclaimer);
  L.push('');
  if (s.verdict) L.push(`Светофор: ${s.verdict.word} — ${s.verdict.oneLine}`);
  if (!s.consentOk) L.push('Клиническое согласие не оформлено или отозвано: данные пациента врачу не передаются.');
  L.push('');
  L.push(`Что изменилось ${s.changes.sinceText}:`);
  if (s.changes.empty) L.push(`  ${s.changes.unchangedText}`);
  for (const r of s.changes.rows) L.push(`  - ${r.word}: ${r.text}`);
  if (s.scores.length) {
    L.push('');
    L.push('Последние баллы:');
    for (const k of s.scores) L.push(`  - ${k.title}: ${k.value}${k.band ? ` (${k.band})` : ''}, ${formatDate(k.date)}${k.delta ? `; ${k.delta.text}` : ''}`);
  }
  if (s.diary && s.diary.count) {
    L.push('');
    L.push(`Дневник: записей ${s.diary.count}${s.diary.cur !== null ? `; среднее за 7 дней ${fmt1(s.diary.cur)}` : ''}${s.diary.prev !== null ? `, неделей ранее ${fmt1(s.diary.prev)}` : ''}.`);
  }
  if (s.adherence && s.adherence.total) L.push(`Приверженность: пройдено ${s.adherence.done} из ${s.adherence.total} назначенных за ${s.adherence.days} дн.`);
  if (s.waiting.length) L.push(`Ждёт ввода врачом: ${s.waiting.join(', ')}`);
  if (s.escalations.length) {
    L.push('');
    L.push('Открытые эскалации:');
    for (const e of s.escalations) L.push(`  - ${e.label}${e.sla ? ` (${e.sla.text})` : ''}`);
  }
  L.push('');
  L.push(s.disclaimer);
  return L.join('\n') + '\n';
}

module.exports = {
  TABS, TAB_KEYS, CLINICAL_DISCLAIMER, AUDIT_WINDOW_MIN, FIRST_VIEW_DAYS, CHANGES_MAX_ROWS, PERIODS, SOURCE_LABEL, JOURNAL_TYPES,
  actionFor, logView, logViewMany, lastView, patientBase, coClinicians, gatherResults, deltaInfo, scalesView, renderChart, sparkline, keyScores,
  openEscalations, diaryTrend, changes, journal, visitSummary, visitText, fmt1, sqlTime, isoDate, viewLabel,
};
