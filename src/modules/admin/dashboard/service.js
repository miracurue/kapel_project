'use strict';

/**
 * Обзор администратора: история сервиса главами (люди → как пользуются → самочувствие → тесты → лечение →
 * побочные эффекты → забота и безопасность → ИИ → контент и цветок → сервис и доступ).
 *
 * Правила (BUILD_RULES §4, PD-19, S-22): всё, что получено от пациентов, читается только из представлений без
 * идентификаторов (analytics_program_*, insights_*, analytics_flower_events) через соединение «только чтение»
 * и только по участникам программы (базовое согласие + согласие на программу). Ячейка, в которую вошло меньше
 * analytics.min_group человек, отдаётся как null — число в ответ не попадает. Служебные цифры (аккаунты, очередь,
 * ИИ, журналы входа) агрегируются как есть: идентификаторов пациентов среди них нет, а `patient_id` не выбирается.
 * Каждый блок описан данными ({type, ...}); рисует их public/js/admin_dashboard.js.
 */

const { readOnly } = require('../../analytics/cohort');
const { COMPLAINT } = require('../../insights/report');
const { arrange } = require('./layout');

const DAY_MS = 86400000;
const dayNum = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const numDay = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const shift = (iso, d) => numDay(dayNum(iso) + d);
const monday = (iso) => {
  const n = dayNum(iso);
  return numDay(n - ((n + 3) % 7)); // 1970-01-01 — четверг
};
const weeksOf = (from, to) => {
  const out = [];
  for (let w = monday(from); w <= to; w = shift(w, 7)) out.push(w);
  return out;
};
const monthsOf = (from, to) => {
  const out = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const last = to.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push(key);
    if (key >= last) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
};
const lastDayOfMonth = (iso) => {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
};
const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);
const round2 = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);
const pct = (num, den) => (den ? Math.round((num / den) * 100) : null);
const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
const num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const dec = (n) => String(n).replace('.', ',');
const median = (list) => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const ROLE_LABEL = {
  patient: 'Пациенты',
  psychiatrist: 'Психиатры',
  psychologist: 'Психологи',
  admin: 'Администраторы',
};
const ACTION_LABEL = {
  diary: 'Дневник',
  test: 'Тесты',
  med: 'Отметки приёма',
  habit: 'Привычки',
  note: 'Заметки',
  article: 'Статьи',
  ai: 'Вопросы помощнику',
  technique: 'Техники',
  login: 'Вход в сервис',
  start: 'Первые шаги',
};
const WEEKDAY = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const SEVERITY_LABEL = {
  mild: 'Немного мешает',
  noticeable: 'Заметно мешает',
  severe: 'Сильно мешает',
  unknown: 'Не указано',
};
const SLOT_ORDER = ['утро', 'день', 'вечер', 'ночь'];
const KIND_LABEL = {
  crisis_no_clinician: 'Кризис без специалиста',
  crisis_manual_review: 'Кризис: нужен ручной разбор',
  ae_no_psychiatrist: 'Побочный эффект без психиатра',
  message_no_clinician: 'Сообщение без специалиста',
  patient_without_clinician: 'Пациент без специалиста',
  erasure: 'Удаление аккаунта',
  subject_info: 'Сведения о данных',
  stop_processing: 'Прекращение обработки',
  dispute_access: '«Это странно»',
  change_clinician: 'Смена специалиста',
  substitution: 'Замещение',
  mail_failed: 'Письмо не отправлено',
  job_failed: 'Фоновая задача',
  ai_budget: 'Бюджет ИИ',
  correction_overdue: 'Исправление просрочено',
  catalog_review: 'Проверка справочника',
};
const PURPOSE_LABEL = {
  patient_assistant: 'Помощник пациента',
  clinician_chat: 'Чат специалиста',
  admin_assistant: 'Помощник администратора',
  diagnostic_hints: 'Подсказки по диагностике',
  drug_chat: 'Вопросы по лекарствам',
  library_chat: 'Вопросы к статье',
  template_chat: 'Помощь с шаблоном',
};
const AI_STATUS_LABEL = {
  ok: 'Ответ дан',
  fallback: 'Запасной ответ',
  error: 'Ошибка',
  timeout: 'Не успел',
  crisis: 'Кризисный путь',
  filtered: 'Отфильтровано',
  limit: 'Лимит',
};
const LOGIN_LABEL = {
  ok: 'Вошли',
  bad_password: 'Неверный пароль',
  unknown: 'Неизвестный адрес',
  blocked: 'Заблокирован',
  second_factor_fail: 'Не прошёл второй фактор',
  locked: 'Временно закрыт вход',
};
const BASIS_LABEL = {
  self: 'Сам пациент',
  assignment: 'По закреплению',
  substitution: 'По замещению',
  crisis: 'В кризисе',
  admin_service: 'Служебный доступ',
  research: 'Исследование',
};
const DSR_LABEL = {
  erasure: 'Удаление',
  correction: 'Исправление',
  info: 'Сведения',
  stop_processing: 'Прекращение обработки',
  dispute_access: '«Это странно»',
  change_clinician: 'Смена специалиста',
  consent_revocation: 'Отзыв согласия',
  export_consent_revocation: 'Отзыв согласия на выгрузку',
  consent_revocation_and_deletion: 'Отзыв согласия и удаление',
};
const VISIT_LABEL = {
  scheduled: 'Запланированы',
  done: 'Состоялись',
  no_show: 'Не пришли',
  cancelled: 'Отменены',
  draft: 'Черновики',
};
const MEDIA_LABEL = { read: 'Читать', listen: 'Слушать', watch: 'Смотреть' };
const LIB_STATUS_LABEL = { published: 'Опубликовано', review: 'На проверке', draft: 'Черновики', withdrawn: 'Снято' };
const TECHNIQUE_LABEL = {
  'breathing-box': 'Квадратное дыхание',
  'breathing-478': 'Дыхание 4-7-8',
  'grounding-54321': 'Заземление 5-4-3-2-1',
  pmr: 'Мышечная релаксация',
  activation: 'Поведенческая активация',
};
const DRUG_GROUP_LABEL = {
  antidepressant: 'Антидепрессанты',
  anxiolytic: 'Анксиолитики',
  antipsychotic: 'Антипсихотики',
  mood_stabilizer: 'Нормотимики',
  hypnotic_sedative: 'Снотворные и седативные',
  corrector: 'Корректоры',
  other: 'Другое',
};

/**
 * Дополняющее скрытие: если части целого показаны, а скрыта ровно одна, её можно вычесть из итога.
 * Тогда скрывается ещё и наименьшая из показанных, чтобы вычитание не раскрыло малую группу.
 */
function guardPartition(items) {
  const hiddenN = items.filter((i) => i.value === null).length;
  if (hiddenN !== 1) return items;
  const shown = items.filter((i) => i.value !== null && i.value > 0);
  if (!shown.length) return items;
  const smallest = shown.reduce((m, i) => (i.value < m.value ? i : m));
  smallest.value = null;
  return items;
}

/** Блоки-описания: рисует их клиент. value === null — «мало данных». */
const series = (title, unit, points, extra = {}) => ({ type: 'series', title, unit, points, ...extra });
const bars = (title, unit, items, extra = {}) => ({ type: 'bars', title, unit, items, ...extra });
const stack = (title, segments, extra = {}) => ({ type: 'stack', title, segments, ...extra });
const funnel = (title, steps, extra = {}) => ({ type: 'funnel', title, steps, ...extra });
const tiles = (items) => ({ type: 'tiles', items });

