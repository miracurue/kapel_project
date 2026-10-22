'use strict';

/**
 * W-41 (этап 14, веха В5): реестр рабочих настроек S-01…S-66 (F-97, F-117).
 * Для каждого ключа — группа, флаги (клиническая «Админ + КО», юридически
 * значимая при real, уведомление остальным администраторам), значение по
 * умолчанию (config/defaults/settings.json) и серверная проверка значения
 * (E-SETTING-INVALID с полем, 09-admin «Settings», правила 5–8).
 * Проверкам, которым нужны база или классификатор (S-54, S-55, S-56),
 * передаётся ctx: { db, dataMode, effective }.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'config', 'defaults', 'settings.json'), 'utf8'),
);

// Поддерживаемые типы вложений (S-25): сузить можно, расширить нельзя.
const FILE_TYPES = ['jpeg', 'png', 'heic', 'pdf', 'docx', 'txt'];
// Часовые пояса России (S-30).
const RF_TIMEZONES = [
  'Europe/Kaliningrad',
  'Europe/Moscow',
  'Europe/Samara',
  'Asia/Yekaterinburg',
  'Asia/Omsk',
  'Asia/Novosibirsk',
  'Asia/Krasnoyarsk',
  'Asia/Irkutsk',
  'Asia/Yakutsk',
  'Asia/Vladivostok',
  'Asia/Magadan',
  'Asia/Kamchatka',
];
const RF_PHONE = /^(\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}$/;
const BLOCKED_WORDS = /срочн|немедлен/i;

const isInt = (v) => Number.isInteger(v);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const bad = (field) => ({ field });
const ok = () => null;
// ---------- проверки значений (часть 1: S-01…S-32) ----------

const VALIDATORS = {
  'ui.undo_window_seconds': (v) => (isInt(v) && v >= 5 && v <= 30 ? ok() : bad('value')),
  'analytics.min_group': (v) => (isInt(v) && v >= 10 && v <= 100 ? ok() : bad('value')),
  'crisis.outcome_due_hours': (v) => (isInt(v) && v >= 1 && v <= 168 ? ok() : bad('value')),

  'crisis.sla': (v) => {
    if (!v || typeof v !== 'object') return bad('value');
    for (const k of ['work_minutes', 'off_minutes']) {
      if (!isInt(v[k]) || v[k] < 5 || v[k] > 1440) return bad(k);
    }
    return ok();
  },

  'crisis.contacts': (v) => {
    if (!Array.isArray(v) || v.length < 1 || v.length > 5) return bad('contacts');
    if (String((v[0] || {}).phone || '').trim() !== '112') return bad('contacts.0.phone');
    for (const [i, c] of v.entries()) {
      if (!c || typeof c !== 'object') return bad(`contacts.${i}`);
      const title = String(c.title || '');
      const phone = String(c.phone || '').trim();
      if (!title || title.length > 80) return bad(`contacts.${i}.title`);
      if (phone !== '112' && !RF_PHONE.test(phone)) return bad(`contacts.${i}.phone`);
      if (c.hours != null && String(c.hours).length > 60) return bad(`contacts.${i}.hours`);
    }
    return ok();
  },

  'crisis.backup': (v, ctx) => {
    if (!Array.isArray(v)) return bad('clinician_ids');
    for (const id of v) {
      const u = ctx.db.prepare('SELECT role, status FROM users WHERE id = ?').get(Number(id));
      if (!u || !['psychiatrist', 'psychologist'].includes(u.role) || u.status !== 'active')
        return bad('clinician_ids');
    }
    return ok();
  },
  'ai.limits': (v) => {
    if (!v || typeof v !== 'object') return bad('value');
    for (const k of ['patient_per_10min', 'patient_per_day', 'clinician_per_hour', 'hints_per_day', 'admin_per_hour']) {
      if (!isInt(v[k]) || v[k] < 1 || v[k] > 1000) return bad(k);
    }
    if (!isInt(v.budget_tokens) || v.budget_tokens < 0) return bad('budget_tokens');
    if (!isInt(v.warn_percent) || v.warn_percent < 50 || v.warn_percent > 95) return bad('warn_percent');
    return ok();
  },

  'ai.timeouts': (v) => {
    if (!v || typeof v !== 'object' || !Object.keys(v).length) return bad('value');
    for (const [k, n] of Object.entries(v)) {
      if (!isInt(n) || n < 5 || n > 180) return bad(k);
    }
    return ok();
  },

  'ai.enabled': (v) => {
    if (!v || typeof v !== 'object') return bad('value');
    if (typeof v.all !== 'boolean') return bad('all');
    for (const [k, n] of Object.entries(v)) {
      if (k !== 'all' && typeof n !== 'boolean') return bad(k);
    }
    return ok();
  },
  'ai.suggested_questions.*': (v) => {
    if (!Array.isArray(v) || v.length < 1 || v.length > 4) return bad('questions');
    if (!v.some((q) => /хуже/i.test(String(q)))) return bad('questions');
    if (v.some((q) => !String(q).trim() || String(q).length > 80)) return bad('questions');
    return ok();
  },

  'course_support.rules': (v) => {
    if (!Array.isArray(v)) return bad('rules');
    const weeks = new Set();
    for (const [i, r] of v.entries()) {
      if (!r || !isInt(r.week) || r.week < 1 || r.week > 52) return bad(`rules.${i}.week`);
      if (weeks.has(r.week)) return bad(`rules.${i}.week`);
      weeks.add(r.week);
      if (!String(r.text || '').trim() || String(r.text).length > 300) return bad(`rules.${i}.text`);
    }
    return ok();
  },
  'voice.max_seconds': (v) => {
    if (!v || typeof v !== 'object') return bad('value');
    if (!isInt(v.patient) || v.patient < 30 || v.patient > 900) return bad('patient');
    if (!isInt(v.clinician) || v.clinician < 60 || v.clinician > 1800) return bad('clinician');
    return ok();
  },

  'files.limits': (v) => {
    if (!v || typeof v !== 'object') return bad('value');
    if (!isInt(v.max_mb) || v.max_mb < 1 || v.max_mb > 20) return bad('max_mb');
    if (!isInt(v.max_count) || v.max_count < 1 || v.max_count > 10) return bad('max_count');
    if (!Array.isArray(v.types) || !v.types.length) return bad('types');
    if (v.types.some((t) => !FILE_TYPES.includes(t))) return bad('types');
    return ok();
  },

  'messages.channel': (v) => {
    if (!v || typeof v !== 'object') return bad('value');
    if (!isInt(v.reply_days) || v.reply_days < 1 || v.reply_days > 10) return bad('reply_days');
    if (v.mode !== 'organizational') return bad('mode');
    if (BLOCKED_WORDS.test(String(v.line || ''))) return bad('line');
    return ok();
  },
  'pv.responsible': (v) => {
    if (v == null) return ok();
    if (typeof v !== 'object') return bad('value');
    if (String(v.name || '').length > 120) return bad('name');
    const contact = String(v.contact || '');
    if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) && !RF_PHONE.test(contact)) return bad('contact');
    return ok();
  },

  'previsit.days_before': (v) => {
    if (!v || typeof v !== 'object') return bad('value');
    if (!isInt(v.days) || v.days < 1 || v.days > 14) return bad('days');
    if (!isInt(v.reminders) || v.reminders < 0 || v.reminders > 1) return bad('reminders');
    return ok();
  },

  'previsit.questions': (v) => {
    if (!Array.isArray(v) || v.length < 1 || v.length > 15) return bad('questions');
    return ok();
  },
  'org.timezone_hours': (v) => {
    if (!v || typeof v !== 'object') return bad('value');
    if (!RF_TIMEZONES.includes(v.timezone)) return bad('timezone');
    const time = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!time.test(String(v.work_from || ''))) return bad('work_from');
    if (!time.test(String(v.work_to || ''))) return bad('work_to');
    if (!Array.isArray(v.days) || v.days.some((d) => !isInt(d) || d < 0 || d > 6)) return bad('days');
    if (v.holidays != null && !Array.isArray(v.holidays)) return bad('holidays');
    return ok();
  },

  'auth.session_timeouts': (v) => {
    if (!v || typeof v !== 'object') return bad('value');
    if (!isInt(v.idle_minutes) || v.idle_minutes < 5 || v.idle_minutes > 60) return bad('idle_minutes');
    if (!isInt(v.staff_absolute_minutes) || v.staff_absolute_minutes < 30 || v.staff_absolute_minutes > 480)
      return bad('staff_absolute_minutes');
    if (!isInt(v.patient_remember_minutes) || v.patient_remember_minutes < 60 || v.patient_remember_minutes > 1440)
      return bad('patient_remember_minutes');
    return ok();
  },
  'retention.*': (v, ctx, key) => {
    if (!isInt(v)) return bad('value');
    const range = RETENTION_RANGES[key];
    if (!range || v < range[0] || v > range[1]) return bad('value');
    return ok();
  },

  'triage.thresholds': (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return bad('value');
    for (const [k, n] of Object.entries(v)) {
      if (!TRIAGE_KEYS.includes(k)) return bad(k);
      if (k === 'hads') return bad(k);
      if (Array.isArray(n)) {
        if (n.some((x) => typeof x !== 'string')) return bad(k);
      } else if (n && typeof n === 'object') {
        for (const [b, val] of Object.entries(n)) {
          if (b === 'hads') return bad(k);
          if (!num(val) || val < 0) return bad(`${k}.${b}`);
        }
      } else if (typeof n !== 'boolean') {
        return bad(k);
      }
    }
    return ok();
  },
  'lists.*': (v, ctx, key) => {
    if (!Array.isArray(v) || v.length < 2 || v.length > 30) return bad('items');
    const norm = (x) => String(typeof x === 'object' && x ? x.key || x.label || '' : x || '').trim();
    if (v.some((x) => !norm(x) || norm(x).length > 60)) return bad('items');
    // S-54: пункт, уже использованный в записях, не удаляется (E-IN-USE),
    // а скрывается для новых. Пока проверяем причины блокировки.
    if (key === 'lists.block_reasons') {
      const current = new Set((ctx.effective(key).value || []).map(norm));
      const next = new Set(v.map(norm));
      for (const gone of current) {
        if (next.has(gone)) continue;
        const used = ctx.db
          .prepare("SELECT 1 FROM users WHERE status = 'blocked' AND status_reason = ? LIMIT 1")
          .get(gone);
        if (used) return { field: 'items', in_use: gone };
      }
    }
    return ok();
  },

  'ae.detect_dictionary': (v) => {
    if (!Array.isArray(v) || v.length > 500) return bad('dictionary');
    const seen = new Set();
    for (const [i, r] of v.entries()) {
      const phrase = String((r && r.phrase) || '')
        .trim()
        .toLowerCase();
      if (!phrase || phrase.length > 120) return bad(`dictionary.${i}.phrase`);
      if (seen.has(phrase)) return bad(`dictionary.${i}.phrase`);
      seen.add(phrase);
      if (!String((r && r.category) || '').trim()) return bad(`dictionary.${i}.category`);
    }
    return ok();
  },

  'reference.search': (v) => {
    if (!v || typeof v !== 'object') return bad('value');
    if (!isInt(v.suggestions) || v.suggestions < 3 || v.suggestions > 10) return bad('suggestions');
    if (!isInt(v.min_chars) || v.min_chars < 2 || v.min_chars > 3) return bad('min_chars');
    if (!['normal', 'soft'].includes(v.fuzziness)) return bad('fuzziness');
    return ok();
  },

  'reference.pharmacies': (v) => {
    if (!v || !Array.isArray(v.items) || v.items.filter((x) => x.active).length < 2) return bad('items');
    if (
      v.items.some(
        (x) =>
          !/^https:\/\//.test(String(x.template || '')) ||
          !String(x.template || '').includes('{inn}') ||
          /\{patient|\{plan|\{item/i.test(String(x.template || '')),
      )
    )
      return bad('items');
    return ok();
  },
  /* W41-VALIDATORS-2C */

  'queue.due': (v) => {
    if (!v || typeof v !== 'object') return bad('value');
    const spec = {
      info_days: [1, 10],
      stop_days: [1, 10],
      erasure_days: [1, 30],
      change_days: [1, 10],
      crisis_repeat_min: [5, 60],
      taken_return_days: [1, 3],
    };
    for (const [k, [lo, hi]] of Object.entries(spec)) {
      if (!isInt(v[k]) || v[k] < lo || v[k] > hi) return bad(k);
    }
    return ok();
  },

  'hints.enabled_real': (v) => (typeof v === 'boolean' ? ok() : bad('value')),
  'auth.admin_second_factor': (v) => (['on', 'off'].includes(v) ? ok() : bad('value')),

  // S-57: выключатели возможностей — только логическое значение.
  'features.*': (v) => (typeof v === 'boolean' ? ok() : bad('value')),

  'service.maintenance': (v) => {
    if (!v || typeof v !== 'object') return bad('value');
    if (typeof v.on !== 'boolean') return bad('on');
    if (v.until != null && Number.isNaN(new Date(v.until).getTime())) return bad('until');
    if (v.message_key != null && !['planned', 'unplanned'].includes(String(v.message_key))) return bad('message_key');
    return ok();
  },

  'demo.route': (v) => {
    if (!Array.isArray(v) || v.length < 3 || v.length > 8) return bad('steps');
    if (v.some((x) => !String(x.url || '').startsWith('/'))) return bad('steps');
    return ok();
  },
};

