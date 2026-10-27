'use strict';

/**
 * Кризисный режим чата пациента (решение владельца 2026-10-26). Подключается на странице чата и на странице справки.
 *
 * Когда сервер открывает кризисный тред (кризисная фраза в чате или кнопка «Поговорить сейчас»), лента заменяется
 * разговором: сверху закреплена карточка с 112 и остальными телефонами из настройки «Кризисные контакты»,
 * под ней сообщения, быстрые ответы и поле ввода. Статус сигнала («врач увидел») обновляется опросом треда.
 * Отправку из поля выполняет public/v2.js, пока режим активен, он передаёт её сюда (submit).
 *
 * Тексты — из /assets/ru.json (ключи msg.crisis.chat.*), data-testid = ключ.
 */
(function () {
  const POLL_MS = 20000;
  let texts = {};
  let threadId = null;
  let timer = null;
  let sending = false;
  const QUICK_TEXTS = [
    'Да, я сейчас в безопасности',
    'Нет, мне небезопасно',
    'Не знаю',
    'Это вышло случайно',
  ];

  const T = (key, fallback) => texts[key] || fallback || key;
  const feed = () => document.querySelector('#v3-chat');
  const field = () => document.querySelector('[data-testid="msg.chat.placeholder"]');

  async function csrf() {
    return (await (await fetch('/api/v1/csrf')).json()).token;
  }

  async function call(path, method, body) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      headers['x-csrf-token'] = await csrf();
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

  async function loadTexts() {
    if (Object.keys(texts).length) return;
    try {
      const response = await fetch('/assets/ru.json');
      if (response.ok) texts = await response.json();
    } catch (_) {
      /* без словаря остаются запасные тексты */
    }
  }

  function el(tag, className, testid, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (testid) node.dataset.testid = testid;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function contacts() {
    try {
      const { response, data } = await call('/api/v1/crisis/contacts', 'GET');
      if (response.ok && Array.isArray(data.contacts) && data.contacts.length) return data.contacts;
    } catch (_) {
      /* ниже минимум */
    }
    return [{ title: 'Экстренные службы', phone: '112' }];
  }

  const telHref = (phone) => `tel:${String(phone).replace(/[^+\d]/g, '')}`;

  // Закреплённая карточка: 112 всегда, остальные телефоны — из настройки; если их нет, видно место под них.
  // Свёрнутость и «быстрые ответы уже нажимали» хранятся на клиенте по номеру треда; при возврате восстанавливаются
  // ещё и по самой переписке (резервный путь, если хранилище недоступно).
  const flagKey = (name) => `cc.crisis.${name}.${threadId}`;
  function flag(name) {
    try {
      return window.localStorage.getItem(flagKey(name)) === '1';
    } catch (_) {
      return false;
    }
  }
  function setFlag(name) {
    try {
      window.localStorage.setItem(flagKey(name), '1');
    } catch (_) {
      /* без хранилища флаг живёт до перезагрузки страницы */
    }
  }

  function setCollapsed(pin, collapsed) {
    pin.dataset.collapsed = collapsed ? '1' : '';
    if (!collapsed) delete pin.dataset.collapsed;
    const toggle = pin.querySelector('[data-crisis-toggle]');
    if (!toggle) return;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.textContent = collapsed
      ? T('msg.crisis.chat.pin.expand', 'Развернуть')
      : T('msg.crisis.chat.pin.collapse', 'Свернуть');
  }

  // Первый ответ пациента в разговоре: карточка сворачивается в полосу с 112 (остаётся закреплённой, разворачивается).
  function collapsePin() {
    const pin = document.querySelector('[data-testid="msg.crisis.chat.pin"]');
    if (pin && !pin.dataset.collapsed && !pin.dataset.userExpanded) setCollapsed(pin, true);
    setFlag('collapsed');
  }

  function hideQuick() {
    setFlag('quick');
    const box = document.querySelector('[data-crisis-quick]');
    if (box) box.hidden = true;
  }

  async function renderPin(state) {
    const list = await contacts();
    const pin = el('section', 'crisis-card crisis-pin', 'msg.crisis.chat.pin');
    pin.setAttribute('aria-label', T('msg.crisis.chat.pin.title', 'Если опасность прямо сейчас'));
    pin.append(el('h2', '', 'msg.crisis.card.title', T('msg.crisis.card.title', 'Похоже, сейчас вам очень трудно')));
    // Кто что увидит: одна строка на виду (врач или служба, не весь разговор).
    const noClinician = state && state.has_clinician === false;
    pin.append(
      el(
        'p',
        'small',
        'msg.crisis.card.who_sees',
        noClinician ? T('msg.crisis.card.who_sees.no_clinician') : T('msg.crisis.card.who_sees'),
      ),
    );
    const acts = el('p', 'acts');
    const call112 = el('a', 'btn crisis', 'msg.crisis.card.call', T('msg.crisis.card.call', 'Позвонить 112'));
    call112.href = 'tel:112';
    const write = el('a', 'btn', 'msg.crisis.card.write', T('msg.crisis.card.write', 'Написать врачу'));
    write.href = '/app?tab=doctor';
    acts.append(call112, write);
    pin.append(acts);
    const toggle = el('button', 'btn crisis-toggle', 'msg.crisis.chat.pin.toggle');
    toggle.type = 'button';
    toggle.dataset.crisisToggle = '';
    toggle.addEventListener('click', () => {
      const collapsed = !pin.dataset.collapsed;
      if (!collapsed) pin.dataset.userExpanded = '1';
      else delete pin.dataset.userExpanded;
      setCollapsed(pin, collapsed);
    });
    pin.append(toggle);
    setCollapsed(pin, false);
    const others = list.filter((c) => String(c.phone).trim() !== '112');
    if (others.length) {
      const ul = el('ul', 'crisis-contacts', 'msg.crisis.chat.contacts');
      others.forEach((c) => {
        const li = document.createElement('li');
        const a = el('a', '', '', `${c.title}: ${c.phone}`);
        a.href = telHref(c.phone);
        li.append(a);
        if (c.hours) li.append(document.createTextNode(` · ${c.hours}`));
        ul.append(li);
      });
      pin.append(ul);
    }
    // Пояснения свёрнуты: карточка закреплена и не должна закрывать разговор.
    const more = el('details', 'small');
    more.append(el('summary', '', '', T('msg.crisis.chat.more', 'О телефонах и приватности')));
    const status = el('p', 'small', 'msg.crisis.chat.status');
    status.dataset.crisisStatus = '';
    status.setAttribute('aria-live', 'polite');
    pin.append(status);
    // Место под телефоны клиники и доверия: список задаёт администратор («Кризисные контакты»), утверждает владелица.
    const slot = el('p', 'muted', 'msg.crisis.chat.contacts_standin', T('msg.crisis.chat.contacts_standin', ''));
    slot.dataset.standin = '';
    more.append(slot);
    more.append(el('p', 'muted', 'msg.crisis.chat.privacy', T('msg.crisis.chat.privacy', '')));
    pin.append(more);
    return pin;
  }

  function messageNode(role, text, aiGenerated, id) {
    const node = el('article', role === 'user' ? 'chat-msg chat-msg_user' : 'chat-msg chat-msg_assistant');
    if (id) node.dataset.id = id;
    if (role !== 'user' && aiGenerated) node.append(el('p', '', 'msg.ai.mark', 'Ответ подготовлен ИИ'));
    const md = role !== 'user' && window.CCDrugDocs && window.CCDrugDocs.renderMarkdown;
    if (md) {
      // Ответ ассистента форматируется (абзацы, списки, жирный), без знаков разметки на экране.
      const box = el('div', 'chat-msg__text md');
      box.append(md(text, { breaks: true, plainLinks: true }));
      node.append(box);
      return node;
    }
    text
      .split(/\n{2,}/)
      .filter(Boolean)
      .forEach((part) => node.append(el('p', 'chat-msg__text', '', part)));
    return node;
  }

  function addMessage(role, text, aiGenerated, id) {
    const root = feed();
    if (!root) return null;
    const node = messageNode(role, text, aiGenerated, id);
    root.insertBefore(node, root.querySelector('[data-crisis-quick]'));
    node.scrollIntoView({ block: 'nearest' });
    return node;
  }

  // Быстрые ответы: отправляют обычный текст, чтобы модель и врач видели то же, что человек.
  function renderQuick() {
    const box = el('div', 'ideas', 'msg.crisis.chat.quick');
    box.dataset.crisisQuick = '';
    [
      ['msg.crisis.chat.quick.safe', 'Да, я сейчас в безопасности'],
      ['msg.crisis.chat.quick.unsafe', 'Нет, мне небезопасно'],
      ['msg.crisis.chat.quick.unknown', 'Не знаю'],
      ['msg.crisis.chat.quick.mistake', 'Это вышло случайно'],
    ].forEach(([key, fallback]) => {
      const b = el('button', 'idea', key, T(key, fallback));
      b.type = 'button';
      b.addEventListener('click', () => {
        hideQuick();
        sendText(b.textContent);
      });
      box.append(b);
    });
    return box;
  }

  function setStatus(state) {
    const node = document.querySelector('[data-crisis-status]');
    if (node && state && state.text) node.textContent = state.text;
  }

  async function poll() {
    if (!threadId) return;
    try {
      const { response, data } = await call(`/api/v1/ai/threads/${encodeURIComponent(threadId)}`, 'GET');
      if (response.ok && data.thread) setStatus(data.thread.crisis);
    } catch (_) {
      /* следующий опрос */
    }
  }

  function startPolling() {
    if (timer) clearInterval(timer);
    timer = setInterval(poll, POLL_MS);
  }

  // Адрес держит кризисный тред: обновление страницы возвращает в него же (вместе с restoreActive, если адрес потерян).
  function pinInUrl(id) {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('tab') === 'chat' && params.get('thread') !== String(id))
        window.history.replaceState(null, '', `/app?tab=chat&thread=${encodeURIComponent(id)}`);
    } catch (_) {
      /* адрес не обновился: страницу вернёт restoreActive */
    }
  }

  async function mount(id, state) {
    await loadTexts();
    const root = feed();
    if (!root) return false;
    threadId = Number(id);
    pinInUrl(threadId);
    const hello = document.querySelector('#v2-chat-hello');
    if (hello) hello.hidden = true;
    root.innerHTML = '';
    root.append(await renderPin(state));
    const quick = renderQuick();
    quick.hidden = flag('quick');
    root.append(quick);
    if (flag('collapsed')) setCollapsed(root.querySelector('[data-testid="msg.crisis.chat.pin"]'), true);
    // Кризисный разговор не блокируется никогда: мягкая пауза чата (статус ТРОЛЛЬ) с экрана снимается.
    if (window.PatientChat && window.PatientChat.hidePaused) window.PatientChat.hidePaused();
    const input = field();
    if (input) input.placeholder = T('msg.crisis.chat.placeholder', input.placeholder);
    setStatus(state);
    startPolling();
    return true;
  }

  // Первый ответ сервера на кризисную фразу или кнопку: { crisis, crisis_thread, reply }.
  async function enter(data, sentText) {
    if (!data || !data.crisis_thread) return false;
    // Кризис признан внутри обычного разговора (crisis_thread.adopted): тред тот же, показываем его целиком.
    if (data.crisis_thread.adopted) {
      const { response, data: full } = await call(
        `/api/v1/ai/threads/${encodeURIComponent(data.crisis_thread.id)}`,
        'GET',
      );
      if (response.ok && (await resumeFrom(full))) {
        if (data.reply && data.reply.text && !document.querySelector(`[data-id="${data.reply.id}"]`))
          addMessage('assistant', data.reply.text, data.reply.ai_generated, data.reply.id);
        const field_ = field();
        if (field_) field_.value = '';
        return true;
      }
    }
    if (!(await mount(data.crisis_thread.id, data.crisis_thread))) return false;
    if (sentText && sentText.trim()) addMessage('user', sentText);
    if (data.reply && data.reply.text) addMessage('assistant', data.reply.text, data.reply.ai_generated, data.reply.id);
    const input = field();
    if (input) input.value = '';
    return true;
  }

  // Возврат на страницу: GET /api/v1/ai/threads/:id для треда режима crisis (вызывает patient_chat.js).
  async function resumeFrom(data) {
    if (!data || !data.thread || data.thread.mode !== 'crisis') return false;
    if (!(await mount(data.thread.id, data.thread.crisis))) return false;
    (data.messages || []).forEach((m) => {
      if (m.role === 'user' || m.role === 'assistant') addMessage(m.role, m.text, m.ai_generated, m.id);
    });
    const list = data.messages || [];
    if (list.some((m) => m.role === 'user' && QUICK_TEXTS.includes(String(m.text).trim()))) hideQuick();
    const firstReply = list.findIndex((m) => m.role === 'assistant');
    if (firstReply >= 0 && list.slice(firstReply).some((m) => m.role === 'user')) collapsePin();
    return true;
  }

  // Страница открыта без адреса треда (или с другим): если кризисный разговор ещё идёт, возвращаем в него.
  // Список тредов отдаёт режим и состояние сигнала; сервер и без этого направит новое сообщение в кризисный тред.
  async function restoreActive() {
    if (threadId) return true;
    try {
      const { response, data } = await call('/api/v1/ai/threads?purpose=patient_assistant', 'GET');
      if (!response.ok) return false;
      const live = (data.items || []).find(
        (t) => t.mode === 'crisis' && t.crisis && ['new', 'in_work'].includes(t.crisis.status),
      );
      if (!live) return false;
      const full = await call(`/api/v1/ai/threads/${encodeURIComponent(live.id)}`, 'GET');
      return full.response.ok ? await resumeFrom(full.data) : false;
    } catch (_) {
      return false;
    }
  }

  async function sendText(text) {
    const value = String(text || '').trim();
    if (!value || !threadId || sending) return;
    sending = true;
    addMessage('user', value);
    collapsePin();
    // Пока модель отвечает, видно, что сообщение дошло и ответ готовится (этапы приходят с сервера).
    const progressId = crypto.randomUUID();
    const stopProgress =
      (window.PatientChat &&
        window.PatientChat.trackProgress &&
        window.PatientChat.trackProgress(progressId, {
          before: feed() && feed().querySelector('[data-crisis-quick]'),
        })) ||
      (() => {});
    try {
      const { response, data } = await call('/api/v1/ai/patient/messages', 'POST', {
        text: value,
        thread_id: threadId,
        progress_id: progressId,
      });
      stopProgress();
      if (response.ok && data.reply && data.reply.text) {
        addMessage('assistant', data.reply.text, data.reply.ai_generated, data.reply.id);
        if (data.crisis_thread) setStatus(data.crisis_thread);
      } else {
        // Карточка 112 закреплена; разговор можно продолжить повторной отправкой.
        addMessage(
          'assistant',
          T('msg.crisis.chat.retry', 'Не получилось ответить. 112 наверху экрана. Попробуй написать ещё раз.'),
        );
      }
    } catch (_) {
      stopProgress();
      addMessage(
        'assistant',
        T('msg.crisis.chat.retry', 'Не получилось ответить. 112 наверху экрана. Попробуй написать ещё раз.'),
      );
    } finally {
      stopProgress();
      sending = false;
    }
  }

  async function submit(input) {
    const value = input ? input.value : '';
    if (input) input.value = '';
    await sendText(value);
  }

  // Кнопка «Поговорить сейчас» (страница справки): сигнал врачу + переход в кризисный тред.
  async function talkNow(button) {
    button.disabled = true;
    try {
      const { response, data } = await call('/api/v1/crisis/help', 'POST', { source: 'button', text: '' });
      if (response.ok && data.crisis_chat && data.crisis_chat.thread_id) {
        window.location.href = `/app?tab=chat&thread=${encodeURIComponent(data.crisis_chat.thread_id)}`;
        return;
      }
      window.location.href = '/app?tab=chat';
    } catch (_) {
      button.disabled = false;
    }
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-crisis-talk]');
    if (button) talkNow(button);
  });

  window.PatientCrisis = { active: () => Boolean(threadId), enter, resumeFrom, restoreActive, submit };
})();
