// W2.G: прогрессивное улучшение страниц /tools: копирование и печать (без JS всё работает, кнопки скрыты).
(function () {
  function wire(btnId, srcId, statusId) {
    var b = document.getElementById(btnId);
    var src = document.getElementById(srcId);
    if (!b || !src) return;
    b.hidden = false;
    b.addEventListener('click', function () {
      var st = document.getElementById(statusId);
      function done(ok) { if (st) st.textContent = ok ? 'Скопировано' : 'Не удалось скопировать: выделите текст вручную'; }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(src.value).then(function () { done(true); }, function () { done(false); });
      else { src.select(); try { done(document.execCommand('copy')); } catch (e) { done(false); } }
    });
  }
  wire('calc-copy', 'calc-text', 'calc-copy-status');
  wire('qn-copy', 'qn-draft', 'qn-copy-status');
  var p = document.getElementById('tools-print');
  if (p) { p.hidden = false; p.addEventListener('click', function () { window.print(); }); }
})();