// ---------- справочники реестра ----------

// Сроки хранения S-23: ключ → [минимум, максимум] в единицах ключа.
const RETENTION_RANGES = {
  'retention.ai_days': [1, 30],
  'retention.pseudonyms_days': [1, 180],
  'retention.notifications_days': [7, 365],
  'retention.events_days': [7, 90],
  'retention.erasure_days': [1, 30],
  'retention.invite_days': [1, 30],
  'retention.reset_token_minutes': [15, 60],
  'retention.uploads_minutes': [5, 60],
  'retention.idempotency_hours': [1, 48],
  'retention.login_attempts_days': [30, 365],
  'retention.logs_days': [90, 730],
};

// Пороги светофора S-20 — ключи CONFIG из src/triage_rules.js (HADS отсутствует).
const TRIAGE_KEYS = [
  'inactivityDays',
  'overdueAssignmentDays',
  'adherenceWindowDays',
  'adherenceMinAssigned',
  'adherenceMinRatio',
  'worseningMinDelta',
  'worseningWindowDays',
  'medAdherenceEnabled',
  'medAdherenceMinExpected',
  'medAdherenceMinRatio',
  'higherIsWorse',
  'lowerIsWorse',
];

// Выключатели возможностей S-57 (F-117). Кризисную проверку, 112, «Мне нужна
// помощь», журналы и псевдонимизацию выключить нельзя — их нет в списке.
const FEATURES = [
  'patient_assistant',
  'voice',
  'patient_files',
  'where_to_buy',
  'course_support',
  'self_test',
  'ai_rating',
  'strange',
];
// Клинические настройки (review-required, «Админ + КО», правило 5).
const CLINICAL = (key) =>
  /^ai\.suggested_questions\./.test(key) ||
  /^lists\.(crisis_outcomes|ae_chips|diary_triggers)$/.test(key) ||
  [
    'crisis.sla',
    'crisis.outcome_due_hours',
    'crisis.rules',
    'triage.thresholds',
    'course_support.rules',
    'ae.detect_dictionary',
    'previsit.questions',
    'packages.shared',
    'ai.eval.threshold',
    'docs.clinical_templates',
  ].includes(key);

