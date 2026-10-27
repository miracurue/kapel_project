'use strict';

/**
 * Панель «Требует вашего внимания» на главной странице специалиста (чат): свежие необработанные
 * кризисы и побочные эффекты, чтобы их не пропустили. Остальное — во вкладке «Сигналы».
 * Закрытую панель не прячем навсегда: кризисы возвращаются через 10 минут, побочные эффекты — через час,
 * а новый сигнал показывается сразу. Время напоминания хранится в браузере (localStorage), по каждому сигналу.
 */
(function () {
  const rail = document.querySelector('[data-alert-rail]');
  if (!rail) return;
  const list = rail.querySelector('[data-alert-list]');
  const more = rail.querySelector('[data-alert-more]');
  const SNOOZE = { crisis: 10 * 60 * 1000, ae: 60 * 60 * 1000 };
  const STORE = 'kapel.alertRail.snooze';
  const MAX = 3;
  const FRESH_AE = 3 * 24 * 60 * 60 * 1000; // побочный эффект старше трёх дней остаётся только во вкладке «Сигналы»
  let me = null;
  let shown = [];

  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(STORE) || '{}') || {};
    } catch (_) {
      return {};
    }
  };
  const write = (map) => {
    try {
      localStorage.setItem(STORE, JSON.stringify(map));
    } catch (_) {
      /* без хранилища панель просто вернётся при следующей проверке */
    }
  };
  // Третий блок (work_chat.js) показывает сигналы по умолчанию и сам решает, видна ли панель.
  const notify = () => rail.dispatchEvent(new CustomEvent('alertrail:change', { bubbles: true }));
  const keyOf = (x) => `${x.kind}-${x.id}`;
  const open = (x) =>
    x.kind === 'ae'
      ? ['submitted', 'awaiting_doctor', 'service_queue'].includes(x.status) &&
        Date.now() - new Date(x.created_at).getTime() < FRESH_AE
      : x.status === 'new' || (x.status === 'in_work' && me && x.taken_by && x.taken_by.id === me);

  const when = (iso) => {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (Number.isNaN(m)) return '';
    if (m < 60) return `${Math.max(1, m)} мин назад`;
    if (m < 1440) return `${Math.round(m / 60)} ч назад`;
    return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  };

  const row = (x) => {
    const li = document.createElement('li');
    li.className = `alert-item alert-item--${x.kind === 'ae' ? 'ae' : 'crisis'}`;
    const head = document.createElement('b');
    head.textContent = `${x.kind === 'ae' ? 'Побочный эффект' : 'Кризис'} · ${x.patient?.name || `П-${x.patient?.id}`}`;
    const text = document.createElement('p');
    const raw = String((x.kind === 'ae' ? x.text : x.quote) || '').trim();
    text.textContent = raw ? (raw.length > 90 ? `${raw.slice(0, 90)}…` : raw) : 'Откройте, чтобы прочитать';
    const meta = document.createElement('small');
    meta.textContent =
      x.kind === 'ae'
        ? `Решите, связано ли это с препаратом${x.created_at ? ` · ${when(x.created_at)}` : ''}`
        : `Нужно связаться с пациентом${x.created_at ? ` · ${when(x.created_at)}` : ''}`;
    li.append(head, text, meta);
    return li;
  };

  const render = (items) => {
    const snooze = read();
    const now = Date.now();
    const visible = items.filter((x) => !(snooze[keyOf(x)] > now));
    shown = items;
    list.replaceChildren(...visible.slice(0, MAX).map(row));
    const extra = visible.length - MAX;
    more.textContent = extra > 0 ? `Ещё ${extra} во вкладке «Сигналы»` : '';
    rail.hidden = visible.length === 0;
    notify();
  };

  const load = async () => {
    try {
      if (me === null) me = (await (await fetch('/api/v1/me')).json()).user?.id || 0;
      const res = await fetch('/api/v1/signals?kind=all&status=all');
      if (!res.ok) return;
      const items = ((await res.json()).items || []).filter(open);
      // сначала кризисы
      items.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'crisis' ? -1 : 1));
      render(items);
    } catch (_) {
      /* оставляем панель как есть до следующей проверки */
    }
  };

  rail.querySelector('[data-alert-close]').addEventListener('click', () => {
    const snooze = read();
    const now = Date.now();
    for (const x of shown) snooze[keyOf(x)] = now + SNOOZE[x.kind === 'ae' ? 'ae' : 'crisis'];
    for (const k of Object.keys(snooze)) if (snooze[k] < now) delete snooze[k];
    write(snooze);
    rail.hidden = true;
    notify();
  });

  load();
  setInterval(load, 15000);
})();
