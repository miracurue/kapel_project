'use strict';

/**
 * Локальная заглушка ИИ-пространства врача (провайдер local_stub, роль 'clinician').
 * Модель НЕ подключена: ответ собирается из данных сервиса и шаблонов. Сети нет.
 * ВСЕ ТЕКСТЫ — REVIEW-REQUIRED: не диагнозы, не рекомендации лечения, без названий лекарств и доз.
 * Результат всё равно проходит пост-фильтр outputFilter в provider.generate.
 */

const outputFilter = require('../outputFilter');
const scenarios = require('./scenarios');

const HEAD = 'Черновик подготовлен локальной заглушкой (настоящая ИИ-модель не подключена). Проверьте и отредактируйте; решение за врачом.';
const NO_SOURCES = 'Ответ опирается только на данные сервиса: материалы к диалогу не прикреплены.';

const num = (x) => (x === null || x === undefined ? '—' : String(Math.round(x * 10) / 10));
const dmy = (iso) => (iso ? iso.split('-').reverse().join('.') : '—');
const sign = (d) => (d > 0 ? `+${d}` : String(d));

function words(s) {
  return String(s || '').toLowerCase().match(/[a-zа-яё0-9]{4,}/g) || [];
}

/** Лучший фрагмент материала под запрос: окно вокруг первого совпадения слов; иначе начало текста. */
function pickFragment(text, query) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const ws = new Set(words(query));
  let best = 0;
  let bestScore = 0;
  const step = 120;
  for (let i = 0; i < t.length; i += step) {
    const chunk = t.slice(i, i + 240).toLowerCase();
    let sc = 0;
    for (const w of ws) if (chunk.includes(w)) sc++;
    if (sc > bestScore) { bestScore = sc; best = i; }
  }
  const frag = t.slice(best, best + 220).trim();
  return (best > 0 ? '… ' : '') + frag + (best + 220 < t.length ? ' …' : '');
}

function buildSources(materials, query) {
  return (materials || []).slice(0, 5).map((m) => ({
    n: m.seq,
    title: m.name,
    fragment: m.hasText ? pickFragment(m.text, query) : '',
    noText: !m.hasText,
  }));
}

function sourcesBlock(sources) {
  if (!sources.length) return NO_SOURCES;
  const lines = sources.map((s) => {
    if (s.noText) return `[Материал ${s.n}: ${s.title}] — текст не извлечён (изображение или скан), в ответе не использован.`;
    const frag = s.fragment ? `, «${s.fragment.slice(0, 140)}${s.fragment.length > 140 ? '…' : ''}»` : '';
    const line = `[Материал ${s.n}: ${s.title}${frag}]`;
    // фрагмент с названиями лекарств/дозами пост-фильтр отклонил бы весь ответ — в тексте оставляем только ссылку
    return outputFilter.check(line).ok ? line : `[Материал ${s.n}: ${s.title}] — фрагмент не показан в тексте (содержит названия или дозы лечения); откройте его по ссылке ниже.`;
  });
  return ['Материалы, на которые опирается черновик:', ...lines].join('\n');
}

// ---------- блоки по данным пациента ----------

function instrumentLines(f, withDynamics) {
  if (!f.consent) return ['Результаты шкал недоступны: нет клинического согласия пациента.'];
  if (!f.instruments.length) return ['Результатов шкал в сервисе пока нет.'];
  return f.instruments.map((i) => {
    const l = i.last;
    let s = `- ${i.label}: ${l.score ?? '—'}${l.band ? ` (${l.band})` : ''}, ${dmy(l.date)}${l.risk ? ', есть отметка риска' : ''}`;
    if (withDynamics && i.points.length >= 2) {
      const a = i.points[0];
      const b = i.points[i.points.length - 1];
      s += `; за выбранный период ${a.score} → ${b.score} (${sign(b.score - a.score)}), измерений: ${i.points.length}`;
    }
    return s;
  });
}

function diaryLines(f) {
  if (!f.share.diaryScores) return ['Пациент не делится оценками дневника.'];
  if (!f.diary) return ['Оценок дневника за выбранный период нет.'];
  const d = f.diary;
  const out = [`- Записей: ${d.count} (${dmy(d.from)} — ${dmy(d.to)}), средняя оценка ${num(d.avg)} из 10, диапазон ${d.min}–${d.max}.`];
  if (d.avgFirstHalf !== null) out.push(`- Среднее в первой половине периода ${num(d.avgFirstHalf)}, во второй ${num(d.avgSecondHalf)}.`);
  if (f.notes.length) out.push('- Заметки дневника (пациент делится): ' + f.notes.map((n) => `${dmy(n.date)} «${n.text}»`).join('; '));
  else if (!f.share.diaryNotes) out.push('- Заметки дневника пациент не показывает (по умолчанию).');
  return out;
}

function crisisLine(f) {
  return f.crisis.open
    ? `Открытых кризисных эскалаций: ${f.crisis.open} (последняя ${dmy(f.crisis.last)}). Сначала обработайте их в кризисной очереди.`
    : 'Открытых кризисных эскалаций нет.';
}

