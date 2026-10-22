// W2.F: прогрессивное улучшение. Без JS всё работает; кнопка печати видна только при JS.
(function () {
  'use strict';
  var p = document.getElementById('care-print');
  if (p) { p.hidden = false; p.addEventListener('click', function () { window.print(); }); }
})();
