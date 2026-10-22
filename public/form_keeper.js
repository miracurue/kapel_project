// W3.K (N2): ввод формы не теряется при истёкшей сессии. Снимок текстовых полей хранится в sessionStorage этой вкладки
// (закрыли вкладку — стёрт; пароли и скрытые поля не сохраняются). После повторного входа на той же странице предлагается восстановить.
(function () {
  'use strict';
  var KEY = 'cc_form_keep';
  var TTL = 2 * 3600 * 1000;
  var store = null;
  try { store = window.sessionStorage; } catch (e) { store = null; }
  if (!store) return;
  function read() { try { return JSON.parse(store.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function write(s) { try { store.setItem(KEY, JSON.stringify(s)); } catch (e) { /* хранилище недоступно */ } }
  function clear() { try { store.removeItem(KEY); } catch (e) { /* ничего */ } }

  var snap = read();
  if (snap && Date.now() - snap.at > TTL) { clear(); snap = null; }

  // страница входа/«сессия истекла»: отмечаем, что отправка или ввод не дошли до сервера
  if (document.querySelector('[data-session-lost]')) {
    if (snap) { snap.lost = true; write(snap); }
    return;
  }
  var path = location.pathname;
  if (snap && snap.path === path && !snap.lost && snap.submitted) { clear(); snap = null; } // отправка прошла успешно
  if (snap && snap.path === path && snap.lost) offer(snap);

  function offer(s) {
    var main = document.getElementById('main-content') || document.body;
    var box = document.createElement('div');
    box.className = 'flash flash-info';
    box.setAttribute('role', 'status');
    box.setAttribute('data-restore-offer', '');
    var p = document.createElement('p');
    p.textContent = 'Сессия истекла, пока вы вводили текст. Он сохранён на этом устройстве в этой вкладке. Восстановить введённое?';
    var yes = document.createElement('button');
    yes.type = 'button';
    yes.textContent = 'Восстановить';
    var no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn-secondary';
    no.textContent = 'Отбросить';
    yes.addEventListener('click', function () {
      var forms = document.querySelectorAll('form');
      Object.keys(s.fields).forEach(function (k) {
        var i = k.indexOf(':');
        var f = forms[Number(k.slice(0, i))];
        var el = f && f.elements[k.slice(i + 1)];
        if (el && !el.length && !el.value) { el.value = s.fields[k]; el.dispatchEvent(new Event('input', { bubbles: true })); }
      });
      clear();
      box.remove();
    });
    no.addEventListener('click', function () { clear(); box.remove(); });
    box.appendChild(p);
    box.appendChild(yes);
    box.appendChild(document.createTextNode(' '));
    box.appendChild(no);
    main.insertBefore(box, main.firstChild);
  }

  function skip(el) {
    var t = (el.type || '').toLowerCase();
    return !el.name || el.name === '_csrf' || ['password', 'hidden', 'file', 'checkbox', 'radio', 'submit', 'button'].indexOf(t) >= 0;
  }
  function capture(form) {
    var forms = Array.prototype.slice.call(document.querySelectorAll('form'));
    var idx = forms.indexOf(form);
    var cur = read();
    var s = cur && cur.path === path && !cur.lost ? cur : { path: path, fields: {} };
    s.at = Date.now();
    s.submitted = false;
    Array.prototype.forEach.call(form.elements, function (el) {
      if (skip(el)) return;
      var key = idx + ':' + el.name;
      if (el.value) s.fields[key] = el.value; else delete s.fields[key];
    });
    if (Object.keys(s.fields).length) write(s); else clear();
  }
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (!el || !el.form || skip(el) || String(el.form.method).toLowerCase() !== 'post') return;
    capture(el.form);
  });
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || String(form.method).toLowerCase() !== 'post') return;
    var s = read();
    if (s && s.path === path) { s.submitted = true; s.at = Date.now(); write(s); }
  });
})();
