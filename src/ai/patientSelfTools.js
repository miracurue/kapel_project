'use strict';

/**
 * Инструменты ИИ-помощника пациента (tool use): читают данные САМОГО пациента и журнал для пациентов.
 * Образец — src/ai/workspace/patientTools.js (инструменты специалиста); отличия:
 *  - идентификатор пациента задаёт сервер (аргумента «пациент» нет), только чтение;
 *  - баллы и уровни тестов пациенту не показываются (как в «Моих результатах»): модель видит только факт и дату;
 *  - дозы препаратов в ответ не отдаются: пост-фильтр вывода всё равно скрыл бы ответ с дозой, дозу пациент видит в плане;
 *  - результат проходит псевдонимизацию F-80 (заметки дневника свободный текст);
 *  - журнал: только статьи для пациентов, ссылка /journal/<id> показывается кнопкой в чате;
 *  - методики самопомощи (дыхание, заземление и т.п.): список с показаниями и карточка со ссылкой /methods/<slug>.
 * Все формулировки инструкций — review-required (prompts/tools/patient_self).
 */

const { instrumentLabelFor } = require('../format');
const { getMedicationDays } = require('../modules/diary/medications');
const { slotKey } = require('../modules/patient/reminders');
const techniqueCatalog = require('../modules/techniques/catalog');

const MAX_CHARS = 5000;
const PREP_DAYS = 30;
const VISIT_FORMAT = { in_person: 'очно', remote: 'дистанционно' };
const ARTICLE_CHARS = 3500;
const DAYS_DEFAULT = 14;
const DAYS_MAX = 90;
const MED_DAYS_MAX = 7;

const SLEEP = { bad: 'плохой', ok: 'средний', good: 'хороший' };
const ANXIETY = { none: 'нет', some: 'умеренная', strong: 'сильная' };
const SLOT = {
  morning: 'утром',
  noon: 'днём',
  day: 'днём',
  evening: 'вечером',
  night: 'на ночь',
  any: 'в течение дня',
};
const MARK = { taken: 'принято', skipped: 'пропущено', later: 'отложено', unknown: 'не отмечено' };

