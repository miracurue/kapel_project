'use strict';

/**
 * Напоминания на странице чата пациента (src/modules/patient/reminders.js, views/pages/app/chat.ejs).
 *
 * Показываются по одному и с перерывом (решение владелицы 2026-10-26): видна только одна карточка, после действия
 * («Принято», «Пропущено», «Заполнить вместе», «Позже» и т. п.) она убирается, следующая появляется через PAUSE_MS.
 * Перерыв и «отложено» помнятся в этом браузере (localStorage), поэтому обновление страницы их не сбрасывает.
 * Приём отмечается тем же запросом, что и вкладка «Лекарства» (POST /api/v1/me/med-marks). Внешних каналов здесь нет.
 */
(function () {
  const PAUSE_MS = 2 * 60 * 1000; // перерыв между карточками
  const LATER_MS = 3 * 60 * 60 * 1000; // «Позже»
  const MED_LATER_MS = 60 * 60 * 1000; // «Напомнить позже» у приёма
  const DONE_MS = 12 * 60 * 60 * 1000; // сделал действие (открыл дневник, начал подготовку): сегодня не повторяем
  const STORE = 'cc.reminders';

  const section = () => document.querySelector('.callout.reminders');
  const cards = () => [...document.querySelectorAll('.reminders .reminder')];

  function load() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE) || '{}');
      return { next: Number(v.next) || 0, snooze: v.snooze && typeof v.snooze === 'object' ? v.snooze : {} };
    } catch (_) {
      return { next: 0, snooze: {} };
    }
  }

  function save(state) {
    try {
      const now = Date.now();
      for (const k of Object.keys(state.snooze)) if (state.snooze[k] <= now) delete state.snooze[k];
      localStorage.setItem(STORE, JSON.stringify(state));
    } catch (_) {
      /* без хранилища перерыв действует только на этой странице */
    }
  }

  let timer = null;

  // Значок на вкладке «Чат» = сколько напоминаний ещё осталось (видимых и ожидающих).
  function refreshBadge() {
    const left = cards().length;
    const badge = document.querySelector('a.tab[data-tab="chat"] .badge');
    if (!badge) return;
    if (left) badge.textContent = String(left);
    else badge.remove();
  }

  // Показывает первую карточку, если перерыв прошёл; иначе прячет блок и ставит таймер.
  function reveal() {
    clearTimeout(timer);
    const box = section();
    if (!box) return;
    const list = cards();
    if (!list.length) {
      box.remove();
      refreshBadge();
      return;
    }
    const wait = load().next - Date.now();
    list.forEach((card, i) => {
      card.hidden = i > 0 || wait > 0;
    });
    box.hidden = wait > 0;
    if (wait > 0) timer = setTimeout(reveal, wait + 50);
    refreshBadge();
  }

  // Действие сделано: карточка уходит, следующая — после перерыва; ключ запоминается, чтобы она не вернулась при обновлении.
  function finish(card, snoozeMs) {
    const state = load();
    if (card.dataset.key && snoozeMs) state.snooze[card.dataset.key] = Date.now() + snoozeMs;
    state.next = Date.now() + PAUSE_MS;
    save(state);
    card.remove();
    reveal();
  }

  function init() {
    const state = load();
    const now = Date.now();
    cards().forEach((card) => {
      if (card.dataset.key && state.snooze[card.dataset.key] > now) card.remove();
    });
    reveal();
  }

  async function csrf() {
    return (await (await fetch('/api/v1/csrf')).json()).token;
  }

  async function post(path, method, body) {
    return fetch(path, {
      method,
      headers: {
        Accept: 'application/json',
        'content-type': 'application/json',
        'x-csrf-token': await csrf(),
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });
  }

  const setBusy = (card, busy) => card.querySelectorAll('button').forEach((b) => (b.disabled = busy));

  document.addEventListener('click', async (event) => {
    // «Позже»: убрать карточку на несколько часов.
    const later = event.target.closest('.reminders .reminder [data-later]');
    if (later) return finish(later.closest('.reminder'), LATER_MS);

    // Подсказка в поле чата (дневник, подготовка к визиту) и ссылки: действие начато, карточка уходит.
    const go = event.target.closest('.reminders .reminder [data-idea], .reminders .reminder a.btn');
    if (go) return finish(go.closest('.reminder'), DONE_MS);

    // Форма обращения: PATCH /api/v1/me/prefs; ответ «Нейтрально» тоже ответ, вопрос больше не повторяется.
    const choice = event.target.closest('[data-reminder="profile"] [data-value]');
    if (choice) {
      const card = choice.closest('.reminder');
      setBusy(card, true);
      try {
        const response = await post('/api/v1/me/prefs', 'PATCH', { [card.dataset.field]: choice.dataset.value });
        if (response.ok) return finish(card, 0);
      } catch (_) {
        /* ниже кнопки снова доступны */
      }
      return setBusy(card, false);
    }

    // Приём лекарства: «Принято / Пропущено / Напомнить позже».
    const button = event.target.closest('[data-reminder="medication"] [data-mark]');
    if (!button) return;
    const card = button.closest('.reminder');
    let targets = [];
    try {
      targets = JSON.parse(card.dataset.targets || '[]');
    } catch (_) {
      targets = [];
    }
    setBusy(card, true);
    try {
      const results = await Promise.all(
        targets.map((target) =>
          post('/api/v1/me/med-marks', 'POST', {
            target,
            day: card.dataset.day,
            slot: card.dataset.slot,
            status: button.dataset.mark,
          }),
        ),
      );
      if (results.every((r) => r.ok)) return finish(card, button.dataset.mark === 'remind_later' ? MED_LATER_MS : 0);
    } catch (_) {
      /* ниже кнопки снова доступны */
    }
    setBusy(card, false);
  });

  init();
})();