// ---------- шаблоны сценариев ----------

function summary(ctx) {
  const f = ctx.patient;
  return [
    'Сводка к приёму (по данным сервиса)',
    '',
    'Результаты шкал:', ...instrumentLines(f, false),
    '',
    'Дневник настроения:', ...diaryLines(f),
    '',
    crisisLine(f),
    f.pending.length ? `Назначено, но не пройдено: ${f.pending.join(', ')}.` : 'Непройденных назначений нет.',
    '',
    'Что стоит обсудить (ориентир, проверьте сами):',
    '- динамика баллов и самочувствия с прошлого визита;',
    '- сон, аппетит, энергия, тревога в повседневной жизни;',
    '- что помогало и что мешало между визитами;',
    '- вопросы и ожидания пациента.',
  ].join('\n');
}

function dynamics(ctx) {
  const f = ctx.patient;
  const p = scenarios.period(ctx.periodDays);
  const lines = ['Динамика за период: ' + (p ? p.label : 'всё время наблюдения'), '', 'Шкалы (изменение баллов; интерпретацию определяет врач):'];
  if (!f.consent) lines.push('Результаты шкал недоступны: нет клинического согласия пациента.');
  else {
    let any = false;
    for (const i of f.instruments) {
      if (i.points.length >= 2) {
        any = true;
        const a = i.points[0];
        const b = i.points[i.points.length - 1];
        lines.push(`- ${i.label}: ${a.score} (${dmy(a.date)}) → ${b.score} (${dmy(b.date)}), изменение ${sign(b.score - a.score)}, измерений: ${i.points.length}`);
      } else if (i.points.length === 1) lines.push(`- ${i.label}: одно измерение за период (${i.points[0].score}, ${dmy(i.points[0].date)}) — сравнивать не с чем.`);
    }
    if (!any && !f.instruments.some((i) => i.points.length)) lines.push('За выбранный период результатов нет.');
    lines.push('Важно: у шкал разное направление (для одних рост баллов — ухудшение, для других — улучшение), смотрите описание шкалы.');
  }
  lines.push('', 'Дневник:', ...diaryLines(f), '', crisisLine(f));
  return lines.join('\n');
}

function recommendations(ctx) {
  const f = ctx.patient;
  return [
    '[Черновик для пациента — врач проверяет и правит перед передачей. Текст нейтральный, без лечения.]',
    '',
    'Здравствуйте!',
    'Спасибо, что приходите на приёмы и проходите назначенные опросники. Кратко о том, что мы обсудили и что можно делать до следующей встречи:',
    '- Старайтесь сохранять привычный режим дня: подъём и отход ко сну примерно в одно время.',
    '- Если удобно, отмечайте самочувствие в дневнике настроения — это поможет нам вместе увидеть динамику.',
    f.pending.length ? `- Пройдите назначенные опросники: ${f.pending.join(', ')}.` : '- Новые опросники при необходимости назначит врач.',
    '- Запишите вопросы к следующему приёму.',
    '- Дополнительные рекомендации врача: [впишите по результатам приёма].',
    '',
    'Если самочувствие заметно ухудшится, не откладывайте обращение к врачу. Если опасность прямо сейчас — позвоните 112.',
    '',
    '[Дата следующего приёма: ____]',
  ].join('\n');
}

function referral(ctx) {
  const f = ctx.patient;
  return [
    'ЧЕРНОВИК направления / выписки (шаблон, поля заполняет врач; ФИО и идентификаторы пациента в сервис не вносятся)',
    '',
    'Пациент: [ФИО, дата рождения — заполнить в МИС]',
    'Цель направления / запрос: [впишите]',
    'Краткие сведения из сервиса:', ...instrumentLines(f, false),
    ...diaryLines(f).map((l) => l),
    crisisLine(f),
    '',
    'Анамнез и клиническая картина: [заполняет врач]',
    'Вопросы специалисту: [впишите]',
    'Рекомендации: [заполняет врач]',
    '',
    'Документ — черновик для переноса в МИС. Клинические выводы формулирует врач.',
  ].join('\n');
}

