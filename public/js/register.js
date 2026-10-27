'use strict';

/**
 * Регистрация: переключатель «пациент / специалист» на месте, отправка одним запросом.
 * Тексты ошибок — из /assets/ru.json (ключи msg.register.*), разметка страницы — серверная.
 */
(function () {
  const root = document.getElementById('reg');
  if (!root) return;
  const q = (s, r = root) => r.querySelector(s);
  const qa = (s, r = root) => [...r.querySelectorAll(s)];
  let TX = {};
  const tx = (key) => TX[key] || key;

  async function api(path, body) {
    const token = (await (await fetch('/api/v1/csrf')).json()).token;
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': token, 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }

  function show(as, push) {
    root.dataset.as = as;
    qa('[data-panel]').forEach((f) => (f.hidden = f.dataset.panel !== as));
    qa('[data-lead]').forEach((p) => (p.hidden = p.dataset.lead !== as));
    qa('.reg-seg a').forEach((a) => {
      if (a.dataset.as === as) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    const done = q('[data-done]');
    if (done && as === 'patient') done.hidden = true;
    if (push) history.replaceState(null, '', as === 'specialist' ? '/register?as=specialist' : '/register');
  }

  function clear(form) {
    qa('[data-err]', form).forEach((n) => (n.textContent = ''));
    qa('input', form).forEach((n) => n.removeAttribute('aria-invalid'));
    q('[data-form-error]', form).textContent = '';
  }
  function fieldError(form, name, text) {
    const node = q(`[data-err="${name}"]`, form);
    if (node) node.textContent = text;
    const input = form.elements[name];
    if (input && input.setAttribute) input.setAttribute('aria-invalid', 'true');
  }
  function apply(form, res, kind) {
    const err = res.data && res.data.error;
    const code = err && err.code;
    if (code === 'E-VALIDATION') {
      for (const f of err.fields || []) {
        if (f.field === 'email') fieldError(form, 'email', tx('msg.register.error.email'));
        else if (f.field === 'password') fieldError(form, 'password', tx('msg.register.error.password'));
        else fieldError(form, f.field, tx('msg.register.error.required'));
      }
    } else if (code === 'E-CONSENT-REQUIRED') {
      q('[data-err="consents"]', form).textContent = tx(
        kind === 'staff' ? 'msg.register.staff.error.consent' : 'msg.register.error.consent',
      );
    } else if (code === 'E-INVITE-INVALID') {
      const details = q('.reg-code', form);
      if (details) details.open = true;
      fieldError(form, 'invite_code', tx('err.e-invite-invalid'));
    } else if (code === 'E-EMAIL-TAKEN') {
      fieldError(form, 'email', tx('msg.register.error.email_taken'));
    } else if (res.status === 429) {
      q('[data-form-error]', form).textContent = tx('msg.register.error.rate');
    } else {
      q('[data-form-error]', form).textContent = tx(
        kind === 'staff' ? 'msg.register.staff.error.generic' : 'msg.register.error.generic',
      );
    }
  }

  async function submitPatient(form) {
    clear(form);
    const email = form.elements.email.value.trim();
    const password = form.elements.password.value;
    const consents = ['base', 'ai', 'research'].filter((k) => form.elements[k] && form.elements[k].checked);
    let bad = false;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      ((bad = true), fieldError(form, 'email', tx('msg.register.error.email')));
    if (password.length < 10) ((bad = true), fieldError(form, 'password', tx('msg.register.error.password')));
    if (!consents.includes('base'))
      ((bad = true), (q('[data-err="consents"]', form).textContent = tx('msg.register.error.consent')));
    if (bad) return;
    const button = q('button[type="submit"]', form);
    button.disabled = true;
    const res = await api('/api/v1/auth/register', {
      email,
      password,
      invite_code: form.elements.invite_code.value.trim() || undefined,
      consents,
    });
    button.disabled = false;
    if (res.status === 200) location.assign('/app');
    else apply(form, res, 'patient');
  }

  async function submitStaff(form) {
    clear(form);
    const body = {
      full_name: form.elements.full_name.value.trim(),
      email: form.elements.email.value.trim(),
      password: form.elements.password.value,
      role: (form.querySelector('input[name="role"]:checked') || {}).value,
      specialty: form.elements.specialty.value,
      workplace: form.elements.workplace.value.trim(),
      qualification: form.elements.qualification.value.trim() || undefined,
      consents: ['staff_pd', 'agreement'].filter((k) => form.elements[k] && form.elements[k].checked),
    };
    let bad = false;
    if (body.full_name.length < 2) ((bad = true), fieldError(form, 'full_name', tx('msg.register.error.required')));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email))
      ((bad = true), fieldError(form, 'email', tx('msg.register.error.email')));
    if (body.password.length < 10) ((bad = true), fieldError(form, 'password', tx('msg.register.error.password')));
    if (body.workplace.length < 2) ((bad = true), fieldError(form, 'workplace', tx('msg.register.error.required')));
    if (body.consents.length < 2)
      ((bad = true), (q('[data-err="consents"]', form).textContent = tx('msg.register.staff.error.consent')));
    if (bad) return;
    const button = q('button[type="submit"]', form);
    button.disabled = true;
    const res = await api('/api/v1/auth/register-specialist', body);
    button.disabled = false;
    if (res.status === 201) {
      form.hidden = true;
      qa('[data-lead]').forEach((p) => (p.hidden = true));
      q('[data-done]').hidden = false;
      q('[data-done] h2').focus?.();
    } else apply(form, res, 'staff');
  }

  root.addEventListener('click', (e) => {
    const a = e.target.closest('.reg-seg a');
    if (!a) return;
    e.preventDefault();
    show(a.dataset.as, true);
  });
  root.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-panel]');
    if (!form) return;
    e.preventDefault();
    if (form.dataset.panel === 'patient') submitPatient(form);
    else submitStaff(form);
  });

  // Ссылка или QR от врача (/register?code=…): подставляем код и раскрываем поле.
  const preset = (new URLSearchParams(location.search).get('code') || '').trim();
  const presetField = q('form[data-panel="patient"]') && q('form[data-panel="patient"]').elements.invite_code;
  if (preset && presetField) {
    presetField.value = preset.slice(0, 32);
    const fold = q('.reg-code');
    if (fold) fold.open = true;
  }

  fetch('/assets/ru.json')
    .then((r) => r.json())
    .then((d) => (TX = d))
    .catch(() => {});
})();