// Юридически значимые при real — требуется «Основание» (правило 6, E-BASIS-REQUIRED).
const LEGAL_REAL = (key) =>
  /^retention\./.test(key) ||
  /^features\./.test(key) ||
  /^docs\./.test(key) ||
  ['messages.channel', 'hints.enabled_real', 'program.config', 'service.maintenance', 'real.checklist'].includes(key);

// Уведомление остальным администраторам (правило 7, F-19).
const NOTIFY = (key) =>
  /^ai\.binding\./.test(key) ||
  /^features\./.test(key) ||
  [
    'crisis.contacts',
    'crisis.sla',
    'ai.enabled',
    'auth.admin_second_factor',
    'ext.gigachat',
    'ext.smtp',
    'crisis.rules',
    'service.maintenance',
  ].includes(key);

function matchValidator(key) {
  if (VALIDATORS[key]) return { fn: VALIDATORS[key], arg: key };
  if (key.startsWith('retention.')) return { fn: VALIDATORS['retention.*'], arg: key };
  if (key.startsWith('lists.')) return { fn: VALIDATORS['lists.*'], arg: key };
  if (key.startsWith('ai.suggested_questions.')) return { fn: VALIDATORS['ai.suggested_questions.*'] };
  if (key.startsWith('features.')) return { fn: VALIDATORS['features.*'], arg: key };
  return null;
}

