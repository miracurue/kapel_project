'use strict';
// «Утверждения»: решение по изменению настройки. Тексты приходят из разметки (data-t-*), своих слов здесь нет.
(function () {
  const root = document.querySelector('[data-work-approvals]');
  if (!root) return;
  const msg = root.querySelector('[data-appr-msg]');
  const T = (k) => root.dataset['t' + k] || '';
  async function decide(row, kind, reason) {
    const token = (await (await fetch('/api/v1/csrf')).json()).token;
    const res = await fetch(`/api/v1/approvals/${row.dataset.approval}/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': token, 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify(kind === 'reject' ? { reason } : {}),
    });
    if (!res.ok) {
      msg.textContent = T('Failed');
      return;
    }
    row.remove();
    msg.textContent = T(kind === 'approve' ? 'Approved' : 'Rejected');
  }
  root.addEventListener('click', (e) => {
    const row = e.target.closest('[data-approval]');
    if (!row) return;
    const more = row.querySelector('[data-appr-more]');
    if (e.target.closest('[data-approve]')) decide(row, 'approve');
    else if (e.target.closest('[data-reject]')) {
      more.hidden = false;
      row.querySelector('[data-appr-reason]').focus();
    } else if (e.target.closest('[data-reject-cancel]')) more.hidden = true;
    else if (e.target.closest('[data-reject-send]')) {
      const reason = row.querySelector('[data-appr-reason]').value.trim();
      if (reason) decide(row, 'reject', reason);
    }
  });
})();
