/* ai-workspace: прогрессивное улучшение ИИ-пространства врача. Без этого скрипта всё работает обычными формами. */
(function () {
  'use strict';

  // ---- предпросмотр материала: снятие замены сразу видно в блоке «после» ----
  Array.prototype.forEach.call(document.querySelectorAll('.ws-keep'), function (cb) {
    cb.addEventListener('change', function () {
      var span = document.getElementById(cb.getAttribute('data-rep'));
      if (!span) return;
      span.textContent = cb.checked ? span.getAttribute('data-orig') : span.getAttribute('data-label');
      span.classList.toggle('is-kept', cb.checked);
    });
  });

  var attachEl = document.getElementById('ws-attach');
  var chat = window.aiChat;
  if (!chat) return;
  var root = chat.root;
  var input = chat.input;

  // после первого сообщения панель сценариев сворачивается в одну строку
  var scn = document.getElementById('ws-scenarios');
  var logEl = document.getElementById('ai-log');
  if (scn && logEl && window.MutationObserver) {
    new MutationObserver(function () { if (logEl.querySelector('.msg')) scn.classList.add('is-compact'); }).observe(logEl, { childList: true });
  }

  // ---- копирование ответа ----
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.ws-copy') : null;
    if (!btn) return;
    var body = btn.closest('.msg__body');
    var textEl = body && body.querySelector('.msg__text');
    if (!textEl) return;
    var text = textEl.textContent;
    var note = btn.parentNode.querySelector('.ws-copied');
    var done = function (ok) {
      if (note) { note.textContent = ok ? 'Скопировано' : 'Не удалось скопировать — выделите текст вручную'; setTimeout(function () { note.textContent = ''; }, 2500); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(); });
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      document.body.removeChild(ta);
      done(ok);
    }
  });

  // ---- сценарии: отправка без перезагрузки ----
  Array.prototype.forEach.call(document.querySelectorAll('.ws-scn-form'), function (f) {
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var sel = f.querySelector('select[name="period"]');
      var extra = { scenario: f.getAttribute('data-scenario'), label: f.querySelector('.ws-scn').firstChild.textContent.trim() };
      if (sel && sel.value) { extra.period = sel.value; extra.label += ' (' + sel.options[sel.selectedIndex].text + ')'; }
      chat.send('', extra);
    });
  });

  // ---- детектор ПДн во вводе (REQ-AID-018) ----
  var panel = document.getElementById('ws-pii');
  var decided = null; // текст, по которому врач уже принял решение (или ПДн не найдены)
  var checking = false;

  function fill(box, segs, masked) {
    box.textContent = '';
    segs.forEach(function (s) {
      if (s.label) {
        var n = document.createElement(masked ? 'span' : 'mark');
        n.textContent = masked ? s.label : s.t;
        if (masked) n.className = 'ws-rep';
        box.appendChild(n);
      } else box.appendChild(document.createTextNode(s.t));
    });
  }

  function detect(text) {
    return fetch(chat.root.getAttribute('data-base') + '/pii/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Accept: 'application/json' },
      body: JSON.stringify({ text: text }),
      credentials: 'same-origin',
    }).then(function (r) { if (!r.ok) throw new Error('detect'); return r.json(); });
  }

  function hidePanel() { if (panel) panel.hidden = true; }

  function run(text, onClean) {
    if (!panel || checking) return;
    checking = true;
    detect(text).then(function (d) {
      checking = false;
      if (input.value !== text) return; // текст уже изменился
      if (!d.count) { decided = text; hidePanel(); if (onClean) onClean(); return; }
      document.getElementById('ws-pii-types').textContent = d.types.join(', ');
      fill(document.getElementById('ws-pii-before'), d.segments, false);
      fill(document.getElementById('ws-pii-after'), d.segments, true);
      panel.hidden = false;
      panel.dataset.masked = d.masked;
      panel.dataset.orig = text;
    }).catch(function () { checking = false; decided = text; if (onClean) onClean(); });
  }

  if (panel) {
    input.addEventListener('paste', function () {
      setTimeout(function () { if (input.value.trim()) { decided = null; run(input.value); } }, 0);
    });
    input.addEventListener('input', function () { if (!panel.hidden && input.value !== panel.dataset.orig) hidePanel(); });
    document.getElementById('ws-pii-yes').addEventListener('click', function () {
      input.value = panel.dataset.masked;
      decided = input.value;
      hidePanel(); chat.autosize(); input.focus();
    });
    document.getElementById('ws-pii-no').addEventListener('click', function () {
      decided = panel.dataset.orig;
      hidePanel(); input.focus();
    });
    // перед отправкой свободного текста: если он ещё не проверен — проверяем и останавливаем отправку
    chat.api.beforeSend = function (text, extra) {
      if (extra && extra.scenario) return true;
      if (decided === text) return true;
      run(text, function () { chat.send(text, extra); });
      return false;
    };
  }

  // открытая форма прикрепления сразу показывается целиком
  if (attachEl) attachEl.addEventListener('toggle', function () { if (attachEl.open) attachEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });

  // ---- перетаскивание файлов на область диалога ----
  var main = root.querySelector('.ai-main');
  var files = document.getElementById('ws-files');
  var attach = attachEl;
  if (main && files && attach && window.DataTransfer) {
    ['dragenter', 'dragover'].forEach(function (ev) {
      main.addEventListener(ev, function (e) {
        if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) { e.preventDefault(); main.classList.add('is-drop'); }
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      main.addEventListener(ev, function () { main.classList.remove('is-drop'); });
    });
    main.addEventListener('drop', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      files.files = e.dataTransfer.files;
      attach.open = true;
      attach.scrollIntoView({ block: 'nearest' });
      files.focus();
    });
  }
})();
