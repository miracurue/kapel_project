// CSRF для fetch (W2.S): токен берётся из <meta name="csrf-token"> и добавляется заголовком X-CSRF-Token
// ко всем изменяющим запросам на тот же источник. Формы получают скрытое поле _csrf от сервера.
// XMLHttpRequest в приложении не используется.
(function () {
  'use strict';
  var meta = document.querySelector('meta[name="csrf-token"]');
  var token = meta ? meta.getAttribute('content') : '';
  if (!token || !window.fetch) return;
  var orig = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = String((init && init.method) || (input && typeof input !== 'string' && input.method) || 'GET').toUpperCase();
    var sameOrigin = (url.charAt(0) === '/' && url.charAt(1) !== '/') || url.indexOf(location.origin + '/') === 0;
    if (sameOrigin && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      init = init || {};
      var h = new Headers(init.headers || (input && typeof input !== 'string' && input.headers) || {});
      h.set('X-CSRF-Token', token);
      init.headers = h;
    }
    return orig.call(this, input, init);
  };
})();
