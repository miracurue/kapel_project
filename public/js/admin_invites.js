'use strict';
// Т-3: приглашения в админке — окно из вкладки «Люди». Создать код для выбранного специалиста (виден один раз),
// список без открытых кодов, отзыв. API: GET/POST /api/v1/admin/invites, POST /api/v1/admin/invites/:id/revoke.
// Общие помощники (запросы с CSRF, окно, подписи) берёт из window.adminKit, который задаёт public/admin.js.
(function () {
  const STATUS = ['active', 'used', 'revoked', 'expired'];
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '');

  async function open() {
    const kit = window.adminKit;
    if (!kit) return;
    const { esc, tx } = kit;
    const staff = await kit.clinicians();
    const options = staff.length
      ? staff.map((p) => `<option value="${Number(p.id)}">${esc(p.label)}</option>`).join('')
      : `<option value="">${esc(tx('msg.admin.invites.no_staff', 'Нет действующих специалистов'))}</option>`;
    kit.dialog(
      `<h3>${esc(tx('msg.admin.invites.title', 'Приглашения пациентов'))}</h3><p class="sub">${esc(tx('msg.admin.invites.lead', ''))}</p>
       <div class="invite-admin-form"><label>${esc(tx('msg.admin.invites.specialist', 'Специалист'))}<select data-inv-who>${options}</select></label>
       <button type="button" class="btn primary" data-inv-make data-testid="msg.admin.invites.create"${staff.length ? '' : ' disabled'}>${esc(tx('msg.admin.invites.create', 'Создать код'))}</button></div>
       <div class="invite-new" data-inv-new hidden><output class="invite-code" data-inv-code></output><p class="small muted" data-inv-exp></p><p class="small muted">${esc(tx('msg.admin.invites.once', ''))}</p><button type="button" class="btn sm" data-inv-copy>${esc(tx('msg.admin.invites.copy', 'Скопировать'))}</button></div>
       <p class="form-error small" data-inv-msg aria-live="polite"></p><div data-inv-list></div>`,
      (bg) => {
        const $ = (sel) => bg.querySelector(sel);
        const msg = $('[data-inv-msg]');
        const paint = async () => {
          const data = await kit.get('/api/v1/admin/invites');
          const items = (data && data.items) || [];
          $('[data-inv-list]').innerHTML = items.length
            ? `<ul class="invite-list">${items
                .map((i) => {
                  const status = STATUS.includes(i.status) ? i.status : 'expired';
                  const when = `${tx('msg.admin.invites.col.created', 'Создан')} ${day(i.created_at)} · ${tx('msg.admin.invites.col.until', 'Действует до').toLowerCase()} ${day(i.expires_at)}`;
                  return `<li class="invite-row"><span class="invite-info"><b>${esc(i.clinician_name || '—')}</b><small class="muted">${esc(when)}</small></span><span class="invite-badge invite-badge--${status}">${esc(tx('msg.admin.invites.status.' + status, status))}</span>${status === 'active' ? `<button type="button" class="btn sm" data-inv-revoke="${Number(i.id)}">${esc(tx('msg.admin.invites.revoke', 'Отозвать'))}</button>` : ''}</li>`;
                })
                .join('')}</ul>`
            : `<p class="muted small">${esc(tx('msg.admin.invites.empty', 'Приглашений пока нет'))}</p>`;
        };
        $('[data-inv-make]').addEventListener('click', async () => {
          const id = Number($('[data-inv-who]').value);
          if (!id) return;
          msg.textContent = '';
          const r = await kit.post('/api/v1/admin/invites', { clinician_id: id });
          if (!r.ok) {
            msg.textContent = r.status === 429 ? tx('msg.admin.invites.limit', '') : tx('msg.admin.invites.error', '');
            return;
          }
          $('[data-inv-code]').textContent = r.data.code;
          $('[data-inv-exp]').textContent = tx('msg.admin.invites.expires', '', { date: day(r.data.expires_at) });
          $('[data-inv-new]').hidden = false;
          $('[data-inv-copy]').textContent = tx('msg.admin.invites.copy', 'Скопировать');
          await paint();
        });
        $('[data-inv-copy]').addEventListener('click', async (ev) => {
          try {
            await navigator.clipboard.writeText($('[data-inv-code]').textContent);
            ev.currentTarget.textContent = tx('msg.admin.invites.copied', 'Скопировано');
          } catch (_) {
            const range = document.createRange();
            range.selectNodeContents($('[data-inv-code]'));
            const sel = getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          }
        });
        bg.addEventListener('click', async (ev) => {
          const btn = ev.target.closest('[data-inv-revoke]');
          if (!btn) return;
          btn.disabled = true;
          const r = await kit.post(`/api/v1/admin/invites/${Number(btn.dataset.invRevoke)}/revoke`, {});
          msg.textContent = r.ok ? tx('msg.admin.invites.revoked', '') : tx('msg.admin.invites.error', '');
          await paint();
        });
        paint();
      },
    );
  }

  window.adminInvites = { open };
})();
