'use strict';
// Маршрутизация, сторона специалиста: в карточке пациента блок «Данные другого специалиста» (только чтение) и
// канал сообщений между связанными специалистами. API — GET /api/v1/patients/{id}/colleagues и
// POST /api/v1/patients/{id}/colleagues/{linkId}/messages. Блока нет, если связи нет (ответ 404).
window.CCColleague = {
  async mount(holder, patientId, { tx, esc }) {
    const ROLE = { psychiatrist: 'психиатр', psychologist: 'психолог' };
    const day = (iso) =>
      iso ? new Date(String(iso).length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString('ru-RU') : '';
    let data;
    try {
      const res = await fetch(`/api/v1/patients/${encodeURIComponent(patientId)}/colleagues`, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!res.ok) return;
      data = await res.json();
    } catch (_) {
      return;
    }
    const post = async (linkId, text) => {
      const token = (await (await fetch('/api/v1/csrf')).json()).token;
      return fetch(`/api/v1/patients/${encodeURIComponent(patientId)}/colleagues/${linkId}/messages`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token, 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ text }),
      });
    };
    const old = holder.querySelector('[data-colleague]');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.dataset.colleague = '';
    for (const item of data.items || []) {
      const c = item.colleague;
      const label = `${ROLE[c.role] || ''} ${c.full_name}`.trim();
      const sec = document.createElement('section');
      sec.className = 'ov-section colleague-block';
      sec.dataset.testid = 'msg.colleague.title';
      sec.dataset.linkId = String(item.id);
      let body = '';
      if (item.shared.tests) {
        body = item.shared.tests.length
          ? `<h3>${esc(tx('msg.colleague.tests'))}</h3><ul>${item.shared.tests
              .map(
                (t) =>
                  `<li>${esc(t.instrument)}: ${esc(t.score ?? '—')}${t.band ? ` · ${esc(t.band)}` : ''} · ${esc(day(t.date))}</li>`,
              )
              .join('')}</ul>`
          : `<p>${esc(tx('msg.colleague.tests.empty'))}</p>`;
      } else if (item.shared.meds) {
        body = item.shared.meds.length
          ? `<h3>${esc(tx('msg.colleague.meds'))}</h3><ul>${item.shared.meds
              .map(
                (m) =>
                  `<li>${esc(m.inn_name)}${m.dose ? ` ${esc(m.dose)} ${esc(m.unit || '')}` : ''}${m.times && m.times.length ? ` · ${esc(m.times.join(', '))}` : ''}</li>`,
              )
              .join('')}</ul>`
          : `<p>${esc(tx('msg.colleague.meds.empty'))}</p>`;
      }
      const msgs = (item.messages || [])
        .map((m) => `<div class="colleague-msg${m.mine ? ' mine' : ''}">${esc(m.body)}</div>`)
        .join('');
      sec.innerHTML = `<h2>${esc(tx('msg.colleague.title'))}</h2><p class="colleague-note" data-testid="msg.colleague.note">${esc(tx('msg.colleague.note').replace('{who}', label))}</p>${body}<h3>${esc(tx('msg.colleague.chat'))}</h3><div class="colleague-msgs" role="log" aria-live="polite">${msgs || `<p class="colleague-note">${esc(tx('msg.colleague.chat.empty'))}</p>`}</div><form class="colleague-form"><input name="text" maxlength="2000" autocomplete="off" aria-label="${esc(tx('msg.colleague.chat.input'))}" placeholder="${esc(tx('msg.colleague.chat.input'))}"><button type="submit" class="btn primary" data-testid="msg.colleague.chat.send">${esc(tx('msg.colleague.chat.send'))}</button></form>`;
      sec.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = e.target.elements.text;
        const text = input.value.trim();
        if (!text) return;
        input.disabled = true;
        const res = await post(item.id, text);
        input.disabled = false;
        if (res.ok) {
          input.value = '';
          window.CCColleague.mount(holder, patientId, { tx, esc });
        }
      });
      wrap.append(sec);
    }
    if (wrap.children.length) holder.append(wrap);
  },
};
