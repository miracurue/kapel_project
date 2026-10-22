'use strict';

/**
 * Отчёт по когорте своих пациентов (REQ-TLS-008): только агрегаты, без ФИО/ID/e-mail. Берутся закреплённые за врачом
 * неархивные пациенты с действующим клиническим согласием (данные без согласия не попадают в агрегаты); заглушки каталога
 * не учитываются. Порог MIN_N: при меньшем числе пациентов (в целом и по каждому разрезу) показывается «слишком мало
 * для агрегата» — чтобы по агрегату нельзя было узнать конкретного человека. Порог — review-required.
 */

const db = require('../db');
const card = require('../patient_card');
const triage = require('../triage_data');
const rules = require('../triage_rules');
const { INSTRUMENTS } = require('../instruments');
const { csvCell } = require('../research_export');

const MIN_N = 5;
const TOO_FEW = 'Слишком мало для агрегата: нужно не менее 5 пациентов.';
const STATUS_ORDER = [['red', 'Кризис'], ['yellow', 'Внимание'], ['gray', 'Мало данных'], ['green', 'Спокойно']];

/** Шкалы с интерпретационными диапазонами, доступные в разрезе. */
function scaleOptions() {
  return Object.values(INSTRUMENTS).filter((d) => d.bands && d.code !== 'hads' && d.code !== 'cssrs').map((d) => ({ code: d.code, title: d.title }));
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const round1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

function summary(clinicianId, { scale = 'phq9', now = new Date() } = {}) {
  const list = triage.listPatients(clinicianId, { now }).patients; // неархивные (+красные архивные не включаем)
  const patients = list.filter((p) => !p.archived);
  const eligible = patients.filter((p) => p.clinical_consent_given && p.account_status === 'active');
  const out = { minN: MIN_N, tooFew: TOO_FEW, total: patients.length, eligible: eligible.length, scale: null, generatedAt: now };
  out.scaleOptions = scaleOptions();
  const def = INSTRUMENTS[scale] && INSTRUMENTS[scale].bands ? INSTRUMENTS[scale] : INSTRUMENTS.phq9;
  out.scale = { code: def.code, title: def.title };
  if (patients.length < MIN_N) { out.status = null; out.tooFewAll = true; return out; }

  out.status = STATUS_ORDER.map(([k, label]) => ({ key: k, label, n: patients.filter((p) => p.verdict.color === k).length }));

  // последние и первые результаты выбранной шкалы по согласившимся пациентам
  const per = [];
  for (const p of eligible) {
    const rs = card.gatherResults(p.id, { consentOk: true }).filter((r) => r.instrument === def.code && !r.stub && r.total !== null);
    if (rs.length) per.push({ first: rs[0], last: rs[rs.length - 1], n: rs.length, all: rs });
  }
  const band = (t) => (def.bands.find((b) => t <= b.max) || def.bands[def.bands.length - 1]).label;
  out.dist = { n: per.length, tooFew: per.length < MIN_N, rows: [] };
  if (!out.dist.tooFew) {
    out.dist.rows = def.bands.map((b) => ({ label: b.label, n: per.filter((x) => band(x.last.total) === b.label).length }));
    out.dist.mean = round1(mean(per.map((x) => x.last.total)));
  }
  const repeated = per.filter((x) => x.n >= 2);
  out.dynamics = { n: repeated.length, tooFew: repeated.length < MIN_N };
  if (!out.dynamics.tooFew) {
    out.dynamics.meanFirst = round1(mean(repeated.map((x) => x.first.total)));
    out.dynamics.meanLast = round1(mean(repeated.map((x) => x.last.total)));
    out.dynamics.meanChange = round1(mean(repeated.map((x) => x.last.total - x.first.total)));
    const dir = rules.CONFIG.lowerIsWorse.includes(def.code) ? -1 : 1;
    out.dynamics.worse = repeated.filter((x) => dir * (x.last.total - x.first.total) > 0).length;
    out.dynamics.better = repeated.filter((x) => dir * (x.last.total - x.first.total) < 0).length;
    out.dynamics.same = repeated.length - out.dynamics.worse - out.dynamics.better;
  }
  // приверженность: назначенные и пройденные за окно (реальные шкалы), по согласившимся
  const days = rules.CONFIG.adherenceWindowDays;
  const since = new Date(now.getTime() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const ids = eligible.map((p) => p.id);
  let assigned = 0; let done = 0; let withAssign = 0;
  for (const id of ids) {
    const rows = db.prepare("SELECT status, instrument FROM instrument_assignments WHERE patient_id = ? AND status IN ('pending','completed') AND assigned_at >= ?").all(id, since)
      .filter((r) => INSTRUMENTS[r.instrument]);
    if (rows.length) withAssign += 1;
    assigned += rows.length;
    done += rows.filter((r) => r.status === 'completed').length;
  }
  out.adherence = { days, patients: withAssign, tooFew: withAssign < MIN_N };
  if (!out.adherence.tooFew) { out.adherence.assigned = assigned; out.adherence.done = done; out.adherence.pct = assigned ? Math.round((done * 100) / assigned) : null; }
  return out;
}

/** CSV только с агрегатами; формулы экранируются. */
function toCsv(s) {
  const L = [['раздел', 'показатель', 'значение'].join(';')];
  const add = (a, b, c) => L.push([a, b, c].map(csvCell).join(';'));
  if (s.tooFewAll) add('общее', 'пациентов', 'слишком мало для агрегата');
  else {
    add('общее', 'пациентов', s.total);
    s.status.forEach((x) => add('статус', x.label, x.n));
    if (s.dist.tooFew) add(`шкала ${s.scale.code}`, 'распределение', 'слишком мало для агрегата');
    else s.dist.rows.forEach((x) => add(`шкала ${s.scale.code}`, x.label, x.n));
    if (s.dynamics.tooFew) add(`шкала ${s.scale.code}`, 'динамика', 'слишком мало для агрегата');
    else { add(`шкала ${s.scale.code}`, 'средний первый балл', s.dynamics.meanFirst); add(`шкала ${s.scale.code}`, 'средний последний балл', s.dynamics.meanLast); add(`шкала ${s.scale.code}`, 'среднее изменение', s.dynamics.meanChange); }
    if (s.adherence.tooFew) add('приверженность', 'пройдено/назначено', 'слишком мало для агрегата');
    else add('приверженность', `пройдено из назначенных за ${s.adherence.days} дн., %`, s.adherence.pct === null ? '' : s.adherence.pct);
  }
  return '﻿' + L.join('\r\n') + '\r\n';
}

module.exports = { summary, toCsv, scaleOptions, MIN_N, TOO_FEW };
