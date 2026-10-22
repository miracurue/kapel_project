'use strict';

/**
 * Анонимный калькулятор шкал (REQ-TLS-001). Чистая функция поверх существующего скоринга
 * (instruments.js / каталог): никаких обращений к БД на расчёт, ответы нигде не сохраняются и не логируются.
 * Сохранение результата в карточку закреплённого пациента (по желанию врача) — отдельная функция saveToPatient():
 * пишется только итог, как при ручном вводе очного бланка; сырые ответы не сохраняются (кроме п.9 PHQ-9 для сверки).
 */

const db = require('../db');
const { INSTRUMENTS } = require('../instruments');
const catalog = require('../instruments_catalog');
const comparison = require('../comparison');
const assignments = require('../assignments');
const { canAccessPatient } = require('../permissions');

const NOT_SAVED = 'Ничего не сохраняется: ответы и результат остаются только на этой странице.';
const SCOPE = 'Справка по правилам шкалы, не диагноз и не заключение; решение за врачом.';
const NO_ESCALATION = 'Пациент не выбран, поэтому эскалация в кризисную очередь НЕ создана — оцените ситуацию и действуйте сами.';

function normalizeItems(items) {
  return items.map((it) => (typeof it === 'string' ? { text: it } : { text: it.text, subscale: it.subscale }));
}

/** Шкалы с автоскорингом: реальные (instruments.js) и онлайн-заглушки каталога. */
function list() {
  const real = Object.values(INSTRUMENTS)
    .filter((d) => d.patientSelfTest)
    .map((d) => ({ code: d.code, title: d.title, stub: false }));
  const stubs = catalog.listCatalog({ mode: 'online_stub' }).map((e) => ({ code: e.code, title: e.title, stub: true }));
  return [...real, ...stubs];
}

/** Описание шкалы для формы: пункты, варианты ответов, критический пункт. null — шкалы нет / автоскоринга нет. */
function get(code) {
  const c = String(code || '');
  const def = INSTRUMENTS[c] && INSTRUMENTS[c].patientSelfTest ? INSTRUMENTS[c] : null;
  if (def) {
    return {
      code: c, title: def.title, stub: false, items: normalizeItems(def.items), options: def.options,
      maxPerItem: def.maxPerItem, criticalItemIndex: def.criticalItemIndex, note: null,
    };
  }
  const e = catalog.getEntry(c);
  if (e && e.mode === 'online_stub') {
    return {
      code: c, title: e.title, stub: true, items: normalizeItems(e.items), options: e.options, maxPerItem: e.maxPerItem,
      criticalItemIndex: null,
      note: `${catalog.STUB_DISCLAIMER} Подсчёт демонстрационный: простая сумма, порогов и толкования нет; клинического смысла результат не имеет.`,
    };
  }
  return null;
}

/** Из тела формы (a0..aN) -> массив чисел; незаполненные пункты перечисляются в ошибке. */
function parseAnswers(scale, body) {
  const answers = [];
  const missing = [];
  scale.items.forEach((_, i) => {
    const raw = body && body[`a${i}`];
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (v === undefined || v === null || String(v).trim() === '') { missing.push(i + 1); answers.push(null); return; }
    const n = Number(v);
    answers.push(Number.isInteger(n) ? n : NaN);
  });
  return { answers, missing };
}

/** Подсчёт. Не бросает: возвращает { ok:false, error } при неполных/неверных ответах. */
function compute(code, body) {
  const scale = get(code);
  if (!scale) return { ok: false, error: 'Для этой шкалы автоматического подсчёта нет.' };
  const { answers, missing } = parseAnswers(scale, body);
  if (missing.length) {
    return { ok: false, scale, answers, error: `Не заполнены пункты: ${missing.join(', ')}. Для подсчёта нужны ответы на все пункты.` };
  }
  if (answers.some((a) => !Number.isInteger(a) || a < 0 || a > scale.maxPerItem)) {
    return { ok: false, scale, answers, error: `Ответ на пункт должен быть целым числом от 0 до ${scale.maxPerItem}.` };
  }
  const r = catalog.scoreAny(code, answers);
  const critical = scale.criticalItemIndex !== null && scale.criticalItemIndex !== undefined && answers[scale.criticalItemIndex] >= 1;
  const result = {
    total: r.total, band: r.band, subscales: r.subscales, riskReasons: r.riskReasons, riskFlag: r.riskFlag,
    critical, noEscalation: NO_ESCALATION, notSaved: NOT_SAVED, scope: SCOPE,
  };
  return { ok: true, scale, answers, result, text: resultText(scale, result) };
}

