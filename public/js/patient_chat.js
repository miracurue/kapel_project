'use strict';

/**
 * Клиентская часть чата пациента (P-13, W-34): история «Сегодня/Ранее» — переименование
 * и удаление с «Отменить» (F-17); чип прикрепления создаёт «✦ Спросить ИИ» на записи из
 * другой вкладки, «×» убирает чип (F-12); отрисовка ответа ИИ с пометкой и 👍/👎 (F-31),
 * карточки «Похоже на побочный эффект» (F-30) и сценария сбоя с «Повторить» (T-413).
 * Отправку сообщения выполняет public/v2.js — единый обработчик кнопки «Отправить»
 * (кризисная карточка остаётся там же).
 *
 * Подсказки прикрепления («Прикрепить: …») над полем ввода убраны решением владелицы
 * 2026-10-25: прикрепление осталось, но только как действие на самом объекте.
 *
 * Тексты значений — как в public/v2.js (значения ключей locales/ru.json); data-testid = ключ.
 */
(function () {
  const tid = (key) => `[data-testid="${key}"]`;

  async function send(path, method, body, idempotencyKey) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      headers['x-csrf-token'] = (await (await fetch('/api/v1/csrf')).json()).token;
      headers['idempotency-key'] = idempotencyKey || crypto.randomUUID();
    }
    const response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try {
      data = await response.json();
    } catch (_) {
      data = {};
    }
    return { response, data };
  }

  // Чипы, прикреплённые к сообщению (F-12): уходят в body.chips вместе с текстом.
  function chips() {
    return [...document.querySelectorAll('[data-chips] > button')]
      .filter((chip) => chip.dataset.testid === 'msg.composer.chip')
      .map((chip) => ({
        type: chip.dataset.type,
        id: chip.dataset.id,
      }));
  }

  function feedRoot() {
    return document.querySelector('#v3-chat');
  }

  function hideHello() {
    const hello = document.querySelector('#v2-chat-hello');
    if (hello) hello.hidden = true;
  }

  function feedAppend(node) {
    const feed = feedRoot();
    if (!feed) return null;
    feed.appendChild(node);
    return node;
  }

  // Ответ ИИ показывается форматированным (абзацы, списки, **жирный**, заголовки), а не со знаками разметки.
  // Разбор в DOM-узлы без innerHTML (public/js/work_drug_docs.js); без него — простой текст.
  function formatted(node, text) {
    const md = window.CCDrugDocs && window.CCDrugDocs.renderMarkdown;
    if (!md) {
      node.textContent = text;
      return node;
    }
    node.classList.add('md');
    node.appendChild(md(text, { breaks: true, plainLinks: true }));
    return node;
  }

  // Ответ ИИ (F-27/F-31): пометка «Ответ подготовлен ИИ», 👍/👎 — одна оценка, повтор заменяет.
  function renderReply(data) {
    hideHello();
    const el = document.createElement('article');
    el.className = 'chat-msg chat-msg_assistant';
    el.dataset.id = data.reply.id;
    const mark = document.createElement('p');
    mark.dataset.testid = 'msg.ai.mark';
    mark.textContent = 'Ответ подготовлен ИИ';
    const text = document.createElement('div');
    text.className = 'chat-msg__text';
    formatted(text, data.reply.text);
    el.append(mark, text);
    const useful = document.createElement('button');
    useful.type = 'button';
    useful.dataset.testid = 'msg.ai.rate.useful';
    useful.textContent = 'Полезно';
    const notUseful = document.createElement('button');
    notUseful.type = 'button';
    notUseful.dataset.testid = 'msg.ai.rate.not_useful';
    notUseful.textContent = 'Неполезно';
    const rate = async (isUseful) => {
      const { response } = await send(`/api/v1/ai/messages/${encodeURIComponent(data.reply.id)}/rating`, 'POST', {
        useful: isUseful,
      });
      if (!response.ok) return;
      useful.remove();
      notUseful.remove();
      const thanks = document.createElement('p');
      thanks.dataset.testid = 'msg.ai.rate.thanks';
      thanks.textContent = 'Спасибо, учтём';
      el.appendChild(thanks);
    };
    useful.addEventListener('click', () => rate(true));
    notUseful.addEventListener('click', () => rate(false));
    const write = document.createElement('a');
    write.dataset.testid = 'msg.chat.answer.write_doctor';
    write.href = '/app?tab=doctor';
    write.textContent = 'Написать врачу';
    const ratings = document.createElement('div');
    ratings.className = 'reply-actions';
    useful.className = 'btn sm';
    notUseful.className = 'btn sm';
    ratings.append(useful, notUseful);
    el.append(ratings, write);
    return feedAppend(el);
  }

  // F-30: карточка «Похоже на побочный эффект. Сообщить врачу?» — ничего не отправляется само;
  // «Да» → предзаполненная форма НЯ (P-14), предзаполнение передаётся через sessionStorage.
  function renderAeCard(prefill) {
    hideHello();
    const card = document.createElement('article');
    card.className = 'chat-msg chat-msg_system crisis-card';
    const title = document.createElement('p');
    title.dataset.testid = 'msg.chat.ae.suggest';
    title.textContent = 'Похоже на побочный эффект. Сообщить врачу?';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.dataset.testid = 'msg.chat.ae.suggest.yes';
    yes.textContent = 'Сообщить врачу';
    const no = document.createElement('button');
    no.type = 'button';
    no.dataset.testid = 'msg.chat.ae.suggest.no';
    no.textContent = 'Не сейчас';
    yes.addEventListener('click', () => {
      try {
        sessionStorage.setItem('cc.ae_prefill', JSON.stringify(prefill || {}));
      } catch (_) {
        /* предзаполнение необязательно */
      }
      window.location.href = '/app?tab=meds&flow=ae';
    });
    no.addEventListener('click', () => card.remove());
    card.append(title, yes, no);
    return feedAppend(card);
  }

  // ---- Опрос о побочном действии (пакет C плана 2026-10-23-ae-intake) ----
  // Карточка AeWizard в ленте; отправка — POST /api/v1/me/adverse-events (source 'ai_chat').
  // Не показывать повторно в том же чате после закрытия или отправки: флаг по треду, на клиенте.
  const aeState = { handled: new Set(), open: null, threadId: null };
  // «Тот же чат» — открытая лента: ?thread=ID или текущая страница (каждое сообщение со страницы чата
  // создаёт свой тред на сервере, поэтому ключом служит не id треда ответа).
  const aeKey = () => new URLSearchParams(window.location.search).get('thread') || 'page';

  function renderAeSummary(text, id) {
    hideHello();
    const el = document.createElement('article');
    el.className = 'chat-msg chat-msg_system ae-summary';
    el.dataset.kind = 'ae_summary';
    if (id) el.dataset.id = id;
    const p = document.createElement('p');
    p.className = 'chat-msg__text';
    p.textContent = text;
    el.appendChild(p);
    return feedAppend(el);
  }

  async function aeContext() {
    const [meds, people] = await Promise.all([
      send('/api/v1/me/meds', 'GET').catch(() => ({ data: {} })),
      send('/api/v1/me/messages', 'GET').catch(() => ({ data: {} })),
    ]);
    const items = ((meds.data && meds.data.plan_items) || [])
      .map((item) => ({
        item_key: item.item_key,
        name: [item.inn_name, item.acceptance && item.acceptance.product && item.acceptance.product.name]
          .filter(Boolean)
          .join(' · '),
      }))
      .filter((item) => item.item_key && item.name);
    const recipients = (people.data && people.data.recipients) || [];
    return { meds: items, recipients };
  }

  async function openAeWizard({ prefill, threadId, text }) {
    const key = aeKey(threadId);
    if (aeState.open || aeState.handled.has(key) || !window.AeWizard) return null;
    aeState.open = key;
    hideHello();
    const host = document.createElement('article');
    host.className = 'chat-msg chat-msg_system ae-host';
    feedAppend(host);
    const idempotencyKey = crypto.randomUUID();
    const tid = threadId || aeState.threadId || null;
    try {
      const [{ meds, recipients }, T] = await Promise.all([aeContext(), window.AeWizard.texts()]);
      const psychiatrist = recipients.find((r) => r.role === 'psychiatrist');
      const whoSees = psychiatrist
        ? (T['msg.ae.who_sees'] || '').replace('{clinician}', psychiatrist.name || '')
        : T['msg.ae.who_sees.none'] || '';
      const wizard = window.AeWizard.mount(host, {
        mode: 'patient',
        prefill: { ...(prefill || {}), text: (prefill && (prefill.text || prefill.description)) || text || '' },
        meds,
        whoSees,
        doctorLink: recipients.length ? '/app?tab=doctor' : null,
        fullFormHref: '/app?tab=meds&flow=ae',
        onSubmit: async (payload) => {
          const body = { ...payload, source: 'ai_chat' };
          if (tid) body.thread_id = Number(tid);
          const { response, data } = await send('/api/v1/me/adverse-events', 'POST', body, idempotencyKey);
          if (data && data.crisis && window.PatientChat.showCrisis) window.PatientChat.showCrisis(data);
          if (!response.ok) throw new Error(String((data && data.error && data.error.code) || response.status));
          if (data.summary && data.summary.text) renderAeSummary(data.summary.text, data.summary.id);
          return data;
        },
        onClose: ({ reason }) => {
          aeState.handled.add(key);
          aeState.open = null;
          if (reason !== 'not_adverse') host.remove();
        },
      });
      await wizard.ready;
      // Переход на полную форму не теряет введённое: текст и выраженность уходят в форму как предзаполнение.
      host.addEventListener('click', (event) => {
        if (!event.target.closest('[data-testid="msg.ae.wizard.full_form"]')) return;
        const now = wizard.state;
        try {
          sessionStorage.setItem(
            'cc.ae_prefill',
            JSON.stringify({ ...(prefill || {}), text: now.text, severity: now.severity || undefined }),
          );
        } catch (_) {
          /* предзаполнение необязательно */
        }
      });
      if (host.scrollIntoView) host.scrollIntoView({ block: 'nearest' });
      return host;
    } catch (_) {
      aeState.open = null;
      host.remove();
      return null;
    }
  }

  // Предложение модели (ответ с полем ae_offer, пакет E): «Да, расскажу подробнее» открывает ту же карточку.
  async function renderAeOffer(replyEl, { prefill, threadId, text } = {}) {
    if (!replyEl || aeState.handled.has(aeKey(threadId)) || aeState.open) return null;
    const T = window.AeWizard ? await window.AeWizard.texts() : {};
    const row = document.createElement('div');
    row.className = 'reply-actions ae-offer';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'btn sm primary';
    yes.dataset.testid = 'msg.ae.wizard.offer.yes';
    yes.textContent = T['msg.ae.wizard.offer.yes'] || 'Да, расскажу подробнее';
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn sm';
    no.dataset.testid = 'msg.ae.wizard.offer.no';
    no.textContent = T['msg.ae.wizard.offer.no'] || 'Не сейчас';
    yes.addEventListener('click', () => {
      row.remove();
      openAeWizard({ prefill, threadId, text });
    });
    no.addEventListener('click', () => {
      row.remove();
      aeState.handled.add(aeKey(threadId));
    });
    row.append(yes, no);
    replyEl.appendChild(row);
    return row;
  }

  // Статьи журнала, которые модель смотрела при ответе (поле articles): ссылки под ответом.
  async function renderArticles(replyEl, articles) {
    if (!replyEl || !Array.isArray(articles) || !articles.length) return null;
    const T = window.AeWizard ? await window.AeWizard.texts() : {};
    const row = document.createElement('div');
    row.className = 'reply-actions chat-articles';
    for (const a of articles.slice(0, 3)) {
      const link = document.createElement('a');
      link.className = 'btn sm';
      link.dataset.testid = 'msg.chat.article.link';
      link.href = `/journal/${encodeURIComponent(a.id)}`;
      link.textContent = `${T['msg.chat.article.link'] || 'Прочитать в журнале'}: ${a.title}`;
      row.append(link);
    }
    replyEl.appendChild(row);
    return row;
  }

  // Методика самопроводящая: карточка-кнопка со ссылкой на страницу упражнения (/methods/<slug>).
  async function renderTechnique(replyEl, technique) {
    if (!replyEl || !technique || !/^[a-z0-9-]+$/.test(String(technique.slug))) return null;
    const T = window.AeWizard ? await window.AeWizard.texts() : {};
    const row = document.createElement('div');
    row.className = 'reply-actions chat-technique';
    const link = document.createElement('a');
    link.className = 'btn sm primary';
    link.dataset.testid = 'msg.chat.technique.open';
    link.dataset.technique = technique.slug;
    link.href = `/methods/${encodeURIComponent(technique.slug)}`;
    link.textContent = `${T['msg.chat.technique.open'] || 'Открыть упражнение'}: ${technique.title}${technique.minutes ? ` · ${technique.minutes}` : ''}`;
    row.append(link);
    replyEl.appendChild(row);
    return row;
  }

  // Check-in: модель предложила запись в дневник (поле diary_proposal). Сохраняет только пациент, кнопкой.
  const MOOD_WORDS = { 1: 'очень плохое', 2: 'плохое', 3: 'среднее', 4: 'хорошее', 5: 'очень хорошее' };
  const SLEEP_WORDS = { bad: 'плохой', ok: 'средний', good: 'хороший' };
  const ANXIETY_WORDS = { none: 'нет', some: 'умеренная', strong: 'сильная' };

  async function renderDiaryProposal(replyEl, proposal) {
    if (!replyEl || !proposal) return null;
    // Модель может предложить ту же запись повторно (на «да, запиши»): прежняя ещё не сохранённая карточка заменяется.
    document.querySelectorAll('.diary-proposal[data-pending]').forEach((old) => old.remove());
    const T = window.AeWizard ? await window.AeWizard.texts() : {};
    const tx = (key, fallback) => T[key] || fallback;
    const box = document.createElement('div');
    box.className = 'reply-actions diary-proposal';
    box.dataset.pending = '1';
    box.dataset.testid = 'msg.chat.diary_proposal.title';
    const lines = [];
    if (proposal.mood) lines.push(`настроение ${proposal.mood}/5 (${MOOD_WORDS[proposal.mood]})`);
    if (proposal.sleep) lines.push(`сон ${SLEEP_WORDS[proposal.sleep]}`);
    if (proposal.anxiety) lines.push(`тревога ${ANXIETY_WORDS[proposal.anxiety]}`);
    if (proposal.note) lines.push(`заметка: ${proposal.note}`);
    const head = document.createElement('p');
    head.textContent = `${tx('msg.chat.diary_proposal.title', 'Записать в дневник?')} ${lines.join(', ')}`;
    const status = document.createElement('p');
    status.setAttribute('aria-live', 'polite');
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn sm primary';
    save.dataset.testid = 'msg.chat.diary_proposal.save';
    save.textContent = tx('msg.chat.diary_proposal.save', 'Записать в дневник');
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'btn sm';
    skip.dataset.testid = 'msg.chat.diary_proposal.skip';
    skip.textContent = tx('msg.chat.diary_proposal.skip', 'Не сейчас');
    skip.addEventListener('click', () => box.remove());
    const key = crypto.randomUUID();
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const body = {};
        for (const field of ['mood', 'sleep', 'anxiety', 'note']) if (proposal[field]) body[field] = proposal[field];
        const { response, data } = await send('/api/v1/me/diary', 'POST', body, key);
        if (response.ok) {
          delete box.dataset.pending;
          head.textContent = tx('msg.chat.diary_proposal.saved', 'Записано в дневник');
          save.remove();
          skip.remove();
          if (data && data.crisis && window.PatientChat.showCrisis) window.PatientChat.showCrisis(data);
        } else {
          status.textContent = tx('msg.chat.diary_proposal.failed', 'Не получилось записать.');
          save.disabled = false;
        }
      } catch (_) {
        status.textContent = tx('msg.chat.diary_proposal.failed', 'Не получилось записать.');
        save.disabled = false;
      }
    });
    box.append(head, save, skip, status);
    replyEl.appendChild(box);
    return box;
  }

  // Подготовка к визиту: модель составила список (поле visit_note_proposal). Врачу отправляет только пациент, кнопкой.
  async function renderVisitNote(replyEl, proposal) {
    if (!replyEl || !proposal || !proposal.text) return null;
    const T = window.AeWizard ? await window.AeWizard.texts() : {};
    const tx = (key, fallback) => T[key] || fallback;
    const box = document.createElement('div');
    box.className = 'reply-actions visit-note';
    box.dataset.testid = 'msg.chat.visit_note.title';
    const head = document.createElement('p');
    head.textContent = tx('msg.chat.visit_note.title', 'Отправить врачу список к визиту?');
    const preview = document.createElement('pre');
    preview.className = 'visit-note__text';
    preview.textContent = proposal.text;
    const status = document.createElement('p');
    status.setAttribute('aria-live', 'polite');
    const send_ = document.createElement('button');
    send_.type = 'button';
    send_.className = 'btn sm primary';
    send_.dataset.testid = 'msg.chat.visit_note.send';
    send_.textContent = tx('msg.chat.visit_note.send', 'Отправить врачу');
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'btn sm';
    skip.dataset.testid = 'msg.chat.visit_note.skip';
    skip.textContent = tx('msg.chat.visit_note.skip', 'Не сейчас');
    skip.addEventListener('click', () => box.remove());
    const key = crypto.randomUUID();
    send_.addEventListener('click', async () => {
      send_.disabled = true;
      try {
        const { response, data } = await send('/api/v1/me/messages', 'POST', { text: proposal.text }, key);
        if (response.ok) {
          head.textContent = tx('msg.chat.visit_note.sent', 'Отправлено врачу');
          preview.remove();
          send_.remove();
          skip.remove();
          if (data && data.crisis && window.PatientChat.showCrisis) window.PatientChat.showCrisis(data);
          return;
        }
      } catch (_) {
        /* ниже сообщение об ошибке */
      }
      status.textContent = tx('msg.chat.visit_note.failed', 'Не получилось отправить.');
      send_.disabled = false;
    });
    box.append(head, preview, send_, skip, status);
    replyEl.appendChild(box);
    return box;
  }

  // Первый ответ нового чата: тред попадает в адрес, чтобы обновление страницы вернуло в него же, а не в пустой чат.
  function pinThreadInUrl(threadId) {
    const params = new URLSearchParams(window.location.search);
    if (params.get('thread') || params.get('tab') !== 'chat') return;
    if (aeState.handled.has('page')) aeState.handled.add(String(threadId));
    try {
      window.history.replaceState(null, '', `/app?tab=chat&thread=${encodeURIComponent(threadId)}`);
    } catch (_) {
      /* адрес не обновился — чат всё равно откроется как последний по времени */
    }
  }

  // Черновик ввода переживает переход на другую вкладку и обратно (sessionStorage одной вкладки браузера).
  const DRAFT_KEY = 'cc.chat_draft';
  const PENDING_KEY = 'cc.chat_pending';
  const store = {
    get(key) {
      try {
        return window.sessionStorage.getItem(key);
      } catch (_) {
        return null;
      }
    },
    set(key, value) {
      try {
        if (value) window.sessionStorage.setItem(key, value);
        else window.sessionStorage.removeItem(key);
      } catch (_) {
        /* хранилище недоступно — чат работает без него */
      }
    },
  };
  function draft() {
    const field = document.querySelector(tid('msg.chat.placeholder'));
    if (!field) return;
    const saved = store.get(DRAFT_KEY);
    if (saved && !field.value) field.value = saved;
    const keep = () => store.set(DRAFT_KEY, field.value.trim() ? field.value : '');
    field.addEventListener('input', keep);
    window.addEventListener('pagehide', keep);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') keep();
    });
  }

  // Ответ ИИ ещё готовится (человек ушёл на другую вкладку сразу после отправки): показываем этапы и ждём ответ в этом треде.
  const WAIT_FRESH_MS = 3 * 60 * 1000;
  const WAIT_MAX_MS = 150 * 1000;
  async function awaitReply(threadId, messages) {
    const last = messages[messages.length - 1];
    if (!last || last.author !== 'user' || last.kind === 'error') return;
    if (Date.now() - Date.parse(last.created_at) > WAIT_FRESH_MS) return;
    let progressId = null;
    try {
      const pending = JSON.parse(store.get(PENDING_KEY) || 'null');
      if (pending && (!pending.thread || Number(pending.thread) === Number(threadId))) progressId = pending.progress;
    } catch (_) {
      progressId = null;
    }
    const stop = trackProgress(progressId || crypto.randomUUID());
    const started = Date.now();
    const known = new Set(messages.map((m) => m.id));
    const poll = async () => {
      let fresh = null;
      try {
        const { response, data } = await send(`/api/v1/ai/threads/${encodeURIComponent(threadId)}`, 'GET');
        if (response.ok) fresh = (data.messages || []).filter((m) => !known.has(m.id));
      } catch (_) {
        fresh = null;
      }
      const answered = fresh && fresh.some((m) => m.author !== 'user' || m.kind === 'error');
      if (answered || Date.now() - started > WAIT_MAX_MS) {
        stop();
        store.set(PENDING_KEY, '');
        if (answered) fresh.forEach((m) => feedAppend(messageNode(m)));
        return;
      }
      setTimeout(poll, 2500);
    };
    setTimeout(poll, 1500);
  }

  // Ответ чата: запомнить тред; ae_suggestion (словарь или модель) → карточка, ae_offer → кнопки под ответом.
  function renderAe(data, { text, replyEl } = {}) {
    const threadId = data && data.thread && data.thread.id;
    if (threadId) {
      aeState.threadId = threadId;
      pinThreadInUrl(threadId);
    }
    if (data && data.articles) renderArticles(replyEl, data.articles);
    if (data && data.technique) renderTechnique(replyEl, data.technique);
    if (data && data.diary_proposal) renderDiaryProposal(replyEl, data.diary_proposal);
    if (data && data.visit_note_proposal) renderVisitNote(replyEl, data.visit_note_proposal);
    if (data && data.ae_suggestion) return openAeWizard({ prefill: data.ae_suggestion.prefill || {}, threadId, text });
    if (data && data.ae_offer)
      return renderAeOffer(replyEl, { prefill: (data.ae_offer && data.ae_offer.prefill) || {}, threadId, text });
    return null;
  }

  // Сбой ИИ (T-413): «Не получилось ответить», текст остаётся в поле, «Повторить» отвечает.
  function renderSendError(code) {
    const box = document.createElement('div');
    box.className = 'chat-msg chat-msg_error';
    const p = document.createElement('p');
    p.dataset.testid = `err.${String(code || 'E-AI-UNAVAILABLE').toLowerCase()}`;
    p.textContent = 'Не получилось ответить. Текст остался в поле';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.dataset.testid = 'msg.shell.retry';
    retry.textContent = 'Повторить';
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      try {
        const threads = await send('/api/v1/ai/threads?purpose=patient_assistant', 'GET');
        const thread = threads.data.items && threads.data.items[0];
        if (!thread) return;
        const opened = await send(`/api/v1/ai/threads/${encodeURIComponent(thread.id)}`, 'GET');
        const lost = [...(opened.data.messages || [])]
          .reverse()
          .find((m) => m.author === 'user' && m.status === 'error');
        if (!lost) return;
        const retried = await send(`/api/v1/ai/messages/${encodeURIComponent(lost.id)}/retry`, 'POST', {});
        if (retried.response.ok && retried.data.reply) {
          box.remove();
          renderReply(retried.data);
        }
      } catch (_) {
        retry.disabled = false;
      }
    });
    box.append(p, retry);
    return feedAppend(box);
  }

  // Чип прикреплённого объекта (F-12): его создаёт «✦ Спросить ИИ» на записи (askFromUrl).
  // Ряд подсказок прикрепления над полем ввода убран (решение владелицы 2026-10-25).
  function addChip(sug) {
    const box = document.querySelector('[data-chips]');
    if (!box) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.dataset.testid = 'msg.composer.chip';
    chip.dataset.type = sug.chip.type;
    chip.dataset.id = String(sug.chip.id);
    chip.textContent = sug.label;
    const remove = document.createElement('span');
    remove.dataset.testid = 'msg.composer.chip.remove';
    remove.textContent = '×';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      chip.remove();
    });
    chip.appendChild(remove);
    box.appendChild(chip);
  }

  // История чатов (F-28): переименование (PATCH) и удаление с «Отменить» (DELETE + POST /undo).
  function history() {
    document.querySelectorAll('[data-thread]').forEach((rowEl) => {
      const id = rowEl.dataset.thread;
      const renameBtn = rowEl.querySelector(tid('msg.chat.history.rename'));
      const delBtn = rowEl.querySelector(tid('msg.chat.history.delete'));
      if (renameBtn)
        renameBtn.addEventListener('click', async () => {
          const title = window.prompt('Новое название чата');
          if (!title) return;
          const { response } = await send(`/api/v1/ai/threads/${encodeURIComponent(id)}`, 'PATCH', { title });
          if (!response.ok) return;
          const link = rowEl.querySelector('a');
          if (link) link.textContent = title;
          const note = document.createElement('p');
          note.dataset.testid = 'msg.undo.chat_renamed';
          note.textContent = 'Переименовано';
          rowEl.appendChild(note);
        });
      if (delBtn)
        delBtn.addEventListener('click', async () => {
          const { data } = await send(`/api/v1/ai/threads/${encodeURIComponent(id)}`, 'DELETE');
          const link = rowEl.querySelector('a');
          if (link) link.hidden = true;
          delBtn.disabled = true;
          if (renameBtn) renameBtn.disabled = true;
          const undoBtn = document.createElement('button');
          undoBtn.type = 'button';
          undoBtn.dataset.testid = 'msg.undo.action';
          undoBtn.textContent = 'Чат удалён · Отменить';
          undoBtn.addEventListener('click', async () => {
            if (!data.undo || !data.undo.id) return;
            await send(`/api/v1/undo/${encodeURIComponent(data.undo.id)}`, 'POST', {});
            if (link) link.hidden = false;
            undoBtn.remove();
            if (delBtn) delBtn.disabled = false;
            if (renameBtn) renameBtn.disabled = false;
          });
          rowEl.appendChild(undoBtn);
        });
    });
  }

  // Примеры пустого чата: текст — в поле.
  function ideas() {
    document.querySelectorAll('[data-idea]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const field = document.querySelector(tid('msg.chat.placeholder'));
        if (field) field.value = btn.dataset.idea;
        hideHello();
      }),
    );
  }

  // Открыт прежний чат: напоминания (лекарства, дневник, визит) остаются на виду над лентой, а не прячутся с приветствием.
  function keepReminders() {
    const hello = document.querySelector('#v2-chat-hello');
    const box = hello && hello.querySelector('.callout.reminders');
    if (box && hello.parentNode) hello.parentNode.insertBefore(box, hello);
  }

  // Открытый тред (?thread=ID): сообщения с пометкой «Ответ подготовлен ИИ».
  function messageNode(m) {
    if (m.kind === 'ae_summary') {
      const node = document.createElement('article');
      node.className = 'chat-msg chat-msg_system ae-summary';
      node.dataset.kind = 'ae_summary';
      node.dataset.id = m.id;
      const p = document.createElement('p');
      p.className = 'chat-msg__text';
      p.textContent = m.text;
      node.appendChild(p);
      return node;
    }
    const el = document.createElement('article');
    el.className = `chat-msg chat-msg_${m.author}`;
    el.dataset.id = m.id;
    if (m.author === 'assistant' && m.ai_generated) {
      const mark = document.createElement('p');
      mark.dataset.testid = 'msg.ai.mark';
      mark.textContent = 'Ответ подготовлен ИИ';
      el.appendChild(mark);
    }
    const text = document.createElement(m.author === 'assistant' ? 'div' : 'p');
    text.className = 'chat-msg__text';
    if (m.author === 'assistant') formatted(text, m.text);
    else text.textContent = m.text;
    el.appendChild(text);
    return el;
  }

  async function openThread() {
    const id = new URLSearchParams(window.location.search).get('thread');
    if (!feedRoot()) return;
    // Идущий кризисный разговор важнее любого другого открытия страницы (обновление, вкладка без адреса треда).
    if (window.PatientCrisis && (await window.PatientCrisis.restoreActive())) return;
    if (!id) return;
    // Тред известен сразу: сообщение, отправленное до загрузки истории, уйдёт в него же, а не в новый чат.
    aeState.threadId = Number(id);
    try {
      const { response, data } = await send(`/api/v1/ai/threads/${encodeURIComponent(id)}`, 'GET');
      if (!response.ok) {
        aeState.threadId = null;
        return;
      }
      // Тред кризисного режима открывается как разговор с закреплёнными телефонами (public/js/patient_crisis.js).
      if (window.PatientCrisis && (await window.PatientCrisis.resumeFrom(data))) {
        aeState.threadId = null;
        return;
      }
      hideHello();
      keepReminders();
      const feed = feedRoot();
      // Пока грузилась история, человек уже мог отправить сообщение: его не стираем, историю ставим перед ним.
      const sentMeanwhile = [...feed.childNodes];
      feed.innerHTML = '';
      (data.messages || []).forEach((m) => {
        if (m.kind === 'ae_summary') aeState.handled.add(aeKey(id));
        feed.appendChild(messageNode(m));
      });
      sentMeanwhile.forEach((node) => feed.appendChild(node));
      if (!sentMeanwhile.length) awaitReply(id, data.messages || []);
    } catch (_) {
      /* история недоступна — пустой чат */
    }
  }

  // Сообщение пациента — пузырём справа, как в прототипе.
  function renderUser(text, chipLabels) {
    hideHello();
    const el = document.createElement('article');
    el.className = 'chat-msg chat-msg_user';
    if (chipLabels && chipLabels.length) {
      const att = document.createElement('div');
      att.className = 'att';
      chipLabels.forEach((label) => {
        const chip = document.createElement('span');
        chip.className = 'chip ro';
        chip.textContent = label;
        att.appendChild(chip);
      });
      el.appendChild(att);
    }
    const body = document.createElement('p');
    body.className = 'chat-msg__text';
    body.textContent = text;
    el.appendChild(body);
    return feedAppend(el);
  }

  // Сообщение не ушло: убираем его из ленты (текст возвращает вызывающий код); пустой чат снова показывает приветствие.
  function removeUser(el) {
    if (el && el.isConnected) el.remove();
    const feed = feedRoot();
    const hello = document.querySelector('#v2-chat-hello');
    if (feed && hello && !feed.children.length) hello.hidden = false;
  }

  // Ход ответа: пока ИИ работает, в ленте растёт список этапов («Смотрю твой дневник», «Формулирую ответ»).
  // Этапы приходят с сервера (GET /api/v1/ai/threads?progress_id=…), в них нет текста сообщения и данных.
  const SLOW_AFTER_MS = 20000;
  function trackProgress(progressId, { before = null } = {}) {
    hideHello();
    const feed = feedRoot();
    if (!feed) return () => {};
    const el = document.createElement('article');
    el.className = 'chat-msg chat-msg_assistant is-working';
    el.dataset.testid = 'msg.chat.progress';
    const list = document.createElement('ol');
    list.className = 'progress';
    list.setAttribute('aria-live', 'polite');
    const slow = document.createElement('p');
    slow.className = 'small muted';
    slow.hidden = true;
    slow.dataset.testid = 'msg.chat.progress.slow';
    slow.textContent = 'Это занимает чуть дольше обычного. Ответ появится здесь, ничего не нужно нажимать повторно.';
    el.append(list, slow);
    if (before && before.parentNode === feed) feed.insertBefore(el, before);
    else feed.appendChild(el);
    let shown = -1;
    let stopped = false;
    const paint = (stages) => {
      const all = ['Сообщение отправлено', ...stages];
      if (all.length === shown) return;
      shown = all.length;
      list.textContent = '';
      all.forEach((label, i) => {
        const li = document.createElement('li');
        li.className = i === all.length - 1 ? 'progress__now' : 'progress__done';
        li.textContent = i === all.length - 1 ? `${label}…` : label;
        list.appendChild(li);
      });
      el.scrollIntoView({ block: 'nearest' });
    };
    paint([]);
    const started = Date.now();
    const tick = async () => {
      if (stopped) return;
      try {
        const { response, data } = await send(
          `/api/v1/ai/threads?progress_id=${encodeURIComponent(progressId)}`,
          'GET',
        );
        if (response.ok && !stopped && data.progress) paint(data.progress.stages || []);
      } catch (_) {
        /* следующий опрос */
      }
      if (!stopped && Date.now() - started > SLOW_AFTER_MS) slow.hidden = false;
      if (!stopped) setTimeout(tick, 700);
    };
    tick();
    return () => {
      stopped = true;
      el.remove();
    };
  }

  // «✦ Спросить ИИ» с другой вкладки: /app?tab=chat&ask=тип:id — чип объекта и готовые вопросы (F-29).
  async function askFromUrl() {
    const ask = new URLSearchParams(window.location.search).get('ask');
    if (!ask || !feedRoot()) return;
    const cut = ask.indexOf(':');
    if (cut < 1) return;
    const { response, data } = await send(
      `/api/v1/ai/questions?object_type=${encodeURIComponent(ask.slice(0, cut))}&object_id=${encodeURIComponent(ask.slice(cut + 1))}`,
      'GET',
    );
    if (!response.ok || !data.chip) return;
    addChip({ chip: data.chip, label: data.label });
    const box = document.querySelector('#v2-chat-hello .ideas');
    if (!box || !(data.questions || []).length) return;
    let T = {};
    try {
      T = await (await fetch('/assets/ru.json')).json();
    } catch (_) {
      T = {};
    }
    const worse = T['msg.ask.worse'] || 'Мне хуже';
    box.innerHTML = '';
    data.questions.forEach((question) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'idea';
      btn.textContent = question;
      if (question === worse) {
        btn.dataset.testid = 'msg.ask.worse';
        btn.addEventListener('click', () => worseFlow(box, T));
      } else
        btn.addEventListener('click', () => {
          const field = document.querySelector(tid('msg.chat.placeholder'));
          if (field) {
            field.value = question;
            field.focus();
          }
        });
      box.appendChild(btn);
    });
  }

  // «Мне хуже»: два вопроса безопасности кнопками. Тревожный ответ («Да» на первый, «Нет» на второй,
  // «Не хочу отвечать» на первый ведёт ко второму) — кризисная карточка без модели и сигнал врачу
  // через POST /api/v1/crisis/help. Карточка с 112 показывается всегда, даже если сигнал не ушёл.
  function worseFlow(box, T) {
    const label = (key, fallback) => T[key] || fallback;
    const button = (key, fallback, handler) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'idea';
      el.dataset.testid = key;
      el.textContent = label(key, fallback);
      el.addEventListener('click', handler);
      return el;
    };
    const ask = (qKey, qFallback, buttons) => {
      box.innerHTML = '';
      const q = document.createElement('p');
      q.dataset.testid = qKey;
      q.textContent = label(qKey, qFallback);
      const row = document.createElement('div');
      row.className = 'ideas';
      row.append(...buttons);
      box.append(q, row);
    };
    const calm = () => {
      box.innerHTML = '';
      const note = document.createElement('p');
      note.className = 'muted';
      note.dataset.testid = 'msg.chat.worse.after';
      note.textContent = label('msg.chat.worse.after', '');
      box.appendChild(note);
    };
    const alarm = async (answer) => {
      hideHello();
      box.innerHTML = '';
      const card = document.createElement('section');
      card.className = 'chat-msg chat-msg_system crisis-card';
      card.dataset.testid = 'msg.crisis.card';
      const render = (delivered) => {
        const who = delivered ? label('msg.crisis.card.who_sees', '') : label('msg.crisis.card.delivery_failed', '');
        card.innerHTML = `<h3 data-testid="msg.crisis.card.title"></h3><p class="acts"><a class="btn crisis" href="tel:112" data-testid="msg.crisis.card.call"></a> <a class="btn" href="/app?tab=doctor" data-testid="msg.crisis.card.write"></a></p><p class="small muted" data-testid="msg.crisis.card.who_sees"></p>`;
        card.querySelector('[data-testid="msg.crisis.card.title"]').textContent = label(
          'msg.crisis.card.title',
          'Вы не одни',
        );
        card.querySelector('[data-testid="msg.crisis.card.call"]').textContent = label(
          'msg.crisis.card.call',
          'Позвонить 112',
        );
        card.querySelector('[data-testid="msg.crisis.card.write"]').textContent = label(
          'msg.crisis.card.write',
          'Написать врачу',
        );
        card.querySelector('[data-testid="msg.crisis.card.who_sees"]').textContent = who;
      };
      render(true);
      feedAppend(card);
      try {
        const { response, data } = await send('/api/v1/crisis/help', 'POST', {
          source: 'button',
          text: `Нажато «Мне хуже»: ${answer}`,
        });
        if (!response.ok || (data.crisis && data.crisis.signal_delivered === false)) render(false);
      } catch (_) {
        render(false);
      }
    };
    const q2 = () =>
      ask('msg.chat.worse.q2', 'Вам сейчас безопасно?', [
        button('msg.chat.worse.q2.yes', 'Да', calm),
        button('msg.chat.worse.q2.no', 'Нет', () => alarm('сейчас небезопасно')),
      ]);
    ask('msg.chat.worse.q1', 'Есть ли у вас сейчас мысли причинить себе вред?', [
      button('msg.chat.worse.q1.yes', 'Да', () => alarm('есть мысли причинить себе вред')),
      button('msg.chat.worse.q1.no', 'Нет', q2),
      button('msg.chat.worse.q1.skip', 'Не хочу отвечать', q2),
    ]);
  }

  // Мягкая пауза чата (статус ТРОЛЛЬ): поле ввода и кнопки неактивны, подпись и экстренная помощь видны. Сервер
  // проверяет паузу при каждой отправке; здесь только вид и таймер возврата. Кризисный разговор паузу снимает с экрана.
  let paused = false;
  let pauseTimer = null;
  const pauseControls = () =>
    ['msg.chat.placeholder', 'msg.composer.attach', 'msg.composer.send']
      .map((key) => document.querySelector(tid(key)))
      .filter(Boolean);
  function showPaused(until) {
    const box = document.querySelector('[data-chat-paused]');
    if (!box) return;
    paused = true;
    box.hidden = false;
    box.dataset.until = until || '';
    for (const el of pauseControls()) el.disabled = true;
    clearTimeout(pauseTimer);
    const ms = until ? new Date(until).getTime() - Date.now() : 0;
    if (ms > 0) pauseTimer = setTimeout(hidePaused, Math.min(ms + 500, 2147483647));
  }
  function hidePaused() {
    const box = document.querySelector('[data-chat-paused]');
    paused = false;
    clearTimeout(pauseTimer);
    if (box) box.hidden = true;
    for (const el of pauseControls()) el.disabled = false;
  }

  function init() {
    const pausedBox = document.querySelector('[data-chat-paused]');
    if (pausedBox && pausedBox.dataset.until) showPaused(pausedBox.dataset.until);
    ideas();
    history();
    draft();
    openThread();
    askFromUrl();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.PatientChat = {
    chips,
    renderReply,
    renderAeCard,
    renderAe,
    renderAeOffer,
    renderAeSummary,
    renderSendError,
    renderUser,
    removeUser,
    trackProgress,
    showPaused,
    hidePaused,
    isPaused: () => paused,
    threadId: () => aeState.threadId,
    rememberPending: (progressId) =>
      store.set(PENDING_KEY, JSON.stringify({ thread: aeState.threadId, progress: progressId })),
  };
})();
