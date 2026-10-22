/* ИИ-чат: прогрессивное улучшение. Без этого скрипта все действия работают обычными формами. */
(function () {
  'use strict';
  var root = document.getElementById('ai-chat');
  if (!root) return;
  root.classList.add('js');
  // анимацию панели включаем только после первой отрисовки, чтобы она не «въезжала» при загрузке
  requestAnimationFrame(function () { requestAnimationFrame(function () { root.classList.add('is-ready'); }); });

  var base = root.getAttribute('data-base');
  var max = Number(root.getAttribute('data-max')) || 2000;
  var log = document.getElementById('ai-log');
  var form = document.getElementById('ai-form');
  var input = document.getElementById('ai-input');
  var sendBtn = document.getElementById('ai-send');
  var count = document.getElementById('ai-count');
  var typing = document.getElementById('ai-typing');
  var stopBtn = document.getElementById('ai-stop');
  var errBox = document.getElementById('ai-error');
  var side = document.getElementById('ai-side');
  var toggle = document.getElementById('ai-side-toggle');
  var threadInput = form.querySelector('input[name="thread_id"]');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var busy = false;
  var stopped = false;

  // --- выдвижная панель диалогов (мобильный) ---
  if (toggle) {
    var closeBtn = document.getElementById('ai-side-close');
    toggle.hidden = false;
    if (closeBtn) closeBtn.hidden = false;
    var setOpen = function (open) {
      root.classList.toggle('is-side-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    toggle.addEventListener('click', function () { setOpen(!root.classList.contains('is-side-open')); });
    if (closeBtn) closeBtn.addEventListener('click', function () { setOpen(false); toggle.focus(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && root.classList.contains('is-side-open')) { setOpen(false); toggle.focus(); }
    });
    // тап вне панели закрывает её
    document.addEventListener('click', function (e) {
      if (root.classList.contains('is-side-open') && !side.contains(e.target) && e.target !== toggle) setOpen(false);
    });
  }

  // --- поле ввода: автовысота, счётчик, Enter ---
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight + 2, 160) + 'px';
    var n = input.value.length;
    count.textContent = String(n);
    count.parentNode.classList.toggle('is-over', n > max);
  }
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (input.value.trim()) form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });
  autosize();
  if (log.querySelector('.msg')) scrollEnd();

  function scrollEnd() { log.scrollTop = log.scrollHeight; }

  function showError(msg) {
    if (!errBox) return;
    errBox.textContent = msg || '';
    errBox.hidden = !msg;
  }

  // --- построение сообщений ---
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function addMessage(m) {
    var empty = document.getElementById('ai-empty');
    if (empty) empty.remove();
    var row = el('div', 'msg msg-' + m.role + ' msg-kind-' + m.kind);
    row.setAttribute('data-id', m.id);
    if (m.role === 'assistant') {
      var pill = el('span', 'ai-pill', 'ИИ');
      pill.title = 'Ответ ИИ-помощника';
      row.appendChild(pill);
    }
    var body = el('div', 'msg__body');
    var text = el('div', 'msg__text', m.text);
    body.appendChild(text);
    row.appendChild(body);
    var end = document.getElementById('end');
    log.insertBefore(row, end);
    scrollEnd();
    return { row: row, body: body, text: text };
  }

  function addCrisisBlock(body) {
    var box = el('div', 'ai-crisis');
    var a = el('a', 'ai-crisis__tel', '112 — экстренные службы');
    a.href = 'tel:112';
    box.appendChild(a);
    box.appendChild(el('span', null, 'Звонок бесплатный. Если опасность прямо сейчас, не ждите ответа.'));
    body.appendChild(box);
  }

  function addRetry(body, threadId) {
    var b = el('button', 'ai-retry', 'Повторить');
    b.type = 'button';
    b.addEventListener('click', function () { retry(threadId, body.parentNode); });
    body.appendChild(b);
  }

  // --- потоковая печать с «Стоп» ---
  function reveal(msg, node, done) {
    var full = msg.text;
    if (reduceMotion || msg.kind === 'crisis' || msg.kind === 'error' || full.length < 2) { node.text.textContent = full; done(full.length, false); return; }
    var i = 0;
    var step = Math.max(1, Math.round(full.length / 120));
    stopped = false;
    stopBtn.hidden = false;
    node.text.textContent = '';
    (function tick() {
      if (stopped) { stopBtn.hidden = true; done(i, true); return; }
      i = Math.min(full.length, i + step);
      node.text.textContent = full.slice(0, i);
      scrollEnd();
      if (i >= full.length) { stopBtn.hidden = true; done(i, false); return; }
      setTimeout(tick, 18);
    })();
  }
  stopBtn.addEventListener('click', function () { stopped = true; });

  // Точка расширения для ИИ-пространства врача (public/workspace.js); у чата пациента не используется.
  var api = { beforeSend: null, extra: null, afterAssistant: null };
  window.aiChat = { root: root, input: input, send: function (text, extra) { return send(text, extra); }, api: api, autosize: autosize };

  function post(url, params) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      credentials: 'same-origin',
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); });
  }

  function setBusy(v) {
    busy = v;
    sendBtn.disabled = v;
    typing.hidden = !v && stopBtn.hidden;
    typing.querySelector('.ai-dots').style.display = v ? '' : 'none';
  }

  function finishAssistant(data, threadId) {
    var a = data.assistant;
    var node = addMessage({ id: a.id, role: 'assistant', kind: a.kind, text: a.text });
    typing.hidden = false;
    setBusy(false);
    typing.querySelector('.ai-dots').style.display = 'none';
    reveal(a, node, function (shown, wasStopped) {
      typing.hidden = true;
      if (a.kind === 'crisis') addCrisisBlock(node.body);
      if (a.kind === 'error') addRetry(node.body, threadId);
      if (data.extras) node.body.insertAdjacentHTML('beforeend', data.extras);
      if (wasStopped && shown < a.text.length) {
        node.text.textContent = a.text.slice(0, shown).trimEnd() + ' …';
        post(base + '/m/' + a.id + '/stop', { len: shown });
      }
      scrollEnd();
      input.focus();
    });
  }

  function adoptThread(t) {
    if (!t) return;
    threadInput.value = t.id;
    Array.prototype.forEach.call(root.querySelectorAll('input[name="thread_id"]'), function (n) { n.value = t.id; });
    root.setAttribute('data-thread-id', t.id);
    if (location.pathname !== t.url) history.replaceState(null, '', t.url);
    var list = document.getElementById('ai-threads');
    if (!list) {
      list = el('ul', 'ai-threads');
      list.id = 'ai-threads';
      var emptyNote = side.querySelector('.ai-side__empty');
      if (emptyNote) emptyNote.remove();
      side.appendChild(list);
    }
    var existing = list.querySelector('a[href="' + t.url + '"]');
    if (!existing) {
      var li = el('li');
      var a = el('a', 'ai-thread', t.title);
      a.href = t.url;
      li.appendChild(a);
      list.insertBefore(li, list.firstChild);
      existing = a;
    }
    // авто-название по первому сообщению: обновляем заголовок и пункт списка без перезагрузки
    var head = document.querySelector('.ai-head__title strong');
    if (head && t.title) head.textContent = t.title;
    if (existing && t.title && existing.firstChild && existing.firstChild.nodeType === 3) existing.firstChild.textContent = t.title;
    list.querySelectorAll('.ai-thread').forEach(function (n) { n.classList.remove('is-active'); n.removeAttribute('aria-current'); });
    existing.classList.add('is-active');
    existing.setAttribute('aria-current', 'page');
  }

  function send(text, extra) {
    if (busy) return;
    showError('');
    if (!text.trim() && !(extra && extra.scenario)) { showError('Напишите сообщение, прежде чем отправлять.'); return; }
    if (api.beforeSend && api.beforeSend(text, extra) === false) return;
    if (text.length > max) { showError('Сообщение длиннее ' + max + ' символов. Сократите его или разделите на части — введённый текст не потерян.'); return; }
    setBusy(true);
    typing.hidden = false;
    var pending = addMessage({ id: '', role: 'user', kind: 'normal', text: (extra && extra.label) || text });
    var params = { thread_id: threadInput.value, text: text };
    if (extra) Object.keys(extra).forEach(function (k) { if (k !== 'label') params[k] = extra[k]; });
    post(base + '/send', params).then(function (res) {
      if (res.status !== 200) {
        pending.row.remove();
        showError(res.json.error || 'Не удалось отправить. Попробуйте ещё раз — текст сохранён в поле ввода.');
        if (!(extra && extra.scenario)) { input.value = text; autosize(); }
        setBusy(false); typing.hidden = true;
        return;
      }
      if (!(extra && extra.scenario)) { input.value = ''; autosize(); }
      pending.row.setAttribute('data-id', res.json.user.id);
      adoptThread(res.json.thread);
      finishAssistant(res.json, res.json.thread.id);
    }).catch(function () {
      pending.row.remove();
      showError('Нет связи с сервером. Текст сохранён в поле ввода — отправьте ещё раз.');
      if (!(extra && extra.scenario)) { input.value = text; autosize(); }
      setBusy(false); typing.hidden = true;
    });
  }

  function retry(threadId, row) {
    if (busy) return;
    setBusy(true); typing.hidden = false;
    post(base + '/t/' + threadId + '/retry', {}).then(function (res) {
      if (res.status !== 200) { showError(res.json.error || 'Не удалось повторить.'); setBusy(false); typing.hidden = true; return; }
      if (row) row.remove();
      if (res.json.assistant) finishAssistant({ assistant: res.json.assistant, extras: res.json.extras }, threadId); else setBusy(false);
    }).catch(function () { showError('Нет связи с сервером.'); setBusy(false); typing.hidden = true; });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    send(input.value);
  });

  // подсказки-старты: подставить и отправить без перезагрузки
  Array.prototype.forEach.call(document.querySelectorAll('.ai-chip-form'), function (f) {
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      send(f.querySelector('input[name="text"]').value);
    });
  });

  // «Повторить» на уже отрисованном сервером сообщении-ошибке
  Array.prototype.forEach.call(document.querySelectorAll('.ai-retry-form'), function (f) {
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var m = f.action.match(/\/t\/(\d+)\/retry/);
      if (m) retry(m[1], f.closest('.msg'));
    });
  });
})();
