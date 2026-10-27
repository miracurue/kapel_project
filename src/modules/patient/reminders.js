'use strict';

/**
 * Напоминания пациенту внутри системы (решение владелицы 2026-10-26: пока без пушей и внешних каналов).
 * Строятся кодом по плану лечения, отметкам приёма и назначенным тестам; ИИ в этом не участвует.
 * Показываются карточками наверху чата (views/pages/app/chat.ejs, public/js/patient_reminders.js).
 *
 * Визит: за 72 часа до начала предлагаем подготовиться (список вопросов в чате, отправка врачу по кнопке).
 * Дневник: со своего времени из дневника («Напоминание» в рабочем пространстве, по умолчанию 19:00 каждый день), если
 * за сегодня в нём ничего нет; режимы «выключено» и «пауза» молчат, «по будням» и «через день» учитываются.
 * Приём: со времени из личных напоминаний пациента (таблица reminders, «Уведомления» в аккаунте); выключенное напоминание,
 * неподходящий день недели и «отложить» (snooze_until) молчат. Если личного времени нет, берётся время слота по умолчанию.
 * Время приёма по умолчанию (review-required): утро с 8:00, день с 13:00, вечер с 19:00, на ночь с 22:00, без времени с 9:00.
 */

const { getMedicationDays } = require('../diary/medications');

// С этого часа (по времени пациента) напоминаем о пустом дневнике за сегодня; review-required.
const DIARY_FROM_HOUR = 19;
// За сколько часов до визита предлагаем подготовиться; review-required.
const VISIT_PREP_HOURS = 72;
const SLOT_FROM_HOUR = { morning: 8, noon: 13, evening: 19, night: 22, any: 9 };
// В плане время приёма хранится словами («утро», «день», «вечер», «на ночь»); в журнале встречаются и английские ключи.
const SLOT_KEY = { утро: 'morning', день: 'noon', вечер: 'evening', 'на ночь': 'night', ночь: 'night', day: 'noon' };
const slotKey = (slot) => SLOT_KEY[slot] || (SLOT_FROM_HOUR[slot] !== undefined ? slot : 'any');

const WEEKDAY = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const toMinutes = (hhmm) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

function localParts(date, timezone) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date);
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(date)
    .split(':');
  const hour = Number(clock[0]);
  const minute = Number(clock[1]);
  const weekday = WEEKDAY[new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(date)];
  return {
    day,
    hour,
    minute,
    minutes: hour * 60 + minute,
    weekday,
    epochDay: Math.floor(Date.parse(`${day}T00:00:00Z`) / 86400000),
  };
}

/**
 * Время приёма: личные напоминания пациента (reminders, kind='med') ставятся на ближайшие по времени слоты того же
 * препарата. Возвращает Map «тип:id|слот» -> { from: минуты | null }; null — напоминать сегодня не нужно.
 */
function ownMedTimes(db, patientId, rows, now, local) {
  const reminders = db
    .prepare(
      "SELECT plan_item_id, patient_med_id, time_hhmm, days_mask, snooze_until, active FROM reminders WHERE patient_id=? AND kind='med'",
    )
    .all(patientId);
  const result = new Map();
  const targets = new Map();
  for (const r of rows) {
    const id = `${r.target.type}:${r.target.id}`;
    if (!targets.has(id)) targets.set(id, { target: r.target, slots: new Set() });
    targets.get(id).slots.add(r.slot);
  }
  for (const [id, { target, slots }] of targets) {
    const mine = reminders
      .filter((x) => (target.type === 'plan_item' ? x.plan_item_id === target.id : x.patient_med_id === target.id))
      .map((x) => ({ ...x, at: toMinutes(x.time_hhmm) }))
      .filter((x) => x.at !== null)
      .sort((a, b) => a.at - b.at);
    const free = new Set(slots);
    for (const rem of mine) {
      let best = null;
      for (const slot of free) {
        const d = Math.abs(SLOT_FROM_HOUR[slotKey(slot)] * 60 - rem.at);
        if (best === null || d < best.d) best = { slot, d };
      }
      if (!best) break;
      free.delete(best.slot);
      const silent =
        !rem.active ||
        !(Number(rem.days_mask) & (1 << local.weekday)) ||
        (rem.snooze_until && Date.parse(rem.snooze_until) > now.getTime());
      result.set(`${id}|${best.slot}`, { from: silent ? null : rem.at });
    }
  }
  return result;
}

