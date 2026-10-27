'use strict';

/**
 * Нежелательное явление у специалиста (пакеты D и F плана 2026-10-23-ae-intake).
 * Общий слой для карточки пациента (/work/patients/ID) и чата специалиста (work_chat.js):
 *   AeClinician.offer(patientId)            → GET  /api/v1/patients/ID/adverse-events/offer
 *   AeClinician.meds(patientId)             → действующие препараты плана (только психиатр, GET .../plan)
 *   AeClinician.report({...})               → POST /api/v1/patients/ID/adverse-events (Idempotency-Key)
 *   AeClinician.open(host, {...})           → AeWizard нужного режима в host, после успеха onDone(data)
 *   AeClinician.confirmation(texts, ...)    → спокойное подтверждение (+ «Открыть черновик извещения»)
 * Режим: психиатр (R-03) — «сразу решение», психолог (R-04) — наблюдение, уходит психиатру пациента.
 * На странице карточки сам подключает кнопку [data-ae-open]. Тексты — ключи msg.ae.* из /assets/ru.json.
 * Ничего не отправляется наружу: черновик извещения открывается в «Сигналах» и уходит только решением человека.
 */
(function () {
  const modeOfPage = () => (document.body.dataset.role === 'R-04' ? 'psychologist' : 'psychiatrist');
  const cap = (v) => (v ? v.charAt(0).toUpperCase() + v.slice(1) : v);

  async function request(path, method, body, key) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      headers['x-csrf-token'] = (await (await fetch('/api/v1/csrf')).json()).token;
      headers['idempotency-key'] = key || crypto.randomUUID();
    }
    const response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try {
      data = await response.json();
    } catch (_) {
      data = {};
    }
    return { response, data };
  }

  async function offer(patientId) {
    try {
      const { response, data } = await request(`/api/v1/patients/${encodeURIComponent(patientId)}/adverse-events/offer`, 'GET');
      return response.ok ? data : null;
    } catch (_) {
      return null;
    }
  }

  // Действующие препараты опубликованного плана (у психолога плана нет — вызывать только для психиатра).
  async function meds(patientId) {
    try {
      const { response, data } = await request(`/api/v1/patients/${encodeURIComponent(patientId)}/plan`, 'GET');
      if (!response.ok) return [];
      const today = new Date().toISOString().slice(0, 10);
      const items = (data.published && data.published.items) || [];
      return items
        .filter((i) => (!i.until || i.until >= today) && (!i.start_date || i.start_date <= today))
        .map((i) => ({
          item_key: i.item_key,
          name: [cap(i.inn_name), i.dose != null && i.unit ? `${i.dose} ${i.unit}` : ''].filter(Boolean).join(' '),
        }))
        .filter((i) => i.item_key && i.name);
    } catch (_) {
      return [];
    }
  }

  // Отправка записи. Ошибка несёт messageKey (ключ текста) для показа в карточке.
  async function report({ patientId, payload, source, threadId, key }) {
    const body = { ...payload, source: source || 'form' };
    if (threadId) body.thread_id = Number(threadId);
    const { response, data } = await request(
      `/api/v1/patients/${encodeURIComponent(patientId)}/adverse-events`,
      'POST',
      body,
      key,
    );
    if (!response.ok) {
      const code = String((data && data.error && data.error.code) || '');
      const error = new Error(code || String(response.status));
      if (code === 'E-NO-PSYCHIATRIST') error.messageKey = 'err.e-no-psychiatrist';
      throw error;
    }
    return data;
  }

  const noticeHref = (data) => `/work?tab=signals&ae=${encodeURIComponent(data.ae.id)}`;

  // Кнопка «Открыть черновик извещения»: только после решения «вероятна» (notice_available).
  function noticeLink(T, data) {
    if (!data || !data.notice_available || !data.ae) return null;
    const a = document.createElement('a');
    a.className = 'btn sm';
    a.href = noticeHref(data);
    a.dataset.testid = 'msg.ae.clinician.notice_open';
    a.dataset.aeNotice = String(data.ae.id);
    a.textContent = T['msg.ae.clinician.notice_open'] || 'Открыть черновик извещения';
    return a;
  }

  // Подтверждение в карточке пациента: статус решения (психиатр) или «Передано психиатру пациента» (психолог).
  function confirmation(T, mode, data, onDone) {
    const box = document.createElement('div');
    box.className = 'ae-done';
    box.dataset.aeDone = '';
    box.setAttribute('role', 'status');
    const p = document.createElement('p');
    p.className = 'ae-done__text';
    if (mode === 'psychologist') {
      p.dataset.testid = 'msg.ae.clinician.done.psychologist';
      p.textContent = T['msg.ae.clinician.done.psychologist'] || '';
    } else {
      const decision = (data.ae && data.ae.decision) || 'insufficient';
      p.dataset.testid = 'msg.ae.clinician.done.psychiatrist';
      p.dataset.decision = decision;
      p.textContent = (T['msg.ae.clinician.done.psychiatrist'] || '').replace(
        '{decision}',
        T[`msg.ae.chat.decision.${decision}`] || decision,
      );
    }
    box.appendChild(p);
    const row = document.createElement('div');
    row.className = 'ae-done__row';
    const link = noticeLink(T, data);
    if (link) {
      row.appendChild(link);
      const note = document.createElement('p');
      note.className = 'ae-done__note';
      note.textContent = T['msg.ae.clinician.notice_note'] || '';
      box.append(row, note);
    }
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn sm';
    ok.dataset.testid = 'msg.ae.clinician.done.close';
    ok.textContent = T['msg.ae.clinician.done.close'] || 'Готово';
    ok.addEventListener('click', () => onDone && onDone());
    row.appendChild(ok);
    if (!link) box.appendChild(row);
    return box;
  }

  /**
   * AeWizard нужного режима внутри host.
   * opts: patientId, mode, prefill, source, threadId, onDone(data) после успешной отправки, onClose({reason}).
   * Один Idempotency-Key на открытую карточку: повтор после сбоя безопасен.
   */
  async function open(host, opts) {
    const mode = opts.mode || modeOfPage();
    const key = crypto.randomUUID();
    const [list, T] = await Promise.all([
      mode === 'psychiatrist' ? meds(opts.patientId) : Promise.resolve([]),
      window.AeWizard.texts(),
    ]);
    const wizard = window.AeWizard.mount(host, {
      mode,
      prefill: opts.prefill || {},
      meds: list,
      onSubmit: async (payload) => {
        const data = await report({
          patientId: opts.patientId,
          payload,
          source: opts.source,
          threadId: opts.threadId,
          key,
        });
        if (opts.onDone) opts.onDone(data, T);
        return data;
      },
      onClose: (info) => opts.onClose && opts.onClose(info),
    });
    await wizard.ready;
    return wizard;
  }

  // ---- карточка пациента: кнопка «＋ Нежелательное явление» и карточка-опрос над разделами ----
  async function initCard() {
    const button = document.querySelector('[data-ae-open]');
    const card = document.querySelector('#v2-card[data-patient-id]');
    if (!button || !card) return;
    const patientId = card.dataset.patientId;
    const mode = modeOfPage();
    if (mode === 'psychologist') {
      // Психологу кнопка нужна только если есть кому передать запись (закреплённый психиатр).
      const state = await offer(patientId);
      if (!state || !state.can_report) return;
    }
    button.closest('.ae-bar').hidden = false;
    let host = null;
    button.addEventListener('click', async () => {
      if (host && host.isConnected) {
        const field = host.querySelector('textarea, button');
        if (field) field.focus();
        return;
      }
      host = document.createElement('section');
      host.className = 'ae-card';
      host.dataset.aeHost = '';
      card.before(host); // сразу под строкой с кнопкой, над разделами карточки
      button.setAttribute('aria-expanded', 'true');
      const close = () => {
        host.remove();
        button.setAttribute('aria-expanded', 'false');
        button.focus();
      };
      try {
        await open(host, {
          patientId,
          mode,
          source: 'form',
          onDone: (data, T) => {
            host.replaceChildren(confirmation(T, mode, data, close));
            host.scrollIntoView({ block: 'nearest' });
          },
          onClose: ({ reason }) => {
            if (reason === 'closed') close();
          },
        });
        host.scrollIntoView({ block: 'nearest' });
        const first = host.querySelector('[data-ae-q]');
        if (first) first.focus({ preventScroll: true });
      } catch (_) {
        host.remove();
        button.setAttribute('aria-expanded', 'false');
      }
    });
  }

  window.AeClinician = { offer, meds, report, open, confirmation, noticeLink, modeOfPage };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCard);
  else initCard();
})();
