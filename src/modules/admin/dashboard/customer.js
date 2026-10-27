'use strict';

/**
 * Глава обзора «Для программы»: ответы на вопросы заказчика по выбранному диагнозу (сколько пациентов,
 * какие специальности и где работают, чем живут врачи, что назначают и покупают, на какой срок, сколько реально
 * в терапии, когда наступает улучшение, какие побочные эффекты). Источник — готовый отчёт insights
 * (report.js + story.js), в котором малые группы уже скрыты; здесь он только раскладывается по блокам обзора.
 */

const hide = (x, value) => (x.suppressed || value === null || value === undefined ? null : value);
const bars = (title, unit, items, extra = {}) => ({ type: 'bars', title, unit, items, ...extra });

function customerChapter(report) {
  const sec = Object.fromEntries(report.sections.map((s) => [s.key, s]));
  const who = sec.who;
  const clin = sec.clinicians;
  const doc = sec.doctors;
  const rx = sec.prescribed;
  const real = sec.reality;
  const out = sec.outcomes;
  const cost = sec.cost;
  const people = (list, label = (x) => x.label, extra) =>
    list.map((x) => ({
      label: label(x),
      value: hide(x, x.n_patients),
      ...(extra ? { extra: x.suppressed ? undefined : extra(x) } : {}),
    }));
  const doctors = (x) => (x.n_doctors ? `${x.n_doctors} специалистов` : undefined);

  const heading = (text, hint = '') => ({ type: 'heading', text, hint });
  const tiles = {
    type: 'tiles',
    items: [
      { label: 'Пациентов в выборке', value: who.suppressed ? null : who.n_patients },
      {
        label: 'Есть назначение',
        value: hide(rx, rx.n_with_plan),
        hint: rx.share_with_plan === null ? '' : `${rx.share_with_plan}% выборки`,
      },
      {
        label: 'Срок назначения (медиана)',
        value: rx.duration_median_days === null || rx.suppressed ? null : Math.round(rx.duration_median_days),
        unit: 'дн.',
        hint: 'только где срок указан',
      },
      {
        label: 'Сообщили о побочных',
        value: hide(cost, cost.n_reporters),
        hint: cost.share_of_group === null ? '' : `${cost.share_of_group}% выборки`,
      },
    ],
  };
  const diagnoses = bars(
    'Сколько пациентов с каждым диагнозом',
    'чел.',
    report.diagnosis.options.map((o) => ({ label: o.label, value: hide(o, o.n_patients) })),
    { note: 'Диагноз указывает врач; у части пациентов он не указан.', span: 'full' },
  );
  const specialties = bars(
    'Какие специальности ведут пациентов',
    'пациентов',
    people(clin.specialties, (x) => x.label, doctors),
  );
  const orgKinds = bars(
    'Где ведут: тип организации',
    'пациентов',
    people(clin.org_kinds, (x) => x.label, doctors),
  );
  const regions = bars(
    'Где ведут: регионы',
    'пациентов',
    people(clin.regions, (x) => x.label, doctors),
  );
  const orgs = bars(
    'Где ведут: организации',
    'пациентов',
    people(clin.organizations.slice(0, 8), (x) => x.label, doctors),
  );
  const journals = bars(
    'Какие журналы читают врачи',
    'специалистов',
    doc.journals.map((j) => ({ label: j.title, value: doc.suppressed ? null : j.n_doctors })),
    { note: 'Только врачи, заполнившие профиль и разрешившие его использовать.' },
  );
  const conferences = bars(
    'На какие конференции ездят',
    'специалистов',
    doc.conferences.map((j) => ({ label: j.title, value: doc.suppressed ? null : j.n_doctors })),
  );
  const byGroup = bars('Какие группы препаратов назначают', 'пациентов', people(rx.by_group));
  const byInn = bars('Что чаще назначают', 'пациентов', people(rx.by_inn.slice(0, 8)));
  const bought = bars(
    'Что покупают',
    'пациентов',
    real.purchases.slice(0, 8).map((p) => ({
      label: p.label,
      value: hide(p, p.n_patients),
      extra:
        p.suppressed || p.share_of_prescribed === null
          ? undefined
          : `${p.share_of_prescribed}% от получивших назначение`,
    })),
    { note: 'Отметки покупки в приложении; сама аптека не фиксируется.' },
  );
  const duration = bars(
    'На какой срок назначают',
    'назначений',
    rx.duration.map((d) => ({ label: d.label, value: hide(d, d.n) })),
  );
  const funnel = {
    type: 'funnel',
    title: 'От назначения до реальной терапии',
    steps: real.funnel.map((f) => ({ key: f.key, label: f.label, value: hide(f, f.n_patients) })),
    note: 'Нет отметки приёма — не значит, что человек не принимает лекарство.',
  };
  const adherence = bars(
    'Как часто отмечают приём',
    'пациентов',
    real.adherence.map((a) => ({ label: a.label, value: hide(a, a.n_patients) })),
  );
  const curves = out.measures
    .filter((m) => !out.suppressed && !m.suppressed && m.curve)
    .map((m) => ({
      type: 'series',
      title: `Когда наступает улучшение: ${m.label}`,
      unit: '% достигли улучшения',
      domain: [0, 100],
      points: m.curve.map((c) => ({ label: `${c.day} дн.`, value: c.share })),
      note: `${m.cut_text}. ${m.n_patients} пациентов в расчёте; ${m.median_reached ? `половина улучшается примерно за ${Math.round(m.median_days)} дн.` : 'половина пока не достигла улучшения'}. Это динамика баллов, а не оценка лечения.`,
    }));
  const complaints = bars('Какие побочные эффекты называют', 'пациентов', people(cost.complaints));
  const severity = bars(
    'Насколько они мешают',
    'сообщений',
    cost.severity.map((s) => ({ label: s.label, value: hide(s, s.n_reports) })),
  );

  // Порядок — рассказ: кто пациенты → кто и где их ведёт → чем живут врачи → что назначают и покупают →
  // что реально происходит → когда лучше → какова цена. Рядом стоят карточки одной темы.
  const blocks = [
    tiles,
    heading('Кто эти пациенты'),
    diagnoses,
    heading('Кто и где их ведёт', 'специальность, тип места работы, регион и конкретные организации'),
    specialties,
    orgKinds,
    regions,
    orgs,
    heading('Чем живут врачи', 'профиль заполняют не все — цифры только по тем, кто разрешил'),
    journals,
    conferences,
    heading('Что назначают и что покупают'),
    byInn,
    bought,
    byGroup,
    duration,
    heading('Что реально происходит'),
    funnel,
    adherence,
    ...(curves.length ? [heading('Когда наступает улучшение'), ...curves] : []),
    heading('Какова цена', 'сообщения пациентов; причина не проверялась'),
    complaints,
    severity,
  ];

  return {
    key: 'program',
    title: 'Диагноз, врачи, лекарства, результат',
    kicker: 'Для программы',
    headline: report.summary?.length ? report.summary.join(' ') : who.headline,
    blocks,
    dx: {
      selected: report.diagnosis.selected.code,
      options: [
        { code: 'all', label: 'Все диагнозы' },
        ...report.diagnosis.options.map((o) => ({ code: o.code, label: o.label })),
      ],
    },
    link: '/admin?tab=analytics',
  };
}

module.exports = { customerChapter };
