'use strict';

// Расчёт аналитики «диагноз → кто ведёт → что назначают → что происходит → что получается → какова цена».
// Чистые функции: на входе строки из представлений insights_* (только коды субъектов), на выходе отчёт
// с подавлением малых групп. Ни базы, ни patient_id здесь нет — загрузку делает data.js.
// Все пороги и определения предварительные (review-required): их утверждает клинический владелец.

const { suppressCells } = require('../analytics/interpret');

const FORMULA_VERSION = 'insights_v1';
const MIN_DOCTORS = 3; // меньше специалистов в ячейке — профиль можно узнать по месту работы или журналам
const LOW_N_OWN = 10; // у специалиста: меньше пациентов — выводы помечаются «мало наблюдений»
const ADHERENCE_WINDOW = 28;
const INTAKE_WINDOW = 14;
const REGULAR_FROM = 0.8;
const PARTIAL_FROM = 0.4;
const RESPONSE_RATIO = 0.5;
const GRID_DAYS = [7, 14, 21, 28, 42, 56, 84];

const INSTRUMENTS = {
  gad7: { label: 'GAD-7', cut: 10 },
  phq9: { label: 'PHQ-9', cut: 10 },
  bai: { label: 'BAI', cut: 16 },
  bdi2: { label: 'BDI-II', cut: 14 },
};

const SPECIALTY = {
  psychiatrist: 'Психиатр',
  psychotherapist: 'Психотерапевт',
  clinical_psychologist: 'Клинический психолог',
  neurologist: 'Невролог',
  somatic: 'Соматический врач (терапевт и др.)',
  other: 'Другая специальность',
};
const ORG_KIND = {
  polyclinic: 'Поликлиника',
  hospital: 'Больница',
  dispensary: 'Диспансер',
  private: 'Частный центр',
  other: 'Другая организация',
};
const DRUG_GROUP = {
  antidepressant: 'Антидепрессанты',
  anxiolytic: 'Анксиолитики',
  antipsychotic: 'Антипсихотики',
  mood_stabilizer: 'Нормотимики',
  hypnotic_sedative: 'Снотворные и седативные',
  corrector: 'Корректоры',
  other: 'Другое',
};
const COMPLAINT = {
  nausea: 'Тошнота',
  headache: 'Головная боль',
  insomnia: 'Плохой сон',
  sleepy: 'Сонливость',
  dizzy: 'Головокружение',
  anxiety: 'Тревога сильнее',
  other: 'Другое',
};
const SEVERITY = {
  mild: 'Немного мешает',
  noticeable: 'Заметно мешает',
  severe: 'Сильно мешает',
  unknown: 'Не указано',
};
const DURATION_BUCKETS = [
  ['to14', 'до 2 недель', 0, 14],
  ['to30', '2–4 недели', 15, 30],
  ['to60', '1–2 месяца', 31, 60],
  ['to90', '2–3 месяца', 61, 90],
  ['to180', '3–6 месяцев', 91, 180],
  ['over180', 'больше 6 месяцев', 181, Infinity],
  ['none', 'срок не указан', null, null],
];

