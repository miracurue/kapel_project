'use strict';

/**
 * «Мои статьи»: переписка автора в центре, изменяемый по ширине редактор справа.
 * Предпросмотр показывается в центре. Черновик сохраняется отдельно от публичной версии;
 * публикация обновляется только явным действием автора. API — /work/api/library*.
 */
(function () {
  const root = document.querySelector('[data-work-library]');
  if (!root) return;
  const T = (name) => root.dataset['t' + name.replace(/(^|[-.])(\w)/g, (_, __, c) => c.toUpperCase())] || '';
  const q = (sel) => root.querySelector(sel);
  const el = {
    reading: q('[data-lib-reading]'),
    resizer: q('[data-lib-resizer]'),
    mine: q('[data-lib-mine]'),
    pub: q('[data-lib-pub]'),
    gapsBox: q('[data-lib-gaps-box]'),
    gaps: q('[data-lib-gaps]'),
    filter: q('[data-lib-filter]'),
    empty: q('[data-lib-empty]'),
    editor: q('[data-lib-editor]'),
    cover: q('[data-lib-cover]'),
    coverImg: q('[data-lib-cover-img]'),
    status: q('[data-lib-status]'),
    byline: q('[data-lib-byline]'),
    title: q('[data-lib-title]'),
    summary: q('[data-lib-summary]'),
    body: q('[data-lib-body]'),
    preview: q('[data-lib-preview]'),
    tags: q('[data-lib-tags]'),
    tagChips: q('[data-lib-tagchips]'),
    doc: q('[data-lib-doc]'),
    docLabel: q('[data-lib-doc-label]'),
    textToggle: q('[data-lib-text-toggle]'),
    publish: q('[data-lib-publish]'),
    save: q('[data-lib-save]'),
    unpublish: q('[data-lib-unpublish]'),
    edit: q('[data-lib-edit]'),
    fields: q('[data-lib-fields]'),
    tagbox: q('[data-lib-tagbox]'),
    hint: q('[data-lib-hint]'),
    chat: q('[data-lib-chat]'),
    coverFile: q('[data-lib-cover-file]'),
    imageFile: q('[data-lib-image-file]'),
    msg: q('[data-lib-msg]'),
    aiInput: q('[data-lib-ai-input]'),
    aiBtn: q('[data-lib-ai]'),
    audBtns: [...root.querySelectorAll('[data-lib-aud-btn]')],
    rw: q('[data-lib-rw]'),
    rwQuote: q('[data-lib-rw-quote]'),
    rwTask: q('[data-lib-rw-task]'),
    rwGo: q('[data-lib-rw-go]'),
    rwResult: q('[data-lib-rw-result]'),
    rwText: q('[data-lib-rw-text]'),
    rwReplace: q('[data-lib-rw-replace]'),
    rwDiscard: q('[data-lib-rw-discard]'),
  };

  const editorBody = () => el.editor.querySelector('.panel-body');

  let mine = [];
  // current: { id, status, cover_file_id, cover_url, ai_assisted, audience }
  let current = null;
  // Журнал, для которого пишется статья: patient | specialist (определяет промпт ИИ и раздел публикации).
  let audience = 'patient';
  // Режим своей статьи: просмотр (как увидит читатель) или редактирование. Открытие и «Сохранить» — просмотр,
  // новая статья, «Редактировать» и сообщение в чат ИИ — редактирование.
  let editing = false;
  let busy = false;
  let previewing = false;
  let dirty = false;
  // Текст в панели: по умолчанию как у читателя; «Править текст» открывает поле с разметкой.
  let sourceMode = false;

  async function call(path, method, body) {
    try {
      const headers = { Accept: 'application/json' };
      if (method !== 'GET') {
        headers['idempotency-key'] = crypto.randomUUID();
        headers['content-type'] = 'application/json';
        headers['x-csrf-token'] = (await (await fetch('/api/v1/csrf')).json()).token;
      }
      const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch (_) {
      return { ok: false, status: 0, data: {} };
    }
  }

  function say(text, undo, undoLabel) {
    paintDoc();
    paintTags();
    el.msg.textContent = text || '';
    q('[data-lib-panel-msg]').textContent = text || '';
    if (undo !== undefined && undo !== null) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'linkish';
      b.textContent = ' ' + (undoLabel || T('ai.undo'));
      b.addEventListener('click', () => {
        undo();
        say('');
      });
      el.msg.appendChild(b);
      const panelButton = b.cloneNode(true);
      panelButton.addEventListener('click', () => {
        undo();
        say('');
      });
      q('[data-lib-panel-msg]').appendChild(panelButton);
    }
  }

  // Тема и препарат показываются метками, а не строкой «препарат:сертралин».
  function tagLabel(tag) {
    const m = /^(препарат|тема)\s*:\s*(.+)$/i.exec(tag);
    if (!m) return tag;
    const v = m[2].replace(/-/g, ' ');
    return T(m[1].toLowerCase() === 'препарат' ? 'tag.drug' : 'tag.theme').replace('{v}', v);
  }
  function paintTags() {
    el.tagChips.textContent = '';
    for (const tag of tagList()) {
      const c = document.createElement('span');
      c.className = 'chip chip--ctx';
      c.textContent = tagLabel(tag);
      el.tagChips.appendChild(c);
    }
    el.tagChips.hidden = !el.tagChips.children.length;
  }
  // Текст статьи так, как его увидит читатель: без знаков разметки.
  function paintDoc() {
    el.doc.textContent = '';
    if (!el.body.value.trim()) {
      const p = document.createElement('p');
      p.className = 'lib-doc-empty';
      p.textContent = T('doc.empty');
      el.doc.appendChild(p);
    } else {
      el.doc.appendChild(window.CCMarkdown.render(el.body.value));
    }
  }
  function paintSource() {
    const on = sourceMode;
    el.body.hidden = !on;
    el.doc.hidden = on;
    el.hint.hidden = !on;
    el.docLabel.textContent = T(on ? 'doc.src_label' : 'doc.reader');
    el.textToggle.textContent = T(on ? 'doc.reader.btn' : 'doc.source');
    el.textToggle.setAttribute('aria-pressed', String(on));
    if (!on) hideRewrite();
  }
  el.textToggle.addEventListener('click', () => {
    sourceMode = !sourceMode;
    paintSource();
    if (sourceMode) el.body.focus();
    else paintDoc();
  });

  const tagList = () =>
    el.tags.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  // ---------- аудитория ----------

  function paintAudience() {
    const previewLabel = T(audience === 'specialist' ? 'preview.specialist' : 'preview.on');
    q('[data-lib-preview-toggle]').textContent = previewLabel;
    q('[data-lib-preview-label]').textContent = previewLabel;
    const locked = Boolean(current && current.id && current.status === 'published');
    for (const b of el.audBtns) {
      b.setAttribute('aria-pressed', b.dataset.libAudBtn === audience ? 'true' : 'false');
      b.disabled = locked || busy;
      b.title = locked ? T('audience.locked') : '';
    }
    el.publish.textContent = current && current.status === 'published' ? T('publish.update') : T('publish.' + audience);
  }

  for (const b of el.audBtns) {
    b.addEventListener('click', () => {
      audience = b.dataset.libAudBtn;
      if (current) current.audience = audience;
      paintAudience();
    });
  }

  // ---------- список слева ----------

  function row(item) {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'th' + (current && current.id === item.id ? ' on' : '');
    a.dataset.id = String(item.id);
    const name = document.createElement('span');
    name.textContent = item.title || '—';
    a.appendChild(name);
    const small = document.createElement('small');
    small.className = 'lib-row-sub';
    const aud = T('audience.' + (item.audience || 'patient'));
    small.textContent = `${T('status.' + item.status)} · ${aud}`;
    small.dataset.status = item.status;
    a.appendChild(document.createElement('br'));
    a.appendChild(small);
    a.addEventListener('click', (e) => {
      e.preventDefault();
      open(item.id);
    });
    return a;
  }

  function renderList() {
    const mobileSelect = q('[data-lib-mobile-select]');
    mobileSelect.replaceChildren(new Option(T('new.hint').split('.')[0], ''));
    for (const item of mine) mobileSelect.appendChild(new Option(item.title, item.id));
    mobileSelect.value = current && current.id ? String(current.id) : '';
    const needle = el.filter.value.trim().toLowerCase();
    const keep = (m) =>
      !needle || String(m.title).toLowerCase().includes(needle) || (m.tags || []).join(' ').includes(needle);
    const shown = mine.filter(keep);
    const lists = [
      [el.pub, shown.filter((m) => m.status === 'published')],
      [el.mine, shown.filter((m) => m.status !== 'published')],
    ];
    for (const [box, items] of lists) {
      const empty = box === el.pub ? T('none.published') : T('none');
      box.textContent = '';
      if (!items.length) {
        const p = document.createElement('p');
        p.className = 'small muted';
        p.textContent = needle ? '' : empty;
        box.appendChild(p);
      }
      for (const m of items) box.appendChild(row(m));
    }
  }

  async function load() {
    const { ok, data } = await call('/work/api/library', 'GET');
    if (ok) {
      mine = data.mine || [];
      renderList();
    }
    const gaps = await call('/work/api/library/gaps', 'GET');
    if (gaps.ok && (gaps.data.gaps || []).length) {
      el.gapsBox.hidden = false;
      el.gaps.textContent = '';
      for (const g of gaps.data.gaps) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = `${g.inn} · ${T('gaps.patients').replace('{n}', g.patients)}`;
        b.addEventListener('click', () => newItem(g.inn));
        el.gaps.appendChild(b);
      }
    }
  }

  // ---------- редактор ----------

  function paintStatus() {
    const status = current && current.id ? current.status : 'draft';
    el.status.textContent = '';
    const ns = 'http://www.w3.org/2000/svg';
    const icon = document.createElementNS(ns, 'svg');
    icon.setAttribute('class', 'i');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '/icons.svg#i-' + (status === 'published' ? 'check-circle' : 'note-pencil'));
    icon.appendChild(use);
    el.status.append(
      icon,
      T('status.' + status) + (current && current.has_unpublished_changes ? ' · ' + T('status.changes') : ''),
    );
    el.status.classList.toggle('ok', status === 'published');
    el.status.classList.toggle('warn', status === 'withdrawn');
    el.status.dataset.status = status;
    el.publish.hidden = false;
    el.unpublish.hidden = status !== 'published';
    paintAudience();
    el.byline.textContent =
      T('byline').replace('{name}', root.dataset.author).replace('{role}', root.dataset.role) +
      (current && current.ai_assisted ? ' · ✦' : '');
  }

  function paintCover() {
    const url = current && current.cover_url;
    el.cover.hidden = !url;
    if (url) el.coverImg.src = url;
    else el.coverImg.removeAttribute('src');
    q('[data-lib-cover-label]').textContent = T(url ? 'cover.change' : 'cover.add');
  }

  // Применяет режим: чужая статья (current === null) всегда только чтение.
  function applyMode() {
    el.empty.hidden = Boolean(current && (current.id || el.body.value || editing)) && !(editing && !chatLog.length);
    el.editor.hidden = !editing;
    el.chat.hidden = !editing || !chatLog.length;
    el.resizer.hidden = !editing;
    root.classList.toggle('lib-panel-open', editing);
    el.reading.hidden = !current || (!current.id && !el.title.value && !el.body.value) || (editing && !previewing);
    if (!el.reading.hidden) setPreview(true);
    el.fields.hidden = false;
    el.tagbox.hidden = false;
    el.edit.hidden = false;
    el.save.hidden = false;
    paintSource();
    paintDoc();
    paintTags();
    el.aiInput.placeholder = current && current.id ? T('ai.placeholder.edit') : root.dataset.initialPlaceholder;
    paintStatus();
  }

  function fill(data) {
    current = {
      id: data.id,
      has_unpublished_changes: data.has_unpublished_changes,
      status: data.status,
      cover_file_id: data.cover_file_id || null,
      cover_url: data.cover_url || null,
      ai_assisted: Boolean(data.ai_assisted),
      audience: data.audience || 'patient',
    };
    audience = current.audience;
    hideRewrite();
    el.title.value = data.title && data.title !== 'Без названия' ? data.title : '';
    el.summary.value = data.summary || '';
    el.body.value = data.body_md || '';
    el.tags.value = (data.tags || []).join(', ');
    dirty = false;
    previewing = false;
    editing = false;
    applyMode();
    paintCover();
    renderList();
  }

  async function open(id) {
    if (busy) return;
    if (current && dirty && !(await save(true))) return;
    const { ok, data } = await call('/work/api/library/' + id, 'GET');
    if (!ok) return;
    fill(data);
    chatLog = [];
    renderChat();
    loadChat(id);
    say('');
    history.replaceState(null, '', '/work?tab=library&id=' + id);
  }

  async function newItem(inn) {
    if (busy) return;
    if (current && dirty && !(await save(true))) return;
    current = { id: null, status: 'draft', cover_file_id: null, cover_url: null, ai_assisted: false, audience };
    if (inn) {
      audience = 'patient';
      current.audience = audience;
    }
    hideRewrite();
    el.title.value = '';
    el.summary.value = '';
    el.body.value = '';
    el.tags.value = inn ? `препарат:${inn}, тема:первые-недели` : '';
    el.aiInput.value = inn
      ? `Первые недели приёма ${inn}: что может беспокоить, как себе помочь, когда написать врачу`
      : '';
    editing = false;
    previewing = false;
    dirty = false;
    chatLog = [];
    renderChat();
    applyMode();
    paintCover();
    say('');
    renderList();
    history.replaceState(null, '', '/work?tab=library');
    el.aiInput.focus();
  }

  function payload() {
    return {
      title: el.title.value.trim(),
      summary: el.summary.value.trim(),
      body_md: el.body.value,
      tags: tagList(),
      ai_assisted: current ? current.ai_assisted : false,
      audience,
    };
  }

  // Сохраняет (создаёт черновик при первом сохранении); возвращает true при успехе.
  async function save(quiet) {
    if (!current) return false;
    const { ok, data } = current.id
      ? await call('/work/api/library/' + current.id, 'PUT', payload())
      : await call('/work/api/library', 'POST', payload());
    if (!ok) {
      say(T('save.failed'));
      return false;
    }
    const wasNew = !current.id;
    dirty = false;
    current.id = data.id;
    current.status = data.status;
    current.has_unpublished_changes = data.has_unpublished_changes;
    current.cover_file_id = data.cover_file_id || null;
    current.cover_url = data.cover_url || null;
    const summary = { id: data.id, status: data.status, audience: data.audience, title: data.title, tags: data.tags };
    mine = [summary, ...mine.filter((m) => m.id !== data.id)];
    if (wasNew) history.replaceState(null, '', '/work?tab=library&id=' + data.id);
    paintStatus();
    renderList();
    if (!quiet) {
      // «Сохранить» показывает статью так, как её увидит читатель.
      editing = false;
      previewing = false;
      applyMode();
      say(T('saved'));
      q('.pane > .scroll').scrollTop = 0;
    }
    return true;
  }

  function setBusy(on) {
    busy = on;
    for (const b of root.querySelectorAll('button,input[type=file],select')) b.disabled = on;
    for (const field of [el.title, el.summary, el.body, el.tags]) field.readOnly = on;
    paintAudience();
  }
  async function action(fn) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (_) {
      say(T('save.failed'));
    } finally {
      setBusy(false);
    }
  }
  el.save.addEventListener('click', () => action(() => save(false)));
  el.edit.addEventListener('click', () => {
    editing = true;
    previewing = false;
    applyMode();
    editorBody().scrollTop = 0;
    el.title.focus({ preventScroll: true });
  });

  el.publish.addEventListener('click', () =>
    action(async () => {
      if (!el.title.value.trim() || !el.body.value.trim()) return say(T('publish.need'));
      if (!(await save(true))) return;
      const { ok } = await call('/work/api/library/' + current.id + '/publish', 'POST', {});
      if (!ok) return say(T('publish.need'));
      current.status = 'published';
      current.has_unpublished_changes = false;
      mine = mine.map((m) => (m.id === current.id ? { ...m, status: 'published' } : m));
      editing = false;
      applyMode();
      renderList();
      say(audience === 'specialist' ? T('published.specialist') : T('published'));
    }),
  );

  el.unpublish.addEventListener('click', () =>
    action(async () => {
      if (!current || !current.id) return;
      const { ok } = await call('/work/api/library/' + current.id + '/unpublish', 'POST', {});
      if (!ok) return;
      current.status = 'withdrawn';
      mine = mine.map((m) => (m.id === current.id ? { ...m, status: 'withdrawn' } : m));
      paintStatus();
      renderList();
      say(T('unpublished'));
    }),
  );

  // ---------- предпросмотр ----------

  function setPreview(on) {
    if (on) hideRewrite();
    el.preview.hidden = !on;
    if (on) {
      el.preview.textContent = '';
      const h = document.createElement('h2');
      h.className = 'lib-title';
      h.textContent = el.title.value;
      if (current && current.cover_url) {
        const img = document.createElement('img');
        img.src = current.cover_url;
        img.alt = '';
        el.preview.appendChild(img);
      }
      el.preview.appendChild(h);
      if (el.summary.value) {
        const lead = document.createElement('p');
        lead.className = 'lib-lead';
        lead.textContent = el.summary.value;
        el.preview.appendChild(lead);
      }
      el.preview.appendChild(window.CCMarkdown.render(el.body.value));
      const foot = document.createElement('p');
      foot.className = 'muted small';
      foot.textContent = el.byline.textContent + ' · ' + T('disclaimer');
      el.preview.appendChild(foot);
    }
  }

  // ---------- картинки ----------

  async function uploadImage(file) {
    if (!(await save(true))) return null;
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('purpose', 'chat');
    const token = (await (await fetch('/api/v1/csrf')).json()).token;
    const res = await fetch('/api/v1/uploads', {
      method: 'POST',
      headers: { 'x-csrf-token': token, 'idempotency-key': crypto.randomUUID() },
      body: fd,
    });
    const up = await res.json().catch(() => ({}));
    if (!res.ok || !up.id) return null;
    const attached = await call('/work/api/library/' + current.id + '/image', 'POST', { upload_id: up.id });
    return attached.ok ? attached.data : null;
  }

  el.coverFile.addEventListener('change', () =>
    action(async () => {
      const file = el.coverFile.files[0];
      el.coverFile.value = '';
      if (!file) return;
      say(T('cover.uploading'));
      const img = await uploadImage(file);
      if (!img) return say(T('upload.failed'));
      const { ok, data } = await call('/work/api/library/' + current.id, 'PUT', { cover_file_id: img.file_id });
      if (!ok) return say(T('upload.failed'));
      current.cover_file_id = data.cover_file_id;
      current.cover_url = data.cover_url;
      current.has_unpublished_changes = data.has_unpublished_changes;
      paintCover();
      paintStatus();
      say(T('cover.added'));
      editorBody().scrollTop = 0;
    }),
  );

  el.imageFile.addEventListener('change', () =>
    action(async () => {
      const file = el.imageFile.files[0];
      el.imageFile.value = '';
      if (!file) return;
      const img = await uploadImage(file);
      if (!img) return say(T('upload.failed'));
      const at = el.body.selectionStart ?? el.body.value.length;
      el.body.value = el.body.value.slice(0, at) + '\n\n' + img.markdown + '\n\n' + el.body.value.slice(at);
      await save(true);
      say(T('saved'));
    }),
  );

  // ---------- беседа с ИИ по статье ----------

  let chatLog = []; // [{ role: 'user' | 'assistant', text }]

  function sparkle() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'i');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '/icons.svg#i-sparkle');
    svg.appendChild(use);
    return svg;
  }
  function renderChat() {
    el.chat.textContent = '';
    el.chat.hidden = !editing || !chatLog.length;
    for (const m of chatLog) {
      const d = document.createElement('div');
      d.className = m.role === 'user' ? 'u' : 'a';
      d.textContent = m.role === 'user' || m.status === 'notice' ? m.text : T('chat.ai');
      if (m.role !== 'user') d.prepend(sparkle());
      if (m.status === 'error') {
        const err = document.createElement('span');
        err.className = 'lib-chat-error';
        err.textContent = T('ai.failed');
        d.appendChild(err);
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'chip';
        retry.textContent = T('ai.retry');
        retry.disabled = busy;
        retry.addEventListener('click', () => {
          el.aiInput.value = m.text;
          askAi();
        });
        d.appendChild(retry);
      }
      if (m.status === 'pending') {
        const wait = document.createElement('span');
        wait.className = 'lib-ai-working';
        wait.textContent = T('ai.wait');
        d.appendChild(wait);
      }
      el.chat.appendChild(d);
    }
    el.chat.scrollTop = el.chat.scrollHeight;
  }

  async function loadChat(id) {
    const { ok, data } = await call('/work/api/library/' + id + '/chat', 'GET');
    if (ok && current && current.id === id) {
      chatLog = data.messages || [];
      renderChat();
    }
  }

  // ---------- ИИ ----------

  async function askAi() {
    const thoughts = el.aiInput.value.trim();
    if (!thoughts || busy) return;
    if (!current) {
      await newItem(null);
      el.aiInput.value = thoughts;
    }
    setBusy(true);
    editing = true;
    previewing = false;
    applyMode();
    const idleLabel = el.aiBtn.textContent;
    el.aiBtn.disabled = true;
    el.aiInput.disabled = true;
    el.aiBtn.textContent = T('ai.busy');
    el.editor.setAttribute('aria-busy', 'true');
    // Prevent concurrent manual edits from being replaced by a returning AI response.
    for (const field of [el.title, el.summary, el.body, el.tags]) field.readOnly = true;
    for (const b of el.editor.querySelectorAll('button,input[type=file]')) b.disabled = true;
    try {
      say(T('ai.wait'));
      if (!(await save(true))) throw new Error('save');
      const previous = { title: el.title.value, summary: el.summary.value, body: el.body.value, tags: el.tags.value };
      chatLog.push({ role: 'user', text: thoughts, status: 'pending' });
      renderChat();
      const { ok, data } = await call('/work/api/library/ai', 'POST', {
        thoughts,
        audience,
        item_id: current.id,
        current: { title: el.title.value.trim(), body_md: el.body.value },
      });
      // Нецелевой запрос: сообщение сервера в чате, статья не меняется, попытка на сервере не сохранена.
      if (ok && data.off_topic) {
        chatLog[chatLog.length - 1].status = 'notice';
        chatLog.push({ role: 'assistant', text: data.message, status: 'notice' });
        el.aiInput.value = '';
        say('');
        return;
      }
      if (!ok || !data.body_md) throw new Error('ai');
      el.title.value = data.title || el.title.value;
      el.summary.value = data.summary || '';
      el.body.value = data.body_md;
      el.tags.value = (data.tags || []).join(', ');
      current.ai_assisted = true;
      current.has_unpublished_changes = current.status === 'published';
      dirty = false; // The server persisted the successful generated version.
      el.aiInput.value = '';
      await loadChat(current.id);
      await load();
      const hadText = previous.body.trim() || previous.title.trim();
      say(
        T('ai.done'),
        hadText
          ? () => {
              el.body.value = previous.body;
              el.title.value = previous.title;
              el.summary.value = previous.summary;
              el.tags.value = previous.tags;
              dirty = true;
            }
          : null,
      );
    } catch (_) {
      say(T('ai.failed'));
      if (current && current.id) await loadChat(current.id);
    } finally {
      setBusy(false);
      el.aiBtn.disabled = false;
      el.aiInput.disabled = false;
      el.aiBtn.textContent = idleLabel;
      el.editor.removeAttribute('aria-busy');
      for (const field of [el.title, el.summary, el.body, el.tags]) field.readOnly = false;
      for (const b of el.editor.querySelectorAll('button,input[type=file]')) b.disabled = false;
      applyMode();
      editorBody().scrollTop = 0;
      renderChat();
    }
  }
  el.aiBtn.addEventListener('click', askAi);
  el.aiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      askAi();
    }
  });

  // ---------- правка выделенного ----------
  // Выделение запоминается: пока автор печатает задание в своём поле, textarea теряет фокус, но диапазон остаётся.

  let sel = null; // { start, end, text }

  function hideRewrite() {
    sel = null;
    el.rw.hidden = true;
    el.rwResult.hidden = true;
  }

  function checkSelection() {
    if (el.body.hidden || el.body.readOnly) return;
    const start = el.body.selectionStart;
    const end = el.body.selectionEnd;
    if (start === end) return; // клик в тексте не закрывает панель: можно дописать задание и отправить
    const text = el.body.value.slice(start, end);
    if (!text.trim()) return;
    if (sel && sel.start === start && sel.end === end) return;
    sel = { start, end, text };
    el.rwQuote.textContent = text.length > 300 ? text.slice(0, 300) + '…' : text;
    el.rwResult.hidden = true;
    el.rw.hidden = false;
  }
  for (const ev of ['mouseup', 'keyup', 'select', 'touchend'])
    el.body.addEventListener(ev, () => setTimeout(checkSelection, 0));

  async function rewrite(task) {
    if (!sel || busy) return;
    setBusy(true);
    const mark = { ...sel };
    const idleLabel = el.rwGo.textContent;
    el.rwGo.disabled = true;
    el.rwGo.textContent = T('rw.busy');
    say(T('rw.wait'));
    try {
      const { ok, data } = await call('/work/api/library/ai/rewrite', 'POST', {
        audience,
        fragment: mark.text,
        instruction: task,
        context_before: el.body.value.slice(0, mark.start),
        context_after: el.body.value.slice(mark.end),
      });
      if (ok && data.off_topic) return say(data.message);
      if (!ok || !data.text) return say(T('rw.failed'));
      say('');
      sel = mark;
      el.rwText.textContent = data.text;
      el.rwResult.hidden = false;
    } catch (_) {
      say(T('rw.failed'));
    } finally {
      setBusy(false);
      el.rwGo.disabled = false;
      el.rwGo.textContent = idleLabel;
    }
  }
  el.rwGo.addEventListener('click', () => rewrite(el.rwTask.value.trim()));
  el.rwTask.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      rewrite(el.rwTask.value.trim());
    }
  });
  for (const b of root.querySelectorAll('[data-lib-rw-quick]')) {
    b.addEventListener('click', () => {
      const key = b.dataset.libRwQuick;
      const task = key ? T('rw.' + key + '.task') : '';
      el.rwTask.value = task;
      rewrite(task);
    });
  }
  el.rwDiscard.addEventListener('click', () => {
    el.rwResult.hidden = true;
    el.body.focus();
  });
  el.rwReplace.addEventListener('click', () => {
    if (!sel) return;
    const text = el.rwText.textContent;
    const before = el.body.value;
    // Текст могли править, пока ждали ответ: ищем фрагмент на прежнем месте, иначе — первое совпадение.
    let at = before.slice(sel.start, sel.end) === sel.text ? sel.start : before.indexOf(sel.text);
    if (at < 0) return say(T('rw.failed'));
    el.body.value = before.slice(0, at) + text + before.slice(at + sel.text.length);
    dirty = true;
    el.body.setSelectionRange(at, at + text.length);
    current = current || {
      id: null,
      status: 'draft',
      cover_file_id: null,
      cover_url: null,
      ai_assisted: false,
      audience,
    };
    current.ai_assisted = true;
    paintStatus();
    el.rwTask.value = '';
    hideRewrite();
    say(
      T('rw.done'),
      () => {
        el.body.value = before;
        dirty = true;
      },
      T('rw.undo'),
    );
    el.body.focus();
  });

  q('[data-lib-mobile-select]').addEventListener('change', (e) => {
    if (e.target.value) open(Number(e.target.value));
  });
  q('[data-lib-mobile-new]').addEventListener('click', () => newItem(null));
  q('[data-lib-new]').addEventListener('click', () => newItem(null));
  el.filter.addEventListener('input', renderList);

  root.dataset.initialPlaceholder = el.aiInput.placeholder;
  for (const field of [el.title, el.summary, el.body, el.tags])
    field.addEventListener('input', () => {
      dirty = true;
    });
  for (const b of root.querySelectorAll('[data-lib-close]'))
    b.addEventListener('click', () => {
      editing = false;
      previewing = false;
      applyMode();
    });
  q('[data-lib-preview-toggle]').addEventListener('click', () => {
    previewing = true;
    editing = false;
    applyMode();
  });
  for (const b of root.querySelectorAll('[data-lib-example]'))
    b.addEventListener('click', () => {
      el.aiInput.value = b.textContent;
      el.aiInput.focus();
    });
  let resizing = false;
  // Ширина правой панели: 46 % рабочей области, не меньше 520 и не больше 680.
  const resize = (percent) => {
    const area = root.clientWidth - q('.side').offsetWidth;
    const width = Math.max(520, Math.min(680, (area * percent) / 100));
    root.style.setProperty('--lib-editor-width', width + 'px');
    el.resizer.setAttribute('aria-valuenow', String(Math.round((width / area) * 100)));
  };
  el.resizer.addEventListener('pointerdown', (e) => {
    resizing = true;
    el.resizer.setPointerCapture(e.pointerId);
  });
  el.resizer.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const rect = root.getBoundingClientRect();
    resize(((rect.right - e.clientX) / (rect.width - q('.side').offsetWidth)) * 100);
  });
  el.resizer.addEventListener('pointerup', () => {
    resizing = false;
  });
  el.resizer.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    resize(Number(el.resizer.getAttribute('aria-valuenow')) + (e.key === 'ArrowLeft' ? 4 : -4));
  });
  resize(46);
  window.addEventListener('resize', () => resize(Number(el.resizer.getAttribute('aria-valuenow'))));
  paintAudience();
  load().then(() => {
    const id = Number(new URLSearchParams(location.search).get('id'));
    if (id) open(id);
  });
})();