function questions(ctx) {
  const f = ctx.patient;
  const lines = ['Что уточнить на приёме (ориентир, проверьте сами):', '',
    '- Жалобы своими словами: что беспокоит больше всего, с какого времени, что менялось.',
    '- Сон: засыпание, пробуждения, длительность; режим дня.',
    '- Настроение, интерес к привычным занятиям, энергия, концентрация.',
    '- Тревога: ситуации, физические проявления, избегание.',
    '- Функционирование: работа/учёба, отношения, быт.',
    '- Стрессоры и события за последнее время; поддержка близких.',
    '- Алкоголь и другие вещества, соматические состояния и ранее проводившееся лечение — по записям врача.',
    '- Мысли о самоповреждении и суицидальные мысли: уточнить прямо и спокойно, по принятому в организации протоколу.',
    '- Что помогало и что мешало между визитами; ожидания от лечения.'];
  if (f) {
    lines.push('', 'По данным сервиса:');
    if (f.crisis.open) lines.push(`- ${crisisLine(f)}`);
    for (const i of f.instruments) {
      if (i.points.length >= 2) {
        const a = i.points[0];
        const b = i.points[i.points.length - 1];
        if (b.score !== a.score) lines.push(`- ${i.label}: изменение ${sign(b.score - a.score)} (${a.score} → ${b.score}) — уточнить, что за этим стоит.`);
      }
      if (i.last.risk) lines.push(`- ${i.label}: есть отметка риска — обсудить.`);
    }
    if (f.diary && f.diary.min <= 3) lines.push(`- В дневнике были низкие оценки (минимум ${f.diary.min}) — уточнить обстоятельства.`);
    if (f.pending.length) lines.push(`- Не пройдены назначенные опросники: ${f.pending.join(', ')} — выяснить причину.`);
  } else lines.push('', 'Пациент к диалогу не привязан: вопросы общие. Чтобы добавить данные сервиса, привяжите пациента.');
  return lines.join('\n');
}

function hypotheses(ctx) {
  const f = ctx.patient;
  const lines = [
    'Гипотезы для клинической проверки — это НЕ диагноз и не вывод системы. Перечень общий, подтверждение или исключение — только на приёме.',
    '',
    '- Тревожная и депрессивная симптоматика разной природы: оцените выраженность, длительность и связь со стрессорами.',
    '- Реакция на стресс или адаптационные трудности: что изменилось в жизни пациента и когда.',
    '- Влияние сна, режима, нагрузки, алкоголя и других веществ на состояние.',
    '- Соматические причины и состояния, дающие похожие жалобы: по данным обследований, которыми располагает врач.',
    '- Эпизоды повышенного настроения или сниженной потребности во сне в прошлом — уточнить в анамнезе.',
    '- Когнитивные жалобы: проверить, не связаны ли они с тревогой, утомлением или сном.',
  ];
  if (f) {
    lines.push('', 'Что из данных сервиса стоит учесть:');
    lines.push(...instrumentLines(f, false), crisisLine(f));
  }
  lines.push('', 'Формулировки — review-required (клиническое ревью); автоматической постановки диагноза в сервисе нет.');
  return lines.join('\n');
}

function retest(ctx) {
  const f = ctx.patient;
  const lines = ['План повторного тестирования (ориентир; интервалы review-required, определяет врач):', ''];
  if (!f.consent) lines.push('Результаты шкал недоступны: нет клинического согласия пациента.');
  else if (!f.instruments.length) lines.push('Результатов в сервисе нет: начните с базовой оценки — выберите подходящие шкалы в карточке пациента.');
  else {
    for (const i of f.instruments) {
      const days = Math.max(0, Math.floor((Date.now() - new Date(i.last.date + 'T00:00:00Z').getTime()) / 86400000));
      lines.push(`- ${i.label}: последний результат ${dmy(i.last.date)} (${days} дн. назад). Повторить ориентировочно через 2–4 недели после предыдущего измерения${days >= 28 ? ' — срок уже подошёл' : ''}.`);
    }
  }
  if (f.pending.length) lines.push('', `Уже назначено и ждёт прохождения: ${f.pending.join(', ')}.`);
  lines.push('', 'Назначить шкалы можно в карточке пациента; сервис ничего не назначает сам.');
  if (f.crisis.open) lines.push('', crisisLine(f));
  return lines.join('\n');
}

const TEMPLATES = { summary, dynamics, recommendations, referral, questions, hypotheses, retest };

function freeText(ctx, query) {
  const lines = ['Это заглушка: ИИ-модель не подключена, свободный запрос не анализируется.', 'Что доступно сейчас: сценарии-кнопки над полем ввода (сводка, динамика, рекомендации, направление, вопросы, гипотезы, повторное тестирование) и работа с вашими материалами.'];
  if (ctx.patient) lines.push('', `К диалогу привязан пациент: в сценариях используются данные сервиса (шкалы: ${ctx.patient.instruments.length}, дневник: ${ctx.patient.diary ? 'есть' : 'нет'}).`);
  void query;
  return lines.join('\n');
}

async function generate({ messages, context }) {
  const ctx = context || {};
  const lastUser = [...(messages || [])].reverse().find((m) => m.role === 'user');
  const query = lastUser ? lastUser.text : '';
  const sc = ctx.scenario ? scenarios.get(ctx.scenario) : null;
  const sources = buildSources(ctx.materials, query);
  let body;
  if (sc && TEMPLATES[sc.key] && (ctx.patient || !sc.needsPatient)) {
    body = TEMPLATES[sc.key](ctx);
  } else body = freeText(ctx, query);
  const text = [HEAD, '', body, '', sourcesBlock(sources)].join('\n');
  return { text, sources, flags: { provider: 'local_stub', topic: sc ? sc.key : 'clinician_free' } };
}

module.exports = { generate, pickFragment, HEAD, NO_SOURCES };