const DAY_MS = 86400000;
const dayNum = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const numDay = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const shift = (iso, d) => numDay(dayNum(iso) + d);
const pct = (num, den) => (den ? Math.round((num / den) * 100) : null);
const sum = (list) => list.reduce((a, b) => a + b, 0);
const mean = (list) => (list.length ? sum(list) / list.length : null);
const median = (list) => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const groupBy = (rows, key) => {
  const map = new Map();
  for (const r of rows) {
    const k = typeof key === 'function' ? key(r) : r[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
};
const distinct = (rows, key) => new Set(rows.map((r) => (typeof key === 'function' ? key(r) : r[key])));

/** Каплан–Мейер для «времени до улучшения»: obs = [{t, event}], event=false — наблюдение оборвано (цензура). */
function kaplanMeier(obs) {
  const sorted = [...obs].sort((a, b) => a.t - b.t || (a.event ? -1 : 1));
  const steps = [];
  let atRisk = sorted.length;
  let surv = 1;
  for (let i = 0; i < sorted.length; ) {
    const t = sorted[i].t;
    let events = 0;
    let leaving = 0;
    while (i < sorted.length && sorted[i].t === t) {
      if (sorted[i].event) events += 1;
      leaving += 1;
      i += 1;
    }
    if (events) {
      surv *= 1 - events / atRisk;
      steps.push({ t, surv });
    }
    atRisk -= leaving;
  }
  const improvedBy = (day) => {
    let s = 1;
    for (const st of steps) if (st.t <= day) s = st.surv;
    return 1 - s;
  };
  const first = steps.find((st) => st.surv <= 0.5);
  return { improvedBy, median: first ? first.t : null };
}

/** Приверженность одного пациента: отметки приёма против запланированных слотов за последние 28 дней. */
function adherenceOf(items, marks, to) {
  const wStart = shift(to, -(ADHERENCE_WINDOW - 1));
  const recentStart = shift(to, -(INTAKE_WINDOW - 1));
  let expected = 0;
  let taken = 0;
  for (const it of items) {
    if (it.status === 'ended' && !it.end_date) continue;
    const s = it.start_date && it.start_date > wStart ? it.start_date : wStart;
    const e = it.end_date && it.end_date < to ? it.end_date : to;
    if (e < s) continue;
    const exp = (dayNum(e) - dayNum(s) + 1) * (it.slots_per_day || 1);
    expected += exp;
    const slots = new Set(
      marks
        .filter((m) => m.item_key === it.item_key && m.status === 'taken' && m.day >= s && m.day <= e)
        .map((m) => `${m.day}|${m.slot}`),
    );
    taken += Math.min(slots.size, exp);
  }
  const inWindow = marks.filter((m) => m.day >= wStart && m.day <= to);
  const takenRecent = inWindow.filter((m) => m.status === 'taken' && m.day >= recentStart).length;
  const ratio = expected ? Math.min(1, taken / expected) : null;
  let category = 'not_active';
  if (expected)
    category = !inWindow.length
      ? 'no_marks'
      : ratio >= REGULAR_FROM
        ? 'regular'
        : ratio >= PARTIAL_FROM
          ? 'partial'
          : 'rare';
  return { expected, taken, ratio, marks: inWindow.length, takenRecent, category };
}

function activeAt(it, to) {
  return it.status === 'active' && (!it.start_date || it.start_date <= to) && (!it.end_date || it.end_date >= to);
}

/** Улучшение по тесту: первое повторное измерение с баллом не выше половины исходного. */
function testOutcome(rows, cut) {
  const sorted = [...rows].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const base = sorted[0];
  if (!base || base.score < cut) return null;
  const later = sorted.filter((r) => r.day > base.day);
  if (!later.length) return null;
  const hit = later.find((r) => r.score <= base.score * RESPONSE_RATIO);
  const last = later[later.length - 1];
  return {
    t: dayNum((hit || last).day) - dayNum(base.day),
    event: Boolean(hit),
    first: base.score,
    last: last.score,
  };
}

/** Улучшение по самочувствию: скользящее среднее 5 записей выросло на балл от среднего первых пяти. */
function moodOutcome(rows) {
  const sorted = [...rows].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  if (sorted.length < 10) return null;
  const base = mean(sorted.slice(0, 5).map((r) => r.mood));
  if (base > 3) return null;
  for (let i = 5; i < sorted.length; i += 1) {
    const avg = mean(sorted.slice(i - 4, i + 1).map((r) => r.mood));
    if (avg >= base + 1)
      return {
        t: dayNum(sorted[i].day) - dayNum(sorted[0].day),
        event: true,
        first: Math.round(base * 10) / 10,
        last: Math.round(avg * 10) / 10,
      };
  }
  return {
    t: dayNum(sorted[sorted.length - 1].day) - dayNum(sorted[0].day),
    event: false,
    first: Math.round(base * 10) / 10,
    last: Math.round(mean(sorted.slice(-5).map((r) => r.mood)) * 10) / 10,
  };
}

function survivalBlock(key, label, kind, perSubject, min, cutText) {
  const obs = perSubject.filter(Boolean);
  const n = obs.length;
  const hidden = n < min;
  const improved = obs.filter((o) => o.event).length;
  const km = n ? kaplanMeier(obs) : null;
  return {
    key,
    label,
    kind,
    cut_text: cutText,
    n_patients: hidden ? null : n,
    n_improved: hidden || improved < min || n - improved < min ? null : improved,
    share_improved: hidden ? null : pct(improved, n),
    median_days: hidden || !km ? null : km.median,
    median_reached: hidden ? null : km.median !== null,
    share_by: hidden
      ? null
      : {
          14: Math.round(km.improvedBy(14) * 100),
          28: Math.round(km.improvedBy(28) * 100),
          56: Math.round(km.improvedBy(56) * 100),
        },
    curve: hidden ? [] : GRID_DAYS.map((d) => ({ day: d, share: Math.round(km.improvedBy(d) * 100) })),
    suppressed: hidden,
  };
}

/**
 * @param {object} data    строки представлений (см. data.js)
 * @param {object} o       {dx, from, to, minGroup, audience:'admin'|'psychiatrist'|'psychologist', diagnoses, withSubjects}
 */
function buildReport(data, o) {
  const own = o.audience !== 'admin';
  const min = own ? 1 : o.minGroup;
  const docMin = own ? 1 : MIN_DOCTORS;
  const to = o.to;
  const from = o.from;
  const meds = o.audience !== 'psychologist';
  // Пустая ячейка ничего не раскрывает и дополнительного скрытия не требует.
  const supp = (cells, m) => {
    if (own) return cells.map((c) => ({ ...c, suppressed: false }));
    const nonEmpty = suppressCells(
      cells.filter((c) => c.n > 0),
      m,
    );
    return cells.map((c) => nonEmpty.find((x) => x.key === c.key) || { ...c, suppressed: false });
  };
  const dxLabel = new Map((o.diagnoses || []).map((d) => [d.code, d.label]));

  const all = new Map(data.patients.map((p) => [p.subject_code, p]));
  const memberCodes = [...new Set(data.members.map((m) => m.subject_code))].filter((c) => all.has(c));

  // ---- выбор диагноза: ячейки диагнозов дают итог, поэтому подавляем с дополнением
  const dxCounts = groupBy(memberCodes, (c) => all.get(c).dx_code || 'unknown');
  const dxCells = supp(
    [...(o.diagnoses || []).map((d) => d.code), 'unknown'].map((code) => ({
      key: code,
      n: (dxCounts.get(code) || []).length,
    })),
    min,
  );
  const diagnosisOptions = dxCells
    .filter((c) => c.n > 0 || c.key === 'unknown')
    .map((c) => ({
      code: c.key,
      label: c.key === 'unknown' ? 'Диагноз не указан' : dxLabel.get(c.key) || c.key,
      n_patients: c.suppressed ? null : c.n,
      suppressed: c.suppressed,
    }));
  const wanted = o.dx || 'all';
  const inDx = (c) => wanted === 'all' || (all.get(c).dx_code || 'unknown') === wanted;
  const codes = memberCodes.filter(inDx);
  const P = new Set(codes);
  const n = codes.length;
  const small = (count) => count < min;
  const lowN = own && n < LOW_N_OWN;
  const sel = {
    code: wanted,
    label:
      wanted === 'all' ? 'Все диагнозы' : wanted === 'unknown' ? 'Диагноз не указан' : dxLabel.get(wanted) || wanted,
  };

  const sub = (rows) => rows.filter((r) => P.has(r.subject_code));
  const links = sub(data.links);
  const plan = sub(data.plan);
  const purchases = sub(data.purchases);
  const marks = sub(data.marks);
  const adverse = sub(data.adverse).filter((a) => a.day >= from && a.day <= to);
  const tests = sub(data.tests);
  const mood = sub(data.mood);

  const sections = [];

  // ---- 1. Кто они
  {
    const months = [];
    for (let m = from.slice(0, 7); m <= to.slice(0, 7); ) {
      months.push(m);
      const [y, mo] = m.split('-').map(Number);
      m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
    }
    const byMonth = groupBy(
      codes.filter((c) => all.get(c).enrolled_day),
      (c) => all.get(c).enrolled_day.slice(0, 7),
    );
    const cells = supp(
      months.map((m) => ({ key: m, n: (byMonth.get(m) || []).length })),
      min,
    );
    sections.push({
      key: 'who',
      title: 'Кто они',
      n_patients: small(n) ? null : n,
      suppressed: small(n),
      low_n: lowN,
      dynamics: small(n)
        ? []
        : cells.map((c) => ({ month: c.key, n_patients: c.suppressed ? null : c.n, suppressed: c.suppressed })),
      how: `Пациенты ${own ? 'в вашем списке' : 'с согласием на программу поддержки'}${wanted === 'all' ? '' : `, диагноз: ${sel.label}`}. Динамика — число пациентов, начавших наблюдение в месяце. Месяцы, где меньше ${min} человек, скрыты${own ? '' : ' вместе с ближайшим соседом по размеру, чтобы скрытое нельзя было вычесть из итога'}.`,
    });
  }

  // ---- 2. Кто их ведёт (только у администратора: о других специалистах врач не видит ничего)
  if (!own) {
    const doctors = new Map();
    for (const l of links) if (!doctors.has(l.clinician_code)) doctors.set(l.clinician_code, l);
    const bySpec = groupBy(links, 'specialty');
    const specialties = [...bySpec.entries()]
      .map(([k, rows]) => {
        const people = distinct(rows, 'subject_code').size;
        const docs = distinct(rows, 'clinician_code').size;
        const hide = people < min || docs < docMin;
        return {
          key: k,
          label: SPECIALTY[k] || k,
          n_patients: hide ? null : people,
          n_doctors: hide ? null : docs,
          suppressed: hide,
        };
      })
      .sort((a, b) => (b.n_patients ?? -1) - (a.n_patients ?? -1));
    const consenting = links.filter((l) => l.profile_consent === 1);
    const group = (field, labelOf) =>
      [
        ...groupBy(
          consenting.filter((l) => l[field]),
          field,
        ).entries(),
      ]
        .map(([k, rows]) => {
          const people = distinct(rows, 'subject_code').size;
          const docs = distinct(rows, 'clinician_code').size;
          const hide = people < min || docs < docMin;
          return {
            key: k,
            label: labelOf(k, rows[0]),
            n_patients: hide ? null : people,
            n_doctors: hide ? null : docs,
            suppressed: hide,
          };
        })
        .sort((a, b) => (b.n_patients ?? -1) - (a.n_patients ?? -1));
    const orgKinds = group('org_kind', (k) => ORG_KIND[k] || k);
    const regions = group('region', (k) => k);
    const orgs = group('org_id', (_k, row) => row.org_name).slice(0, 12);
    const docTotal = doctors.size;
    const docConsent = [...doctors.values()].filter((d) => d.profile_consent === 1).length;
    sections.push({
      key: 'clinicians',
      title: 'Кто их ведёт',
      n_doctors: docTotal < docMin ? null : docTotal,
      specialties,
      org_kinds: orgKinds,
      regions,
      organizations: orgs,
      profile_share: docTotal < docMin ? null : pct(docConsent, docTotal),
      suppressed: small(n) || docTotal < docMin,
      how: `Специальность — из профиля специалиста, а если профиль не заполнен, по роли в сервисе. Место работы и регион — только у специалистов, которые разрешили использовать профиль в аналитике (необязательно). Строка видна, если в ней не меньше ${min} пациентов и не меньше ${docMin} специалистов: иначе по месту работы можно было бы узнать конкретного врача. Пациент с двумя специалистами попадает в обе строки, поэтому строки не складываются в итог.`,
    });
  }

  // ---- 3. Чем живут врачи (только у администратора)
  if (!own) {
    const interests = data.interests.filter((i) => links.some((l) => l.clinician_code === i.clinician_code));
    const consentingDocs = distinct(
      links.filter((l) => l.profile_consent === 1),
      'clinician_code',
    ).size;
    const top = (kind) =>
      [
        ...groupBy(
          interests.filter((i) => i.kind === kind),
          'title_norm',
        ).entries(),
      ]
        .map(([, rows]) => {
          const docs = distinct(rows, 'clinician_code').size;
          return docs < docMin || consentingDocs < docMin
            ? null
            : { title: rows[0].title, n_doctors: docs, share: pct(docs, consentingDocs) };
        })
        .filter(Boolean)
        .sort((a, b) => b.n_doctors - a.n_doctors)
        .slice(0, 10);
    const journals = top('journal');
    const conferences = top('conference');
    sections.push({
      key: 'doctors',
      title: 'Чем живут врачи',
      n_doctors_declared: consentingDocs < docMin ? null : consentingDocs,
      journals,
      conferences,
      suppressed: small(n) || consentingDocs < docMin,
      how: `Журналы и конференции специалисты называют сами и только если разрешили использовать профиль в аналитике. Названия видны, если их указали не меньше ${docMin} специалистов. Доля — от специалистов, которые заполнили профиль, а не от всех.`,
    });
  }

  // ---- 4. Что назначают
  const planPatients = new Set(plan.map((r) => r.subject_code));
  const nPlan = planPatients.size;
  if (meds) {
    const byInn = [...groupBy(plan, 'inn_id').entries()]
      .map(([, rows]) => {
        const people = distinct(rows, 'subject_code').size;
        return {
          label: rows[0].inn_name,
          group: DRUG_GROUP[rows[0].drug_group] || rows[0].drug_group,
          n_patients: people < min ? null : people,
          share: people < min || small(nPlan) ? null : pct(people, nPlan),
          suppressed: people < min,
        };
      })
      .sort((a, b) => (b.n_patients ?? -1) - (a.n_patients ?? -1));
    const byGroup = [...groupBy(plan, 'drug_group').entries()]
      .map(([k, rows]) => {
        const people = distinct(rows, 'subject_code').size;
        return {
          label: DRUG_GROUP[k] || k,
          n_patients: people < min ? null : people,
          share: people < min || small(nPlan) ? null : pct(people, nPlan),
          suppressed: people < min,
        };
      })
      .sort((a, b) => (b.n_patients ?? -1) - (a.n_patients ?? -1));
    // Срок: по одному назначению на пациента и препарат (пункты плана уникальны по ключу).
    const perItem = new Map();
    for (const r of plan) perItem.set(`${r.subject_code}|${r.item_key}`, r);
    const items = [...perItem.values()];
    const bucketOf = (r) => {
      if (r.duration_days === null || r.duration_days === undefined || r.duration_days < 0) return 'none';
      return DURATION_BUCKETS.find((b) => b[2] !== null && r.duration_days >= b[2] && r.duration_days <= b[3])[0];
    };
    const counts = groupBy(items, bucketOf);
    const bucketCells = supp(
      DURATION_BUCKETS.map((b) => ({ key: b[0], n: (counts.get(b[0]) || []).length })),
      min,
    );
    const termDays = items.filter((r) => r.duration_days > 0).map((r) => r.duration_days);
    const termPeople = distinct(
      items.filter((r) => r.duration_days > 0),
      'subject_code',
    ).size;
    const hideTerm = termPeople < min;
    sections.push({
      key: 'prescribed',
      title: 'Что назначают',
      n_with_plan: small(nPlan) ? null : nPlan,
      share_with_plan: small(nPlan) || small(n) ? null : pct(nPlan, n),
      by_inn: byInn.slice(0, 12),
      by_group: byGroup,
      duration: DURATION_BUCKETS.map((b, i) => ({
        key: b[0],
        label: b[1],
        n: bucketCells[i].suppressed || (hideTerm && b[0] !== 'none') ? null : bucketCells[i].n,
        suppressed: bucketCells[i].suppressed || (hideTerm && b[0] !== 'none'),
      })),
      duration_median_days: hideTerm ? null : median(termDays),
      duration_n_patients: hideTerm ? null : termPeople,
      suppressed: small(nPlan),
      low_n: lowN,
      how: `Опубликованные планы лекарств по МНН. Доля — от пациентов, у которых есть назначение. Срок — дни от начала до даты окончания, если врач её указал (плановая для действующих и фактическая для завершённых назначений); без даты окончания срок «не указан». Это учёт назначений, а не оценка выбора врача.`,
    });
  }

  // ---- 5. Что реально происходит
  const adh = new Map();
  if (meds) {
    const itemsBy = groupBy(plan, 'subject_code');
    const marksBy = groupBy(marks, 'subject_code');
    for (const [code, items] of itemsBy) adh.set(code, adherenceOf(items, marksBy.get(code) || [], to));
    const inTherapy = [...itemsBy.entries()]
      .filter(([, items]) => items.some((it) => activeAt(it, to)))
      .map(([c]) => c);
    const bought = new Set(
      purchases
        .filter((p) => plan.some((it) => it.subject_code === p.subject_code && it.item_key === p.item_key))
        .map((p) => p.subject_code),
    );
    const taking = [...adh.entries()].filter(([, a]) => a.takenRecent > 0).map(([c]) => c);
    const regular = [...adh.entries()].filter(([, a]) => a.category === 'regular').map(([c]) => c);
    const stage = (key, label, count) => ({
      key,
      label,
      n_patients: small(nPlan) || count < min ? null : count,
      share: small(nPlan) || count < min ? null : pct(count, nPlan),
      suppressed: small(nPlan) || count < min,
    });
    const cats = groupBy([...adh.values()], 'category');
    const catKeys = [
      ['regular', 'Отмечают приём регулярно (не реже 4 из 5)'],
      ['partial', 'Отмечают частично'],
      ['rare', 'Отмечают редко'],
      ['no_marks', 'Отметок нет (неизвестно, принимают ли)'],
      ['not_active', 'Назначение не действует'],
    ];
    const catCells = supp(
      catKeys.map(([k]) => ({ key: k, n: (cats.get(k) || []).length })),
      min,
    );
    const buyByInn = [...groupBy(purchases, 'inn_id').entries()]
      .map(([, rows]) => {
        const people = distinct(rows, 'subject_code').size;
        const prescribed = distinct(
          plan.filter((p) => p.inn_id === rows[0].inn_id),
          'subject_code',
        ).size;
        return {
          label: rows[0].inn_name,
          n_patients: people < min ? null : people,
          share_of_prescribed: people < min || prescribed < min ? null : pct(people, prescribed),
          suppressed: people < min,
        };
      })
      .sort((a, b) => (b.n_patients ?? -1) - (a.n_patients ?? -1));
    sections.push({
      key: 'reality',
      title: 'Что реально происходит',
      funnel: [
        stage('prescribed', 'Есть назначение', nPlan),
        stage('active', 'Назначение действует сейчас', inTherapy.length),
        stage('bought', 'Отметили покупку', bought.size),
        stage('taking', `Отмечали приём за ${INTAKE_WINDOW} дней`, taking.length),
        stage('regular', 'Отмечают приём регулярно', regular.length),
      ],
      adherence: catKeys.map(([k, label], i) => ({
        key: k,
        label,
        n_patients: small(nPlan) || catCells[i].suppressed ? null : catCells[i].n,
        suppressed: small(nPlan) || catCells[i].suppressed,
      })),
      purchases: buyByInn.slice(0, 10),
      suppressed: small(nPlan),
      low_n: lowN,
      how: `Покупка — отметка самого пациента «купил(а) препарат», без цены и аптеки. Приём — отметки «принял» за ${ADHERENCE_WINDOW} дней против запланированных приёмов по плану (приёмов в день × дней); «регулярно» — от ${Math.round(REGULAR_FROM * 100)}%, «частично» — от ${Math.round(PARTIAL_FROM * 100)}%. Если отметок нет, это неизвестно, а не «не принимает»: пациент мог не отмечать. Отметки видны, только если пациент делится журналом приёма.`,
    });
  }

  // ---- 6. Что получается
  {
    const blocks = [];
    const testsBy = groupBy(
      tests.filter((t) => INSTRUMENTS[t.instrument] && t.version !== null && t.mode === 'online'),
      (t) => `${t.instrument}:${t.version}`,
    );
    for (const [key, rows] of testsBy) {
      const instr = INSTRUMENTS[rows[0].instrument];
      const perSubject = [...groupBy(rows, 'subject_code').values()].map((r) => testOutcome(r, instr.cut));
      blocks.push(
        survivalBlock(
          key,
          `${instr.label}, версия ${rows[0].version}`,
          'test',
          perSubject,
          min,
          `балл не выше половины исходного (исходный не ниже ${instr.cut})`,
        ),
      );
    }
    const moodOutcomes = [...groupBy(mood, 'subject_code').values()].map(moodOutcome);
    if (moodOutcomes.some(Boolean))
      blocks.push(
        survivalBlock(
          'mood',
          'Самочувствие по дневнику',
          'mood',
          moodOutcomes,
          min,
          'среднее настроение за 5 записей выросло на 1 балл от исходного',
        ),
      );
    blocks.sort((a, b) => (b.n_patients ?? -1) - (a.n_patients ?? -1));
    sections.push({
      key: 'outcomes',
      title: 'Что получается',
      measures: blocks,
      suppressed: !blocks.length || blocks.every((b) => b.suppressed),
      low_n: lowN,
      how: `Время от первого измерения до первого повторного, где улучшение достигнуто. Те, у кого улучшения ещё нет, учтены как «пока без улучшения» до даты последнего измерения (оценка Каплана–Мейера), поэтому медиана не завышается из-за тех, кто выбыл. Сравниваются только измерения одной методики и одной версии, заполненные онлайн. «Улучшение» — рабочее определение (снижение балла вдвое), не клинический вывод и не оценка лечения.`,
    });
  }

  // ---- 7. Какова цена
  if (meds) {
    const reports = [...groupBy(adverse, 'report_ref').values()];
    const reportPeople = distinct(adverse, 'subject_code').size;
    const complaintRows = [...groupBy(adverse, (a) => a.complaint || 'other').entries()]
      .map(([k, rows]) => {
        const people = distinct(rows, 'subject_code').size;
        return {
          key: k,
          label: COMPLAINT[k] || 'Другое',
          n_patients: people < min ? null : people,
          n_reports: people < min ? null : distinct(rows, 'report_ref').size,
          share_of_reporters: people < min || reportPeople < min ? null : pct(people, reportPeople),
          suppressed: people < min,
        };
      })
      .sort((a, b) => (b.n_patients ?? -1) - (a.n_patients ?? -1));
    const severityCounts = groupBy(reports, (r) => r[0].severity || 'unknown');
    const sevCells = supp(
      Object.keys(SEVERITY).map((k) => ({ key: k, n: (severityCounts.get(k) || []).length })),
      min,
    );
    const byInn = [
      ...groupBy(
        adverse.filter((a) => a.inn_id),
        'inn_id',
      ).entries(),
    ]
      .map(([, rows]) => {
        const people = distinct(rows, 'subject_code').size;
        return { label: rows[0].inn_name, n_patients: people < min ? null : people, suppressed: people < min };
      })
      .sort((a, b) => (b.n_patients ?? -1) - (a.n_patients ?? -1));
    sections.push({
      key: 'cost',
      title: 'Какова цена',
      n_reporters: reportPeople < min ? null : reportPeople,
      n_reports: reportPeople < min ? null : reports.length,
      share_of_group: reportPeople < min || small(n) ? null : pct(reportPeople, n),
      share_of_prescribed: reportPeople < min || small(nPlan) ? null : pct(reportPeople, nPlan),
      complaints: complaintRows,
      severity: Object.entries(SEVERITY).map(([k, label], i) => ({
        key: k,
        label,
        n_reports: sevCells[i].suppressed ? null : sevCells[i].n,
        suppressed: sevCells[i].suppressed,
      })),
      by_inn: byInn.slice(0, 8),
      suppressed: reportPeople < min,
      low_n: lowN,
      how: `Сообщения пациентов о побочных эффектах, отправленные за период. Это сообщения, а не подтверждённые реакции на лекарство: причинная связь не проверялась. Жалобы — отметки пациента в форме; один человек мог отметить несколько. Нет сообщений — не значит, что эффектов нет.`,
    });
  }

  const out = {
    scope: own ? 'own' : 'program',
    formula_version: FORMULA_VERSION,
    preliminary: true,
    period: { from, to },
    min_group: own ? null : min,
    min_doctors: own ? null : MIN_DOCTORS,
    low_n_threshold: own ? LOW_N_OWN : null,
    diagnosis: { selected: sel, options: diagnosisOptions },
    n_patients: small(n) ? null : n,
    sections,
  };
  if (o.withSubjects) {
    out.per_subject = codes.map((c) => {
      const a = adh.get(c);
      return {
        code: c,
        dx: all.get(c).dx_code || null,
        drugs: [...new Set(plan.filter((p) => p.subject_code === c && activeAt(p, to)).map((p) => p.inn_name))],
        adherence: a ? { category: a.category, ratio: a.ratio === null ? null : Math.round(a.ratio * 100) } : null,
        bought: purchases.some((p) => p.subject_code === c),
        ae_reports: distinct(
          adverse.filter((x) => x.subject_code === c),
          'report_ref',
        ).size,
        tests: ['gad7', 'phq9', 'bai', 'bdi2']
          .map((ins) => {
            const rows = tests
              .filter((t) => t.subject_code === c && t.instrument === ins && t.mode === 'online')
              .sort((x, y) => (x.day < y.day ? -1 : 1));
            return rows.length
              ? {
                  instrument: INSTRUMENTS[ins].label,
                  n: rows.length,
                  first: rows[0].score,
                  last: rows[rows.length - 1].score,
                }
              : null;
          })
          .filter(Boolean),
        mood: (() => {
          const m = mood.filter((x) => x.subject_code === c).sort((x, y) => (x.day < y.day ? -1 : 1));
          return m.length >= 2
            ? {
                n: m.length,
                first: Math.round(mean(m.slice(0, 5).map((x) => x.mood)) * 10) / 10,
                last: Math.round(mean(m.slice(-5).map((x) => x.mood)) * 10) / 10,
              }
            : null;
        })(),
      };
    });
  }
  return out;
}

module.exports = {
  buildReport,
  kaplanMeier,
  adherenceOf,
  testOutcome,
  moodOutcome,
  FORMULA_VERSION,
  MIN_DOCTORS,
  LOW_N_OWN,
  SPECIALTY,
  ORG_KIND,
  DRUG_GROUP,
  COMPLAINT,
  INSTRUMENTS,
};
