'use strict';

// W-48: библиотека — свой плеер (play/pause, ползунок с клавиатурой), личная позиция
// «Продолжить» (F-50, DB-64), живой поиск по карточкам и раскрытие статей.

(function () {
  let tokenPromise = null;
  const csrfToken = () => {
    if (!tokenPromise)
      tokenPromise = fetch('/api/v1/csrf')
        .then((r) => r.json())
        .then((d) => d.token || '');
    return tokenPromise;
  };
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  async function savePosition(itemId, positionS) {
    try {
      const token = await csrfToken();
      await fetch(`/api/v1/library/${itemId}/position`, {
        method: 'PUT',
        keepalive: true,
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ position_s: Math.max(0, Math.ceil(positionS)) }),
      });
    } catch (_) {
      /* офлайн: позиция сохранится при следующей паузе */
    }
  }

  function wire(box) {
    const audio = box.querySelector('audio');
    const toggle = box.querySelector('[data-lib-toggle]');
    const seek = box.querySelector('[data-lib-seek]');
    const fill = box.querySelector('[data-lib-fill]');
    const time = box.querySelector('[data-lib-time]');
    const itemId = audio.dataset.item;
    const dur = Number(audio.dataset.duration) || 0;
    let pos = Number(audio.dataset.position) || 0;
    let resumed = false;

    const paint = () => {
      const total = dur || audio.duration || 0;
      seek.setAttribute('aria-valuenow', String(Math.round(pos)));
      if (total) seek.setAttribute('aria-valuemax', String(Math.round(total)));
      fill.style.width = total ? `${Math.min(100, (pos / total) * 100)}%` : '0';
      time.textContent = `${mmss(pos)} / ${mmss(total)}`;
    };
    const setPlaying = (on) => {
      toggle.dataset.testid = on ? 'msg.library.pause' : 'msg.library.play';
      toggle.setAttribute('aria-label', on ? 'Пауза' : 'Воспроизвести');
      toggle.classList.toggle('on', on);
      box.closest('.lib-card')?.classList.toggle('playing', on);
    };
    const jump = (to) => {
      const total = dur || audio.duration || 0;
      pos = Math.max(0, total ? Math.min(total, to) : to);
      try {
        audio.currentTime = pos;
      } catch (_) {
        /* медиа ещё не загружено */
      }
      paint();
    };

    toggle.addEventListener('click', async () => {
      if (!audio.paused) {
        audio.pause();
        return;
      }
      if (!resumed && pos > 0) {
        audio.addEventListener('loadedmetadata', () => jump(pos), { once: true });
        resumed = true;
      }
      try {
        await audio.play();
      } catch (_) {
        /* воспроизведение заблокировано */
      }
    });
    audio.addEventListener('play', () => setPlaying(true));
    let lastSaved = 0;
    audio.addEventListener('timeupdate', () => {
      pos = audio.currentTime;
      paint();
      // позиция сохраняется по ходу воспроизведения: уход со страницы сразу после паузы её не теряет
      const now = Date.now();
      if (pos >= 0.2 && now - lastSaved > 2000) {
        lastSaved = now;
        savePosition(itemId, pos);
      }
    });
    window.addEventListener('pagehide', () => {
      if (pos > 0) savePosition(itemId, pos);
    });
    audio.addEventListener('pause', () => {
      setPlaying(false);
      savePosition(itemId, audio.currentTime || pos);
    });
    audio.addEventListener('ended', () => {
      setPlaying(false);
      savePosition(itemId, 0);
    });
    seek.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') jump(pos + 10);
      else if (e.key === 'ArrowLeft') jump(pos - 10);
      else return;
      e.preventDefault();
    });
    seek.addEventListener('click', (e) => {
      const total = dur || audio.duration || 0;
      const rect = seek.getBoundingClientRect();
      if (total && rect.width) jump(((e.clientX - rect.left) / rect.width) * total);
    });
    paint();
  }

  csrfToken(); // токен заранее: сохранение позиции при уходе со страницы не ждёт второй запрос
  document.querySelectorAll('[data-lib-player]').forEach(wire);

  document.querySelectorAll('[data-lib-read]').forEach((button) =>
    button.addEventListener('click', () => {
      const body = button.closest('.lib-card').querySelector('.lib-body');
      body.hidden = !body.hidden;
      button.textContent = body.hidden ? 'Читать' : 'Свернуть';
    }),
  );

  // Статья журнала: текст в data-md отрисовывается мини-разметкой (md.js), без неё остаётся простой текст.
  document.querySelectorAll('[data-md]').forEach((node) => {
    if (!window.CCMarkdown) return;
    node.textContent = '';
    node.appendChild(window.CCMarkdown.render(node.dataset.md));
  });

  const search = document.querySelector('[data-testid="msg.library.search"]');
  const empty = document.querySelector('[data-testid="msg.library.empty_search"]');
  let topic = '';
  const applyFilters = () => {
    const needle = search ? search.value.trim().toLowerCase() : '';
    let shown = 0;
    document.querySelectorAll('.lib-card').forEach((card) => {
      const hit =
        (!needle || card.dataset.search.includes(needle)) &&
        (!topic || (card.dataset.tags || '').split(' ').includes(topic));
      card.hidden = !hit;
      if (hit) shown += 1;
    });
    if (empty) empty.hidden = Boolean(shown) || (!needle && !topic);
  };
  if (search) {
    search.addEventListener('input', applyFilters);
    search.form?.addEventListener('submit', (e) => e.preventDefault());
  }
  // Рубрики журнала: фильтр карточек по тегу «тема:…».
  document.querySelectorAll('[data-topic]').forEach((button) =>
    button.addEventListener('click', () => {
      topic = button.dataset.topic;
      document.querySelectorAll('[data-topic]').forEach((b) => b.classList.toggle('on', b === button));
      applyFilters();
    }),
  );
})();
