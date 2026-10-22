'use strict';
// Цветок и капельки пациента: счётчик в шапке, полноэкранный цветок, малый цветок в Дневнике, «+N» после действий.
// Данные только свои (GET /api/v1/me/flower). Никаких штрафов и «потерянных» серий: интерфейс только поощряет.
(async () => {
  const counter = document.querySelector('[data-flower-counter]');
  if (!counter || !window.FlowerPlant) return;
  let dictionary = {};
  try {
    dictionary = await (await fetch('/assets/ru.json')).json();
  } catch {
    /* тексты — ключи, интерфейс остаётся рабочим */
  }
  const t = (key, vars = {}) =>
    String(dictionary[key] || key).replace(/\{(\w+)\}/g, (_, name) => (vars[name] === undefined ? '' : vars[name]));
  const esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const plural = (n, base) => {
    const m10 = n % 10;
    const m100 = n % 100;
    const form = m10 === 1 && m100 !== 11 ? 'one' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'few' : 'many';
    return t(`${base}.${form}`, { n });
  };
  const drops = (n) => plural(n, 'msg.flower.drops');

  let state = null;
  let panel = null;
  let plant = null;
  let returnFocus = counter;
  let mode = 'closed';
  let fullReturn = 'closed';
  const minis = [];
  let gainTimer = 0;
  const live = document.createElement('span');
  live.className = 'sr';
  live.setAttribute('role', 'status');
  counter.after(live);
  const balanceEl = counter.querySelector('[data-flower-balance]');
  const gainEl = counter.querySelector('[data-flower-gain]');

  const csrf = async () => (await (await fetch('/api/v1/csrf')).json()).token;
  const stageName = (s) => t(`msg.flower.stage.${s.stage.key}`);

  function setBalance(n) {
    balanceEl.textContent = String(n);
    counter.setAttribute('aria-label', t('msg.flower.counter.aria', { n }));
  }

  /** «+N» у счётчика на две секунды, без окон и подтверждений. */
  function showGain(n) {
    if (!(n > 0)) return;
    gainEl.textContent = `+${n}`;
    gainEl.hidden = false;
    gainEl.classList.remove('on');
    void gainEl.offsetWidth;
    gainEl.classList.add('on');
    live.textContent = t('msg.flower.gain.aria', { text: drops(n) });
    window.clearTimeout(gainTimer);
    gainTimer = window.setTimeout(() => {
      gainEl.hidden = true;
      live.textContent = '';
    }, 2000);
  }

  async function load() {
    const response = await fetch('/api/v1/me/flower');
    if (!response.ok) throw new Error('flower');
    state = await response.json();
    setBalance(state.balance);
    render();
    return state;
  }

  function nextLine(s) {
    if (s.full) return t('msg.flower.full');
    if (!s.next) return t('msg.flower.next.full', { steps: plural(s.max_steps - s.steps, 'msg.flower.steps') });
    const stage = t(`msg.flower.stage.${s.next.key}`);
    return s.next.drops_to_go > 0
      ? t('msg.flower.next', { stage, drops: drops(s.next.drops_to_go) })
      : t('msg.flower.next.ready', { stage, steps: plural(s.next.steps_to_go, 'msg.flower.steps') });
  }

  function stageText(s) {
    return s.full ? t('msg.flower.stage.full.text') : t(`msg.flower.stage.${s.stage.key}.text`);
  }

  function sourcesHtml(s) {
    return s.sources
      .map(
        (x) =>
          `<li><span>${esc(t(`msg.flower.source.${x.action}`))}<small>${esc(x.once ? t('msg.flower.source.once') : t('msg.flower.source.cap', { n: x.daily_cap }))}</small></span><b>+${x.drops}</b></li>`,
      )
      .join('');
  }

  function buildPanel() {
    panel = document.createElement('dialog');
    panel.id = 'flower-panel';
    panel.className = 'flower-panel';
    panel.hidden = true;
    panel.setAttribute('aria-labelledby', 'flower-panel-title');
    panel.innerHTML = `<div class="fp-head"><button type="button" class="btn ghost" data-flower-close>${esc(t('msg.flower.screen.back'))}</button><h2 id="flower-panel-title" data-testid="msg.flower.panel.title">${esc(t('msg.flower.panel.title'))}</h2></div>
      <div class="fp-body"><div class="fp-scene"><button type="button" class="fp-plant" data-fp-plant data-flower-water aria-label="${esc(t('msg.flower.screen.water'))}"></button><p class="fp-scene-hint" data-fp-scene-hint>${esc(t('msg.flower.screen.hint'))}</p></div><div data-fp-info><p class="muted" role="status">${esc(t('msg.flower.panel.loading'))}</p></div></div>`;
    panel.addEventListener('cancel', (event) => {
      event.preventDefault();
      close();
    });
    document.body.append(panel);
    plant = window.FlowerPlant.mount(panel.querySelector('[data-fp-plant]'));
    panel.addEventListener('click', (e) => {
      if (e.target.closest('[data-flower-close]')) return close();
      if (e.target.closest('[data-flower-enlarge]')) return open();
      if (e.target.closest('[data-flower-water]')) water(e.target.closest('button'));
    });
  }

  function renderPanel(skipPlant = false) {
    if (!panel || !state) return;
    plant.label(t('msg.flower.plant.aria', { stage: stageName(state) }));
    const canvas = panel.querySelector('[data-fp-plant]');
    const sidebar = mode === 'sidebar';
    canvas.toggleAttribute('data-flower-enlarge', sidebar);
    canvas.toggleAttribute('data-flower-water', !sidebar);
    canvas.setAttribute('aria-label', t(sidebar ? 'msg.flower.screen.open' : 'msg.flower.screen.water'));
    canvas.disabled = !sidebar && (busy || !state.can_water);
    panel.querySelector('[data-flower-close]').textContent = t(
      sidebar ? 'msg.flower.panel.close' : 'msg.flower.screen.back',
    );
    panel.querySelector('[data-fp-scene-hint]').textContent = t(
      sidebar ? 'msg.flower.panel.enlarge' : state.full ? 'msg.flower.full' : 'msg.flower.screen.hint',
    );
    if (!skipPlant) plant.set(state.steps, false);
    const stages = ['sprout', 'crown', 'bloom']
      .map(
        (k, i) =>
          `<li${state.stage.index === i + 1 ? ' aria-current="step" class="on"' : ''}>${esc(t(`msg.flower.stage.${k}`))}</li>`,
      )
      .join('');
    panel.querySelector('[data-fp-info]').innerHTML = `
      <ol class="fp-stages">${stages}</ol>
      <h3 class="fp-stage">${esc(stageName(state))}</h3>
      <p>${esc(stageText(state))}</p>
      <p class="fp-next">${esc(nextLine(state))}</p>
      <div class="fp-water"><p class="fp-balance"><svg class="drop" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3S5 11 5 15a7 7 0 0 0 14 0c0-4-7-12-7-12Z"/></svg>${esc(t('msg.flower.balance', { drops: drops(state.balance) }))}</p>
      <button type="button" class="btn primary" data-flower-water data-testid="msg.flower.water"${state.can_water ? '' : ' disabled'}>${esc(t('msg.flower.water'))}</button></div>
      <p class="muted small" data-fp-hint>${state.can_water || state.full ? '' : esc(t('msg.flower.water.hint'))}</p>
      <p class="fp-feedback" role="status" aria-live="polite" data-fp-feedback></p>
      <details class="fp-sources"><summary data-testid="msg.flower.sources.title">${esc(t('msg.flower.sources.title'))}</summary>
      <ul class="fp-list">${sourcesHtml(state)}</ul>
      <p class="muted small">${esc(t('msg.flower.sources.note', { n: drops(state.daily_max) }))}</p></details>
      <p class="small"><a href="/account/help#flower" data-testid="msg.flower.help.link">${esc(t('msg.flower.help.link'))}</a></p>`;
  }

  function renderMini(skipPlant = false) {
    for (const el of minis) {
      if (!state) continue;
      if (!el.mini) {
        el.innerHTML = `<button type="button" class="fm-plant" data-fm-plant data-flower-open aria-label="${esc(t('msg.flower.screen.open'))}"></button><div class="fm-text"><h3>${esc(t('msg.flower.mini.title'))}</h3><p class="fm-stage" data-fm-stage></p><p class="muted small" data-fm-today></p></div><div class="fm-acts"><button type="button" class="btn" data-flower-water>${esc(t('msg.flower.water'))}</button><button type="button" class="btn ghost" data-flower-open data-testid="msg.flower.mini.more">${esc(t('msg.flower.mini.more'))}</button></div>`;
        el.mini = window.FlowerPlant.mount(el.querySelector('[data-fm-plant]'));
      }
      el.mini.label(t('msg.flower.plant.aria', { stage: stageName(state) }));
      if (!skipPlant) el.mini.set(state.steps, false);
      el.querySelector('[data-fm-stage]').textContent = stageName(state);
      el.querySelector('[data-fm-today]').textContent = t('msg.flower.mini.today', {
        n: state.today_drops,
        total: state.balance,
      });
      el.querySelector('[data-flower-water]').disabled = !state.can_water;
    }
  }

  function render() {
    renderPanel();
    renderMini();
  }

  let busy = false;
  async function water(button) {
    if (busy || !state || !state.can_water) return;
    busy = true;
    for (const control of document.querySelectorAll('[data-flower-water]')) control.disabled = true;
    const keepFocus = document.activeElement === button;
    const feedback = panel?.querySelector('[data-fp-feedback]');
    try {
      const response = await fetch('/api/v1/me/flower/water', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': await csrf(),
          'idempotency-key': crypto.randomUUID(),
        },
        body: '{}',
      });
      const data = await response.json();
      if (!response.ok) {
        if (feedback)
          feedback.textContent = t(data.error?.reason === 'full' ? 'msg.flower.water.full' : 'msg.flower.water.error');
        await load();
        return;
      }
      state = data;
      setBalance(state.balance);
      renderMini(true);
      renderPanel(true);
      if (keepFocus && !button.isConnected)
        panel?.querySelector('[data-testid="msg.flower.water"]')?.focus({ preventScroll: true });
      for (const target of [plant, ...minis.map((m) => m.mini)]) {
        if (!target) continue;
        target.pour();
        target.set(state.steps, true);
      }
      const fresh = panel?.querySelector('[data-fp-feedback]');
      const confirmation = t('msg.flower.water.done', { steps: plural(data.watered.steps, 'msg.flower.steps') });
      if (fresh) fresh.textContent = confirmation;
      live.textContent = confirmation;
    } catch {
      if (feedback) feedback.textContent = t('msg.flower.water.error');
    } finally {
      busy = false;
      for (const control of document.querySelectorAll('[data-flower-water]')) control.disabled = !state?.can_water;
    }
  }

  function refreshPanel() {
    renderPanel();
    load().catch(() => {
      panel.querySelector('[data-fp-info]').innerHTML =
        `<p class="muted" role="alert">${esc(t('msg.flower.panel.error'))}</p>`;
    });
  }

  function positionSidebar() {
    const top = document.querySelector('header.top');
    panel.style.setProperty('--fl-top', `${Math.max(0, Math.round(top?.getBoundingClientRect().bottom || 0))}px`);
  }

  function openSidebar(trigger = null, fromFull = false) {
    if (!panel) buildPanel();
    if (trigger) returnFocus = trigger;
    if (panel.open) panel.close();
    mode = 'sidebar';
    panel.classList.add('is-sidebar');
    panel.hidden = false;
    positionSidebar();
    panel.show();
    document.body.classList.remove('flower-open');
    document.body.classList.add('flower-sidebar');
    counter.setAttribute('aria-expanded', 'true');
    refreshPanel();
    panel.querySelector(fromFull ? '[data-fp-plant]' : '[data-flower-close]').focus();
  }

  function open(recordHistory = true, trigger = null) {
    if (!panel) buildPanel();
    if (mode === 'full') return;
    fullReturn =
      mode === 'sidebar' || (!recordHistory && history.state?.flowerReturn === 'sidebar') ? 'sidebar' : 'closed';
    if (trigger) returnFocus = trigger;
    if (panel.open) panel.close();
    mode = 'full';
    panel.classList.remove('is-sidebar');
    panel.hidden = false;
    panel.showModal();
    document.body.classList.remove('flower-sidebar');
    document.body.classList.add('flower-open');
    counter.setAttribute('aria-expanded', 'true');
    if (recordHistory && !isFlowerLocation()) {
      const url = new URL(location.href);
      url.searchParams.set('flower', '1');
      history.pushState({ ...history.state, flowerScreen: true, flowerReturn: fullReturn }, '', url);
    }
    refreshPanel();
    panel.querySelector('[data-flower-close]').focus();
  }

  function hidePanel() {
    if (!panel?.open) return;
    mode = 'closed';
    panel.close();
    panel.hidden = true;
    document.body.classList.remove('flower-open', 'flower-sidebar');
    counter.setAttribute('aria-expanded', 'false');
    requestAnimationFrame(() => {
      if (!panel.open && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    });
  }

  function leaveFull() {
    if (fullReturn === 'sidebar') openSidebar(null, true);
    else hidePanel();
  }

  function close() {
    if (mode === 'sidebar') return hidePanel();
    leaveFull();
    if (!isFlowerLocation()) return;
    if (history.state?.flowerScreen) history.back();
    else {
      const url = new URL(location.href);
      url.searchParams.delete('flower');
      history.replaceState(history.state, '', url);
    }
  }

  const isFlowerLocation = () => new URL(location.href).searchParams.get('flower') === '1';
  window.addEventListener('resize', () => {
    if (mode === 'sidebar') positionSidebar();
  });
  counter.addEventListener('click', () => (mode === 'sidebar' ? close() : openSidebar(counter)));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && mode === 'sidebar') close();
  });
  window.addEventListener('popstate', () => {
    if (isFlowerLocation()) open(false);
    else if (mode === 'full') leaveFull();
  });
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-flower-open]');
    if (target) open(true, target);
    const mini = e.target.closest('[data-flower-mini] [data-flower-water]');
    if (mini) water(mini);
  });

  // «+N» после любой записи пациента: сервер сообщает заголовками X-Flower-Gain / X-Flower-Balance.
  const nativeFetch = window.fetch;
  let refresh = 0;
  window.fetch = async function flowerFetch(...args) {
    const response = await nativeFetch.apply(this, args);
    try {
      const gain = Number(response.headers.get('x-flower-gain'));
      const balance = response.headers.get('x-flower-balance');
      if (balance !== null) setBalance(Number(balance));
      if (gain > 0) {
        showGain(gain);
        window.dispatchEvent(new CustomEvent('flower:gain', { detail: { gain } }));
      }
      if (balance !== null && (panel && !panel.hidden ? true : minis.length)) {
        window.clearTimeout(refresh);
        refresh = window.setTimeout(() => load().catch(() => {}), 400);
      }
    } catch {
      /* награда не должна мешать основному действию */
    }
    return response;
  };

  for (const el of document.querySelectorAll('[data-flower-mini]')) minis.push(el);
  try {
    await load();
    if (isFlowerLocation()) open(false);
  } catch {
    balanceEl.textContent = '0';
  }
})();
