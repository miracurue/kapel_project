'use strict';
// Templates use the article workspace layout; patient-filled copies never enter saved drafts or AI context.
// Вкладка «Шаблоны и документы»: здесь шаблоны и переключатель режима; документы по пациентам — work_documents.js.
(function () {
  const root = document.querySelector('[data-work-docs]');
  if (!root) return;
  const T = (name) =>
    root.dataset['t' + name.charAt(0).toUpperCase() + name.slice(1).replace(/-(\w)/g, (_, c) => c.toUpperCase())] || '';
  const q = (name) => root.querySelector('[data-tpl-' + name + ']');
  let docTexts = {};
  try {
    docTexts = JSON.parse(root.parentNode.querySelector('[data-doc-i18n]')?.textContent || '{}');
  } catch (_) {
    /* Подписи формы необязательны для работы шаблонов. */
  }
  const DT = (name) => docTexts['msg.doc.' + name] || '';
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
    filled = null,
    filledFor = null,
    mode = 'templates';
  const drafts = new Map();
  const initialPlaceholder = input.placeholder;
  const viewTpl = q('view-tpl') || root.querySelector('[data-view-tpl]');
  const viewDoc = root.querySelector('[data-view-doc]');
  const dock = root.querySelector('[data-dock]');
  const formView = root.querySelector('[data-tpl-form]');
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
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
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
  // Один список «Шаблоны»: сначала свои, потом встроенные с пометкой.
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
        a.className = 'th' + (isBuiltin ? ' th-builtin' : '') + (current?.id === item.id ? ' on' : '');
        a.dataset.id = item.id;
        if (current?.id === item.id) a.setAttribute('aria-current', 'true');
        a.append(item.title);
        if (isBuiltin) {
          const mark = document.createElement('small');
          mark.textContent = T('builtin') + (item.kind === 'form' ? ' · ' + DT('form_tag').toLowerCase() : '');
          a.appendChild(mark);
        }
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
      row.textContent = m.role === 'user' || m.status === 'notice' ? m.text : T('chat-result');
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
    const inTemplates = mode === 'templates';
    const isForm = Boolean(current?.kind === 'form');
    root.classList.toggle('lib-panel-open', editing && inTemplates);
    editor.hidden = !editing || !inTemplates;
    q('resizer').hidden = !editing || !inTemplates;
    q('empty').hidden = Boolean(current && (current.id || body.value || editing)) && !(editing && !messages.length);
    q('reading').hidden = isForm || editing || !current || !(current.id || title.value || body.value);
    q('reading-title').textContent = title.value;
    q('preview').textContent = filled ?? body.value;
    q('delete').hidden = !current?.id || current.builtin;
    q('builtin-tag').hidden = !current?.builtin;
    const saveDoc = q('save-doc');
    if (saveDoc) saveDoc.hidden = filled === null || !filledFor;
    if (formView) {
      formView.hidden = !isForm;
      formView.querySelector('[data-tpl-form-title]').textContent = isForm ? current.title : '';
    }
    if (dock) dock.hidden = !inTemplates || isForm;
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
    const scope = '[data-view-tpl],[data-tpl-editor],[data-pane-templates],[data-dock],[data-tpl-mobile]';
    for (const field of root.querySelectorAll(
      scope
        .split(',')
        .map((x) => x + ' :is(button,select,input,textarea)')
        .join(','),
    ))
      field.disabled = on;
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
  for (const name of ['close', 'preview-toggle'])
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
      filledFor = Number(q('patient').value);
      editing = false;
      say(T('filled'));
    }),
  );
  // «Сохранить как документ»: подставленный текст — документом пациента; сам шаблон не меняется.
  const saveDocButton = q('save-doc');
  if (saveDocButton)
    saveDocButton.addEventListener('click', () =>
      action(async () => {
        if (filled === null || !filledFor) return;
        const { ok } = await call('/work/api/documents/from-text', 'POST', {
          patient_id: filledFor,
          title: title.value.trim() || T('untitled'),
          body: filled,
        });
        say(ok ? DT('saved_as_doc') : DT('save_as_doc_failed'));
        if (ok) root.dispatchEvent(new CustomEvent('docs:created'));
      }),
    );
  async function askAi() {
    const request = input.value.trim();
    if (!request || busy) return;
    if (!current) current = { id: null, builtin: false };
    const previous = { title: title.value, body: body.value };
    const history = messages.filter((m) => !['pending', 'error', 'notice'].includes(m.status)).slice(-12);
    setBusy(true);
    editing = true;
    filled = null;
    const pending = { role: 'user', text: request, status: 'pending' };
    messages.push(pending);
    paint();
    say(T('wait'));
    try {
      const { ok, data } = await call('/work/api/templates/ai', 'POST', { request, current: previous, history });
      // Нецелевой запрос: сообщение сервера в чате, шаблон не меняется и не сохраняется (в историю и на сервер не уходит).
      if (ok && data.off_topic) {
        pending.status = 'notice';
        messages.push({ role: 'assistant', text: data.message, status: 'notice' });
        input.value = '';
        say('');
        return;
      }
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
  // Режим вкладки: «Шаблоны» (редактор и ИИ) или «Документы» (заполненные бланки по пациентам).
  function setMode(next) {
    if (next === mode || busy || (next === 'documents' && !viewDoc)) return;
    mode = next;
    editing = false;
    root.dataset.mode = mode;
    viewTpl.hidden = mode !== 'templates';
    if (viewDoc) viewDoc.hidden = mode !== 'documents';
    for (const [name, on] of [
      ['pane-templates', mode === 'templates'],
      ['pane-documents', mode === 'documents'],
      ['tpl-mobile', mode === 'templates'],
      ['doc-mobile', mode === 'documents'],
    ]) {
      const box = root.querySelector('[data-' + name + ']');
      if (box) box.hidden = !on;
    }
    for (const b of root.querySelectorAll('[data-doc-seg] [data-doc-mode]'))
      b.setAttribute('aria-pressed', String(b.dataset.docMode === mode));
    paint();
    root.dispatchEvent(new CustomEvent('docs:mode', { detail: { mode } }));
  }
  for (const b of root.querySelectorAll('[data-doc-mode]'))
    b.addEventListener('click', () => setMode(b.dataset.docMode));
  root.docsApi = { call, setMode, text: DT, mode: () => mode };

  async function init() {
    try {
      const { ok, data } = await call('/work/api/templates', 'GET');
      if (!ok) throw new Error('load');
      own = data.own || [];
      builtin = data.builtin || [];
      renderList();
    } catch (_) {
      say(T('save-failed'));
    }
    resize(46);
    paint();
  }
  init();
})();