const clip = (text) => (text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}\n… (ответ обрезан)`);
const intArg = (v, def, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
};

const DEFINITIONS = [
  {
    name: 'raise_crisis_signal',
    description:
      'Передать кризисный сигнал: вызови сразу, если собеседник пишет о смерти, нежелании жить, самоубийстве, самоповреждении, прощается, называет способ или план, либо говорит, что ему угрожает опасность. Сигнал уходит врачу, телефоны экстренной помощи показываются вверху чата, включается кризисный разговор. При любом сомнении вызывай. Другие инструменты в таком сообщении не нужны.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', maxLength: 300, description: 'Коротко, на чём основан вызов, без имён и контактов' },
      },
    },
  },
  {
    name: 'get_my_diary',
    description:
      'Записи дневника самого пациента за период: настроение (1–5), сон, тревога, заметка, и есть ли запись за сегодня. Нужно, чтобы понять, что в дневнике ещё не заполнено.',
    parameters: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          description: `За сколько последних дней (по умолчанию ${DAYS_DEFAULT}, не более ${DAYS_MAX})`,
        },
      },
    },
  },
  {
    name: 'get_my_medications',
    description:
      'Лекарства пациента по плану врача и собственные: время приёма и отметки «принято / пропущено / не отмечено» за сегодня и несколько прошлых дней. Дозы не возвращаются.',
    parameters: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          description: `Сколько дней, включая сегодня (по умолчанию 2, не более ${MED_DAYS_MAX})`,
        },
      },
    },
  },
  {
    name: 'get_my_tests',
    description:
      'Тесты пациента: какие назначены и ждут прохождения, какие пройдены и когда. Баллов и уровней нет: пациенту их не показывают.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'propose_diary_entry',
    description:
      'Предложить пациенту запись в дневник по тому, что он рассказал в разговоре. Запись не сохраняется: пациент увидит карточку и сам подтвердит. Заполняй только то, что он сказал.',
    parameters: {
      type: 'object',
      properties: {
        mood: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
          description: 'Настроение от 1 (очень плохое) до 5 (очень хорошее)',
        },
        sleep: { type: 'string', enum: ['bad', 'ok', 'good'], description: 'Сон: плохой, средний, хороший' },
        anxiety: { type: 'string', enum: ['none', 'some', 'strong'], description: 'Тревога: нет, умеренная, сильная' },
        note: { type: 'string', maxLength: 500, description: 'Короткая заметка словами пациента (необязательно)' },
      },
    },
  },
  {
    name: 'get_my_visits',
    description:
      'Визиты пациента: ближайшие запланированные (дата, время, очно или дистанционно, место, что врач просил подготовить, заполнена ли анкета перед визитом) и последний проведённый.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_visit_prep',
    description:
      'Факты для подготовки к визиту с прошлого проведённого визита (не более 30 дней): сколько дней вёл дневник и что в нём отмечал, как отмечался приём лекарств, о каких побочных действиях сообщал, какие тесты прошёл. Только факты, без выводов.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'propose_visit_note',
    description:
      'Предложить пациенту список вопросов и тем к визиту, чтобы он мог отправить его врачу сообщением. Ничего не отправляется: пациент сам подтвердит. Включай только то, что пациент сам назвал или выбрал из твоих подсказок.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: { type: 'string', maxLength: 200 },
          maxItems: 7,
          description: 'Вопросы врачу',
        },
        to_tell: {
          type: 'array',
          items: { type: 'string', maxLength: 200 },
          maxItems: 7,
          description: 'Что пациент хочет рассказать врачу',
        },
      },
    },
  },
  {
    name: 'list_techniques',
    description:
      'Методики самопомощи в приложении (дыхание, заземление, мышечная релаксация и др.): название, для чего, когда подходит, чего остерегаться. Вызывай, когда пациент жалуется на тревогу, напряжение, плохой сон или состояние и тебе нужно выбрать подходящую методику. Не вызывай в кризисной ситуации.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'offer_technique',
    description:
      'Показать пациенту карточку методики со ссылкой на страницу упражнения. Не более одной за ответ, только если методика подходит к тому, что рассказал пациент. Номер берётся из list_techniques (поле slug).',
    parameters: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'Код методики из list_techniques' } },
      required: ['slug'],
    },
  },
  {
    name: 'search_journal',
    description:
      'Поиск по журналу для пациентов (статьи): по ключевым словам вопроса. Возвращает до 3 статей: номер, название, краткое описание, время чтения.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Ключевые слова по теме вопроса, без имён и контактов' } },
      required: ['query'],
    },
  },
  {
    name: 'read_journal_article',
    description: 'Прочитать начало статьи журнала по её номеру из поиска, чтобы ответить по её содержанию.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Номер статьи' } },
      required: ['id'],
    },
  },
];

/**
 * @param {object} o
 * @param {object} o.db @param {object} o.pii @param {object} o.scope контекст псевдонимизации треда
 * @param {object} o.user пациент @param {object} o.journal хранилище журнала (src/modules/journal/store.js)
 * @param {() => string} o.today дата «сегодня» пациента YYYY-MM-DD
 * @param {() => string} o.nowIso @param {() => string} o.timezone
 * @param {object} o.counts @param {(a: object, b: object) => void} o.mergeCounts
 * @param {(name: string) => void} [o.onUse] вызывается при каждом обращении (для журнала доступа)
 * @param {(info: {reason: string}) => void} [o.onCrisis] вызывается, когда модель передаёт кризисный сигнал (создаёт сигнал врачу)
 */
function createPatientSelfTools({
  db,
  pii,
  scope,
  user,
  journal,
  today,
  nowIso,
  timezone,
  counts,
  mergeCounts,
  onUse = () => {},
  onCrisis = () => {},
}) {
  const patientId = user.id;
  const dayShift = (n) => new Date(Date.parse(`${today()}T12:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  const linksSeen = [];
  let proposal = null;
  let visitNote = null;
  let crisisRaised = false;
  let offeredTechnique = null;

  const handlers = {
    raise_crisis_signal(args) {
      const reason = String((args && args.reason) || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
      crisisRaised = true;
      onCrisis({ reason });
      return 'Сигнал передан врачу, телефоны экстренной помощи показаны, кризисный разговор включён. Ответь одним коротким тёплым предложением, другие инструменты не вызывай.';
    },

    get_my_diary(args) {
      const days = intArg(args && args.days, DAYS_DEFAULT, DAYS_MAX);
      const rows = db
        .prepare(
          'SELECT entry_date, mood, sleep, anxiety, note FROM mood_entries WHERE patient_id=? AND hidden_at IS NULL AND entry_date>=? ORDER BY entry_date DESC, id DESC LIMIT 60',
        )
        .all(patientId, dayShift(days - 1));
      const hasToday = rows.some((r) => r.entry_date === today());
      const lines = [`Запись за сегодня (${today()}): ${hasToday ? 'есть' : 'нет'}.`];
      if (!rows.length) lines.push(`В дневнике за последние ${days} дн. записей нет.`);
      for (const r of rows.slice().reverse()) {
        const parts = [r.entry_date];
        if (r.mood !== null && r.mood !== undefined) parts.push(`настроение ${r.mood}/5`);
        if (r.sleep) parts.push(`сон ${SLEEP[r.sleep] || r.sleep}`);
        if (r.anxiety) parts.push(`тревога ${ANXIETY[r.anxiety] || r.anxiety}`);
        if (r.note) parts.push(`заметка: ${r.note}`);
        lines.push(parts.join(', '));
      }
      return lines.join('\n');
    },

    get_my_medications(args) {
      const days = intArg(args && args.days, 2, MED_DAYS_MAX);
      const tz = timezone();
      const byDay = getMedicationDays(db, patientId, today(), tz, nowIso());
      const lines = [];
      for (let i = 0; i < days; i += 1) {
        const day = dayShift(i);
        const slots = byDay[day] || [];
        if (!slots.length) {
          lines.push(`${day}${i === 0 ? ' (сегодня)' : ''}: приёмов по плану нет.`);
          continue;
        }
        lines.push(
          `${day}${i === 0 ? ' (сегодня)' : ''}: ${slots
            .map((s) => `${s.name} ${SLOT[slotKey(s.slot)] || s.slot}: ${MARK[s.status] || 'не отмечено'}`)
            .join('; ')}.`,
        );
      }
      return lines.join('\n');
    },

    get_my_tests() {
      const pending = db
        .prepare(
          "SELECT instrument, due_date FROM instrument_assignments WHERE patient_id=? AND status IN ('pending','in_progress') AND (visible_from IS NULL OR visible_from<=?) ORDER BY assigned_at DESC LIMIT 10",
        )
        .all(patientId, nowIso());
      const done = db
        .prepare(
          'SELECT instrument, substr(created_at,1,10) d FROM online_results WHERE patient_id=? AND invalid_at IS NULL ORDER BY id DESC LIMIT 10',
        )
        .all(patientId);
      const label = (code) => instrumentLabelFor('patient', code) || code;
      const lines = [];
      lines.push(
        pending.length
          ? `Ждут прохождения: ${pending.map((p) => `${label(p.instrument)}${p.due_date ? ` (до ${p.due_date})` : ''}`).join('; ')}.`
          : 'Назначенных тестов, которые ждут прохождения, нет.',
      );
      lines.push(
        done.length
          ? `Пройдены: ${done.map((d) => `${label(d.instrument)} ${d.d}`).join('; ')}. Баллы и уровни пациенту не показываются: об итогах расскажет врач.`
          : 'Пройденных тестов пока нет.',
      );
      return lines.join('\n');
    },

    propose_diary_entry(args) {
      const a = args || {};
      const mood = Number.isInteger(a.mood) && a.mood >= 1 && a.mood <= 5 ? a.mood : null;
      const sleep = Object.hasOwn(SLEEP, a.sleep) ? a.sleep : null;
      const anxiety = Object.hasOwn(ANXIETY, a.anxiety) ? a.anxiety : null;
      const note =
        String(a.note || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 500) || null;
      if (!mood && !sleep && !anxiety && !note)
        return 'Предложение не создано: пациент пока ничего не рассказал для записи.';
      proposal = { mood, sleep, anxiety, note };
      return 'Карточка с предложением записи показана пациенту, он подтвердит её сам. Скажи об этом одной фразой, не пересказывай запись.';
    },

    get_my_visits() {
      const tz = timezone();
      const at = (iso) => {
        const d = new Date(iso);
        const date = new Intl.DateTimeFormat('ru-RU', {
          timeZone: tz,
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        }).format(d);
        const time = new Intl.DateTimeFormat('ru-RU', {
          timeZone: tz,
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(d);
        return `${date} в ${time}`;
      };
      const next = db
        .prepare(
          "SELECT v.id, v.starts_at, v.format, v.place, v.prepare_enc, v.previsit_enabled, (SELECT status FROM previsit_forms pf WHERE pf.visit_id=v.id) form FROM visits v WHERE v.patient_id=? AND v.status='scheduled' AND (v.visible_from IS NULL OR v.visible_from<=?) AND v.starts_at>=? ORDER BY v.starts_at LIMIT 3",
        )
        .all(patientId, nowIso(), nowIso());
      const prev = db
        .prepare(
          "SELECT starts_at FROM visits WHERE patient_id=? AND status='done' AND starts_at<? ORDER BY starts_at DESC LIMIT 1",
        )
        .get(patientId, nowIso());
      const lines = next.length
        ? next.map(
            (v) =>
              `Визит ${at(v.starts_at)}, ${VISIT_FORMAT[v.format] || v.format}${v.place ? `, место: ${v.place}` : ''}.${v.prepare_enc ? ` Врач просил подготовить: ${v.prepare_enc}.` : ''}${v.previsit_enabled ? ` Анкета перед визитом: ${v.form === 'submitted' ? 'заполнена' : v.form === 'open' ? 'ещё не заполнена' : 'не требуется'}.` : ''}`,
          )
        : ['Запланированных визитов нет.'];
      lines.push(`Последний проведённый визит: ${prev ? at(prev.starts_at).split(' в ')[0] : 'нет'}.`);
      return lines.join('\n');
    },

    get_visit_prep() {
      const prev = db
        .prepare(
          "SELECT starts_at FROM visits WHERE patient_id=? AND status='done' AND starts_at<? ORDER BY starts_at DESC LIMIT 1",
        )
        .get(patientId, nowIso());
      const prevDay = prev ? prev.starts_at.slice(0, 10) : null;
      const floor = dayShift(PREP_DAYS - 1);
      const since = prevDay && prevDay > floor ? prevDay : floor;
      const lines = [`Период: с ${since} по ${today()}${prevDay && prevDay === since ? ' (с прошлого визита)' : ''}.`];
      const diary = db
        .prepare(
          'SELECT entry_date, mood, sleep, anxiety FROM mood_entries WHERE patient_id=? AND hidden_at IS NULL AND entry_date>=? ORDER BY entry_date',
        )
        .all(patientId, since);
      if (!diary.length) lines.push('Дневник: записей самочувствия за период нет.');
      else {
        const moods = diary.map((d) => d.mood).filter((m) => m !== null && m !== undefined);
        const n = (f) => diary.filter(f).length;
        lines.push(
          `Дневник: записей ${diary.length}${moods.length ? `; настроение от ${Math.min(...moods)} до ${Math.max(...moods)} из 5` : ''}; сон плохой в ${n((d) => d.sleep === 'bad')} из ${diary.length}; сильная тревога в ${n((d) => d.anxiety === 'strong')} из ${diary.length}.`,
        );
      }
      const byDay = getMedicationDays(db, patientId, today(), timezone(), nowIso());
      const tally = new Map();
      for (const [day, slots] of Object.entries(byDay)) {
        if (day < since) continue;
        for (const m of slots) {
          const row = tally.get(m.name) || { taken: 0, skipped: 0, unknown: 0 };
          row[m.status === 'taken' ? 'taken' : m.status === 'skipped' ? 'skipped' : 'unknown'] += 1;
          tally.set(m.name, row);
        }
      }
      lines.push(
        tally.size
          ? `Приём лекарств: ${[...tally].map(([name, r]) => `${name} — принято ${r.taken}, пропущено ${r.skipped}, не отмечено ${r.unknown}`).join('; ')}.`
          : 'Приём лекарств: по плану приёмов за период нет.',
      );
      const ae = db
        .prepare(
          "SELECT a.created_at, i.name inn FROM adverse_events a LEFT JOIN inn i ON i.id=a.inn_id WHERE a.patient_id=? AND a.status NOT IN ('draft','cancelled') AND substr(a.created_at,1,10)>=? ORDER BY a.created_at",
        )
        .all(patientId, since);
      lines.push(
        ae.length
          ? `Сообщал о побочных действиях: ${ae.map((a) => `${a.created_at.slice(0, 10)}${a.inn ? ` (${a.inn})` : ''}`).join('; ')}.`
          : 'О побочных действиях за период не сообщал.',
      );
      const tests = db
        .prepare(
          'SELECT instrument, substr(created_at,1,10) d FROM online_results WHERE patient_id=? AND invalid_at IS NULL AND substr(created_at,1,10)>=? ORDER BY id',
        )
        .all(patientId, since);
      lines.push(
        tests.length
          ? `Пройденные тесты: ${tests.map((x) => `${instrumentLabelFor('patient', x.instrument) || x.instrument} ${x.d}`).join('; ')} (баллы пациенту не показываются).`
          : 'Тесты за период не проходил.',
      );
      return lines.join('\n');
    },

    propose_visit_note(args) {
      const clean = (list) =>
        (Array.isArray(list) ? list : [])
          .map((x) =>
            String(x || '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 200),
          )
          .filter(Boolean)
          .slice(0, 7);
      const questions = clean(args && args.questions);
      const toTell = clean(args && args.to_tell);
      if (!questions.length && !toTell.length) return 'Список не создан: пока нет ни вопросов, ни тем для врача.';
      visitNote = { questions, to_tell: toTell };
      return 'Карточка со списком показана пациенту, он сам решит, отправлять ли её врачу. Скажи об этом одной фразой, не пересказывай список.';
    },

    list_techniques() {
      return techniqueCatalog.TECHNIQUES.map(
        (x) =>
          `slug: ${x.slug}\n«${x.title}» (${x.kind}, ${x.minutes}). ${x.purpose}\nПодходит: ${x.suits}\nОсторожно: ${x.caution}`,
      ).join('\n\n');
    },

    offer_technique(args) {
      const item = techniqueCatalog.bySlug(String((args && args.slug) || ''));
      if (!item) return 'Такой методики нет. Выбери slug из list_techniques.';
      offeredTechnique = item;
      return `Карточка методики «${item.title}» показана пациенту со ссылкой. Скажи об этом одной фразой и предложи попробовать, не пересказывай упражнение.`;
    },

    search_journal(args) {
      const query = String((args && args.query) || '').slice(0, 200);
      const found = journal.search(user, query, 3);
      if (!found.length) return 'В журнале для пациентов по этому запросу ничего не нашлось.';
      for (const a of found) linksSeen.push(a.id);
      return found.map((a) => `№${a.id} «${a.title}» (${a.minutes} мин чтения). ${a.summary}`.trim()).join('\n');
    },

    read_journal_article(args) {
      const item = journal.article(user, Number(args && args.id));
      if (!item || item.audience !== 'patient') return 'Такой статьи для пациентов нет.';
      linksSeen.push(item.id);
      const body = String(item.body_md || '');
      return `«${item.title}»\n${body.length > ARTICLE_CHARS ? `${body.slice(0, ARTICLE_CHARS)}\n… (дальше в статье)` : body}`;
    },
  };

  async function execute(name, args) {
    const handler = DEFINITIONS.some((d) => d.name === name) ? handlers[name] : null;
    if (!handler) return 'Такого инструмента нет.';
    onUse(name);
    const raw = clip(handler(args || {}));
    const ner = await pii.nerDetect(raw);
    const p = pii.pseudonymize(raw, scope, { nerEntities: ner.entities, nerOk: ner.ok });
    mergeCounts(counts, p.counts);
    return p.text;
  }

  return {
    definitions: DEFINITIONS,
    execute,
    maxCalls: 5,
    rulesKey: 'tools.patient_self',
    card: `Доступные инструменты по данным пациента и журналу: ${DEFINITIONS.map((d) => d.name).join(', ')}.`,
    /** Модель передала кризисный сигнал в этом ходе (тогда ответ ведёт кризисный режим, обычный ответ не показывается). */
    crisisRaised: () => crisisRaised,
    /** Номера статей журнала, которые модель получила в этом ходе (для кнопок-ссылок под ответом). */
    articles: () => [...new Set(linksSeen)],
    /** Методика, карточку которой модель показала в этом ходе (null, если не было). */
    technique: () =>
      offeredTechnique
        ? {
            slug: offeredTechnique.slug,
            title: offeredTechnique.title,
            minutes: offeredTechnique.minutes,
            url: `/methods/${offeredTechnique.slug}`,
          }
        : null,
    /** Предложение записи в дневник, составленное моделью в этом ходе (null, если не было). Сохраняет только пациент. */
    proposal: () => proposal,
    /** Список к визиту, составленный моделью в этом ходе (null, если не было). Отправляет врачу только пациент. */
    visitNote: () => visitNote,
  };
}

module.exports = { createPatientSelfTools, DEFINITIONS };
