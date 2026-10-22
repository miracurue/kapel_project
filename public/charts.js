/* SVG-графики без внешних библиотек (REQ-PAT-011).
 * Работает и в браузере (window.CCCharts), и на сервере (require): сервер
 * рендерит готовый SVG, поэтому график виден и без JS.
 * Спокойные цвета: линия — синий акцент, без красного. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CCCharts = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * points: [{ t: 'YYYY-MM-DD...' | число-время, v: число, label: 'подпись для таблицы/значения' }]
   * opts: { min, max, title, desc, width, height, unit }
   * Возвращает строку <svg>. Пустой массив -> '' (пустое состояние рисует страница).
   */
  function lineChart(points, opts) {
    opts = opts || {};
    if (!points || !points.length) return '';
    var W = opts.width || 640;
    var H = opts.height || 260;
    var pad = { l: 40, r: 16, t: 16, b: 44 };
    var vals = points.map(function (p) { return p.v; });
    var min = opts.min !== undefined ? opts.min : Math.min.apply(null, vals);
    var max = opts.max !== undefined ? opts.max : Math.max.apply(null, vals);
    if (max === min) { max = min + 1; }
    var times = points.map(function (p) { return typeof p.t === 'number' ? p.t : parseT(p.t); });
    var t0 = Math.min.apply(null, times);
    var t1 = Math.max.apply(null, times);
    var iw = W - pad.l - pad.r;
    var ih = H - pad.t - pad.b;
    function x(i) { return pad.l + (t1 === t0 ? iw / 2 : ((times[i] - t0) / (t1 - t0)) * iw); }
    function y(v) { return pad.t + ih - ((v - min) / (max - min)) * ih; }

    var id = 'c' + Math.abs(hash(String(opts.title || '') + vals.join(',')));
    var out = [];
    out.push('<svg class="cc-chart" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-labelledby="' + id + 't ' + id + 'd" preserveAspectRatio="xMidYMid meet">');
    out.push('<title id="' + id + 't">' + esc(opts.title || 'График') + '</title>');
    out.push('<desc id="' + id + 'd">' + esc(opts.desc || 'Динамика значений по времени. Значения также приведены в таблице под графиком.') + '</desc>');
    // горизонтальные линии сетки и подписи оси Y
    var ticks = 4;
    for (var k = 0; k <= ticks; k++) {
      var tv = min + ((max - min) * k) / ticks;
      var ty = y(tv);
      out.push('<line class="cc-grid" x1="' + pad.l + '" y1="' + ty.toFixed(1) + '" x2="' + (W - pad.r) + '" y2="' + ty.toFixed(1) + '"/>');
      out.push('<text class="cc-axis" x="' + (pad.l - 6) + '" y="' + (ty + 4).toFixed(1) + '" text-anchor="end">' + esc(round(tv)) + '</text>');
    }
    // ось времени: первая и последняя дата
    out.push('<text class="cc-axis" x="' + pad.l + '" y="' + (H - 22) + '" text-anchor="start">' + esc(dateLabel(t0)) + '</text>');
    out.push('<text class="cc-axis" x="' + (W - pad.r) + '" y="' + (H - 22) + '" text-anchor="end">' + esc(dateLabel(t1)) + '</text>');
    if (points.length > 1) {
      var d = points.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1); }).join(' ');
      out.push('<path class="cc-line" d="' + d + '" fill="none"/>');
    }
    points.forEach(function (p, i) {
      var cx = x(i).toFixed(1);
      var cy = y(p.v).toFixed(1);
      out.push('<circle class="cc-dot" cx="' + cx + '" cy="' + cy + '" r="4"><title>' + esc(p.label || (dateLabel(times[i]) + ': ' + p.v)) + '</title></circle>');
      // подпись значений текстом (не только цветом/позицией); при большом числе точек подписываем крайние
      if (points.length <= 12 || i === 0 || i === points.length - 1) {
        out.push('<text class="cc-val" x="' + cx + '" y="' + (Number(cy) - 9).toFixed(1) + '" text-anchor="middle">' + esc(round(p.v)) + '</text>');
      }
    });
    out.push('</svg>');
    return out.join('');
  }

  function parseT(v) {
    var s = String(v).replace(' ', 'T');
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += s.length <= 10 ? 'T00:00:00Z' : 'Z';
    return Date.parse(s);
  }
  function round(n) { return Math.round(n * 10) / 10; }
  function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }
  function dateLabel(ms) {
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getUTCDate()) + '.' + p(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear();
  }

  return { lineChart: lineChart, esc: esc };
});
