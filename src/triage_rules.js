'use strict';

/**
 * «Светофор» кабинета клинициста (REQ-CLN-001…003). Чистые правила без БД:
 * вход — снимок данных пациента (собирает src/triage_data.js), выход — цвет,
 * подпись и список причин «почему». ВСЕ ПОРОГИ — review-required (OQ-8):
 * значения по умолчанию — заглушки до клинического утверждения; меняются
 * только здесь (или передачей config в evaluate), без правки логики.
 *
 * Цвета и порядок важности:
 *   red    «Кризис»      — открытая эскалация Tier >=2, обращение пациента
 *                          (OQ-13: приоритет как у Tier 2) или просрочка SLA.
 *                          Красный — только при реальной эскалации.
 *   yellow «Внимание»    — открытая Tier 1; ухудшение; нет активности >= N дней;
 *                          назначенный тест не пройден >= N дней; низкая приверженность.
 *   gray   «Мало данных» — нет результатов не-заглушек, либо нет действующего
 *                          клинического согласия (данные врачу не передаются).
 *   green  «Спокойно»    — иначе.
 * Результаты и назначения тестов-заглушек каталога (stub) на светофор не влияют.
 * Светофор — подсказка «куда посмотреть», не диагноз и не заключение.
 */

const CONFIG = Object.freeze({
  // дней без любой активности пациента (результат, дневник, чат) -> жёлтый. review-required (OQ-8)
  inactivityDays: 14,
  // назначенный (не заглушка) тест не пройден столько дней -> жёлтый. review-required
  overdueAssignmentDays: 14,
  // низкая приверженность: за последние adherenceWindowDays назначено >= adherenceMinAssigned
  // тестов, а пройдено меньше adherenceMinRatio. review-required
  adherenceWindowDays: 56,
  adherenceMinAssigned: 3,
  adherenceMinRatio: 0.5,
  // ухудшение: последний результат шкалы хуже предыдущего (более тяжёлый уровень
  // ИЛИ ухудшение балла минимум на worseningMinDelta этой шкалы), если он не старше worseningWindowDays.
  // Значения — «минимальная клинически значимая разница» по умолчанию, ВСЕ review-required (OQ-8):
  // PHQ-9 5, GAD-7 4, HADS (каждая подшкала A и D) 3, WHO-5 10 (падение: порог −10). Смена уровня (band) в худшую
  // сторону даёт «Внимание» независимо от величины. Ключ default — для шкал без своего порога (прежнее поведение: любой рост).
  // Можно передать и одно число — оно тогда действует на все шкалы (удобно для тестов и «нулевого» порога).
  worseningMinDelta: Object.freeze({ phq9: 5, gad7: 4, hads: 3, who5: 10, default: 1 }),
  worseningWindowDays: 28,
  // W2.F: приверженность приёму по плану врача (отметки пациента). ПО УМОЛЧАНИЮ ВЫКЛЮЧЕНО: светофор не учитывает приём,
  // пока клинический владелец не утвердит. Порог review-required. Учитываются только отметки, которыми пациент делится.
  medAdherenceEnabled: false,
  medAdherenceMinExpected: 4,
  medAdherenceMinRatio: 0.5,
  // шкалы, где БОЛЬШЕ балл = ХУЖЕ / МЕНЬШЕ балл = ХУЖЕ. Остальные (C-SSRS, СМИЛ) не сравниваются. HADS сравнивается по подшкалам A и D отдельно.
  higherIsWorse: ['phq9', 'gad7', 'bdi2', 'stai', 'hads'],
  lowerIsWorse: ['who5'],
});

const COLORS = Object.freeze({
  red: { key: 'red', word: 'Кризис', icon: '⚠', rank: 0 },
  yellow: { key: 'yellow', word: 'Внимание', icon: '◐', rank: 1 },
  gray: { key: 'gray', word: 'Мало данных', icon: '○', rank: 2 },
  green: { key: 'green', word: 'Спокойно', icon: '✓', rank: 3 },
});

const DAY = 86400000;

