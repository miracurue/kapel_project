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
  const storageKey = 'clinical-compass-rhythm-demo-builder-v2';
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
    return seed().map((h) => ({
      ...h,
      type: h.id === 'sleep' ? 'measure' : h.id === 'plants' ? 'check' : h.unit === 'мин' ? 'duration' : 'count',
      goal: h.range ? 'range' : 'min',
      aggregation: h.id === 'sleep' ? 'last' : h.id === 'plants' ? 'any' : 'sum',
      minimum: 0,
      maximum: h.id === 'sleep' ? 24 : h.id === 'med' ? 2 : 1e9,
      step: h.id === 'sleep' ? 0.1 : 1,
      logs: h.values.map((v) => (v == null ? [] : [v])),
    }));
  }
  let habits = initialHabits(),
    mode = 'patient',
    selected = 'sleep',
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
    }
  } catch {
    /* Storage can be disabled for a local file. The page still works. */
  }
  function persist() {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ version: 2, habits, reminder }));
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
  function render() {
    const shown = visible();
    if (!shown.some((h) => h.id === selected)) selected = shown[0]?.id || '';
    $('#doctor-notice').hidden = mode !== 'doctor';
    $('aside').hidden = mode === 'doctor';
    $('.workspace').classList.toggle('doctor-view', mode === 'doctor');
    $('#add').hidden = mode === 'doctor';
    $('#today-caption').textContent = mode === 'doctor' ? 'Доступные вам показатели' : 'Ваши ориентиры на день';
    document
      .querySelectorAll('[data-mode]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    $('#cards').innerHTML =
      shown
        .map((h) => {
          const v = h.values[13],
            due = scheduled(h, 13),
            textual = ['note', 'choice'].includes(h.type);
          const main = v == null ? '—' : numericTypes.includes(h.type) ? number(v) : valueLabel(h, v);
          const suffix =
            v == null
              ? due
                ? 'пока нет записи'
                : 'на сегодня нет плана'
              : numericTypes.includes(h.type)
                ? h.unit
                : '';
          const progress = v == null ? 0 : h.goal === 'none' ? 100 : meets(h, v) ? 100 : 50;
          return `<article class="habit-card" data-habit="${h.id}" style="--color:${h.color};--tint:${h.tint};--progress:${progress}%"><div class="card-top"><span class="habit-icon" aria-hidden="true">${h.icon}</span><span class="card-title">${esc(h.name)}</span>${h.system ? '<span class="system-tag">Основное</span>' : ''}</div><div class="card-value"><strong class="${textual ? 'text-value' : ''}">${esc(main.length > 85 ? main.slice(0, 85) + '…' : main)}</strong><span>${esc(suffix)}</span></div><div class="card-plan">${esc(planLabel(h))}</div><div class="track"><div class="track-fill"></div></div><div class="card-bottom">${mode === 'patient' ? `<div class="card-tools"><button data-edit="${h.id}">${v == null ? '+ Отметить' : 'Внести / изменить'}</button>${h.id.startsWith('custom-') ? `<button data-delete="${h.id}" aria-label="Удалить привычку ${esc(h.name)}">Удалить</button>` : ''}</div><label class="share"><input type="checkbox" data-share="${h.id}" ${h.shared ? 'checked' : ''}>Видно врачу</label>` : '<span class="muted">Самоотчёт пациента</span>'}</div></article>`;
        })
        .join('') || '<p class="muted">Нет открытых врачу показателей.</p>';
    const start = 14 - Number($('#period').value);
    $('#calendar').innerHTML = `<thead><tr><th scope="col">Октябрь</th>${days
      .slice(start)
      .map((d) => `<th scope="col" class="${d === 21 ? 'today-col' : ''}">${d}</th>`)
      .join('')}</tr></thead><tbody>${shown
      .map(
        (h) =>
          `<tr><th scope="row">${h.icon} ${esc(h.name)}</th>${days
            .slice(start)
            .map((d, k) => {
              const i = k + start,
                s = status(h, i),
                v = h.values[i];
              const compact =
                v == null
                  ? s === 'off'
                    ? '·'
                    : '—'
                  : h.type === 'check'
                    ? v
                      ? '✓'
                      : '0'
                    : h.type === 'note'
                      ? `✎${h.logs[i].length}`
                      : h.type === 'choice'
                        ? h.choices[v - 1].slice(0, 3)
                        : h.type === 'time'
                          ? clock(v)
                          : number(v);
              return `<td><button class="cell ${s}" data-history="${h.id}" data-index="${i}" aria-label="${esc(h.name)}, ${d} октября: ${statusNames[s]}${v == null ? '' : `, ${esc(valueLabel(h, v))}`}" title="${esc(v == null ? statusNames[s] : valueLabel(h, v))}">${esc(compact)}</button></td>`;
            })
            .join('')}</tr>`,
      )
      .join('')}</tbody>`;
    $('#metric').innerHTML = shown
      .map((h) => `<option value="${h.id}" ${h.id === selected ? 'selected' : ''}>${esc(h.name)}</option>`)
      .join('');
    renderChart();
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
        `${number(Number((values.reduce((a, b) => a + b, 0) / values.length).toPrecision(4)))} ${h.unit}`;
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
    const tick = (v) => (h.type === 'time' ? clock(Math.min(1439, Math.round(v))) : number(v));
    const ticks =
      h.type === 'choice'
        ? h.choices.map((name, i) => [i + 1, name.slice(0, 12)])
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
    const bars = days
      .slice(start)
      .map((d, k) => {
        const i = k + start,
          v = plotted(i),
          x = left + k * step + step * 0.24,
          bw = step * 0.52;
        return `${v == null ? `<line x1="${x}" x2="${x + bw}" y1="${bottom - 2}" y2="${bottom - 2}" stroke="#bcc9c1" stroke-width="3"/>` : h.type === 'choice' ? `<circle cx="${x + bw / 2}" cy="${y(v)}" r="5" fill="${h.color}"/>` : `<rect x="${x}" y="${Math.min(base, y(v)) - (v === 0 ? 3 : 0)}" width="${bw}" height="${Math.max(3, Math.abs(base - y(v)))}" rx="3" fill="${h.color}" opacity="${i === 13 ? 1 : 0.65}"><title>${esc(valueLabel(h, h.values[i]))}</title></rect>`}<text x="${x + bw / 2}" y="188" text-anchor="middle" fill="#7d8f87" font-size="11">${d}</text>`;
      })
      .join('');
    $('#chart').innerHTML =
      `<svg viewBox="0 0 720 210" role="img" aria-label="${esc(h.name)}: динамика с ${days[start]} по 21 октября. Значения в таблице ниже.">${goal}${grid}${bars}</svg>`;
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
    $('#entry-fields').innerHTML = field;
    $('#entry-operation').value = 'replace';
    $('#entry-operation-label').hidden = h.system || h.type === 'check';
    $('#entry-records').textContent = h.logs[index].length
      ? `Уже записано: ${h.logs[index].map((v) => valueLabel(h, v)).join('; ')}`
      : 'Записей за этот день пока нет.';
    $('#entry-missed').hidden = h.type !== 'check';
    $('#editor').showModal();
  }
  function saveEntry(v) {
    const h = habits.find((h) => h.id === editing.id),
      i = editing.index;
    if (v === null) h.logs[i] = [];
    else if ($('#entry-operation').value === 'append' && !h.system && h.type !== 'check') h.logs[i].push(v);
    else h.logs[i] = [v];
    h.values[i] = aggregate(h, h.logs[i]);
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
    const v = h.type === 'note' ? raw.trim() : h.type === 'time' ? parseClock(raw) : Number(raw);
    if (h.type === 'note' && !v) {
      $('#entry-value').setCustomValidity('Введите текст заметки');
      $('#entry-value').reportValidity();
      return;
    }
    if (h.type !== 'note' && !Number.isFinite(v)) return;
    saveEntry(v);
  });
  $('#entry-fields').addEventListener('input', () => $('#entry-value').setCustomValidity(''));
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
  $('#entry-clear').addEventListener('click', () => saveEntry(null));
  $('#cards').addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit]'),
      del = e.target.closest('[data-delete]');
    if (b) openEntry(b.dataset.edit);
    if (del) {
      habits = habits.filter((h) => h.id !== del.dataset.delete);
      persist();
      render();
      toast('Демопривычка удалена');
    }
  });
  $('#cards').addEventListener('change', (e) => {
    if (e.target.matches('[data-share]')) {
      habits.find((h) => h.id === e.target.dataset.share).shared = e.target.checked;
      persist();
      toast('Видимость в предпросмотре изменена');
    }
  });
  $('#calendar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-history]');
    if (b) openEntry(b.dataset.history, Number(b.dataset.index));
  });
  $('#audience').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) {
      mode = b.dataset.mode;
      render();
    }
  });
  $('#preview-doctor').addEventListener('click', () => {
    mode = mode === 'patient' ? 'doctor' : 'patient';
    render();
    window.scrollTo({ top: 100, behavior: 'smooth' });
  });
  $('#period').addEventListener('change', render);
  $('#metric').addEventListener('change', () => {
    selected = $('#metric').value;
    renderChart();
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
  document.querySelectorAll('[data-food]').forEach((b) =>
    b.addEventListener('click', () => {
      if (mode === 'doctor') return;
      const h = habits.find((h) => h.id === 'food');
      h.logs[13] = [Number(b.dataset.food)];
      h.values[13] = Number(b.dataset.food);
      selected = 'food';
      persist();
      render();
      toast('Питание отмечено');
    }),
  );
  function renderReminder() {
    $('#reminder-frequency').value = reminder.frequency;
    $('#reminder-time').value = reminder.time;
    $('#reminder-summary').textContent =
      reminder.frequency === 'off'
        ? 'Напоминания на паузе. Вернитесь к ним, когда будет удобно.'
        : `${reminder.frequency === 'daily' ? 'Не больше одного вопроса в день' : 'Один вопрос через день'}, около ${reminder.time}. Темы чередуются с учётом ваших планов.`;
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
    mode = 'patient';
    selected = 'sleep';
    reminder = { frequency: 'daily', time: '19:00' };
    $('#period').value = '14';
    persist();
    renderReminder();
    render();
    toast('Демонстрационные данные восстановлены');
  });
  updateBuilder(true);
  renderReminder();
  render();
})();