function build(db, { from, to, minGroup, now, program = null }) {
  const ro = readOnly(db);
  const days = dayNum(to) - dayNum(from) + 1;
  const prev = { from: shift(from, -days), to: shift(from, -1) };
  // Неполная первая неделя отбрасывается (иначе график начинается с заниженной точки); неполная последняя помечается.
  const weeks = weeksOf(from, to).filter((w) => w >= from);
  const weekLabel = (w) => w;
  const hidden = (people) => people === null || people === undefined || people < minGroup;
  const cell = (people, value) => (hidden(people) ? null : value);
  const nowIso = now;
  // Уровень 1 (служебные счётчики: активность, записи) — по всем пациентам; уровень 2 (здоровье) — по согласию research.
  const serviceSubjects = 'subject_code IN (SELECT subject_code FROM analytics_service_members)';
  const programSubjects = 'subject_code IN (SELECT subject_code FROM analytics_program_members)';
  const insightsSubjects = "subject_code IN (SELECT subject_code FROM insights_members WHERE scope = 'program')";

  const programMembers = ro.prepare('SELECT COUNT(*) AS n FROM analytics_program_members').get().n;
  const serviceMembers = ro.prepare('SELECT COUNT(*) AS n FROM analytics_service_members').get().n;

  // ---------- общие запросы по участникам программы
  const countPeople = (view, scopeSql, dayCol, a, b, extra = '') =>
    ro
      .prepare(
        `SELECT COUNT(DISTINCT subject_code) AS p, COUNT(*) AS n FROM ${view} WHERE ${scopeSql} AND ${dayCol} BETWEEN ? AND ?${extra}`,
      )
      .get(a, b);
  const deltaOf = (cur, before) => (before ? Math.round(((cur - before) / before) * 100) : null);

  // ---------- главная строка и плитки
  function kpis() {
    const items = [];
    const push = (key, label, cur, before, hint, opts = {}) =>
      items.push({
        key,
        label,
        value: cur,
        prev: before,
        delta: cur === null || before === null ? null : deltaOf(cur, before),
        hint,
        ...opts,
      });

    const wk = { from: shift(to, -6), to };
    const wkPrev = { from: shift(to, -13), to: shift(to, -7) };
    const activeNow = countPeople('analytics_flower_events', serviceSubjects, 'day', wk.from, wk.to);
    const activePrev = countPeople('analytics_flower_events', serviceSubjects, 'day', wkPrev.from, wkPrev.to);
    push(
      'active_week',
      'Активных пациентов за неделю',
      cell(activeNow.p, activeNow.p),
      cell(activePrev.p, activePrev.p),
      serviceMembers >= minGroup ? `из ${num(serviceMembers)} пациентов` : '',
    );

    const diaryNow = countPeople(
      'analytics_service_facts',
      serviceSubjects,
      'day',
      from,
      to,
      " AND metric = 'diary_entry'",
    );
    const diaryPrev = countPeople(
      'analytics_service_facts',
      serviceSubjects,
      'day',
      prev.from,
      prev.to,
      " AND metric = 'diary_entry'",
    );
    push(
      'diary',
      'Дней с записью в дневнике',
      cell(diaryNow.p, diaryNow.n),
      cell(diaryPrev.p, diaryPrev.n),
      hidden(diaryNow.p) ? '' : `от ${num(diaryNow.p)} ${plural(diaryNow.p, 'человека', 'человек', 'человек')}`,
    );

    const testNow = countPeople('insights_tests', insightsSubjects, 'day', from, to);
    const testPrev = countPeople('insights_tests', insightsSubjects, 'day', prev.from, prev.to);
    push('tests', 'Пройдено тестов', cell(testNow.p, testNow.n), cell(testPrev.p, testPrev.n), '');

    const medNow = countPeople('insights_med_marks', insightsSubjects, 'day', from, to);
    const medPrev = countPeople('insights_med_marks', insightsSubjects, 'day', prev.from, prev.to);
    push('meds', 'Отметок о приёме лекарств', cell(medNow.p, medNow.n), cell(medPrev.p, medPrev.n), '');

    const aiCount = (a, b) =>
      db.prepare('SELECT COUNT(*) AS n FROM ai_audit WHERE substr(created_at,1,10) BETWEEN ? AND ?').get(a, b).n;
    push('ai', 'Обращений к ИИ', aiCount(from, to), aiCount(prev.from, prev.to), 'всех ролей');

    const open = db
      .prepare(
        "SELECT COUNT(*) AS n, SUM(CASE WHEN due_at IS NOT NULL AND due_at < ? THEN 1 ELSE 0 END) AS late FROM service_queue WHERE status IN ('new','taken','open','waiting')",
      )
      .get(nowIso);
    push('queue', 'Запросов ждут решения', open.n, null, open.late ? `просрочено: ${open.late}` : 'просроченных нет', {
      tone: open.late ? 'warn' : 'ok',
      link: '/admin?tab=requests',
    });
    return items;
  }

  // ---------- 1. Люди
  function people() {
    const rows = db
      .prepare("SELECT role, status, COUNT(*) AS n FROM users WHERE status <> 'tombstone' GROUP BY role, status")
      .all();
    const by = (role, statuses) =>
      rows.filter((r) => r.role === role && (!statuses || statuses.includes(r.status))).reduce((s, r) => s + r.n, 0);
    const patients = by('patient');
    const patientsActive = by('patient', ['active']);
    const clinicians = by('psychiatrist', ['active']) + by('psychologist', ['active']);
    const blocked = rows.filter((r) => ['blocked', 'deactivated'].includes(r.status)).reduce((s, r) => s + r.n, 0);
    const pendingDeletion = rows.filter((r) => r.status === 'deletion_requested').reduce((s, r) => s + r.n, 0);

    const consent = (kind) =>
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM consent_current c JOIN users u ON u.id = c.user_id WHERE c.consent_kind = ? AND c.action = 'given' AND u.role = 'patient' AND u.status = 'active'",
        )
        .get(kind).n;
    const base = consent('base');
    const program = consent('research');
    const withClinician = db
      .prepare(
        "SELECT COUNT(DISTINCT a.patient_id) AS n FROM care_assignments a JOIN users u ON u.id = a.patient_id WHERE a.ended_at IS NULL AND COALESCE(a.end_reason,'') <> 'signal_only' AND u.role = 'patient' AND u.status = 'active'",
      )
      .get().n;

    const ever = (view, scopeSql) =>
      ro.prepare(`SELECT COUNT(DISTINCT subject_code) AS p FROM ${view} WHERE ${scopeSql}`).get().p;
    const diaryEver = ever('analytics_service_facts', `${serviceSubjects} AND metric = 'diary_entry'`);
    const testEver = ever('insights_tests', insightsSubjects);
    const medEver = ever('insights_med_marks', insightsSubjects);
    const recent = countPeople('analytics_flower_events', serviceSubjects, 'day', shift(to, -13), to).p;

    const enrol = ro
      .prepare(
        `SELECT substr(enrolled_day,1,7) AS m, COUNT(*) AS p FROM insights_patients WHERE ${insightsSubjects} AND enrolled_day IS NOT NULL GROUP BY m`,
      )
      .all();
    const enrolBy = new Map(enrol.map((r) => [r.m, r.p]));
    const first = enrol.length ? enrol.map((r) => r.m).sort()[0] : to.slice(0, 7);
    const months = monthsOf(`${first}-01`, to).slice(-12);
    const growth = months.map((m) => ({
      label: m,
      value: cell(enrolBy.get(m) || 0, enrolBy.get(m) || 0),
      n: enrolBy.get(m) || 0,
    }));

    // Нагрузка на специалистов: сколько пациентов у каждого (имён нет, только распределение).
    const loads = db
      .prepare(
        "SELECT COUNT(DISTINCT a.patient_id) AS p FROM users c LEFT JOIN care_assignments a ON a.clinician_id = c.id AND a.ended_at IS NULL AND COALESCE(a.end_reason,'') <> 'signal_only' WHERE c.role IN ('psychiatrist','psychologist') AND c.status = 'active' GROUP BY c.id",
      )
      .all()
      .map((r) => r.p);
    const buckets = [
      ['0', 'нет пациентов', (n) => n === 0],
      ['1-5', '1–5', (n) => n >= 1 && n <= 5],
      ['6-10', '6–10', (n) => n >= 6 && n <= 10],
      ['11-20', '11–20', (n) => n >= 11 && n <= 20],
      ['21+', 'больше 20', (n) => n > 20],
    ].map(([key, label, test]) => ({ key, label, value: loads.filter(test).length }));
    const med = median(loads);

    const headline =
      `В сервисе ${num(patients)} ${plural(patients, 'пациент', 'пациента', 'пациентов')} и ${num(clinicians)} ${plural(clinicians, 'специалист', 'специалиста', 'специалистов')}. ` +
      `${pct(program, patientsActive) ?? 0}% пациентов согласились на обезличенную аналитику, у ${pct(withClinician, patientsActive) ?? 0}% есть специалист` +
      (clinicians
        ? `; в среднем у специалиста ${dec(round1(med))} ${plural(Math.round(med || 0), 'пациент', 'пациента', 'пациентов')} (медиана).`
        : '.');

    return {
      key: 'people',
      title: 'Кто с нами',
      kicker: 'Люди',
      headline,
      blocks: [
        tiles([
          { label: 'Пациентов', value: patients, hint: `активных: ${num(patientsActive)}` },
          { label: 'Специалистов', value: clinicians, hint: 'психиатры и психологи' },
          { label: 'Администраторов', value: by('admin', ['active']) },
          {
            label: 'Закрыто или на удалении',
            value: blocked + pendingDeletion,
            hint: 'заблокированы, отключены, ждут удаления',
          },
        ]),
        funnel(
          'Путь пациента: от аккаунта до привычки',
          [
            { key: 'acc', label: 'Аккаунт создан', value: patientsActive },
            { key: 'base', label: 'Дали базовое согласие', value: base },
            { key: 'program', label: 'Согласны на обезличенную аналитику', value: program },
            { key: 'care', label: 'Есть специалист', value: withClinician },
            { key: 'diary', label: 'Хоть раз вели дневник', value: cell(diaryEver, diaryEver) },
            { key: 'test', label: 'Проходили тесты', value: cell(testEver, testEver) },
            { key: 'med', label: 'Отмечали приём лекарств', value: cell(medEver, medEver) },
            { key: 'recent', label: 'Заходили за последние 2 недели', value: cell(recent, recent) },
          ],
          {
            note: 'Шаги после согласия на программу считаются только по участникам программы; группы меньше порога скрыты.',
          },
        ),
        bars(
          'Аккаунты по ролям',
          'чел.',
          ['patient', 'psychiatrist', 'psychologist', 'admin'].map((role) => ({
            label: ROLE_LABEL[role],
            value: by(role),
          })),
        ),
        series('Когда пациенты начали наблюдение', 'чел. в месяц', growth, {
          kind: 'columns',
          note: 'Месяц первого закрепления за специалистом; участники программы.',
        }),
        bars('Сколько пациентов у специалистов', 'специалистов', buckets, {
          note: 'Только распределение: имён в обзоре нет.',
        }),
      ],
    };
  }

  // ---------- 2. Как пользуются
  function usage() {
    const perWeek = ro
      .prepare(
        `SELECT date(day,'weekday 0','-6 days') AS w, COUNT(DISTINCT subject_code) AS p, COUNT(*) AS n FROM analytics_flower_events WHERE ${serviceSubjects} AND kind = 'earn' AND day BETWEEN ? AND ? GROUP BY w`,
      )
      .all(from, to);
    const wMap = new Map(perWeek.map((r) => [r.w, r]));
    const active = weeks.map((w) => {
      const r = wMap.get(w);
      return { label: weekLabel(w), value: r ? cell(r.p, r.p) : 0, n: r ? r.p : 0 };
    });

    const actions = ro
      .prepare(
        `SELECT action, COUNT(DISTINCT subject_code) AS p, COUNT(*) AS n FROM analytics_flower_events WHERE ${serviceSubjects} AND kind = 'earn' AND day BETWEEN ? AND ? GROUP BY action ORDER BY n DESC`,
      )
      .all(from, to)
      .filter((r) => ACTION_LABEL[r.action]);
    const actionItems = actions.map((r) => ({
      label: ACTION_LABEL[r.action],
      value: cell(r.p, r.n),
      people: cell(r.p, r.p),
    }));

    const wd = ro
      .prepare(
        `SELECT CAST(strftime('%w', day) AS INTEGER) AS d, COUNT(DISTINCT subject_code) AS p, COUNT(*) AS n FROM analytics_flower_events WHERE ${serviceSubjects} AND kind = 'earn' AND action <> 'login' AND day BETWEEN ? AND ? GROUP BY d`,
      )
      .all(from, to);
    const wdMap = new Map(wd.map((r) => [r.d, r]));
    const weekdays = [1, 2, 3, 4, 5, 6, 0].map((d) => {
      const r = wdMap.get(d);
      return { label: WEEKDAY[d], value: r ? cell(r.p, r.n) : 0 };
    });

    const mau = countPeople('analytics_flower_events', serviceSubjects, 'day', shift(to, -27), to).p;
    const wau = countPeople('analytics_flower_events', serviceSubjects, 'day', shift(to, -6), to).p;
    const dau = countPeople('analytics_flower_events', serviceSubjects, 'day', to, to).p;
    const perPerson = ro
      .prepare(
        `SELECT COUNT(DISTINCT day) AS d FROM analytics_flower_events WHERE ${serviceSubjects} AND kind = 'earn' AND day BETWEEN ? AND ? GROUP BY subject_code`,
      )
      .all(shift(to, -27), to)
      .map((r) => r.d);
    const avgDays =
      perPerson.length >= minGroup ? round1(perPerson.reduce((s, x) => s + x, 0) / perPerson.length) : null;

    const top = actionItems.find((a) => a.value !== null);
    const bestDay = [...weekdays].filter((d) => d.value !== null).sort((a, b) => b.value - a.value)[0];
    const headline = hidden(wau)
      ? 'Пока слишком мало активных участников, чтобы показывать картину по использованию.'
      : `За последнюю неделю заходили ${num(wau)} ${plural(wau, 'пациент', 'пациента', 'пациентов')}, за месяц — ${num(mau)}. ` +
        (top ? `Чаще всего делают: ${top.label.toLowerCase()}. ` : '') +
        (bestDay ? `Самый деятельный день недели — ${bestDay.label}.` : '');

    return {
      key: 'usage',
      title: 'Как пользуются сервисом',
      kicker: 'Активность',
      headline,
      blocks: [
        tiles([
          { label: 'Сегодня', value: cell(dau, dau), hint: 'активных пациентов' },
          { label: 'За неделю', value: cell(wau, wau), hint: 'активных пациентов' },
          { label: 'За месяц', value: cell(mau, mau), hint: 'активных пациентов' },
          {
            label: 'Дней активности',
            value: avgDays === null ? null : dec(avgDays),
            hint: 'на человека за последние 4 недели',
          },
        ]),
        series('Активные пациенты по неделям', 'чел.', active, {
          note: 'Любое действие, за которое растёт цветок: вход, дневник, тест, отметка приёма, статья.',
        }),
        bars('Что делают в сервисе', 'действий', actionItems, {
          note: 'Количество действий за период; справа — сколько людей.',
        }),
        bars('В какие дни недели', 'действий', weekdays, {
          kind: 'columns',
          note: 'Без входов: только содержательные действия.',
        }),
      ],
    };
  }

  // ---------- 3. Самочувствие
  function wellbeing() {
    const weekly = ro
      .prepare(
        `SELECT week AS w, COUNT(DISTINCT subject_code) AS p, COUNT(*) AS n, AVG(value) AS v FROM analytics_program_facts WHERE ${programSubjects} AND metric = 'mood' AND day BETWEEN ? AND ? GROUP BY week`,
      )
      .all(from, to);
    const wMap = new Map(weekly.map((r) => [r.w, r]));
    const moodSeries = weeks.map((w) => {
      const r = wMap.get(w);
      return { label: weekLabel(w), value: r ? cell(r.p, round2(r.v)) : null, n: r ? r.p : 0 };
    });

    // Доли показываются, только если в метрике за период набралась группа не меньше порога.
    const dist = (metric) => {
      const rows = ro
        .prepare(
          `SELECT value AS v, COUNT(DISTINCT subject_code) AS p, COUNT(*) AS n FROM analytics_program_facts WHERE ${programSubjects} AND metric = ? AND day BETWEEN ? AND ? GROUP BY value ORDER BY value`,
        )
        .all(metric, from, to);
      rows.people = ro
        .prepare(
          `SELECT COUNT(DISTINCT subject_code) AS p FROM analytics_program_facts WHERE ${programSubjects} AND metric = ? AND day BETWEEN ? AND ?`,
        )
        .get(metric, from, to).p;
      return rows;
    };
    const moodDist = dist('mood');
    const total = (rows) => rows.reduce((s, r) => s + r.n, 0);
    const share = (rows, v) => {
      if (hidden(rows.people)) return null;
      const r = rows.find((x) => x.v === v);
      return r && !hidden(r.p) ? pct(r.n, total(rows)) : r ? null : 0;
    };
    const MOOD_LABEL = { 1: '1 — очень плохо', 2: '2 — плохо', 3: '3 — так себе', 4: '4 — хорошо', 5: '5 — отлично' };
    const moodBars = guardPartition(
      [1, 2, 3, 4, 5].map((v) => ({
        label: MOOD_LABEL[v],
        value: share(moodDist, v),
        tone: v <= 2 ? 'low' : v >= 4 ? 'high' : 'mid',
      })),
    );

    const sleep = dist('sleep_score');
    const anx = dist('anxiety_score');

    const reg = ro
      .prepare(
        `SELECT COUNT(DISTINCT day) AS d FROM analytics_service_facts WHERE ${serviceSubjects} AND metric = 'diary_entry' AND day BETWEEN ? AND ? GROUP BY subject_code`,
      )
      .all(from, to)
      .map((r) => r.d);
    const writers = reg.length;
    const regBuckets = [
      ['Почти каждый день', (d) => d >= days * 0.6],
      ['Через день', (d) => d >= days * 0.3 && d < days * 0.6],
      ['Иногда', (d) => d >= days * 0.1 && d < days * 0.3],
      ['Редко', (d) => d < days * 0.1],
    ].map(([label, test]) => {
      const n = reg.filter(test).length;
      return { label, value: cell(n, n) };
    });
    guardPartition(regBuckets);

    const vis = moodSeries.filter((p) => p.value !== null);
    let trend = '';
    if (vis.length >= 4) {
      const half = Math.floor(vis.length / 2);
      const avg = (list) => list.reduce((s, p) => s + p.value, 0) / list.length;
      const a = avg(vis.slice(0, half));
      const b = avg(vis.slice(-half));
      const d = round2(b - a);
      trend =
        Math.abs(d) < 0.1
          ? `Среднее настроение держится ровно: около ${dec(round1(b))} из 5.`
          : `Среднее настроение ${d > 0 ? 'выросло' : 'снизилось'} с ${dec(round1(a))} до ${dec(round1(b))} из 5 за период.`;
    }
    const low =
      share(moodDist, 1) === null || share(moodDist, 2) === null ? null : share(moodDist, 1) + share(moodDist, 2);
    const strongAnx = share(anx, 2);
    const headline = hidden(writers)
      ? 'Участников с дневником пока слишком мало, чтобы показывать общую картину.'
      : `${trend ? `${trend} ` : ''}${low !== null ? `Дни с настроением 1–2 — ${low}% записей. ` : ''}${strongAnx !== null ? `Сильную тревогу отмечали в ${strongAnx}% записей.` : ''}`.trim();

    const sleepSeg = guardPartition([
      { label: 'Плохо', value: share(sleep, 0), tone: 'low' },
      { label: 'Нормально', value: share(sleep, 1), tone: 'mid' },
      { label: 'Хорошо', value: share(sleep, 2), tone: 'high' },
    ]);
    const anxSeg = guardPartition([
      { label: 'Нет', value: share(anx, 0), tone: 'high' },
      { label: 'Немного', value: share(anx, 1), tone: 'mid' },
      { label: 'Сильная', value: share(anx, 2), tone: 'low' },
    ]);

    return {
      key: 'wellbeing',
      title: 'Как они себя чувствуют',
      kicker: 'Дневник',
      headline,
      blocks: [
        series('Среднее настроение по неделям', 'балл 1–5', moodSeries, {
          domain: [1, 5],
          note: 'Среднее по людям, которые вели дневник на этой неделе; неделя с группой меньше порога пропущена.',
        }),
        bars('Как распределились оценки настроения', '% записей', moodBars),
        stack('Сон', sleepSeg),
        stack('Тревога', anxSeg),
        bars('Как часто ведут дневник', 'чел.', regBuckets, { note: `Дней с записью за период (${days} дн.).` }),
      ],
    };
  }

  // ---------- 4. Тесты
  function testsChapter() {
    const labels = Object.fromEntries(
      db
        .prepare('SELECT code, title FROM instruments')
        .all()
        .map((r) => [r.code, r.title.split(':')[0].replace(/\s*\(.*\)\s*$/, '')]),
    );
    const per = ro
      .prepare(
        `SELECT instrument, COUNT(DISTINCT subject_code) AS p, COUNT(*) AS n, AVG(score) AS avg FROM insights_tests WHERE ${insightsSubjects} AND day BETWEEN ? AND ? GROUP BY instrument ORDER BY n DESC`,
      )
      .all(from, to);
    const items = per.map((r) => ({
      label: labels[r.instrument] || r.instrument,
      value: cell(r.p, r.n),
      people: cell(r.p, r.p),
      extra: cell(r.p, `средний балл ${dec(round1(r.avg))}`),
    }));
    const weekly = ro
      .prepare(
        `SELECT date(day,'weekday 0','-6 days') AS w, COUNT(DISTINCT subject_code) AS p, COUNT(*) AS n FROM insights_tests WHERE ${insightsSubjects} AND day BETWEEN ? AND ? GROUP BY w`,
      )
      .all(from, to);
    const wMap = new Map(weekly.map((r) => [r.w, r]));
    const wSeries = weeks.map((w) => {
      const r = wMap.get(w);
      return { label: weekLabel(w), value: r ? cell(r.p, r.n) : 0, n: r ? r.p : 0 };
    });
    const tot = countPeople('insights_tests', insightsSubjects, 'day', from, to);
    const share = programMembers ? pct(tot.p, programMembers) : null;
    const topItem = items.find((i) => i.value !== null);
    const headline = hidden(tot.p)
      ? 'Тестов за период пройдено слишком мало, чтобы показывать картину.'
      : `За период пройдено ${num(tot.n)} ${plural(tot.n, 'тест', 'теста', 'тестов')} — их проходили ${num(tot.p)} ${plural(tot.p, 'человек', 'человека', 'человек')}${share !== null ? ` (${share}% участников программы)` : ''}.` +
        (topItem ? ` Чаще всего — ${topItem.label}.` : '');
    return {
      key: 'tests',
      title: 'Что показывают тесты',
      kicker: 'Тесты',
      headline,
      blocks: [
        series('Сколько тестов проходят по неделям', 'результатов', wSeries, { kind: 'columns' }),
        bars('Какие тесты проходят', 'результатов', items, {
          note: 'Баллы разных тестов между собой не сравниваются; клинические выводы по ним здесь не делаются.',
        }),
      ],
    };
  }

  // ---------- 5. Лечение
  function treatment() {
    const status = ro
      .prepare(
        `SELECT status, COUNT(DISTINCT subject_code) AS p, COUNT(*) AS n FROM insights_med_marks WHERE ${insightsSubjects} AND day BETWEEN ? AND ? GROUP BY status`,
      )
      .all(from, to);
    const totalMarks = status.reduce((s, r) => s + r.n, 0);
    const people = ro
      .prepare(
        `SELECT COUNT(DISTINCT subject_code) AS p FROM insights_med_marks WHERE ${insightsSubjects} AND day BETWEEN ? AND ?`,
      )
      .get(from, to).p;
    const stShare = (key) => {
      const r = status.find((x) => x.status === key);
      return hidden(people) ? null : r ? pct(r.n, totalMarks) : 0;
    };
    const weekly = ro
      .prepare(
        `SELECT date(day,'weekday 0','-6 days') AS w, COUNT(DISTINCT subject_code) AS p, COUNT(*) AS n, SUM(CASE WHEN status='taken' THEN 1 ELSE 0 END) AS t FROM insights_med_marks WHERE ${insightsSubjects} AND day BETWEEN ? AND ? GROUP BY w`,
      )
      .all(from, to);
    const wMap = new Map(weekly.map((r) => [r.w, r]));
    const taken = weeks.map((w) => {
      const r = wMap.get(w);
      return { label: weekLabel(w), value: r ? cell(r.p, pct(r.t, r.n)) : null, n: r ? r.p : 0 };
    });
    const slots = ro
      .prepare(
        `SELECT CASE slot WHEN 'morning' THEN 'утро' WHEN 'noon' THEN 'день' WHEN 'evening' THEN 'вечер' WHEN 'night' THEN 'ночь' ELSE slot END AS slot, COUNT(DISTINCT subject_code) AS p, COUNT(*) AS n, SUM(CASE WHEN status='taken' THEN 1 ELSE 0 END) AS t FROM insights_med_marks WHERE ${insightsSubjects} AND day BETWEEN ? AND ? GROUP BY 1`,
      )
      .all(from, to)
      .sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot))
      .map((r) => ({
        label: r.slot.charAt(0).toUpperCase() + r.slot.slice(1),
        value: cell(r.p, pct(r.t, r.n)),
        people: cell(r.p, r.p),
      }));
    const groups = ro
      .prepare(
        `SELECT drug_group AS g, COUNT(DISTINCT subject_code) AS p FROM insights_plan_items WHERE ${insightsSubjects} AND status = 'active' GROUP BY g ORDER BY p DESC`,
      )
      .all()
      .map((r) => ({ label: DRUG_GROUP_LABEL[r.g] || 'Другое', value: cell(r.p, r.p) }));
    const inn = ro
      .prepare(
        `SELECT inn_name AS n, COUNT(DISTINCT subject_code) AS p FROM insights_plan_items WHERE ${insightsSubjects} AND status = 'active' GROUP BY inn_id ORDER BY p DESC LIMIT 8`,
      )
      .all()
      .map((r) => ({ label: r.n.charAt(0).toUpperCase() + r.n.slice(1), value: cell(r.p, r.p) }));
    const planned = ro
      .prepare(
        `SELECT COUNT(DISTINCT subject_code) AS p FROM insights_plan_items WHERE ${insightsSubjects} AND status = 'active'`,
      )
      .get().p;
    const bought = ro
      .prepare(`SELECT COUNT(DISTINCT subject_code) AS p FROM insights_purchases WHERE ${insightsSubjects}`)
      .get().p;

    const taken100 = stShare('taken');
    const headline = hidden(people)
      ? 'Отметок о приёме лекарств пока слишком мало, чтобы показывать картину.'
      : `${num(people)} ${plural(people, 'человек отмечал', 'человека отмечали', 'человек отмечали')} приём: «принял» — ${taken100}% отметок, «пропустил» — ${stShare('skipped')}%, «позже» — ${stShare('later')}%. ` +
        'Нет отметки — не значит, что человек не принимает лекарство.';
    return {
      key: 'treatment',
      title: 'Что с лечением',
      kicker: 'Лекарства',
      headline,
      blocks: [
        tiles([
          { label: 'Участников с назначением', value: cell(planned, planned) },
          { label: 'Отметили покупку', value: cell(bought, bought) },
          { label: 'Отмечали приём за период', value: cell(people, people) },
        ]),
        stack(
          'Что отмечают при приёме',
          guardPartition([
            { label: 'Принял', value: stShare('taken'), tone: 'high' },
            { label: 'Позже', value: stShare('later'), tone: 'mid' },
            { label: 'Пропустил', value: stShare('skipped'), tone: 'low' },
          ]),
        ),
        series('Доля отметок «принял» по неделям', '%', taken, {
          domain: [0, 100],
          note: 'Доля среди отметок, а не среди назначенных приёмов.',
        }),
        bars('Когда чаще принимают', '% «принял»', slots),
        bars('Какие группы препаратов назначены', 'чел.', groups, {
          note: 'Действующие назначения; каждый человек учтён в группе один раз.',
        }),
        bars('Чаще всего назначают', 'чел.', inn),
      ],
    };
  }

  // ---------- 6. Побочные эффекты
  function adverse() {
    const tot = ro
      .prepare(
        `SELECT COUNT(DISTINCT subject_code) AS p, COUNT(DISTINCT report_ref) AS n FROM insights_adverse WHERE ${insightsSubjects} AND day BETWEEN ? AND ?`,
      )
      .get(from, to);
    const monthRows = ro
      .prepare(
        `SELECT substr(day,1,7) AS m, COUNT(DISTINCT subject_code) AS p, COUNT(DISTINCT report_ref) AS n FROM insights_adverse WHERE ${insightsSubjects} AND day BETWEEN ? AND ? GROUP BY m`,
      )
      .all(from, to);
    const mMap = new Map(monthRows.map((r) => [r.m, r]));
    const monthly = monthsOf(from, to).map((m) => {
      const r = mMap.get(m);
      return { label: m, value: r ? cell(r.p, r.n) : 0, n: r ? r.p : 0 };
    });
    const sev = ro
      .prepare(
        `SELECT COALESCE(severity,'unknown') AS s, COUNT(DISTINCT subject_code) AS p, COUNT(DISTINCT report_ref) AS n FROM insights_adverse WHERE ${insightsSubjects} AND day BETWEEN ? AND ? GROUP BY s`,
      )
      .all(from, to);
    const sevItems = guardPartition(
      ['mild', 'noticeable', 'severe', 'unknown'].map((k) => {
        const r = sev.find((x) => x.s === k);
        return {
          label: SEVERITY_LABEL[k],
          value: r ? cell(r.p, r.n) : hidden(tot.p) ? null : 0,
          tone: k === 'severe' ? 'low' : k === 'noticeable' ? 'mid' : 'high',
        };
      }),
    );
    const complaints = ro
      .prepare(
        `SELECT COALESCE(complaint,'other') AS c, COUNT(DISTINCT subject_code) AS p FROM insights_adverse WHERE ${insightsSubjects} AND day BETWEEN ? AND ? GROUP BY c ORDER BY p DESC`,
      )
      .all(from, to)
      .map((r) => ({ label: COMPLAINT[r.c] || 'Другое', value: cell(r.p, r.p) }));
    const topC = complaints.find((c) => c.value !== null);
    const sharePeople = programMembers ? pct(tot.p, programMembers) : null;
    const headline = hidden(tot.p)
      ? 'Сообщений о побочных эффектах мало — показывать разбивку нельзя: по малой группе можно узнать человека.'
      : `О побочных эффектах сообщили ${num(tot.p)} ${plural(tot.p, 'человек', 'человека', 'человек')}${sharePeople !== null ? ` (${sharePeople}% участников)` : ''}, всего ${num(tot.n)} ${plural(tot.n, 'сообщение', 'сообщения', 'сообщений')}.` +
        (topC
          ? ` Чаще всего — «${topC.label.toLowerCase()}». Это сообщения пациентов, а не подтверждённая связь с лекарством.`
          : '');
    return {
      key: 'adverse',
      title: 'Побочные эффекты',
      kicker: 'Безопасность лечения',
      headline,
      blocks: [
        series('Сообщения по месяцам', 'сообщений', monthly, { kind: 'columns' }),
        bars('Насколько мешает', 'сообщений', sevItems),
        bars('На что жалуются', 'чел.', complaints, { note: 'Один человек может назвать несколько жалоб.' }),
      ],
    };
  }

  // ---------- 7. Забота и безопасность
  function care() {
    const crisis = db
      .prepare(
        "SELECT COUNT(*) AS n, SUM(CASE WHEN status='handled' THEN 1 ELSE 0 END) AS handled, SUM(CASE WHEN status<>'handled' AND due_at IS NOT NULL AND due_at < ? THEN 1 ELSE 0 END) AS late FROM crisis_escalations WHERE substr(created_at,1,10) BETWEEN ? AND ?",
      )
      .get(nowIso, from, to);
    const handledTimes = db
      .prepare(
        "SELECT (julianday(handled_at) - julianday(created_at)) * 1440 AS m FROM crisis_escalations WHERE status='handled' AND handled_at IS NOT NULL AND substr(created_at,1,10) BETWEEN ? AND ?",
      )
      .all(from, to)
      .map((r) => r.m)
      .filter((m) => m >= 0);
    const medMin = median(handledTimes);
    const tiers = db
      .prepare(
        'SELECT tier, COUNT(*) AS n FROM crisis_escalations WHERE substr(created_at,1,10) BETWEEN ? AND ? GROUP BY tier ORDER BY tier',
      )
      .all(from, to);
    const crisisWeekly = db
      .prepare(
        "SELECT strftime('%Y-%m-%d', date(substr(created_at,1,10),'weekday 0','-6 days')) AS w, COUNT(*) AS n FROM crisis_escalations WHERE substr(created_at,1,10) BETWEEN ? AND ? GROUP BY w",
      )
      .all(from, to);
    const cMap = new Map(crisisWeekly.map((r) => [r.w, r.n]));
    const crisisSeries = weeks.map((w) => ({ label: weekLabel(w), value: cMap.get(w) || 0 }));

    const queueOpen = db
      .prepare(
        "SELECT kind, COUNT(*) AS n FROM service_queue WHERE status IN ('new','taken','open','waiting') GROUP BY kind ORDER BY n DESC",
      )
      .all()
      .map((r) => ({ label: KIND_LABEL[r.kind] || 'Другое', value: r.n }));
    const closed = db
      .prepare(
        "SELECT COUNT(*) AS n, AVG((julianday(closed_at) - julianday(created_at)) * 24) AS h FROM service_queue WHERE status IN ('done','rejected') AND closed_at IS NOT NULL AND substr(closed_at,1,10) BETWEEN ? AND ?",
      )
      .get(from, to);

    const msgs = db
      .prepare(
        "SELECT sender_role AS r, COUNT(*) AS n FROM care_messages WHERE status = 'sent' AND substr(created_at,1,10) BETWEEN ? AND ? GROUP BY sender_role",
      )
      .all(from, to);
    const fromPatients = msgs.find((m) => m.r === 'patient')?.n || 0;
    const fromClinicians = msgs.find((m) => m.r === 'clinician')?.n || 0;
    const visits = db
      .prepare('SELECT status, COUNT(*) AS n FROM visits WHERE substr(starts_at,1,10) BETWEEN ? AND ? GROUP BY status')
      .all(from, to)
      .map((r) => ({ label: VISIT_LABEL[r.status] || r.status, value: r.n }));
    const dsr = db
      .prepare(
        "SELECT request_type AS t, COUNT(*) AS n FROM data_subject_requests WHERE status IN ('submitted','in_work','waiting_crisis','pending') GROUP BY t ORDER BY n DESC",
      )
      .all()
      .map((r) => ({ label: DSR_LABEL[r.t] || 'Другое', value: r.n }));
    const noClinician = db
      .prepare(
        "SELECT COUNT(*) AS n FROM users u WHERE u.role = 'patient' AND u.status = 'active' AND NOT EXISTS (SELECT 1 FROM care_assignments a WHERE a.patient_id = u.id AND a.ended_at IS NULL AND COALESCE(a.end_reason,'') <> 'signal_only')",
      )
      .get().n;

    const headline =
      (crisis.n
        ? `За период было ${crisis.n} ${plural(crisis.n, 'кризисное обращение', 'кризисных обращения', 'кризисных обращений')}: разобрано ${crisis.handled || 0}${crisis.late ? `, просрочено ${crisis.late}` : ''}${medMin !== null ? `; медиана до закрытия — ${Math.round(medMin)} мин` : ''}. `
        : 'Кризисных обращений за период не было. ') +
      (noClinician
        ? `Без специалиста сейчас ${num(noClinician)} ${plural(noClinician, 'пациент', 'пациента', 'пациентов')}. `
        : 'У всех пациентов есть специалист. ') +
      `Открытых служебных запросов — ${queueOpen.reduce((s, q) => s + q.value, 0)}.`;

    return {
      key: 'care',
      title: 'Забота и безопасность',
      kicker: 'Кризисы и запросы',
      headline,
      blocks: [
        tiles([
          {
            label: 'Кризисных обращений',
            value: crisis.n,
            tone: crisis.late ? 'warn' : 'ok',
            hint: crisis.late ? `просрочено: ${crisis.late}` : 'просроченных нет',
          },
          {
            label: 'Медиана до закрытия',
            value: medMin === null ? null : Math.round(medMin),
            unit: 'мин',
            hint: `закрыто: ${crisis.handled || 0}`,
          },
          {
            label: 'Запросов закрыто',
            value: closed.n,
            hint: closed.n ? `в среднем за ${dec(round1(closed.h))} ч` : '',
          },
          {
            label: 'Сообщений пациент ↔ специалист',
            value: fromPatients + fromClinicians,
            hint: `от пациентов: ${fromPatients}, от специалистов: ${fromClinicians}`,
          },
        ]),
        series('Кризисные обращения по неделям', 'обращений', crisisSeries, { kind: 'columns' }),
        bars(
          'Тяжесть обращений',
          'обращений',
          tiers.map((t) => ({
            label: ['', 'Уровень 1', 'Уровень 2', 'Уровень 3'][t.tier] || 'Уровень 0',
            value: t.n,
            tone: t.tier >= 2 ? 'low' : 'mid',
          })),
        ),
        bars('Что ждёт решения администратора', 'запросов', queueOpen, { link: '/admin?tab=requests' }),
        bars('Визиты', 'визитов', visits),
        bars('Обращения о данных и согласиях в работе', 'обращений', dsr),
      ],
    };
  }

  // ---------- 8. ИИ
  function ai() {
    const totals = db
      .prepare(
        'SELECT COUNT(*) AS n, COALESCE(SUM(tokens_in),0) AS tin, COALESCE(SUM(tokens_out),0) AS tout, AVG(duration_ms) AS ms FROM ai_audit WHERE substr(created_at,1,10) BETWEEN ? AND ?',
      )
      .get(from, to);
    const byPurpose = db
      .prepare(
        'SELECT purpose, COUNT(*) AS n FROM ai_audit WHERE substr(created_at,1,10) BETWEEN ? AND ? GROUP BY purpose ORDER BY n DESC',
      )
      .all(from, to)
      .map((r) => ({ label: PURPOSE_LABEL[r.purpose] || 'Другое', value: r.n }));
    const statuses = db
      .prepare(
        'SELECT status, COUNT(*) AS n FROM ai_audit WHERE substr(created_at,1,10) BETWEEN ? AND ? GROUP BY status',
      )
      .all(from, to);
    const okShare = totals.n ? pct(statuses.find((s) => s.status === 'ok')?.n || 0, totals.n) : null;
    const weekly = db
      .prepare(
        "SELECT date(substr(created_at,1,10),'weekday 0','-6 days') AS w, COUNT(*) AS n FROM ai_audit WHERE substr(created_at,1,10) BETWEEN ? AND ? GROUP BY w",
      )
      .all(from, to);
    const wMap = new Map(weekly.map((r) => [r.w, r.n]));
    const wSeries = weeks.map((w) => ({ label: weekLabel(w), value: wMap.get(w) || 0 }));
    const cost = db
      .prepare(
        'SELECT month, SUM(requests) AS r, SUM(tokens) AS t, SUM(cost_kopecks) AS c FROM ai_usage WHERE month BETWEEN ? AND ? GROUP BY month ORDER BY month',
      )
      .all(from.slice(0, 7), to.slice(0, 7));
    const cMap = new Map(cost.map((r) => [r.month, r]));
    const costSeries = monthsOf(from, to).map((m) => ({
      label: m,
      value: cMap.has(m) ? round2(cMap.get(m).c / 100) : 0,
    }));
    const totalCost = cost.reduce((s, r) => s + r.c, 0) / 100;
    const ratings = db
      .prepare(
        'SELECT rating, COUNT(*) AS n FROM ai_ratings WHERE substr(updated_at,1,10) BETWEEN ? AND ? GROUP BY rating',
      )
      .all(from, to);
    const rated = ratings.reduce((s, r) => s + r.n, 0);
    const useful = ratings.find((r) => r.rating === 'useful')?.n || 0;
    const agent = db
      .prepare(
        "SELECT COUNT(*) AS n, AVG(steps) AS steps, AVG(tool_calls) AS tools, AVG(duration_ms) AS ms, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok FROM ai_agent_runs WHERE substr(created_at,1,10) BETWEEN ? AND ?",
      )
      .get(from, to);
    const crisisAi = db
      .prepare('SELECT COUNT(*) AS n FROM ai_audit WHERE crisis = 1 AND substr(created_at,1,10) BETWEEN ? AND ?')
      .get(from, to).n;

    const headline = totals.n
      ? `ИИ ответил на ${num(totals.n)} ${plural(totals.n, 'обращение', 'обращения', 'обращений')}, потрачено ${num(totals.tin + totals.tout)} токенов${totalCost ? ` (${dec(round2(totalCost))} ₽)` : ''}. ` +
        (okShare !== null ? `Нормальный ответ — в ${okShare}% случаев. ` : '') +
        (rated ? `Полезным ответ назвали ${pct(useful, rated)}% из ${rated} оценивших.` : 'Оценок ответов пока нет.')
      : 'За период обращений к ИИ не было.';
    return {
      key: 'ai',
      title: 'ИИ-помощники',
      kicker: 'ИИ',
      headline,
      blocks: [
        tiles([
          { label: 'Обращений', value: totals.n },
          {
            label: 'Токенов',
            value: totals.tin + totals.tout,
            hint: `вопросы ${num(totals.tin)}, ответы ${num(totals.tout)}`,
          },
          { label: 'Среднее время ответа', value: totals.ms ? dec(round1(totals.ms / 1000)) : null, unit: 'с' },
          { label: 'Кризисный путь до ИИ', value: crisisAi, hint: 'сообщения, обработанные кризисной проверкой' },
        ]),
        series('Обращения к ИИ по неделям', 'обращений', wSeries, { kind: 'columns' }),
        bars('Кто обращается', 'обращений', byPurpose),
        stack(
          'Чем закончились обращения',
          ['ok', 'fallback', 'filtered', 'limit', 'timeout', 'error', 'crisis'].map((k) => ({
            label: AI_STATUS_LABEL[k],
            value: totals.n ? pct(statuses.find((s) => s.status === k)?.n || 0, totals.n) : null,
            tone: k === 'ok' ? 'high' : ['fallback', 'filtered', 'limit', 'crisis'].includes(k) ? 'mid' : 'low',
          })),
        ),
        series('Расход по месяцам', '₽', costSeries, { kind: 'columns' }),
        tiles([
          { label: 'Прогонов агента', value: agent.n, hint: agent.n ? `успешно: ${pct(agent.ok, agent.n)}%` : '' },
          { label: 'Шагов за прогон', value: agent.n ? dec(round1(agent.steps)) : null },
          {
            label: 'Вызовов инструментов',
            value: agent.n ? dec(round1(agent.tools)) : null,
            hint: 'в среднем за прогон',
          },
          {
            label: 'Оценили полезным',
            value: rated ? `${pct(useful, rated)}%` : null,
            hint: rated ? `оценок: ${rated}` : 'оценок нет',
          },
        ]),
      ],
    };
  }

  // ---------- 9. Контент и цветок
  function content() {
    const lib = db
      .prepare(
        'SELECT status, media, audience, COUNT(*) AS n FROM library_items WHERE hidden_at IS NULL GROUP BY status, media, audience',
      )
      .all();
    const sumBy = (key) => {
      const m = new Map();
      for (const r of lib) m.set(r[key], (m.get(r[key]) || 0) + r.n);
      return m;
    };
    const byStatus = sumBy('status');
    const byMedia = sumBy('media');
    const byAud = sumBy('audience');
    const likes = db
      .prepare('SELECT COUNT(*) AS n FROM journal_likes WHERE substr(created_at,1,10) BETWEEN ? AND ?')
      .get(from, to).n;
    const topLiked = db
      .prepare(
        `SELECT v.title AS title, COUNT(l.user_id) AS n FROM journal_likes l JOIN library_items i ON i.id = l.item_id AND i.status = 'published' JOIN library_versions v ON v.item_id = i.id AND v.version = i.current_version WHERE substr(l.created_at,1,10) BETWEEN ? AND ? GROUP BY l.item_id ORDER BY n DESC LIMIT 5`,
      )
      .all(from, to)
      .map((r) => ({ label: r.title.replace(/^STAND-IN:\s*/, ''), value: r.n }));

    const earn = ro
      .prepare(
        `SELECT COUNT(DISTINCT subject_code) AS p, COALESCE(SUM(amount),0) AS drops FROM analytics_flower_events WHERE ${serviceSubjects} AND kind = 'earn' AND day BETWEEN ? AND ?`,
      )
      .get(from, to);
    const water = ro
      .prepare(
        `SELECT COUNT(DISTINCT subject_code) AS p, COALESCE(SUM(steps),0) AS steps FROM analytics_flower_events WHERE ${serviceSubjects} AND kind = 'spend' AND day BETWEEN ? AND ?`,
      )
      .get(from, to);
    const techniques = db
      .prepare(
        'SELECT slug, COUNT(DISTINCT patient_id) AS p, COUNT(*) AS n FROM technique_runs WHERE day BETWEEN ? AND ? GROUP BY slug ORDER BY n DESC',
      )
      .all(from, to)
      .map((r) => ({
        label: TECHNIQUE_LABEL[r.slug] || 'Другая техника',
        value: cell(r.p, r.n),
        people: cell(r.p, r.p),
      }));
    const published = byStatus.get('published') || 0;

    const headline =
      `В библиотеке ${num(published)} ${plural(published, 'опубликованный материал', 'опубликованных материала', 'опубликованных материалов')}` +
      `${byStatus.get('review') ? `, ещё ${byStatus.get('review')} на проверке` : ''}; ` +
      `за период материалам поставили ${num(likes)} ${plural(likes, 'отметку «нравится»', 'отметки «нравится»', 'отметок «нравится»')}. ` +
      (hidden(water.p) ? '' : `Цветок поливали ${num(water.p)} ${plural(water.p, 'человек', 'человека', 'человек')}.`);

    return {
      key: 'content',
      title: 'Материалы и цветок',
      kicker: 'Контент',
      headline,
      blocks: [
        tiles([
          { label: 'Опубликовано', value: published },
          { label: 'Отметок «нравится»', value: likes, hint: 'за период' },
          { label: 'Капель заработано', value: cell(earn.p, earn.drops), hint: 'участниками программы' },
          { label: 'Шагов роста', value: cell(water.p, water.steps), hint: 'потрачено на полив' },
        ]),
        bars(
          'Материалы по состоянию',
          'шт.',
          ['published', 'review', 'draft', 'withdrawn'].map((k) => ({
            label: LIB_STATUS_LABEL[k],
            value: byStatus.get(k) || 0,
          })),
          { link: '/admin?tab=content' },
        ),
        bars(
          'Формат',
          'шт.',
          ['read', 'listen', 'watch'].map((k) => ({ label: MEDIA_LABEL[k], value: byMedia.get(k) || 0 })),
        ),
        bars('Для кого', 'шт.', [
          { label: 'Для пациентов', value: byAud.get('patient') || 0 },
          { label: 'Для специалистов', value: byAud.get('specialist') || 0 },
        ]),
        bars('Что нравится больше всего', 'отметок', topLiked),
        bars('Техники самопомощи', 'раз', techniques),
      ],
    };
  }

  // ---------- 10. Сервис и доступ
  function access() {
    const logins = db
      .prepare(
        'SELECT result, COUNT(*) AS n FROM login_attempts WHERE substr(created_at,1,10) BETWEEN ? AND ? GROUP BY result ORDER BY n DESC',
      )
      .all(from, to);
    const fails = logins.filter((r) => r.result !== 'ok').reduce((s, r) => s + r.n, 0);
    const okLogins = logins.find((r) => r.result === 'ok')?.n || 0;
    const failWeekly = db
      .prepare(
        "SELECT date(substr(created_at,1,10),'weekday 0','-6 days') AS w, COUNT(*) AS n FROM login_attempts WHERE result <> 'ok' AND substr(created_at,1,10) BETWEEN ? AND ? GROUP BY w",
      )
      .all(from, to);
    const fMap = new Map(failWeekly.map((r) => [r.w, r.n]));
    const phi = db
      .prepare(
        'SELECT basis, decision, COUNT(*) AS n FROM phi_access_log WHERE substr(created_at,1,10) BETWEEN ? AND ? GROUP BY basis, decision',
      )
      .all(from, to);
    const phiTotal = phi.reduce((s, r) => s + r.n, 0);
    const denied = phi.filter((r) => r.decision === 'deny').reduce((s, r) => s + r.n, 0);
    const phiBasis = new Map();
    for (const r of phi) phiBasis.set(r.basis || 'self', (phiBasis.get(r.basis || 'self') || 0) + r.n);
    const actions = db
      .prepare(
        "SELECT CASE WHEN instr(action,'.') > 0 THEN substr(action,1,instr(action,'.')-1) ELSE action END AS g, COUNT(*) AS n FROM action_log WHERE substr(created_at,1,10) BETWEEN ? AND ? GROUP BY g ORDER BY n DESC LIMIT 8",
      )
      .all(from, to);
    const ACTION_GROUP = {
      auth: 'Вход и сессии',
      admin: 'Действия администратора',
      demo: 'Демонстрация',
      migration: 'Обновления базы',
      settings: 'Настройки',
      consent: 'Согласия',
      patient: 'Пациенты',
      library: 'Библиотека',
      ai: 'ИИ',
      export: 'Выгрузки',
      care: 'Закрепления',
      crisis: 'Кризисы',
    };
    const sessions = db
      .prepare(
        'SELECT COUNT(*) AS n FROM sessions WHERE closed_at IS NULL AND user_id IS NOT NULL AND idle_expires_at > ?',
      )
      .get(nowIso).n;
    const mail = db.prepare('SELECT status, COUNT(*) AS n FROM mail_queue GROUP BY status').all();
    const mailBad = mail.filter((m) => ['failed', 'retry', 'expired'].includes(m.status)).reduce((s, m) => s + m.n, 0);
    const jobs = db
      .prepare(
        'SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN consecutive_failures > 0 THEN 1 ELSE 0 END),0) AS bad FROM scheduled_jobs',
      )
      .get();
    const exportsN = db
      .prepare('SELECT COUNT(*) AS n FROM export_log WHERE substr(created_at,1,10) BETWEEN ? AND ?')
      .get(from, to).n;

    const headline =
      `За период ${num(okLogins)} ${plural(okLogins, 'успешный вход', 'успешных входа', 'успешных входов')} и ${num(fails)} ${plural(fails, 'неудачная попытка', 'неудачные попытки', 'неудачных попыток')}. ` +
      (phiTotal
        ? `Медицинские карточки открывали ${num(phiTotal)} ${plural(phiTotal, 'раз', 'раза', 'раз')}${denied ? `, отказов в доступе — ${denied}` : ', отказов в доступе не было'}. `
        : 'Карточки пациентов не открывали. ') +
      (mailBad || jobs.bad
        ? 'Есть сбои в почте или фоновых задачах — см. «Сервис».'
        : 'Почта и фоновые задачи работают без сбоев.');

    return {
      key: 'access',
      title: 'Сервис и доступ',
      kicker: 'Надёжность',
      headline,
      blocks: [
        tiles([
          { label: 'Сейчас в сервисе', value: sessions, hint: 'открытых сессий' },
          {
            label: 'Открытий карточек',
            value: phiTotal,
            hint: denied ? `отказов: ${denied}` : 'отказов нет',
            tone: denied ? 'warn' : 'ok',
          },
          { label: 'Выгрузок', value: exportsN, link: '/admin?tab=log' },
          {
            label: 'Сбоев в фоне',
            value: jobs.bad + mailBad,
            hint: `задач: ${jobs.n}`,
            tone: jobs.bad + mailBad ? 'warn' : 'ok',
            link: '/admin?tab=service',
          },
        ]),
        series(
          'Неудачные попытки входа по неделям',
          'попыток',
          weeks.map((w) => ({ label: weekLabel(w), value: fMap.get(w) || 0 })),
          { kind: 'columns' },
        ),
        bars(
          'Чем заканчивались попытки входа',
          'попыток',
          logins.map((r) => ({
            label: LOGIN_LABEL[r.result] || r.result,
            value: r.n,
            tone: r.result === 'ok' ? 'high' : 'low',
          })),
        ),
        bars(
          'Почему открывали карточки',
          'раз',
          [...phiBasis.entries()]
            .map(([k, v]) => ({ label: BASIS_LABEL[k] || 'Другое', value: v }))
            .sort((a, b) => b.value - a.value),
        ),
        bars(
          'Что фиксирует журнал действий',
          'записей',
          actions.map((r) => ({ label: ACTION_GROUP[r.g] || 'Другое', value: r.n })),
          { link: '/admin?tab=log' },
        ),
      ],
    };
  }

  const safe = (fn, key, title) => {
    try {
      return fn();
    } catch (e) {
      console.warn('admin dashboard', key, e.message);
      return { key, title, kicker: '', headline: 'Этот раздел сейчас не удалось собрать.', blocks: [], error: true };
    }
  };

  const kpiList = (() => {
    try {
      return kpis();
    } catch (e) {
      console.warn('admin dashboard kpis', e.message);
      return [];
    }
  })();
  const chapters = [
    safe(people, 'people', 'Кто с нами'),
    ...(program ? [program] : []),
    safe(usage, 'usage', 'Как пользуются сервисом'),
    safe(wellbeing, 'wellbeing', 'Как они себя чувствуют'),
    safe(testsChapter, 'tests', 'Что показывают тесты'),
    safe(treatment, 'treatment', 'Что с лечением'),
    safe(adverse, 'adverse', 'Побочные эффекты'),
    safe(care, 'care', 'Забота и безопасность'),
    safe(ai, 'ai', 'ИИ-помощники'),
    safe(content, 'content', 'Материалы и цветок'),
    safe(access, 'access', 'Сервис и доступ'),
  ];

  for (const c of chapters) arrange(c);

  // Последняя неделя или месяц ещё не закончились — график помечает такую точку, чтобы спад не читался как падение.
  for (const c of chapters)
    for (const b of c.blocks) {
      if (b.type !== 'series' || !b.points.length) continue;
      const last = b.points[b.points.length - 1];
      if (/^\d{4}-\d{2}-\d{2}$/.test(last.label) && shift(last.label, 6) > to) last.partial = true;
      else if (/^\d{4}-\d{2}$/.test(last.label) && last.label === to.slice(0, 7) && to !== lastDayOfMonth(to))
        last.partial = true;
    }

  // Вводная строка: из уже подавленных плиток, поэтому скрытых чисел в ней нет.
  const k = Object.fromEntries(kpiList.map((x) => [x.key, x]));
  const parts = [];
  if (k.active_week?.value != null)
    parts.push(
      `на этой неделе заходили ${num(k.active_week.value)} ${plural(k.active_week.value, 'пациент', 'пациента', 'пациентов')}`,
    );
  if (k.diary?.value != null)
    parts.push(
      `в дневнике ${num(k.diary.value)} ${plural(k.diary.value, 'день с записью', 'дня с записью', 'дней с записью')}`,
    );
  if (k.ai?.value) parts.push(`ИИ ответил ${num(k.ai.value)} ${plural(k.ai.value, 'раз', 'раза', 'раз')}`);
  const lead = `${parts.length ? `За ${days} ${plural(days, 'день', 'дня', 'дней')}: ${parts.join(', ')}. ` : ''}${k.queue?.value ? `Ждут решения ${k.queue.value} ${plural(k.queue.value, 'запрос', 'запроса', 'запросов')}${k.queue.tone === 'warn' ? ', часть просрочена' : ''}.` : 'Очередь запросов пуста.'}`;

  return {
    scope: 'program',
    period: { from, to, days },
    previous: prev,
    min_group: minGroup,
    program_members: programMembers >= minGroup ? programMembers : null,
    lead,
    kpis: kpiList,
    chapters,
    formula_version: 'admin_dashboard_v1',
    disclaimer:
      'Предварительные данные демонстрации. Цифры по пациентам — только по участникам программы и без идентификаторов; группы меньше порога скрыты. Пороги и формулировки требуют проверки специалистом.',
  };
}

module.exports = { build };
