// Поиск и фильтры в выборе методики из каталога (views/_catalog_picker.ejs); без JS список виден целиком.
(function () {
  document.querySelectorAll('.catalog-picker').forEach(function (root) {
    var bar = root.querySelector('[data-filters]');
    var input = root.querySelector('input[type="search"]');
    if (!bar || !input) return;
    bar.hidden = false;
    var selects = bar.querySelectorAll('select[data-filter]');
    function apply() {
      var q = input.value.trim().toLowerCase();
      var any = false;
      root.querySelectorAll('.catalog-item').forEach(function (el) {
        var show = !q || el.getAttribute('data-search').indexOf(q) !== -1;
        selects.forEach(function (s) { if (s.value && el.getAttribute('data-' + s.getAttribute('data-filter')) !== s.value) show = false; });
        el.hidden = !show;
        if (show) any = true;
      });
      root.querySelectorAll('.catalog-kind').forEach(function (k) { k.hidden = !k.querySelector('.catalog-item:not([hidden])'); });
      root.querySelectorAll('.catalog-domain').forEach(function (d) { d.hidden = !d.querySelector('.catalog-item:not([hidden])'); });
      root.querySelector('.catalog-empty').hidden = any;
    }
    input.addEventListener('input', apply);
    selects.forEach(function (s) { s.addEventListener('change', apply); });
  });
})();
