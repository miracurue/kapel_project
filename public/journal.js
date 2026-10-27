'use strict';

/**
 * Журнал: разбор разметки статьи, лайки и «Показать ещё» (подгрузка следующей страницы ленты).
 * Карточки приходят с сервера готовым HTML (экранирование на сервере), здесь они только вставляются в ленту.
 */
(function () {
  let csrf = null;
  async function token() {
    if (!csrf) csrf = (await (await fetch('/api/v1/csrf')).json()).token;
    return csrf;
  }

  // --- Шапка: у страниц Журнала нет текущей вкладки (shell.js отмечает первую вкладку, когда в адресе нет tab) ---
  const tabs = document.querySelector('header.top .tabs');
  if (tabs) {
    const clear = () => tabs.querySelectorAll('a.tab[aria-current]').forEach((a) => a.removeAttribute('aria-current'));
    clear();
    new MutationObserver(clear).observe(tabs, { attributes: true, attributeFilter: ['aria-current'], subtree: true });
  }

  // --- Печать статьи: тихая кнопка рядом со сведениями об авторе; оформление страницы для бумаги — в journal.css ---
  document.querySelector('[data-print-article]')?.addEventListener('click', () => window.print());

  // --- Статья: разметка в DOM ---
  for (const el of document.querySelectorAll('.j-text[data-md]')) {
    if (window.CCMarkdown) {
      const md = el.dataset.md;
      el.textContent = '';
      el.appendChild(window.CCMarkdown.render(md));
    }
  }

  // --- Лайки ---
  function paint(id, state) {
    for (const btn of document.querySelectorAll(`[data-like="${id}"]`)) {
      btn.classList.toggle('on', state.liked);
      btn.setAttribute('aria-pressed', state.liked ? 'true' : 'false');
      const n = btn.querySelector('[data-like-n]');
      if (n) n.textContent = String(state.likes);
    }
  }
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-like]');
    if (!btn || btn.disabled) return;
    const id = btn.dataset.like;
    const next = btn.getAttribute('aria-pressed') !== 'true';
    const n = btn.querySelector('[data-like-n]');
    paint(id, { liked: next, likes: Math.max(0, Number(n ? n.textContent : 0) + (next ? 1 : -1)) });
    try {
      const res = await fetch(`/journal/api/${id}/like`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-csrf-token': await token() },
        body: JSON.stringify({ liked: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      paint(id, await res.json());
    } catch {
      paint(id, { liked: !next, likes: Math.max(0, Number(n ? n.textContent : 0) + (next ? -1 : 1)) });
    }
  });

  // --- Показать ещё ---
  const feed = document.querySelector('[data-feed]');
  const btn = document.querySelector('[data-more-btn]');
  const end = document.querySelector('[data-end]');
  if (!feed || !btn) return;
  let loading = false;
  btn.addEventListener('click', async () => {
    if (loading) return;
    loading = true;
    btn.disabled = true;
    let more = false;
    try {
      const q = new URLSearchParams({
        aud: feed.dataset.aud,
        page: String(Number(feed.dataset.page) + 1),
        topic: feed.dataset.topic || '',
      });
      const res = await fetch(`/journal/feed?${q}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const seen = new Set([...feed.querySelectorAll('[data-id]')].map((x) => x.dataset.id));
      const tpl = document.createElement('template');
      tpl.innerHTML = data.html;
      for (const card of [...tpl.content.querySelectorAll('[data-id]')]) if (seen.has(card.dataset.id)) card.remove();
      feed.appendChild(tpl.content);
      feed.dataset.page = String(data.page);
      more = data.has_more;
    } catch {
      more = false;
    }
    loading = false;
    btn.disabled = false;
    btn.hidden = !more;
    if (end) end.hidden = more;
  });
})();
