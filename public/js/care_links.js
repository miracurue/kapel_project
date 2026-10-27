'use strict';
// Маршрутизация, сторона пациента: вопрос «с кем из ваших специалистов соединить нового», ввод кода второго
// специалиста (в т. ч. из ссылки /account?link=КОД) и снятие связи в «Мои данные и согласия».
// API — GET /api/v1/me/care-links, POST /api/v1/me/care-links/answer, POST /api/v1/me/care-links/{id}/end.
(function () {
  const profile = document.querySelector('#acc-profile[data-role="patient"]');
  const mydata = document.querySelector('#my-data');
  if (!profile && !mydata) return;
  let TX = {};
  const tx = (key) => TX[key] || key;
  const ROLE = { psychiatrist: 'психиатр', psychologist: 'психолог' };
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const who = (p) => `${ROLE[p.role] || ''} ${p.full_name}`.trim();

  async function call(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      headers['Idempotency-Key'] = crypto.randomUUID();
      headers['X-CSRF-Token'] = (await (await fetch('/api/v1/csrf')).json()).token;
    }
    try {
      const res = await fetch(path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
      });
      return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
    } catch (_) {
      return { ok: false, status: 0, data: {} };
    }
  }

  function promptCard(prompt, refresh) {
    const card = el('section', 'card acc-block carelink-prompt');
    card.dataset.testid = 'msg.carelinks.prompt.title';
    card.append(el('h3', '', tx('msg.carelinks.prompt.title').replace('{who}', who(prompt.new_specialist))));
    card.append(el('p', 'sub', tx('msg.carelinks.prompt.text')));
    const chosen = new Set();
    const chips = el('div', 'acts');
    for (const option of prompt.options) {
      const chip = el('button', 'btn', who(option));
      chip.type = 'button';
      chip.setAttribute('aria-pressed', 'false');
      chip.dataset.id = String(option.id);
      chip.addEventListener('click', () => {
        const on = !chosen.has(option.id);
        if (on) chosen.add(option.id);
        else chosen.delete(option.id);
        chip.setAttribute('aria-pressed', String(on));
        chip.classList.toggle('primary', on);
      });
      chips.append(chip);
    }
    const done = el('button', 'btn primary', tx('msg.carelinks.prompt.done'));
    done.type = 'button';
    done.dataset.testid = 'msg.carelinks.prompt.done';
    done.addEventListener('click', async () => {
      done.disabled = true;
      const r = await call('POST', '/api/v1/me/care-links/answer', {
        prompt_id: prompt.id,
        clinician_ids: [...chosen],
      });
      if (r.ok) refresh();
      else done.disabled = false;
    });
    card.append(chips, el('div', 'acts'), done);
    return card;
  }

  async function mountProfile() {
    const view = await call('GET', '/api/v1/me/care-links');
    if (!view.ok) return;
    const params = new URLSearchParams(location.search);
    const prefill = (params.get('link') || '').trim();
    let host = document.querySelector('[data-carelinks]');
    if (!host) {
      host = el('div');
      host.dataset.carelinks = '';
      profile.prepend(host); // вопрос пациенту — первым на странице
    }
    host.replaceChildren();
    for (const prompt of view.data.prompts) host.append(promptCard(prompt, mountProfile));
    const hasDoctor = view.data.specialists.length > 0;
    if (hasDoctor) {
      const add = el('section', 'card acc-block');
      add.append(el('h3', '', tx('msg.carelinks.add.title')), el('p', 'sub', tx('msg.carelinks.add.text')));
      const input = el('input');
      input.dataset.testid = 'msg.carelinks.add.input';
      input.autocomplete = 'off';
      input.setAttribute('autocapitalize', 'characters');
      input.spellcheck = false;
      input.value = prefill;
      const label = el('label', '', tx('msg.carelink.input'));
      label.append(input);
      const row = el('div', 'row-fields');
      row.append(label);
      const out = el('p', 'sub');
      out.setAttribute('aria-live', 'polite');
      const send = el('button', 'btn primary', tx('msg.carelinks.add.submit'));
      send.type = 'button';
      send.dataset.testid = 'msg.carelinks.add.submit';
      send.addEventListener('click', async () => {
        const code = input.value.trim();
        if (!code) return;
        const r = await call('POST', '/api/v1/me/care-link', { invite_code: code });
        if (r.ok) {
          input.value = '';
          out.textContent = tx('msg.carelink.ok').replace('{name}', r.data.clinician || '');
          mountProfile();
        } else {
          const c = r.data && r.data.error && r.data.error.code;
          out.textContent =
            c === 'E-INVITE-INVALID'
              ? tx('err.e-invite-invalid')
              : c === 'E-CONFLICT'
                ? tx('msg.carelink.error.conflict')
                : r.status === 429
                  ? tx('msg.carelink.error.rate')
                  : tx('msg.carelink.error.generic');
        }
      });
      add.append(row, el('div', 'acts'), send, out);
      host.append(add);
    } else if (prefill) {
      // Врача ещё нет: поле кода рисует account.js; подставляем код, когда оно появится.
      let tries = 0;
      const timer = setInterval(() => {
        const field = document.querySelector('[data-testid="msg.carelink.input"]');
        tries += 1;
        if (field) {
          field.value = prefill;
          clearInterval(timer);
        } else if (tries > 30) clearInterval(timer);
      }, 100);
    }
  }

  async function mountData() {
    const view = await call('GET', '/api/v1/me/care-links');
    if (!view.ok) return;
    let box = document.querySelector('[data-carelinks-data]');
    if (!box) {
      box = el('section', 'acc-block');
      box.dataset.carelinksData = '';
      mydata.after(box);
    }
    box.replaceChildren();
    if (!view.data.links.length) return;
    const h = el('h2', 'sec-h', tx('msg.carelinks.data.title'));
    h.dataset.testid = 'msg.carelinks.data.title';
    box.append(h, el('p', 'sub', tx('msg.carelinks.data.text')));
    const list = el('div', 'list');
    for (const link of view.data.links) {
      const row = el('div', 'li');
      const info = el('div', 'grow');
      info.append(el('b', '', `${who(link.a)} ↔ ${who(link.b)}`));
      const end = el('button', 'btn', tx('msg.carelinks.data.end'));
      end.type = 'button';
      end.dataset.testid = 'msg.carelinks.data.end';
      end.dataset.id = String(link.id);
      end.addEventListener('click', async () => {
        end.disabled = true;
        const r = await call('POST', `/api/v1/me/care-links/${link.id}/end`, {});
        if (r.ok) mountData();
        else end.disabled = false;
      });
      row.append(info, end);
      list.append(row);
    }
    box.append(list);
  }

  fetch('/assets/ru.json')
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}))
    .then((t) => {
      TX = t;
      if (profile) mountProfile();
      if (mydata) mountData();
    });
})();
