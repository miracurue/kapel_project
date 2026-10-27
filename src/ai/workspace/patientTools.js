'use strict';

/**
 * Инструменты ИИ специалиста по закреплённому пациенту (tool use). Модель получает карточку-описание и список
 * инструментов, сама решает, что запросить (дневник, результаты, план…) и сколько. Идентификатор пациента задаёт
 * СЕРВЕР при создании набора: у инструментов нет аргумента «patient», модель не может обратиться к чужому.
 *
 * Правила (как у чипов, src/modules/context/chips.js):
 *  - только чтение; роль определяет набор (психолог не видит план лечения и нежелательные явления);
 *  - видимость дневника — на каждом чтении (redactEntry: оценки/заметки только если пациент делится);
 *  - результат каждого инструмента проходит псевдонимизацию F-80 до возвращения модели;
 *  - обращение пишется в phi_access_log (section 'ai.tool', без содержимого), размер ответа ограничен.
 */

const { redactEntry, scoresVisible } = require('../../modules/diary/visibility');
const { instrumentLabelFor } = require('../../format');

function sessionTag(req) {
  try {
    return require('../../platform').sha((req && req.session && req.session.sid_hash) || '');
  } catch (_) {
    return null;
  }
}

const DAYS_DEFAULT = 30;
const DAYS_MAX = 365;
const MAX_ROWS = 60;
const MAX_CHARS = 6000;

const SLEEP = { bad: 'плохой', ok: 'средний', good: 'хороший' };
const ANXIETY = { none: 'нет', some: 'умеренная', strong: 'сильная' };
const SEVERITY = { mild: 'лёгкая', noticeable: 'заметная', severe: 'тяжёлая' };
const AE_STATUS = {
  draft: 'черновик',
  submitted: 'отправлено',
  awaiting_doctor: 'ждёт врача',
  service_queue: 'в очереди службы',
  related_likely: 'связь вероятна',
  not_related: 'связи нет',
  insufficient: 'данных недостаточно',
};
const VISIT_FORMAT = { in_person: 'очно', remote: 'дистанционно' };
const VISIT_STATUS = { draft: 'черновик', scheduled: 'запланирован', done: 'проведён', no_show: 'не явился', cancelled: 'отменён' };
const TIMES = { morning: 'утром', noon: 'днём', day: 'днём', evening: 'вечером', night: 'на ночь' };

