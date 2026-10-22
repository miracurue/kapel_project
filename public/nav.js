// Меню-гамбургер (вынесено из шаблона ради CSP без inline-скриптов).
(function () {
  // Доступность: прокручиваемые области таблиц доступны с клавиатуры (WCAG 2.1.1).
  var regions = document.querySelectorAll('.table-responsive');
  for (var i = 0; i < regions.length; i++) {
    if (!regions[i].hasAttribute('tabindex')) regions[i].setAttribute('tabindex', '0');
    if (!regions[i].hasAttribute('role')) regions[i].setAttribute('role', 'region');
    if (!regions[i].hasAttribute('aria-label')) regions[i].setAttribute('aria-label', 'Таблица (прокручивается)');
  }
  var btn = document.getElementById('nav-toggle');
  var nav = document.getElementById('sidenav');
  if (!btn || !nav) return;
  // Прогрессивное улучшение: без JS меню остаётся развёрнутым.
  var narrow = window.matchMedia('(max-width: 760px)');
  function set(open) {
    nav.classList.toggle('is-collapsed', !open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  set(!narrow.matches);
  // Клавиатура: Esc закрывает открытое меню на узком экране и возвращает фокус на кнопку.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && narrow.matches && btn.getAttribute('aria-expanded') === 'true') { set(false); btn.focus(); }
  });
  btn.addEventListener('click', function () { set(btn.getAttribute('aria-expanded') !== 'true'); });
  narrow.addEventListener && narrow.addEventListener('change', function (e) { set(!e.matches); });
})();