function subscaleText(code, sub) {
  if (!sub) return '';
  if (code === 'hads') return `; тревога ${sub.A}, депрессия ${sub.D}`;
  if (code === 'cssrs') return `; уровень идеации ${sub.ideationLevel}, поведение: ${sub.behavior ? 'да' : 'нет'}`;
  return '';
}

/** Текст для кнопки «Копировать результат»: без данных пациента, с пометками. */
function resultText(scale, r) {
  const L = [`${scale.title}`, `Итог: ${r.total}${subscaleText(scale.code, r.subscales)}`, `Уровень: ${r.band}`];
  if (scale.stub) L.push(`ЗАГЛУШКА: ${catalog.STUB_DISCLAIMER}`);
  if (r.riskReasons.length) {
    L.push('Сработали правила шкалы:');
    for (const x of r.riskReasons) L.push(`  - ${x}`);
    L.push(r.noEscalation);
  }
  L.push(r.scope, r.notSaved);
  return L.join('\n');
}

// ---------- сохранение в карточку (по желанию врача) ----------

const NOT_SAVEABLE = new Set(['cssrs']);

/**
 * Сохранить ИТОГ в карточку закреплённого пациента (как ручной ввод очного бланка).
 * C-SSRS не сохраняется: этот скринер идёт только по кризисному пути с пациентом.
 * @returns {{ok:boolean, error?:string}}
 */
function saveToPatient(user, patientId, code, computed, date) {
  const pid = Number(patientId);
  if (!canAccessPatient(user, pid, db)) return { ok: false, error: 'Пациент не закреплён за вами.' };
  { const wb = assignments.writeBlocked(pid); if (wb.blocked) return { ok: false, error: wb.reason }; }
  if (!computed || !computed.ok) return { ok: false, error: 'Нечего сохранять.' };
  if (NOT_SAVEABLE.has(code)) return { ok: false, error: 'C-SSRS в карточку из калькулятора не сохраняется: скринер проводится с пациентом и подчиняется кризисному протоколу.' };
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : new Date().toISOString().slice(0, 10);
  const r = computed.result;
  const note = 'Внесено из калькулятора шкал; ответы по пунктам не сохранены.';
  const tx = db.transaction(() => {
    if (computed.scale.stub) {
      const info = db
        .prepare("INSERT INTO catalog_protocols (patient_id, entered_by, instrument, test_date, protocol_json, status) VALUES (?, ?, ?, ?, ?, 'ready')")
        .run(pid, user.id, code, d, JSON.stringify({ score: r.total, observations: note }));
      assignments.completeWaiting(pid, code, Number(info.lastInsertRowid));
    } else {
      const item9 = code === 'phq9' ? computed.answers[8] : null;
      const info = db
        .prepare(
          `INSERT INTO offline_results (patient_id, entered_by, instrument, total_score, subscales_json, item9_score, band, risk_flag, risk_reasons_json, test_date, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(pid, user.id, code, r.total, r.subscales ? JSON.stringify(r.subscales) : null, item9, r.band, r.riskFlag ? 1 : 0, JSON.stringify(r.riskReasons), d, note);
      comparison.createComparisonPairIfPossible(db.prepare('SELECT * FROM offline_results WHERE id = ?').get(info.lastInsertRowid));
      assignments.completeWaiting(pid, code, null);
    }
    db.prepare('INSERT INTO phi_access_log (actor_id, patient_id, action) VALUES (?, ?, ?)').run(user.id, pid, 'tools_calculator_save');
  });
  tx();
  return { ok: true };
}

module.exports = { list, get, compute, saveToPatient, resultText, NOT_SAVED, NO_ESCALATION, SCOPE };
