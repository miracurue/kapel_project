'use strict';

/** Повторное согласие (смена версии текста) и принятие соглашения сотрудником: одна галочка, один запрос. */
(function () {
  const box = document.getElementById('renew') || document.getElementById('terms');
  if (!box) return;
  const q = (s) => box.querySelector(s);
  let TX = {};
  fetch('/assets/ru.json')
    .then((r) => r.json())
    .then((d) => (TX = d))
    .catch(() => {});

  async function post(path, body) {
    const token = (await (await fetch('/api/v1/csrf')).json()).token;
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': token, 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify(body),
    });
  }

  q('[data-accept]').addEventListener('click', async () => {
    const check = q('input[type="checkbox"]');
    const error = q('[data-form-error]');
    error.textContent = '';
    if (!check.checked) {
      error.textContent = TX['msg.consent.renew.error'] || 'Отметьте галочку, чтобы подтвердить.';
      return;
    }
    if (box.dataset.terms) {
      const r = await post('/api/v1/me/terms/accept', { checkbox: true });
      if (r.ok) location.assign(box.dataset.next || '/');
      else error.textContent = TX['msg.register.error.generic'] || '';
      return;
    }
    const r = await post(`/api/v1/consents/${box.dataset.kind}`, {
      action: 'give',
      version: Number(box.dataset.version),
      checkbox: true,
    });
    if (r.ok) location.assign('/onboarding/consent');
    else error.textContent = TX['msg.register.error.generic'] || '';
  });
})();
