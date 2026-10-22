'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const days = Array.from({ length: 14 }, (_, i) => 8 + i);
  const seed = () => [
    {
      id: 'sleep',
      name: 'Сон',
      icon: '☾',
      color: '#7979ad',
      tint: '#efedf7',
      unit: 'ч',
      target: 8,
      range: [7, 9],
      schedule: 'daily',
      shared: true,
      system: true,
      plan: 'Личный ориентир: 7–9 часов',
      values: [7.5, 8, 6.5, 7, 8.5, null, 7.5, 8, 7, 6, 8, 7.5, 8, 7.3],
    },
    {
      id: 'med',
      name: 'Лекарства',
      icon: '⊕',
      color: '#6b91b2',
      tint: '#eaf1f8',
      unit: 'приёма',
      target: 2,
      schedule: 'daily',
      shared: true,
      system: true,
      plan: '2 приёма по демоплану',
      values: [2, 2, 2, 1, 2, 2, null, 2, 2, 2, 1, 2, 2, 1],
    },
    {
      id: 'food',
      name: 'Питание',
      icon: '◒',
      color: '#c29c5e',
      tint: '#f8f1e4',
      unit: 'раза',
      target: 3,
      schedule: 'daily',
      shared: false,
      plan: '3 раза в день',
      values: [3, 2, 3, 3, null, 2, 3, 3, 2, 3, 3, 2, 3, 2],
    },
    {
      id: 'walk',
      name: 'Прогулка',
      icon: '↟',
      color: '#679481',
      tint: '#eaf3ed',
      unit: 'мин',
      target: 20,
      schedule: 'alternate',
      shared: true,
      plan: '20 минут через день',
      values: [null, 25, null, 15, null, 0, null, 30, null, 20, null, null, null, null],
    },
    {
      id: 'plants',
      name: 'Полив цветов',
      icon: '♧',
      color: '#83a273',
      tint: '#edf3e8',
      unit: 'раз',
      target: 1,
      schedule: 'weekly',
      shared: false,
      plan: 'По субботам · сегодня не нужно',
      values: [null, null, 1, null, null, null, null, null, null, 1, null, null, null, null],
    },
    {
      id: 'read',
      name: 'Чтение',
      icon: '▤',
      color: '#b78980',
      tint: '#f8eeeb',
      unit: 'мин',
      target: 15,
      schedule: 'daily',
      shared: false,
      plan: '15 минут перед сном',
      values: [15, 20, null, 10, 15, 0, 20, 15, null, 25, 15, 10, 15, null],
    },
  ];
  const storageKey = 'clinical-compass-unified-diary-demo-v1';
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
    check: 'Факт выполнения',
    count: 'Количество',
    duration: 'Длительность',
    measure: 'Измерение',
    scale: 'Шкала',
    time: 'Время суток',
    choice: 'Выбор варианта',
    note: 'Заметка',
  };
  const aggregations = {
    sum: 'сумма за день',
    last: 'последняя запись',
    mean: 'среднее за день',
    max: 'максимум за день',
    min: 'минимум за день',
    any: 'хотя бы одно выполнение',
    notes: 'все заметки за день',
  };
  const unitLists = {
    check: [['flag', 'сделано / нет']],
    count: [
      ['times', 'раз'],
      ['steps', 'шагов'],
      ['pages', 'страниц'],
      ['items', 'штук'],
      ['custom', 'Своя единица…'],
    ],
    duration: [
      ['minutes', 'мин'],
      ['hours', 'ч'],
    ],
    measure: [
      ['ml', 'мл'],
      ['litres', 'л'],
      ['kg', 'кг'],
      ['g', 'г'],
      ['km', 'км'],
      ['m', 'м'],
      ['percent', '%'],
      ['celsius', '°C'],
      ['custom', 'Своя единица…'],
    ],
    scale: [['points', 'баллов']],
    time: [['clock', 'чч:мм']],
    choice: [['choice', 'вариант']],
    note: [['text', 'текст']],
  };
  function initialHabits() {
    const base = seed().map((h) => ({
      ...h,
      type: h.id === 'sleep' ? 'measure' : h.id === 'plants' ? 'check' : h.unit === 'мин' ? 'duration' : 'count',
      goal: h.range ? 'range' : 'min',
      aggregation: h.id === 'sleep' ? 'last' : h.id === 'plants' ? 'any' : 'sum',
      minimum: 0,
      maximum: h.id === 'sleep' ? 24 : h.id === 'med' ? 2 : 1e9,
      step: h.id === 'sleep' ? 0.1 : 1,
      logs: h.values.map((v) => (v == null ? [] : [v])),
    }));
    const sleep = base.find((h) => h.id === 'sleep');
    sleep.goal = 'none';
    sleep.target = null;
    sleep.range = null;
    sleep.plan = 'Длительность и качество · без оценки выполнения';
    sleep.values[13] = 7.5;
    sleep.logs[13] = [7.5];
    const med = base.find((h) => h.id === 'med');
    med.medSlots = med.values.map((v) =>
      v == null ? [null, null] : [v > 0 ? 'taken' : 'skipped', v > 1 ? 'taken' : null],
    );
    const states = [
      {
        id: 'mood',
        name: 'Настроение',
        icon: '◉',
        unit: 'из 5',
        minimum: 1,
        maximum: 5,
        color: '#6389ce',
        tint: '#eef3fc',
        values: [2, 2, 3, 3, null, 3, 4, 3, 4, 4, 5, 4, 4, null],
      },
      {
        id: 'anxiety',
        name: 'Тревога',
        icon: '≈',
        unit: 'из 2',
        minimum: 0,
        maximum: 2,
        color: '#b49570',
        tint: '#f7f1e9',
        values: [2, 1, 1, 1, null, 1, 0, 1, 0, 1, 0, 0, 1, null],
      },
      {
        id: 'quality',
        name: 'Качество сна',
        icon: '☾',
        unit: 'из 3',
        minimum: 1,
        maximum: 3,
        color: '#8b82b6',
        tint: '#f2eff8',
        values: [1, 1, 2, 2, 2, null, 3, 2, 2, 3, 3, 2, 3, null],
      },
    ].map((h) => ({
      ...h,
      type: 'scale',
      goal: 'none',
      target: null,
      range: null,
      step: 1,
      schedule: 'daily',
      shared: true,
      system: true,
      aggregation: 'last',
      group: 'state',
      logs: h.values.map((v) => (v == null ? [] : [v])),
    }));
    return [...states, ...base];
  }
  const initialNotes = () => [
    {
      id: 'demo-note-1',
      index: 12,
      order: 1,
      text: 'После прогулки зашла в любимую кофейню. Хочется запомнить этот спокойный вечер.',
      shared: true,
    },
    {
      id: 'demo-note-2',
      index: 10,
      order: 1,
      text: 'Весь день торопилась. На завтра оставлю побольше свободного времени.',
      shared: false,
    },
    {
      id: 'demo-note-3',
      index: 7,
      order: 1,
      text: 'Гуляла с подругой, долго разговаривали. Рада, что всё-таки выбралась.',
      shared: true,
    },
    {
      id: 'demo-note-4',
      index: 3,
      order: 1,
      text: 'Вечером читала несколько страниц. Приятно снова возвращаться к книге.',
      shared: false,
    },
  ];
  let journalNotes = initialNotes(),
    historyMode = 'state',
    showUnscheduled = false,
    drawerDay = 13,
    drawerHabit = null;
  const moodNames = ['Очень тяжело', 'Так себе', 'Нормально', 'Хорошо', 'Отлично'];
  const anxietyNames = ['Нет', 'Немного', 'Сильная'];
  const qualityNames = ['Плохой', 'Нормальный', 'Хороший'];
  let habits = initialHabits(),
    mode = 'patient',
    selected = 'mood',
    editing = null,
    toastTimer;
  let reminder = { frequency: 'daily', time: '19:00' };
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    if (
      saved?.version === 2 &&
      Array.isArray(saved.habits) &&
      saved.habits.every(
        (h) => Array.isArray(h.values) && h.values.length === 14 && Array.isArray(h.logs) && h.logs.length === 14,
      )
    ) {
      habits = saved.habits;
      reminder = saved.reminder || reminder;
      journalNotes = Array.isArray(saved.notes) ? saved.notes : initialNotes();
    }
  } catch {
    /* Storage can be disabled for a local file. The page still works. */
  }
  function persist() {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ version: 2, habits, reminder, notes: journalNotes }));
    } catch {
      toast('Браузер не разрешил сохранение: изменения останутся до обновления страницы.');
    }
  }
  const visible = () => habits.filter((h) => mode === 'patient' || h.shared);
  const weekday = (i) => new Date(Date.UTC(2026, 9, days[i])).getUTCDay();
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
    done: 'По ориентиру',
    partial: 'Вне ориентира',
    missed: 'Не выполнено',
    missing: 'Нет записи',
    off: 'Не запланировано',
    recorded: 'Записано, без оценки',
  };
  function valueLabel(h, v) {
    if (v == null) return 'Нет записи';
    if (h.id === 'mood') return moodNames[v - 1];
    if (h.id === 'anxiety') return anxietyNames[v];
    if (h.id === 'quality') return qualityNames[v - 1];
    if (h.type === 'time') return clock(v);
    if (h.type === 'check') return v === 1 ? 'Сделано' : 'Не выполнено';
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
    if (h.schedule === 'daily') return 'каждый день';
    if (h.schedule === 'free') return 'по желанию';
    if (h.schedule === 'interval') return `каждые ${h.interval} дн., с ${days[h.startIndex]} октября`;
    if (h.schedule === 'weekdays')
      return h.weekdays.map((n) => ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][n]).join(', ');
    return h.schedule === 'alternate' ? 'через день' : 'по субботам';
  }
  function goalLabel(h) {
    if (h.type === 'check') return 'Отметить выполнение';
    if (h.goal === 'none') return 'Без цели и оценки';
    const label = (v) => (h.type === 'time' ? clock(v) : `${number(v)} ${h.unit}`);
    if (h.goal === 'range')
      return `${label(h.range[0])} — ${label(h.range[1])}${h.type === 'time' && h.range[0] > h.range[1] ? ' (через полночь)' : ''}`;
    return `${{ min: 'Не меньше', max: 'Не больше', exact: 'Ровно' }[h.goal]} ${label(h.target)}`;
  }
  function planLabel(h) {
    return h.plan || `${goalLabel(h)} · ${scheduleLabel(h)}`;
  }
  const accessBadge = (shared) =>
    `<span class="visibility-label ${shared ? '' : 'private'}">${shared ? 'Видно специалисту' : 'Только мне'}</span>`;
  const shortNumber = (value) => number(Number(value.toPrecision(5)));
  const dayLabel = (index) =>
    index === 13 ? 'Сегодня, 21 октября' : index === 12 ? 'Вчера, 20 октября' : `${index + 8} октября`;
  function moodFace(i) {
    const mouths = ['M6 16 Q12 9 18 16', 'M7 15 Q12 12 17 15', 'M7 14 H17', 'M6 12 Q12 18 18 12', 'M6 11 Q12 20 18 11'];
    return `<svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true"><circle cx="8" cy="8" r="1" fill="white"/><circle cx="16" cy="8" r="1" fill="white"/><path d="${mouths[i]}" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round"/></svg>`;
  }
  function statePickers() {
    const mood = habits.find((h) => h.id === 'mood'),
      anxiety = habits.find((h) => h.id === 'anxiety');
    const selectedMood = mood.values[13],
      selectedAnxiety = anxiety.values[13];
    $('#state-pickers').innerHTML =
      `<div><div class="state-group-label">Настроение <small>· без оценки выполнения</small></div><div class="mood-buttons" role="group" aria-label="Настроение">${moodNames.map((name, i) => `<button data-state="mood" data-state-value="${i + 1}" aria-pressed="${selectedMood === i + 1}" ${mode === 'doctor' ? 'disabled' : ''}><span class="mood-face mood-${i + 1}" aria-hidden="true">${moodFace(i)}</span>${name}</button>`).join('')}</div></div><div class="anxiety-row"><span class="state-group-label">Тревога</span><div class="rating-buttons" role="group" aria-label="Тревога">${anxietyNames.map((name, i) => `<button data-state="anxiety" data-state-value="${i}" aria-pressed="${selectedAnxiety === i}" ${mode === 'doctor' ? 'disabled' : ''}>${name}</button>`).join('')}</div></div>`;
  }
  function essentialCards() {
    const sleep = habits.find((h) => h.id === 'sleep'),
      quality = habits.find((h) => h.id === 'quality'),
      med = habits.find((h) => h.id === 'med');
    $('#essential-cards').innerHTML =
      `<article class="panel essential-card" data-habit="sleep"><div class="card-top"><span class="habit-icon" style="--color:#8b82b6;--tint:#f2eff8" aria-hidden="true">☾</span><span class="card-title">Сон</span></div><div class="card-value"><strong>${sleep.values[13] == null ? '—' : number(sleep.values[13])}</strong><span>часов</span></div><div class="sleep-quality">${quality.values[13] == null ? 'Качество пока не отмечено' : `${qualityNames[quality.values[13] - 1]} сон`}</div><div class="card-bottom">${mode === 'patient' ? '<button data-edit="sleep">Отметить сон</button>' : ''}${accessBadge(true)}</div></article><article class="panel essential-card" data-habit="med"><div class="card-top"><span class="habit-icon" style="--color:#6b91b2;--tint:#eaf1f8" aria-hidden="true">⊕</span><span class="card-title">Лекарства</span></div><div class="card-value"><strong>${med.values[13] == null ? '—' : med.values[13]}</strong><span>из 2 приёмов</span></div><div class="card-plan">По демонстрационному плану</div><div class="med-slots">${med.medSlots[13].map((v, i) => `<span class="med-slot ${v || 'pending'}">${v === 'taken' ? '✓' : v === 'skipped' ? '−' : '○'} ${i === 0 ? '08:00' : '20:00'}</span>`).join('')}</div><div class="card-bottom">${mode === 'patient' ? '<button data-edit="med">Отметить приём</button>' : ''}${accessBadge(true)}</div></article>`;
  }
  function personalCard(h) {
    const v = h.values[13],
      textual = ['note', 'choice'].includes(h.type);
    const main = v == null ? '—' : numericTypes.includes(h.type) ? shortNumber(v) : valueLabel(h, v);
    const progress = v == null ? 0 : h.goal === 'none' ? 100 : meets(h, v) ? 100 : 50;
    return `<article class="habit-card" data-habit="${h.id}" style="--color:${h.color};--tint:${h.tint};--progress:${progress}%"><div class="card-top"><span class="habit-icon" aria-hidden="true">${h.icon}</span><span class="card-title">${esc(h.name)}</span><button class="habit-more" data-about="${h.id}" aria-label="Правила и история: ${esc(h.name)}">⋯</button></div><div class="card-value"><strong class="${textual ? 'text-value' : ''}">${esc(main.length > 70 ? main.slice(0, 70) + '…' : main)}</strong><span>${v == null ? 'пока нет записи' : numericTypes.includes(h.type) ? esc(h.unit) : ''}</span></div><div class="card-plan">${esc(planLabel(h))}</div><div class="track"><div class="track-fill"></div></div><div class="card-bottom">${mode === 'patient' ? `<button data-edit="${h.id}">${v == null ? '+ Отметить' : 'Внести / изменить'}</button>` : ''}${accessBadge(h.shared)}</div></article>`;
  }
  function render() {
    const shown = visible();
    if (!shown.some((h) => h.id === selected)) selected = shown[0]?.id || '';
    $('#doctor-notice').hidden = mode !== 'doctor';
    document.body.classList.toggle('doctor-preview', mode === 'doctor');
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
    $('#cards').innerHTML = cards.map(personalCard).join('') || '<p class="muted">Личных привычек на сегодня нет.</p>';
    $('#show-unscheduled').hidden = !off.length;
    $('#show-unscheduled').textContent = showUnscheduled
      ? 'Скрыть привычки вне плана'
      : `Ещё ${off.length} вне плана на сегодня ↓`;
    $('#today-caption').textContent = mode === 'doctor' ? 'Только открытые пациентом' : 'Не обязательно отмечать всё';
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
    const attention = visible().some((h) => h.id === 'food')
      ? 'В этом примере настроение постепенно улучшается, а регулярное питание пока даётся сложнее.'
      : 'В этом примере настроение во второй половине периода выше, а часть отметок приёмов отсутствует.';
    const next =
      mode === 'patient'
        ? 'Можно попробовать одно напоминание в удобное время.'
        : 'Можно обсудить с пациентом, какие ориентиры ему удобны.';
    $('#interpretation-summary').textContent =
      `${attention} По новым привычкам ещё рано судить об устойчивой динамике. ${next}`;
  }
  function renderMonth() {
    const mood = habits.find((h) => h.id === 'mood'),
      notes = allNotes();
    let html =
      ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => `<span class="dow">${d}</span>`).join('') +
      '<span></span>'.repeat(3);
    for (let day = 1; day <= 31; day++) {
      const index = day - 8,
        value = index >= 0 && index <= 13 ? mood.values[index] : null,
        hasNotes = notes.some((n) => n.index === index);
      html += `<button class="month-day ${value == null ? 'empty' : ''} ${day === 21 ? 'today' : ''}" ${value == null ? '' : `data-mood="${value}"`} data-open-day="${index}" aria-label="${day} октября: ${value == null ? 'нет отметки настроения' : moodNames[value - 1]}${hasNotes ? ', есть заметка' : ''}" aria-pressed="${$('#day-drawer').open && !drawerHabit && drawerDay === index}" ${day > 21 ? 'disabled' : ''}>${day}${hasNotes ? '<span class="has-note">·</span>' : ''}</button>`;
    }
    $('#month-calendar').innerHTML = html;
  }
  function renderHabitCalendar() {
    const start = 14 - Number($('#history-period').value),
      shown = visible().filter((h) => h.group !== 'state');
    $('#calendar').innerHTML = `<thead><tr><th scope="col">Октябрь</th>${days
      .slice(start)
      .map((d) => `<th scope="col" class="${d === 21 ? 'today-col' : ''}">${d}</th>`)
      .join('')}</tr></thead><tbody>${shown
      .map(
        (h) =>
          `<tr><th scope="row">${h.icon} ${esc(h.name)}</th>${days
            .slice(start)
            .map((d, k) => {
              const index = k + start,
                v = h.values[index],
                s = status(h, index),
                compact =
                  v == null
                    ? s === 'off'
                      ? '·'
                      : '—'
                    : h.type === 'check'
                      ? v
                        ? '✓'
                        : '0'
                      : h.type === 'note'
                        ? `✎${h.logs[index].length}`
                        : h.type === 'choice'
                          ? h.choices[v - 1].slice(0, 3)
                          : h.type === 'time'
                            ? clock(v)
                            : shortNumber(v);
              return `<td><button class="cell ${s}" data-history="${h.id}" data-index="${index}" aria-label="${esc(h.name)}, ${d} октября: ${statusNames[s]}${v == null ? '' : `, ${esc(valueLabel(h, v))}`}" title="${esc(v == null ? statusNames[s] : valueLabel(h, v))}">${esc(compact)}</button></td>`;
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
      ? 'Самооценка пациента. Здесь нет оценки выполнения.'
      : h.goal === 'none'
        ? 'Вы выбрали наблюдение без цели.'
        : `Ваш ориентир: ${goalLabel(h).toLocaleLowerCase('ru')}.`;
    const half = Math.floor(n / 2),
      first = h.values.slice(start, start + half).filter((v) => v != null),
      second = h.values.slice(start + half).filter((v) => v != null);
    const mean = (list) => number(Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10);
    const comparison =
      numericTypes.includes(h.type) && first.length >= 2 && second.length >= 2
        ? `<strong>${mean(first)} → ${mean(second)} ${esc(h.unit)}</strong>средние первой и второй половин периода: ${first.length} и ${second.length} заполненных дней.`
        : `<strong>${n - recorded} без отметки</strong>в расчётах они остаются пропусками.`;
    $('#insights').innerHTML =
      `<div class="insight"><strong>${recorded} из ${n} дней</strong>есть записи по выбранному показателю.</div><div class="insight">${comparison}</div><div class="insight"><strong>${isState ? 'Наблюдение за собой' : h.goal === 'none' ? 'Без оценки' : 'Личный ориентир'}</strong>${esc(descriptor)}</div>`;
  }
  function renderChart() {
    const h = habits.find((h) => h.id === selected);
    if (!h) {
      $('#chart').innerHTML = '';
      $('#chart-value').textContent = 'Нет данных';
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
    if (!values.length) $('#chart-value').textContent = 'Пока нет записей';
    else if (h.type === 'note')
      $('#chart-value').textContent = `${h.logs.slice(start).reduce((a, b) => a + b.length, 0)} заметок`;
    else if (['time', 'choice'].includes(h.type)) $('#chart-value').textContent = valueLabel(h, values.at(-1));
    else if (h.type === 'check') $('#chart-value').textContent = `${values.filter((v) => v === 1).length} выполнений`;
    else
      $('#chart-value').textContent =
        `${number(h.group === 'state' ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : Number((values.reduce((a, b) => a + b, 0) / values.length).toPrecision(4)))} ${h.unit}`;
    $('#chart-description').textContent =
      `${numericTypes.includes(h.type) ? 'среднее по заполненным дням' : ['time', 'choice'].includes(h.type) ? 'последняя запись' : 'за выбранный период'} · ${values.length} дней с данными${hasGoal && h.schedule !== 'free' ? ` · ${done} из ${count} дней по ориентиру` : ''}`;
    $('#chart-footnote').textContent =
      h.type === 'note'
        ? 'На графике — количество заметок по дням. Содержание можно посмотреть в таблице ниже.'
        : h.type === 'choice'
          ? 'Варианты — категории, их высота не означает «лучше» или «хуже». Среднее не рассчитывается.'
          : hasGoal
            ? 'Пунктир или полоса — ваш личный ориентир. Это не медицинская норма. Пробелы не превращаются в нули.'
            : 'Наблюдение без оценки выполнения. Серый штрих — нет записи.';
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
    const left = h.type === 'choice' ? 90 : 45,
      w = 720,
      top = 22,
      bottom = 165,
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
          `<line x1="${left}" x2="710" y1="${y(v)}" y2="${y(v)}" stroke="#e9efec"/><text x="${left - 9}" y="${y(v) + 4}" text-anchor="end" fill="#7d8f87" font-size="10">${esc(label)}</text>`,
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
          ([a, b]) => `<rect x="${left}" y="${y(b)}" width="${710 - left}" height="${y(a) - y(b)}" fill="${h.tint}"/>`,
        )
        .join('');
    } else if (hasGoal && Number.isFinite(h.target))
      goal = `<line x1="${left}" x2="710" y1="${y(h.target)}" y2="${y(h.target)}" stroke="${h.color}" stroke-dasharray="5 5"/>`;
    const base = y(Math.min(high, Math.max(low, 0)));
    const lineChart = h.group === 'state' || h.id === 'sleep';
    let path = '',
      connected = false;
    if (lineChart)
      days.slice(start).forEach((_, k) => {
        const v = plotted(k + start);
        if (v == null) {
          connected = false;
          return;
        }
        path += `${connected ? 'L' : 'M'}${left + k * step + step / 2},${y(v)} `;
        connected = true;
      });
    const trendLine = lineChart
      ? `<path d="${path}" fill="none" stroke="${h.color}" stroke-width="2" stroke-linejoin="round"/>`
      : '';
    const bars = days
      .slice(start)
      .map((d, k) => {
        const i = k + start,
          v = plotted(i),
          x = left + k * step + step * 0.24,
          bw = step * 0.52;
        return `${v == null ? `<line x1="${x}" x2="${x + bw}" y1="${bottom - 2}" y2="${bottom - 2}" stroke="#bcc9c1" stroke-width="3"/>` : h.type === 'choice' || lineChart ? `<circle cx="${x + bw / 2}" cy="${y(v)}" r="5" fill="${h.color}"/>` : `<rect x="${x}" y="${Math.min(base, y(v)) - (v === 0 ? 3 : 0)}" width="${bw}" height="${Math.max(3, Math.abs(base - y(v)))}" rx="3" fill="${h.color}" opacity="${i === 13 ? 1 : 0.65}"><title>${esc(valueLabel(h, h.values[i]))}</title></rect>`}<text x="${x + bw / 2}" y="188" text-anchor="middle" fill="#7d8f87" font-size="11">${d}</text>`;
      })
      .join('');
    $('#chart').innerHTML =
      `<svg viewBox="0 0 720 210" role="img" aria-label="${esc(h.name)}: динамика с ${days[start]} по 21 октября. Значения в таблице ниже.">${goal}${grid}${trendLine}${bars}</svg>`;
    $('#chart-table').innerHTML =
      `<table><thead><tr><th>Дата</th><th>Итог дня</th><th>Все записи</th></tr></thead><tbody>${days
        .slice(start)
        .map((d, k) => {
          const i = k + start;
          return `<tr><th scope="row">${d} октября</th><td>${esc(valueLabel(h, h.values[i]))}</td><td>${esc(h.logs[i].map((v) => valueLabel(h, v)).join('; '))}</td></tr>`;
        })
        .join('')}</tbody></table>`;
  }
  function openEntry(id, index = 13) {
    const h = habits.find((h) => h.id === id);
    if (mode === 'doctor') {
      selected = id;
      render();
      $('#chart-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (index < (h.startIndex || 0)) {
      toast('Привычка ещё не отслеживалась в этот день. Дату начала можно выбрать при создании.');
      return;
    }
    editing = { id, index };
    $('#entry-title').textContent = `${h.name} · ${days[index]} октября`;
    $('#entry-hint').textContent =
      `${planLabel(h)}. ${aggregations[h.aggregation]}.${h.id === 'med' ? ' Только факт приёма, без изменения назначения.' : ''}`;
    if (h.id === 'med') {
      openMedEditor(h, index);
      return;
    }
    let field = '';
    const v = h.aggregation === 'mean' ? (h.logs[index].at(-1) ?? null) : h.values[index];
    if (h.type === 'check')
      field = `<label>Выполнение<select id="entry-value"><option value="1" ${v === 1 ? 'selected' : ''}>Сделано</option><option value="0" ${v === 0 ? 'selected' : ''}>Не выполнено</option></select></label>`;
    else if (h.type === 'note')
      field = `<label>Заметка<textarea id="entry-value" maxlength="2000" required>${esc(v ?? '')}</textarea></label>`;
    else if (h.type === 'choice')
      field = `<label>Вариант<select id="entry-value">${h.choices.map((s, i) => `<option value="${i + 1}" ${v === i + 1 ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>`;
    else if (h.type === 'time')
      field = `<label>Время суток<input id="entry-value" type="time" value="${v == null ? '' : clock(v)}" required></label>`;
    else
      field = `<label>Значение, ${esc(h.unit)}<input id="entry-value" type="number" min="${h.minimum}" max="${h.maximum}" step="${h.step}" value="${v ?? ''}" required></label>`;
    if (h.id === 'sleep') {
      const q = habits.find((x) => x.id === 'quality').values[index];
      field += `<label>Качество сна<select id="sleep-quality"><option value="">Не отмечать</option>${qualityNames.map((name, k) => `<option value="${k + 1}" ${q === k + 1 ? 'selected' : ''}>${name}</option>`).join('')}</select></label>`;
    }
    $('#entry-fields').innerHTML = field;
    if (h.id === 'sleep') $('#entry-value').required = false;
    $('#entry-operation').value = 'replace';
    $('#entry-operation-label').hidden = h.system || h.type === 'check';
    $('#entry-records').textContent = h.logs[index].length
      ? `Уже записано: ${h.logs[index].map((v) => valueLabel(h, v)).join('; ')}`
      : 'Записей за этот день пока нет.';
    $('#entry-missed').hidden = h.type !== 'check';
    $('#editor').showModal();
  }
  function saveEntry(v, clearSleep = false) {
    const h = habits.find((h) => h.id === editing.id),
      i = editing.index;
    if (v === null) h.logs[i] = [];
    else if ($('#entry-operation').value === 'append' && !h.system && h.type !== 'check') h.logs[i].push(v);
    else h.logs[i] = [v];
    h.values[i] = aggregate(h, h.logs[i]);
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
    toast('Запись сохранена. Календарь и график обновлены.');
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
        $('#entry-value').setCustomValidity('Укажите длительность или качество сна');
        $('#entry-value').reportValidity();
        return;
      }
      saveEntry(null);
      return;
    }
    const v = h.type === 'note' ? raw.trim() : h.type === 'time' ? parseClock(raw) : Number(raw);
    if (h.type === 'note' && !v) {
      $('#entry-value').setCustomValidity('Введите текст заметки');
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
      toast('Видимость в предпросмотре изменена');
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
    $('#target-caption').textContent = goal === 'range' ? 'Нижняя граница' : 'Значение';
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
        ? 'Сохраняются часы и минуты. Среднее времени суток не рассчитывается.'
        : type === 'choice'
          ? 'Варианты не имеют порядка «лучше — хуже». На графике они подписаны названиями.'
          : type === 'note'
            ? 'Сохраняется текст каждой заметки. На графике — число заметок по дням.'
            : type === 'check'
              ? 'За день достаточно одного выполнения. «Нет записи» отличается от «Не выполнено».'
              : `Итог дня: ${aggregations[$('#habit-aggregation').value]}. Все отдельные записи сохраняются.`;
    try {
      const draft = readBuilder();
      $('#habit-preview').textContent =
        `${draft.name || 'Ваша привычка'} · ${typeNames[draft.type]} · ${goalLabel(draft)} · ${scheduleLabel(draft)} · ${aggregations[draft.aggregation]}.`;
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
      throw Error('Укажите короткое название своей единицы. Например, «кругов».');
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
      throw Error('Границы шкалы должны быть целыми числами; максимум больше минимума (в пределах ±1 000 000).');
    const choices =
      type === 'choice'
        ? $('#habit-choices')
            .value.split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    if (type === 'choice' && (choices.length < 2 || choices.length > 12 || choices.some((s) => s.length > 45)))
      throw Error('Укажите от 2 до 12 вариантов, каждый до 45 символов, по одному на строку.');
    if (type === 'choice' && new Set(choices.map((s) => s.toLocaleLowerCase('ru'))).size !== choices.length)
      throw Error('Варианты должны различаться: уберите повторяющиеся строки.');
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
      throw Error('Ориентир должен входить в допустимые границы выбранного типа.');
    if (['count', 'scale'].includes(type) && goal !== 'none' && !Number.isInteger(target))
      throw Error('Для количества и шкалы задайте целый ориентир.');
    if (
      goal === 'range' &&
      (!Number.isFinite(upper) || upper < minimum || upper > maximum || (type !== 'time' && upper < target))
    )
      throw Error('Проверьте верхнюю границу диапазона: она должна быть не меньше нижней.');
    if (['count', 'scale'].includes(type) && goal === 'range' && !Number.isInteger(upper))
      throw Error('Границы количества и шкалы должны быть целыми.');
    const startValue = $('#habit-start').value,
      startIndex = Number(startValue.slice(-2)) - 8;
    if (!/^2026-10-(0[89]|1\d|2[01])$/.test(startValue) || startIndex < 0 || startIndex > 13)
      throw Error('В демонстрации выберите дату с 8 по 21 октября 2026.');
    const schedule = $('#habit-schedule').value,
      interval = Number($('#habit-interval').value),
      weekdays = [...document.querySelectorAll('[name="weekday"]:checked')].map((el) => Number(el.value));
    if (schedule === 'interval' && (!Number.isInteger(interval) || interval < 1 || interval > 365))
      throw Error('Интервал: целое число от 1 до 365 дней.');
    if (schedule === 'weekdays' && !weekdays.length) throw Error('Выберите хотя бы один день недели.');
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
      if (!config.name) throw Error('Введите название привычки.');
      const h = {
        ...config,
        id: `custom-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        icon: '✧',
        color: '#798eaa',
        tint: '#edf1f8',
        values: Array(14).fill(null),
        logs: Array.from({ length: 14 }, () => []),
      };
      habits.push(h);
      selected = h.id;
      persist();
      $('#creator').close();
      $('#habit-form').reset();
      updateBuilder(true);
      render();
      toast('Привычка добавлена. Можно внести первую запись.');
    } catch (error) {
      $('#builder-error').textContent = error.message;
      $('#builder-error').hidden = false;
      $('#builder-error').scrollIntoView({ block: 'nearest' });
    }
  });
  const presets = {
    water: { name: 'Пить воду', type: 'measure', unit: 'ml', goal: 'min', target: 1500, aggregation: 'sum' },
    walk: { name: 'Гулять', type: 'duration', unit: 'minutes', goal: 'min', target: 20, aggregation: 'sum' },
    energy: { name: 'Энергия', type: 'scale', unit: 'points', goal: 'none', aggregation: 'last' },
    bed: {
      name: 'Время отхода ко сну',
      type: 'time',
      unit: 'clock',
      goal: 'range',
      target: '23:00',
      upper: '01:00',
      aggregation: 'last',
    },
    note: { name: 'Что порадовало сегодня', type: 'note', unit: 'text', goal: 'none', aggregation: 'notes' },
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
        ? 'Напоминания на паузе'
        : `${reminder.frequency === 'daily' ? 'Один вопрос' : 'Вопрос через день'} в ${reminder.time}`;
    $('#reminders').hidden = mode === 'doctor';
  }
  $('#reminders').addEventListener('click', () => $('#reminder-dialog').showModal());
  $('#reminder-form').addEventListener('submit', (e) => {
    e.preventDefault();
    reminder = { frequency: $('#reminder-frequency').value, time: $('#reminder-time').value };
    renderReminder();
    persist();
    $('#reminder-dialog').close();
    toast('Настройки изменены в прототипе');
  });
  $('#reset').addEventListener('click', () => {
    habits = initialHabits();
    journalNotes = initialNotes();
    historyMode = 'state';
    showUnscheduled = false;
    drawerHabit = null;
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    mode = 'patient';
    selected = 'mood';
    reminder = { frequency: 'daily', time: '19:00' };
    $('#period').value = '14';
    $('#history-period').value = '14';
    persist();
    renderReminder();
    render();
    toast('Демонстрационные данные восстановлены');
  });
  function allNotes() {
    const ordinary = journalNotes
      .filter((n) => mode === 'patient' || n.shared)
      .map((n) => ({ ...n, source: 'day', sourceName: 'Заметка о дне' }));
    const fromHabits = visible()
      .filter((h) => h.type === 'note')
      .flatMap((h) =>
        h.logs.flatMap((entries, index) =>
          entries.map((text, k) => ({
            id: `${h.id}-${index}-${k}`,
            habitId: h.id,
            index,
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
    return `<article class="note-preview" data-note-id="${esc(note.id)}"><div class="note-preview-head"><button data-open-day="${note.index}">${esc(dayLabel(note.index).split(',')[0])}</button>${accessBadge(note.shared)}</div><p>${esc(text)}</p><span class="note-source">${esc(note.sourceName)}</span></article>`;
  }
  function renderNotes() {
    const notes = allNotes();
    $('#recent-notes').innerHTML =
      notes
        .slice(0, 3)
        .map((n) => noteHtml(n, false))
        .join('') || '<p class="empty-notes">Здесь появятся ваши заметки. Иногда достаточно пары слов.</p>';
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
        (!from || `2026-10-${String(n.index + 8).padStart(2, '0')}` >= from),
    );
    $('#note-results-count').textContent = `Найдено записей: ${notes.length}`;
    $('#note-results').innerHTML =
      notes.map((n) => noteHtml(n)).join('') ||
      '<p class="empty-notes">Заметок по этим условиям нет. Попробуйте другой запрос.</p>';
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
    drawerDay = Math.max(-7, Math.min(13, index));
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
    const v = h.values[index],
      canEdit = mode === 'patient' && index >= Math.max(0, h.startIndex || 0),
      label = v == null ? 'Нет записи' : valueLabel(h, v);
    const recordText =
      h.id === 'med'
        ? h.medSlots[index]
            ?.map(
              (v, i) =>
                `${i === 0 ? '08:00' : '20:00'} — ${v === 'taken' ? 'принято' : v === 'skipped' ? 'пропущено' : 'нет отметки'}`,
            )
            .join(' · ')
        : h.id === 'sleep'
          ? `Качество: ${valueLabel(
              habits.find((x) => x.id === 'quality'),
              habits.find((x) => x.id === 'quality').values[index],
            )}`
          : null;
    return `<div class="drawer-row"><div><h4>${esc(h.name)}</h4><strong>${esc(label)}</strong>${recordText ? `<p>${esc(recordText)}</p>` : ''}<p>${accessBadge(h.shared)}</p></div>${canEdit ? `<button data-edit="${h.id}" data-entry-index="${index}">${v == null ? 'Отметить' : 'Изменить'}</button>` : ''}</div>`;
  }
  function renderDrawer() {
    if (drawerHabit) {
      renderHabitDrawer();
      return;
    }
    const index = drawerDay,
      notes = allNotes().filter((n) => n.index === index);
    $('#drawer-kicker').textContent = 'ДЕНЬ ПОДРОБНО';
    $('#drawer-title').textContent = dayLabel(index);
    $('#drawer-nav').hidden = false;
    $('#previous-day').disabled = index <= -7;
    $('#next-day').disabled = index >= 13;
    if (index < 0) {
      $('#drawer-content').innerHTML = '<p class="empty-notes">В демонстрационных данных за этот день записей нет.</p>';
      return;
    }
    const mood = habits.find((h) => h.id === 'mood'),
      anxiety = habits.find((h) => h.id === 'anxiety'),
      sleep = habits.find((h) => h.id === 'sleep'),
      med = habits.find((h) => h.id === 'med');
    const personal = visible().filter(
      (h) => !h.system && h.type !== 'note' && (scheduled(h, index) || h.values[index] != null),
    );
    $('#drawer-content').innerHTML =
      `<section class="drawer-section"><h3>Самочувствие</h3>${drawerRow(mood, index)}${drawerRow(anxiety, index)}</section><section class="drawer-section"><h3>Сон и лекарства</h3>${drawerRow(sleep, index)}${drawerRow(med, index)}</section><section class="drawer-section"><h3>Личные привычки</h3>${personal.map((h) => drawerRow(h, index)).join('') || '<p class="muted">На этот день нет запланированных личных привычек.</p>'}</section><section class="drawer-section"><h3>Заметки за день</h3>${notes.map((n) => `<article class="drawer-note"><p>${esc(n.text)}</p><div class="drawer-note-footer"><span>${esc(n.sourceName)}</span>${mode === 'patient' && n.source === 'day' ? `<label><input type="checkbox" data-note-share="${esc(n.id)}" ${n.shared ? 'checked' : ''}>Видно специалисту</label>` : accessBadge(n.shared)}</div></article>`).join('') || '<p class="muted">Заметок нет.</p>'}${mode === 'patient' ? `<form id="drawer-note-form"><label for="drawer-note-text" class="state-group-label">Добавить пару слов</label><textarea id="drawer-note-text" rows="3" maxlength="2000" required placeholder="Что запомнилось в этот день?"></textarea><label class="check-label"><input type="checkbox" id="drawer-note-share">Показать специалисту</label><button type="submit" class="primary">Сохранить заметку</button></form>` : ''}</section>${mode === 'patient' ? '<button class="primary drawer-bottom-action" id="discuss-day">✦ Обсудить день с ИИ</button><p class="drawer-privacy">Откроется черновик вопроса. В прототипе ИИ не подключён и сообщения не отправляются.</p>' : ''}`;
  }
  function renderHabitDrawer() {
    const h = visible().find((h) => h.id === drawerHabit);
    if (!h) {
      $('#day-drawer').close();
      drawerHabit = null;
      return;
    }
    $('#drawer-kicker').textContent = 'ПРАВИЛА И ИСТОРИЯ';
    $('#drawer-title').textContent = h.name;
    $('#drawer-nav').hidden = true;
    $('#drawer-content').innerHTML = `<section class="drawer-section">${[
      ['Способ учёта', typeNames[h.type]],
      ['Единица', h.unit],
      ['Ориентир', goalLabel(h)],
      ['Расписание', scheduleLabel(h)],
      ['Итог дня', aggregations[h.aggregation]],
    ]
      .map(([label, value]) => `<div class="drawer-property"><span>${label}</span><strong>${esc(value)}</strong></div>`)
      .join(
        '',
      )}<p class="drawer-privacy">Тип и единица сохраняют смысл прошлых записей. В этом прототипе для другого способа учёта создайте новую привычку.</p>${mode === 'patient' ? `<label class="check-label"><input type="checkbox" data-share="${h.id}" ${h.shared ? 'checked' : ''}>Показывать специалисту в предпросмотре</label><button class="primary" data-edit="${h.id}">Внести отметку за сегодня</button>` : accessBadge(h.shared)}</section><section class="drawer-section"><h3>Записи за две недели</h3>${
      days
        .map((d, index) =>
          h.values[index] == null
            ? ''
            : `<button class="drawer-record" data-open-day="${index}"><span>${dayLabel(index).split(',')[0]}</span><span>${esc(valueLabel(h, h.values[index]))} ↗</span></button>`,
        )
        .reverse()
        .join('') || '<p class="muted">Записей пока нет.</p>'
    }</section>${mode === 'patient' && h.id.startsWith('custom-') ? `<button id="delete-diary-habit" data-id="${h.id}">Удалить демопривычку</button>` : ''}`;
  }
  function openMedEditor(h, index) {
    const slots = h.medSlots[index] || [null, null];
    $('#entry-fields').innerHTML =
      `<input id="entry-value" type="hidden" value="0"><p class="muted">Препарат по демоплану · отметки двух приёмов. Назначение здесь не редактируется.</p>${slots.map((v, i) => `<label>Приём в ${i === 0 ? '08:00' : '20:00'}<select id="med-slot-${i}"><option value="">Нет отметки</option><option value="taken" ${v === 'taken' ? 'selected' : ''}>Принял(а)</option><option value="skipped" ${v === 'skipped' ? 'selected' : ''}>Пропустил(а)</option></select></label>`).join('')}`;
    $('#entry-operation-label').hidden = true;
    $('#entry-missed').hidden = true;
    $('#entry-records').textContent = 'Отметки — только самоотчёт. Пропуск и отсутствие записи различаются.';
    $('#editor').showModal();
  }
  function saveMedEditor(h, index) {
    h.medSlots[index] = [0, 1].map((i) => $(`#med-slot-${i}`).value || null);
    h.logs[index] = h.medSlots[index].filter(Boolean).map((v) => (v === 'taken' ? 1 : 0));
    h.values[index] = h.logs[index].length ? h.logs[index].reduce((a, b) => a + b, 0) : null;
    selected = h.id;
    $('#editor').close();
    persist();
    render();
    toast('Демоотметки приёмов сохранены');
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
    toast(h.values[13] == null ? 'Отметка убрана' : 'Самооценка сохранена');
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
      $('#day-note').setCustomValidity('Введите текст заметки');
      $('#day-note').reportValidity();
      return;
    }
    $('#note-form').reset();
    toast('Заметка сохранена');
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
      persist();
      render();
      toast('Видимость заметки изменена в предпросмотре');
    }
  });
  $('#drawer-content').addEventListener('submit', (e) => {
    if (e.target.id !== 'drawer-note-form') return;
    e.preventDefault();
    const text = $('#drawer-note-text').value;
    if (!addNote(drawerDay, text, $('#drawer-note-share').checked)) {
      $('#drawer-note-text').setCustomValidity('Введите текст заметки');
      $('#drawer-note-text').reportValidity();
      return;
    }
    toast('Заметка за выбранный день сохранена');
  });
  $('#drawer-content').addEventListener('input', (e) => {
    if (e.target.id === 'drawer-note-text') e.target.setCustomValidity('');
  });
  $('#drawer-content').addEventListener('click', (e) => {
    const deleteHabit = e.target.closest('#delete-diary-habit');
    if (deleteHabit) {
      habits = habits.filter((h) => h.id !== deleteHabit.dataset.id);
      drawerHabit = null;
      $('#day-drawer').close();
      persist();
      render();
      toast('Демопривычка удалена');
    }
    if (e.target.closest('#discuss-day')) {
      const items = visible()
          .filter((h) => h.values[drawerDay] != null)
          .map((h) => `${h.name}: ${valueLabel(h, h.values[drawerDay])}`),
        notes = allNotes()
          .filter((n) => n.index === drawerDay)
          .map((n) => n.text);
      $('#discussion-text').value =
        `Хочу обсудить ${drawerDay + 8} октября. Помоги заметить, на что обратить внимание.\n\n${items.join('\n')}${notes.length ? '\n\nМои заметки:\n' + notes.join('\n') : ''}`;
      $('#discussion-dialog').showModal();
    }
  });
  $('#copy-discussion').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#discussion-text').value);
      toast('Вопрос скопирован. Ничего не отправлено.');
    } catch {
      $('#discussion-text').focus();
      $('#discussion-text').select();
      toast('Выделил текст. Скопируйте его сочетанием Ctrl+C.');
    }
  });

  updateBuilder(true);
  renderReminder();
  render();
})();
