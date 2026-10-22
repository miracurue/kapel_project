/* Прогрессивные улучшения кабинета пациента. Без JS всё работает (формы, PRG);
 * здесь только удобство: блок поддержки на критическом пункте, автосохранение
 * черновиков при потере сети, защита от двойного нажатия. Внешних запросов нет. */
(function () {
  'use strict';

  function store() {
    try { return window.localStorage; } catch (e) { return null; }
  }
  var ls = store();
  function get(k) { try { return ls ? ls.getItem(k) : null; } catch (e) { return null; } }
  function set(k, v) { try { if (ls) ls.setItem(k, v); } catch (e) { /* хранилище недоступно */ } }
  function del(k) { try { if (ls) ls.removeItem(k); } catch (e) { /* ничего */ } }

  // 1) Критический пункт: показать блок поддержки сразу при ненулевом ответе (REQ-PAT-009)
  document.querySelectorAll('form[data-critical]').forEach(function (form) {
    var block = document.getElementById('inline-support');
    if (!block) return;
    form.addEventListener('change', function (e) {
      if (e.target && e.target.name === 'value') block.hidden = !(Number(e.target.value) > 0);
    });
    var checked = form.querySelector('input[name="value"]:checked');
    if (checked && Number(checked.value) > 0) block.hidden = false;
  });

  // 2) Автоотправка переключателей и выбора теста
  document.querySelectorAll('form[data-autosubmit-form] input[type="checkbox"]').forEach(function (cb) {
    cb.addEventListener('change', function () { cb.form.submit(); });
  });
  document.querySelectorAll('select[data-autosubmit]').forEach(function (sel) {
    sel.addEventListener('change', function () { sel.form.submit(); });
  });

  // 3) Защита от двойной отправки
  document.querySelectorAll('form').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (e.defaultPrevented) return;
      if (form.dataset.sending === '1') { e.preventDefault(); return; }
      form.dataset.sending = '1';
      form.querySelectorAll('button[type="submit"]').forEach(function (b) { b.setAttribute('aria-busy', 'true'); });
      window.setTimeout(function () { form.dataset.sending = ''; form.querySelectorAll('button[type="submit"]').forEach(function (b) { b.removeAttribute('aria-busy'); }); }, 4000);
    });
  });

  // 4) Черновики текстовых полей и поведение без сети (REQ-PAT-021, NFR-013)
  document.querySelectorAll('[data-clear-draft]').forEach(function (el) {
    var k = 'cc_draft_' + el.getAttribute('data-clear-draft');
    del(k); del(k + '_sent');
  });
  var hasError =!!document.querySelector('[data-form-error]');
  document.querySelectorAll('[data-draft-key]').forEach(function (field) {
    var key = 'cc_draft_' + field.getAttribute('data-draft-key');
    var sentKey = key + '_sent';
    var form = field.form;
    if (get(sentKey) === '1') {
      del(sentKey);
      if (!hasError) del(key);
    }
    var saved = get(key);
    if (saved && !field.value) field.value = saved;
    field.addEventListener('input', function () { set(key, field.value); });
    if (!form) return;
    var note = document.createElement('p');
    note.className = 'offline-note';
    note.setAttribute('role', 'alert');
    note.hidden = true;
    note.textContent = 'Не отправлено: нет соединения. Текст сохранён на этом устройстве, нажмите «Отправить» ещё раз, когда сеть появится.';
    form.appendChild(note);
    form.addEventListener('submit', function (e) {
      if (navigator.onLine === false) {
        e.preventDefault();
        form.dataset.sending = '';
        note.hidden = false;
        set(key, field.value);
        return;
      }
      note.hidden = true;
      set(sentKey, '1');
    });
    window.addEventListener('online', function () { note.hidden = true; });
  });
})();