function parseTs(v) {
  if (v instanceof Date) return v;
  if (!v) return null;
  const s = String(v);
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.includes('T') ? s + 'Z' : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

function minutesText(ms) {
  const m = Math.max(1, Math.round(Math.abs(ms) / 60000));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ч ${m % 60} мин`;
  return `${Math.floor(h / 24)} дн`;
}

/** Текст SLA: «осталось 12 мин» / «просрочено на 7 мин» / «без срока SLA». */
function slaText(dueAt, now) {
  const due = parseTs(dueAt);
  if (!due) return { overdue: false, text: 'без срока SLA' };
  const diff = due.getTime() - now.getTime();
  return diff >= 0
    ? { overdue: false, text: `осталось ${minutesText(diff)}` }
    : { overdue: true, text: `просрочено на ${minutesText(diff)}` };
}

function escalationLabel(e) {
  return e.kind === 'appeal' ? 'Обращение пациента' : `Эскалация: ${require("./labels").tierLabel(e.tier)}`;
}

function bandIndex(bands, total) {
  if (!bands) return null;
  const i = bands.findIndex((b) => total <= b.max);
  return i < 0 ? bands.length - 1 : i;
}

function minDeltaFor(cfg, code) {
  const m = cfg.worseningMinDelta;
  if (typeof m === 'number') return m;
  const v = m && (m[code] !== undefined ? m[code] : m.default);
  return typeof v === 'number' ? v : 1;
}

/** Ухудшение между двумя значениями одной шкалы: delta >= порога ИЛИ переход в более тяжёлый уровень. */
function worse(prevTotal, lastTotal, bands, sign, minDelta) {
  const delta = (lastTotal - prevTotal) * sign;
  const bi = bandIndex(bands, lastTotal);
  const bp = bandIndex(bands, prevTotal);
  const levelWorse = bi !== null && bp !== null && (sign > 0 ? bi > bp : bi < bp);
  return delta >= minDelta || levelWorse ? { levelWorse } : null;
}

/**
 * results — [{id,instrument,total,at,bands,subscales?}] одной шкалы по возрастанию времени.
 * HADS: сравниваются подшкалы A и D по отдельности (сумма A+D не интерпретируется).
 */
function detectWorsening(results, cfg, now) {
  if (results.length < 2) return null;
  const prev = results[results.length - 2];
  const last = results[results.length - 1];
  const at = parseTs(last.at);
  if (!at || now.getTime() - at.getTime() > cfg.worseningWindowDays * DAY) return null;
  const code = last.instrument;
  const sign = cfg.lowerIsWorse.includes(code) ? -1 : cfg.higherIsWorse.includes(code) ? 1 : 0;
  if (!sign) return null;
  const minDelta = minDeltaFor(cfg, code);
  if (code === 'hads') {
    if (!last.subscales || !prev.subscales) return null;
    for (const k of ['A', 'D']) {
      if (typeof last.subscales[k] !== 'number' || typeof prev.subscales[k] !== 'number') continue;
      const w = worse(prev.subscales[k], last.subscales[k], last.bands, sign, minDelta); // bands HADS заданы на подшкалу (0-21)
      if (w) return { instrument: code, label: `HADS-${k}`, sub: k, from: prev.subscales[k], to: last.subscales[k], levelWorse: w.levelWorse, resultId: last.id };
    }
    return null;
  }
  const w = worse(prev.total, last.total, last.bands, sign, minDelta);
  return w ? { instrument: code, label: code.toUpperCase(), from: prev.total, to: last.total, levelWorse: w.levelWorse, resultId: last.id } : null;
}

/**
 * snapshot:
 *  consent {clinical:boolean, active:boolean}
 *  openEscalations [{id, tier, kind:'tier'|'appeal', due_at, unresolved}]
 *  results [{id, instrument, total, at, bands, stub}] (онлайн + очные)
 *  pending [{id, instrument, assigned_at, stub}] ожидающие назначения
 *  assignedInWindow / completedInWindow: число назначений не-заглушек за окно
 *  lastActivityAt: последняя активность (результат не-заглушки, дневник, чат) или null
 * Возвращает { color, word, icon, rank, reasons:[{level,code,key,text}], oneLine, why }.
 */
function evaluate(snapshot, now = new Date(), config = CONFIG) {
  const cfg = { ...CONFIG, ...config };
  const reasons = [];
  const add = (level, code, key, text) => reasons.push({ level, code, key, text });

  // --- красный/жёлтый по эскалациям: видны всегда, даже без согласия (OQ-6) ---
  const effTier = (e) => (e.kind === 'appeal' ? 2 : e.tier);
  const escs = [...(snapshot.openEscalations || [])].sort((a, b) => effTier(b) - effTier(a));
  for (const e of escs) {
    const high = e.kind === 'appeal' || e.tier >= 2;
    if (high) {
      const sla = slaText(e.due_at, now);
      let t = `${escalationLabel(e)} ${e.kind === 'appeal' ? 'не подтверждено' : 'не подтверждена'}, SLA: ${sla.text}`;
      if (e.unresolved) t += '; нет резерва — разбор вручную';
      add('red', sla.overdue ? 'sla_overdue' : 'open_high', `esc:${e.id}:${e.kind || 'tier'}`, t);
    } else {
      add('yellow', 'open_tier1', `esc:${e.id}:tier`, 'Открыта эскалация уровня 1 (повышенное внимание), ждёт подтверждения');
    }
  }

  const consentOk = !snapshot.consent || (snapshot.consent.clinical && snapshot.consent.active);
  if (!consentOk) {
    add('gray', 'no_consent', 'no_consent', 'Нет действующего клинического согласия — данные пациента врачу не передаются');
  } else {
    const real = (snapshot.results || []).filter((r) => !r.stub);
    const byInstr = new Map();
    for (const r of real) {
      if (!byInstr.has(r.instrument)) byInstr.set(r.instrument, []);
      byInstr.get(r.instrument).push(r);
    }
    for (const list of byInstr.values()) {
      list.sort((a, b) => parseTs(a.at) - parseTs(b.at));
      const w = detectWorsening(list, cfg, now);
      if (w) {
        add('yellow', 'worsening', `worsening:${w.instrument}:${w.resultId}`,
          `Ухудшение по ${w.label}: ${w.from} → ${w.to}${w.levelWorse ? ' (более тяжёлый уровень)' : ''}`);
      }
    }
    const last = parseTs(snapshot.lastActivityAt);
    if (last) {
      const days = Math.floor((now.getTime() - last.getTime()) / DAY);
      if (days >= cfg.inactivityDays) add('yellow', 'inactive', 'inactive', `Нет активности ${days} дн. (порог ${cfg.inactivityDays})`);
    }
    for (const p of snapshot.pending || []) {
      if (p.stub) continue;
      const a = parseTs(p.assigned_at);
      if (!a) continue;
      const days = Math.floor((now.getTime() - a.getTime()) / DAY);
      if (days >= cfg.overdueAssignmentDays) {
        add('yellow', 'overdue_assignment', `overdue:${p.id}`,
          `Назначенный тест ${String(p.instrument).toUpperCase()} не пройден ${days} дн. (порог ${cfg.overdueAssignmentDays})`);
      }
    }
    if (snapshot.assignedInWindow >= cfg.adherenceMinAssigned &&
        snapshot.completedInWindow / snapshot.assignedInWindow < cfg.adherenceMinRatio) {
      add('yellow', 'low_adherence', 'low_adherence',
        `Низкая приверженность: пройдено ${snapshot.completedInWindow} из ${snapshot.assignedInWindow} назначенных за ${cfg.adherenceWindowDays} дн.`);
    }
    const m = snapshot.meds;
    if (cfg.medAdherenceEnabled && m && m.expected >= cfg.medAdherenceMinExpected && m.taken / m.expected < cfg.medAdherenceMinRatio) {
      add('yellow', 'low_med_adherence', 'low_med_adherence',
        `Мало отметок «принято» по плану приёма: ${m.taken} из ${m.expected} за ${m.days} дн. (отметки пациента; порог ${cfg.medAdherenceMinRatio})`);
    }
    if (real.length === 0 && !snapshot.lastActivityAt && !reasons.length) {
      add('gray', 'no_data', 'no_data', 'Пока нет результатов (тесты-заглушки не учитываются) — недостаточно данных');
    }
  }

  const levels = new Set(reasons.map((r) => r.level));
  const level = levels.has('red') ? 'red' : levels.has('yellow') ? 'yellow' : levels.has('gray') ? 'gray' : 'green';
  const shown = reasons.filter((r) => r.level === level);
  const color = COLORS[level];
  const main = level === 'green' ? 'Нет признаков, требующих внимания, по правилам светофора' : shown[0].text;
  const oneLine = shown.length > 1 ? `${main} (+${shown.length - 1})` : main;
  return {
    color: level,
    word: color.word,
    icon: color.icon,
    rank: color.rank,
    reasons: shown,
    allReasons: reasons,
    oneLine,
    why: level === 'green' ? main : shown.map((r) => r.text).join('; '),
  };
}

const DISCLAIMER = 'Светофор — подсказка, куда посмотреть в первую очередь: риск или гипотеза, не диагноз; решение за врачом. Пороги — демонстрационные, требуют клинического утверждения (review-required).';

module.exports = { DISCLAIMER, CONFIG, COLORS, evaluate, detectWorsening, slaText, parseTs, minutesText, escalationLabel, DAY };
