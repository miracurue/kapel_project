'use strict';
// Режим «Документы» вкладки «Шаблоны и документы»: список по пациентам, форма извещения, автосохранение,
// «Готово» (документ закрывается для правки), «Исправленная версия», скачивание docx, «Заполнить для пациента».
// API — /work/api/documents* (src/ai/workspace/documentsApi.js). Каркас вкладки и переключатель режима — work_docs.js.
(function () {
  const root = document.querySelector('[data-work-docs]');
  if (!root || !root.docsApi || !window.NoticeForm) return;
  const { call, setMode } = root.docsApi;
  const NS = 'http://www.w3.org/2000/svg';
  const AUTOSAVE_MS = 700;
  const $ = (sel) => root.querySelector(sel);
  const list = $('[data-doc-list]'),
    filter = $('[data-doc-filter]'),
    mobile = $('[data-doc-mobile-select]'),
    view = $('[data-doc-view]'),
    emptyView = $('[data-doc-empty]'),
    fillBox = $('[data-doc-fillbox]');

  const DT = (key, vars) =>
    Object.entries(vars || {}).reduce((s, [k, v]) => s.replaceAll('{' + k + '}', v), root.docsApi.text(key) || key);

  let groups = [],
    listState = 'idle', // idle | loading | error | ready
    current = null, // полный документ с сервера + локальные поля
    form = null,
    dirty = false,
    saving = false,
    saveTimer = null,
    saveState = 'saved', // saved | dirty | saving | failed | conflict
    aeByPatient = null;

  const el = (tag, attrs, ...kids) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === false || value == null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const kid of kids.flat()) if (kid != null) node.append(kid);
    return node;
  };
  const icon = (name) => {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'i');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', '/icons.svg#i-' + name);
    svg.appendChild(use);
    return svg;
  };
  const when = (iso, withTime) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(
      'ru-RU',
      withTime
        ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
        : { day: '2-digit', month: '2-digit', year: 'numeric' },
    );
  };
  // Статус всегда словом и значком, а не одним цветом.
  const statusPill = (status) =>
    el(
      'span',
      { class: 'st-pill ' + (status === 'ready' ? 'ok' : 'warn'), 'data-status': status },
      icon(status === 'ready' ? 'check-circle' : 'pencil-simple'),
      el('span', { text: DT('status.' + (status === 'ready' ? 'ready' : 'draft')) }),
    );
  const errCode = (res) => res?.data?.error?.code || '';

  // ---------- список ----------
  function rowOf(meta) {
    const a = el('a', {
      href: '?tab=docs&doc=' + meta.id,
      class: 'th doc-row' + (current?.id === meta.id ? ' on' : ''),
      'data-id': meta.id,
    });
    if (current?.id === meta.id) a.setAttribute('aria-current', 'true');
    a.append(
      el('span', { class: 'doc-row-title', text: meta.title }),
      el(
        'span',
        { class: 'doc-row-meta' },
        el('time', { datetime: meta.updated_at, text: when(meta.updated_at) }),
        statusPill(meta.status),
        meta.supersedes_id ? el('span', { class: 'doc-row-tag', text: DT('corrected') }) : null,
      ),
    );
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openDoc(meta.id);
    });
    return a;
  }
  function renderList() {
    list.textContent = '';
    mobile.textContent = '';
    mobile.append(el('option', { value: '', text: DT('mobile_none') }));
    if (listState === 'loading') return void list.append(el('p', { class: 'small muted', text: DT('list.loading') }));
    if (listState === 'error') {
      const retry = el('button', { type: 'button', class: 'btn sm', text: DT('retry') });
      retry.addEventListener('click', loadList);
      return void list.append(el('p', { class: 'form-error', role: 'alert', text: DT('list.error') }), retry);
    }
    const needle = filter.value.trim().toLowerCase();
    let shown = 0;
    for (const group of groups) {
      const label = group.name || group.service_no || '';
      const docs = group.documents.filter(
        (d) => !needle || (label + ' ' + (group.service_no || '') + ' ' + d.title).toLowerCase().includes(needle),
      );
      if (!docs.length) continue;
      shown += docs.length;
      const box = el('section', { class: 'doc-group', 'aria-label': label });
      box.append(el('h4', { text: label + (group.service_no && group.name ? ' · ' + group.service_no : '') }));
      const optgroup = el('optgroup', { label });
      for (const d of docs) {
        box.append(rowOf(d));
        optgroup.append(
          el('option', {
            value: d.id,
            text: `${d.title} · ${when(d.updated_at)} · ${DT('status.' + (d.status === 'ready' ? 'ready' : 'draft'))}`,
          }),
        );
      }
      list.append(box);
      mobile.append(optgroup);
    }
    if (!shown) {
      list.append(
        needle
          ? el('p', { class: 'small muted', text: root.dataset.tNoMatch || '' })
          : el(
              'div',
              { class: 'doc-list-empty' },
              el('b', { text: DT('list.empty') }),
              el('p', { class: 'small muted', text: DT('list.empty_hint') }),
            ),
      );
    }
    mobile.value = current ? String(current.id) : '';
  }
  async function loadList() {
    listState = 'loading';
    renderList();
    const res = await call('/work/api/documents', 'GET').catch(() => null);
    if (!res || !res.ok) {
      listState = 'error';
      return renderList();
    }
    groups = (res.data.patients || []).map((p) => ({ ...p, documents: p.documents || [] }));
    listState = 'ready';
    renderList();
  }
  // Сохранённое состояние документа попадает в строку списка без повторной загрузки.
  function syncRow() {
    if (!current) return;
    for (const group of groups) {
      const row = group.documents.find((d) => d.id === current.id);
      if (row) Object.assign(row, { status: current.status, version: current.version, updated_at: current.updated_at });
    }
  }

  // ---------- документ ----------
  function showView(on) {
    view.hidden = !on;
    emptyView.hidden = on;
  }
  function setUrl(id) {
    const url = new URL(location.href);
    if (id) url.searchParams.set('doc', id);
    else url.searchParams.delete('doc');
    history.replaceState(null, '', url);
  }
  async function openDoc(id) {
    if (!(await flush())) return;
    setMode('documents');
    showView(true);
    view.textContent = '';
    view.append(el('p', { class: 'small muted', role: 'status', text: DT('loading') }));
    const res = await call('/work/api/documents/' + encodeURIComponent(id), 'GET').catch(() => null);
    if (!res || !res.ok) {
      current = null;
      view.textContent = '';
      const retry = el('button', { type: 'button', class: 'btn', text: DT('retry') });
      retry.addEventListener('click', () => openDoc(id));
      view.append(el('p', { class: 'form-error', role: 'alert', text: DT('load_failed') }));
      if (res && res.status !== 404) view.append(retry);
      return;
    }
    current = res.data.document;
    dirty = false;
    saveState = 'saved';
    setUrl(current.id);
    renderDoc(true);
    renderList();
  }
  function closeDoc() {
    current = null;
    form = null;
    setUrl(null);
    showView(false);
    renderList();
  }

  const msgBox = () => view.querySelector('[data-doc-msg]');
  function say(text) {
    const box = msgBox();
    if (box) box.textContent = text || '';
  }

  // Документ из шаблона: только чтение и «Скопировать» (для МИС).
  function renderTextDoc(doc, focusTitle, title) {
    form = null;
    const copy = el('button', { type: 'button', class: 'btn', text: DT('copy'), 'data-testid': 'msg.doc.copy' });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(doc.body);
        say(root.dataset.tCopied || '');
      } catch (_) {
        say(root.dataset.tCopyFailed || '');
      }
    });
    view.append(
      el('p', { class: 'small muted', text: DT('text_note') }),
      el('div', { class: 'doc-text', 'data-doc-text': true, text: doc.body }),
      el('div', { class: 'tpl-acts' }, copy),
    );
    if (focusTitle) title.focus({ preventScroll: true });
    view.closest('.scroll')?.scrollTo({ top: 0 });
  }

  function renderDoc(focusTitle) {
    const doc = current;
    const ready = doc.status === 'ready';
    view.textContent = '';
    const title = el('h2', { class: 'doc-title', tabindex: '-1', text: doc.title });
    const sub = [
      doc.patient?.name,
      doc.patient?.service_no,
      DT('meta.version', { n: doc.version }),
      DT('meta.updated', { when: when(doc.updated_at, true) }),
    ].filter(Boolean);
    view.append(
      el(
        'header',
        { class: 'doc-head' },
        el('div', { class: 'doc-head-main' }, title, el('p', { class: 'doc-sub', text: sub.join(' · ') })),
        el(
          'div',
          { class: 'doc-head-tags' },
          doc.supersedes_id ? el('span', { class: 'chip', text: DT('corrected') }) : null,
          statusPill(doc.status),
        ),
      ),
      el('p', { class: 'small muted', role: 'status', 'data-doc-msg': true }),
    );
    if (doc.kind === 'text') return renderTextDoc(doc, focusTitle, title);
    if (ready) view.append(lockedBanner(doc));
    else
      view.append(
        el('p', { class: 'small muted doc-req-note', text: DT('required_note') }),
        el('div', { 'data-doc-missing': true }),
      );
    const host = el('div', { class: 'doc-form', 'data-doc-form': true });
    view.append(host);
    form = window.NoticeForm.build(host, {
      fields: doc.fields,
      readOnly: ready,
      text: DT,
      onChange: onEdit,
    });
    if (!ready) {
      view.append(el('div', { class: 'doc-bar', 'data-doc-bar': true }));
      renderMissing();
      renderBar();
    }
    if (focusTitle) title.focus({ preventScroll: true });
    view.closest('.scroll')?.scrollTo({ top: 0 });
  }

  function lockedBanner(doc) {
    const download = el(
      'button',
      { type: 'button', class: 'btn primary', 'data-testid': 'msg.doc.download.docx' },
      icon('download-simple'),
      el('span', { text: DT('download.docx') }),
    );
    download.addEventListener('click', () => downloadFile(doc.id, download));
    const acts = el('div', { class: 'tpl-acts' }, download);
    if (doc.superseded_by) {
      const open = el('button', { type: 'button', class: 'btn', text: DT('open_corrected') });
      open.addEventListener('click', () => openDoc(doc.superseded_by));
      acts.append(open);
    } else {
      const revise = el(
        'button',
        { type: 'button', class: 'btn', 'data-testid': 'msg.doc.revise_btn' },
        icon('note-pencil'),
        el('span', { text: DT('revise_btn') }),
      );
      revise.addEventListener('click', () => revise_(doc, revise));
      acts.append(revise);
    }
    return el(
      'section',
      { class: 'doc-locked', 'aria-labelledby': 'doc-locked-t' },
      icon('lock'),
      el(
        'div',
        { class: 'doc-locked-body' },
        el('b', { id: 'doc-locked-t', text: DT('locked.title') }),
        el('p', { text: DT('locked.text') }),
        acts,
      ),
    );
  }

  async function downloadFile(id, button) {
    button.disabled = true;
    say('');
    try {
      const res = await fetch('/work/api/documents/' + encodeURIComponent(id) + '/file?format=docx');
      if (!res.ok) throw new Error('file');
      const url = URL.createObjectURL(await res.blob());
      const a = el('a', { href: url, download: 'notice-' + id + '.docx' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (_) {
      say(DT('download.failed'));
    } finally {
      button.disabled = false;
    }
  }
  async function revise_(doc, button) {
    button.disabled = true;
    const res = await call('/work/api/documents/' + encodeURIComponent(doc.id) + '/revise', 'POST', {}).catch(
      () => null,
    );
    button.disabled = false;
    if (!res || !res.ok) return say(DT('revise.failed'));
    await loadList();
    openDoc(res.data.document.id);
  }

  // ---------- «Не заполнено обязательное» ----------
  function renderMissing() {
    const box = view.querySelector('[data-doc-missing]');
    if (!box || !form) return;
    const names = window.NoticeForm.missing(current.fields);
    box.textContent = '';
    if (!names.length) return;
    const items = names.map((path) => {
      const b = el('button', {
        type: 'button',
        class: 'chip doc-missing-chip',
        'data-path': path,
        text: DT('field.' + path),
      });
      b.addEventListener('click', () => form.focusField(path));
      return el('li', null, b);
    });
    box.append(
      el(
        'section',
        { class: 'doc-missing', 'aria-labelledby': 'doc-missing-t' },
        el('h3', { id: 'doc-missing-t' }, icon('warning-circle'), el('span', { text: DT('missing.title') })),
        el('p', { class: 'small muted', text: DT('missing.hint') }),
        el('ul', { class: 'doc-missing-list' }, items),
      ),
    );
  }

  // ---------- автосохранение ----------
  function onEdit() {
    dirty = true;
    saveState = 'dirty';
    renderMissing();
    renderBar();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, AUTOSAVE_MS);
  }
  // Ждёт, пока уйдёт последняя правка; false — документ остался несохранённым.
  async function flush() {
    if (!current || current.status !== 'draft') return true;
    clearTimeout(saveTimer);
    while (saving) await new Promise((r) => setTimeout(r, 40));
    if (dirty) await save();
    return !dirty;
  }
  async function save() {
    if (saving || !dirty || !current || current.status !== 'draft') return;
    saving = true;
    dirty = false;
    saveState = 'saving';
    renderBar();
    const doc = current;
    const res = await call('/work/api/documents/' + encodeURIComponent(doc.id), 'PUT', {
      version: doc.version,
      fields: doc.fields,
    }).catch(() => null);
    saving = false;
    if (current !== doc) return;
    if (res && res.ok) {
      doc.version = res.data.document.version;
      doc.updated_at = res.data.document.updated_at;
      saveState = dirty ? 'dirty' : 'saved';
      syncRow();
      if (dirty) saveTimer = setTimeout(save, AUTOSAVE_MS);
    } else {
      dirty = true;
      const code = errCode(res);
      saveState = code === 'E-CONFLICT' ? 'conflict' : 'failed';
      if (code === 'E-SIGNED-IMMUTABLE') {
        dirty = false;
        await reloadCurrent();
        return say(DT('save.locked'));
      }
    }
    renderBar();
  }
  async function reloadCurrent() {
    const id = current.id;
    dirty = false;
    saveState = 'saved';
    current = null;
    await openDoc(id);
    await loadList();
  }

  // ---------- нижняя панель черновика: сохранение, «Готово», удаление ----------
  let barMode = 'main'; // main | ready | delete
  function renderBar() {
    const bar = view.querySelector('[data-doc-bar]');
    if (!bar) return;
    bar.textContent = '';
    if (barMode === 'ready') return void bar.append(confirmBlock('ready', onReady));
    if (barMode === 'delete') return void bar.append(confirmBlock('delete', onDelete));
    const status = el('span', { class: 'doc-save', role: 'status', 'data-save': saveState });
    const label = {
      saved: 'save.saved',
      dirty: 'save.dirty',
      saving: 'save.saving',
      failed: 'save.failed',
      conflict: 'save.conflict',
    }[saveState];
    status.append(
      icon(
        saveState === 'saved'
          ? 'check'
          : saveState === 'failed' || saveState === 'conflict'
            ? 'warning-circle'
            : 'clock',
      ),
      el('span', { text: DT(label) }),
    );
    const left = el('div', { class: 'doc-bar-state' }, status);
    if (saveState === 'failed') {
      const retry = el('button', { type: 'button', class: 'linkish', text: DT('save.retry') });
      retry.addEventListener('click', () => {
        clearTimeout(saveTimer);
        save();
      });
      left.append(retry);
    }
    if (saveState === 'conflict') {
      const reload = el('button', { type: 'button', class: 'linkish', text: DT('save.reload') });
      reload.addEventListener('click', reloadCurrent);
      left.append(reload);
    }
    const del = el(
      'button',
      { type: 'button', class: 'btn ghost', 'data-testid': 'msg.doc.delete_draft' },
      icon('trash'),
      el('span', { text: DT('delete_draft') }),
    );
    del.addEventListener('click', () => {
      barMode = 'delete';
      renderBar();
      bar.querySelector('[data-confirm-title]')?.focus();
    });
    const ready = el(
      'button',
      { type: 'button', class: 'btn primary', 'data-testid': 'msg.doc.ready', 'data-doc-ready': true },
      icon('check'),
      el('span', { text: DT('ready') }),
    );
    ready.addEventListener('click', onReadyClick);
    bar.append(left, el('div', { class: 'doc-bar-acts' }, del, ready));
  }
  function confirmBlock(kind, action) {
    const title = el('b', {
      tabindex: '-1',
      'data-confirm-title': true,
      text: kind === 'ready' ? DT('ready.title') : DT('delete.confirm'),
    });
    const yes = el('button', {
      type: 'button',
      class: kind === 'ready' ? 'btn primary' : 'btn danger',
      'data-testid': kind === 'ready' ? 'msg.doc.ready.confirm' : 'msg.doc.delete.yes',
      text: kind === 'ready' ? DT('ready.confirm') : DT('delete.yes'),
    });
    const no = el('button', {
      type: 'button',
      class: 'btn',
      text: kind === 'ready' ? DT('ready.back') : DT('delete.no'),
    });
    yes.addEventListener('click', () => action(yes));
    no.addEventListener('click', () => {
      barMode = 'main';
      renderBar();
    });
    return el(
      'div',
      { class: 'doc-confirm', role: 'group', 'aria-label': title.textContent },
      title,
      kind === 'ready' ? el('p', { text: DT('ready.text') }) : null,
      el('div', { class: 'tpl-acts' }, yes, no),
    );
  }
  async function onReadyClick() {
    say('');
    if (!(await flush())) return;
    const names = window.NoticeForm.missing(current.fields);
    if (names.length) {
      form.markInvalid(names);
      view.querySelector('[data-doc-missing]')?.scrollIntoView({ block: 'center' });
      form.focusField(names[0]);
      return;
    }
    barMode = 'ready';
    renderBar();
    view.querySelector('[data-confirm-title]')?.focus();
  }
  async function onReady(button) {
    button.disabled = true;
    const res = await call('/work/api/documents/' + encodeURIComponent(current.id) + '/ready', 'POST', {
      version: current.version,
    }).catch(() => null);
    barMode = 'main';
    if (res && res.ok) {
      current = res.data.document;
      syncRow();
      renderDoc(true);
      renderList();
      return;
    }
    const code = errCode(res);
    if (code === 'E-VALIDATION') {
      renderBar();
      const names = res.data.error.missing || [];
      form.markInvalid(names);
      return names[0] && form.focusField(names[0]);
    }
    if (code === 'E-CONFLICT') saveState = 'conflict';
    renderBar();
    say(code === 'E-CONFLICT' ? DT('save.conflict') : DT('ready.failed'));
  }
  async function onDelete(button) {
    button.disabled = true;
    const res = await call('/work/api/documents/' + encodeURIComponent(current.id), 'DELETE').catch(() => null);
    barMode = 'main';
    if (!res || !res.ok) {
      renderBar();
      return say(DT('delete.failed'));
    }
    dirty = false;
    clearTimeout(saveTimer);
    const id = current.id;
    for (const g of groups) g.documents = g.documents.filter((d) => d.id !== id);
    groups = groups.filter((g) => g.documents.length);
    closeDoc();
  }

  // ---------- «Заполнить для пациента» ----------
  const fillPatient = $('[data-doc-fill-patient]'),
    fillAe = $('[data-doc-fill-ae]'),
    fillMsg = $('[data-doc-fill-msg]'),
    fillOpen = $('[data-doc-fill]');
  async function loadAes() {
    if (aeByPatient) return aeByPatient;
    aeByPatient = new Map();
    const res = await call('/api/v1/signals', 'GET').catch(() => null);
    for (const item of res?.ok ? res.data.items || [] : [])
      if (item.kind === 'ae' && item.status === 'related_likely' && item.patient) {
        const key = String(item.patient.id);
        if (!aeByPatient.has(key)) aeByPatient.set(key, []);
        aeByPatient.get(key).push(item);
      }
    return aeByPatient;
  }
  async function syncAe() {
    const map = await loadAes();
    const items = map.get(fillPatient.value) || [];
    fillAe.textContent = '';
    fillAe.append(el('option', { value: '', text: DT('fill.ae_none') }));
    for (const item of items) {
      const text = String(item.text || '')
        .replace(/\s+/g, ' ')
        .slice(0, 60);
      fillAe.append(
        el('option', {
          value: item.id,
          text: [when(item.started_on || item.created_at), text].filter(Boolean).join(' · '),
        }),
      );
    }
    fillAe.disabled = !items.length;
    const preset = fillBox.dataset.preset;
    if (preset && items.some((i) => String(i.id) === preset)) fillAe.value = preset;
  }
  if (fillBox) {
    fillOpen.addEventListener('click', () => {
      fillBox.hidden = false;
      fillMsg.textContent = '';
      fillPatient.focus();
    });
    $('[data-doc-fill-cancel]').addEventListener('click', () => {
      fillBox.hidden = true;
      fillOpen.focus();
    });
    fillPatient.addEventListener('change', syncAe);
    fillBox.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!fillPatient.value) {
        fillMsg.textContent = DT('fill.choose');
        return fillPatient.focus();
      }
      const submit = $('[data-doc-fill-create]');
      submit.disabled = true;
      fillMsg.textContent = '';
      const body = { template_key: 'b-roszdravnadzor', patient_id: Number(fillPatient.value) };
      if (fillAe.value) body.ae_id = Number(fillAe.value);
      const res = await call('/work/api/documents', 'POST', body).catch(() => null);
      submit.disabled = false;
      if (!res || !res.ok) {
        fillMsg.textContent = errCode(res) === 'E-STATUS' ? DT('fill.ae_changed') : DT('fill.failed');
        return;
      }
      fillBox.hidden = true;
      await loadList();
      openDoc(res.data.document.id);
    });
  }

  // ---------- связка с вкладкой ----------
  filter.addEventListener('input', renderList);
  mobile.addEventListener('change', () => mobile.value && openDoc(Number(mobile.value)));
  // Из вкладки шаблонов создан документ: список перечитывается при следующем показе.
  root.addEventListener('docs:created', () => {
    listState = 'idle';
  });
  root.addEventListener('docs:mode', async (e) => {
    if (e.detail.mode === 'documents') {
      showView(Boolean(current));
      if (listState === 'idle' || listState === 'error') loadList();
      else renderList();
      if (current) setUrl(current.id);
    } else {
      await flush();
      setUrl(null);
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (dirty || saving) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  root.documents = { open: openDoc, reload: loadList };

  const wanted = new URLSearchParams(location.search).get('doc');
  if (wanted && /^\d{1,12}$/.test(wanted)) {
    setMode('documents');
    openDoc(Number(wanted));
  }
})();
