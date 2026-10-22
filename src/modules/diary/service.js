'use strict';

const { isDeepStrictEqual } = require('node:util');
const storage = require('./storage');

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const canonicalWellbeing = (v) =>
  Object.fromEntries(['mood', 'anxiety', 'sleepQuality', 'sleepHours'].map((key) => [key, v?.[key] ?? null]));
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const empty = () => ({
  habits: [],
  entries: {},
  wellbeings: {},
  dayNotes: [],
  reminder: { frequency: 'daily', time: '19:00' },
});
function strings(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(strings);
}
function validDay(day) {
  return (
    dayPattern.test(day) &&
    Number.isFinite(Date.parse(`${day}T00:00:00Z`)) &&
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day
  );
}
function validValue(h, v) {
  if (h.type === 'check') return v === true || v === false || v === 0 || v === 1;
  if (h.type === 'note') return typeof v === 'string';
  if (h.type === 'choice') return Number.isInteger(v) && v >= 1 && v <= (h.choices?.length || 0);
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  if (['count', 'scale', 'time'].includes(h.type) && !Number.isInteger(v)) return false;
  if (['count', 'duration'].includes(h.type) && v < 0) return false;
  if (h.type === 'time' && (v < 0 || v > 1439)) return false;
  return (h.minimum === undefined || v >= h.minimum) && (h.maximum === undefined || v <= h.maximum);
}
function normalize(raw) {
  if (!object(raw) || JSON.stringify(raw).length > 900000) throw new Error('validation');
  if (
    !Array.isArray(raw.habits) ||
    raw.habits.length > 100 ||
    !object(raw.entries) ||
    !object(raw.wellbeings) ||
    !Array.isArray(raw.dayNotes) ||
    raw.dayNotes.length > 5000 ||
    !object(raw.reminder)
  )
    throw new Error('validation');
  const state = JSON.parse(JSON.stringify(raw));
  const ids = new Set();
  for (const h of state.habits) {
    if (
      !object(h) ||
      typeof h.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(h.id) ||
      ['__proto__', 'constructor', 'prototype', 'mood', 'anxiety', 'quality', 'sleep', 'med'].includes(h.id) ||
      ids.has(h.id) ||
      typeof h.name !== 'string' ||
      h.name.length > 200 ||
      typeof h.shared !== 'boolean' ||
      !['check', 'count', 'duration', 'measure', 'scale', 'time', 'choice', 'note'].includes(h.type) ||
      'values' in h ||
      'logs' in h ||
      h.id === 'med'
    )
      throw new Error('validation');
    for (const key of ['color', 'tint'])
      if (h[key] !== undefined && !/^#[a-f0-9]{3,8}$/i.test(h[key])) throw new Error('validation');
    for (const key of ['icon', 'unit', 'plan'])
      if (h[key] !== undefined && (typeof h[key] !== 'string' || h[key].length > 500)) throw new Error('validation');
    if (
      h.choices !== undefined &&
      (!Array.isArray(h.choices) ||
        h.choices.length > 100 ||
        h.choices.some((v) => typeof v !== 'string' || v.length > 200))
    )
      throw new Error('validation');
    for (const key of ['minimum', 'maximum', 'target', 'interval', 'startIndex'])
      if (h[key] !== undefined && h[key] !== null && (typeof h[key] !== 'number' || !Number.isFinite(h[key])))
        throw new Error('validation');
    if (h.minimum !== undefined && h.maximum !== undefined && h.minimum > h.maximum) throw new Error('validation');
    if (h.goal !== undefined && !['none', 'min', 'max', 'exact', 'range'].includes(h.goal))
      throw new Error('validation');
    if (
      h.aggregation !== undefined &&
      !['sum', 'mean', 'average', 'last', 'max', 'min', 'count', 'any', 'notes'].includes(h.aggregation)
    )
      throw new Error('validation');
    if (
      h.schedule !== undefined &&
      !['daily', 'free', 'interval', 'weekdays', 'alternate', 'custom'].includes(h.schedule)
    )
      throw new Error('validation');
    if (h.schedule === 'interval' && (!Number.isInteger(h.interval) || h.interval < 1 || h.interval > 365))
      throw new Error('validation');
    if (
      h.schedule === 'weekdays' &&
      (!Array.isArray(h.weekdays) ||
        !h.weekdays.length ||
        h.weekdays.some((v) => !Number.isInteger(v) || v < 0 || v > 6))
    )
      throw new Error('validation');
    if (
      h.range !== undefined &&
      h.range !== null &&
      (!Array.isArray(h.range) ||
        h.range.length !== 2 ||
        h.range.some((v) => typeof v !== 'number' || !Number.isFinite(v)))
    )
      throw new Error('validation');
    ids.add(h.id);
  }
  for (const [id, dates] of Object.entries(state.entries)) {
    const habit = state.habits.find((h) => h.id === id);
    if (!ids.has(id) || !object(dates)) throw new Error('validation');
    for (const [day, values] of Object.entries(dates))
      if (
        !validDay(day) ||
        !Array.isArray(values) ||
        values.length > 100 ||
        values.some(
          (v) =>
            !['number', 'string', 'boolean'].includes(typeof v) ||
            (typeof v === 'number' && !Number.isFinite(v)) ||
            (typeof v === 'string' && v.length > 2000),
        )
      )
        throw new Error('validation');
    for (const values of Object.values(dates))
      for (const value of values) if (!validValue(habit, value)) throw new Error('validation');
  }
  for (const [day, w] of Object.entries(state.wellbeings)) {
    if (!validDay(day) || !object(w)) throw new Error('validation');
    for (const [k, v] of Object.entries(w)) {
      const limits = { mood: [1, 5], anxiety: [0, 2], sleepQuality: [1, 3], sleepHours: [0, 24] }[k];
      if (
        !limits ||
        (v !== null &&
          (typeof v !== 'number' ||
            !Number.isFinite(v) ||
            v < limits[0] ||
            v > limits[1] ||
            (k !== 'sleepHours' && !Number.isInteger(v))))
      )
        throw new Error('validation');
    }
  }
  const notes = new Set();
  for (const n of state.dayNotes) {
    if (
      !object(n) ||
      typeof n.id !== 'string' ||
      n.id.length > 100 ||
      notes.has(n.id) ||
      !validDay(n.day) ||
      typeof n.text !== 'string' ||
      n.text.length > 2000 ||
      typeof n.shared !== 'boolean'
    )
      throw new Error('validation');
    notes.add(n.id);
  }
  if (
    !['daily', 'alternate', 'weekdays', 'paused', 'off'].includes(state.reminder.frequency) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(state.reminder.time)
  )
    throw new Error('validation');
  return state;
}
function windowState(state, from, to) {
  const inRange = (day) => day >= from && day <= to;
  return {
    ...state,
    entries: Object.fromEntries(
      Object.entries(state.entries).map(([id, dates]) => [
        id,
        Object.fromEntries(Object.entries(dates).filter(([day]) => inRange(day))),
      ]),
    ),
    wellbeings: Object.fromEntries(Object.entries(state.wellbeings).filter(([day]) => inRange(day))),
    dayNotes: state.dayNotes.filter((n) => inRange(n.day)),
  };
}
function mergeWindow(before, incoming, from, to) {
  const inside = (day) => day >= from && day <= to;
  for (const day of Object.keys(incoming.wellbeings)) if (!inside(day)) throw new Error('validation');
  for (const dates of Object.values(incoming.entries))
    for (const day of Object.keys(dates)) if (!inside(day)) throw new Error('validation');
  if (incoming.dayNotes.some((n) => !inside(n.day))) throw new Error('validation');
  const merged = {
    ...incoming,
    entries: {},
    wellbeings: {
      ...Object.fromEntries(Object.entries(before.wellbeings).filter(([day]) => !inside(day))),
      ...incoming.wellbeings,
    },
    dayNotes: [...before.dayNotes.filter((n) => !inside(n.day)), ...incoming.dayNotes],
  };
  for (const h of incoming.habits)
    merged.entries[h.id] = {
      ...Object.fromEntries(Object.entries(before.entries[h.id] || {}).filter(([day]) => !inside(day))),
      ...(incoming.entries[h.id] || {}),
    };
  return merged;
}
function create(db) {
  function read(patientId) {
    const row = db.prepare('SELECT revision,state_json FROM diary_workspaces WHERE patient_id=?').get(patientId);
    const state = {
      ...empty(),
      ...(row ? JSON.parse(row.state_json) : {}),
      ...storage.load(db, patientId),
      wellbeings: {},
    };
    const prefs = db.prepare('SELECT share_diary_notes FROM user_prefs WHERE user_id=?').get(patientId);
    const latest = db
      .prepare(
        'SELECT * FROM mood_entries m WHERE patient_id=? AND hidden_at IS NULL AND id=(SELECT MAX(x.id) FROM mood_entries x WHERE x.patient_id=m.patient_id AND x.entry_date=m.entry_date AND x.hidden_at IS NULL) ORDER BY entry_date,id',
      )
      .all(patientId);
    for (const m of latest) {
      state.wellbeings[m.entry_date] = {
        mood: m.mood ?? null,
        anxiety: { none: 0, some: 1, strong: 2 }[m.anxiety] ?? null,
        sleepQuality: { bad: 1, ok: 2, good: 3 }[m.sleep] ?? null,
        sleepHours: m.legacy_sleep_hours ?? null,
      };
    }
    const notes = db
      .prepare(
        'SELECT id,entry_date,note FROM mood_entries WHERE patient_id=? AND hidden_at IS NULL AND note IS NOT NULL ORDER BY id',
      )
      .all(patientId);
    const legacyIds = new Set(notes.map((m) => `legacy-${m.id}`));
    state.dayNotes = state.dayNotes.filter((n) => !n.id.startsWith('legacy-') || legacyIds.has(n.id));
    for (const m of notes) {
      const n = state.dayNotes.find((n) => n.id === `legacy-${m.id}`);
      if (n) {
        n.text = m.note;
        n.day = m.entry_date;
      } else
        state.dayNotes.push({
          id: `legacy-${m.id}`,
          day: m.entry_date,
          text: m.note,
          shared: Boolean(prefs?.share_diary_notes),
        });
    }
    return { revision: row?.revision || 0, state };
  }
  function save(patientId, revision, state, today, timestamp) {
    return db
      .transaction(() => {
        const before = read(patientId);
        if (before.revision !== revision) return { conflict: before.revision };
        // Historical measurements are immutable through this endpoint. Sharing metadata may change.
        for (const [day, value] of Object.entries(before.state.wellbeings))
          if (day !== today && !isDeepStrictEqual(state.wellbeings[day], value)) throw new Error('history');
        for (const [day, value] of Object.entries(state.wellbeings))
          if (day !== today && !isDeepStrictEqual(before.state.wellbeings[day], value)) throw new Error('history');
        for (const [id, dates] of Object.entries(before.state.entries))
          for (const [day, value] of Object.entries(dates))
            if (
              day !== today &&
              state.habits.some((h) => h.id === id) &&
              !isDeepStrictEqual(state.entries[id]?.[day], value)
            )
              throw new Error('history');
        for (const [id, dates] of Object.entries(state.entries))
          for (const [day, value] of Object.entries(dates))
            if (day !== today && !isDeepStrictEqual(before.state.entries[id]?.[day], value)) throw new Error('history');
        for (const n of state.dayNotes) {
          const old = before.state.dayNotes.find((v) => v.id === n.id);
          if ((n.id.startsWith('legacy-') || n.day !== today) && (!old || old.day !== n.day || old.text !== n.text))
            throw new Error('history');
        }
        for (const n of before.state.dayNotes)
          if ((n.id.startsWith('legacy-') || n.day !== today) && !state.dayNotes.some((v) => v.id === n.id))
            throw new Error('history');
        for (const h of state.habits) {
          const old = before.state.habits.find((v) => v.id === h.id);
          if (old && (old.type !== h.type || old.unit !== h.unit)) throw new Error('history');
        }
        const w = state.wellbeings[today] || {};
        if (
          !isDeepStrictEqual(
            canonicalWellbeing(state.wellbeings[today]),
            canonicalWellbeing(before.state.wellbeings[today]),
          )
        ) {
          db.prepare(
            'INSERT INTO mood_entries(patient_id,entry_date,mood,sleep,anxiety,legacy_sleep_hours,triggers_json,created_at) VALUES (?,?,?,?,?,?,?,?)',
          ).run(
            patientId,
            today,
            w.mood ?? null,
            { 1: 'bad', 2: 'ok', 3: 'good' }[w.sleepQuality] || null,
            { 0: 'none', 1: 'some', 2: 'strong' }[w.anxiety] || null,
            w.sleepHours ?? null,
            '[]',
            timestamp,
          );
        }
        storage.persist(db, patientId, state, before.state, today, timestamp);
        db.prepare(
          'INSERT INTO diary_workspaces(patient_id,revision,state_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(patient_id) DO UPDATE SET revision=excluded.revision,state_json=excluded.state_json,updated_at=excluded.updated_at',
        ).run(patientId, revision + 1, JSON.stringify({ reminder: state.reminder }), timestamp);
        return read(patientId);
      })
      .immediate();
  }
  return { read, save };
}
function shared(state) {
  const habits = state.habits.filter((h) => h.shared);
  return {
    habits,
    entries: Object.fromEntries(Object.entries(state.entries).filter(([id]) => habits.some((h) => h.id === id))),
    wellbeings: state.wellbeings,
    dayNotes: state.dayNotes.filter((n) => n.shared),
  };
}
module.exports = { create, normalize, strings, shared, empty, windowState, mergeWindow };
