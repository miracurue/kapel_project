'use strict';
// Templates use the article workspace layout; patient-filled copies never enter saved drafts or AI context.
(function () {
  const root = document.querySelector('[data-work-docs]');
  if (!root) return;
  const T = (name) =>
    root.dataset['t' + name.charAt(0).toUpperCase() + name.slice(1).replace(/-(\w)/g, (_, c) => c.toUpperCase())] || '';
  const q = (name) => root.querySelector('[data-tpl-' + name + ']');
  const editor = q('editor'),
    editorBody = editor.querySelector('.panel-body'),
    title = q('title'),
    body = q('body'),
    input = q('ai-input');
  let own = [],
    builtin = [],
    current = null,
    messages = [],
    editing = false,
    busy = false,
    dirty = false,
    filled = null;
  const drafts = new Map();
  const initialPlaceholder = input.placeholder;
  function say(text, undo) {
    for (const box of [q('msg'), q('panel-msg')]) {
      box.textContent = text || '';
      if (undo) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'linkish';
        b.textContent = T('ai-undo');
        b.addEventListener('click', () => {
          undo();
          dirty = true;
          filled = null;
          paint();
          say('');
        });
        box.appendChild(b);
      }
    }
  }
  async function call(path, method, data) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      headers['x-csrf-token'] = (await (await fetch('/api/v1/csrf')).json()).token;
      headers['idempotency-key'] = crypto.randomUUID();
    }
    const res = await fetch(path, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  }
  function snapshot() {
    if (current)
      drafts.set(current.id || 'new', {
        ...current,
        title: title.value,
        body: body.value,
        messages: [...messages],
        request: input.value,
        dirty,
      });
  }
  function renderList() {
    const needle = q('filter').value.trim().toLowerCase();
    const select = q('mobile-select');
    select.textContent = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = T('untitled');
    select.appendChild(empty);
    for (const [box, items, isBuiltin] of [
      [q('own'), own, false],
      [q('builtin'), builtin, true],
    ]) {
      box.textContent = '';
      for (const item of items) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.title;
        select.appendChild(option);
        if (needle && !(item.title + item.body).toLowerCase().includes(needle)) continue;
        const a = document.createElement('a');
        a.href = '#';
        a.className = 'th' + (current?.id === item.id ? ' on' : '');
        a.textContent = item.title;
        a.dataset.id = item.id;
        a.addEventListener('click', (e) => {
          e.preventDefault();
          switchTo(item, isBuiltin);
        });
        box.appendChild(a);
      }
    }
    select.value = current?.id || '';
  }
  function renderChat() {
    const chat = q('chat');
    chat.textContent = '';
    chat.hidden = !editing || !messages.length;
    for (const m of messages) {
      const row = document.createElement('div');
      row.className = m.role === 'user' ? 'u' : 'a';
      row.textContent = m.role === 'user' ? m.text : T('chat-result');
      if (m.role !== 'user') {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('class', 'i');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        const use = document.createElementNS(ns, 'use');
        use.setAttribute('href', '/icons.svg#i-sparkle');
        svg.appendChild(use);
        row.prepend(svg);
      }
      if (m.status === 'pending' || m.status === 'error') {
        const hint = document.createElement('span');
        hint.className = m.status === 'pending' ? 'lib-ai-working' : 'lib-chat-error';
        hint.textContent = T(m.status === 'pending' ? 'wait' : 'ai-failed');
        row.appendChild(hint);
        if (m.status === 'error') {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'chip';
          b.textContent = T('retry');
          b.disabled = busy;
          b.addEventListener('click', () => {
            input.value = m.text;
            askAi();
          });
          row.appendChild(b);
        }
      }
      chat.appendChild(row);
    }
  }
  function paint() {
    root.classList.toggle('lib-panel-open', editing);
    editor.hidden = !editing;
    q('resizer').hidden = !editing;
    q('empty').hidden = Boolean(current && (current.id || body.value || editing)) && !(editing && !messages.length);
    q('reading').hidden = editing || !current || !(current.id || title.value || body.value);
    q('reading-title').textContent = title.value;
    q('preview').textContent = filled ?? body.value;
    q('delete').hidden = !current?.id || current.builtin;
    input.placeholder = current?.id || body.value ? T('edit-placeholder') : initialPlaceholder;
    renderChat();
  }
  function open(item, isBuiltin) {
    if (busy) return;
    snapshot();
    const cached = drafts.get(item?.id || 'new');
    current = cached || (item ? { ...item, builtin: isBuiltin } : { id: null, builtin: false });
    title.value = current.title || '';
    body.value = current.body || '';
    messages = [...(current.messages || [])];
    input.value = current.request || '';
    dirty = Boolean(current.dirty);
    editing = false;
    filled = null;
    say('');
    paint();
    renderList();
  }
  function setBusy(on) {
    busy = on;
    for (const field of root.querySelectorAll('button, select, input, textarea')) field.disabled = on;
    editor.setAttribute('aria-busy', String(on));
  }
  async function action(fn) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (_) {
      say(T('save-failed'));
    } finally {
      setBusy(false);
      paint();
    }
  }
  async function save(quiet = false) {
    if (!body.value.trim()) {
      say(T('save-failed'));
      return false;
    }
    const update = current?.id && !current.builtin;
    const result = await call(
      '/work/api/templates' + (update ? '/' + encodeURIComponent(current.id) : ''),
      update ? 'PUT' : 'POST',
      { title: title.value.trim() || T('untitled'), body: body.value, messages },
    );
    if (!result.ok) {
      say(T('save-failed'));
      return false;
    }
    const oldKey = current?.id || 'new';
    current = { ...result.data, builtin: false };
    dirty = false;
    drafts.delete(oldKey);
    title.value = current.title;
    own = [result.data, ...own.filter((x) => x.id !== current.id)];
    renderList();
    if (!quiet) {
      editing = false;
      say(T(update ? 'saved' : 'saved-as-own'));
    }
    return true;
  }
  q('new').addEventListener('click', () => newItem());
  q('mobile-new').addEventListener('click', () => newItem());
  async function switchTo(item, isBuiltin) {
    if (busy) return;
    if (dirty && body.value.trim()) {
      setBusy(true);
      let saved = false;
      try {
        saved = await save(true);
      } catch (_) {
        say(T('save-failed'));
      } finally {
        setBusy(false);
      }
      if (!saved) return;
    }
    open(item, isBuiltin);
  }
  async function newItem() {
    await switchTo(null, false);
    input.focus();
  }
  q('filter').addEventListener('input', renderList);
  q('mobile-select').addEventListener('change', (e) => {
    const item = [...own, ...builtin].find((x) => x.id === e.target.value);
    if (item) switchTo(item, builtin.includes(item));
  });
  q('edit').addEventListener('click', () => {
    if (!current) current = { id: null, builtin: false };
    editing = true;
    filled = null;
    say('');
    paint();
    title.focus({ preventScroll: true });
    editorBody.scrollTop = 0;
  });
  for (const name of ['close', 'back', 'preview-toggle'])
    q(name).addEventListener('click', () => {
      editing = false;
      paint();
    });
  for (const field of [title, body])
    field.addEventListener('input', () => {
      dirty = true;
      filled = null;
    });
  q('save').addEventListener('click', () => action(() => save()));
  q('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(filled ?? body.value);
      say(T('copied'));
    } catch (_) {
      const selection = window.getSelection(),
        range = document.createRange();
      range.selectNodeContents(q('preview'));
      selection.removeAllRanges();
      selection.addRange(range);
      say(T('copy-failed'));
    }
  });
  q('delete').addEventListener('click', () =>
    action(async () => {
      if (!current?.id || current.builtin) return;
      const { ok } = await call('/work/api/templates/' + encodeURIComponent(current.id), 'DELETE');
      if (!ok) return say(T('save-failed'));
      own = own.filter((x) => x.id !== current.id);
      drafts.delete(current.id);
      current = null;
      title.value = '';
      body.value = '';
      messages = [];
      editing = false;
      filled = null;
      input.value = '';
      renderList();
      say(T('deleted'));
    }),
  );
  q('fill').addEventListener('click', () =>
    action(async () => {
      if (!q('patient').value) return;
      const { ok, data } = await call('/work/api/templates/patient/' + encodeURIComponent(q('patient').value), 'GET');
      if (!ok) return say(T('save-failed'));
      filled = body.value;
      for (const [key, value] of Object.entries(data)) if (value) filled = filled.split('[' + key + ']').join(value);
      editing = false;
      say(T('filled'));
    }),
  );
  async function askAi() {
    const request = input.value.trim();
    if (!request || busy) return;
    if (!current) current = { id: null, builtin: false };
    const previous = { title: title.value, body: body.value };
    const history = messages.filter((m) => m.status !== 'pending' && m.status !== 'error').slice(-12);
    setBusy(true);
    editing = true;
    filled = null;
    const pending = { role: 'user', text: request, status: 'pending' };
    messages.push(pending);
    paint();
    say(T('wait'));
    try {
      const { ok, data } = await call('/work/api/templates/ai', 'POST', { request, current: previous, history });
      if (!ok || !data.body) throw new Error('ai');
      body.value = data.body;
      if (!title.value.trim()) title.value = request.slice(0, 120);
      pending.status = 'done';
      messages.push({ role: 'assistant', text: T('chat-result'), status: 'done' });
      dirty = true;
      input.value = '';
      const persisted = await save(true);
      if (persisted)
        say(
          T('ai-done'),
          previous.body
            ? () => {
                title.value = previous.title;
                body.value = previous.body;
              }
            : null,
        );
    } catch (_) {
      pending.status = 'error';
      dirty = true;
      if (current.id && !current.builtin && body.value.trim()) {
        try {
          await save(true);
        } catch (_) {
          /* Keep the failed request and draft locally for retry. */
        }
      }
      say(T('ai-failed'));
    } finally {
      setBusy(false);
      paint();
      snapshot();
      editorBody.scrollTop = 0;
    }
  }
  q('ai').addEventListener('click', askAi);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      askAi();
    }
  });
  for (const b of root.querySelectorAll('[data-tpl-example]'))
    b.addEventListener('click', () => {
      input.value = b.textContent;
      input.focus();
    });
  const separator = q('resizer');
  let resizing = false;
  // Ширина правой панели: 46 % рабочей области, не меньше 520 и не больше 680.
  const resize = (value) => {
    const area = root.clientWidth - root.querySelector('.side').offsetWidth;
    const width = Math.max(520, Math.min(680, (area * value) / 100));
    root.style.setProperty('--lib-editor-width', width + 'px');
    separator.setAttribute('aria-valuenow', String(Math.round((width / area) * 100)));
  };
  separator.addEventListener('pointerdown', (e) => {
    resizing = true;
    separator.setPointerCapture(e.pointerId);
  });
  separator.addEventListener('pointermove', (e) => {
    if (resizing)
      resize(
        ((root.getBoundingClientRect().right - e.clientX) /
          (root.clientWidth - root.querySelector('.side').offsetWidth)) *
          100,
      );
  });
  for (const ev of ['pointerup', 'pointercancel'])
    separator.addEventListener(ev, () => {
      resizing = false;
    });
  separator.addEventListener('keydown', (e) => {
    if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      resize(Number(separator.getAttribute('aria-valuenow')) + (e.key === 'ArrowLeft' ? 4 : -4));
    }
  });
  window.addEventListener('resize', () => resize(Number(separator.getAttribute('aria-valuenow'))));
  window.addEventListener('beforeunload', (e) => {
    if (dirty || busy) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  async function init() {
    try {
      const { ok, data } = await call('/work/api/templates', 'GET');
      if (!ok) throw new Error('load');
      own = data.own || [];
      builtin = data.builtin || [];
      renderList();
      const raw = sessionStorage.getItem('cc.doc_prefill');
      sessionStorage.removeItem('cc.doc_prefill');
      const text = String((raw && JSON.parse(raw).text) || '').trim();
      if (text) {
        open(null, false);
        title.value = text.split('\n')[0].slice(0, 120);
        body.value = text;
        editing = true;
        dirty = true;
        say(T('from-chat'));
      }
    } catch (_) {
      say(T('save-failed'));
    }
    resize(46);
    paint();
  }
  init();
})();
