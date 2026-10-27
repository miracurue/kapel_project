'use strict';

/**
 * Пуши о напоминаниях на этом устройстве (Web Push). Ключ и состояние — из GET /api/v1/me/prefs (поле push),
 * подписка сохраняется через PATCH /api/v1/me/prefs { push_subscription }. Работает в браузерах с service worker
 * и Push API; на iPhone — после «Добавить на экран «Домой»». Service worker: /sw.js.
 */
(function () {
  const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  async function api(method, body) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      headers['x-csrf-token'] = (await (await fetch('/api/v1/csrf')).json()).token;
      headers['idempotency-key'] = crypto.randomUUID();
    }
    const response = await fetch('/api/v1/me/prefs', {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try {
      data = await response.json();
    } catch (_) {
      data = {};
    }
    return { ok: response.ok, data };
  }

  function keyBytes(base64url) {
    const padded = base64url + '='.repeat((4 - (base64url.length % 4)) % 4);
    const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  /** { supported, available, subscribed, denied } — available: сервер умеет слать пуши. */
  async function state() {
    if (!supported()) return { supported: false, available: false, subscribed: false, denied: false };
    const { ok, data } = await api('GET');
    const push = (ok && data.push) || {};
    let here = false;
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      here = Boolean(reg && (await reg.pushManager.getSubscription()));
    } catch (_) {
      here = false;
    }
    return {
      supported: true,
      available: Boolean(push.available),
      subscribed: here,
      denied: Notification.permission === 'denied',
      key: push.public_key || null,
    };
  }

  async function enable() {
    const current = await state();
    if (!current.supported || !current.available || !current.key) return false;
    if ((await Notification.requestPermission()) !== 'granted') return false;
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const sub =
      (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(current.key) }));
    return (await api('PATCH', { push_subscription: sub.toJSON() })).ok;
  }

  async function disable() {
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub) await sub.unsubscribe();
    } catch (_) {
      /* подписка в браузере уже снята */
    }
    return (await api('PATCH', { push_subscription: null })).ok;
  }

  window.PatientPush = { supported, state, enable, disable };
})();
