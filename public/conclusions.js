// Заключения и протоколы психолога: автосохранение и секундомер. Без JS всё работает обычными формами.
(function () {
  'use strict';

  function fmtTime(d) { return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

  document.querySelectorAll('form[data-autosave]').forEach(function (form) {
    var url = form.getAttribute('data-autosave');
    var state = form.querySelector('.concl-state') || document.getElementById('autosave-state');
    var timer = null;
    var busy = false;
    var dirty = false;
    function say(t) { if (state) state.textContent = t; }
    function save() {
      if (busy) { dirty = true; return; }
      busy = true; dirty = false;
      var body = new URLSearchParams(new FormData(form));
      fetch(url, { method: 'POST', body: body, headers: { 'X-Requested-With': 'fetch', 'Accept': 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.json().then(function (j) { return { r: r, j: j }; }); })
        .then(function (x) {
          if (x.r.ok && x.j.ok) {
            say('Сохранено автоматически в ' + fmtTime(new Date()));
            var p = document.getElementById('exam-progress');
            if (p && x.j.progress) p.textContent = 'внесено ' + x.j.progress.entered + ' из ' + x.j.progress.total;
          } else { say(x.j.message || 'Не удалось сохранить автоматически. Нажмите «Сохранить».'); }
        })
        .catch(function () { say('Нет связи: нажмите «Сохранить», когда она появится.'); })
        .then(function () { busy = false; if (dirty) save(); });
    }
    form.addEventListener('input', function () {
      say('Есть несохранённые изменения…');
      clearTimeout(timer);
      timer = setTimeout(save, 1200);
    });
  });

  // секундомер и счётчик ошибок: необязательные помощники
  document.querySelectorAll('.concl-proto-form').forEach(function (form) {
    var box = form.querySelector('[data-timer]');
    if (box) {
      box.hidden = false;
      var out = box.querySelector('[data-timer-out]');
      var hidden = form.querySelector('input[name="timer_sec"]');
      var total = Number(hidden.value) || 0;
      var startedAt = null;
      var tick = null;
      var show = function () { var cur = total + (startedAt ? (Date.now() - startedAt) / 1000 : 0); out.textContent = cur.toFixed(0); return cur; };
      show();
      box.querySelector('[data-timer-start]').addEventListener('click', function () {
        if (startedAt) return;
        startedAt = Date.now();
        tick = setInterval(show, 250);
      });
      box.querySelector('[data-timer-stop]').addEventListener('click', function () {
        if (!startedAt) return;
        total += (Date.now() - startedAt) / 1000; startedAt = null; clearInterval(tick); show();
        hidden.value = total.toFixed(0);
        hidden.dispatchEvent(new Event('input', { bubbles: true }));
      });
      box.querySelector('[data-timer-apply]').addEventListener('click', function () {
        var f = form.querySelector('input[name="duration_sec"]');
        f.value = show().toFixed(0);
        f.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    var inc = form.querySelector('[data-inc="errors"]');
    if (inc) {
      inc.hidden = false;
      inc.addEventListener('click', function () {
        var f = form.querySelector('input[name="errors"]');
        f.value = (Number(f.value) || 0) + 1;
        f.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
  });
})();
