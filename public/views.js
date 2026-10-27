'use strict';

/**
 * Экраны для показа (читаются поверх каркаса v2.js, data-testid каркаса не меняются):
 * дневник с графиком, тесты с динамикой, лекарства по плану, список пациентов, карточка
 * пациента, аналитика специалиста, «Мои данные», обзор администратора и маршрут показа.
 * Все данные приходят из API текущего пользователя; тексты — из /assets/ru.json.
 */
(function () {
  const q = (s, r = document) => r.querySelector(s);
  const qa = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  let TX = {};
  const tx = (key, fallback) => TX[key] || fallback || key;
  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const pad = (n) => String(n).padStart(2, '0');
  const parse = (iso) => new Date(/^\d{4}-\d\d-\d\d$/.test(iso) ? `${iso}T12:00:00` : iso);
  const day = (iso) => {
    const d = parse(iso);
    return Number.isNaN(d.getTime()) ? String(iso || '') : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  };
  const dayTime = (iso) => {
    const d = parse(iso);
    return Number.isNaN(d.getTime())
      ? String(iso || '')
      : `${d.getDate()} ${MONTHS[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const INSTR = {
    phq9: 'PHQ-9',
    gad7: 'GAD-7',
    who5: 'WHO-5',
    scl90r: 'SCL-90-R',
    itt_l: 'ИТТ СТ-Л',
    itt_s: 'ИТТ СТ-С',
    stai: 'Спилбергер–Ханин (STAI)',
    bai: 'Шкала тревоги Бека (BAI)',
    shars: 'Шкала тревоги Шихана (ShARS)',
  };
  const instr = (code) => INSTR[code] || String(code || '').toUpperCase();
  const MOOD_WORD = ['', 'очень плохо', 'плохо', 'так себе', 'хорошо', 'отлично'];
  const SLEEP_WORD = { bad: 'сон плохой', ok: 'сон нормальный', good: 'сон хороший' };
  const ANX_WORD = { none: 'тревоги нет', some: 'тревога умеренная', strong: 'тревога сильная' };
  const STATUS = {
    new: 'новый',
    in_work: 'в работе',
    taken: 'взят в работу',
    submitted: 'отправлено',
    handled: 'обработан',
    closed: 'закрыт',
    awaiting_visibility: 'ожидает',
  };
  const DOT = { red: ['red', 'Нужно внимание'], yellow: ['yellow', 'Следить'], green: ['green', 'Спокойно'] };

  async function api(path) {
    try {
      const r = await fetch(path, { headers: { Accept: 'application/json' } });
      return r.ok ? await r.json() : null;
    } catch (_) {
      return null;
    }
  }
  async function post(path, body, method = 'POST') {
    const token = (await (await fetch('/api/v1/csrf')).json()).token;
    const r = await fetch(path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': token,
        'idempotency-key': crypto.randomUUID(),
        Accept: 'application/json',
      },
      body: JSON.stringify(body || {}),
    });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
  }
  const chart = (points, opts) => (window.CCCharts && points.length ? window.CCCharts.lineChart(points, opts) : '');
  const card = (title, body, cls = '') => `<section class="card vcard ${cls}"><h3>${esc(title)}</h3>${body}</section>`;
  const empty = (text) => `<p class="muted">${esc(text)}</p>`;

  // ---------- общие приёмы ----------
  function polishTexts() {
    const main = q('main');
    if (!main) return;
    const iso = /\b(20\d\d-\d\d-\d\d)T(\d\d:\d\d)[\d:.]*Z\b/g;
    const walk = (node) => {
      if (node.nodeType === 3) {
        let s = node.nodeValue;
        if (!/20\d\d-\d\d-\d\dT|\{n[:}]|Источник: test| · (submitted|decided|handled)$/.test(s)) return;
        s = s.replace(iso, (m) => dayTime(m));
        s = s.replace(/\s*·?\s*\{n(:[^}]*)?\}/g, '');
        s = s.replace('Источник: test', 'Источник: сообщение пациента');
        s = s.replace(/ · submitted$/, ' · на рассмотрении').replace(/ · (decided|handled)$/, ' · обработано');
        if (s !== node.nodeValue) node.nodeValue = s;
        return;
      }
      if (node.nodeType === 1 && !['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT'].includes(node.tagName))
        node.childNodes.forEach(walk);
    };
    const hideBare = (n) => {
      if (n.nodeType !== 1) return;
      qa('[data-signal] p', n.matches && n.matches('[data-signal] p') ? n.parentNode : n).forEach((p) => {
        if (/^\d+$/.test(p.textContent.trim())) p.hidden = true;
      });
    };
    walk(main);
    hideBare(main);
    new MutationObserver((muts) => {
      for (const m of muts)
        m.addedNodes.forEach((n) => {
          walk(n);
          hideBare(n);
        });
    }).observe(main, { childList: true, subtree: true });
  }

  // ---------- общие кирпичи экранов пациента ----------
  const askStar = (type, id) =>
    `<a class="ask" href="/app?tab=chat&ask=${encodeURIComponent(type)}:${encodeURIComponent(id)}" aria-label="Спросить ИИ" title="Спросить ИИ" data-testid="msg.ask.star" data-object-type="${esc(type)}" data-object-id="${esc(id)}"><svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-sparkle"/></svg></a>`;
  const askLine = (text, href = '/app?tab=chat') => `<a class="ask-line" href="${esc(href)}">${esc(text)}</a>`;
  const soon = (text = 'скоро') =>
    `<span class="soon" title="Интерфейс готов, серверная часть в работе">${esc(text)}</span>`;
  const spark = (values, w = 120, h = 36) => {
    if (values.length < 2) return '';
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo || 1;
    const pts = values
      .map(
        (v, i) =>
          `${((i / (values.length - 1)) * (w - 6) + 3).toFixed(1)},${(h - 4 - ((v - lo) / span) * (h - 8)).toFixed(1)}`,
      )
      .join(' ');
    return `<svg class="spark-sm" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  };
  const MOOD_EMOJI = ['', '😣', '🙁', '😐', '🙂', '😄'];
  const MOOD_TITLE = ['', 'Плохо', 'Так себе', 'Нормально', 'Хорошо', 'Отлично'];
  const SLEEP_SHORT = { bad: 'плохо', ok: 'нормально', good: 'хорошо' };
  const ANX_SHORT = { none: 'нет', some: 'немного', strong: 'сильная' };
  const TEST_TITLE = {
    phq9: 'Тест на настроение',
    gad7: 'Тест на тревогу',
    who5: 'Тест на самочувствие',
    scl90r: 'Опросник симптомов',
  };
  const testTitle = (code) => TEST_TITLE[code] || instr(code);
  const relDay = (iso) => {
    const d = parse(iso);
    if (Number.isNaN(d.getTime())) return String(iso || '');
    const diff = Math.round((new Date().setHours(12, 0, 0, 0) - new Date(d).setHours(12, 0, 0, 0)) / 86400000);
    if (diff === 0) return 'Сегодня';
    if (diff === 1) return 'Вчера';
    if (diff === 2) return 'Позавчера';
    return day(iso);
  };

  // ---------- пациент: дневник ----------
  // Сегодня → календарь месяца → динамика → заметки. Толкование («что заметно») приходит с сервера из общей аналитики.
  const DOW = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
  const MONTH_FULL = [
    'Январь',
    'Февраль',
    'Март',
    'Апрель',
    'Май',
    'Июнь',
    'Июль',
    'Август',
    'Сентябрь',
    'Октябрь',
    'Ноябрь',
    'Декабрь',
  ];
  const SLEEP_FULL = { bad: 'сон плохой', ok: 'сон нормальный', good: 'сон хороший' };
  const ANX_FULL = { none: 'тревоги нет', some: 'небольшая тревога', strong: 'сильная тревога' };
  const SLEEP_BAR = { bad: 'var(--m1)', ok: 'var(--m3)', good: 'var(--m5)' };
  const ANX_BAR = { strong: 'var(--m1)', some: 'var(--m2)', none: 'var(--m3)' };
  const dnum = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);
  const dstr = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
  const dow = (iso) => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
  const dayLong = (iso, today) => {
    if (iso === today) return 'Сегодня';
    if (dnum(iso) === dnum(today) - 1) return 'Вчера';
    const [, m, d] = iso.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]}`;
  };

  function diaryChart(byDay, today, span) {
    const days = [];
    for (let n = dnum(today) - span + 1; n <= dnum(today); n += 1) days.push(dstr(n));
    const W = 560;
    const L = 22;
    const R = 8;
    const T = 8;
    const H = 120;
    const cw = (W - L - R) / days.length;
    const x = (i) => L + cw * (i + 0.5);
    const y = (v) => T + ((5 - v) / 4) * H;
    let s = `<svg viewBox="0 0 ${W} ${T + H + 84}" role="img" aria-label="Настроение, сон и тревога по дням">`;
    for (let v = 1; v <= 5; v += 1)
      s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
    let path = '';
    let open = false;
    days.forEach((d, i) => {
      const e = byDay.get(d);
      if (e && e.mood) {
        path += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(e.mood).toFixed(1)}`;
        open = true;
      } else open = false;
    });
    s += `<path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    days.forEach((d, i) => {
      const e = byDay.get(d);
      if (e && e.mood)
        s += `<circle cx="${x(i).toFixed(1)}" cy="${y(e.mood).toFixed(1)}" r="${d === today ? 5 : 3.2}" fill="var(--m${e.mood})" stroke="var(--bg)" stroke-width="1.5"><title>${esc(day(d))}: ${e.mood} из 5</title></circle>`;
    });
    const strip = (title, key, map, top) => {
      days.forEach((d, i) => {
        const e = byDay.get(d);
        const fill = e && e[key] ? map[e[key]] : 'var(--soft2)';
        s += `<rect x="${(x(i) - cw / 2 + 1).toFixed(1)}" y="${top}" width="${Math.max(cw - 2, 2).toFixed(1)}" height="14" rx="3" fill="${fill}"/>`;
      });
      s += `<text x="${L}" y="${top - 3}">${title}</text>`;
    };
    strip('Сон', 'sleep', SLEEP_BAR, T + H + 34);
    strip('Тревога', 'anxiety', ANX_BAR, T + H + 66);
    days.forEach((d, i) => {
      if (i === 0 || i === days.length - 1 || i % (span > 14 ? 7 : 3) === 0)
        s += `<text x="${x(i).toFixed(1)}" y="${T + H + 14}" text-anchor="middle">${Number(d.slice(8))}</text>`;
    });
    return `${s}</svg>`;
  }

  async function patientDiary() {
    const root = q('#v2-diary');
    if (!root) return;
    const note = q('[data-testid="msg.diary.note"]', root);
    const save = q('[data-testid="msg.diary.save"]', root);
    const status = qa(
      '[data-testid="msg.undo.diary_saved"],[data-testid="msg.diary.chart"],[data-testid="msg.diary.visibility"]',
      root,
    );
    const emptyNote = q('[data-testid="msg.diary.empty"]', root);
    const side = q('[data-diary-side]');
    const pick = { mood: null, sleep: null, anxiety: null };
    window.__diaryPick = pick;
    const moodBtn = (n, on, ids) =>
      `<button type="button" role="radio" aria-checked="${on}" data-v="${n}"${ids ? ` data-testid="msg.diary.mood.${n}"` : ''} aria-label="${MOOD_TITLE[n]}"><i data-m="${n}"></i><span>${MOOD_TITLE[n]}</span></button>`;
    const SEG = {
      sleep: [
        ['bad', 'Плохо'],
        ['ok', 'Норм.'],
        ['good', 'Хорошо'],
      ],
      anxiety: [
        ['none', 'Нет'],
        ['some', 'Немного'],
        ['strong', 'Сильная'],
      ],
    };
    const seg = (name, cur, ids) =>
      `<div class="seg" role="radiogroup" aria-label="${name === 'sleep' ? 'Сон' : 'Тревога'}" data-pick="${name}">${SEG[name].map(([v, text]) => `<button type="button" role="radio" aria-checked="${cur === v}" data-v="${v}"${ids ? ` data-testid="msg.diary.${name}.${v}"` : ''}>${text}</button>`).join('')}</div>`;
    // Выбор настроения, сна и тревоги: тот же набор для новой записи и для правки сегодняшней.
    const pickers = (cur, ids) =>
      `<div class="dlabel">Настроение</div><div class="scale" role="radiogroup" aria-label="Настроение" data-pick="mood">${[1, 2, 3, 4, 5].map((n) => moodBtn(n, cur.mood === n, ids)).join('')}</div>` +
      `<div class="dtwo"><div><div class="dlabel">Сон</div>${seg('sleep', cur.sleep, ids)}</div><div><div class="dlabel">Тревога</div>${seg('anxiety', cur.anxiety, ids)}</div></div>`;

    const layout = document.createElement('div');
    layout.className = 'dgrid';
    layout.innerHTML =
      '<div class="dcol"><section class="dcard" id="d-main"><div id="d-form"><div class="dcard-h"><h2>Как вы сегодня?</h2><span class="muted small" id="d-date"></span></div>' +
      pickers({}, true) +
      '<div class="note-row" id="d-noterow"></div></div><div id="d-view" hidden></div></section>' +
      '<section class="dcard soft" id="d-obs" hidden><div class="dcard-h"><h2>Что заметно за две недели</h2></div><ul class="obs" id="d-obs-list"></ul><div class="flag" id="d-flag" hidden></div></section></div>' +
      '<div class="dcol"><section class="dcard" id="d-cal"></section><section class="dcard" id="d-chart" hidden></section></div>';
    root.before(layout);
    // Поле, кнопка и статусы остаются внутри #v2-diary (их ведут v2.js и shell.js: черновик, сохранение) — переносим весь блок в карточку.
    q('#d-noterow', layout).replaceWith(root);
    root.classList.add('note-row');
    if (note) {
      note.rows = 1;
      note.placeholder = 'Заметка, если хочется';
      note.addEventListener('input', () => {
        note.style.height = 'auto';
        note.style.height = `${note.scrollHeight}px`;
      });
    }
    if (save) {
      save.className = 'btn dsave';
      save.textContent = 'Сохранить';
    }
    // Тот же список заметок — для телефона, где боковой панели нет.
    const notesCard = document.createElement('section');
    notesCard.className = 'dcard dnotes';
    notesCard.id = 'd-notes';
    layout.after(notesCard);
    [...status, emptyNote].filter(Boolean).forEach((n) => n.classList.add('dstatus'));
    notesCard.insertAdjacentHTML(
      'afterend',
      `<p class="footnote">Напоминание о записи: ${soon()} <span class="muted small">время и дни — когда подключим</span></p>`,
    );

    let data = { items: [], analytics: null, today: null };
    let view = null; // {y, m} — показанный месяц
    let selected = null; // ISO-день выбранной записи; null — сегодня
    let mode = 'view'; // 'view' | 'edit' | 'fix' для открытой записи
    let editPick = {};
    let span = 14;
    let shown = 5;
    let sideShown = 14;
    const byDay = new Map();
    const weekOf = (iso) => Math.floor((dnum(iso) + 3) / 7);
    const weekTitle = (iso, today) => {
      const diff = weekOf(today) - weekOf(iso);
      return diff === 0
        ? 'Эта неделя'
        : diff === 1
          ? 'Прошлая неделя'
          : `${day(dstr(weekOf(iso) * 7 - 3))} — ${day(dstr(weekOf(iso) * 7 + 3))}`;
    };
    const summary = (e) =>
      [e.mood ? MOOD_TITLE[e.mood] : '', SLEEP_FULL[e.sleep] || '', ANX_FULL[e.anxiety] || '']
        .filter(Boolean)
        .join(' · ');
    const entryHtml = (e, today) => {
      const own = e.entry_date === today;
      const long =
        e.entry_date === today
          ? `Сегодня, ${Number(today.slice(8))} ${MONTHS[Number(today.slice(5, 7)) - 1]}`
          : dayLong(e.entry_date, today);
      if (mode === 'edit' && own)
        return `<div class="dcard-h"><h2>Правка записи · ${esc(long)}</h2></div>${pickers({ mood: editPick.mood, sleep: editPick.sleep, anxiety: editPick.anxiety })}<div class="note-row"><textarea id="d-edit-note" rows="2" maxlength="2000" placeholder="Заметка, если хочется">${esc(editPick.note || '')}</textarea></div><div class="acts"><button type="button" class="btn dsave" data-edit-save="${e.id}">Сохранить</button><button type="button" class="btn ghost" data-edit-cancel>Отмена</button><span class="muted small" data-edit-msg></span></div>`;
      return (
        `<div class="dcard-h"><h2>${esc(long)}</h2><span class="dacts">${askStar('diary_entry', e.id)}</span></div>` +
        `<div class="drow">${e.mood ? `<span class="chip"><i class="ddot sm" data-m="${e.mood}"></i>${MOOD_TITLE[e.mood]}</span>` : ''}${e.sleep ? `<span class="chip">${SLEEP_FULL[e.sleep]}</span>` : ''}${e.anxiety ? `<span class="chip">${ANX_FULL[e.anxiety]}</span>` : ''}</div>` +
        (e.note ? `<p class="quote">${esc(e.note)}</p>` : '<p class="muted small">Заметки нет.</p>') +
        (mode === 'fix'
          ? `<div class="note-row"><textarea id="d-fix-text" rows="2" maxlength="500" placeholder="Что нужно исправить в этой записи?"></textarea></div><div class="acts"><button type="button" class="btn dsave" data-fix-send="${e.id}">Отправить</button><button type="button" class="btn ghost" data-edit-cancel>Отмена</button><span class="muted small" data-edit-msg></span></div>`
          : `<div class="acts">${own ? '<button type="button" class="btn ghost" data-edit>Изменить</button>' : `<button type="button" class="btn ghost" data-fix-open>Попросить исправить</button>`}</div>`) +
        (own
          ? `<p class="muted small">Запись сохранена, её видит ваш специалист.${e.mood && e.mood <= 2 ? ' Если сегодня тяжело, <a href="/app?tab=doctor">можно написать специалисту</a>.' : ''}</p>`
          : '')
      );
    };

    const render = () => {
      const today = data.today;
      const [ty, tm] = today.split('-').map(Number);
      view = view || { y: ty, m: tm - 1 };
      q('#d-date', layout).textContent = `${DOW[dow(today)]}, ${Number(today.slice(8))} ${MONTHS[tm - 1]}`;
      // Главная карточка: форма новой записи, либо запись выбранного дня
      const shownDay = selected || today;
      const entry = byDay.get(shownDay);
      const formMode = shownDay === today && !entry;
      q('#d-form', layout).hidden = !formMode;
      const viewEl = q('#d-view', layout);
      viewEl.hidden = formMode;
      if (!formMode)
        viewEl.innerHTML = entry
          ? entryHtml(entry, today)
          : `<div class="dcard-h"><h2>${esc(dayLong(shownDay, today))}</h2></div><p class="muted">Записи за этот день нет.</p>`;
      if (emptyNote) emptyNote.hidden = data.items.length > 0;
      // Боковая панель: записи по неделям
      if (side) {
        const days = [...byDay.keys()].sort().reverse();
        let list = '';
        let cur = null;
        days.slice(0, sideShown).forEach((iso) => {
          const e = byDay.get(iso);
          if (weekOf(iso) !== cur) {
            cur = weekOf(iso);
            list += `<h4>${weekTitle(iso, today)}</h4>`;
          }
          list += `<a href="#" class="th${shownDay === iso && !formMode ? ' on' : ''}" data-dsel="${iso}"><i class="ddot sm" data-m="${e.mood || 3}"></i><span>${esc(dayLong(iso, today))}</span><br><small class="lib-row-sub">${esc(e.note ? String(e.note).slice(0, 40) : summary(e) || 'запись')}</small></a>`;
        });
        side.innerHTML =
          `<div class="side-head"><button type="button" class="new" data-dnew>${byDay.has(today) ? 'Запись за сегодня' : 'Новая запись'}</button></div>` +
          (days.length ? list : '<p class="muted small">Здесь будут ваши записи.</p>') +
          (days.length > sideShown ? '<button type="button" class="btn ghost" data-dmore>Показать ещё</button>' : '');
      }
      // Что заметно
      const a = data.analytics;
      const obs = q('#d-obs', layout);
      obs.hidden = !data.items.length || !a || !a.observations.length;
      if (!obs.hidden) {
        q('#d-obs-list', layout).innerHTML = a.observations
          .map((o) => `<li data-obs="${esc(o.key)}">${esc(o.text)}</li>`)
          .join('');
        const flag = q('#d-flag', layout);
        flag.hidden = !a.flag;
        if (a.flag)
          flag.innerHTML = `${esc(a.flag.text)}<br><a href="/app?tab=doctor" data-testid="msg.diary.flag.write">Написать специалисту</a>`;
      }
      // Календарь
      const first = `${view.y}-${pad(view.m + 1)}-01`;
      const last = dnum(`${view.m === 11 ? view.y + 1 : view.y}-${pad(((view.m + 1) % 12) + 1)}-01`) - 1;
      const lastDay = dnum(today) < last && ty === view.y && tm - 1 === view.m ? dnum(today) : last;
      const gridEnd = ty === view.y && tm - 1 === view.m ? Math.min(last, dnum(today) + (6 - dow(today))) : last;
      let cells =
        DOW.map((d) => `<div class="dow">${d}</div>`).join('') + '<div class="day pad"></div>'.repeat(dow(first));
      for (let n = dnum(first); n <= gridEnd; n += 1) {
        const iso = dstr(n);
        const e = byDay.get(iso);
        const future = n > lastDay && n > dnum(today);
        cells += `<button type="button" class="day${future ? ' future' : e ? '' : ' empty'}${iso === today ? ' today' : ''}" ${e && e.mood ? `data-m="${e.mood}"` : ''} data-d="${iso}" aria-pressed="${shownDay === iso}" ${future ? 'disabled' : ''} aria-label="${Number(iso.slice(8))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}${e ? (e.mood ? `, ${MOOD_TITLE[e.mood]}` : ', запись') : ', записи нет'}">${Number(iso.slice(8))}${e && e.note ? '<span class="n"></span>' : ''}</button>`;
      }
      const earliest = data.items.length ? data.items[data.items.length - 1].entry_date : today;
      const canPrev = `${view.y}-${pad(view.m + 1)}` > earliest.slice(0, 7);
      const canNext = !(view.y === ty && view.m === tm - 1);
      q('#d-cal', layout).innerHTML =
        `<div class="cal-h"><h2>${MONTH_FULL[view.m]} ${view.y}</h2><div class="nav"><button type="button" data-nav="-1" aria-label="Предыдущий месяц" ${canPrev ? '' : 'disabled'}>‹</button><button type="button" data-nav="1" aria-label="Следующий месяц" ${canNext ? '' : 'disabled'}>›</button></div></div>` +
        `<div class="cal">${cells}</div><div class="legend"><span>Хуже</span>${[1, 2, 3, 4, 5].map((n) => `<i data-m="${n}"></i>`).join('')}<span>лучше</span><span class="legend-note">● есть заметка</span></div>` +
        (data.items.length
          ? ''
          : '<p class="muted detail">Здесь появится ваш месяц: каждый день закрасится цветом настроения. Для начала достаточно одной отметки сегодня.</p>');
      // Динамика
      q('#d-chart', layout).hidden = data.items.length < 3;
      q('#d-chart', layout).innerHTML =
        `<div class="dcard-h"><h2>Динамика</h2><div class="tabs" role="group" aria-label="Период">${[
          [14, '2 недели'],
          [30, 'Месяц'],
        ]
          .map(([n, t]) => `<button type="button" data-span="${n}" aria-pressed="${span === n}">${t}</button>`)
          .join(
            '',
          )}</div></div>${diaryChart(byDay, today, span)}<p class="muted small">Оранжевый — хуже, синий — лучше. Серые клетки — дни без записи.</p>`;
      // Заметки (телефон)
      const withNotes = data.items.filter((x) => x.note);
      let list = '';
      let curWeek = null;
      withNotes.slice(0, shown).forEach((x) => {
        if (weekOf(x.entry_date) !== curWeek) {
          curWeek = weekOf(x.entry_date);
          list += `<div class="week">${weekTitle(x.entry_date, today)}</div>`;
        }
        list += `<div class="nrow"><span class="d">${esc(dayLong(x.entry_date, today))}</span><i class="ddot sm" data-m="${x.mood || 3}"></i><span>${esc(x.note)}</span></div>`;
      });
      notesCard.hidden = !withNotes.length;
      notesCard.innerHTML = withNotes.length
        ? `<div class="dcard-h"><h2>Ваши заметки</h2></div>${list}${withNotes.length > shown ? '<button type="button" class="btn ghost" data-more>Показать ещё</button>' : ''}`
        : '';
    };
    const load = async () => {
      const r = await api('/api/v1/me/diary');
      if (!r) return;
      data = {
        items: r.items || [],
        analytics: r.analytics || null,
        today: r.today || new Date().toISOString().slice(0, 10),
      };
      byDay.clear();
      // items идут от новых к старым: первая запись дня — последняя по времени
      data.items.forEach((x) => {
        if (!byDay.has(x.entry_date)) byDay.set(x.entry_date, x);
      });
      render();
    };
    const openDay = (iso) => {
      selected = iso === data.today ? null : iso;
      mode = 'view';
      render();
    };
    layout.addEventListener('click', async (e) => {
      const radio = e.target.closest('[role="radio"]');
      if (radio) {
        const group = radio.closest('[data-pick]');
        const name = group.dataset.pick;
        const target = radio.closest('#d-form') ? pick : editPick;
        const same = String(target[name]) === radio.dataset.v;
        target[name] = same ? null : name === 'mood' && target === editPick ? Number(radio.dataset.v) : radio.dataset.v;
        qa('[role="radio"]', group).forEach((x) => x.setAttribute('aria-checked', String(!same && x === radio)));
        return;
      }
      const edit = e.target.closest('[data-edit]');
      if (edit) {
        const cur = byDay.get(data.today);
        editPick = { mood: cur.mood, sleep: cur.sleep, anxiety: cur.anxiety, note: cur.note || '' };
        mode = 'edit';
        render();
        return;
      }
      if (e.target.closest('[data-edit-cancel]')) {
        mode = 'view';
        render();
        return;
      }
      const saveEdit = e.target.closest('[data-edit-save]');
      if (saveEdit) {
        const msg = q('[data-edit-msg]', layout);
        const r = await post(
          `/api/v1/me/diary/${saveEdit.dataset.editSave}`,
          {
            mood: editPick.mood || undefined,
            sleep: editPick.sleep || undefined,
            anxiety: editPick.anxiety || undefined,
            note: q('#d-edit-note', layout).value,
          },
          'PATCH',
        );
        if (r.ok) {
          mode = 'view';
          await load();
        } else
          msg.textContent = r.status === 409 ? 'Править можно только запись за сегодня.' : 'Не получилось сохранить.';
        return;
      }
      if (e.target.closest('[data-fix-open]')) {
        mode = 'fix';
        render();
        return;
      }
      const send = e.target.closest('[data-fix-send]');
      if (send) {
        const text = q('#d-fix-text', layout).value.trim();
        if (!text) return;
        const r = await post('/api/v1/me/corrections', {
          record: { type: 'diary_entry', id: Number(send.dataset.fixSend) },
          text,
        });
        q('[data-edit-msg]', layout).textContent = r.ok
          ? 'Запрос на исправление отправлен специалисту.'
          : r.status === 409
            ? 'Запрос по этой записи уже отправлен.'
            : 'Не получилось отправить.';
        if (r.ok || r.status === 409) send.remove();
        return;
      }
      const nav = e.target.closest('[data-nav]');
      if (nav) {
        const m = view.m + Number(nav.dataset.nav);
        view = { y: view.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 };
        render();
        return;
      }
      const d = e.target.closest('.day[data-d]');
      if (d && !d.disabled) {
        openDay(d.dataset.d);
        return;
      }
      const sp = e.target.closest('[data-span]');
      if (sp) {
        span = Number(sp.dataset.span);
        render();
      }
    });
    side?.addEventListener('click', (e) => {
      if (e.target.closest('[data-dnew]')) {
        openDay(data.today);
        return;
      }
      if (e.target.closest('[data-dmore]')) {
        sideShown += 14;
        render();
        return;
      }
      const link = e.target.closest('[data-dsel]');
      if (!link) return;
      e.preventDefault();
      openDay(link.dataset.dsel);
    });
    notesCard.addEventListener('click', (e) => {
      if (!e.target.closest('[data-more]')) return;
      shown += 5;
      render();
    });
    await load();
    document.addEventListener('click', (e) => {
      if (!e.target.closest('[data-testid="msg.diary.save"]')) return;
      setTimeout(async () => {
        selected = null;
        mode = 'view';
        await load();
      }, 900);
    });
  }

  // ---------- пациент: тесты ----------
  async function patientTests() {
    const root = q('#v2-tests');
    if (!root || new URLSearchParams(location.search).get('run')) return;
    // Страница без боковой панели: методики (рисует сервер) → тесты двумя группами → недавние результаты.
    // «Результаты и динамика» и отдельный результат открываются на месте, кнопкой «К методикам» — обратно.
    const assignedBox = q('#tests-assigned');
    const notice = q('#tests-notice');
    const testsBlock = q('#tests');
    const holder = document.createElement('div');
    holder.id = 'tests-history';
    testsBlock.after(holder);
    const [assign, res] = await Promise.all([api('/api/v1/me/assignments'), api('/api/v1/me/results')]);
    const open = ((assign && assign.items) || []).filter((a) => ['pending', 'in_progress'].includes(a.status));
    const series = (res && res.series) || [];
    const byCode = {};
    [...series]
      .reverse()
      .filter((r) => r.total_score != null) // результат без балла (SCL-90-R) пациенту не показывается
      .forEach((r) => (byCode[r.instrument] = byCode[r.instrument] || []).push(r));
    let selected = 'hub';
    const methods = q('#techniques');
    const tabs = q('#tests-tabs');
    // Раздел на главной: «Упражнения» или «Тесты»; если врач назначил тест или пришли по ссылке #tests, открываем тесты.
    let tab = open.length || location.hash === '#tests' ? 'tests' : 'exercises';
    try {
      if (!open.length && location.hash !== '#tests' && sessionStorage.getItem('kapel.methodsTab') === 'tests')
        tab = 'tests';
    } catch {
      /* без хранилища всегда начинаем с упражнений */
    }

    const assignCard = (a) =>
      `<section class="card vcard"><h3>${esc(testTitle(a.instrument_code))}</h3><div class="sub">Назначил(а) специалист${a.progress && a.progress.total > 1 ? ` · ${a.progress.done} из ${a.progress.total}` : ''}</div><div class="acts"><a class="btn primary" href="/app?tab=tests&run=${a.id}">${a.status === 'in_progress' ? 'Продолжить' : 'Начать'}<span class="drop-badge" data-flower-badge="test" data-flower-key="test:${esc(a.instrument_code)}:{day}"></span></a></div></section>`;
    const resultCard = (r) => {
      if (r.total_score == null)
        return `<section class="card vcard"><div class="grow"><h3>${esc(testTitle(r.instrument))} · ${esc(day(r.created_at))}</h3><div class="sub">${esc(tx('msg.tests.result.done'))}</div><p class="sub">${esc(tx(r.completion_key || 'msg.tests.result.for_doctor'))}</p>${r.self_initiated && !r.shared_at ? `<button type="button" class="btn" data-share="${r.id}">${esc(tx('msg.tests.self.show'))}</button>` : ''}</div></section>`;
      const rows = byCode[r.instrument];
      const at = rows.findIndex((x) => x.id === r.id);
      const before = at > 0 ? rows[at - 1] : null;
      return (
        `<section class="card vcard">${askStar('result', r.id)}<div class="row2"><div class="grow"><h3>${esc(testTitle(r.instrument))} · ${esc(day(r.created_at))}</h3><div class="sub">${r.total_score} баллов${before ? ` · в прошлый раз ${before.total_score}` : ''}${r.self_initiated ? ' · пройден самостоятельно' : ''}</div></div>${spark(rows.slice(0, at + 1).map((x) => x.total_score))}</div><p class="small"><button type="button" class="link" data-wrong="${r.id}">Ответ записан неверно? Попросить исправить</button> ${soon()}</p>${r.self_initiated ? `<div class="acts"><button type="button" class="btn" data-share="${r.id}">Показать врачу</button></div>` : ''}</section>` +
        card(
          `Динамика · ${instr(r.instrument)}`,
          `${chart(
            rows.map((x) => ({ t: x.created_at, v: x.total_score, label: `${day(x.created_at)}: ${x.total_score}` })),
            { min: 0, title: `${instr(r.instrument)} по времени`, height: 170, width: 420 },
          )}<p class="muted small">Это не диагноз: результат помогает специалисту видеть динамику.</p>`,
        )
      );
    };
    const overview = () =>
      series
        .filter((r) => r.total_score == null)
        .map(resultCard)
        .join('') +
      (Object.keys(byCode).length
        ? card(
            'Динамика',
            `<div class="grid2">${Object.entries(byCode)
              .map(
                ([code, rows]) =>
                  `<div class="mini"><h4>${esc(instr(code))}</h4>${chart(
                    rows.map((r) => ({
                      t: r.created_at,
                      v: r.total_score,
                      label: `${day(r.created_at)}: ${r.total_score}`,
                    })),
                    { min: 0, title: `${instr(code)} по времени`, height: 170, width: 420 },
                  )}</div>`,
              )
              .join(
                '',
              )}</div><p class="muted small">Это не диагноз: результат помогает специалисту видеть динамику.</p>`,
          )
        : series.length
          ? ''
          : card('Результаты', empty('Результатов пока нет.')));

    const recent = () => {
      const last = series.slice(0, 3);
      if (!last.length) return '';
      return `<section class="tech-section" aria-labelledby="recent-title"><div class="tech-head row2"><div class="grow"><h2 id="recent-title">Недавние результаты</h2><p>Как менялись баллы — в «Результатах и динамике».</p></div><a href="#" class="btn sm" data-tsel="overview">Результаты и динамика</a></div>${last
        .map((r) =>
          r.total_score == null
            ? resultCard(r)
            : `<section class="card vcard row2"><div class="grow"><h3>${esc(testTitle(r.instrument))} · ${esc(day(r.created_at))}</h3><div class="sub">${r.total_score} баллов</div></div><a href="#" class="btn sm" data-tsel="result:${esc(r.id)}">Открыть</a></section>`,
        )
        .join('')}</section>`;
    };
    const assigned = () =>
      `<div class="tech-head"><h3>Назначено врачом</h3><p>${open.length ? 'Специалист просит пройти эти тесты.' : 'Сейчас ничего не назначено. Когда специалист назначит тест, он появится здесь.'}</p></div>${open.map(assignCard).join('')}`;
    const back = () =>
      `<p class="pt-back"><a href="#" class="btn sm" data-tsel="hub"><svg class="i i--16" aria-hidden="true" focusable="false"><use href="/icons.svg#i-arrow-left"/></svg>К методикам</a></p>`;
    const paint = () => {
      const [kind, id] = selected.split(':');
      const r = kind === 'result' && series.find((x) => String(x.id) === id);
      const onHub = selected === 'hub';
      if (methods) methods.hidden = !(onHub && tab === 'exercises');
      testsBlock.hidden = !(onHub && tab === 'tests');
      holder.hidden = onHub && tab !== 'tests';
      if (tabs) {
        tabs.hidden = !onHub;
        tabs
          .querySelectorAll('[data-ttab]')
          .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ttab === tab)));
      }
      if (notice)
        notice.innerHTML =
          onHub && open.length && tab === 'exercises'
            ? `<a class="tests-notice" href="#tests" data-ttab="tests"><svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-clipboard-text"/></svg><span>Врач назначил ${open.length === 1 ? 'тест' : `тесты: ${open.length}`} — ${esc(open.map((a) => testTitle(a.instrument_code)).join(', '))}</span><b>Перейти</b></a>`
            : '';
      assignedBox.innerHTML = assigned();
      holder.innerHTML = onHub
        ? recent()
        : back() + (r ? resultCard(r) : overview()) + askLine('Спросить ИИ о результатах…');
    };
    paint();
    const choose = (e) => {
      const link = e.target.closest('[data-tsel]');
      if (!link) return;
      e.preventDefault();
      selected = link.dataset.tsel;
      paint();
      q('.app-main .scroll')?.scrollTo({ top: 0 });
    };
    tabs?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ttab]');
      if (!b) return;
      tab = b.dataset.ttab;
      try {
        sessionStorage.setItem('kapel.methodsTab', tab);
      } catch {
        /* вкладка просто не запомнится */
      }
      paint();
    });
    notice?.addEventListener('click', (e) => {
      if (!e.target.closest('[data-ttab]')) return;
      e.preventDefault();
      tab = 'tests';
      paint();
    });
    holder.addEventListener('click', choose);
    holder.addEventListener('click', async (e) => {
      const share = e.target.closest('[data-share]');
      if (share) {
        const r = await post(`/api/v1/me/results/${share.dataset.share}/share`, {});
        share.replaceWith(
          Object.assign(document.createElement('span'), {
            className: 'muted small',
            textContent: r.ok ? 'Показано врачу' : 'Не получилось',
          }),
        );
      }
      if (e.target.closest('[data-wrong]')) {
        const note = e.target.closest('.small');
        note.insertAdjacentHTML(
          'afterend',
          '<p class="muted small">Исправление ответов в тестах: интерфейс готов, серверная часть в работе — пока напишите врачу.</p>',
        );
      }
    });
  }

  // ---------- пациент: лекарства ----------
  async function patientMeds() {
    const root = q('#v2-meds');
    if (!root) return;
    const [data, rem, ae] = await Promise.all([
      api('/api/v1/me/meds'),
      api('/api/v1/me/reminders'),
      api('/api/v1/me/adverse-events'),
    ]);
    const holder = document.createElement('div');
    holder.id = 'meds-extra';
    root.after(holder);
    const own = (data && data.patient_meds) || [];
    const reminders = (rem && rem.items) || [];
    const support = (data && data.course_support) || [];
    const aes = (ae && ae.items) || [];
    const AE_STATUS = {
      awaiting_doctor: 'ждёт врача',
      reviewed: 'врач посмотрел',
      submitted: 'отправлено',
      saved_private: 'Сохранено у вас',
    };
    let html = '';
    html += reminders.length
      ? `<p class="footnote" id="rem-line">Напоминание о приёме в ${esc(reminders[0].time_hhmm)} · <button type="button" class="link" id="rem-edit">изменить</button></p>`
      : `<p class="footnote">Напоминание о приёме ${soon()} <span class="muted small">время и дни выберем, когда подключим</span></p>`;
    if (own.length)
      html +=
        '<p class="sec-label">Внесено вами</p>' +
        own
          .map(
            (m) =>
              `<section class="card vcard">${askStar('plan_item', 'own:' + m.id)}<h3>${esc(m.product_name || m.inn_name)} ${esc(m.dose)} ${esc(m.unit)}</h3><div class="sub">${esc(m.inn_name)} · ${esc((m.times || []).join(', '))}</div><div class="acts"><span class="chip ro">Внесено вами</span></div></section>`,
          )
          .join('');
    if (support.length) {
      const week = Math.max(...support.map((x) => x.week));
      html += `<section class="card soft vcard" data-standin><div class="sub">Неделя ${week} курса</div><p>Это общий текст-заглушка о ходе курса. Не прекращайте приём сами — сначала обсудите с врачом.</p></section>`;
    }
    if (aes.length)
      html +=
        '<p class="sec-label">Вы сообщали врачу</p>' +
        aes
          .map(
            (x) =>
              `<section class="card vcard">${askStar('adverse_event', x.id)}<h3>Побочное действие · ${esc(day(x.created_at))}</h3><div class="sub">${esc(AE_STATUS[x.status] || x.status)}</div></section>`,
          )
          .join('');
    html += `<p class="footnote">Сервис не подбирает дозы и не проверяет сочетания. Вопросы о лечении — врачу.</p>`;
    holder.innerHTML = html;
    q('#rem-edit', holder)?.addEventListener('click', () => {
      const time = window.prompt('Время напоминания (чч:мм)', reminders[0].time_hhmm);
      if (!time || !/^\d\d:\d\d$/.test(time)) return;
      fetch('/api/v1/csrf')
        .then((r) => r.json())
        .then(({ token }) =>
          fetch(`/api/v1/me/reminders/${reminders[0].id}`, {
            method: 'PUT',
            headers: {
              'content-type': 'application/json',
              'x-csrf-token': token,
              'idempotency-key': crypto.randomUUID(),
            },
            body: JSON.stringify({ time, enabled: true }),
          }),
        )
        .then((r) => {
          if (r.ok) q('#rem-line').firstChild.nodeValue = `Напоминание о приёме в ${time} · `;
        });
    });
  }

  // ---------- специалист: список пациентов (слева) ----------
  const hoursAgo = (iso) => {
    const d = parse(iso);
    const ms = Date.now() - d.getTime();
    if (Number.isNaN(ms)) return '';
    const m = Math.round(ms / 60000);
    if (m < 60) return `${Math.max(1, m)} мин`;
    if (m < 1440) return `${Math.round(m / 60)} ч`;
    const days = Math.round(m / 1440);
    return days === 1 ? 'вчера' : day(iso);
  };
  const dotClass = { red: 'r', yellow: 'y', green: 'g', none: 'n' };

  async function patientEvents(id) {
    const [tests, diary, visits, msgs] = await Promise.all([
      api(`/api/v1/patients/${id}?tab=tests`),
      api(`/api/v1/patients/${id}?tab=diary`),
      api(`/api/v1/patients/${id}/visits`),
      api(`/api/v1/patients/${id}/messages`),
    ]);
    return {
      results: (tests && tests.results) || [],
      entries: (diary && diary.items) || [],
      visits: (visits && visits.items) || [],
      previsit: visits && visits.previsit,
      messages: ((msgs && (msgs.items || msgs.messages)) || []).slice(),
    };
  }

  async function clinicianPatients() {
    const list = q('[data-items]');
    if (!list) return;
    const search = q('[data-testid="msg.patients.search"]');
    const pills = qa('.plist .filters .pill');
    const [pat, sig] = await Promise.all([api('/api/v1/patients'), api('/api/v1/signals?kind=all&status=all')]);
    const base = {};
    ((pat && pat.items) || []).forEach((p) => (base[p.id] = p));
    const open = {};
    ((sig && sig.items) || [])
      .filter((s) => s.status !== 'handled')
      .forEach((s) => (open[s.patient && s.patient.id] = open[s.patient && s.patient.id] || []).push(s));
    const info = {};
    const fill = async (a) => {
      const id = a.dataset.id;
      const ev = await patientEvents(id);
      const mine = open[id] || [];
      const crisis = mine.find((s) => s.kind === 'crisis');
      const ae = mine.find((s) => s.kind === 'ae');
      const lastResult = ev.results[0];
      const lastMsg = ev.messages.filter((m) => m.sender_role === 'patient').slice(-1)[0];
      const soon = ev.visits.find((v) => v.status === 'scheduled' && parse(v.starts_at) - Date.now() < 7 * 86400000);
      let line = 'Нет новых событий';
      let when = '';
      let dot = 'n';
      if (crisis) {
        line = `Кризис · ${hoursAgo(crisis.created_at)}`.replace(/ · $/, '');
        dot = 'r';
      } else if (ae) {
        line = 'Побочный эффект';
        dot = 'y';
      } else if (lastMsg && Date.now() - parse(lastMsg.created_at) < 3 * 86400000) {
        line = `Сообщение: «${String(lastMsg.body || lastMsg.text || '').slice(0, 40)}…»`;
        when = hoursAgo(lastMsg.created_at);
        dot = 'g';
      } else if (lastResult) {
        line = lastResult.scl90r
          ? `${testShort(lastResult.instrument)}: GSI ${ru2(lastResult.scl90r.rows.find((x) => x.code === 'GSI').value)}`
          : `${testShort(lastResult.instrument)}: ${lastResult.total_score}`;
        when = hoursAgo(lastResult.created_at);
        dot = 'g';
      } else if ((base[id] || {}).dot === 'red') dot = 'r';
      if (line === 'Нет новых событий' && soon) line = `визит ${day(soon.starts_at)}`;
      info[id] = { signal: Boolean(crisis || ae), visit: Boolean(soon) };
      // статус словом и значком (спецификация 11): кризис и побочный эффект выделены, визит скоро — со значком календаря
      const stIcon =
        dot === 'r'
          ? 'warning'
          : dot === 'y'
            ? 'warning-circle'
            : !lastMsg && !lastResult && soon
              ? 'calendar-blank'
              : '';
      const stLine = q('[data-last]', a);
      stLine.classList.toggle('st--crisis', dot === 'r');
      stLine.classList.toggle('st--ae', dot === 'y');
      stLine.innerHTML = `${stIcon ? `<svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-${stIcon}"/></svg>` : ''}${esc(line)}`;
      q('[data-when]', a).textContent = when;
      a.dataset.group = dot === 'r' || dot === 'y' ? 'attention' : soon ? 'visit' : 'rest';
      const d = q('[data-dot]', a);
      d.className = `dotc ${dot}`;
      d.setAttribute(
        'aria-label',
        { r: 'Открыт кризисный сигнал', y: 'Побочный эффект или ухудшение', g: 'Стабильно', n: 'Нет данных' }[dot],
      );
    };
    await Promise.all(qa('a.pi', list).map(fill));
    // группы как в образце: нужно внимание, визит скоро, остальные (порядок внутри группы прежний)
    const groupTitles = { attention: 'Нужно внимание', visit: 'Визит скоро', rest: 'Остальные' };
    const regroup = () => {
      qa('.group-t', list).forEach((h) => h.remove());
      const rows = qa('a.pi', list);
      ['attention', 'visit', 'rest'].forEach((g) => {
        const part = rows.filter((a) => a.dataset.group === g);
        if (!part.length) return;
        const h = document.createElement('p');
        h.className = 'group-t';
        h.dataset.group = g;
        h.textContent = groupTitles[g];
        list.append(h);
        part.forEach((a) => list.append(a));
      });
    };
    regroup();
    q('a.pi.on', list)?.scrollIntoView({ block: 'nearest' });
    let archived = false;
    const apply = () => {
      const needle = search ? search.value.trim().toLowerCase() : '';
      const mode = (pills.find((x) => x.classList.contains('on')) || {}).dataset?.filter || 'all';
      qa('a.pi', list).forEach((a) => {
        let ok = !needle || a.textContent.toLowerCase().includes(needle);
        if (mode === 'signal') ok = ok && (info[a.dataset.id] || {}).signal;
        if (mode === 'visit') ok = ok && (info[a.dataset.id] || {}).visit;
        a.hidden = !ok;
      });
      qa('.group-t', list).forEach((h) => {
        h.hidden = !qa(`a.pi[data-group="${h.dataset.group}"]`, list).some((a) => !a.hidden);
      });
    };
    if (search) {
      search.addEventListener('input', apply);
    }
    pills.forEach((p) =>
      p.addEventListener('click', async () => {
        pills.forEach((x) => x.classList.remove('on'));
        p.classList.add('on');
        if (p.dataset.filter === 'archive') {
          const arch = await api('/api/v1/patients?filter=archive');
          archived = true;
          const items = (arch && arch.items) || [];
          list.dataset.live = list.innerHTML;
          list.innerHTML = items.length
            ? items
                .map(
                  (x) =>
                    `<span class="pi p-row"><span class="avatar-sm ava">·</span><span class="grow p-meta"><b>${esc(x.service_no)}</b><small class="st">В архиве</small></span></span>`,
                )
                .join('')
            : '<p class="muted small pad">Архив пуст</p>';
          return;
        }
        if (archived) {
          list.innerHTML = list.dataset.live;
          archived = false;
        }
        apply();
      }),
    );
  }

  // Десятичное число с запятой, 2 знака; null — прочерк.
  const ru2 = (x) => (x === null || x === undefined ? '—' : (Math.round(x * 100) / 100).toFixed(2).replace('.', ','));
  // Блок результата SCL-90-R для специалиста: данные и нормы приходят с сервера, тексты — из locales/ru.json.
  const scl90rBlock = (r) => {
    const d = r.scl90r;
    const fill = (key, vars) => Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, esc(v)), tx(key));
    const crisis = `<div class="crisis-items" data-testid="msg.scl90r.crisis.title"><h4>${esc(tx('msg.scl90r.crisis.title'))}</h4><ul>${d.crisis_items
      .map(
        (c) =>
          `<li${c.value > 0 ? ' class="warn"' : ''}>${fill('msg.scl90r.crisis.item', { n: c.item, text: c.text, value: c.value })}${c.value > 0 ? ` — <b>${esc(tx('msg.scl90r.crisis.positive'))}</b>` : ''}</li>`,
      )
      .join('')}</ul></div>`;
    const fmtRow = (x) => (x.code === 'PSI' ? String(x.value) : ru2(x.value));
    const table = `<div class="scroll-x"><table class="tbl scl90r-table"><thead><tr><th>${esc(tx('msg.scl90r.col.scale'))}</th><th>${esc(tx('msg.scl90r.col.value'))}</th><th>${esc(tx('msg.scl90r.col.ru'))}</th><th>${esc(tx('msg.scl90r.col.us'))}</th><th>${esc(tx('msg.scl90r.col.compare'))}</th></tr></thead><tbody>${d.rows
      .map(
        (x) =>
          `<tr><td><b>${esc(x.code === 'ADD' ? 'Dopoln.' : x.code)}</b> ${esc(x.title !== x.code ? x.title : '')}</td><td>${fmtRow(x)}</td><td>${esc(x.norms ? x.norms.ru.text : '—')}</td><td>${esc(x.norms ? x.norms.us.text : '—')}</td><td>${esc(tx(x.compare_ru ? `msg.scl90r.compare.${x.compare_ru}` : 'msg.scl90r.compare.none'))}</td></tr>`,
      )
      .join('')}</tbody></table></div>`;
    const groups = `<details><summary>${esc(tx('msg.scl90r.groups'))}</summary><div class="scroll-x"><table class="tbl scl90r-groups"><thead><tr><th>${esc(tx('msg.scl90r.col.scale'))}</th>${d.groups.map((g) => `<th>${esc(g.label)}</th>`).join('')}</tr></thead><tbody>${d.rows
      .filter((x) => x.norms)
      .map(
        (x) =>
          `<tr><td>${esc(x.code === 'ADD' ? 'Dopoln.' : x.code)}</td>${d.groups.map((g) => `<td>${esc(x.norms[g.key].text)}</td>`).join('')}</tr>`,
      )
      .join('')}</tbody></table></div><p class="muted small">${esc(tx('msg.scl90r.groups.note'))}</p></details>`;
    const interp = `<details><summary>${esc(tx('msg.scl90r.interp.show'))}</summary>${d.rows
      .map(
        (x) =>
          `<p><b>${esc(x.code === 'ADD' ? 'Dopoln.' : x.code)}.</b> ${esc(x.interpretation || tx('msg.scl90r.interp.none'))}</p>`,
      )
      .join('')}</details>`;
    const high = `<details><summary>${esc(tx('msg.scl90r.high.show'))}</summary>${d.high_items.length ? `<ul>${d.high_items.map((x) => `<li>${fill('msg.scl90r.high.item', { n: x.item, text: x.text, value: x.value })}</li>`).join('')}</ul>` : `<p class="muted">${esc(tx('msg.scl90r.high.none'))}</p>`}</details>`;
    const hist = `<details><summary>${esc(tx('msg.scl90r.history'))}</summary>${
      d.history.length
        ? `<div class="scroll-x"><table class="tbl"><thead><tr><th></th><th>GSI</th><th>PSI</th><th>PDSI</th>${Object.keys(
            d.history[0].scales,
          )
            .map((k) => `<th>${esc(k)}</th>`)
            .join('')}</tr></thead><tbody>${d.history
            .map(
              (h) =>
                `<tr><td>${esc(day(h.created_at))}</td><td>${ru2(h.gsi)}</td><td>${ru2(h.psi)}</td><td>${ru2(h.pdsi)}</td>${Object.values(
                  h.scales,
                )
                  .map((v) => `<td>${ru2(v)}</td>`)
                  .join('')}</tr>`,
            )
            .join('')}</tbody></table></div>`
        : `<p class="muted">${esc(tx('msg.scl90r.history.none'))}</p>`
    }</details>`;
    return `<section class="card vcard" data-testid="msg.scl90r.title" data-result="${esc(r.id)}"><h3>${esc(tx('msg.scl90r.title'))}</h3><div class="sub">${fill('msg.scl90r.meta', { date: day(d.created_at), version: d.instrument_version })}</div>${crisis}<h4>${esc(tx('msg.scl90r.scales'))}</h4>${table}${groups}${interp}${high}${hist}<p class="muted small" data-testid="msg.scl90r.disclaimer">${esc(tx('msg.scl90r.disclaimer'))}</p>${d.key_deviation === 'pending_owner_approval' ? `<p class="muted small">${esc(tx('msg.scl90r.deviation'))}</p>` : ''}</section>`;
  };

  // Блок результата ИТТ (СТ-Л / СТ-С) для специалиста: обе группы норм отрисованы сразу, переключатель
  // только скрывает/показывает; тексты — из locales/ru.json, данные и тексты интерпретаций — с сервера.
  const stanBar = (n, hi) =>
    `<span class="stan" role="img" aria-label="${esc(tx('msg.itt.stanine.aria').replace('{n}', n))}">${[
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]
      .map((i) => `<i${i === n ? ` class="on${hi && n >= hi ? ' hi' : ''}"` : ''}></i>`)
      .join('')}</span>`;
  const ittBlock = (r) => {
    const d = r.itt;
    const fill = (key, vars) => Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, esc(v)), tx(key));
    const label = (g) => (d.groups.find((x) => x.key === g) || {}).label || g;
    const perGroup = (g) => {
      const total = `<p data-testid="msg.itt.total.title"><b>${esc(tx('msg.itt.total.title'))}.</b> ${fill('msg.itt.total.line', { raw: d.total.raw, max: d.total.max, stanine: d.total.stanine[g] })} ${stanBar(d.total.stanine[g])}</p>`;
      const table = `<div class="scroll-x"><table class="tbl itt-table"><thead><tr><th>${esc(tx('msg.itt.col.scale'))}</th><th>${esc(tx('msg.itt.col.raw'))}</th><th>${esc(tx('msg.itt.col.stanine'))}</th><th>${esc(tx('msg.itt.col.scale19'))}</th></tr></thead><tbody>${d.rows
        .map(
          (x) =>
            `<tr><td><b>${esc(x.code)}</b> ${esc(x.title)}</td><td>${x.raw} / ${x.max}</td><td>${x.stanine[g]}</td><td>${stanBar(x.stanine[g], d.high_from)}</td></tr>`,
        )
        .join('')}</tbody></table></div>`;
      const interp = `<h4>${esc(tx('msg.itt.interp.title'))}</h4>${d.rows
        .map((x) =>
          x.stanine[g] >= d.high_from
            ? `<p><b>${esc(x.code)}.</b> ${fill('msg.itt.interp.high', { n: x.stanine[g] })} ${esc(x.interpretation)}</p>`
            : `<p class="muted"><b>${esc(x.code)}.</b> ${fill('msg.itt.interp.notHigh', { n: x.stanine[g] })}</p>`,
        )
        .join('')}<p class="muted small">${esc(tx('msg.itt.interp.assumption'))}</p>`;
      const pairRows = (p) =>
        p
          ? `<td>${p.total.raw} · ${p.total.stanine[g]}</td>${d.rows.map((x) => `<td>${p.subscales[x.code].stanine[g]}</td>`).join('')}`
          : `<td colspan="${d.rows.length + 1}" class="muted">${esc(tx('msg.itt.pair.empty'))}</td>`;
      const ownIsL = d.scale === 'L';
      const own = {
        total: { raw: d.total.raw, stanine: d.total.stanine },
        subscales: Object.fromEntries(d.rows.map((x) => [x.code, { stanine: x.stanine }])),
      };
      const lRow = ownIsL ? own : d.pair;
      const sRow = ownIsL ? d.pair : own;
      const pair = `<h4>${esc(tx('msg.itt.pair.title'))}</h4>${d.pair ? '' : `<p class="muted">${esc(tx('msg.itt.pair.none'))}</p>`}<div class="scroll-x"><table class="tbl itt-pair"><thead><tr><th></th><th>${esc(tx('msg.itt.pair.total'))}</th>${d.rows.map((x) => `<th>${esc(x.code)}</th>`).join('')}</tr></thead><tbody><tr><th>${esc(tx('msg.itt.pair.l'))}</th>${pairRows(lRow)}</tr><tr><th>${esc(tx('msg.itt.pair.s'))}</th>${pairRows(sRow)}</tr></tbody></table></div>`;
      const hist = `<h4>${esc(tx('msg.itt.history'))}</h4>${
        d.history.length
          ? `<div class="scroll-x"><table class="tbl"><thead><tr><th></th><th>${esc(tx('msg.itt.history.col.total'))}</th><th>${esc(tx('msg.itt.col.stanine'))}</th></tr></thead><tbody>${d.history
              .map(
                (h) =>
                  `<tr><td>${esc(day(h.created_at))}</td><td>${h.total.raw}</td><td>${h.total.stanine[g]} ${stanBar(h.total.stanine[g])}</td></tr>`,
              )
              .join('')}</tbody></table></div>`
          : `<p class="muted">${esc(tx('msg.itt.history.none'))}</p>`
      }`;
      return `<div class="itt-grp" data-g="${esc(g)}"${g === d.applied_group ? '' : ' hidden'}>${total}<h4>${esc(tx('msg.itt.subs.title'))}</h4>${table}${interp}${pair}${hist}</div>`;
    };
    const switcher = `<div class="itt-switch" data-testid="msg.itt.group.switch"><span>${esc(tx('msg.itt.group.switch'))}</span>${d.groups
      .map(
        (g) =>
          `<button type="button" class="btn small" data-itt-group="${esc(g.key)}" aria-pressed="${g.key === d.applied_group}">${esc(g.label)}</button>`,
      )
      .join('')}</div>`;
    return `<section class="card vcard" data-testid="msg.itt.title" data-itt="${esc(r.id)}"><h3>${esc(tx(d.scale === 'S' ? 'msg.itt.title.s' : 'msg.itt.title.l'))}</h3><div class="sub">${fill('msg.itt.meta', { date: day(d.created_at), version: d.instrument_version })}</div><p data-testid="msg.itt.group.applied">${fill('msg.itt.group.applied', { group: label(d.applied_group), reason: tx(`msg.itt.group.reason.${d.applied_reason}`) })}</p><p class="muted small">${esc(tx('msg.itt.group.assumption'))}</p>${switcher}${d.groups.map((g) => perGroup(g.key)).join('')}<p class="muted small" data-testid="msg.itt.disclaimer">${esc(tx('msg.itt.disclaimer'))}</p></section>`;
  };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-itt-group]');
    if (!b) return;
    const sec = b.closest('[data-itt]');
    qa('[data-itt-group]', sec).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    qa('.itt-grp', sec).forEach((x) => (x.hidden = x.dataset.g !== b.dataset.ittGroup));
  });

  const testShort = (code) =>
    ({ phq9: 'Тест на настроение', gad7: 'Тест на тревогу', who5: 'Тест на самочувствие' })[code] || instr(code);

  // ---------- специалист: карточка пациента ----------
  async function clinicianCard() {
    const root = q('#v2-card');
    if (!root) return;
    const id = root.dataset.patientId;
    const tab = root.dataset.tab;
    if (tab === 'overview' && window.CCPatientOverview) {
      await window.CCPatientOverview.mount(root, { api, tx, esc });
      return;
    }
    const holder = document.createElement('div');
    holder.id = 'card-rich';
    root.before(holder);
    const [tests, diary, plan, visits, signals, msgs] = await Promise.all([
      api(`/api/v1/patients/${id}?tab=tests`),
      api(`/api/v1/patients/${id}?tab=diary`),
      api(`/api/v1/patients/${id}/plan`),
      api(`/api/v1/patients/${id}/visits`),
      api('/api/v1/signals?kind=all&status=all'),
      api(`/api/v1/patients/${id}/messages`),
    ]);
    const results = (tests && tests.results) || [];
    const byCode = {};
    [...results]
      .reverse()
      .filter((r) => !r.scl90r && !r.itt && !r.stai) // суммы SCL-90-R (0–360) и ИТТ на общих графиках не показываются
      .forEach((r) => (byCode[r.instrument] = byCode[r.instrument] || []).push(r));
    const entries = ((diary && diary.items) || []).slice().reverse();
    const moods = entries.filter((x) => x.mood);
    const mySignals = ((signals && signals.items) || []).filter(
      (s) => String(s.patient && s.patient.id) === String(id),
    );
    const openSignals = mySignals.filter((s) => s.status !== 'handled');
    const published = plan && plan.published;
    const nextVisit = ((visits && visits.items) || []).find((v) => v.status === 'scheduled');
    const msgItems = ((msgs && (msgs.items || msgs.messages)) || []).slice();
    const ru = (n) => String(Math.round(n * 10) / 10).replace('.', ',');
    const mean = (a) => a.reduce((s, x) => s + x.mood, 0) / a.length;

    // шапка: что принимает и что беспокоит
    const status = q('[data-pstatus]');
    if (status) {
      const meds =
        published && published.items.length
          ? published.items
              .map(
                (i) =>
                  `${i.inn_name} ${i.dose} ${i.unit}${i.patient_dose ? ` (пациент указал: ${i.patient_dose.value} ${i.patient_dose.unit})` : ''}`,
              )
              .join(', ')
          : '';
      const crisisOpen = openSignals.some((s) => s.kind === 'crisis');
      status.innerHTML = [
        meds ? `<span>${esc(meds)}</span>` : '',
        openSignals.length
          ? `<span class="st ${crisisOpen ? 'st--crisis' : 'st--ae'}"><svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-${crisisOpen ? 'warning' : 'warning-circle'}"/></svg>${crisisOpen ? 'открытый сигнал безопасности' : 'побочный эффект'}</span>`
          : '',
      ].join('');
    }

    // плитки
    const week = moods.slice(-7);
    const before = moods.slice(-14, -7);
    const moodDelta = week.length && before.length ? mean(week) - mean(before) : null;
    const tRows = byCode.gad7 || byCode.phq9 || [];
    const tCode = byCode.gad7 ? 'gad7' : 'phq9';
    const tLast = tRows[tRows.length - 1];
    const tPrev = tRows[tRows.length - 2];
    const arrow = (d, goodDown) =>
      d === null || d === 0
        ? ''
        : `<small class="${d < 0 === goodDown ? 'up' : 'down'}">${d > 0 ? '↑' : '↓'} ${ru(Math.abs(d))}</small>`;
    const stats = `<div class="stats">
      <div class="stat"><small>Настроение, дневник</small><b>${week.length ? ru(mean(week)) : '—'} ${arrow(moodDelta, false)}</b><small>из 5 за неделю</small></div>
      <div class="stat"><small>${tCode === 'gad7' ? 'Тревога' : 'Настроение'}, тест</small><b>${tLast ? tLast.total_score : '—'} ${tLast && tPrev ? arrow(tLast.total_score - tPrev.total_score, true) : ''}</b><small>${tLast ? esc(day(tLast.created_at)) : 'нет результатов'}</small></div>
      <div class="stat"><small>Приём по плану</small><b>—</b><small>нет отметок ${soon('скоро')}</small></div>
    </div>`;

    // лента событий
    const ev = [];
    openSignals.forEach((s) =>
      ev.push({
        at: s.created_at || '',
        dot: s.kind === 'crisis' ? 'r' : 'y',
        title: s.kind === 'crisis' ? 'Сигнал безопасности: кризисная фраза в чате' : 'Побочный эффект',
        sub:
          s.kind === 'crisis'
            ? `${dayTime(s.created_at)} · пациенту показан 112`
            : [s.created_at ? dayTime(s.created_at) : '', esc((s.text || '').slice(0, 60))].filter(Boolean).join(' · '),
        href: '/work?tab=signals',
      }),
    );
    results.slice(0, 2).forEach((r) =>
      ev.push({
        at: r.created_at,
        dot: 'n',
        title: r.scl90r
          ? `${testShort(r.instrument)}: GSI ${ru2(r.scl90r.rows.find((x) => x.code === 'GSI').value)}`
          : `${testShort(r.instrument)}: ${r.total_score} баллов`,
        sub: day(r.created_at),
        href: '?ptab=tests',
        star: true,
      }),
    );
    ((diary && diary.analytics && diary.analytics.lines) || [])
      .filter((l) => l.tone === 'warn')
      .forEach((l) =>
        ev.push({
          at: entries.length ? entries[entries.length - 1].entry_date : '',
          dot: 'y',
          title: `Дневник: ${l.text.replace(/\.$/, '')}`,
          sub: 'по записям пациента',
          href: '?ptab=diary',
          star: true,
        }),
      );
    const lastPat = msgItems.filter((m) => m.sender_role === 'patient').slice(-1)[0];
    if (lastPat)
      ev.push({
        at: lastPat.created_at,
        dot: 'n',
        title: 'Сообщение от пациента',
        sub: `${dayTime(lastPat.created_at)} · «${esc(String(lastPat.body || lastPat.text || '').slice(0, 50))}»`,
        href: '?ptab=messages',
      });
    if (nextVisit)
      ev.push({
        at: nextVisit.starts_at,
        dot: 'n',
        title: 'Визит',
        sub: `${dayTime(nextVisit.starts_at)} · анкета ${nextVisit.previsit_enabled ? (visits.previsit ? 'заполнена' : 'не заполнена') : 'выключена'}`,
        href: '?ptab=treatment',
      });
    ev.sort((x, y) => String(y.at).localeCompare(String(x.at)));
    const timeline = ev.length
      ? `<div class="list">${ev
          .map(
            (e) =>
              `<a class="li ev" href="${esc(e.href)}"><span class="dotc ${e.dot}"></span><div class="grow"><b>${esc(e.title)}</b><small>${e.sub}</small></div><span class="go">${e.star ? '✦' : '→'}</span></a>`,
          )
          .join('')}</div>`
      : empty('Событий пока нет.');

    // Лекарства в карточке: что назначено, дозы, срок и что по этому поводу сказал пациент (правка — на вкладке «Лечение»).
    const medBadge = (i) =>
      !i.acceptance
        ? '<span class="rx-badge y">ждёт подтверждения пациента</span>'
        : i.acceptance.review_needed
          ? '<span class="rx-badge y">назначение изменено — пациент должен проверить</span>'
          : '<span class="rx-badge g">пациент принял</span>';
    const medsHtml =
      published && published.items.length
        ? `<p class="sec-label">Лекарства · план версия ${published.version}</p><div class="list">${published.items
            .map(
              (i) =>
                `<a class="li" href="?ptab=treatment"><span class="dotc ${i.acceptance && !i.acceptance.review_needed ? 'g' : 'y'}"></span><div class="grow"><b>${esc(cap(i.inn_name))} ${esc(i.dose)} ${esc(i.unit)}</b><small>${esc((i.times || []).join(', '))}${i.until ? ` · до ${esc(day(i.until))}` : ''}${i.patient_dose ? ` · пациент указал: ${esc(i.patient_dose.value)} ${esc(i.patient_dose.unit)}` : ''}${i.acceptance && i.acceptance.product ? ` · купил(а): ${esc(i.acceptance.product.name)}` : ''}</small>${medBadge(i)}</div><span class="go">→</span></a>`,
            )
            .join('')}</div>`
        : '';
    const visitHtml = nextVisit
      ? `<section class="card vcard"><div class="sub">Ближайший визит</div><h3>${esc(dayTime(nextVisit.starts_at))}</h3><div class="sub">${nextVisit.format === 'remote' ? 'дистанционно' : 'очно'}${nextVisit.place ? `, ${esc(nextVisit.place)}` : ''} · анкета перед приёмом ${nextVisit.previsit_enabled ? 'включена' : 'выключена'}</div></section>`
      : '';
    const testCharts = Object.entries(byCode).map(([code, rows]) => {
      const first = rows[0].total_score;
      const lastScore = rows[rows.length - 1].total_score;
      const delta = lastScore - first;
      return `<div class="mini"><h4>${esc(testShort(code))} · сейчас <b>${lastScore}</b> <small class="muted">(${delta === 0 ? 'без изменений' : delta < 0 ? `снижение на ${-delta}` : `рост на ${delta}`})</small></h4>${chart(
        rows.map((r) => ({ t: r.created_at, v: r.total_score, label: `${day(r.created_at)}: ${r.total_score}` })),
        { min: 0, title: `${instr(code)}`, height: 170, width: 420 },
      )}</div>`;
    });
    const moodChart = chart(
      moods.map((x) => ({ t: x.entry_date, v: x.mood, label: `${day(x.entry_date)}: ${x.mood}` })),
      { min: 1, max: 5, title: 'Настроение', height: 170, width: 420 },
    );
    const parts = {
      overview: stats + medsHtml + `<p class="sec-label">Что произошло</p>` + timeline,
      treatment: visitHtml,
      tests:
        (testCharts.length ? card('Динамика', `<div class="grid2">${testCharts.join('')}</div>`) : '') +
        (results.length
          ? `<p class="sec-label">Результаты</p>` +
            results
              .map((r) =>
                r.scl90r
                  ? scl90rBlock(r)
                  : r.itt
                    ? ittBlock(r)
                    : r.stai
                      ? `<section class="card vcard" data-stai="${esc(r.id)}"><h3>${esc(instr(r.instrument))} · ${esc(day(r.created_at))}</h3>${['reactive', 'personal'].map((key) => `<p><b>${esc(tx(`msg.tests.stai.${key}`))}</b>: ${esc(r.stai[key]?.raw)} · ${esc(r.stai[key]?.band)}</p>`).join('')}<p class="muted small">${esc(tx('msg.tests.review_required'))}</p></section>`
                      : `<section class="card vcard"><div class="row2"><div class="grow"><h3>${esc(testShort(r.instrument))} · ${esc(day(r.created_at))}</h3><div class="sub">${r.total_score} баллов · ${r.self_initiated ? 'сам пациент, показано врачу' : 'назначено врачом'}</div></div></div></section>`,
              )
              .join('')
          : card('Результаты', empty('Результатов нет.'))) +
        (tests && tests.offline_results && tests.offline_results.length
          ? card(
              'Очные результаты',
              `<ul class="vlist">${tests.offline_results.map((r) => `<li data-offline-result="${esc(r.id)}"><b>${esc(instr(r.instrument))}${r.test_date ? ` · ${esc(day(r.test_date))}` : ''}</b><span>${r.total_score == null ? (r.entry_method === 'photo' ? 'без баллов' : '— баллов') : `${r.total_score} баллов`}${r.band && r.band !== 'review_required' ? ` · ${esc(r.band)}` : ''}${r.risk_flag ? ' · <strong class="warn">кризисный пункт</strong>' : ''}</span><em>${r.erroneous ? 'отмечен ошибочным' : r.entry_method === 'photo' ? 'фото бланка' : r.status === 'draft' ? 'очно · черновик' : 'очно, внёс врач'}${r.source_file_id ? ` · <a href="/api/v1/files/${esc(r.source_file_id)}" download data-offline-file>открыть фото</a>` : ''}</em></li>`).join('')}</ul>`,
            )
          : ''),
      diary:
        (((diary && diary.analytics && diary.analytics.lines) || []).length
          ? card(
              'Что видно по дневнику',
              `<ul class="obs">${diary.analytics.lines.map((l) => `<li${l.tone === 'warn' ? ' class="warn"' : ''}>${esc(l.text)}</li>`).join('')}</ul><p class="muted small">Числа за ${diary.analytics.window_days} дней по записям пациента. Это не оценка и не рекомендация.</p>`,
            )
          : '') +
        card('Настроение за 2 недели', moodChart || empty('Записей нет.')) +
        (entries.length
          ? card(
              'Записи',
              entries
                .slice()
                .reverse()
                .slice(0, 20)
                .map(
                  (x) =>
                    `<div class="nrow"><span class="d">${esc(day(x.entry_date))}</span>${x.mood ? `<i class="ddot sm" data-m="${x.mood}" title="${MOOD_TITLE[x.mood]}"></i>` : '<i></i>'}<span>${esc([x.mood ? MOOD_TITLE[x.mood] : '', x.sleep ? `сон: ${SLEEP_SHORT[x.sleep]}` : '', x.anxiety ? `тревога: ${ANX_SHORT[x.anxiety]}` : ''].filter(Boolean).join(' · '))}${x.note ? `<br><span class="quote">«${esc(x.note)}»</span>` : ''}</span></div>`,
                )
                .join(''),
            )
          : ''),
      messages: '',
      docs: '',
    };
    holder.innerHTML = parts[tab] === undefined ? parts.overview : parts[tab];
    if (tab === 'diary') {
      const workspace = await api(`/api/v1/patients/${id}/diary-workspace`);
      if (workspace?.state) {
        const state = workspace.state;
        const habitRows = (state.habits || [])
          .map((h) => {
            const records = Object.entries(state.entries[h.id] || {})
              .sort(([a], [b]) => b.localeCompare(a))
              .slice(0, 14);
            return `<h4>${esc(h.name)}</h4>${records.map(([date, values]) => `<p><time>${esc(day(date))}</time> · ${values.map((v) => esc(v === true ? '✓' : v === false ? '−' : v)).join(', ')} ${esc(h.unit || '')}</p>`).join('')}`;
          })
          .join('');
        const notes = (state.dayNotes || [])
          .slice()
          .sort((a, b) => b.day.localeCompare(a.day))
          .slice(0, 30)
          .map(
            (n) => `<div class="nrow"><time>${esc(day(n.day))}</time><span class="quote">${esc(n.text)}</span></div>`,
          )
          .join('');
        if (habitRows) holder.insertAdjacentHTML('beforeend', card(tx('msg.diary.workspace.shared_habits'), habitRows));
        if (notes) holder.insertAdjacentHTML('beforeend', card(tx('msg.diary.workspace.shared_notes'), notes));
      }
    }

    if (tab === 'docs') {
      const docs = await api('/api/v1/documents');
      const mine = ((docs && docs.items) || []).filter((d) => String(d.patient_id) === String(id));
      holder.innerHTML = mine.length
        ? `<div class="list">${mine.map((d) => `<a class="li" href="/work?tab=docs"><div class="grow"><b>${esc(d.number || 'Документ')}</b><small>${esc(d.status)} · версия ${d.version}</small></div><span class="btn">Открыть</span></a>`).join('')}</div>`
        : empty('Документов нет. Создайте черновик на вкладке «Документы».');
    }
    // служебные элементы каркаса: в нужных вкладках остаются, в остальных скрыты
    if (!['overview', 'treatment'].includes(tab))
      qa('[data-testid="msg.v3.previsit.summary"]', root).forEach((n) => n.remove());
    if (tab !== 'tests')
      qa('[data-testid="msg.card.tests.package_start"],[data-testid="msg.card.tests.cancel"]', root).forEach((b) =>
        b.classList.add('visually-hidden-ctl'),
      );
  }

  const cap = (v) =>
    String(v || '')
      .charAt(0)
      .toUpperCase() + String(v || '').slice(1);

  // ---------- специалист: «⋮» в карточке пациента ----------
  function cardMenu() {
    q('.ptabs [aria-current]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
    const btn = q('[data-card-menu-btn]');
    if (!btn) return;
    const menu = q('[data-card-menu]');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('[data-card-menu]')) menu.hidden = true;
    });
    const open = q('[data-archive-open]', menu);
    if (!open) return;
    const id = q('#v2-card')?.dataset.patientId;
    open.addEventListener('click', () => {
      menu.hidden = true;
      const bg = document.createElement('div');
      bg.className = 'modal-bg';
      const reasons = [
        ['done', 'Курс завершён'],
        ['moved', 'Переведён(а) к другому специалисту'],
        ['refused', 'Отказ от наблюдения'],
        ['other', 'Другое'],
      ];
      bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Завершить наблюдение"><h3 data-testid="msg.card.archive.title">Завершить наблюдение?</h3><p data-testid="msg.card.archive.text">Назначения и напоминания остановятся, будущие визиты отменятся. Кабинет пациента станет только для чтения, «Мне нужна помощь · 112» продолжит работать. Вернуть пациента сможет администратор или новое приглашение.</p><p class="sec-label">Причина</p><div class="choices">${reasons.map(([k, label]) => `<button type="button" class="choice" data-reason="${k}" data-testid="msg.card.archive.reason.${k}" aria-pressed="false">${esc(label)}</button>`).join('')}</div><label class="arch-sum">Итоговая сводка — необязательно<textarea data-arch-summary maxlength="1000"></textarea></label><p class="sub" data-arch-out aria-live="polite"></p><div class="acts"><button type="button" class="btn ghost" data-testid="msg.card.archive.cancel" data-x>Не завершать</button><button type="button" class="btn primary danger-fill" data-testid="msg.card.archive.confirm" data-ok>Завершить наблюдение</button></div></div>`;
      document.body.appendChild(bg);
      let picked = '';
      bg.addEventListener('click', async (e) => {
        if (e.target === bg || e.target.closest('[data-x]')) return bg.remove();
        const c = e.target.closest('[data-reason]');
        if (c) {
          qa('[data-reason]', bg).forEach((x) => x.setAttribute('aria-pressed', String(x === c)));
          picked = c.dataset.reason;
          return;
        }
        if (e.target.closest('[data-ok]')) {
          const out = q('[data-arch-out]', bg);
          if (!picked) {
            out.textContent = 'Выберите причину.';
            return;
          }
          const label = reasons.find(([k]) => k === picked)[1];
          const summary = q('[data-arch-summary]', bg).value;
          const r = await post(`/api/v1/patients/${id}/archive`, { reason: label, summary, confirm: true });
          if (!r.ok) {
            out.textContent =
              r.status === 409 && r.data && r.data.error && r.data.error.code === 'E-CRISIS-OPEN'
                ? 'Есть открытый сигнал безопасности — сначала обработайте его.'
                : 'Не получилось завершить наблюдение.';
            return;
          }
          bg.remove();
          const body = q('.pcard .pbody');
          const date = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
          if (body)
            body.innerHTML = `<section class="card"><h3 data-testid="msg.card.archived">Наблюдение завершено ${esc(date)} · только чтение</h3><p class="sub">Пациент ушёл из списка в фильтр «Архив».</p></section>`;
          q(`.plist a.pi[data-id="${id}"]`)?.remove();
        }
      });
    });
  }

  // Предпросмотр методики для специалиста: что увидит пациент и как считается результат.
  const toolPreview = (pv) => {
    if (!pv) return '';
    const parts = [];
    if (pv.purpose) parts.push(`<p><b>Назначение.</b> ${esc(pv.purpose)}</p>`);
    if (pv.instruction)
      parts.push(
        `<p><b>${esc(tx(pv.mode === 'reference_only' ? 'msg.tests.instruction.specialist' : 'msg.tests.instruction.patient'))}.</b> ${esc(pv.instruction)}</p>`,
      );
    if (!pv.question_count && pv.expected_question_count)
      parts.push(`<p>${esc(tx('msg.tests.expected_count').replace('{count}', pv.expected_question_count))}</p>`);
    if (pv.options.length)
      parts.push(
        `<p><b>Варианты ответа.</b> ${pv.options.map((o) => `${esc(o.label)} (${o.score})`).join(' · ')}${pv.max_total ? ` · максимум ${pv.max_total} баллов` : ''}</p>`,
      );
    if (pv.questions.length)
      parts.push(
        `<details open><summary><b>Вопросы (${pv.questions.length})</b>${pv.question_title ? ` — ${esc(pv.question_title)}` : ''}</summary><ol class="tool-q">${pv.questions.map((x) => `<li value="${x.n}">${esc(x.text)}</li>`).join('')}</ol></details>`,
      );
    if (pv.bands.length)
      parts.push(`<p><b>Ключ.</b> ${pv.bands.map((b) => `${b.min}–${b.max}: ${esc(b.label)}`).join(' · ')}</p>`);
    if (pv.scales.length)
      parts.push(
        `<details><summary><b>Шкалы и толкование (${pv.scales.length})</b></summary>${pv.scales.map((x) => `<p><b>${esc(x.title)}</b> (${esc(x.code)}), пункты: ${x.items.join(', ')}.${x.direct ? `<br>${esc(tx('msg.tests.scale.direct'))}: ${x.direct.join(', ')}; ${esc(tx('msg.tests.scale.reverse'))}: ${x.reverse.join(', ')}; ${esc(tx('msg.tests.scale.offset'))}: ${x.offset}.` : ''}${x.interpretation ? `<br>${esc(x.interpretation)}` : ''}</p>`).join('')}</details>`,
      );
    if (pv.note) parts.push(`<p class="muted small">${esc(pv.note)}</p>`);
    if (pv.sources.length) parts.push(`<p class="muted small">Источники: ${pv.sources.map(esc).join('; ')}</p>`);
    return `<div class="tool-preview">${parts.join('')}</div>`;
  };

  // Очный бланк: та же шкала, что пациент проходит онлайн, только пустая — врач отмечает ответы с приёма,
  // сервер считает баллы тем же ключом и сохраняет результат в карточку пациента («Тесты» → «Очные результаты»).
  function offlineForm(list, people, selectedTool) {
    const box = q('#offline-form');
    if (!box) return;
    const today = () => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const field = (x) => {
      const name = `off-${x.id}`;
      if (x.type === 'single' || x.type === 'multi')
        return `<div class="choices" role="${x.type === 'single' ? 'radiogroup' : 'group'}">${x.options.map((o) => `<label class="choice"><input type="${x.type === 'single' ? 'radio' : 'checkbox'}" name="${esc(name)}" value="${esc(o.value)}">${esc(o.label)}</label>`).join('')}</div>`;
      if (x.type === 'number')
        return `<input type="number" name="${esc(name)}"${x.min !== undefined ? ` min="${esc(x.min)}"` : ''}${x.max !== undefined ? ` max="${esc(x.max)}"` : ''}>`;
      if (x.type === 'date') return `<input type="date" name="${esc(name)}">`;
      return `<textarea name="${esc(name)}" rows="2" maxlength="${x.type === 'text_long' ? 4000 : 300}"></textarea>`;
    };
    let current = null;
    const open = (code) => {
      const i = list.find((x) => x.code === code);
      const pv = i && i.preview;
      current = pv;
      if (!i || i.assignable === false || !pv || !pv.questions.length) {
        const ready = list.filter((x) => x.assignable !== false && x.preview?.questions?.length);
        box.innerHTML = `<p class="sub" role="status">Какую шкалу заполнить? Бланк откроется здесь.</p><div class="soon-tags">${ready.map((x) => `<button type="button" class="tag" data-offline-open="${esc(x.code)}">${esc(x.title || testShort(x.code))}</button>`).join('')}</div>`;
        return;
      }
      if (!people.length) {
        box.innerHTML = `<p class="sub" role="status">У вас пока нет закреплённых пациентов.</p>`;
        return;
      }
      box.innerHTML = `<section class="card offline-form" data-offline-form="${esc(i.code)}"><h3>${esc(i.title || testShort(i.code))} — очный бланк</h3><div class="row-fields"><label>Пациент<select data-offline-patient>${people.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label><label>Дата приёма<input type="date" data-offline-date value="${today()}" max="${today()}"></label></div>${pv.instruction ? `<p class="sub">${esc(pv.instruction)}</p>` : ''}<ol class="offline-q">${pv.questions.map((x) => `<li><fieldset data-q="${esc(x.id)}" data-type="${esc(x.type)}"${x.required ? ' data-required' : ''}><legend>${esc(x.text)}</legend>${field(x)}</fieldset></li>`).join('')}</ol><p class="muted small" data-offline-count></p><div class="acts"><button type="button" class="btn primary" data-offline-save>Сохранить в карточку</button><button type="button" class="btn" data-offline-cancel>Отмена</button></div><p class="sub" data-offline-out aria-live="polite"></p><p class="muted small">${esc(tx('msg.tests.review_required'))}</p></section>`;
      count();
      box.scrollIntoView({ block: 'start', behavior: 'smooth' });
    };
    const answers = () => {
      const out = {};
      box.querySelectorAll('fieldset[data-q]').forEach((fs) => {
        const id = fs.dataset.q;
        const type = fs.dataset.type;
        // значения вариантов в методике — строки или числа; отправляем ровно то значение, что в методике
        const options = (current?.questions.find((x) => x.id === id) || {}).options || [];
        const value = (raw) => (options.find((o) => String(o.value) === raw) || { value: raw }).value;
        if (type === 'multi') {
          const v = [...fs.querySelectorAll('input:checked')].map((x) => value(x.value));
          if (v.length) out[id] = v;
        } else if (type === 'single') {
          const v = fs.querySelector('input:checked');
          if (v) out[id] = value(v.value);
        } else {
          const v = fs.querySelector('input,textarea').value.trim();
          if (v) out[id] = type === 'number' ? Number(v) : v;
        }
      });
      return out;
    };
    const count = () => {
      const total = box.querySelectorAll('fieldset[data-q]').length;
      const done = Object.keys(answers()).length;
      const el = q('[data-offline-count]', box);
      if (el) el.textContent = `Отмечено ${done} из ${total}`;
    };
    // «Фото бланка»: снимок или скан бумажного бланка просто сохраняется в карточке пациента — без распознавания.
    // Подходит для любой методики, в том числе с рисунком или письмом от руки.
    const openPhoto = (file) => {
      const sel = selectedTool();
      const chosen = sel.startsWith('ins:') ? sel.slice(4) : '';
      if (!people.length) {
        box.innerHTML = `<p class="sub" role="status">У вас пока нет закреплённых пациентов.</p>`;
        return;
      }
      box.innerHTML = `<section class="card offline-form" data-offline-photo><h3>Фото бланка</h3><p class="sub">Файл: ${esc(file.name)}. Снимок сохранится в карточке пациента; баллы по нему не считаются.</p><div class="row-fields"><label>Пациент<select data-offline-patient>${people.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label><label>Шкала<select data-offline-tool>${list.map((i) => `<option value="${esc(i.code)}"${i.code === chosen ? ' selected' : ''}>${esc(i.title || testShort(i.code))}</option>`).join('')}</select></label><label>Дата приёма<input type="date" data-offline-date value="${today()}" max="${today()}"></label></div><div class="acts"><button type="button" class="btn primary" data-photo-save>Сохранить в карточку</button><button type="button" class="btn" data-offline-cancel>Отмена</button></div><p class="sub" data-offline-out aria-live="polite"></p></section>`;
      box._photo = file;
      box.scrollIntoView({ block: 'start', behavior: 'smooth' });
    };
    q('[data-testid="msg.composer.attach.photo"]')?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) openPhoto(file);
    });
    document.addEventListener('click', (e) => {
      const opener = e.target.closest('[data-offline-open]');
      if (opener) {
        const sel = selectedTool();
        open(opener.dataset.offlineOpen || (sel.startsWith('ins:') ? sel.slice(4) : ''));
      }
    });
    box.addEventListener('change', (e) => {
      if (e.target.closest('fieldset[data-q]')) {
        e.target.closest('fieldset[data-q]').classList.remove('is-missing');
        count();
      }
    });
    box.addEventListener('click', async (e) => {
      if (e.target.closest('[data-offline-cancel]')) {
        box.innerHTML = '';
        return;
      }
      const photoSave = e.target.closest('[data-photo-save]');
      if (photoSave) {
        const out = q('[data-offline-out]', box);
        photoSave.disabled = true;
        out.textContent = 'Сохраняю…';
        const token = (await (await fetch('/api/v1/csrf')).json()).token;
        const fd = new FormData();
        fd.append('file', box._photo, box._photo.name);
        fd.append('purpose', 'offline_result');
        const up = await fetch('/api/v1/uploads', {
          method: 'POST',
          headers: { 'x-csrf-token': token, 'idempotency-key': crypto.randomUUID() },
          body: fd,
        });
        const uploaded = await up.json().catch(() => ({}));
        if (!up.ok || !uploaded.id) {
          photoSave.disabled = false;
          out.textContent =
            up.status === 413
              ? 'Файл слишком большой (до 10 МБ).'
              : up.status === 415 || up.status === 422
                ? 'Нужен снимок JPG или PNG либо PDF.'
                : 'Не получилось загрузить файл. Попробуйте ещё раз.';
          return;
        }
        const who = q('[data-offline-patient]', box).value;
        const r = await post(`/api/v1/patients/${who}/offline-results`, {
          instrument_code: q('[data-offline-tool]', box).value,
          method: 'photo',
          upload_id: uploaded.id,
          held_on: q('[data-offline-date]', box).value || undefined,
        });
        photoSave.disabled = false;
        if (!r.ok) {
          out.textContent = 'Не получилось сохранить в карточку. Попробуйте ещё раз.';
          return;
        }
        const name = q('[data-offline-patient] option:checked', box).textContent;
        box.innerHTML = `<section class="card" data-offline-saved="${esc(r.data.id)}" role="status"><h3>Фото сохранено в карточку</h3><p>${esc(name)}: бланк хранится в карточка → «Тесты» → «Очные результаты».</p><div class="acts"><a class="btn" href="/work/patients/${esc(who)}?ptab=tests">Открыть карточку</a></div></section>`;
        return;
      }
      const save = e.target.closest('[data-offline-save]');
      if (!save) return;
      const form = q('[data-offline-form]', box);
      const out = q('[data-offline-out]', box);
      const given = answers();
      const missing = [...box.querySelectorAll('fieldset[data-required]')].filter(
        (fs) => given[fs.dataset.q] === undefined,
      );
      box.querySelectorAll('fieldset.is-missing').forEach((fs) => fs.classList.remove('is-missing'));
      if (missing.length) {
        missing.forEach((fs) => fs.classList.add('is-missing'));
        out.textContent = `Не отмечено пунктов: ${missing.length}. Они подсвечены.`;
        missing[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      save.disabled = true;
      const who = q('[data-offline-patient]', box).value;
      const r = await post(`/api/v1/patients/${who}/offline-results`, {
        instrument_code: form.dataset.offlineForm,
        method: 'manual',
        answers: given,
        held_on: q('[data-offline-date]', box).value || undefined,
      });
      save.disabled = false;
      if (!r.ok) {
        out.textContent =
          r.status === 422
            ? 'Проверьте ответы: не все пункты отмечены.'
            : r.status === 403
              ? 'Нет доступа к этому пациенту или шкале.'
              : 'Не получилось сохранить. Попробуйте ещё раз.';
        return;
      }
      const name = q('[data-offline-patient] option:checked', box).textContent;
      box.innerHTML = `<section class="card" data-offline-saved="${esc(r.data.id)}" role="status"><h3>Сохранено в карточку</h3><p>${esc(name)}: ${esc(r.data.total_score)} баллов${r.data.band && r.data.band !== 'review_required' ? ` · ${esc(r.data.band)}` : ''}.</p>${r.data.risk_flag ? '<p class="warn"><b>Отмечен кризисный пункт</b> — создан сигнал на проверку.</p>' : ''}<div class="acts"><a class="btn" href="/work/patients/${esc(who)}?ptab=tests">Открыть карточку</a><button type="button" class="btn" data-offline-open="${esc(form.dataset.offlineForm)}">Заполнить ещё</button></div></section>`;
    });
  }

  // ---------- специалист: тесты и пакеты ----------
  async function clinicianTools() {
    const root = q('#work-tools');
    if (!root) return;
    const people = JSON.parse(decodeURIComponent(root.dataset.patients || '[]'));
    const [ins, pk] = await Promise.all([api('/api/v1/instruments'), api('/api/v1/packages')]);
    const list = (ins && ins.items) || [];
    const packs = (pk && pk.items) || [];
    const linkedTool = new URLSearchParams(location.search).get('tool');
    // Без ссылки на конкретный тест подробности не открыты: сверху — карточки, выбор — по нажатию.
    let selected = list.some((i) => i.code === linkedTool) ? `ins:${linkedTool}` : linkedTool === 'hads' ? 'hads' : '';

    const detail = () => {
      if (!selected) return '';
      const [kind, id] = selected.split(':');
      if (kind === 'ins') {
        const i = list.find((x) => x.code === id);
        if (!i) return '';
        return `<section class="card" data-tool="${esc(i.code)}"><h3>${esc(i.title || testShort(i.code))}</h3><div class="sub">${esc(tx(`msg.tests.mode.${i.mode || 'assignable'}`))}${i.preview?.question_count ? ` · ${i.preview.question_count} вопросов` : ''}</div>${i.assignable !== false ? `<div class="acts"><button type="button" class="btn primary" data-assign="${esc(i.code)}">Назначить</button>${i.preview?.question_count ? `<button type="button" class="btn" data-offline-open="${esc(i.code)}">Внести очный результат</button><a class="btn" href="/print/test/${encodeURIComponent(i.code)}" target="_blank" rel="noopener">Распечатать бланк</a>` : ''}</div>` : ''}${toolPreview(i.preview)}<p class="muted small">${esc(tx('msg.tests.review_required'))}</p></section><div id="assign-flow"></div>`;
      }
      if (kind === 'pack') {
        const x = packs.find((p) => String(p.id) === id);
        return x
          ? `<section class="card"><h3>${esc(x.title || 'Пакет')}</h3><div class="sub">${(x.items || []).map((c) => esc((list.find((i) => i.code === c) || {}).title || c)).join(' · ')}</div><div class="acts"><button type="button" class="btn primary" data-assign-pack="${x.id}">Назначить</button></div></section><div id="assign-flow"></div>`
          : '';
      }
      return `<section class="card"><h3>Пакет «Старт»</h3><div class="sub">настроение + тревога, раз в 2 недели ${soon()}</div><div class="acts"><button type="button" class="btn" disabled>Назначить</button></div></section><div id="assign-flow"></div>`;
    };
    const paint = () => {
      const testCard = (key, title, sub, badge, tone) =>
        `<button type="button" class="tcard tone-${tone}${selected === key ? ' is-on' : ''}" data-toolcard="${esc(key)}" aria-pressed="${selected === key}"><span class="tcard-ico"><svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-clipboard-text"/></svg></span><span class="tcard-kind">${badge}</span><h3>${esc(title)}</h3><p>${sub}</p></button>`;
      const ready = list.filter((i) => (i.mode || 'assignable') !== 'awaiting_text');
      const soon = list.filter((i) => (i.mode || 'assignable') === 'awaiting_text');
      const grid = `<section class="tech-section" aria-labelledby="tests-title"><div class="tech-head"><h2 id="tests-title">Тесты для назначения</h2><p>Назначаются пациенту кнопкой «Назначить» — он увидит тест у себя во вкладке «Методики».</p></div><div class="tech-grid">${ready
        .map((i) =>
          testCard(
            `ins:${i.code}`,
            i.title || testShort(i.code),
            i.preview?.question_count ? `${i.preview.question_count} вопросов` : '',
            esc(tx(`msg.tests.mode.${i.mode || 'assignable'}`)),
            i.assignable === false ? 'sage' : 'jade',
          ),
        )
        .join('')}${packs
        .map((x) =>
          testCard(`pack:${x.id}`, x.title || 'Пакет', `${(x.items || []).length} опросников`, 'Пакет', 'honey'),
        )
        .join(
          '',
        )}</div>${soon.length ? `<details class="soon-list"><summary>Скоро появятся (${soon.length})</summary><div class="soon-tags">${soon.map((i) => `<button type="button" class="tag" data-toolcard="ins:${esc(i.code)}">${esc(i.title || testShort(i.code))}</button>`).join('')}</div></details>` : ''}</section>`;
      root.innerHTML =
        grid +
        (selected === 'hads'
          ? '<section class="card"><h3>HADS</h3><div class="sub">Госпитальная шкала тревоги и депрессии. Скоро появится.</div></section>'
          : detail());
    };
    paint();
    offlineForm(list, people, () => selected);
    root.addEventListener('click', (e) => {
      const cardBtn = e.target.closest('[data-toolcard]');
      if (!cardBtn) return;
      selected = cardBtn.dataset.toolcard;
      const url = new URL(location.href);
      if (selected.startsWith('ins:')) url.searchParams.set('tool', selected.slice(4));
      else url.searchParams.delete('tool');
      history.replaceState(null, '', url);
      paint();
      q('[data-tool], #assign-flow', root)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-assign],[data-assign-pack]');
      if (b) {
        const pack = packs.find((x) => String(x.id) === b.dataset.assignPack);
        const what = pack ? `пакет «${esc(pack.title)}»` : esc(testShort(b.dataset.assign));
        const target = pack ? `data-send-pack="${pack.id}"` : `data-send="${esc(b.dataset.assign)}"`;
        q('#assign-flow', root).innerHTML =
          `<section class="card"><h3>Назначить ${what}</h3><div class="row-fields"><select id="assign-who" aria-label="Пациент">${people.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select><button type="button" class="btn primary" ${target}>Отправить пациенту</button></div><p id="assign-out" class="sub" aria-live="polite"></p></section>`;
        return;
      }
      const send = e.target.closest('[data-send],[data-send-pack]');
      if (send) {
        const who = q('#assign-who', root).value;
        const body = send.dataset.sendPack
          ? { package_id: Number(send.dataset.sendPack) }
          : { instrument_code: send.dataset.send };
        const r = await post(`/api/v1/patients/${who}/assignments`, body);
        q('#assign-out', root).textContent = r.ok
          ? 'Отправлено пациенту. Он увидит тест во вкладке «Методики».'
          : r.status === 409
            ? 'Этот тест уже назначен пациенту и ещё не пройден.'
            : 'Не получилось назначить.';
      }
    });
  }

  // ---------- специалист: аналитика ----------
  async function clinicianAnalytics() {
    const root = q('#work-analytics');
    if (!root) return;
    const names = JSON.parse(decodeURIComponent(root.dataset.patients || '[]'));
    const cohort = await api('/api/v1/analytics/my-patients?by=diary');
    const rows = [];
    for (const p of names) {
      const [tests, diary] = await Promise.all([
        api(`/api/v1/patients/${p.id}?tab=tests`),
        api(`/api/v1/patients/${p.id}?tab=diary`),
      ]);
      const res = (tests && tests.results) || [];
      const pick = (code) => {
        const arr = res.filter((r) => r.instrument === code).reverse();
        return arr.length ? { first: arr[0].total_score, last: arr[arr.length - 1].total_score, n: arr.length } : null;
      };
      const moods = ((diary && diary.items) || []).filter((x) => x.mood).map((x) => x.mood);
      rows.push({
        p,
        phq: pick('phq9'),
        gad: pick('gad7'),
        mood: moods.length ? moods.reduce((a, b) => a + b, 0) / moods.length : null,
        entries: moods.length,
      });
    }
    const cell = (x) =>
      x
        ? `${x.first} → <b>${x.last}</b> ${x.last < x.first ? '<span class="good">↓</span>' : x.last > x.first ? '<span class="bad">↑</span>' : '→'}`
        : '—';
    const N = rows.length;
    const small = N < 10;
    const diaryNow = rows.filter((r) => r.entries > 0).length;
    const withTests = rows.filter((r) => r.phq || r.gad).length;
    const improved = rows.filter((r) => r.phq && r.phq.last < r.phq.first).length;
    const tile = (label, num, den, how) =>
      `<div class="stat"><small>${label}</small><b>${small ? '—' : `${Math.round((num / den) * 100)}%`}</b><small>${small ? 'мало данных' : `${num} из ${den}`}</small><details class="how"><summary>Как считается</summary><p>${how}</p></details></div>`;
    root.innerHTML =
      `<div id="ins-own"></div><h2 class="sec-h">Аналитика по вашим пациентам</h2><div class="stats">${tile('Проходят тесты', withTests, N || 1, 'Доля ваших пациентов, у которых есть хотя бы один результат теста.')}${tile('Ведут дневник', diaryNow, N || 1, 'Доля пациентов, у которых есть записи в дневнике.')}${tile('Улучшение по PHQ-9', improved, N || 1, 'Доля пациентов, у которых последний результат ниже первого. Баллы — STAND-IN, не диагноз.')}</div>` +
      (small
        ? `<p class="sub" data-testid="msg.analytics.small">Недостаточно данных для общих цифр: в группе меньше 10. Ниже — ваши пациенты по отдельности.</p>`
        : '') +
      `<p class="footnote left" data-testid="msg.analytics.not_rating">Это не рейтинг пациентов и специалистов.</p>` +
      card(
        'Дневник вашей когорты',
        window.CCCohort
          ? window.CCCohort.html(cohort, {
              url: '/api/v1/analytics/export?section=diary',
              label: tx('msg.analytics.export.csv_diary', 'Скачать CSV'),
              testid: 'msg.analytics.export.csv_diary',
            })
          : '',
      ) +
      card(
        'По вашим пациентам',
        `<table class="vtable"><thead><tr><th>Пациент</th><th>PHQ-9 (первый → последний)</th><th>GAD-7</th><th>Настроение (среднее)</th><th>Записей</th></tr></thead><tbody>${rows.map((r) => `<tr><td><a href="/work/patients/${r.p.id}">${esc(r.p.name)}</a></td><td>${cell(r.phq)}</td><td>${cell(r.gad)}</td><td>${r.mood ? r.mood.toFixed(1) : '—'}</td><td>${r.entries}</td></tr>`).join('')}</tbody></table><p class="muted small">Баллы — STAND-IN методики, не диагноз. Стрелка показывает изменение между первым и последним результатом.</p>`,
      ) +
      (root.dataset.research === '1'
        ? card(
            'Сравнение онлайн и очно',
            `<p class="sub" data-testid="msg.analytics.research.title">Сравнение онлайн и очно</p><p class="muted small">Только пациенты с согласием на исследования. Группы меньше 10 скрыты.</p><div class="acts"><button type="button" class="btn" disabled>Скачать CSV с псевдонимами</button> ${soon()}</div><p class="muted small">Данных недостаточно для вывода.</p>`,
          )
        : '');
    if (window.CCInsights) window.CCInsights.mount(q('#ins-own', root), { url: '/api/v1/analytics/my-insights' });
    // Список слева: разделы отчёта; выбор прокручивает к разделу (все разделы остаются на странице).
    const side = q('[data-analytics-side]');
    if (side) {
      const sections = [
        ['Обзор', 'цифры по вашим пациентам', q('.sec-h', root)],
        ['Дневник когорты', 'общие цифры', qa('.vcard', root).find((c) => /Дневник вашей когорты/.test(c.textContent))],
        ['По пациентам', 'таблица динамики', qa('.vcard', root).find((c) => /По вашим пациентам/.test(c.textContent))],
        ...(root.dataset.research === '1'
          ? [
              [
                'Сравнение онлайн и очно',
                'исследование',
                qa('.vcard', root).find((c) => /Сравнение онлайн и очно/.test(c.textContent)),
              ],
            ]
          : []),
      ].filter(([, , el]) => el);
      side.innerHTML = sections
        .map(
          ([title, sub], n) =>
            `<a href="#" class="th${n === 0 ? ' on' : ''}" data-ansel="${n}"><span>${esc(title)}</span><br><small class="lib-row-sub">${esc(sub)}</small></a>`,
        )
        .join('');
      side.addEventListener('click', (e) => {
        const link = e.target.closest('[data-ansel]');
        if (!link) return;
        e.preventDefault();
        side.querySelectorAll('[data-ansel]').forEach((x) => x.classList.toggle('on', x === link));
        sections[Number(link.dataset.ansel)][2].scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  document.addEventListener('click', async (e) => {
    const step = e.target.closest('[data-route-role]');
    if (!step) return;
    const r = await post('/api/v1/demo/login-as', { role: step.dataset.routeRole });
    if (r.ok) location.assign(step.dataset.routeUrl);
  });

  async function init() {
    try {
      const r = await fetch('/assets/ru.json');
      if (r.ok) TX = await r.json();
    } catch (_) {
      TX = {};
    }
    polishTexts();
    const jobs = [
      patientDiary,
      patientTests,
      patientMeds,
      cardMenu, // меню «⋮» не ждёт загрузки списка: клик сразу после открытия не должен теряться
      clinicianPatients,
      clinicianCard,
      clinicianTools,
      clinicianAnalytics,
    ];
    for (const job of jobs) {
      try {
        await job();
      } catch (e) {
        console.warn('views', job.name, e);
      }
    }
  }
  document.addEventListener('DOMContentLoaded', init);
})();
