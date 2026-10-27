'use strict';

/**
 * Клиент ИИ-чата специалиста (P-20, W-35): выбор закреплённого пациента через «@»
 * (список зашит в страницу сервером — только свои закреплённые пациенты), подсказки
 * объектов пациента (F-12), отправка POST /api/v1/ai/clinician/messages с чипами
 * (F-13), ответ — черновик с пометкой ИИ, кнопками «В черновик документа»,
 * «Открыть карточку» и оценкой 👍/👎 (F-31). Тексты — ключами ru.json (data-атрибуты
 * шаблона), содержимого объектов в клиент не передаётся (PD-14).
 */

(function () {
  const root = document.querySelector('[data-work-chat]');
  if (!root) return;

  // drug — препарат, прикреплённый к чату (тред создаётся при первом вопросе); panel — открытая справа карточка.
  const state = { patients: [], patient: null, chips: [], suggestions: [], drug: null, clinrec: null, panel: null };
  // Опрос о нежелательном явлении (пакеты D/E плана 2026-10-23-ae-intake): handled — пациенты, по которым предложение
  // закрыто, отправлено или отклонено (не повторять); threadId — тред текущего разговора о пациенте.
  const ae = { handled: new Set(), open: null, threadId: null };
  // Тред открытого разговора: из ?thread=, из ответа сервера; fresh — «Новый чат» (следующий вопрос начнёт тред).
  const chat = { threadId: new URLSearchParams(window.location.search).get('thread'), fresh: false };
  try {
    state.patients = JSON.parse(decodeURIComponent(root.dataset.patients || '[]'));
  } catch (_) {
    state.patients = [];
  }

  const feed = root.querySelector('[data-feed]');
  const hello = root.querySelector('[data-hello]');
  const field = root.querySelector('[data-testid="msg.wchat.placeholder"]');
  const send = root.querySelector('[data-testid="msg.composer.send"]');
  const chipsBox = root.querySelector('[data-chips]');
  const suggRow = root.querySelector('[data-suggestions]');
  const mention = root.querySelector('[data-mention]');
  const panel = root.querySelector('[data-drug-panel]');
  const panelBody = root.querySelector('[data-drug-panel-body]');
  const panelView = root.querySelector('[data-drug-panel-view]');
  const rail = root.querySelector('[data-alert-rail]');
  const panelAsk = root.querySelector('[data-drug-ask]');
  const panelClose = root.querySelector('[data-drug-panel-close]');
  const pickField = root.querySelector('[data-pick-search]');
  const pickBox = root.querySelector('[data-pick-results]');
  let drugText = {};
  try {
    drugText = JSON.parse(decodeURIComponent(root.dataset.drugStrings || '{}'));
  } catch (_) {
    drugText = {};
  }
  let clinText = {};
  try {
    clinText = JSON.parse(decodeURIComponent(root.dataset.clinrecStrings || '{}'));
  } catch (_) {
    clinText = {};
  }
  const resizer = root.querySelector('[data-panel-resizer]');
  const ctxLabel = root.querySelector('[data-chips-label]');
  const suggBox = root.querySelector('.chat-sugg');
  let instrText = {};
  try {
    instrText = JSON.parse(decodeURIComponent(root.dataset.instrStrings || '{}'));
  } catch (_) {
    instrText = {};
  }
  const docs = window.CCDrugDocs ? window.CCDrugDocs.create({ text: instrText }) : null;
  let sourceText = {};
  try {
    sourceText = JSON.parse(decodeURIComponent(root.dataset.sourceStrings || '{}'));
  } catch (_) {
    sourceText = {};
  }
  // Карточки источников под ответом и их просмотр в правой панели (public/js/work_sources.js).
  const sourcesUI = window.CCSources
    ? window.CCSources.create({
        text: { ...sourceText, loading: clinText.loading, more: clinText.more, version: clinText.version, pdf: clinText.pdf, figure: clinText.figure, page: instrText.page },
        renderMarkdown: window.CCDrugDocs ? window.CCDrugDocs.renderMarkdown : null,
      })
    : null;

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function note(text) {
    let node = root.querySelector('[data-note]');
    if (!node) {
      node = el('p', { 'data-note': '', 'data-testid': 'msg.composer.chips.note' });
      chipsBox.after(node);
    }
    node.textContent = text || '';
    node.hidden = !text;
  }

  function renderChips() {
    chipsBox.innerHTML = '';
    if (state.patient) {
      const chip = el(
        'button',
        {
          type: 'button',
          'data-testid': 'msg.wchat.patient_chip',
          'data-type': 'patient',
          'data-id': String(state.patient.id),
        },
        (root.dataset.tPatientChip || '').replace('{name}', state.patient.name),
      );
      const remove = el('span', { 'data-testid': 'msg.composer.chip.remove', 'aria-label': '×' }, '×');
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        clearSubject();
      });
      chip.appendChild(remove);
      chipsBox.appendChild(chip);
    }
    if (state.drug) {
      const chip = el(
        'button',
        {
          type: 'button',
          'data-testid': 'msg.wchat.drug_chip',
          'data-type': 'drug',
          'data-id': String(state.drug.drug.id),
        },
        (drugText.chip || '{name}').replace('{name}', cap(state.drug.drug.name)),
      );
      chip.addEventListener('click', () => {
        if (!state.panel || !state.panel.drug || state.panel.drug.id !== state.drug.drug.id) openPanel(state.drug.drug);
      });
      const remove = el('span', { 'data-testid': 'msg.composer.chip.remove', 'aria-label': '×' }, '×');
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        detachDrug();
      });
      chip.appendChild(remove);
      chipsBox.appendChild(chip);
    }
    if (state.clinrec) {
      const chip = el(
        'button',
        {
          type: 'button',
          'data-testid': 'msg.wchat.clinrec_chip',
          'data-type': 'clinrec',
          'data-id': String(state.clinrec.doc.id),
        },
        (clinText.chip || '{name}').replace('{name}', state.clinrec.doc.title),
      );
      chip.addEventListener('click', () => {
        if (!state.panel || !state.panel.clinrec || state.panel.clinrec.id !== state.clinrec.doc.id)
          selectClinrec(state.clinrec.doc.id);
      });
      const remove = el('span', { 'data-testid': 'msg.composer.chip.remove', 'aria-label': '×' }, '×');
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        detachClinrec();
      });
      chip.appendChild(remove);
      chipsBox.appendChild(chip);
    }
    state.chips.forEach((chip, i) => {
      const node = el(
        'button',
        { type: 'button', 'data-testid': 'msg.composer.chip', 'data-type': chip.type, 'data-id': String(chip.id) },
        chip.label,
      );
      const remove = el('span', { 'data-testid': 'msg.composer.chip.remove', 'aria-label': '×' }, '×');
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        state.chips.splice(i, 1);
        renderChips();
      });
      node.appendChild(remove);
      chipsBox.appendChild(node);
    });
    if (ctxLabel) ctxLabel.hidden = !chipsBox.children.length;
  }

  function renderSuggestions() {
    if (!suggRow) return;
    suggRow.innerHTML = '';
    state.suggestions.forEach((sug) => {
      if (state.chips.some((c) => c.type === sug.chip.type && String(c.id) === String(sug.chip.id))) return;
      const btn = el('button', { type: 'button', 'data-testid': 'msg.composer.suggestion' }, sug.label);
      btn.addEventListener('click', () => {
        if (state.chips.length >= 5) {
          note('Не больше пяти чипов в одном сообщении');
          return;
        }
        state.chips.push(sug.chip);
        renderChips();
        renderSuggestions();
      });
      suggRow.appendChild(btn);
    });
  }

  async function loadSuggestions() {
    if (!state.patient) {
      state.suggestions = [];
      renderSuggestions();
      return;
    }
    try {
      const res = await fetch(
        `/api/v1/context/suggestions?tab=chat&patient_id=${encodeURIComponent(state.patient.id)}`,
        {
          headers: { Accept: 'application/json' },
        },
      );
      if (res.ok) {
        const body = await res.json();
        state.suggestions = Array.isArray(body.items) ? body.items : [];
      }
    } catch (_) {
      state.suggestions = [];
    }
    renderSuggestions();
  }

  // ---- «@»: поиск только среди закреплённых пациентов (список — в странице) ----

  function mentionQuery(text) {
    const m = /@([^@\s]*)$/.exec(text || '');
    return m ? m[1].toLowerCase() : null;
  }

  function renderMention(query) {
    mention.innerHTML = '';
    if (query === null) {
      mention.hidden = true;
      return;
    }
    const hits = state.patients.filter((p) => p.name.toLowerCase().includes(query)).slice(0, 8);
    for (const p of hits) {
      const opt = el('button', { type: 'button', role: 'option', 'data-id': String(p.id) }, p.name);
      opt.addEventListener('click', () => {
        field.value = field.value.replace(/@[^@\s]*$/, '').trimEnd();
        mention.innerHTML = '';
        mention.hidden = true;
        selectPatient(p);
        field.focus();
      });
      mention.appendChild(opt);
    }
    mention.hidden = hits.length === 0;
  }

  field.addEventListener('input', () => renderMention(mentionQuery(field.value)));
  field.addEventListener('blur', () =>
    setTimeout(() => {
      mention.innerHTML = '';
      mention.hidden = true;
    }, 150),
  );

  root.querySelectorAll('.idea').forEach((btn) => {
    btn.addEventListener('click', () => {
      field.value = btn.dataset.idea || '';
      field.focus();
    });
  });

  // ---- отправка: POST /api/v1/ai/clinician/messages, ответ — черновик с пометкой ИИ ----

  async function postJson(path, body) {
    const token = (await (await fetch('/api/v1/csrf')).json()).token;
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': token, 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify(body),
    });
  }

  function addBubble(kind, text) {
    const row = el('div', { class: `msg ${kind === 'user' ? 'me' : 'ai'}`, 'data-testid': `msg.wchat.${kind}` });
    row.appendChild(el('div', { class: 'bubble' }, text));
    feed.appendChild(row);
    row.scrollIntoView({ block: 'end' });
    return row;
  }

  function addReplyActions(row, reply) {
    const meta = el('div', { class: 'meta reply-actions' });
    meta.appendChild(el('span', { 'data-testid': 'msg.ai.clinician.under_answer' }, root.dataset.tUnderAnswer || ''));
    const rate = async (useful) => {
      const res = await postJson(`/api/v1/ai/messages/${encodeURIComponent(reply.id)}/rating`, { useful });
      if (!res.ok) return;
      up.remove();
      down.remove();
      meta.appendChild(el('span', { 'data-testid': 'msg.ai.rate.thanks' }, 'Спасибо, учтём'));
    };
    const up = el(
      'button',
      { type: 'button', 'aria-label': root.dataset.tRateUseful || 'Полезно', 'data-testid': 'msg.ai.rate.useful' },
      '👍',
    );
    const down = el(
      'button',
      {
        type: 'button',
        'aria-label': root.dataset.tRateNotUseful || 'Неполезно',
        'data-testid': 'msg.ai.rate.not_useful',
      },
      '👎',
    );
    up.addEventListener('click', () => rate(true));
    down.addEventListener('click', () => rate(false));
    meta.append(up, down);
    row.appendChild(meta);
    row.dataset.id = String(reply.id);
  }

  // Открыть источник ответа в правой панели: документ целиком, нужная глава раскрыта и подсвечена, остальные свёрнуты.
  // «Знания модели» и статья показывают пояснение. Кликабельны все источники.
  function openSource(s) {
    if (!sourcesUI) return;
    state.panel = { source: s, drug: null, clinrec: null, reader: null };
    showPanel();
    panelAsk.hidden = true;
    panel.querySelector('[data-drug-panel-title]').textContent = s.label || '';
    sourcesUI.openInPanel(panelBody, s, {
      setTitle: (title) => {
        if (state.panel && state.panel.source === s) panel.querySelector('[data-drug-panel-title]').textContent = title || '';
      },
    });
  }

  const canOpenSource = () => Boolean(sourcesUI);

  // Источники ответа: карточки под сообщением (номер, вид, название, место, цитата); клик открывает источник справа.
  function addSources(row, sources) {
    if (!Array.isArray(sources) || !sources.length) return;
    if (sourcesUI) sourcesUI.renderCards(row, sources, openSource);
  }

  // Текст ответа ИИ: форматированный (заголовки, списки, таблицы, жирный), метки [n] — кнопки, открывающие источник.
  function renderAnswer(box, text, sources) {
    box.textContent = '';
    box.classList.add('md');
    if (!docs || !window.CCDrugDocs) {
      box.textContent = text;
      return;
    }
    const byN = new Map(
      (Array.isArray(sources) ? sources : []).filter((s) => s.n !== undefined && s.n !== null).map((s) => [Number(s.n), s]),
    );
    const cite = (n) => {
      const src = byN.get(n);
      if (!src) return null;
      const open = canOpenSource(src);
      const model = n === 0; // [0] — «Знания модели»: отдельный источник, не из базы
      const b = el(open ? 'button' : 'span', { class: 'cite' + (model ? ' cite_model' : '') + (open ? '' : ' cite_plain'), title: src.label || '' }, model ? sourceText.model_cite || '0' : String(n));
      if (open) {
        b.type = 'button';
        b.setAttribute('data-testid', 'msg.wchat.source.cite');
        b.setAttribute('aria-label', `Источник ${n}${src.label ? ': ' + src.label : ''}`);
        b.addEventListener('click', () => openSource(src));
      }
      return b;
    };
    box.appendChild(window.CCDrugDocs.renderMarkdown(text, { cite }));
  }

  // Ход ответа: пока агент работает, под вопросом растёт список этапов («Смотрю инструкции к лекарствам» и т. п.).
  function trackProgress(bubble, progressId) {
    bubble.textContent = '';
    bubble.classList.add('is-working');
    const list = el('ol', { class: 'progress', 'aria-live': 'polite' });
    bubble.appendChild(list);
    let shown = 0;
    let stopped = false;
    const paint = (stages) => {
      if (stages.length === shown) return;
      shown = stages.length;
      list.textContent = '';
      stages.forEach((label, i) => {
        const last = i === stages.length - 1;
        list.appendChild(el('li', { class: last ? 'progress__now' : 'progress__done' }, last ? `${label}…` : label));
      });
      bubble.scrollIntoView({ block: 'end' });
    };
    const tick = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`/work/api/chat-progress/${encodeURIComponent(progressId)}`, {
          headers: { Accept: 'application/json' },
        });
        if (res.ok && !stopped) {
          const info = await res.json();
          paint(info.stages || []);
          // Тред известен ещё до ответа: адрес страницы уже ведёт в него, и после обновления ответ не потеряется.
          if (info.thread_id && !state.drug && !state.clinrec) {
            chat.threadId = String(info.thread_id);
            chat.fresh = false;
            history.replaceState(null, '', `/work?tab=chat&thread=${info.thread_id}`);
          }
        }
      } catch (_) {
        /* следующий опрос */
      }
      if (!stopped) setTimeout(tick, 700);
    };
    paint(['Отправляю вопрос']);
    shown = 1;
    tick();
    return () => {
      stopped = true;
      bubble.classList.remove('is-working');
    };
  }

  // Сколько после вопроса ждём ответ в открытом треде (дольше шлюз не работает: таймауты вызовов короче).
  const AWAIT_REPLY_MS = 4 * 60 * 1000;
  async function awaitReply(threadId, afterId) {
    const pending = addBubble('assistant', '');
    const bubble = pending.querySelector('.bubble');
    bubble.classList.add('is-working');
    const list = el('ol', { class: 'progress', 'aria-live': 'polite' });
    list.appendChild(el('li', { class: 'progress__now' }, 'Ответ готовится…'));
    bubble.appendChild(list);
    const started = Date.now();
    while (Date.now() - started < AWAIT_REPLY_MS) {
      await new Promise((r) => setTimeout(r, 3000));
      if (!bubble.isConnected) return; // ушли в другой чат
      const res = await getJson(`/api/v1/ai/threads/${encodeURIComponent(threadId)}`);
      if (!res.ok) continue;
      const reply = (res.data.messages || []).find((m) => m.id > afterId && m.role === 'assistant');
      if (!reply) continue;
      bubble.classList.remove('is-working');
      renderAnswer(bubble, reply.text, reply.sources);
      addSources(pending, reply.sources);
      addReplyActions(pending, reply);
      return;
    }
    bubble.classList.remove('is-working');
    bubble.textContent = 'Ответа нет. Отправьте вопрос ещё раз.';
  }

  let busy = false;
  async function submit() {
    const text = field.value.trim();
    if (!text || busy) return;
    busy = true;
    send.disabled = true;
    if (hello) hello.hidden = true;
    addBubble('user', text);
    field.value = '';
    const pending = addBubble('assistant', '');
    const progressId = crypto.randomUUID();
    const stopProgress = trackProgress(pending.querySelector('.bubble'), progressId);
    const body = {
      progress_id: progressId,
      text,
      chips: [state.patient ? { type: 'patient', id: state.patient.id } : null, ...state.chips].filter(Boolean),
    };
    if (state.patient) body.patient_id = state.patient.id;
    if (chat.fresh) body.new_thread = true;
    else if (chat.threadId) body.thread_id = Number(chat.threadId);
    const patientAtSend = state.patient ? state.patient.id : null;
    const subjectAtSend = !state.drug && !state.clinrec;
    try {
      if (state.drug && !state.drug.thread) await ensureDrugThread();
      const res = state.clinrec
        ? await postJson(`/work/api/clinrecs/${encodeURIComponent(state.clinrec.doc.id)}/messages`, {
            text,
            ...(state.clinrec.thread ? { thread_id: state.clinrec.thread.id } : {}),
          })
        : state.drug
          ? await postJson(`/work/api/drugs/threads/${state.drug.thread.id}/messages`, { text })
          : await postJson('/api/v1/ai/clinician/messages', body);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.reply) {
        stopProgress();
        renderAnswer(pending.querySelector('.bubble'), data.reply.text, data.reply.sources || data.sources);
        addReplyActions(pending, data.reply);
        if (data.thread && data.thread.id && patientAtSend) ae.threadId = data.thread.id;
        if (!state.clinrec && !state.drug && data.thread && data.thread.id) {
          chat.threadId = String(data.thread.id);
          chat.fresh = false;
          history.replaceState(null, '', `/work?tab=chat&thread=${data.thread.id}`);
        }
        if (data.ae_offer && patientAtSend && subjectAtSend)
          renderAeOffer(pending, {
            prefill: data.ae_offer.prefill || {},
            patientId: patientAtSend,
            threadId: data.thread && data.thread.id,
            text,
          });
        addSources(pending, data.reply.sources || data.sources);
        if (state.clinrec && data.thread) {
          state.clinrec.thread = { id: data.thread.id };
          history.replaceState(null, '', `/work?tab=chat&thread=${data.thread.id}`);
        }
        if (state.drug && state.drug.thread)
          history.replaceState(null, '', `/work?tab=chat&thread=${state.drug.thread.id}`);
      } else {
        stopProgress();
        field.value = text;
        pending.querySelector('.bubble').textContent =
          res.status === 429
            ? 'Слишком часто. Подождите минуту.'
            : 'Не удалось получить ответ. Текст остался в поле — отправьте ещё раз.';
      }
    } catch (_) {
      stopProgress();
      field.value = text;
      pending.querySelector('.bubble').textContent = 'Нет связи с сервером. Текст остался в поле.';
    }
    busy = false;
    send.disabled = false;
    field.focus();
    sideHistory();
  }

  // ---- выбор предмета разговора: пациент или лекарство (поиск слева сверху) ----

  const cap = (v) => (v ? v.charAt(0).toUpperCase() + v.slice(1) : v);
  const getJson = async (path) => {
    const res = await fetch(path, { headers: { Accept: 'application/json' } });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  };

  const suggLabel = root.querySelector('.chat-sugg__label');
  function setPlaceholder() {
    const subjectOn = Boolean(state.drug || state.clinrec);
    if (suggLabel) suggLabel.textContent = subjectOn ? root.dataset.tAskLabel : root.dataset.tSuggLabel;
    if (suggBox) suggBox.classList.toggle('is-drug', subjectOn);
    field.placeholder = state.clinrec
      ? clinText.placeholder
      : state.drug
        ? root.dataset.tDrugPlaceholder
        : root.dataset.tChatPlaceholder;
  }

  function resetFeed() {
    feed.textContent = '';
    if (hello) hello.hidden = Boolean(state.patient || state.drug || state.clinrec);
  }

  function clearSubject() {
    state.patient = null;
    state.drug = null;
    state.clinrec = null;
    state.chips = [];
    state.suggestions = [];
    setPlaceholder();
    renderChips();
    renderSuggestions();
    if (hello) hello.hidden = false;
  }

  function restoreMessages(messages) {
    for (const m of messages || []) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      if (m.kind === 'ae_summary') {
        renderAeSummary(m.text, { id: m.id });
        if (state.patient) ae.handled.add(String(state.patient.id));
        continue;
      }
      const row = el('article', { class: `chat-msg chat-msg_${m.role}` });
      const body = el('div', { class: 'chat-msg__text' }, m.text);
      row.appendChild(body);
      if (m.role === 'assistant') {
        renderAnswer(body, m.text, m.sources);
        addSources(row, m.sources);
      }
      feed.appendChild(row);
    }
  }

  // ---- нежелательное явление: предложение под ответом ИИ, карточка-опрос и сводка в ленте ----

  // Сводка записи — спокойное системное сообщение; из истории треда kind 'ae_summary' рисуется так же.
  function renderAeSummary(text, { id, data } = {}) {
    if (hello) hello.hidden = true;
    const row = el('article', { class: 'chat-msg chat-msg_system ae-summary', 'data-kind': 'ae_summary' });
    if (id) row.dataset.id = String(id);
    row.appendChild(el('p', { class: 'chat-msg__text' }, text));
    if (data && data.notice_available && window.AeClinician) {
      window.AeWizard.texts().then((T) => {
        const link = window.AeClinician.noticeLink(T, data);
        if (link) row.appendChild(link);
      });
    }
    feed.appendChild(row);
    row.scrollIntoView({ block: 'nearest' });
    return row;
  }

  // «Похоже на возможную побочную реакцию у пациента. Оформить?» — «Оформить» открывает опрос нужного режима здесь же.
  async function renderAeOffer(after, { prefill, patientId, threadId, text } = {}) {
    const key = String(patientId || '');
    if (!after || !key || !window.AeWizard || !window.AeClinician) return null;
    if (ae.handled.has(key) || ae.open === key || feed.querySelector('[data-ae-offer]')) return null;
    const T = await window.AeWizard.texts();
    const card = el('div', { class: 'ae-offer-card', 'data-ae-offer': '', role: 'group' });
    const msg = el('p', { class: 'ae-offer-card__text', 'data-testid': 'msg.ae.clinician.offer' }, T['msg.ae.clinician.offer'] || '');
    const yes = el('button', { type: 'button', class: 'btn sm primary', 'data-testid': 'msg.ae.clinician.offer.yes' }, T['msg.ae.clinician.offer.yes'] || 'Оформить');
    const no = el('button', { type: 'button', class: 'btn sm', 'data-testid': 'msg.ae.clinician.offer.no' }, T['msg.ae.clinician.offer.no'] || 'Не сейчас');
    const x = el('button', { type: 'button', class: 'ae-offer-card__x', 'aria-label': T['msg.ae.wizard.close'] || 'Закрыть', 'data-testid': 'msg.ae.wizard.close' }, '×');
    const dismiss = () => {
      ae.handled.add(key);
      card.remove();
    };
    no.addEventListener('click', dismiss);
    x.addEventListener('click', dismiss);
    yes.addEventListener('click', async () => {
      ae.open = key;
      const host = el('article', { class: 'chat-msg chat-msg_system ae-host', 'data-ae-host': '' });
      card.replaceWith(host);
      const finish = () => {
        ae.open = null;
        ae.handled.add(key);
      };
      try {
        await window.AeClinician.open(host, {
          patientId,
          mode: root.dataset.aeMode,
          prefill: { ...(prefill || {}), text: (prefill && (prefill.text || prefill.description)) || text || '' },
          source: 'ai_chat',
          threadId,
          onDone: (data, texts) => {
            finish();
            const mode = root.dataset.aeMode;
            if (data.summary && data.summary.text) {
              host.remove();
              renderAeSummary(data.summary.text, { id: data.summary.id, data });
            } else {
              host.replaceChildren(window.AeClinician.confirmation(texts, mode, data, () => host.remove()));
            }
          },
          onClose: ({ reason }) => {
            if (reason === 'closed') {
              finish();
              host.remove();
            }
          },
        });
        host.scrollIntoView({ block: 'nearest' });
      } catch (_) {
        ae.open = null;
        host.remove();
      }
    });
    const row = el('div', { class: 'ae-offer-card__row' });
    row.append(yes, no);
    card.append(msg, row, x);
    after.after(card);
    card.scrollIntoView({ block: 'nearest' });
    return card;
  }

  window.WorkChat = { renderAeOffer, renderAeSummary };

  function showDrugCard(drug) {
    const subject = panelBody;
    subject.textContent = '';
    subject.appendChild(el('h2', {}, cap(drug.name)));
    const bits = [drug.group_label];
    if (drug.atc) bits.push(`${drugText.atc} ${drug.atc}`);
    if (drug.rx_only !== null) bits.push(drug.rx_only ? drugText.rx : drugText.otc);
    subject.appendChild(el('p', { class: 'sub' }, bits.join(' · ')));
    subject.appendChild(el('h4', { class: 'sec-label' }, drugText.trade));
    if (drug.products.length) {
      const ul = el('ul', { class: 'drug-trade' });
      for (const pr of drug.products) {
        const detail = [pr.form, pr.strengths.join(', ')].filter(Boolean).join(' · ');
        ul.appendChild(el('li', {}, detail ? `${pr.name} — ${detail}` : pr.name));
      }
      subject.appendChild(ul);
    } else {
      subject.appendChild(el('p', { class: 'small muted' }, drugText.no_trade));
    }
    if (docs) {
      const host = el('div', { class: 'drug-instr', 'data-testid': 'msg.drugs.instr.title' });
      subject.appendChild(host);
      docs.mountCard(host, drug.id);
    }
    subject.appendChild(el('h4', { class: 'sec-label' }, drugText.articles));
    if (!drug.articles.specific.length) subject.appendChild(el('p', { class: 'small muted' }, drugText.no_articles));
    for (const a of drug.articles.specific) {
      const det = el('details', { class: 'drug-article' });
      det.appendChild(el('summary', {}, a.title));
      if (a.summary) det.appendChild(el('p', { class: 'sub' }, a.summary));
      const body = el('div', { class: 'article-text' });
      if (window.CCMarkdown) body.appendChild(window.CCMarkdown.render(a.body_md));
      else body.textContent = a.body_md;
      det.appendChild(body);
      const marks = [a.stand_in ? drugText.stand_in : '', a.ai_assisted ? drugText.ai_assisted : ''].filter(Boolean);
      if (marks.length) det.appendChild(el('p', { class: 'small muted' }, marks.join(' · ')));
      subject.appendChild(det);
    }
  }

  function drugQuestions() {
    state.suggestions = [];
    suggRow.innerHTML = '';
    for (const k of ['q1', 'q2', 'q3', 'q4']) {
      const btn = el('button', { type: 'button', 'data-testid': 'msg.composer.suggestion' }, drugText[k]);
      btn.addEventListener('click', () => {
        field.value = drugText[k];
        field.focus();
      });
      suggRow.appendChild(btn);
    }
  }

  async function selectPatient(p) {
    chat.threadId = null;
    chat.fresh = false;
    state.drug = null;
    state.clinrec = null;
    state.patient = { id: p.id, name: p.name };
    state.chips = [];
    setPlaceholder();
    resetFeed();
    renderChips();
    state.suggestions = [];
    renderSuggestions();
    // Прежний разговор с этим пациентом (последний тред специалиста по нему) показываем сразу.
    const list = await getJson('/api/v1/ai/threads?purpose=clinician_chat');
    const last = (list.data.items || []).find((x) => x.patient_id === p.id);
    if (last && state.patient && state.patient.id === p.id) {
      const msgs = await getJson(`/api/v1/ai/threads/${encodeURIComponent(last.id)}`);
      if (msgs.ok && state.patient && state.patient.id === p.id) restoreMessages(msgs.data.messages);
    }
  }

  // ---- правая панель: карточка препарата и источники ответов ----

  // Третий блок справа один: пока ничего не открыто, в нём сигналы (если они есть), иначе — открытое содержимое.
  function syncPanel() {
    const open = Boolean(state.panel);
    panelView.hidden = !open;
    panel.classList.toggle('is-content', open);
    panel.hidden = !open && (!rail || rail.hidden);
    if (resizer) resizer.hidden = panel.hidden;
    root.classList.toggle('has-drug-panel', !panel.hidden);
  }

  function setAsk(label) {
    panelAsk.title = label || '';
    panelAsk.setAttribute('aria-label', label || '');
  }

  function showPanel() {
    syncPanel();
  }

  function closePanel() {
    state.panel = null;
    panelBody.textContent = '';
    syncPanel();
  }

  function openPanel(drug) {
    state.panel = { drug, clinrec: null, reader: null };
    showPanel();
    panel.querySelector('[data-drug-panel-title]').textContent = cap(drug.name);
    setAsk(drugText.ask);
    panelAsk.hidden = Boolean(state.drug && state.drug.drug.id === drug.id);
    panelBody.scrollTop = 0;
    showDrugCard(drug);
  }

  // Карточка клинической рекомендации: название, версия, оглавление; вопрос ИИ подставляет название в поле ввода.
  async function selectClinrec(id) {
    const res = await getJson(`/work/api/clinrecs/${encodeURIComponent(id)}`);
    if (!res.ok) {
      addBubble('assistant', clinText.open_failed);
      return;
    }
    const doc = res.data;
    state.panel = { clinrec: doc, drug: null, reader: null };
    showPanel();
    panel.querySelector('[data-drug-panel-title]').textContent = doc.title;
    setAsk(clinText.ask);
    panelAsk.hidden = Boolean(state.clinrec && state.clinrec.doc.id === doc.id);
    panelBody.scrollTop = 0;
    panelBody.textContent = '';
    panelBody.appendChild(el('h2', {}, doc.title));
    if (doc.version) panelBody.appendChild(el('p', { class: 'sub' }, `${clinText.version}: ${doc.version}`));
    if (doc.pdf) {
      const pdf = el(
        'a',
        {
          class: 'btn',
          href: `/work/api/clinrecs/${encodeURIComponent(doc.id)}/pdf`,
          target: '_blank',
          rel: 'noopener',
          'data-testid': 'msg.wchat.clinrec.pdf',
        },
        clinText.pdf,
      );
      panelBody.appendChild(el('p', {}, '')).appendChild(pdf);
    }
    panelBody.appendChild(el('h4', { class: 'sec-label' }, clinText.sections));
    // Разделы второго уровня раскрываются по клику; текст раздела (с подразделами) подгружается постранично.
    for (const sec of doc.sections.filter((x) => x.level === 2)) {
      const det = el('details', { class: 'drug-article clinrec-section', 'data-section': sec.id });
      det.appendChild(el('summary', {}, sec.title));
      const body = el('div', { class: 'article-text' });
      det.appendChild(body);
      let loaded = false;
      const load = async (cursor) => {
        const q = cursor ? `?cursor=${cursor}` : '';
        const r = await getJson(`/work/api/clinrecs/${encodeURIComponent(doc.id)}/sections/${encodeURIComponent(sec.id)}${q}`);
        body.querySelectorAll('[data-more],[data-loading]').forEach((n) => n.remove());
        if (!r.ok) {
          body.appendChild(el('p', { class: 'small muted' }, clinText.section_failed));
          loaded = false;
          return;
        }
        const chunk = el('div', { class: 'cr-text' });
        if (window.CCClinrecMd) chunk.appendChild(window.CCClinrecMd.render(r.data.text, { imageNote: clinText.figure }));
        else chunk.textContent = r.data.text;
        body.appendChild(chunk);
        if (r.data.hasMore) {
          const more = el('button', { type: 'button', class: 'btn', 'data-more': '' }, clinText.more);
          more.addEventListener('click', () => {
            more.disabled = true;
            load(r.data.nextCursor);
          });
          body.appendChild(more);
        }
      };
      det.addEventListener('toggle', () => {
        if (!det.open || loaded) return;
        loaded = true;
        body.appendChild(el('p', { class: 'small muted', 'data-loading': '' }, clinText.loading));
        load(0);
      });
      panelBody.appendChild(det);
    }
  }

  // Карточку открывает любой выбор препарата; чат при этом не создаётся и к нему ничего не прикрепляется.
  async function selectDrug(innId) {
    const res = await getJson(`/work/api/drugs/${innId}`);
    if (!res.ok) {
      addBubble('assistant', drugText.open_failed);
      return;
    }
    openPanel(res.data);
  }

  // Прикрепить препарат к чату: чип над полем ввода, вопросы идут только по нему. Тред создаётся при первом вопросе.
  function attachDrug(drug, thread, messages) {
    const same = state.drug && state.drug.drug.id === drug.id && !thread;
    if (same) {
      field.focus();
      return;
    }
    state.patient = null;
    state.chips = [];
    state.clinrec = null;
    state.drug = { drug, thread: thread || null };
    setPlaceholder();
    resetFeed();
    renderChips();
    restoreMessages(messages);
    drugQuestions();
    if (state.panel && state.panel.drug && state.panel.drug.id === drug.id) panelAsk.hidden = true;
    if (thread) history.replaceState(null, '', `/work?tab=chat&thread=${thread.id}`);
    field.focus();
  }

  function detachDrug() {
    state.drug = null;
    state.suggestions = [];
    suggRow.innerHTML = '';
    setPlaceholder();
    resetFeed();
    renderChips();
    if (state.panel && state.panel.drug) panelAsk.hidden = false;
    history.replaceState(null, '', '/work?tab=chat');
  }

  // Прикрепить клиническую рекомендацию: чип над полем, вопросы идут по ней; выдержки ищет сервер только в этом документе.
  function attachClinrec(doc) {
    if (state.clinrec && state.clinrec.doc.id === doc.id) {
      field.focus();
      return;
    }
    state.patient = null;
    state.drug = null;
    state.chips = [];
    state.clinrec = { doc, thread: null };
    setPlaceholder();
    resetFeed();
    renderChips();
    clinrecQuestions();
    if (state.panel && state.panel.clinrec && state.panel.clinrec.id === doc.id) panelAsk.hidden = true;
    field.focus();
  }

  function detachClinrec() {
    state.clinrec = null;
    state.suggestions = [];
    suggRow.innerHTML = '';
    setPlaceholder();
    resetFeed();
    renderChips();
    if (state.panel && state.panel.clinrec) panelAsk.hidden = false;
    history.replaceState(null, '', '/work?tab=chat');
  }

  function clinrecQuestions() {
    state.suggestions = [];
    suggRow.innerHTML = '';
    for (const k of ['q1', 'q2', 'q3']) {
      const btn = el('button', { type: 'button', 'data-testid': 'msg.composer.suggestion' }, clinText[k]);
      btn.addEventListener('click', () => {
        field.value = clinText[k];
        field.focus();
      });
      suggRow.appendChild(btn);
    }
  }

  async function ensureDrugThread() {
    const res = await postJson(`/work/api/drugs/${state.drug.drug.id}/open`, {});
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.thread) throw new Error('open');
    state.drug.thread = data.thread;
  }

  async function openDrugThread(th) {
    const [drug, msgs] = await Promise.all([
      getJson(`/work/api/drugs/${th.drug_inn_id}`),
      getJson(`/api/v1/ai/threads/${encodeURIComponent(th.id)}`),
    ]);
    if (!drug.ok || !msgs.ok) return;
    attachDrug(drug.data, { id: th.id }, msgs.data.messages);
    openPanel(drug.data);
    sideHistory();
  }

  if (panel) {
    panelAsk.addEventListener('click', () => {
      if (state.panel && state.panel.clinrec) attachClinrec(state.panel.clinrec);
      else if (state.panel && state.panel.drug) attachDrug(state.panel.drug);
    });
    panelClose.addEventListener('click', closePanel);
    root.addEventListener('alertrail:change', syncPanel);
    syncPanel();
  }

  let pickTimer = null;
  let pickSeq = 0;
  let pickActive = -1;
  const PICK_MIN = 2;

  function closePick(clear) {
    pickSeq++;
    if (clear) pickField.value = '';
    pickBox.hidden = true;
    pickBox.textContent = '';
    pickActive = -1;
    pickField.setAttribute('aria-expanded', 'false');
    pickField.removeAttribute('aria-activedescendant');
  }

  function pickRows() {
    return Array.from(pickBox.querySelectorAll('a.th'));
  }

  function setActive(i) {
    const rows = pickRows();
    rows.forEach((r) => r.classList.remove('is-active'));
    pickActive = rows.length ? (i + rows.length) % rows.length : -1;
    if (pickActive >= 0) {
      rows[pickActive].classList.add('is-active');
      rows[pickActive].scrollIntoView({ block: 'nearest' });
      pickField.setAttribute('aria-activedescendant', rows[pickActive].id);
    }
  }

  // Подсказки появляются только по мере ввода (от PICK_MIN символов): клинреки и лекарства, без пациентов.
  async function renderPick() {
    const seq = ++pickSeq;
    const query = pickField.value.trim().toLowerCase();
    if (query.length < PICK_MIN) {
      closePick(false);
      return;
    }
    const params = new URLSearchParams({ q: query });
    const [found, recs] = await Promise.all([
      getJson(`/work/api/drugs?${params}`),
      getJson(`/work/api/clinrecs?${params}`),
    ]);
    if (seq !== pickSeq) return;
    const drugs = ((found.data && found.data.items) || []).slice(0, 8);
    const clinrecs = ((recs.data && recs.data.items) || []).slice(0, 5);
    pickBox.textContent = '';
    let n = 0;
    const row = (cls, type, id, title, sub, kind, open) => {
      const a = el('a', { href: '#', class: cls, role: 'option', id: `pick-opt-${n++}`, 'data-type': type, 'data-id': String(id) });
      a.appendChild(el('span', {}, title));
      if (sub) a.appendChild(el('small', {}, sub));
      a.appendChild(el('span', { class: 'kind' }, kind));
      a.addEventListener('mousedown', (e) => e.preventDefault());
      a.addEventListener('click', (e) => {
        e.preventDefault();
        closePick(true);
        pickField.blur();
        open();
      });
      return a;
    };
    const section = (title, rows) => {
      if (!rows.length) return;
      pickBox.appendChild(el('h4', {}, title));
      for (const r of rows) pickBox.appendChild(r);
    };
    section(
      root.dataset.tPickClinrecs,
      clinrecs.map((c) => row('th pick-clinrec', 'clinrec', c.id, c.title, '', root.dataset.tKindClinrec, () => selectClinrec(c.id))),
    );
    section(
      root.dataset.tPickDrugs,
      drugs.map((d) =>
        row(
          'th pick-drug',
          'drug',
          d.id,
          cap(d.name),
          [d.group_label, d.trade_names.slice(0, 2).join(', ')].filter(Boolean).join(' · '),
          root.dataset.tKindDrug,
          () => selectDrug(d.id),
        ),
      ),
    );
    if (!pickBox.children.length) pickBox.appendChild(el('p', { class: 'small muted' }, root.dataset.tPickNone));
    pickBox.hidden = false;
    pickField.setAttribute('aria-expanded', 'true');
    pickActive = -1;
  }

  if (pickField) {
    pickField.addEventListener('input', () => {
      clearTimeout(pickTimer);
      pickTimer = setTimeout(renderPick, 150);
    });
    pickField.addEventListener('keydown', (e) => {
      if (pickBox.hidden) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive(pickActive + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(pickActive - 1);
      } else if (e.key === 'Enter') {
        const rows = pickRows();
        const target = rows[pickActive >= 0 ? pickActive : 0];
        if (target) {
          e.preventDefault();
          target.click();
        }
      } else if (e.key === 'Escape') {
        closePick(false);
      }
    });
    pickField.addEventListener('blur', () =>
      setTimeout(() => {
        if (document.activeElement !== pickField) closePick(false);
      }, 150),
    );
  }

  // Ширина правой панели: тянется за левую границу, ←/→ на разделителе; значение помним между визитами.
  if (resizer && panel) {
    const MIN = 320;
    const KEY = 'cc.chat.panelWidth';
    const maxWidth = () => Math.max(MIN, Math.min(720, Math.round(root.clientWidth * 0.6)));
    const apply = (px) => {
      const w = Math.min(maxWidth(), Math.max(MIN, Math.round(px)));
      root.style.setProperty('--chat-panel-width', `${w}px`);
      resizer.setAttribute('aria-valuenow', String(w));
      return w;
    };
    resizer.setAttribute('aria-valuemin', String(MIN));
    try {
      const saved = Number(localStorage.getItem(KEY));
      if (saved) apply(saved);
    } catch (_) {
      /* без хранилища остаётся ширина по умолчанию */
    }
    const save = (w) => {
      try {
        localStorage.setItem(KEY, String(w));
      } catch (_) {
        /* не критично */
      }
    };
    resizer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      resizer.setPointerCapture(e.pointerId);
      resizer.classList.add('on');
      root.classList.add('is-resizing');
    });
    resizer.addEventListener('pointermove', (e) => {
      if (!resizer.hasPointerCapture(e.pointerId)) return;
      apply(panel.getBoundingClientRect().right - e.clientX);
    });
    const stop = (e) => {
      if (resizer.hasPointerCapture(e.pointerId)) resizer.releasePointerCapture(e.pointerId);
      resizer.classList.remove('on');
      root.classList.remove('is-resizing');
      save(Math.round(panel.getBoundingClientRect().width));
    };
    resizer.addEventListener('pointerup', stop);
    resizer.addEventListener('pointercancel', stop);
    resizer.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const cur = panel.getBoundingClientRect().width;
      save(apply(cur + (e.key === 'ArrowLeft' ? 40 : -40)));
    });
  }

  // История чатов слева: GET /api/v1/ai/threads, группы «Сегодня / Ранее»; ?thread=ID открывает чат.
  // Чаты по лекарствам — обычные треды (purpose = drug_chat) и открываются здесь же, в общем пространстве.
  // restore — только при загрузке страницы: открыть тред из ?thread=; при обновлении после ответа ленту не трогаем.
  async function sideHistory({ restore = false } = {}) {
    const box = root.querySelector('[data-threads]');
    if (!box) return;
    let items = [];
    const drugIds = new Map();
    try {
      const res = await fetch('/api/v1/ai/threads', { headers: { Accept: 'application/json' } });
      if (res.ok)
        items = ((await res.json()).items || []).filter(
          (x) => x.purpose === 'clinician_chat' || x.purpose === 'drug_chat',
        );
      if (items.some((x) => x.purpose === 'drug_chat')) {
        const dr = await getJson('/work/api/drugs/threads');
        for (const x of dr.data.items || []) drugIds.set(x.id, x.drug_inn_id);
      }
    } catch (_) {
      items = [];
    }
    if (!items.length) return;
    const today = new Date().toISOString().slice(0, 10);
    const open =
      state.drug && state.drug.thread
        ? String(state.drug.thread.id)
        : new URLSearchParams(window.location.search).get('thread');
    const groups = [
      ['Сегодня', items.filter((x) => String(x.updated_at).slice(0, 10) === today)],
      ['Ранее', items.filter((x) => String(x.updated_at).slice(0, 10) !== today)],
    ];
    box.textContent = '';
    for (const [title, rows] of groups) {
      if (!rows.length) continue;
      box.appendChild(el('h4', {}, title));
      for (const th of rows) {
        const link = el(
          'a',
          { class: `th${String(th.id) === open ? ' on' : ''}`, href: `/work?tab=chat&thread=${th.id}` },
          th.title || 'Чат',
        );
        if (th.purpose === 'drug_chat' && drugIds.get(th.id)) {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            openDrugThread({ id: th.id, drug_inn_id: drugIds.get(th.id) });
          });
        }
        const row = el('div', { class: 'th-row' });
        const del = el('button', { class: 'th-del', type: 'button' }, '×');
        const delText = root.dataset.tHistoryDelete || '';
        del.setAttribute('aria-label', delText);
        del.title = delText;
        del.addEventListener('click', async () => {
          del.disabled = true;
          const token = (await (await fetch('/api/v1/csrf')).json()).token;
          const res = await fetch(`/api/v1/ai/threads/${encodeURIComponent(th.id)}`, {
            method: 'DELETE',
            headers: { 'x-csrf-token': token, 'idempotency-key': crypto.randomUUID() },
          });
          if (!res.ok) {
            del.disabled = false;
            return;
          }
          // Открытый чат удалён — открывается новый пустой.
          if (String(th.id) === String(open) || String(th.id) === String(chat.threadId))
            window.location.assign('/work?tab=chat');
          else sideHistory();
        });
        row.append(link, del);
        box.appendChild(row);
      }
    }
    if (restore && open && !state.drug) {
      const th = items.find((x) => String(x.id) === String(open));
      if (th && th.purpose === 'drug_chat' && drugIds.get(th.id)) {
        openDrugThread({ id: th.id, drug_inn_id: drugIds.get(th.id) });
        return;
      }
      try {
        const res = await fetch(`/api/v1/ai/threads/${encodeURIComponent(open)}`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (hello) hello.hidden = true;
        for (const m of data.messages || []) {
          if (m.kind === 'ae_summary') {
            renderAeSummary(m.text, { id: m.id });
            if (data.thread && data.thread.patient_id) ae.handled.add(String(data.thread.patient_id));
            continue;
          }
          const row = el('article', { class: `chat-msg chat-msg_${m.author}` });
          const body = el('div', { class: 'chat-msg__text' }, m.text);
          row.appendChild(body);
          if (m.author === 'assistant' || m.author === 'ai') {
            renderAnswer(body, m.text, m.sources);
            addSources(row, m.sources);
          }
          feed.appendChild(row);
        }
        // Страницу обновили, пока шёл ответ: вопрос уже в треде, а ответ ещё не записан — ждём его здесь.
        const last = (data.messages || []).at(-1);
        if (last && last.role === 'user' && Date.now() - Date.parse(last.created_at) < AWAIT_REPLY_MS)
          awaitReply(open, last.id);
      } catch (_) {
        /* чат недоступен — пустое поле */
      }
    }
  }
  sideHistory({ restore: true });

  // «Новый чат» без перезагрузки страницы: перезагрузка обрывала идущий запрос, а сервер дописывал ответ в старый тред.
  const newLink = root.querySelector('[data-testid="msg.chat.history.new"]');
  if (newLink)
    newLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (busy) return;
      clearSubject();
      resetFeed();
      chat.threadId = null;
      chat.fresh = true;
      ae.threadId = null;
      history.replaceState(null, '', '/work?tab=chat');
      root.querySelectorAll('[data-threads] .th.on').forEach((a) => a.classList.remove('on'));
      field.focus();
    });

  // Переход из карточки пациента: /work?tab=chat&p=ID — пациент уже выбран.
  const presetId = new URLSearchParams(window.location.search).get('p');
  const preset = presetId && state.patients.find((p) => String(p.id) === presetId);
  if (preset) selectPatient(preset);

  send.addEventListener('click', submit);
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
})();
