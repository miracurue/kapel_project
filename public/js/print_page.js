'use strict';
// Страницы печати: кнопка «Распечатать» и «Назад» без встроенных скриптов (CSP).
(function () {
  document.querySelector('[data-print]')?.addEventListener('click', () => window.print());
  document.querySelector('[data-back]')?.addEventListener('click', (event) => {
    event.preventDefault();
    if (history.length > 1) history.back();
    else window.close();
  });
})();