/** Время напоминания о дневнике из рабочего пространства дневника; null — сегодня не напоминать. */
function diaryFrom(db, patientId, local) {
  let reminder = { frequency: 'daily', time: '19:00' };
  try {
    const row = db.prepare('SELECT state_json FROM diary_workspaces WHERE patient_id=?').get(patientId);
    const saved = row && JSON.parse(row.state_json).reminder;
    if (saved && typeof saved === 'object') reminder = { ...reminder, ...saved };
  } catch (_) {
    /* битое состояние: значения по умолчанию */
  }
  if (['off', 'paused'].includes(reminder.frequency)) return null;
  if (reminder.frequency === 'weekdays' && local.weekday > 4) return null;
  if (reminder.frequency === 'alternate' && local.epochDay % 2 !== 0) return null;
  return toMinutes(reminder.time) ?? DIARY_FROM_HOUR * 60;
}

/**
 * @returns {Array<{kind: 'visit', id: number, when: string, format: string} | {kind: 'diary', day: string} | {kind: 'profile', field: string} | {kind: 'medication', slot: string, day: string, names: string[], targets: object[]} | {kind: 'test', names: string[]}>}
 */
function dueReminders(db, { patientId, now = new Date(), timezone = 'Europe/Moscow', labelOf = (code) => code }) {
  const local = localParts(now, timezone);
  const { day } = local;
  const out = [];
  const pending = (getMedicationDays(db, patientId, day, timezone, now.toISOString())[day] || []).filter(
    (r) => r.status === 'unknown' || r.status === 'later',
  );
  const own = ownMedTimes(db, patientId, pending, now, local);
  const rows = pending.filter((r) => {
    const mine = own.get(`${r.target.type}:${r.target.id}|${r.slot}`);
    const from = mine ? mine.from : SLOT_FROM_HOUR[slotKey(r.slot)] * 60;
    return from !== null && local.minutes >= from;
  });
  const bySlot = new Map();
  for (const r of rows) {
    if (!bySlot.has(r.slot))
      bySlot.set(r.slot, { kind: 'medication', slot: r.slot, slotKey: slotKey(r.slot), day, names: [], targets: [] });
    const group = bySlot.get(r.slot);
    group.names.push(r.name);
    group.targets.push(r.target);
  }
  out.push(...bySlot.values());
  const tests = db
    .prepare(
      "SELECT instrument FROM instrument_assignments WHERE patient_id=? AND status IN ('pending','in_progress') AND (visible_from IS NULL OR visible_from<=?) ORDER BY assigned_at DESC LIMIT 5",
    )
    .all(patientId, now.toISOString());
  // Дневник «заполнен», если за сегодня есть запись самочувствия, значение привычки или заметка дня.
  const diaryAt = diaryFrom(db, patientId, local);
  if (diaryAt !== null && local.minutes >= diaryAt) {
    const filled = db
      .prepare(
        `SELECT 1 FROM mood_entries WHERE patient_id=? AND hidden_at IS NULL AND entry_date=?
         UNION ALL SELECT 1 FROM diary_habit_values WHERE patient_id=? AND hidden_at IS NULL AND day=?
         UNION ALL SELECT 1 FROM diary_day_notes WHERE patient_id=? AND day=? AND text<>'' LIMIT 1`,
      )
      .get(patientId, day, patientId, day, patientId, day);
    if (!filled) out.push({ kind: 'diary', day });
  }
  // Ближайший визит в пределах VISIT_PREP_HOURS: предложение подготовиться с помощником.
  const visit = db
    .prepare(
      "SELECT id, starts_at, format FROM visits WHERE patient_id=? AND status='scheduled' AND (visible_from IS NULL OR visible_from<=?) AND starts_at>=? AND starts_at<=? ORDER BY starts_at LIMIT 1",
    )
    .get(
      patientId,
      now.toISOString(),
      now.toISOString(),
      new Date(now.getTime() + VISIT_PREP_HOURS * 3600000).toISOString(),
    );
  if (visit) {
    const at = new Date(visit.starts_at);
    const date = new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, day: '2-digit', month: '2-digit' }).format(at);
    const time = new Intl.DateTimeFormat('ru-RU', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(at);
    out.push({ kind: 'visit', id: visit.id, when: `${date} в ${time}`, format: visit.format });
  }
  const prefs = db.prepare('SELECT address_form_set FROM user_prefs WHERE user_id=?').get(patientId);
  // Один раз спрашиваем форму обращения (для форм рода в ответах помощника и тёплых фраз); ответ «нейтрально» тоже ответ.
  if (prefs && !prefs.address_form_set) out.push({ kind: 'profile', field: 'address_form' });
  if (tests.length) out.push({ kind: 'test', names: tests.map((x) => labelOf(x.instrument)) });
  return out;
}

module.exports = { dueReminders, localParts, slotKey, SLOT_FROM_HOUR, DIARY_FROM_HOUR, VISIT_PREP_HOURS };
