// Карточка пациента клинициста: прогрессивное улучшение. Без JS всё работает: поля видны целиком с подписями.
(function () {
  'use strict';

  // Форма ввода результата: показываем только поля выбранной методики.
  var LEGACY = ['phq9', 'gad7', 'who5', 'bdi2', 'hads', 'stai', 'mmpi'];
  var form = document.querySelector('form.pc-entry');
  if (form) {
    form.classList.add('js');
    var groups = form.querySelectorAll('.pc-fields');
    var update = function () {
      var checked = form.querySelector('input[name="instrument"]:checked');
      var code = checked ? checked.value : '';
      var key = !code ? '' : LEGACY.indexOf(code) >= 0 ? code : 'protocol';
      groups.forEach(function (g) {
        var codes = (g.getAttribute('data-for') || '').split(' ');
        g.hidden = !key || codes.indexOf(key) < 0;
      });
    };
    form.addEventListener('change', update);
    update();
  }

  // Справка «К приёму»: печать и копирование (кнопки видны только при JS).
  var print = document.getElementById('pc-print');
  if (print) { print.hidden = false; print.addEventListener('click', function () { window.print(); }); }
  var copy = document.getElementById('pc-copy');
  if (copy) {
    copy.hidden = false;
    copy.addEventListener('click', function () {
      var ta = document.getElementById(copy.getAttribute('data-target'));
      var status = document.getElementById('pc-copy-status');
      if (!ta) return;
      var done = function (ok) { if (status) status.textContent = ok ? 'Скопировано.' : 'Не удалось скопировать: выделите текст вручную.'; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(ta.value).then(function () { done(true); }, function () { done(false); });
      } else {
        ta.select();
        try { done(document.execCommand('copy')); } catch (e) { done(false); }
      }
    });
  }
})();
