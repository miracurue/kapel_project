'use strict';

/**
 * Клиентская часть чата пациента (P-13, W-34): история «Сегодня/Ранее» — переименование
 * и удаление с «Отменить» (F-17); подсказки композера → чип в поле, «×» возвращает;
 * отрисовка ответа ИИ с пометкой и 👍/👎 (F-31), карточки «Похоже на побочный эффект» (F-30)
 * и сценария сбоя с «Повторить» (T-413). Отправку сообщения выполняет public/v2.js —
 * единый обработчик кнопки «Отправить» (кризисная карточка остаётся там же).
 *
 * Тексты значений — как в public/v2.js (значения ключей locales/ru.json); data-testid = ключ.
 */
(function () {
  const tid = (key) => `[data-testid="${key}"]`;

  async function send(path, method, body) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      headers['x-csrf-token'] = (await (await fetch('/api/v1/csrf')).json()).token;
      headers['idempotency-key'] = crypto.randomUUID();
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

  // Ответ ИИ (F-27/F-31): пометка «Ответ подготовлен ИИ», 👍/👎 — одна оценка, повтор заменяет.
  function renderReply(data) {
    hideHello();
    const el = document.createElement('article');
    el.className = 'chat-msg chat-msg_assistant';
    el.dataset.id = data.reply.id;
    const mark = document.createElement('p');
    mark.dataset.testid = 'msg.ai.mark';
    mark.textContent = 'Ответ подготовлен ИИ';
    const text = document.createElement('p');
    text.className = 'chat-msg__text';
    text.textContent = data.reply.text;
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

  // Подсказки композера (F-12): клик — чип в поле, «×» — подсказка возвращается в строку.
  async function loadSuggestions() {
    const row = document.querySelector('#v2-chat-suggestions');
    if (!row) return;
    let items = [];
    try {
      const res = await fetch('/api/v1/context/suggestions', { headers: { Accept: 'application/json' } });
      if (res.ok) items = (await res.json()).items || [];
    } catch (_) {
      items = [];
    }
    row.innerHTML = '';
    items.forEach((sug) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.testid = 'msg.composer.suggestion';
      btn.textContent = sug.label;
      btn.addEventListener('click', () => {
        btn.remove();
        addChip(sug, () => row.appendChild(btn));
      });
      row.appendChild(btn);
    });
  }

  function addChip(sug, restore) {
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
      restore();
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

  // Открытый тред (?thread=ID): сообщения с пометкой «Ответ подготовлен ИИ».
  function messageNode(m) {
    const el = document.createElement('article');
    el.className = `chat-msg chat-msg_${m.author}`;
    el.dataset.id = m.id;
    if (m.author === 'assistant' && m.ai_generated) {
      const mark = document.createElement('p');
      mark.dataset.testid = 'msg.ai.mark';
      mark.textContent = 'Ответ подготовлен ИИ';
      el.appendChild(mark);
    }
    const text = document.createElement('p');
    text.className = 'chat-msg__text';
    text.textContent = m.text;
    el.appendChild(text);
    return el;
  }

  async function openThread() {
    const id = new URLSearchParams(window.location.search).get('thread');
    if (!id || !feedRoot()) return;
    try {
      const { response, data } = await send(`/api/v1/ai/threads/${encodeURIComponent(id)}`, 'GET');
      if (!response.ok) return;
      hideHello();
      const feed = feedRoot();
      feed.innerHTML = '';
      (data.messages || []).forEach((m) => feed.appendChild(messageNode(m)));
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
    feedAppend(el);
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
    addChip({ chip: data.chip, label: data.label }, () => {});
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

  function init() {
    ideas();
    history();
    loadSuggestions();
    openThread();
    askFromUrl();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.PatientChat = { chips, renderReply, renderAeCard, renderSendError, renderUser };
})();
