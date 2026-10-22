'use strict';
(async () => {
  const root = document.querySelector('.diary-workspace');
  if (!root) return;
  const $ = (selector) => root.querySelector(selector);
  const dictionary = await (await fetch('/assets/ru.json')).json();
  const t = (key) => dictionary[key] || key;
  let today,
    revision,
    stateWindow,
    state,
    sharedState,
    analytics,
    medications = {},
    medicationsShared = true,
    blocked = false;
  let calendarMonth;
  const shiftDay = (date, amount) =>
    new Date(Date.parse(date + 'T00:00:00Z') + amount * 86400000).toISOString().slice(0, 10);
  const dateAt = (index) => shiftDay(today, index - 13);
  const indexOfDate = (date) =>
    Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000) + 13;
  const days = Array.from({ length: 14 }, (_, i) => i);
  const formatDate = (date, options = { day: 'numeric', month: 'long' }) =>
    new Date(date + 'T00:00:00Z').toLocaleDateString('ru-RU', { ...options, timeZone: 'UTC' });
  function saveStatus(status, message) {
    const el = $('[data-diary-save-status]');
    el.dataset.state = status;
    el.textContent = message;
  }
  function showCrisis(card) {
    let holder = root.querySelector('[data-diary-crisis]');
    if (!holder) {
      holder = document.createElement('section');
      holder.dataset.diaryCrisis = '';
      holder.className = 'diary-crisis';
      holder.setAttribute('role', 'alert');
      root.prepend(holder);
    }
    holder.replaceChildren();
    const heading = document.createElement('h2');
    heading.textContent = t('msg.crisis.card.title');
    holder.append(heading);
    for (const [href, key] of [
      ['tel:112', 'msg.crisis.card.call'],
      ['/app?tab=doctor', 'msg.crisis.card.write'],
    ]) {
      const link = document.createElement('a');
      link.href = href;
      link.className = key === 'msg.crisis.card.call' ? 'btn crisis' : 'btn';
      link.textContent = t(key);
      holder.append(link, document.createTextNode(' '));
    }
    const delivery = document.createElement('p');
    delivery.textContent = t(
      card.signal_delivered ? 'msg.diary.workspace.signal_delivered' : 'msg.diary.workspace.signal_not_delivered',
    );
    holder.append(delivery);
    holder.scrollIntoView({ block: 'nearest' });
  }
  async function request(path, method = 'GET', body) {
    const headers = {};
    if (method !== 'GET') {
      const csrf = await fetch('/api/v1/csrf');
      if (!csrf.ok) throw Error(t('msg.diary.workspace.save_error'));
      headers['x-csrf-token'] = (await csrf.json()).token;
      headers['idempotency-key'] = crypto.randomUUID();
      headers['content-type'] = 'application/json';
    }
    const response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (data.crisis) showCrisis(data.crisis);
    if (data.ae_suggestion && !data.crisis) {
      let holder = $('[data-diary-ae]');
      if (!holder) {
        holder = document.createElement('p');
        holder.className = 'alert alert--warn';
        holder.dataset.diaryAe = '';
        const link = document.createElement('a');
        link.href = '/app?tab=meds&flow=ae';
        link.textContent = t('msg.diary.workspace.ae_suggestion');
        holder.append(link);
        $('.diary-main').prepend(holder);
      }
    }
    if (!response.ok || data.saved === false) {
      const error = Error(
        response.status === 409
          ? t('msg.diary.workspace.conflict')
          : data.crisis
            ? t('msg.diary.workspace.crisis')
            : t('msg.diary.workspace.save_error'),
      );
      error.data = data;
      throw error;
    }
    return data;
  }
  try {
    const data = await request('/api/v1/me/diary-workspace?window=90');
    ({ today, revision, state, sharedState, analytics } = data);
    stateWindow = data.window;
    medications = data.medications || {};
    medicationsShared = data.medications_shared !== false;
    calendarMonth = today.slice(0, 7);
  } catch (error) {
    saveStatus('error', error.message);
    root.setAttribute('aria-busy', 'false');
    return;
  }
  const esc = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const number = (value) => Number(value).toLocaleString('ru-RU', { maximumSignificantDigits: 12 });
  const clock = (value) =>
    `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(Math.round(value % 60)).padStart(2, '0')}`;
  const parseClock = (text) => {
    const [h, m] = text.split(':').map(Number);
    return h * 60 + m;
  };
  const numericTypes = ['count', 'duration', 'measure', 'scale'];
  const typeNames = {
    check: t('msg.diary.workspace.dynamic.001'),
    count: t('msg.diary.workspace.dynamic.002'),
    duration: t('msg.diary.workspace.dynamic.003'),
    measure: t('msg.diary.workspace.dynamic.004'),
    scale: t('msg.diary.workspace.dynamic.005'),
    time: t('msg.diary.workspace.dynamic.006'),
    choice: t('msg.diary.workspace.dynamic.007'),
    note: t('msg.diary.workspace.dynamic.008'),
  };
  const aggregations = {
    sum: t('msg.diary.workspace.dynamic.009'),
    last: t('msg.diary.workspace.dynamic.010'),
    mean: t('msg.diary.workspace.dynamic.011'),
    max: t('msg.diary.workspace.dynamic.012'),
    min: t('msg.diary.workspace.dynamic.013'),
    any: t('msg.diary.workspace.dynamic.014'),
    notes: t('msg.diary.workspace.dynamic.015'),
  };
  const unitLists = {
    check: [['flag', t('msg.diary.workspace.dynamic.016')]],
    count: [
      ['times', t('msg.diary.workspace.dynamic.017')],
      ['steps', t('msg.diary.workspace.dynamic.018')],
      ['pages', t('msg.diary.workspace.dynamic.019')],
      ['items', t('msg.diary.workspace.dynamic.020')],
      ['custom', t('msg.diary.workspace.dynamic.021')],
    ],
    duration: [
      ['minutes', t('msg.diary.workspace.dynamic.022')],
      ['hours', t('msg.diary.workspace.dynamic.023')],
    ],
    measure: [
      ['ml', t('msg.diary.workspace.dynamic.024')],
      ['litres', t('msg.diary.workspace.dynamic.025')],
      ['kg', t('msg.diary.workspace.dynamic.026')],
      ['g', t('msg.diary.workspace.dynamic.027')],
      ['km', t('msg.diary.workspace.dynamic.028')],
      ['m', t('msg.diary.workspace.dynamic.029')],
      ['percent', '%'],
      ['celsius', '°C'],
      ['custom', t('msg.diary.workspace.dynamic.021')],
    ],
    scale: [['points', t('msg.diary.workspace.dynamic.030')]],
    time: [['clock', t('msg.diary.workspace.dynamic.031')]],
    choice: [['choice', t('msg.diary.workspace.dynamic.032')]],
    note: [['text', t('msg.diary.workspace.dynamic.033')]],
  };
  function initialHabits() {
    return [
      {
        id: 'mood',
        name: t('msg.diary.workspace.dynamic.034'),
        icon: '◉',
        unit: t('msg.diary.workspace.dynamic.035'),
        minimum: 1,
        maximum: 5,
        color: '#6389ce',
        tint: '#eef3fc',
        type: 'scale',
        group: 'state',
      },
      {
        id: 'anxiety',
        name: t('msg.diary.workspace.dynamic.036'),
        icon: '≈',
        unit: t('msg.diary.workspace.dynamic.037'),
        minimum: 0,
        maximum: 2,
        color: '#b49570',
        tint: '#f7f1e9',
        type: 'scale',
        group: 'state',
      },
      {
        id: 'quality',
        name: t('msg.diary.workspace.dynamic.038'),
        icon: '☾',
        unit: t('msg.diary.workspace.dynamic.039'),
        minimum: 1,
        maximum: 3,
        color: '#8b82b6',
        tint: '#f2eff8',
        type: 'scale',
        group: 'state',
      },
      {
        id: 'sleep',
        name: t('msg.diary.workspace.dynamic.040'),
        icon: '☾',
        unit: t('msg.diary.workspace.dynamic.023'),
        minimum: 0,
        maximum: 24,
        color: '#7979ad',
        tint: '#efedf7',
        type: 'measure',
      },
      {
        id: 'med',
        name: t('msg.diary.workspace.dynamic.041'),
        icon: '⊕',
        unit: t('msg.diary.workspace.dynamic.042'),
        minimum: 0,
        maximum: 100,
        color: '#6b91b2',
        tint: '#eaf1f8',
        type: 'count',
      },
    ].map((h) => ({
      ...h,
      system: true,
      shared: true,
      step: h.id === 'sleep' ? 0.1 : 1,
      goal: 'none',
      aggregation: 'last',
      schedule: 'daily',
    }));
  }
  const wellbeingField = { mood: 'mood', anxiety: 'anxiety', quality: 'sleepQuality', sleep: 'sleepHours' };
  function attachDateView(h) {
    const indexed = (read, write) =>
      new Proxy(Array(14).fill(null), {
        get(target, prop, receiver) {
          return typeof prop === 'string' && /^-?\d+$/.test(prop)
            ? read(Number(prop))
            : Reflect.get(target, prop, receiver);
        },
        set(target, prop, value) {
          if (typeof prop === 'string' && /^-?\d+$/.test(prop)) {
            write(Number(prop), value);
            return true;
          }
          return Reflect.set(target, prop, value);
        },
      });
    const field = wellbeingField[h.id];
    const read = (index) => {
      const day = dateAt(index);
      const data = mode === 'doctor' ? sharedState : state;
      if (field) {
        const v = data.wellbeings[day]?.[field];
        return v == null ? [] : [v];
      }
      if (h.id === 'med')
        return (medications[day] || [])
          .filter((m) => !m.legacy && (m.status === 'taken' || m.status === 'skipped'))
          .map((m) => (m.status === 'taken' ? 1 : 0));
      return data.entries[h.id]?.[day] || [];
    };
    const write = (index, values) => {
      const day = dateAt(index);
      if (field) {
        state.wellbeings[day] ||= {};
        state.wellbeings[day][field] = values.length ? values.at(-1) : null;
      } else if (h.id !== 'med') {
        state.entries[h.id] ||= {};
        state.entries[h.id][day] = values;
      }
    };
    h.logs = indexed(read, write);
    h.values = indexed(
      (i) => (h.id === 'med' ? (read(i).length ? read(i).reduce((a, b) => a + b, 0) : null) : aggregate(h, read(i))),
      (i, v) => write(i, v == null ? [] : [v]),
    );
    h.medSlots = indexed(
      (i) => (medications[dateAt(i)] || []).map((m) => (m.status === 'unknown' ? null : m.status)),
      () => {},
    );
    h.startIndex = h.startDay ? indexOfDate(h.startDay) : -100000;
    return h;
  }
  const initialNotes = () => state.dayNotes.map((n) => ({ ...n, index: indexOfDate(n.day), order: n.order || 0 }));
  let journalNotes = initialNotes(),
    historyMode = 'state',
    showUnscheduled = false,
    drawerDay = 13,
    drawerHabit = null;
  const moodNames = [
    t('msg.diary.workspace.dynamic.043'),
    t('msg.diary.workspace.dynamic.044'),
    t('msg.diary.workspace.dynamic.045'),
    t('msg.diary.workspace.dynamic.046'),
    t('msg.diary.workspace.dynamic.047'),
  ];
  const anxietyNames = [
    t('msg.diary.workspace.dynamic.048'),
    t('msg.diary.workspace.dynamic.049'),
    t('msg.diary.workspace.dynamic.050'),
  ];
  const qualityNames = [
    t('msg.diary.workspace.dynamic.051'),
    t('msg.diary.workspace.dynamic.052'),
    t('msg.diary.workspace.dynamic.053'),
  ];
  let habits = [...initialHabits(), ...state.habits].map(attachDateView),
    mode = 'patient',
    selected = 'mood',
    editing = null,
    toastTimer;
  let reminder = state.reminder;
  let saveQueue = Promise.resolve();
  let pendingSaves = 0;
  const noteSharing = new Map();
  function persist() {
    if (blocked) return;
    state.habits = habits
      .filter((h) => !h.system)
      .map(({ values, logs, medSlots, startIndex, ...h }) => ({ ...h, startDay: h.startDay || dateAt(startIndex) }));
    state.dayNotes = journalNotes.map(({ index, ...n }) => ({ ...n, day: dateAt(index) }));
    state.reminder = reminder;
    const snapshot = JSON.parse(JSON.stringify(state));
    if (stateWindow) {
      const within = (day) => day >= stateWindow.from && day <= stateWindow.to;
      snapshot.wellbeings = Object.fromEntries(Object.entries(snapshot.wellbeings).filter(([day]) => within(day)));
      snapshot.entries = Object.fromEntries(
        Object.entries(snapshot.entries).map(([id, dates]) => [
          id,
          Object.fromEntries(Object.entries(dates).filter(([day]) => within(day))),
        ]),
      );
      snapshot.dayNotes = snapshot.dayNotes.filter((n) => within(n.day));
    }
    const sharingSnapshot = [...noteSharing].map(([id, shared]) => ({ id, shared }));
    pendingSaves += 1;
    saveStatus('saving', t('msg.diary.workspace.saving'));
    saveQueue = saveQueue.then(async () => {
      if (blocked) return;
      try {
        const result = await request('/api/v1/me/diary-workspace', 'PUT', {
          revision,
          state: snapshot,
          window: stateWindow,
          noteSharing: sharingSnapshot,
        });
        revision = result.revision;
        analytics = result.analytics;
        const outside = (day) => day < stateWindow.from || day > stateWindow.to;
        const mergeHistory = (current, received) => ({
          ...received,
          wellbeings: {
            ...Object.fromEntries(Object.entries(current.wellbeings).filter(([day]) => outside(day))),
            ...received.wellbeings,
          },
          entries: Object.fromEntries(
            received.habits.map((h) => [
              h.id,
              {
                ...Object.fromEntries(Object.entries(current.entries[h.id] || {}).filter(([day]) => outside(day))),
                ...(received.entries[h.id] || {}),
              },
            ]),
          ),
          dayNotes: [...current.dayNotes.filter((n) => outside(n.day)), ...received.dayNotes],
        });
        sharedState = mergeHistory(sharedState, result.sharedState);
        if (result.shared_scores === false) sharedState.wellbeings = {};
        for (const change of sharingSnapshot) {
          sharedState.dayNotes = sharedState.dayNotes.filter((n) => n.id !== change.id);
          const note = journalNotes.find((n) => n.id === change.id);
          if (change.shared && note) {
            const { index, ...n } = note;
            sharedState.dayNotes.push({ ...n, day: dateAt(index) });
          }
          if (noteSharing.get(change.id) === change.shared) noteSharing.delete(change.id);
        }
        medicationsShared = result.medications_shared !== false;
        if (pendingSaves === 1) state = mergeHistory(state, result.state);
        renderInterpretation();
      } catch (error) {
        blocked = true;
        saveStatus('error', error.message);
        $('[data-diary-content]').inert = true;
      } finally {
        pendingSaves -= 1;
        if (!blocked && !pendingSaves) saveStatus('saved', t('msg.diary.workspace.saved'));
      }
    });
    return saveQueue;
  }
  const visible = () =>
    habits.filter(
      (h) =>
        mode === 'patient' ||
        (h.system
          ? h.id === 'med'
            ? medicationsShared
            : Object.keys(sharedState.wellbeings).length > 0
          : sharedState.habits.some((item) => item.id === h.id)),
    );
  const weekday = (i) => new Date(dateAt(i) + 'T00:00:00Z').getUTCDay();
  function scheduled(h, i) {
    if (i < (h.startIndex || 0)) return false;
    if (h.schedule === 'free') return false;
    if (h.schedule === 'daily') return true;
    if (h.schedule === 'interval') return (i - h.startIndex) % h.interval === 0;
    if (h.schedule === 'weekdays') return h.weekdays.includes(weekday(i));
    return h.schedule === 'alternate' ? i % 2 === 1 : [2, 9].includes(i);
  }
  function meets(h, v) {
    if (h.goal === 'none') return null;
    if (h.type === 'check') return v === 1;
    if (h.goal === 'range')
      return h.type === 'time' && h.range[0] > h.range[1]
        ? v >= h.range[0] || v <= h.range[1]
        : v >= h.range[0] && v <= h.range[1];
    if (h.goal === 'max') return v <= h.target;
    if (h.goal === 'exact') return Math.abs(v - h.target) < 1e-8;
    return v >= h.target;
  }
  function status(h, i) {
    const v = h.values[i];
    if (v == null) return scheduled(h, i) ? 'missing' : 'off';
    if (h.goal === 'none') return 'recorded';
    if (meets(h, v)) return 'done';
    return h.type === 'check' && v === 0 ? 'missed' : 'partial';
  }
  const statusNames = {
    done: t('msg.diary.workspace.dynamic.054'),
    partial: t('msg.diary.workspace.dynamic.055'),
    missed: t('msg.diary.workspace.dynamic.056'),
    missing: t('msg.diary.workspace.dynamic.057'),
    off: t('msg.diary.workspace.dynamic.058'),
    recorded: t('msg.diary.workspace.dynamic.059'),
  };
  function valueLabel(h, v) {
    if (v == null) return t('msg.diary.workspace.dynamic.057');
    if (h.id === 'mood') return moodNames[v - 1];
    if (h.id === 'anxiety') return anxietyNames[v];
    if (h.id === 'quality') return qualityNames[v - 1];
    if (h.type === 'time') return clock(v);
    if (h.type === 'check')
      return v === 1 ? t('msg.diary.workspace.dynamic.060') : t('msg.diary.workspace.dynamic.056');
    if (h.type === 'choice') return h.choices[v - 1] || '—';
    if (h.type === 'note') return String(v);
    return `${number(v)} ${h.unit}`;
  }
  function aggregate(h, list) {
    if (!list.length) return null;
    if (['last', 'notes'].includes(h.aggregation)) return list[list.length - 1];
    if (h.aggregation === 'any') return Math.max(...list);
    if (h.aggregation === 'sum') return Number(list.reduce((a, b) => a + b, 0).toPrecision(12));
    if (h.aggregation === 'mean') return list.reduce((a, b) => a + b, 0) / list.length;
    return h.aggregation === 'max' ? Math.max(...list) : Math.min(...list);
  }
  function toast(message) {
    $('#toast').textContent = message;
    $('#toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      $('#toast').hidden = true;
    }, 3200);
  }
  function scheduleLabel(h) {
    if (h.schedule === 'daily') return t('msg.diary.workspace.dynamic.061');
    if (h.schedule === 'free') return t('msg.diary.workspace.dynamic.062');
    if (h.schedule === 'interval')
      return `${t('msg.diary.workspace.dynamic.063')} ${h.interval} ${t('msg.diary.workspace.dynamic.064')} ${formatDate(dateAt(h.startIndex))}`;
    if (h.schedule === 'weekdays')
      return h.weekdays
        .map(
          (n) =>
            [
              t('msg.diary.workspace.dynamic.065'),
              t('msg.diary.workspace.dynamic.066'),
              t('msg.diary.workspace.dynamic.067'),
              t('msg.diary.workspace.dynamic.068'),
              t('msg.diary.workspace.dynamic.069'),
              t('msg.diary.workspace.dynamic.070'),
              t('msg.diary.workspace.dynamic.071'),
            ][n],
        )
        .join(', ');
    return h.schedule === 'alternate' ? t('msg.diary.workspace.dynamic.072') : t('msg.diary.workspace.dynamic.073');
  }
  function goalLabel(h) {
    if (h.type === 'check') return t('msg.diary.workspace.dynamic.074');
    if (h.goal === 'none') return t('msg.diary.workspace.dynamic.075');
    const label = (v) => (h.type === 'time' ? clock(v) : `${number(v)} ${h.unit}`);
    if (h.goal === 'range')
      return `${label(h.range[0])} — ${label(h.range[1])}${h.type === 'time' && h.range[0] > h.range[1] ? t('msg.diary.workspace.dynamic.076') : ''}`;
    return `${{ min: t('msg.diary.workspace.dynamic.077'), max: t('msg.diary.workspace.dynamic.078'), exact: t('msg.diary.workspace.dynamic.079') }[h.goal]} ${label(h.target)}`;
  }
  function planLabel(h) {
    return h.plan || `${goalLabel(h)} · ${scheduleLabel(h)}`;
  }
  const accessBadge = (shared) =>
    `<span class="visibility-label ${shared ? '' : 'private'}">${ico(shared ? 'eye' : 'lock', 'i--16')}${shared ? t('msg.diary.workspace.dynamic.080') : t('msg.diary.workspace.dynamic.081')}</span>`;
  const shortNumber = (value) => number(Number(value.toPrecision(5)));
  const dayLabel = (index) =>
    `${index === 13 ? t('msg.diary.workspace.today') + ', ' : index === 12 ? t('msg.diary.workspace.yesterday') + ', ' : ''}${formatDate(dateAt(index))}`;
  const ico = (name, size = '') =>
    `<svg class="i ${size}" aria-hidden="true" focusable="false"><use href="/icons.svg#i-${name}"/></svg>`;
  function statePickers() {
    $('.state-panel').hidden = mode === 'doctor' && !Object.keys(sharedState.wellbeings).length;
    const mood = habits.find((h) => h.id === 'mood'),
      anxiety = habits.find((h) => h.id === 'anxiety');
    const selectedMood = mood.values[13],
      selectedAnxiety = anxiety.values[13];
    const off = mode === 'doctor' ? 'disabled' : '';
    $('#state-pickers').innerHTML =
      `<div class="moods mood-buttons" role="radiogroup" aria-label="${t('msg.diary.workspace.dynamic.034')}">${moodNames.map((name, i) => `<button type="button" role="radio" data-state="mood" data-state-value="${i + 1}" aria-checked="${selectedMood === i + 1}" tabindex="${selectedMood === i + 1 || (selectedMood == null && i === 0) ? 0 : -1}" ${off}><span class="peb p${i + 1}" aria-hidden="true"></span><span>${name}</span></button>`).join('')}</div><div class="anxiety-row"><h4 class="field-label">${t('msg.diary.workspace.dynamic.036')}</h4><div class="seg seg--sm rating-buttons" role="radiogroup" aria-label="${t('msg.diary.workspace.dynamic.036')}">${anxietyNames.map((name, i) => `<button type="button" role="radio" data-state="anxiety" data-state-value="${i}" aria-checked="${selectedAnxiety === i}" tabindex="${selectedAnxiety === i || (selectedAnxiety == null && i === 0) ? 0 : -1}" ${off}>${name}</button>`).join('')}</div></div>`;
  }
  const medicationRows = (index) => medications[dateAt(index)] || [];
  function medicationLabel(row) {
    return [
      row.name,
      row.dose == null ? '' : row.dose,
      row.unit,
      row.legacy
        ? t('msg.diary.workspace.legacy_day_mark')
        : row.slot === 'any'
          ? t('msg.diary.workspace.any_slot')
          : row.slot,
    ]
      .filter((v) => v !== '')
      .join(' · ');
  }
  function essentialCards() {
    const sleep = habits.find((h) => h.id === 'sleep'),
      quality = habits.find((h) => h.id === 'quality'),
      rows = medicationRows(13);
    const planned = rows.filter((m) => !m.legacy);
    const taken = planned.filter((m) => m.status === 'taken').length;
    $('#essential-cards').innerHTML =
      `<article class="inset essential-card" data-habit="sleep"><h4 class="card-top">${ico('moon', 'i--18')}<span class="card-title">${t('msg.diary.workspace.dynamic.040')}</span></h4><div class="card-value"><strong>${sleep.values[13] == null ? '—' : number(sleep.values[13])}</strong><span>${t('msg.diary.workspace.dynamic.085')}</span></div><div class="sleep-quality small">${quality.values[13] == null ? t('msg.diary.workspace.quality_empty') : qualityNames[quality.values[13] - 1] + ' ' + t('msg.diary.workspace.sleep')}</div><div class="card-bottom">${mode === 'patient' ? t('msg.diary.workspace.dynamic.083') : ''}${accessBadge(true)}</div></article><article class="inset essential-card" data-habit="med"><h4 class="card-top">${ico('pill', 'i--18')}<span class="card-title">${t('msg.diary.workspace.dynamic.041')}</span></h4><div class="card-value"><strong>${planned.length ? taken : '—'}</strong><span>${planned.length ? t('msg.diary.workspace.out_of') + ' ' + planned.length + ' ' + t('msg.diary.workspace.doses') : ''}</span></div><div class="med-slots">${rows.map((row) => `<span class="med-slot ${esc(row.status || 'pending')}">${row.status === 'taken' ? ico('check', 'i--16') : ''}${esc(medicationLabel(row))}</span>`).join('') || '<p class="p-hint">' + t('msg.diary.workspace.no_medications') + '</p>'}</div><div class="card-bottom">${mode === 'patient' && planned.length ? t('msg.diary.workspace.dynamic.084') : ''}<a class="small" href="/app?tab=meds">${t('msg.diary.workspace.medication_plan')}</a>${accessBadge(true)}</div></article>`;
    $('[data-habit="med"]').hidden = mode === 'doctor' && !medicationsShared;
    $('[data-habit="sleep"]').hidden = mode === 'doctor' && !Object.keys(sharedState.wellbeings).length;
  }
  // Клетка матрицы привычек: сделано (галочка), пропуск (крестик), нет отметки (пунктир), без плана (пусто), без оценки (точка)
  const cellMark = (s) =>
    s === 'done'
      ? ico('check', 'i--16')
      : s === 'missed'
        ? ico('x', 'i--16')
        : s === 'partial'
          ? ico('check', 'i--16')
          : '';
  function personalCard(h) {
    const v = h.values[13],
      textual = ['note', 'choice'].includes(h.type);
    const main = v == null ? '—' : numericTypes.includes(h.type) ? shortNumber(v) : valueLabel(h, v);
    const progress = v == null ? 0 : h.goal === 'none' ? 100 : meets(h, v) ? 100 : 50;
    const strip = days
      .slice(7)
      .map((d) => {
        const s = status(h, d);
        return `<span class="mx mx--${s}" role="img" aria-label="${esc(formatDate(dateAt(d)))}: ${statusNames[s]}">${cellMark(s)}</span>`;
      })
      .join('');
    return `<article class="habit-card qrow" data-habit="${h.id}" data-progress="${progress}"><div class="q-main"><h3 class="card-title">${esc(h.name)}</h3><p class="card-plan small">${esc(planLabel(h))}</p><div class="card-value"><strong class="${textual ? 'text-value' : ''}">${esc(main.length > 70 ? main.slice(0, 70) + '…' : main)}</strong><span>${v == null ? t('msg.diary.workspace.dynamic.086') : numericTypes.includes(h.type) ? esc(h.unit) : ''}</span></div></div><div class="mx-strip" role="group" aria-label="${esc(h.name)}">${strip}</div><div class="q-act">${mode === 'patient' ? `<button class="btn sm" type="button" data-edit="${h.id}">${v == null ? t('msg.diary.workspace.dynamic.087') : t('msg.diary.workspace.dynamic.088')}</button>` : ''}<button class="round round--sm habit-more" type="button" data-about="${h.id}" aria-label="${t('msg.diary.workspace.dynamic.089')} ${esc(h.name)}">${ico('dots-three-vertical', 'i--18')}</button></div>${accessBadge(h.shared)}</article>`;
  }
  function render() {
    const shown = visible();
    if (!shown.some((h) => h.id === selected)) selected = shown[0]?.id || '';
    $('#doctor-notice').hidden = mode !== 'doctor';
    root.classList.toggle('doctor-preview', mode === 'doctor');
    $('#add').hidden = mode === 'doctor';
    $('#note-form').hidden = mode === 'doctor';
    document
      .querySelectorAll('[data-mode]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    statePickers();
    essentialCards();
    renderInterpretation();
    const personal = shown.filter((h) => !h.system),
      pending = personal.filter((h) => scheduled(h, 13) || h.values[13] != null),
      off = personal.filter((h) => !scheduled(h, 13) && h.values[13] == null);
    const cards = (showUnscheduled ? personal : pending).sort(
      (a, b) => Number(b.values[13] == null && scheduled(b, 13)) - Number(a.values[13] == null && scheduled(a, 13)),
    );
    $('#cards').innerHTML = cards.map(personalCard).join('') || t('msg.diary.workspace.dynamic.090');
    $('#show-unscheduled').hidden = !off.length;
    $('#show-unscheduled').textContent = showUnscheduled
      ? t('msg.diary.workspace.dynamic.091')
      : `${t('msg.diary.workspace.dynamic.092')} ${off.length} ${t('msg.diary.workspace.dynamic.093')}`;
    $('#today-caption').textContent =
      mode === 'doctor' ? t('msg.diary.workspace.dynamic.094') : t('msg.diary.workspace.dynamic.095');
    document
      .querySelectorAll('[data-history-mode]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.historyMode === historyMode)));
    $('#state-history').hidden = historyMode !== 'state';
    $('#habit-history').hidden = historyMode !== 'habits';
    $('#history-period').hidden = historyMode !== 'habits';
    renderMonth();
    renderHabitCalendar();
    $('#metric').innerHTML = shown
      .map((h) => `<option value="${h.id}" ${h.id === selected ? 'selected' : ''}>${esc(h.name)}</option>`)
      .join('');
    renderChart();
    renderInsights();
    renderNotes();
    renderReminder();
    if ($('#day-drawer').open) renderDrawer();
  }
  function renderInterpretation() {
    const lines = [...(analytics?.flag ? [analytics.flag] : []), ...(analytics?.observations || [])];
    $('#interpretation-summary').textContent = lines.length
      ? lines
          .slice(0, 3)
          .map((x) => x.text)
          .join(' ')
      : t('msg.diary.workspace.no_interpretation');
  }
  function renderMonth() {
    const first = calendarMonth + '-01';
    const offset = (new Date(first + 'T00:00:00Z').getUTCDay() + 6) % 7;
    const last = new Date(Date.UTC(Number(calendarMonth.slice(0, 4)), Number(calendarMonth.slice(5)), 0)).getUTCDate();
    const mood = habits.find((h) => h.id === 'mood'),
      notes = allNotes();
    $('#history-month').textContent = formatDate(first, { month: 'long', year: 'numeric' });
    $('#next-month').disabled = calendarMonth >= today.slice(0, 7);
    let html =
      [
        t('msg.diary.workspace.dynamic.096'),
        t('msg.diary.workspace.dynamic.097'),
        t('msg.diary.workspace.dynamic.098'),
        t('msg.diary.workspace.dynamic.099'),
        t('msg.diary.workspace.dynamic.100'),
        t('msg.diary.workspace.dynamic.101'),
        t('msg.diary.workspace.dynamic.102'),
      ]
        .map((d) => `<span class="cal-h">${d}</span>`)
        .join('') + '<span></span>'.repeat(offset);
    for (let day = 1; day <= last; day++) {
      const date = calendarMonth + '-' + String(day).padStart(2, '0'),
        index = indexOfDate(date),
        value = mood.values[index],
        hasNotes = notes.some((n) => n.index === index),
        future = date > today;
      const label = `${formatDate(date)}, ${value == null ? t('msg.diary.workspace.dynamic.057').toLocaleLowerCase('ru') : `${t('msg.diary.workspace.cal_mood')} ${value} ${t('msg.diary.workspace.cal_of_5')}`}${hasNotes ? `, ${t('msg.diary.workspace.cal_has_note')}` : ''}`;
      html += `<button type="button" class="cal-day ${future ? 'is-future' : value == null ? 'm0' : 'm' + value} ${date === today ? 'is-today' : ''}" ${value == null ? '' : `data-mood="${value}"`} data-open-day="${index}" aria-label="${esc(label)}" aria-pressed="${$('#day-drawer').open && !drawerHabit && drawerDay === index}" ${future ? 'disabled' : ''}><span class="n">${day}</span>${future ? '<span></span>' : value == null ? '<span class="v v--none">—</span>' : `<span class="v">${value}</span>`}${hasNotes ? ico('note-pencil', 'note-i') : ''}</button>`;
    }
    $('#month-calendar').innerHTML = html;
  }
  async function loadHistoryMonth() {
    const from = calendarMonth + '-01';
    const monthEnd = new Date(Date.UTC(Number(calendarMonth.slice(0, 4)), Number(calendarMonth.slice(5)), 0))
      .toISOString()
      .slice(0, 10);
    const to = monthEnd > today ? today : monthEnd;
    if (from >= stateWindow.from) return;
    await saveQueue;
    const data = await request(`/api/v1/me/diary-workspace?from=${from}&to=${to}`);
    Object.assign(state.wellbeings, data.state.wellbeings);
    Object.assign(sharedState.wellbeings, data.sharedState.wellbeings);
    for (const [id, dates] of Object.entries(data.state.entries)) Object.assign((state.entries[id] ||= {}), dates);
    for (const [id, dates] of Object.entries(data.sharedState.entries))
      Object.assign((sharedState.entries[id] ||= {}), dates);
    const sharedIds = new Set(sharedState.dayNotes.map((n) => n.id));
    sharedState.dayNotes.push(...data.sharedState.dayNotes.filter((n) => !sharedIds.has(n.id)));
    const ids = new Set(state.dayNotes.map((n) => n.id));
    state.dayNotes.push(...data.state.dayNotes.filter((n) => !ids.has(n.id)));
    journalNotes = initialNotes();
  }
  $('#previous-month').addEventListener('click', async () => {
    calendarMonth = shiftDay(calendarMonth + '-01', -1).slice(0, 7);
    try {
      await loadHistoryMonth();
    } catch (error) {
      saveStatus('error', error.message);
    }
    renderMonth();
  });
  $('#next-month').addEventListener('click', () => {
    calendarMonth = shiftDay(calendarMonth + '-01', 32).slice(0, 7);
    renderMonth();
  });
  function renderHabitCalendar() {
    const start = 14 - Number($('#history-period').value),
      shown = visible().filter((h) => h.group !== 'state');
    $('#calendar').innerHTML =
      `<thead><tr><th scope="col"><span class="sr">${esc(formatDate(today, { month: 'long' }))}</span></th>${days
        .slice(start)
        .map(
          (d) =>
            `<th scope="col" class="${d === 13 ? 'today-col' : ''}">${new Date(dateAt(d) + 'T00:00:00Z').getUTCDate()}</th>`,
        )
        .join('')}</tr></thead><tbody>${shown
        .map(
          (h) =>
            `<tr><th scope="row">${esc(h.name)}</th>${days
              .slice(start)
              .map((d, k) => {
                const index = k + start,
                  v = h.values[index],
                  s = status(h, index),
                  compact =
                    v == null
                      ? ''
                      : h.type === 'check'
                        ? ''
                        : h.type === 'note'
                          ? String(h.logs[index].length)
                          : h.type === 'choice'
                            ? (h.choices[v - 1] || '').slice(0, 3)
                            : h.type === 'time'
                              ? clock(v)
                              : shortNumber(v);
                return `<td><button type="button" class="cell mx mx--${s} ${s}" data-history="${h.id}" data-index="${index}" aria-label="${esc(h.name)}, ${formatDate(dateAt(d))}: ${statusNames[s]}${v == null ? '' : `, ${esc(valueLabel(h, v))}`}" title="${esc(v == null ? statusNames[s] : valueLabel(h, v))}">${compact ? esc(compact) : cellMark(s)}</button></td>`;
              })
              .join('')}</tr>`,
        )
        .join('')}</tbody>`;
  }
  function renderInsights() {
    const h = habits.find((h) => h.id === selected);
    if (!h) {
      $('#insights').innerHTML = '';
      return;
    }
    const n = Number($('#period').value),
      start = 14 - n,
      recorded = h.values.slice(start).filter((v) => v != null).length;
    const isState = h.group === 'state' || h.id === 'sleep';
    const descriptor = isState
      ? t('msg.diary.workspace.dynamic.103')
      : h.goal === 'none'
        ? t('msg.diary.workspace.dynamic.104')
        : `${t('msg.diary.workspace.dynamic.105')} ${goalLabel(h).toLocaleLowerCase('ru')}.`;
    const half = Math.floor(n / 2),
      first = h.values.slice(start, start + half).filter((v) => v != null),
      second = h.values.slice(start + half).filter((v) => v != null);
    const mean = (list) => number(Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10);
    const comparison =
      numericTypes.includes(h.type) && first.length >= 2 && second.length >= 2
        ? `<strong>${mean(first)} → ${mean(second)} ${esc(h.unit)}</strong>${t('msg.diary.workspace.dynamic.106')} ${first.length} ${t('msg.diary.workspace.dynamic.107')} ${second.length} ${t('msg.diary.workspace.dynamic.108')}`
        : `<strong>${n - recorded} ${t('msg.diary.workspace.dynamic.109')}</strong>${t('msg.diary.workspace.dynamic.110')}`;
    $('#insights').innerHTML =
      `<div class="insight"><strong>${recorded} ${t('msg.diary.workspace.dynamic.114')} ${n} ${t('msg.diary.workspace.dynamic.115')}</strong>${t('msg.diary.workspace.dynamic.116')}</div><div class="insight">${comparison}</div><div class="insight"><strong>${isState ? t('msg.diary.workspace.dynamic.111') : h.goal === 'none' ? t('msg.diary.workspace.dynamic.112') : t('msg.diary.workspace.dynamic.113')}</strong>${esc(descriptor)}</div>`;
  }
  function renderChart() {
    const h = habits.find((h) => h.id === selected);
    if (!h) {
      $('#chart').innerHTML = '';
      $('#chart-value').textContent = t('msg.diary.workspace.dynamic.117');
      $('#chart-description').textContent = '';
      $('#chart-table').innerHTML = '';
      $('#chart-footnote').textContent = '';
      return;
    }
    const start = 14 - Number($('#period').value),
      values = h.values.slice(start).filter((v) => v != null);
    const plotted = (i) => (h.values[i] == null ? null : h.type === 'note' ? h.logs[i].length : h.values[i]);
    const hasGoal = h.goal !== 'none',
      count = days.slice(start).filter((_, k) => scheduled(h, k + start)).length;
    const done = days.slice(start).filter((_, k) => scheduled(h, k + start) && status(h, k + start) === 'done').length;
    if (!values.length) $('#chart-value').textContent = t('msg.diary.workspace.dynamic.118');
    else if (h.type === 'note')
      $('#chart-value').textContent =
        `${h.logs.slice(start).reduce((a, b) => a + b.length, 0)} ${t('msg.diary.workspace.dynamic.119')}`;
    else if (['time', 'choice'].includes(h.type)) $('#chart-value').textContent = valueLabel(h, values.at(-1));
    else if (h.type === 'check')
      $('#chart-value').textContent = `${values.filter((v) => v === 1).length} ${t('msg.diary.workspace.dynamic.120')}`;
    else
      $('#chart-value').textContent =
        `${number(h.group === 'state' ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : Number((values.reduce((a, b) => a + b, 0) / values.length).toPrecision(4)))} ${h.unit}`;
    $('#chart-description').textContent =
      `${numericTypes.includes(h.type) ? t('msg.diary.workspace.dynamic.121') : ['time', 'choice'].includes(h.type) ? t('msg.diary.workspace.dynamic.010') : t('msg.diary.workspace.dynamic.122')} · ${values.length} ${t('msg.diary.workspace.dynamic.124')}${hasGoal && h.schedule !== 'free' ? ` · ${done} ${t('msg.diary.workspace.dynamic.114')} ${count} ${t('msg.diary.workspace.dynamic.123')}` : ''}`;
    $('#chart-footnote').textContent =
      h.type === 'note'
        ? t('msg.diary.workspace.dynamic.125')
        : h.type === 'choice'
          ? t('msg.diary.workspace.dynamic.126')
          : hasGoal
            ? t('msg.diary.workspace.dynamic.127')
            : t('msg.diary.workspace.dynamic.128');
    const data = days
      .slice(start)
      .map((_, k) => plotted(k + start))
      .filter((v) => v != null);
    const targets = hasGoal ? (h.range || [h.target]).filter(Number.isFinite) : [];
    let low = Math.min(0, ...data, ...targets),
      high = Math.max(1, ...data, ...targets);
    if (h.type === 'time') {
      low = 0;
      high = 1440;
    } else if (h.type === 'scale') {
      low = h.minimum;
      high = h.maximum;
    } else if (h.type === 'choice') {
      low = 0;
      high = h.choices.length;
    } else {
      const span = high - low;
      high += span * 0.15;
      if (low < 0) low -= span * 0.1;
    }
    const left = h.type === 'choice' ? 90 : 52,
      w = Math.max(300, Math.round($('#chart').clientWidth || 1080)),
      top = 30,
      bottom = 200,
      step = (w - left - 12) / (14 - start),
      y = (v) => bottom - ((v - low) / (high - low)) * (bottom - top);
    const tick = (v) => (h.type === 'time' ? clock(Math.min(1439, Math.round(v))) : number(Number(v.toPrecision(3))));
    const ticks =
      h.type === 'choice'
        ? h.choices.map((name, i) => [i + 1, name.slice(0, 12)])
        : h.type === 'scale' && high - low <= 10
          ? Array.from({ length: high - low + 1 }, (_, i) => [low + i, String(low + i)])
          : Array.from({ length: 4 }, (_, i) => [low + ((high - low) * i) / 3, tick(low + ((high - low) * i) / 3)]);
    const grid = ticks
      .map(
        ([v, label]) =>
          `<line class="grid" x1="${left}" x2="${w - 10}" y1="${y(v)}" y2="${y(v)}"/><text x="${left - 9}" y="${y(v) + 4}" text-anchor="end">${esc(label)}</text>`,
      )
      .join('');
    let goal = '';
    if (hasGoal && h.range) {
      const ranges =
        h.type === 'time' && h.range[0] > h.range[1]
          ? [
              [h.range[0], 1440],
              [0, h.range[1]],
            ]
          : [h.range];
      goal = ranges
        .map(
          ([a, b]) =>
            `<rect class="band" x="${left}" y="${y(b)}" width="${w - 10 - left}" height="${y(a) - y(b)}" rx="8"/>`,
        )
        .join('');
    } else if (hasGoal && Number.isFinite(h.target))
      goal = `<line class="lref" x1="${left}" x2="${w - 10}" y1="${y(h.target)}" y2="${y(h.target)}"/>`;
    const base = y(Math.min(high, Math.max(low, 0)));
    const lineChart = h.group === 'state' || h.id === 'sleep';
    // ряд различим и без цвета: свой штрих и своя форма маркера, подпись у линии (спецификация 8.5)
    const series = { mood: 1, sleep: 2, anxiety: 3, quality: 4 }[h.id] || 1;
    const marker = (cx, cy, k) =>
      k === 2
        ? `<rect class="d${k}" x="${cx - 4.5}" y="${cy - 4.5}" width="9" height="9"/>`
        : k === 3
          ? `<path class="d${k}" d="M${cx} ${cy - 5.5} l5.5 10 h-11z"/>`
          : k === 4
            ? `<path class="d${k}" d="M${cx} ${cy - 6} l6 6 l-6 6 l-6 -6z"/>`
            : `<circle class="d${k}" cx="${cx}" cy="${cy}" r="4.5"/>`;
    let path = '',
      connected = false,
      lastPoint = null;
    if (lineChart)
      days.slice(start).forEach((_, k) => {
        const v = plotted(k + start);
        if (v == null) {
          connected = false;
          return;
        }
        const cx = left + k * step + step / 2;
        path += `${connected ? 'L' : 'M'}${cx},${y(v)} `;
        connected = true;
        lastPoint = [cx, y(v)];
      });
    const trendLine = lineChart ? `<path class="l${series}" d="${path}"/>` : '';
    const bars = days
      .slice(start)
      .map((d, k) => {
        const i = k + start,
          v = plotted(i),
          x = left + k * step + step * 0.24,
          bw = step * 0.52;
        return `${v == null ? `<line class="miss" x1="${x}" x2="${x + bw}" y1="${bottom - 2}" y2="${bottom - 2}"/>` : h.type === 'choice' || lineChart ? marker(x + bw / 2, y(v), series) : `<rect class="bar s${series}${i === 13 ? ' now' : ''}" x="${x}" y="${Math.min(base, y(v)) - (v === 0 ? 3 : 0)}" width="${bw}" height="${Math.max(3, Math.abs(base - y(v)))}" rx="3"><title>${esc(valueLabel(h, h.values[i]))}</title></rect>`}<text x="${x + bw / 2}" y="${bottom + 24}" text-anchor="middle">${new Date(dateAt(d) + 'T00:00:00Z').getUTCDate()}</text>`;
      })
      .join('');
    const direct = lastPoint
      ? `<text class="lab s${series}" x="${Math.min(lastPoint[0], w - 10)}" y="${Math.max(14, lastPoint[1] - 12)}" text-anchor="end">${esc(h.name)}</text>`
      : '';
    $('#chart').innerHTML =
      `<svg class="chart" viewBox="0 0 ${w} ${bottom + 36}" width="${w}" height="${bottom + 36}" role="img" aria-label="${esc(h.name)}: ${t('msg.diary.workspace.dynamic.129')} ${formatDate(dateAt(start))} ${t('msg.diary.workspace.dynamic.130')} ${formatDate(today)}. ${t('msg.diary.workspace.dynamic.131')}">${goal}${grid}${trendLine}${bars}${direct}</svg>`;
    $('#chart-table').innerHTML =
      `<table><thead><tr><th>${t('msg.diary.workspace.dynamic.132')}</th><th>${t('msg.diary.workspace.dynamic.133')}</th><th>${t('msg.diary.workspace.dynamic.134')}</th></tr></thead><tbody>${days
        .slice(start)
        .map((d, k) => {
          const i = k + start;
          return `<tr><th scope="row">${formatDate(dateAt(d))}</th><td>${esc(valueLabel(h, h.values[i]))}</td><td>${esc(h.logs[i].map((v) => valueLabel(h, v)).join('; '))}</td></tr>`;
        })
        .join('')}</tbody></table>`;
  }
  function openEntry(id, index = 13) {
    const h = habits.find((h) => h.id === id);
    if (mode === 'doctor') {
      selected = id;
      setTab('dynamics');
      render();
      $('#chart-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (index !== 13) {
      toast(t('msg.diary.workspace.history_readonly'));
      return;
    }
    if (index < (h.startIndex || 0)) {
      toast(t('msg.diary.workspace.dynamic.135'));
      return;
    }
    $('#entry-clear').hidden = false;
    editing = { id, index };
    $('#entry-title').textContent = `${h.name} · ${formatDate(dateAt(index))}`;
    $('#entry-hint').textContent =
      `${planLabel(h)}. ${aggregations[h.aggregation]}.${h.id === 'med' ? t('msg.diary.workspace.dynamic.136') : ''}`;
    if (h.id === 'med') {
      openMedEditor(h, index);
      return;
    }
    let field = '';
    const v = h.aggregation === 'mean' ? (h.logs[index].at(-1) ?? null) : h.values[index];
    if (h.type === 'check')
      field = `<label>${t('msg.diary.workspace.dynamic.137')}<select id="entry-value"><option value="1" ${v === 1 ? 'selected' : ''}>${t('msg.diary.workspace.dynamic.060')}</option><option value="0" ${v === 0 ? 'selected' : ''}>${t('msg.diary.workspace.dynamic.056')}</option></select></label>`;
    else if (h.type === 'note')
      field = `<label>${t('msg.diary.workspace.dynamic.008')}<textarea id="entry-value" maxlength="2000" required>${esc(v ?? '')}</textarea></label>`;
    else if (h.type === 'choice')
      field = `<label>${t('msg.diary.workspace.dynamic.138')}<select id="entry-value">${h.choices.map((s, i) => `<option value="${i + 1}" ${v === i + 1 ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>`;
    else if (h.type === 'time')
      field = `<label>${t('msg.diary.workspace.dynamic.006')}<input id="entry-value" type="time" value="${v == null ? '' : clock(v)}" required></label>`;
    else
      field = `<label>${t('msg.diary.workspace.dynamic.139')} ${esc(h.unit)}<input id="entry-value" type="number" min="${h.minimum}" max="${h.maximum}" step="${h.step}" value="${v ?? ''}" required></label>`;
    if (h.id === 'sleep') {
      const q = habits.find((x) => x.id === 'quality').values[index];
      field += `<label>${t('msg.diary.workspace.dynamic.038')}<select id="sleep-quality"><option value="">${t('msg.diary.workspace.dynamic.140')}</option>${qualityNames.map((name, k) => `<option value="${k + 1}" ${q === k + 1 ? 'selected' : ''}>${name}</option>`).join('')}</select></label>`;
    }
    $('#entry-fields').innerHTML = field;
    if (h.id === 'sleep') $('#entry-value').required = false;
    $('#entry-operation').value = 'replace';
    $('#entry-operation-label').hidden = h.system || h.type === 'check';
    $('#entry-records').textContent = h.logs[index].length
      ? `${t('msg.diary.workspace.dynamic.141')} ${h.logs[index].map((v) => valueLabel(h, v)).join('; ')}`
      : t('msg.diary.workspace.dynamic.142');
    $('#entry-missed').hidden = h.type !== 'check';
    $('#editor').showModal();
  }
  function saveEntry(v, clearSleep = false) {
    const h = habits.find((h) => h.id === editing.id),
      i = editing.index;
    if (v === null) h.logs[i] = [];
    else if ($('#entry-operation').value === 'append' && !h.system && h.type !== 'check') h.logs[i] = [...h.logs[i], v];
    else h.logs[i] = [v];

    if (h.id === 'sleep') {
      const quality = habits.find((x) => x.id === 'quality'),
        q = $('#sleep-quality')?.value;
      quality.values[i] = clearSleep || !q ? null : Number(q);
      quality.logs[i] = quality.values[i] == null ? [] : [quality.values[i]];
    }
    selected = h.id;
    $('#editor').close();
    persist();
    render();
    toast(t('msg.diary.workspace.dynamic.143'));
  }
  $('#entry-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const h = habits.find((h) => h.id === editing.id),
      raw = $('#entry-value').value;
    if (h.id === 'med') {
      saveMedEditor(h, editing.index);
      return;
    }
    if (h.id === 'sleep' && raw === '') {
      if (!$('#sleep-quality').value) {
        $('#entry-value').setCustomValidity(t('msg.diary.workspace.dynamic.144'));
        $('#entry-value').reportValidity();
        return;
      }
      saveEntry(null);
      return;
    }
    const v = h.type === 'note' ? raw.trim() : h.type === 'time' ? parseClock(raw) : Number(raw);
    if (h.type === 'note' && !v) {
      $('#entry-value').setCustomValidity(t('msg.diary.workspace.dynamic.145'));
      $('#entry-value').reportValidity();
      return;
    }
    if (h.type !== 'note' && !Number.isFinite(v)) return;
    saveEntry(v);
  });
  $('#entry-fields').addEventListener('input', () => $('#entry-value')?.setCustomValidity(''));
  $('#entry-operation').addEventListener('change', () => {
    const h = habits.find((h) => h.id === editing.id);
    if ($('#entry-operation').value === 'append')
      $('#entry-value').value = ['note', 'time'].includes(h.type) ? '' : h.type === 'choice' ? '1' : '';
    else
      $('#entry-value').value =
        h.type === 'time'
          ? h.values[editing.index] == null
            ? ''
            : clock(h.values[editing.index])
          : ((h.aggregation === 'mean' ? h.logs[editing.index].at(-1) : h.values[editing.index]) ?? '');
  });
  $('#entry-missed').addEventListener('click', () => saveEntry(0));
  $('#entry-clear').addEventListener('click', () => {
    const h = habits.find((x) => x.id === editing.id);
    if (h.id === 'med') {
      h.medSlots[editing.index] = [null, null];
    }
    saveEntry(null, true);
  });
  document.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit]'),
      about = e.target.closest('[data-about]'),
      day = e.target.closest('[data-open-day]');
    if (edit) openEntry(edit.dataset.edit, edit.dataset.entryIndex == null ? 13 : Number(edit.dataset.entryIndex));
    if (about) openHabit(about.dataset.about);
    if (day) openDay(Number(day.dataset.openDay));
  });
  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-share]')) {
      habits.find((h) => h.id === e.target.dataset.share).shared = e.target.checked;
      persist();
      render();
      toast(t('msg.diary.workspace.dynamic.146'));
    }
  });
  $('#calendar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-history]');
    if (b) openDay(Number(b.dataset.index));
  });
  $('#audience').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) {
      mode = b.dataset.mode;
      document.querySelectorAll('dialog[open]').forEach((d) => d.close());
      render();
    }
  });
  $('#period').addEventListener('change', render);
  $('#history-period').addEventListener('change', renderHabitCalendar);
  $('#metric').addEventListener('change', () => {
    selected = $('#metric').value;
    renderChart();
    renderInsights();
  });
  document
    .querySelectorAll('[data-close]')
    .forEach((b) => b.addEventListener('click', () => document.getElementById(b.dataset.close).close()));
  function showField(selector, show) {
    const el = $(selector);
    el.hidden = !show;
    el.querySelectorAll('input,select,textarea').forEach((input) => {
      input.disabled = !show;
    });
  }
  function updateBuilder(typeChanged = false) {
    const type = $('#habit-type').value;
    if (typeChanged) {
      $('#habit-unit').innerHTML = unitLists[type]
        .map(([id, label]) => `<option value="${id}">${label}</option>`)
        .join('');
      const choices =
        type === 'check'
          ? ['any']
          : type === 'note'
            ? ['notes']
            : ['time', 'choice'].includes(type)
              ? ['last']
              : ['sum', 'last', 'mean', 'max', 'min'];
      $('#habit-aggregation').innerHTML = choices
        .map((value) => `<option value="${value}">${aggregations[value]}</option>`)
        .join('');
      $('#habit-aggregation').value = ['measure', 'time', 'choice'].includes(type)
        ? 'last'
        : type === 'scale'
          ? 'mean'
          : choices[0];
      $('#habit-goal').value = ['note', 'choice', 'measure', 'time', 'scale'].includes(type) ? 'none' : 'min';
    }
    const noNumeric = ['note', 'choice'].includes(type),
      goal = $('#habit-goal').value;
    showField('#habit-unit-label', !['note', 'choice', 'check'].includes(type));
    showField('#custom-unit-label', ['count', 'measure'].includes(type) && $('#habit-unit').value === 'custom');
    $('#habit-custom-unit').required = !$('#custom-unit-label').hidden;
    showField('#signed-label', type === 'measure');
    showField('#scale-fields', type === 'scale');
    showField('#choice-fields', type === 'choice');
    $('#habit-choices').required = type === 'choice';
    showField('#goal-label', !noNumeric && type !== 'check');
    showField('#target-label', !noNumeric && type !== 'check' && goal !== 'none');
    showField('#upper-label', !noNumeric && type !== 'check' && goal === 'range');
    $('#target-caption').textContent =
      goal === 'range' ? t('msg.diary.workspace.dynamic.147') : t('msg.diary.workspace.dynamic.148');
    const time = type === 'time';
    ['#habit-target', '#habit-upper'].forEach((selector) => {
      const input = $(selector);
      input.type = time ? 'time' : 'number';
      input.required = !input.disabled;
      if (!time) {
        input.step = ['count', 'scale'].includes(type) ? '1' : 'any';
        input.min =
          type === 'scale'
            ? $('#scale-min').value
            : type === 'measure' && $('#habit-signed').checked
              ? '-1000000000'
              : '0';
        input.max = type === 'scale' ? $('#scale-max').value : '1000000000';
      } else {
        input.removeAttribute('min');
        input.removeAttribute('max');
        input.step = '60';
      }
    });
    if (typeChanged) {
      $('#habit-target').value = time ? '23:00' : type === 'duration' ? '15' : type === 'scale' ? '3' : '1';
      $('#habit-upper').value = time
        ? '01:00'
        : type === 'duration'
          ? '30'
          : type === 'scale'
            ? $('#scale-max').value
            : '2';
    }
    showField('#interval-label', $('#habit-schedule').value === 'interval');
    showField('#weekday-fields', $('#habit-schedule').value === 'weekdays');
    $('#habit-interval').required = !$('#interval-label').hidden;
    $('#aggregation-hint').textContent =
      type === 'time'
        ? t('msg.diary.workspace.dynamic.149')
        : type === 'choice'
          ? t('msg.diary.workspace.dynamic.150')
          : type === 'note'
            ? t('msg.diary.workspace.dynamic.151')
            : type === 'check'
              ? t('msg.diary.workspace.dynamic.152')
              : `${t('msg.diary.workspace.dynamic.153')} ${aggregations[$('#habit-aggregation').value]}. ${t('msg.diary.workspace.dynamic.154')}`;
    try {
      const draft = readBuilder();
      $('#habit-preview').textContent =
        `${draft.name || t('msg.diary.workspace.dynamic.155')} · ${typeNames[draft.type]} · ${goalLabel(draft)} · ${scheduleLabel(draft)} · ${aggregations[draft.aggregation]}.`;
    } catch (error) {
      $('#habit-preview').textContent = error.message;
    }
  }
  function readBuilder() {
    const type = $('#habit-type').value,
      name = $('#habit-name').value.trim();
    const chosenUnit = $('#habit-unit').value;
    const unit =
      chosenUnit === 'custom'
        ? $('#habit-custom-unit').value.trim()
        : unitLists[type].find(([id]) => id === chosenUnit)?.[1] || '';
    if (['count', 'measure'].includes(type) && chosenUnit === 'custom' && !unit)
      throw Error(t('msg.diary.workspace.dynamic.156'));
    const minimum =
      type === 'scale' ? Number($('#scale-min').value) : type === 'measure' && $('#habit-signed').checked ? -1e9 : 0;
    const maximum =
      type === 'scale' ? Number($('#scale-max').value) : type === 'time' ? 1439 : type === 'check' ? 1 : 1e9;
    if (
      type === 'scale' &&
      (!Number.isInteger(minimum) ||
        !Number.isInteger(maximum) ||
        minimum >= maximum ||
        Math.abs(minimum) > 1e6 ||
        Math.abs(maximum) > 1e6)
    )
      throw Error(t('msg.diary.workspace.dynamic.157'));
    const choices =
      type === 'choice'
        ? $('#habit-choices')
            .value.split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    if (type === 'choice' && (choices.length < 2 || choices.length > 12 || choices.some((s) => s.length > 45)))
      throw Error(t('msg.diary.workspace.dynamic.158'));
    if (type === 'choice' && new Set(choices.map((s) => s.toLocaleLowerCase('ru'))).size !== choices.length)
      throw Error(t('msg.diary.workspace.dynamic.159'));
    const goal = type === 'check' ? 'min' : ['note', 'choice'].includes(type) ? 'none' : $('#habit-goal').value;
    const target =
      type === 'check'
        ? 1
        : goal === 'none'
          ? null
          : type === 'time'
            ? parseClock($('#habit-target').value)
            : Number($('#habit-target').value);
    const upper = type === 'time' ? parseClock($('#habit-upper').value) : Number($('#habit-upper').value);
    if (goal !== 'none' && (!Number.isFinite(target) || target < minimum || target > maximum))
      throw Error(t('msg.diary.workspace.dynamic.160'));
    if (['count', 'scale'].includes(type) && goal !== 'none' && !Number.isInteger(target))
      throw Error(t('msg.diary.workspace.dynamic.161'));
    if (
      goal === 'range' &&
      (!Number.isFinite(upper) || upper < minimum || upper > maximum || (type !== 'time' && upper < target))
    )
      throw Error(t('msg.diary.workspace.dynamic.162'));
    if (['count', 'scale'].includes(type) && goal === 'range' && !Number.isInteger(upper))
      throw Error(t('msg.diary.workspace.dynamic.163'));
    const startValue = $('#habit-start').value,
      startIndex = indexOfDate(startValue);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startValue) || startValue > today)
      throw Error(t('msg.diary.workspace.start_error'));
    const schedule = $('#habit-schedule').value,
      interval = Number($('#habit-interval').value),
      weekdays = [...document.querySelectorAll('[name="weekday"]:checked')].map((el) => Number(el.value));
    if (schedule === 'interval' && (!Number.isInteger(interval) || interval < 1 || interval > 365))
      throw Error(t('msg.diary.workspace.dynamic.164'));
    if (schedule === 'weekdays' && !weekdays.length) throw Error(t('msg.diary.workspace.dynamic.165'));
    return {
      name,
      type,
      unit,
      unitId: chosenUnit,
      minimum,
      maximum,
      step: ['count', 'scale'].includes(type) ? 1 : 'any',
      goal,
      target,
      range: goal === 'range' ? [target, upper] : null,
      aggregation: $('#habit-aggregation').value,
      schedule,
      startIndex,
      startDay: startValue,
      interval,
      weekdays,
      choices,
      shared: $('#habit-share').checked,
    };
  }
  $('#add').addEventListener('click', () => {
    $('#builder-error').hidden = true;
    updateBuilder();
    $('#creator').showModal();
  });
  $('#habit-form').addEventListener('input', () => {
    $('#builder-error').hidden = true;
    updateBuilder();
  });
  $('#habit-form').addEventListener('change', (e) => {
    updateBuilder(e.target.id === 'habit-type');
  });
  $('#habit-form').addEventListener('submit', (e) => {
    e.preventDefault();
    try {
      const config = readBuilder();
      if (!config.name) throw Error(t('msg.diary.workspace.dynamic.166'));
      const h = {
        ...config,
        id: `custom-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        icon: '✧',
        color: '#798eaa',
        tint: '#edf1f8',
        values: Array(14).fill(null),
        logs: Array.from({ length: 14 }, () => []),
      };
      attachDateView(h);
      habits.push(h);
      selected = h.id;
      persist();
      $('#creator').close();
      $('#habit-form').reset();
      updateBuilder(true);
      render();
      toast(t('msg.diary.workspace.dynamic.167'));
    } catch (error) {
      $('#builder-error').textContent = error.message;
      $('#builder-error').hidden = false;
      $('#builder-error').scrollIntoView({ block: 'nearest' });
    }
  });
  const presets = {
    water: {
      name: t('msg.diary.workspace.dynamic.168'),
      type: 'measure',
      unit: 'ml',
      goal: 'min',
      target: 1500,
      aggregation: 'sum',
    },
    walk: {
      name: t('msg.diary.workspace.dynamic.169'),
      type: 'duration',
      unit: 'minutes',
      goal: 'min',
      target: 20,
      aggregation: 'sum',
    },
    energy: {
      name: t('msg.diary.workspace.dynamic.170'),
      type: 'scale',
      unit: 'points',
      goal: 'none',
      aggregation: 'last',
    },
    bed: {
      name: t('msg.diary.workspace.dynamic.171'),
      type: 'time',
      unit: 'clock',
      goal: 'range',
      target: '23:00',
      upper: '01:00',
      aggregation: 'last',
    },
    note: {
      name: t('msg.diary.workspace.dynamic.172'),
      type: 'note',
      unit: 'text',
      goal: 'none',
      aggregation: 'notes',
    },
  };
  document.querySelectorAll('[data-preset]').forEach((button) =>
    button.addEventListener('click', () => {
      const p = presets[button.dataset.preset];
      $('#habit-name').value = p.name;
      $('#habit-type').value = p.type;
      updateBuilder(true);
      $('#habit-unit').value = p.unit;
      $('#habit-goal').value = p.goal;
      $('#habit-aggregation').value = p.aggregation;
      updateBuilder();
      if (p.target != null) $('#habit-target').value = p.target;
      if (p.upper != null) $('#habit-upper').value = p.upper;
      updateBuilder();
    }),
  );
  function renderReminder() {
    $('#reminder-frequency').value = reminder.frequency;
    $('#reminder-time').value = reminder.time;
    $('#reminder-summary').textContent =
      reminder.frequency === 'off'
        ? t('msg.diary.workspace.dynamic.173')
        : `${reminder.frequency === 'daily' ? t('msg.diary.workspace.dynamic.174') : t('msg.diary.workspace.dynamic.175')} ${t('msg.diary.workspace.dynamic.176')} ${reminder.time}`;
    $('#reminders').hidden = mode === 'doctor';
  }
  $('#reminders').addEventListener('click', () => $('#reminder-dialog').showModal());
  $('#reminder-form').addEventListener('submit', (e) => {
    e.preventDefault();
    reminder = { frequency: $('#reminder-frequency').value, time: $('#reminder-time').value };
    renderReminder();
    persist();
    $('#reminder-dialog').close();
    toast(t('msg.diary.workspace.dynamic.177'));
  });
  function allNotes() {
    const ordinary = (
      mode === 'doctor' ? sharedState.dayNotes.map((n) => ({ ...n, index: indexOfDate(n.day) })) : journalNotes
    )
      .filter((n) => mode === 'patient' || n.shared)
      .map((n) => ({ ...n, source: 'day', sourceName: t('msg.diary.workspace.dynamic.178') }));
    const fromHabits = visible()
      .filter((h) => h.type === 'note')
      .flatMap((h) =>
        Object.entries((mode === 'doctor' ? sharedState : state).entries[h.id] || {}).flatMap(([day, entries]) =>
          entries.map((text, k) => ({
            id: `${h.id}-${day}-${k}`,
            habitId: h.id,
            index: indexOfDate(day),
            order: k,
            text,
            shared: h.shared,
            source: 'habit',
            sourceName: h.name,
          })),
        ),
      );
    return [...ordinary, ...fromHabits].sort((a, b) => b.index - a.index || b.order - a.order);
  }
  function noteHtml(note, full = true) {
    const text = full ? note.text : note.text.length > 135 ? note.text.slice(0, 135) + '…' : note.text;
    return `<article class="note-preview" data-note-id="${esc(note.id)}"><div class="note-preview-head"><button type="button" class="link" data-open-day="${note.index}">${esc(dayLabel(note.index).split(',')[0])}</button>${accessBadge(note.shared)}</div><p>${esc(text)}</p><span class="note-source">${esc(note.sourceName)}</span></article>`;
  }
  function renderNotes() {
    const notes = allNotes();
    $('#recent-notes').innerHTML =
      notes
        .slice(0, 3)
        .map((n) => noteHtml(n, false))
        .join('') || t('msg.diary.workspace.dynamic.179');
    if ($('#notes-dialog').open) renderAllNotes();
  }
  function renderAllNotes() {
    const query = $('#note-search').value.trim().toLocaleLowerCase('ru'),
      source = $('#note-source').value,
      from = $('#note-from').value;
    const notes = allNotes().filter(
      (n) =>
        (!query ||
          n.text.toLocaleLowerCase('ru').includes(query) ||
          n.sourceName.toLocaleLowerCase('ru').includes(query)) &&
        (source === 'all' || n.source === source) &&
        (!from || dateAt(n.index) >= from),
    );
    $('#note-results-count').textContent = `${t('msg.diary.workspace.dynamic.180')} ${notes.length}`;
    $('#note-results').innerHTML = notes.map((n) => noteHtml(n)).join('') || t('msg.diary.workspace.dynamic.181');
  }
  function addNote(index, text, shared) {
    text = text.trim();
    if (!text) return false;
    journalNotes.push({
      id: `day-note-${Date.now()}-${Math.floor(Math.random() * 1e5)}`,
      index,
      order: Date.now(),
      text,
      shared,
    });
    persist();
    render();
    return true;
  }
  function openDay(index) {
    if ($('#notes-dialog').open) $('#notes-dialog').close();
    drawerHabit = null;
    drawerDay = Math.min(13, index);
    renderDrawer();
    if (!$('#day-drawer').open) $('#day-drawer').showModal();
    renderMonth();
  }
  function openHabit(id) {
    drawerHabit = id;
    renderDrawer();
    if (!$('#day-drawer').open) $('#day-drawer').showModal();
  }
  function drawerRow(h, index) {
    if (mode === 'doctor' && !visible().some((item) => item.id === h.id)) return '';
    const v = h.values[index],
      canEdit =
        mode === 'patient' &&
        index === 13 &&
        index >= h.startIndex &&
        (h.id !== 'med' || medicationRows(index).some((row) => !row.legacy)),
      label = v == null ? t('msg.diary.workspace.dynamic.057') : valueLabel(h, v);
    const recordText =
      h.id === 'med'
        ? medicationRows(index)
            .map(
              (row) => medicationLabel(row) + ' — ' + t('msg.diary.workspace.medication.' + (row.status || 'unknown')),
            )
            .join(' · ')
        : h.id === 'sleep'
          ? `${t('msg.diary.workspace.dynamic.182')} ${valueLabel(
              habits.find((x) => x.id === 'quality'),
              habits.find((x) => x.id === 'quality').values[index],
            )}`
          : null;
    return `<div class="drawer-row"><div><h4>${esc(h.name)}</h4><strong>${esc(label)}</strong>${recordText ? `<p>${esc(recordText)}</p>` : ''}<p>${accessBadge(h.shared)}</p></div>${canEdit ? `<button type="button" class="btn sm" data-edit="${h.id}" data-entry-index="${index}">${v == null ? t('msg.diary.workspace.dynamic.183') : t('msg.diary.workspace.dynamic.184')}</button>` : ''}</div>`;
  }
  function renderDrawer() {
    if (drawerHabit) {
      renderHabitDrawer();
      return;
    }
    const index = drawerDay,
      notes = allNotes().filter((n) => n.index === index);
    $('#drawer-kicker').textContent = t('msg.diary.workspace.dynamic.185');
    $('#drawer-title').textContent = dayLabel(index);
    $('#drawer-nav').hidden = false;
    $('#previous-day').disabled = false;
    $('#next-day').disabled = index >= 13;
    const mood = habits.find((h) => h.id === 'mood'),
      anxiety = habits.find((h) => h.id === 'anxiety'),
      sleep = habits.find((h) => h.id === 'sleep'),
      med = habits.find((h) => h.id === 'med');
    const personal = visible().filter(
      (h) => !h.system && h.type !== 'note' && (scheduled(h, index) || h.values[index] != null),
    );
    $('#drawer-content').innerHTML =
      `${mode === 'patient' && index !== 13 ? '<p class="drawer-privacy">' + t('msg.diary.workspace.history_readonly') + ' <a href="/app?tab=doctor">' + t('msg.diary.workspace.ask_correction') + '</a></p>' : ''}<section class="drawer-section"><h3>${t('msg.diary.workspace.dynamic.193')}</h3>${drawerRow(mood, index)}${drawerRow(anxiety, index)}</section><section class="drawer-section"><h3>${t('msg.diary.workspace.dynamic.194')}</h3>${drawerRow(sleep, index)}${drawerRow(med, index)}</section><section class="drawer-section"><h3>${t('msg.diary.workspace.dynamic.195')}</h3>${personal.map((h) => drawerRow(h, index)).join('') || t('msg.diary.workspace.dynamic.186')}</section><section class="drawer-section"><h3>${t('msg.diary.workspace.dynamic.196')}</h3>${notes.map((n) => `<article class="drawer-note"><p>${esc(n.text)}</p><div class="drawer-note-footer"><span>${esc(n.sourceName)}</span>${mode === 'patient' && n.source === 'day' ? `<label><input type="checkbox" data-note-share="${esc(n.id)}" ${n.shared ? 'checked' : ''}>${t('msg.diary.workspace.dynamic.080')}</label>` : accessBadge(n.shared)}</div></article>`).join('') || t('msg.diary.workspace.dynamic.187')}${mode === 'patient' && index === 13 ? `<form id="drawer-note-form"><label for="drawer-note-text" class="field-label">${t('msg.diary.workspace.dynamic.188')}</label><textarea id="drawer-note-text" rows="3" maxlength="2000" required placeholder="${t('msg.diary.workspace.dynamic.189')}"></textarea><label class="check-label"><input type="checkbox" id="drawer-note-share">${t('msg.diary.workspace.dynamic.190')}</label><button type="submit" class="btn primary">${t('msg.diary.workspace.dynamic.191')}</button></form>` : ''}</section>${mode === 'patient' ? t('msg.diary.workspace.dynamic.192') : ''}`;
  }
  function renderHabitDrawer() {
    const h = visible().find((h) => h.id === drawerHabit);
    if (!h) {
      $('#day-drawer').close();
      drawerHabit = null;
      return;
    }
    $('#drawer-kicker').textContent = t('msg.diary.workspace.dynamic.197');
    $('#drawer-title').textContent = h.name;
    $('#drawer-nav').hidden = true;
    $('#drawer-content').innerHTML = `<section class="drawer-section">${[
      [t('msg.diary.workspace.dynamic.198'), typeNames[h.type]],
      [t('msg.diary.workspace.dynamic.199'), h.unit],
      [t('msg.diary.workspace.dynamic.200'), goalLabel(h)],
      [t('msg.diary.workspace.dynamic.201'), scheduleLabel(h)],
      [t('msg.diary.workspace.dynamic.133'), aggregations[h.aggregation]],
    ]
      .map(([label, value]) => `<div class="drawer-property"><span>${label}</span><strong>${esc(value)}</strong></div>`)
      .join(
        '',
      )}<p class="drawer-privacy">${t('msg.diary.workspace.dynamic.206')}</p>${mode === 'patient' ? `<label class="check-label"><input type="checkbox" data-share="${h.id}" ${h.shared ? 'checked' : ''}>${t('msg.diary.workspace.dynamic.202')}</label><button type="button" class="btn primary" data-edit="${h.id}">${t('msg.diary.workspace.dynamic.203')}</button>` : accessBadge(h.shared)}</section><section class="drawer-section"><h3>${t('msg.diary.workspace.dynamic.207')}</h3>${
      days
        .map((d, index) =>
          h.values[index] == null
            ? ''
            : `<button type="button" class="drawer-record" data-open-day="${index}"><span>${dayLabel(index).split(',')[0]}</span><span>${esc(valueLabel(h, h.values[index]))}</span></button>`,
        )
        .reverse()
        .join('') || t('msg.diary.workspace.dynamic.204')
    }</section>${mode === 'patient' && h.id.startsWith('custom-') ? `<button type="button" class="btn danger" id="delete-diary-habit" data-id="${h.id}">${t('msg.diary.workspace.dynamic.205')}</button>` : ''}`;
  }
  function openMedEditor(h, index) {
    const rows = medicationRows(index);
    if (!rows.length) return;
    $('#entry-fields').innerHTML =
      `<input id="entry-value" type="hidden" value="0"><p class="muted">${t('msg.diary.workspace.medication_note')}</p>${rows.map((row, i) => `<label>${esc(medicationLabel(row))}<select id="med-slot-${i}" ${row.legacy ? 'disabled' : ''}>${['unknown', 'taken', 'skipped', 'later'].map((status) => `<option value="${status}" ${(row.status || 'unknown') === status ? 'selected' : ''}>${t('msg.diary.workspace.medication.' + status)}</option>`).join('')}</select></label>`).join('')}`;
    $('#entry-operation-label').hidden = true;
    $('#entry-missed').hidden = true;
    $('#entry-clear').hidden = true;
    $('#entry-records').textContent = t('msg.diary.workspace.medication_self_report');
    $('#editor').showModal();
  }
  async function saveMedEditor(h, index) {
    const rows = medicationRows(index),
      choices = rows.map((row, i) => ({ row, status: $('#med-slot-' + i).value })).filter(({ row }) => !row.legacy);
    $('#entry-form button[type="submit"]').disabled = true;
    saveStatus('saving', t('msg.diary.workspace.saving'));
    try {
      for (const { row, status } of choices) {
        if ((row.status || 'unknown') === status) continue;
        await request('/api/v1/me/med-marks', 'POST', {
          target: row.target,
          day: dateAt(index),
          slot: row.slot,
          status,
        });
        row.status = status;
      }
      $('#editor').close();
      saveStatus('saved', t('msg.diary.workspace.saved'));
      render();
    } catch (error) {
      saveStatus('error', error.message);
    } finally {
      $('#entry-form button[type="submit"]').disabled = false;
    }
  }
  $('#state-pickers').addEventListener('click', (e) => {
    const b = e.target.closest('[data-state]');
    if (!b || mode === 'doctor') return;
    const h = habits.find((h) => h.id === b.dataset.state),
      v = Number(b.dataset.stateValue);
    h.values[13] = h.values[13] === v ? null : v;
    h.logs[13] = h.values[13] == null ? [] : [h.values[13]];
    selected = h.id;
    persist();
    render();
    toast(h.values[13] == null ? t('msg.diary.workspace.dynamic.208') : t('msg.diary.workspace.dynamic.209'));
  });
  $('#show-unscheduled').addEventListener('click', () => {
    showUnscheduled = !showUnscheduled;
    render();
  });
  $('#history-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-history-mode]');
    if (b) {
      historyMode = b.dataset.historyMode;
      render();
    }
  });
  $('#note-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#day-note').value;
    if (!addNote(13, text, $('#note-share').checked)) {
      $('#day-note').setCustomValidity(t('msg.diary.workspace.dynamic.145'));
      $('#day-note').reportValidity();
      return;
    }
    $('#note-form').reset();
    toast(t('msg.diary.workspace.dynamic.210'));
  });
  $('#day-note').addEventListener('input', () => $('#day-note').setCustomValidity(''));
  $('#all-notes').addEventListener('click', () => {
    renderAllNotes();
    $('#notes-dialog').showModal();
  });
  ['#note-search', '#note-source', '#note-from'].forEach((id) => $(id).addEventListener('input', renderAllNotes));
  $('#previous-day').addEventListener('click', () => {
    drawerDay -= 1;
    renderDrawer();
    renderMonth();
    $('#day-drawer').scrollTop = 0;
  });
  $('#next-day').addEventListener('click', () => {
    drawerDay += 1;
    renderDrawer();
    renderMonth();
    $('#day-drawer').scrollTop = 0;
  });
  $('#day-drawer').addEventListener('close', renderMonth);
  $('#drawer-content').addEventListener('change', (e) => {
    if (e.target.matches('[data-note-share]')) {
      const n = journalNotes.find((n) => n.id === e.target.dataset.noteShare);
      n.shared = e.target.checked;
      if (dateAt(n.index) < stateWindow.from) noteSharing.set(n.id, n.shared);
      persist();
      render();
      toast(t('msg.diary.workspace.dynamic.211'));
    }
  });
  $('#drawer-content').addEventListener('submit', (e) => {
    if (e.target.id !== 'drawer-note-form') return;
    e.preventDefault();
    const text = $('#drawer-note-text').value;
    if (!addNote(drawerDay, text, $('#drawer-note-share').checked)) {
      $('#drawer-note-text').setCustomValidity(t('msg.diary.workspace.dynamic.145'));
      $('#drawer-note-text').reportValidity();
      return;
    }
    toast(t('msg.diary.workspace.dynamic.212'));
  });
  $('#drawer-content').addEventListener('input', (e) => {
    if (e.target.id === 'drawer-note-text') e.target.setCustomValidity('');
  });
  $('#drawer-content').addEventListener('click', (e) => {
    const deleteHabit = e.target.closest('#delete-diary-habit');
    if (deleteHabit) {
      delete state.entries[deleteHabit.dataset.id];
      habits = habits.filter((h) => h.id !== deleteHabit.dataset.id);
      drawerHabit = null;
      $('#day-drawer').close();
      persist();
      render();
      toast(t('msg.diary.workspace.dynamic.213'));
    }
    if (e.target.closest('#discuss-day')) {
      const items = visible()
          .filter((h) => h.values[drawerDay] != null)
          .map((h) => `${h.name}: ${valueLabel(h, h.values[drawerDay])}`),
        notes = allNotes()
          .filter((n) => n.index === drawerDay)
          .map((n) => n.text);
      $('#discussion-text').value =
        `${t('msg.diary.workspace.dynamic.215')} ${formatDate(dateAt(drawerDay))}. ${t('msg.diary.workspace.dynamic.216')}\n\n${items.join('\n')}${notes.length ? t('msg.diary.workspace.dynamic.214') + notes.join('\n') : ''}`;
      $('#discussion-dialog').showModal();
    }
  });
  $('#copy-discussion').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#discussion-text').value);
      toast(t('msg.diary.workspace.dynamic.217'));
    } catch {
      $('#discussion-text').focus();
      $('#discussion-text').select();
      toast(t('msg.diary.workspace.dynamic.218'));
    }
  });

  // вкладки страницы: Сегодня / История / Динамика / Заметки (панели переключаются, ничего не перезагружается)
  const tabNames = ['today', 'history', 'dynamics', 'notes'];
  function setTab(name, focus) {
    if (!tabNames.includes(name)) name = 'today';
    for (const b of document.querySelectorAll('.diary-workspace [role="tab"][data-tab]')) {
      const on = b.dataset.tab === name;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name;
    if (name === 'dynamics') renderChart();
    try {
      history.replaceState(null, '', '#' + name);
    } catch {
      /* адресная строка не обязательна */
    }
  }
  document.querySelector('[role="tablist"]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) setTab(b.dataset.tab);
  });
  document.querySelector('[role="tablist"]').addEventListener('keydown', (e) => {
    const k = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!k) return;
    const current = tabNames.indexOf(
      document.querySelector('.diary-workspace [role="tab"][data-tab][aria-selected="true"]').dataset.tab,
    );
    e.preventDefault();
    setTab(tabNames[(current + k + tabNames.length) % tabNames.length], true);
  });
  // радиогруппы «Как вы сегодня?» и «Тревога»: стрелки переносят выбор, как у обычной радиогруппы
  $('#state-pickers').addEventListener('keydown', (e) => {
    const k = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const current = e.target.closest('[role="radio"]');
    if (!k || !current || mode === 'doctor') return;
    const group = [...current.parentNode.querySelectorAll('[role="radio"]')];
    const next = group[(group.indexOf(current) + k + group.length) % group.length];
    e.preventDefault();
    next.click();
    root
      .querySelector('[data-state="' + next.dataset.state + '"][data-state-value="' + next.dataset.stateValue + '"]')
      ?.focus();
  });

  window.addEventListener('beforeunload', (event) => {
    if ($('[data-diary-save-status]').dataset.state === 'saving') {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  $('#habit-start').defaultValue = today;
  $('#habit-start').value = today;
  $('#habit-start').max = today;
  $('#note-from').max = today;
  $('.date-label').textContent = formatDate(today, { weekday: 'long', day: 'numeric', month: 'long' });
  updateBuilder(true);
  renderReminder();
  render();
  setTab(location.hash.slice(1));
  let chartTimer;
  window.addEventListener('resize', () => {
    clearTimeout(chartTimer);
    chartTimer = setTimeout(() => {
      if (!$('#dynamics').hidden) renderChart();
    }, 150);
  });
  window.addEventListener('hashchange', () => setTab(location.hash.slice(1)));
  root.setAttribute('aria-busy', 'false');
  $('[data-diary-content]').inert = false;
  saveStatus('saved', t('msg.diary.workspace.saved'));
})();
