// Обновление SLA-таймеров без перезагрузки (без JS остаётся значение на момент загрузки)
(function () {
  function txt(ms) {
    var m = Math.max(1, Math.round(Math.abs(ms) / 60000));
    if (m < 60) return m + ' мин';
    var h = Math.floor(m / 60);
    return h < 48 ? h + ' ч ' + (m % 60) + ' мин' : Math.floor(h / 24) + ' дн';
  }
  function tick() {
    document.querySelectorAll('.sla[data-due]').forEach(function (el) {
      var d = Date.parse(el.getAttribute('data-due'));
      if (isNaN(d)) return;
      var diff = d - Date.now();
      var over = diff < 0;
      el.classList.toggle('sla--overdue', over);
      el.classList.toggle('sla--ok', !over);
      el.querySelector('.sla__state').innerHTML = '<span aria-hidden="true">' + (over ? '⚠' : '⏱') + '</span> <strong>' + (over ? 'Просрочено' : 'В срок') + '</strong>';
      el.querySelector('.sla__text').textContent = (over ? 'просрочено на ' : 'осталось ') + txt(diff);
    });
  }
  tick();
  setInterval(tick, 15000);
})();