// Значения по умолчанию: config/defaults/settings.json; S-57 — true;
// S-20 — CONFIG из src/triage_rules.js (без HADS); S-55 — словарь риск-классификатора.
function defaultValue(key) {
  if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return DEFAULTS[key];
  if (key === 'triage.thresholds') {
    const { CONFIG } = require('../../triage_rules');
    return JSON.parse(JSON.stringify(CONFIG));
  }
  if (key === 'crisis.rules') return crisisRulesDefault();
  if (key.startsWith('features.')) return FEATURES.includes(key.slice('features.'.length));
  if (key.startsWith('retention.')) {
    const ranges = {
      'retention.ai_days': 30,
      'retention.pseudonyms_days': 180,
      'retention.notifications_days': 90,
      'retention.events_days': 90,
      'retention.erasure_days': 30,
      'retention.invite_days': 7,
      'retention.reset_token_minutes': 60,
      'retention.uploads_minutes': 20,
      'retention.idempotency_hours': 24,
      'retention.login_attempts_days': 90,
      'retention.logs_days': 365,
    };
    return key in ranges ? ranges[key] : null;
  }
  return null;
}

// S-55: словарь кризисных фраз по умолчанию — рабочий набор src/riskClassifier.js
// (фразы и коды триггеров; формы значений совпадают с Handoff отчёта 13).
function crisisRulesDefault() {
  const { CATEGORIES, DRAFT_KEYWORDS } = require('../../riskClassifier');
  const phrases = [];
  for (const [category, list] of Object.entries(DRAFT_KEYWORDS)) {
    for (const text of list) phrases.push({ text, level: 'high', code: CATEGORIES_NAME[category] || `CAT${category}` });
  }
  return { phrases };
}

const CATEGORIES_NAME = {
  1: 'PLAN',
  2: 'MEANS_ACCESS',
  3: 'FAREWELL',
  4: 'INTENT_HOPELESSNESS',
  5: 'CURRENT_SELF_HARM',
};

module.exports = {
  DEFAULTS,
  FEATURES,
  FILE_TYPES,
  RF_TIMEZONES,
  RETENTION_RANGES,
  CLINICAL,
  LEGAL_REAL,
  NOTIFY,
  matchValidator,
  defaultValue,
};
