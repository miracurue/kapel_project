'use strict';

/** Админка → «Запросы»: очередь «Заявки специалистов» (подтвердить с ролью / отклонить с причиной). */
(function () {
  const root = document.getElementById('staff-apps');
  if (!root) return;
  let TX = {};
  const tx = (k) => TX[k] || k;
  const esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const fmt = (iso) => {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return Number.isNaN(d.getTime()) ? '' : `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
  };
  async function call(path, method, body) {
    const token = (await (await fetch('/api/v1/csrf')).json()).token;
    const r = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-csrf-token': token, 'idempotency-key': crypto.randomUUID() },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { ok: r.ok, data: await r.json().catch(() => ({})) };
  }
  async function draw() {
    const res = await fetch('/api/v1/admin/staff-applications', { headers: { Accept: 'application/json' } });
    const items = res.ok ? (await res.json()).items : [];
    root.innerHTML = `<h2 id="staff-apps-h" data-testid="msg.admin.staffapps.title">${esc(tx('msg.admin.staffapps.title'))}${items.length ? ` · ${items.length}` : ''}</h2>${
      items.length
        ? items
            .map(
              (a) =>
                `<div class="staff-app" data-id="${a.id}"><div class="staff-app__main"><b>${esc(a.full_name)}</b><small>${esc(a.email)} · ${esc(tx('msg.register.staff.role.' + a.role_requested))} · ${esc(tx('msg.register.staff.specialty.' + (a.specialty || 'other')))}</small><small>${esc(a.workplace || '')}${a.qualification ? ` · ${esc(tx('msg.admin.staffapps.qualification'))}: ${esc(a.qualification)}` : ''} · ${esc(fmt(a.created_at))}</small></div><div class="staff-app__acts"><button type="button" class="btn primary" data-approve data-testid="msg.admin.staffapps.approve">${esc(tx('msg.admin.staffapps.approve'))}</button><button type="button" class="btn" data-reject data-testid="msg.admin.staffapps.reject">${esc(tx('msg.admin.staffapps.reject'))}</button></div></div>`,
            )
            .join('')
        : `<p class="muted" data-testid="msg.admin.staffapps.empty">${esc(tx('msg.admin.staffapps.empty'))}</p>`
    }<p class="sub" data-out aria-live="polite"></p>`;
  }
  root.addEventListener('click', async (e) => {
    const row = e.target.closest('.staff-app');
    if (!row) return;
    const id = row.dataset.id;
    const out = root.querySelector('[data-out]');
    const form = row.querySelector('.staff-app__form');
    if (e.target.closest('[data-approve]')) {
      if (!form || form.dataset.mode !== 'approve') {
        form?.remove();
        row.insertAdjacentHTML(
          'beforeend',
          `<div class="staff-app__form" data-mode="approve"><fieldset class="choices reg-roles"><legend>${esc(tx('msg.admin.staffapps.role'))}</legend><label class="choice"><input type="radio" name="role-${id}" value="psychologist" checked>${esc(tx('msg.register.staff.role.psychologist'))}</label><label class="choice"><input type="radio" name="role-${id}" value="psychiatrist">${esc(tx('msg.register.staff.role.psychiatrist'))}</label></fieldset><div class="staff-app__acts"><button type="button" class="btn primary" data-confirm-approve>${esc(tx('msg.admin.staffapps.approve'))}</button><button type="button" class="btn ghost" data-cancel>${esc(tx('msg.admin.staffapps.cancel'))}</button></div></div>`,
        );
        const requested = row.querySelector('.staff-app__main small')?.textContent || '';
        if (requested.includes(tx('msg.register.staff.role.psychiatrist')))
          row.querySelector(`input[value="psychiatrist"]`).checked = true;
      }
    } else if (e.target.closest('[data-reject]')) {
      form?.remove();
      row.insertAdjacentHTML(
        'beforeend',
        `<div class="staff-app__form" data-mode="reject"><label class="field">${esc(tx('msg.admin.staffapps.reason'))}<input name="reason" maxlength="300" data-testid="msg.admin.staffapps.reason"></label><div class="staff-app__acts"><button type="button" class="btn primary" data-confirm-reject>${esc(tx('msg.admin.staffapps.reject.confirm'))}</button><button type="button" class="btn ghost" data-cancel>${esc(tx('msg.admin.staffapps.cancel'))}</button></div></div>`,
      );
    } else if (e.target.closest('[data-cancel]')) {
      form?.remove();
    } else if (e.target.closest('[data-confirm-approve]')) {
      const role = row.querySelector('input[type="radio"]:checked').value;
      const r = await call(`/api/v1/admin/staff-applications/${id}/approve`, 'POST', { role });
      out.textContent = tx(r.ok ? 'msg.admin.staffapps.done' : 'msg.admin.staffapps.error');
      if (r.ok) await draw();
    } else if (e.target.closest('[data-confirm-reject]')) {
      const reason = row.querySelector('input[name="reason"]').value.trim();
      if (!reason) return row.querySelector('input[name="reason"]').setAttribute('aria-invalid', 'true');
      const r = await call(`/api/v1/admin/staff-applications/${id}/reject`, 'POST', { reason });
      out.textContent = tx(r.ok ? 'msg.admin.staffapps.done' : 'msg.admin.staffapps.error');
      if (r.ok) await draw();
    }
  });
  fetch('/assets/ru.json')
    .then((r) => r.json())
    .then((d) => (TX = d))
    .catch(() => {})
    .then(draw);
})();
