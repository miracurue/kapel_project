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

  const state = { patients: [], patient: null, chips: [], suggestions: [], drug: null };
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
  const noChips = root.querySelector('[data-no-chips]');
  const subject = root.querySelector('[data-subject]');
  const pickField = root.querySelector('[data-pick-search]');
  const pickBox = root.querySelector('[data-pick-results]');
  let drugText = {};
  try {
    drugText = JSON.parse(decodeURIComponent(root.dataset.drugStrings || '{}'));
  } catch (_) {
    drugText = {};
  }

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
    if (noChips) noChips.hidden = !(state.patient && !state.chips.length);
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
    const toDoc = el(
      'button',
      { type: 'button', class: 'btn', 'data-testid': 'msg.wchat.to_doc' },
      root.dataset.tToDoc || 'В черновик документа',
    );
    toDoc.addEventListener('click', () => {
      try {
        sessionStorage.setItem('cc.doc_prefill', JSON.stringify({ text: String(reply.text || '').slice(0, 2000) }));
      } catch (_) {
        /* без предзаполнения */
      }
      window.location.assign('/work?tab=docs');
    });
    meta.appendChild(toDoc);
    if (state.patient) {
      meta.appendChild(
        el(
          'a',
          { class: 'btn', href: `/work/patients/${state.patient.id}`, 'data-testid': 'msg.wchat.open_card' },
          root.dataset.tOpenCard || 'Открыть карточку',
        ),
      );
    }
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

  let busy = false;
  async function submit() {
    const text = field.value.trim();
    if (!text || busy) return;
    busy = true;
    send.disabled = true;
    if (hello) hello.hidden = true;
    addBubble('user', text);
    const pending = addBubble('assistant', '…');
    const body = {
      text,
      chips: [state.patient ? { type: 'patient', id: state.patient.id } : null, ...state.chips].filter(Boolean),
    };
    if (state.patient) body.patient_id = state.patient.id;
    try {
      const res = state.drug
        ? await postJson(`/work/api/drugs/threads/${state.drug.thread.id}/messages`, { text })
        : await postJson('/api/v1/ai/clinician/messages', body);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.reply) {
        field.value = '';
        pending.querySelector('.bubble').textContent = data.reply.text;
        addReplyActions(pending, data.reply);
      } else {
        pending.querySelector('.bubble').textContent =
          res.status === 429
            ? 'Слишком часто. Подождите минуту.'
            : 'Не удалось получить ответ. Текст остался в поле — отправьте ещё раз.';
      }
    } catch (_) {
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
    if (suggLabel) suggLabel.hidden = Boolean(state.drug);
    field.placeholder = state.drug ? root.dataset.tDrugPlaceholder : root.dataset.tChatPlaceholder;
  }

  function resetFeed() {
    feed.textContent = '';
    if (hello) hello.hidden = Boolean(state.patient || state.drug);
  }

  function clearSubject() {
    state.patient = null;
    state.drug = null;
    state.chips = [];
    state.suggestions = [];
    subject.hidden = true;
    subject.textContent = '';
    setPlaceholder();
    renderChips();
    renderSuggestions();
    if (hello) hello.hidden = false;
  }

  function restoreMessages(messages) {
    for (const m of messages || []) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const row = el('article', { class: `chat-msg chat-msg_${m.role}` });
      row.appendChild(el('p', { class: 'chat-msg__text' }, m.text));
      feed.appendChild(row);
    }
  }

  function showPatientCard(p) {
    subject.textContent = '';
    subject.hidden = false;
    subject.appendChild(el('p', { class: 'small muted' }, root.dataset.tPickPatientCard || ''));
    subject.appendChild(el('h2', {}, p.name));
    subject.appendChild(el('p', { class: 'sub' }, root.dataset.tPickPatientHint || ''));
    subject
      .appendChild(el('p', {}, ''))
      .appendChild(el('a', { href: `/work/patients/${p.id}` }, root.dataset.tPickOpenPatient || ''));
  }

  function showDrugCard(drug) {
    subject.textContent = '';
    subject.hidden = false;
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
    subject.appendChild(el('p', {}, '')).appendChild(el('a', { href: '/work?tab=library' }, drugText.all_articles));
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
    state.drug = null;
    state.patient = { id: p.id, name: p.name };
    state.chips = [];
    setPlaceholder();
    resetFeed();
    showPatientCard(p);
    renderChips();
    loadSuggestions();
    // Прежний разговор с этим пациентом (последний тред специалиста по нему) показываем сразу.
    const list = await getJson('/api/v1/ai/threads?purpose=clinician_chat');
    const last = (list.data.items || []).find((x) => x.patient_id === p.id);
    if (last && state.patient && state.patient.id === p.id) {
      const msgs = await getJson(`/api/v1/ai/threads/${encodeURIComponent(last.id)}`);
      if (msgs.ok && state.patient && state.patient.id === p.id) restoreMessages(msgs.data.messages);
    }
  }

  async function showDrug(thread, drug, messages) {
    state.patient = null;
    state.chips = [];
    state.drug = { thread, drug };
    setPlaceholder();
    resetFeed();
    showDrugCard(drug);
    renderChips();
    restoreMessages(messages);
    drugQuestions();
    history.replaceState(null, '', `/work?tab=chat&thread=${thread.id}`);
    sideHistory();
  }

  async function selectDrug(innId) {
    const res = await postJson(`/work/api/drugs/${innId}/open`, {});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      resetFeed();
      addBubble('assistant', drugText.open_failed);
      return;
    }
    showDrug(data.thread, data.drug, []);
  }

  async function openDrugThread(th) {
    const [drug, msgs] = await Promise.all([
      getJson(`/work/api/drugs/${th.drug_inn_id}`),
      getJson(`/api/v1/ai/threads/${encodeURIComponent(th.id)}`),
    ]);
    if (!drug.ok || !msgs.ok) return;
    showDrug({ id: th.id }, drug.data, msgs.data.messages);
  }

  let pickTimer = null;
  let pickSeq = 0;
  async function renderPick() {
    const seq = ++pickSeq;
    const query = pickField.value.trim().toLowerCase();
    const patients = state.patients.filter((p) => !query || p.name.toLowerCase().includes(query)).slice(0, 6);
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    const found = await getJson(`/work/api/drugs?${params}`);
    if (seq !== pickSeq) return;
    const drugs = (found.data.items || []).slice(0, query ? 8 : 6);
    pickBox.textContent = '';
    const section = (title, rows) => {
      if (!rows.length) return;
      pickBox.appendChild(el('h4', {}, title));
      for (const r of rows) pickBox.appendChild(r);
    };
    section(
      root.dataset.tPickPatients,
      patients.map((p) => {
        const a = el(
          'a',
          { href: '#', class: 'th', role: 'option', 'data-type': 'patient', 'data-id': String(p.id) },
          p.name,
        );
        a.addEventListener('mousedown', (e) => e.preventDefault());
        a.addEventListener('click', (e) => {
          e.preventDefault();
          closePick();
          selectPatient(p);
        });
        return a;
      }),
    );
    section(
      root.dataset.tPickDrugs,
      drugs.map((d) => {
        const a = el('a', {
          href: '#',
          class: 'th pick-drug',
          role: 'option',
          'data-type': 'drug',
          'data-id': String(d.id),
        });
        a.appendChild(el('span', {}, cap(d.name)));
        a.appendChild(
          el('small', {}, [d.group_label, d.trade_names.slice(0, 2).join(', ')].filter(Boolean).join(' · ')),
        );
        a.addEventListener('mousedown', (e) => e.preventDefault());
        a.addEventListener('click', (e) => {
          e.preventDefault();
          closePick();
          selectDrug(d.id);
        });
        return a;
      }),
    );
    if (!pickBox.children.length) pickBox.appendChild(el('p', { class: 'small muted' }, root.dataset.tPickNone));
    pickBox.hidden = false;
  }

  function closePick() {
    pickField.value = '';
    pickBox.hidden = true;
    pickBox.textContent = '';
    pickField.blur();
  }

  if (pickField) {
    pickField.addEventListener('focus', renderPick);
    pickField.addEventListener('input', () => {
      clearTimeout(pickTimer);
      pickTimer = setTimeout(renderPick, 150);
    });
    pickField.addEventListener('blur', () =>
      setTimeout(() => {
        if (document.activeElement !== pickField) pickBox.hidden = true;
      }, 150),
    );
  }

  // История чатов слева: GET /api/v1/ai/threads, группы «Сегодня / Ранее»; ?thread=ID открывает чат.
  // Чаты по лекарствам — обычные треды (purpose = drug_chat) и открываются здесь же, в общем пространстве.
  async function sideHistory() {
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
    const open = state.drug ? String(state.drug.thread.id) : new URLSearchParams(window.location.search).get('thread');
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
        box.appendChild(link);
      }
    }
    if (open && !state.drug) {
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
          const row = el('article', { class: `chat-msg chat-msg_${m.author}` });
          row.appendChild(el('p', { class: 'chat-msg__text' }, m.text));
          feed.appendChild(row);
        }
      } catch (_) {
        /* чат недоступен — пустое поле */
      }
    }
  }
  sideHistory();

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
