'use strict';

// Рассказ по отчёту: заголовок-вывод каждого раздела и краткое резюме. Тексты собираются из уже подавленных
// данных отчёта, поэтому скрытые числа в них попасть не могут. Тон осторожный: «по предварительным данным»,
// без причинных слов и рекомендаций (decision-support; формулировки — review-required).

const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
const people = (n) => `${n} ${plural(n, 'пациент', 'пациента', 'пациентов')}`;
const doctors = (n) => `${n} ${plural(n, 'специалист', 'специалиста', 'специалистов')}`;
const low = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const PRELIM = 'предварительно';
const NOT_ENOUGH = 'Данных недостаточно: в группе слишком мало человек, цифры скрыты, чтобы никого нельзя было узнать.';
const NOT_ENOUGH_OWN = 'Пока нечего показывать: нет подходящих данных по вашим пациентам.';

function narrate(report) {
  const own = report.scope === 'own';
  const none = own ? NOT_ENOUGH_OWN : NOT_ENOUGH;
  const get = (key) => report.sections.find((s) => s.key === key);
  const facts = [];
  const dx = report.diagnosis.selected.code === 'all' ? '' : `, диагноз «${report.diagnosis.selected.label}»`;

  for (const s of report.sections) {
    s.status = s.suppressed ? 'hidden' : s.low_n ? 'low' : 'ok';
    switch (s.key) {
      case 'who': {
        if (s.suppressed) s.headline = none;
        else {
          s.headline = `${own ? 'У вас' : 'В выборке'} ${people(s.n_patients)}${dx}; ниже — как они пришли в наблюдение по месяцам (${PRELIM}).`;
          facts.push(`${people(s.n_patients)}${dx}.`);
        }
        break;
      }
      case 'clinicians': {
        const top = s.specialties.find((x) => !x.suppressed);
        const region = s.regions.find((x) => !x.suppressed);
        if (s.suppressed || !top) s.headline = none;
        else {
          s.headline = `Чаще всего их ведут: ${low(top.label)} (${people(top.n_patients)}, ${doctors(top.n_doctors)})${region ? `; больше всего пациентов в регионе «${region.label}»` : ''}.`;
          facts.push(`Чаще всего пациентов ведёт специальность «${low(top.label)}».`);
        }
        break;
      }
      case 'doctors': {
        const j = s.journals[0];
        const c = s.conferences[0];
        if (s.suppressed || (!j && !c))
          s.headline = 'Профили специалистов заполнены слишком редко, чтобы делать выводы о журналах и конференциях.';
        else
          s.headline = `Среди специалистов, заполнивших профиль, чаще всего называют ${j ? `журнал «${j.title}»` : ''}${j && c ? ' и ' : ''}${c ? `конференцию «${c.title}»` : ''} (${PRELIM}).`;
        break;
      }
      case 'prescribed': {
        const top = s.by_inn.find((x) => !x.suppressed);
        if (s.suppressed || !top) s.headline = none;
        else {
          const term =
            s.duration_median_days !== null
              ? `; срок, если указан, в среднем около ${Math.round(s.duration_median_days)} дн. (медиана)`
              : '; срок чаще не указан';
          s.headline = `Назначение есть у ${s.share_with_plan === null ? people(s.n_with_plan) : `${s.share_with_plan}% пациентов`}; чаще других — ${top.label} (${people(top.n_patients)})${term}.`;
          facts.push(
            `Чаще всего назначают ${top.label}${s.duration_median_days !== null ? `, медианный срок около ${Math.round(s.duration_median_days)} дней` : ''}.`,
          );
        }
        break;
      }
      case 'reality': {
        const f = Object.fromEntries(s.funnel.map((x) => [x.key, x]));
        if (s.suppressed) s.headline = none;
        else {
          const bought = f.bought.share !== null ? `${f.bought.share}% отметили покупку` : 'покупки отмечены редко';
          const taking =
            f.taking.share !== null ? `${f.taking.share}% отмечали приём за две недели` : 'отметки приёма редки';
          s.headline = `Из тех, кому назначено: ${bought}, ${taking}. Нет отметки — не значит, что человек не принимает (${PRELIM}).`;
          if (f.taking.share !== null)
            facts.push(`Приём отмечают ${f.taking.share}% пациентов с назначением (отметка — не факт приёма).`);
        }
        break;
      }
      case 'outcomes': {
        const m = s.measures.find((x) => !x.suppressed);
        if (s.suppressed || !m) s.headline = none;
        else {
          const med = m.median_reached
            ? `половина улучшается примерно за ${m.median_days} дн.`
            : 'медиана времени до улучшения пока не достигнута';
          s.headline = `${m.label}: улучшение достигли ${m.share_improved}% из ${people(m.n_patients)}; ${med} (${PRELIM}, не оценка лечения).`;
          facts.push(
            `${m.label}: улучшение у ${m.share_improved}% пациентов${m.median_reached ? `, медиана ${m.median_days} дней` : ''}.`,
          );
        }
        break;
      }
      case 'cost': {
        const top = s.complaints.find((x) => !x.suppressed);
        if (s.suppressed)
          s.headline = own
            ? 'За период сообщений о побочных эффектах нет или их слишком мало для сводки.'
            : 'Сообщений о побочных эффектах слишком мало, чтобы показывать подробности.';
        else {
          const share = s.share_of_prescribed ?? s.share_of_group;
          s.headline = `О побочных эффектах сообщили ${people(s.n_reporters)}${share !== null ? ` (${share}%)` : ''}${top ? `, чаще всего — «${low(top.label)}»` : ''}. Это сообщения, причина не проверялась.`;
          facts.push(
            `О побочных эффектах сообщили ${people(s.n_reporters)}${top ? `, чаще — «${low(top.label)}»` : ''}.`,
          );
        }
        break;
      }
      default:
    }
  }
  report.summary = facts.slice(0, 5);
  report.disclaimer =
    'Предварительные данные для обсуждения. Определения и пороги ещё не утверждены клиническим владельцем. Это не оценка лечения и не рекомендация.';
  return report;
}

module.exports = { narrate, plural };