const iso = (v) => String(v || '').slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const clipText = (text) => (text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}\n… (ответ обрезан, уточните период)`);

function periodArg(args, def = DAYS_DEFAULT) {
  const n = Number(args && args.days);
  return Number.isInteger(n) && n > 0 ? Math.min(n, DAYS_MAX) : def;
}

const daysProp = {
  type: 'integer',
  description: `За сколько последних дней (по умолчанию ${DAYS_DEFAULT}, не более ${DAYS_MAX})`,
};

const DEFINITIONS = [
  {
    name: 'get_overview',
    description:
      'Краткая сводка по пациенту: диагноз, текущее лечение, последние результаты тестов, активность дневника, ближайший и последний визит. Начинай с неё, если нужно понять общую картину.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_diary',
    description:
      'Записи дневника пациента за период: настроение (1–5), сон, тревога, заметки. Показывает только то, чем пациент разрешил делиться с врачом.',
    parameters: { type: 'object', properties: { days: daysProp } },
  },
  {
    name: 'get_results',
    description:
      'Результаты тестов и шкал (онлайн и очные) с баллом, уровнем и признаком риска; можно отфильтровать по методике и периоду.',
    parameters: {
      type: 'object',
      properties: {
        instrument: { type: 'string', description: 'Код методики, например PHQ9 или GAD7 (необязательно)' },
        days: daysProp,
      },
    },
  },
  {
    name: 'get_plan',
    description: 'Текущий план лечения: препараты, дозы, время приёма, сроки (только психиатр).',
    parameters: { type: 'object', properties: {} },
    roles: ['psychiatrist'],
  },
  {
    name: 'get_visits',
    description: 'Визиты пациента за период и ближайшие: дата, формат, статус.',
    parameters: { type: 'object', properties: { days: daysProp } },
  },
  {
    name: 'get_adverse_events',
    description: 'Нежелательные явления, о которых сообщал пациент: дата начала, тяжесть, препарат, статус разбора (только психиатр).',
    parameters: { type: 'object', properties: { days: daysProp } },
    roles: ['psychiatrist'],
  },
];

/**
 * @param {object} o
 * @param {object} o.db @param {object} o.pii @param {object} o.scope контекст псевдонимизации треда
 * @param {object} o.req @param {object} o.user специалист @param {number} o.patientId закреплённый пациент
 * @param {object} o.counts счётчики псевдонимизации (дополняются)
 * @param {(a: object, b: object) => void} o.mergeCounts
 * @param {() => string} [o.nowIso] текущее время сервера (окно отмены записей пациента)
 * @returns {{definitions: object[], execute: (name: string, args: object) => Promise<string>, card: string}}
 */
function createPatientTools({ db, pii, scope, req, user, patientId, counts, mergeCounts, nowIso = () => new Date().toISOString() }) {
  const allowed = DEFINITIONS.filter((d) => !d.roles || d.roles.includes(user.role));
  const definitions = allowed.map(({ roles: _roles, ...def }) => def);

  const handlers = {
    get_overview() {
      const lines = [];
      const dx = db
        .prepare(
          'SELECT c.code, c.label FROM patient_diagnoses d JOIN diagnosis_catalog c ON c.code=d.code WHERE d.patient_id=? AND d.ended_at IS NULL',
        )
        .get(patientId);
      lines.push(`Диагноз в карточке: ${dx ? `${dx.code} ${dx.label}` : 'не указан'}.`);
      const ep = db.prepare('SELECT started_at FROM care_episodes WHERE patient_id=? AND ended_at IS NULL').get(patientId);
      if (ep) lines.push(`Наблюдение с ${iso(ep.started_at)}.`);
      if (user.role === 'psychiatrist') {
        const items = planItems();
        lines.push(
          items.length
            ? `Текущий план: ${items.map((i) => `${i.name}${i.dose}`).join('; ')}.`
            : 'Опубликованного плана лечения нет.',
        );
      }
      const results = resultRows(null, 365);
      const seen = new Set();
      const last = results.filter((r) => (seen.has(r.instrument) ? false : seen.add(r.instrument))).slice(0, 5);
      lines.push(
        last.length
          ? `Последние результаты: ${last.map((r) => `${r.label} ${r.date} — ${r.score}${r.band ? ` (${r.band})` : ''}${r.risk ? ', есть признак риска' : ''}`).join('; ')}.`
          : 'Результатов тестов нет.',
      );
      const diary = db
        .prepare('SELECT count(*) n, max(entry_date) last FROM mood_entries WHERE patient_id=? AND hidden_at IS NULL AND entry_date>=?')
        .get(patientId, daysAgo(14));
      lines.push(
        diary.n
          ? `Дневник: ${diary.n} записей за 14 дней, последняя ${iso(diary.last)}.`
          : 'В дневнике за последние 14 дней записей нет.',
      );
      const nowIso = new Date().toISOString();
      const next = db
        .prepare("SELECT starts_at, format FROM visits WHERE patient_id=? AND status='scheduled' AND starts_at>=? ORDER BY starts_at LIMIT 1")
        .get(patientId, nowIso);
      const prev = db
        .prepare("SELECT starts_at FROM visits WHERE patient_id=? AND status='done' AND starts_at<? ORDER BY starts_at DESC LIMIT 1")
        .get(patientId, nowIso);
      lines.push(`Ближайший визит: ${next ? `${iso(next.starts_at)}, ${VISIT_FORMAT[next.format] || ''}` : 'не назначен'}; последний проведённый: ${prev ? iso(prev.starts_at) : 'нет'}.`);
      if (user.role === 'psychiatrist') {
        const ae = db
          .prepare("SELECT count(*) n FROM adverse_events WHERE patient_id=? AND status NOT IN ('draft','cancelled') AND NOT (status='service_queue' AND psychiatrist_id IS NULL)")
          .get(patientId);
        lines.push(`Нежелательных явлений в истории: ${ae.n}.`);
      }
      lines.push(
        `Что можно запросить подробнее: ${definitions
          .filter((d) => d.name !== 'get_overview')
          .map((d) => d.name)
          .join(', ')}.`,
      );
      return lines.join('\n');
    },

    get_diary(args) {
      const days = periodArg(args);
      const rows = db
        .prepare(
          'SELECT id, patient_id, entry_date, mood, sleep, anxiety, note FROM mood_entries WHERE patient_id=? AND hidden_at IS NULL AND entry_date>=? ORDER BY entry_date DESC LIMIT ?',
        )
        .all(patientId, daysAgo(days), MAX_ROWS);
      if (!rows.length) return `В дневнике за последние ${days} дн. записей нет.`;
      const out = [];
      if (!scoresVisible(db, patientId, user)) out.push('Пациент не делится оценками дневника; видны только даты записей.');
      for (const entry of rows.reverse()) {
        const r = redactEntry(db, patientId, user, entry);
        const parts = [iso(r.entry_date)];
        if (r.mood !== undefined && r.mood !== null) parts.push(`настроение ${r.mood}/5`);
        if (r.sleep) parts.push(`сон ${SLEEP[r.sleep] || r.sleep}`);
        if (r.anxiety) parts.push(`тревога ${ANXIETY[r.anxiety] || r.anxiety}`);
        if (r.note) parts.push(`заметка: ${r.note}`);
        out.push(parts.join(', '));
      }
      return out.join('\n');
    },

    get_results(args) {
      const days = periodArg(args, 180);
      const instrument = args && typeof args.instrument === 'string' ? args.instrument.trim().slice(0, 40) : null;
      const rows = resultRows(instrument, days);
      if (!rows.length) return 'Результатов за этот период нет.';
      return rows
        .slice(0, MAX_ROWS)
        .map((r) => `${r.date} ${r.label}: ${r.score}${r.band ? `, ${r.band}` : ''}${r.risk ? ', есть признак риска' : ''}${r.kind === 'offline' ? ' (очный)' : ''}${r.notes ? `. Заметки: ${r.notes}` : ''}`)
        .join('\n');
    },

    get_plan() {
      const items = planItems();
      if (!items.length) return 'Опубликованного плана лечения нет.';
      return items.map((i) => `${i.name}${i.dose}${i.times ? `, ${i.times}` : ''}${i.period ? `, ${i.period}` : ''}`).join('\n');
    },

    get_visits(args) {
      const days = periodArg(args, 90);
      const rows = db
        .prepare('SELECT starts_at, format, status FROM visits WHERE patient_id=? AND starts_at>=? ORDER BY starts_at LIMIT ?')
        .all(patientId, `${daysAgo(days)}T00:00:00Z`, MAX_ROWS);
      if (!rows.length) return 'Визитов за этот период нет.';
      return rows.map((v) => `${iso(v.starts_at)}: ${VISIT_FORMAT[v.format] || v.format}, ${VISIT_STATUS[v.status] || v.status}`).join('\n');
    },

    get_adverse_events(args) {
      const days = periodArg(args, 180);
      const rows = db
        .prepare(
          `SELECT a.onset_date, a.created_at, a.severity, a.status, i.name inn FROM adverse_events a LEFT JOIN inn i ON i.id=a.inn_id
           WHERE a.patient_id=? AND a.status NOT IN ('draft','cancelled') AND NOT (a.status='service_queue' AND a.psychiatrist_id IS NULL) AND (a.visible_from IS NULL OR a.visible_from<=?) AND a.created_at>=? ORDER BY a.created_at DESC LIMIT ?`,
        )
        .all(patientId, nowIso(), `${daysAgo(days)}T00:00:00Z`, MAX_ROWS);
      if (!rows.length) return 'Нежелательных явлений за этот период нет.';
      return rows
        .map((a) => `${iso(a.onset_date || a.created_at)}: ${a.inn ? `препарат ${a.inn}, ` : ''}тяжесть ${SEVERITY[a.severity] || 'не указана'}, ${AE_STATUS[a.status] || a.status}`)
        .join('\n');
    },
  };

  function planItems() {
    const version = db
      .prepare("SELECT id FROM plan_versions WHERE patient_id=? AND status='published' ORDER BY version DESC LIMIT 1")
      .get(patientId);
    if (!version) return [];
    return db
      .prepare(
        "SELECT i.name, p.dose_value, p.dose_unit, p.times_json, p.start_date, p.end_date, p.duration_text FROM plan_items p JOIN inn i ON i.id=p.inn_id WHERE p.plan_version_id=? AND p.status='active' ORDER BY p.id",
      )
      .all(version.id)
      .map((r) => {
        let times = '';
        try {
          times = JSON.parse(r.times_json || '[]')
            .map((t) => TIMES[t] || t)
            .join(', ');
        } catch (_) {
          times = '';
        }
        const period = r.duration_text || [r.start_date && `с ${iso(r.start_date)}`, r.end_date && `по ${iso(r.end_date)}`].filter(Boolean).join(' ');
        return {
          name: r.name,
          dose: r.dose_value ? ` ${String(r.dose_value).replace(/\.0$/, '')} ${r.dose_unit || ''}`.trimEnd() : '',
          times,
          period,
        };
      });
  }

  // Действующие результаты (недействительные и заменённые не берём), новые первыми.
  function resultRows(instrument, days) {
    const since = daysAgo(days);
    const filter = instrument ? 'AND lower(instrument)=lower(?)' : '';
    const args = (extra) => (instrument ? [patientId, extra, instrument] : [patientId, extra]);
    const online = db
      .prepare(
        `SELECT instrument, total_score, band, risk_flag, created_at d FROM online_results WHERE patient_id=? AND invalid_at IS NULL AND substr(created_at,1,10)>=? ${filter}`,
      )
      .all(...args(since));
    const offline = db
      .prepare(
        `SELECT instrument, total_score, band, risk_flag, test_date d, notes FROM offline_results WHERE patient_id=? AND invalid_at IS NULL AND status='saved' AND test_date>=? ${filter}`,
      )
      .all(...args(since));
    const map = (kind) => (r) => ({
      kind,
      instrument: r.instrument,
      label: instrumentLabelFor('specialist', r.instrument) || r.instrument,
      date: iso(r.d),
      score: r.total_score === null || r.total_score === undefined ? 'нет балла' : r.total_score,
      band: r.band || '',
      risk: Boolean(r.risk_flag),
      notes: r.notes || '',
    });
    return [...online.map(map('online')), ...offline.map(map('offline'))].sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  function log(name) {
    try {
      db.prepare(
        'INSERT INTO phi_access_log(actor_id,actor_role,patient_id,section,action,decision,basis,object_type,object_id,session_tag,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        user.id,
        user.role,
        patientId,
        'ai.tool',
        'view',
        'allow',
        'assignment',
        name,
        null,
        sessionTag(req),
        new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      );
    } catch (_) {
      /* журнал не ломает ответ */
    }
  }

  async function execute(name, args) {
    const handler = allowed.some((d) => d.name === name) ? handlers[name] : null;
    if (!handler) return 'Такого инструмента нет.';
    log(name);
    const raw = clipText(handler(args || {}));
    const ner = await pii.nerDetect(raw);
    const p = pii.pseudonymize(raw, scope, { nerEntities: ner.entities, nerOk: ner.ok });
    mergeCounts(counts, p.counts);
    return p.text;
  }

  // Правила работы с инструментами — в системном промпте clinician_chat (v2); здесь только список доступного этой роли.
  const card = `Доступные инструменты по закреплённому пациенту: ${definitions.map((d) => d.name).join(', ')}.`;

  return { definitions, execute, card, maxCalls: 5 };
}

module.exports = { createPatientTools, DEFINITIONS };
