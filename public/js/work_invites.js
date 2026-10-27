'use strict';
// Т-2: приглашения пациентов у специалиста. Кнопка «+ Пригласить» над списком пациентов, окно с новым кодом
// (виден один раз) и списком своих приглашений. API — GET/POST /api/v1/invites, POST /api/v1/invites/:id/revoke.
(function () {
  const root = document.querySelector('[data-invite-root]');
  if (!root) return;
  let T = {};
  try {
    T = JSON.parse(decodeURIComponent(root.dataset.i18n || '')) || {};
  } catch (_) {
    /* без подписей окно не открываем */
    return;
  }
  const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '');
  const fill = (text, date) => String(text || '').replace('{date}', fmt(date));
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  async function call(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      headers['Idempotency-Key'] = crypto.randomUUID();
      const meta = document.querySelector('meta[name="csrf-token"]');
      headers['X-CSRF-Token'] = meta ? meta.content : (await (await fetch('/api/v1/csrf')).json()).token;
    }
    const res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  // Вид как у соседней кнопки «Журнал»: значок и подпись (на телефоне подпись скрывает общий стиль .jbtn span).
  const openBtn = el('button', 'jbtn invite-open');
  const plus = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  plus.setAttribute('class', 'i');
  plus.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '/icons.svg#i-plus');
  plus.append(use);
  openBtn.append(plus, el('span', '', String(T.open || '').replace(/^\+\s*/, '')));
  openBtn.setAttribute('aria-label', T.open);
  openBtn.type = 'button';
  openBtn.dataset.testid = 'msg.patients.invite';
  openBtn.setAttribute('aria-haspopup', 'dialog');
  root.append(openBtn);

  const dlg = el('dialog', 'invite-dlg');
  dlg.setAttribute('aria-labelledby', 'invite-title');
  const title = el('h2', '', T.title);
  title.id = 'invite-title';
  const created = el('div', 'invite-new');
  created.hidden = true;
  const codeLine = el('output', 'invite-code');
  const note = el('p', 'small muted', T.note);
  const exp = el('p', 'small muted');
  const copy = el('button', 'btn sm', T.copy);
  copy.type = 'button';
  const qr = el('div', 'invite-qr');
  qr.setAttribute('role', 'img');
  created.append(codeLine, qr, exp, note, copy);
  const msg = el('p', 'form-error small');
  msg.setAttribute('aria-live', 'polite');
  const listTitle = el('h3', 'invite-list-h', T.list);
  const list = el('ul', 'invite-list');
  const make = el('button', 'btn primary', T.create);
  make.type = 'button';
  make.dataset.testid = 'msg.patients.invite.create';
  const close = el('button', 'btn', T.close);
  close.type = 'button';
  const acts = el('div', 'acts');
  acts.append(close, make);
  dlg.append(title, created, msg, listTitle, list, acts);
  root.append(dlg);

  const label = (item) => {
    const status = item.status === 'active' && new Date(item.expires_at) < new Date() ? 'expired' : item.status;
    return { status, text: T['status.' + status] || status };
  };

  async function paint() {
    const r = await call('GET', '/api/v1/invites');
    list.replaceChildren();
    const items = (r.ok && r.data.items) || [];
    if (!items.length) {
      list.append(el('li', 'small muted', T.empty));
      return;
    }
    for (const item of items) {
      const { status, text } = label(item);
      const row = el('li', 'invite-row');
      const info = el('span', 'invite-info');
      info.append(el('b', '', fill(T.created_at, item.created_at)));
      info.append(el('small', 'muted', status === 'active' ? fill(T.until, item.expires_at) : text));
      const badge = el('span', 'invite-badge invite-badge--' + status, text);
      row.append(info, badge);
      if (status === 'active') {
        const rev = el('button', 'btn sm', T.revoke);
        rev.type = 'button';
        rev.addEventListener('click', async () => {
          rev.disabled = true;
          const res = await call('POST', '/api/v1/invites/' + item.id + '/revoke');
          msg.textContent = res.ok ? T.revoked : T.error;
          await paint();
        });
        row.append(rev);
      }
      list.append(row);
    }
  }

  make.addEventListener('click', async () => {
    make.disabled = true;
    msg.textContent = '';
    const r = await call('POST', '/api/v1/invites', {});
    make.disabled = false;
    if (!r.ok) {
      msg.textContent = r.status === 429 ? T.limit : T.error;
      return;
    }
    codeLine.textContent = r.data.code;
    // QR ведёт на /register?code=… (или в профиль вошедшего пациента); картинка приходит готовым SVG с сервера.
    const svg = typeof r.data.qr_svg === 'string' && r.data.qr_svg.startsWith('<svg') ? r.data.qr_svg : '';
    qr.innerHTML = svg;
    qr.hidden = !svg;
    qr.setAttribute('aria-label', r.data.code);
    exp.textContent = fill(T.expires, r.data.expires_at);
    created.hidden = false;
    copy.textContent = T.copy;
    await paint();
  });

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(codeLine.textContent);
      copy.textContent = T.copied;
    } catch (_) {
      const range = document.createRange();
      range.selectNodeContents(codeLine);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });

  openBtn.addEventListener('click', () => {
    created.hidden = true;
    codeLine.textContent = '';
    qr.innerHTML = '';
    msg.textContent = '';
    dlg.showModal();
    paint();
  });
  // Код виден только пока окно открыто: закрыли — очистили.
  dlg.addEventListener('close', () => {
    codeLine.textContent = '';
    qr.innerHTML = '';
    created.hidden = true;
  });
  close.addEventListener('click', () => dlg.close());
})();
