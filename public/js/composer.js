'use strict';

/**
 * Композер (F-12, F-13, F-29) — клиентская логика чипов и подсказок.
 *
 *  - подсказки (до трёх) из GET /api/v1/context/suggestions: клик добавляет
 *    чип в поле, «×» возвращает подсказку в строку;
 *  - «@» и «+ → Из моих данных» — поиск GET /api/v1/context/search (до 20);
 *  - «✦ Спросить ИИ» — GET /api/v1/ai/questions, до 4 готовых вопросов,
 *    «Мне хуже» всегда среди них;
 *  - чипы уходят с сообщением в body.chips; сервер заново проверяет каждую
 *    ссылку (F-13): при 409 E-CONTEXT-REJECTED текст остаётся в поле,
 *    отклонённые чипы убираются со строкой «… больше недоступно — убрано».
 *
 * Тексты — только ключами словаря (data-testid = ключ), значения из
 * window.TEXTS. Содержимого объектов в клиент не передаётся — только ссылки
 * {тип, ID, версия} и подписи.
 */

(function () {
  const tid = (key) => `[data-testid="${key}"]`;
  const texts = window.TEXTS || {};

  function stateFor(root) {
    return { root, chips: [], suggestions: [] };
  }

  function labelOf(chip) {
    return chip.label || texts['msg.composer.label.object'] || 'Объект';
  }

  function note(st, text) {
    let el = st.root.querySelector(tid('msg.composer.chips.note'));
    if (!el) {
      el = document.createElement('p');
      el.dataset.testid = 'msg.composer.chips.note';
      st.root.appendChild(el);
    }
    el.textContent = text;
    el.hidden = !text;
  }

  function renderChips(st) {
    const box = st.root.querySelector('[data-chips]');
    if (!box) return;
    box.innerHTML = '';
    st.chips.forEach((chip, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.dataset.testid = 'msg.composer.chip';
      el.dataset.type = chip.type;
      el.dataset.id = String(chip.id);
      el.textContent = labelOf(chip);
      const remove = document.createElement('span');
      remove.dataset.testid = 'msg.composer.chip.remove';
      remove.setAttribute('aria-label', (texts['msg.composer.chip.remove'] || 'Убрать «{label}»').replace('{label}', labelOf(chip)));
      remove.textContent = '×';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        st.chips.splice(i, 1);
        renderChips(st);
        renderSuggestions(st);
      });
      el.appendChild(remove);
      box.appendChild(el);
    });
  }

  function renderSuggestions(st) {
    const row = st.root.querySelector(tid('msg.composer.suggestions'));
    if (!row) return;
    row.innerHTML = '';
    st.suggestions.forEach((sug) => {
      const used = st.chips.some((c) => c.type === sug.chip.type && String(c.id) === String(sug.chip.id));
      if (used) return; // подсказка ушла из строки: она стала чипом
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.testid = 'msg.composer.suggestion';
      btn.textContent = sug.label;
      btn.addEventListener('click', () => {
        if (st.chips.length >= 5) {
          note(st, texts['msg.composer.chips.max'] || 'Не больше пяти чипов в одном сообщении');
          return;
        }
        st.chips.push(sug.chip);
        renderChips(st);
        renderSuggestions(st);
      });
      row.appendChild(btn);
    });
  }

  async function fetchJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { status: res.status, body: null };
    return { status: res.status, body: await res.json() };
  }

  async function loadSuggestions(st) {
    const { status, body } = await fetchJson('/api/v1/context/suggestions');
    if (status !== 200 || !body) return;
    st.suggestions = body.items || [];
    renderSuggestions(st);
  }

  // «✦ Спросить ИИ» у объекта: новый чат с чипом и готовыми вопросами.
  async function askAi(st, type, id) {
    const { status, body } = await fetchJson(`/api/v1/ai/questions?object_type=${encodeURIComponent(type)}&object_id=${encodeURIComponent(id)}`);
    if (status !== 200 || !body) return;
    if (body.chip && st.chips.length < 5) {
      st.chips.push(body.chip);
      renderChips(st);
      renderSuggestions(st);
    }
    const row = st.root.querySelector('[data-questions]');
    if (!row) return;
    row.innerHTML = '';
    body.questions.forEach((question) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = question;
      btn.addEventListener('click', () => {
        if (question === (texts['msg.ask.worse'] || 'Мне хуже')) {
          worseFlow(st);
          return;
        }
        const field = st.root.querySelector(tid('msg.chat.placeholder'));
        if (field) field.value = question;
      });
      row.appendChild(btn);
    });
  }

  // «Мне хуже»: сначала два вопроса безопасности кнопками; «Да» — кризисная
  // карточка без вызова модели (F-29, путь кризиса через crisisGate).
  function worseFlow(st) {
    const row = st.root.querySelector('[data-questions]');
    if (!row) return;
    const q1 = texts['msg.chat.worse.q1'] || '';
    row.innerHTML = '';
    const p1 = document.createElement('p');
    p1.dataset.testid = 'msg.chat.worse.q1';
    p1.textContent = q1;
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.dataset.testid = 'msg.chat.worse.q1.yes';
    yes.textContent = texts['msg.chat.worse.q1.yes'] || 'Да';
    const no = document.createElement('button');
    no.type = 'button';
    no.dataset.testid = 'msg.chat.worse.q1.no';
    no.textContent = texts['msg.chat.worse.q1.no'] || 'Нет';
    yes.addEventListener('click', () => showCrisisCard(st));
    no.addEventListener('click', () => { row.innerHTML = ''; note(st, texts['msg.chat.worse.after'] || ''); });
    row.append(p1, yes, no);
  }

  function showCrisisCard(st) {
    if (st.root.querySelector(tid('msg.crisis.card.title'))) return;
    const card = document.createElement('div');
    card.dataset.testid = 'msg.crisis.card';
    const title = document.createElement('p');
    title.dataset.testid = 'msg.crisis.card.title';
    title.textContent = texts['msg.crisis.card.title'] || '';
    const call = document.createElement('a');
    call.dataset.testid = 'msg.crisis.card.call';
    call.href = 'tel:112';
    call.textContent = texts['msg.crisis.card.call'] || '112';
    const write = document.createElement('a');
    write.dataset.testid = 'msg.crisis.card.write';
    write.href = '?tab=doctor';
    write.textContent = texts['msg.crisis.card.write'] || '';
    const who = document.createElement('p');
    who.dataset.testid = 'msg.crisis.card.who_sees';
    who.textContent = texts['msg.crisis.card.who_sees'] || '';
    card.append(title, call, write, who);
    st.root.appendChild(card);
  }

  function init() {
    const roots = document.querySelectorAll('[data-composer]');
    roots.forEach((root) => {
      const st = stateFor(root);
      root._composer = st;
      loadSuggestions(st);
      document.querySelectorAll(tid('msg.ask.star')).forEach((star) => {
        star.addEventListener('click', () => askAi(st, star.dataset.objectType || '', star.dataset.objectId || ''));
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
