'use strict';

/**
 * Админка (вкладки: Обзор · Запросы · Люди · Настройки · Аудит · Контент · Аналитика · Аналитика сервиса · Сервис).
 * Все данные — из служебных API администратора (пациенты — только номерами, PD-20). Где серверной
 * части ещё нет, экран нарисован и помечен «скоро»; перечень — docs/DEMO_GAPS.md.
 * data-testid совпадают с ключами locales/ru.json.
 */
(function () {
  const q = (s, r = document) => r.querySelector(s);
  const qa = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  let TX = {};
  const tx = (key, fallback = '', vars = {}) => {
    let text = TX[key] || fallback || key;
    for (const [k, v] of Object.entries(vars)) text = text.replace(`{${k}}`, v);
    return text;
  };
  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const pad = (n) => String(n).padStart(2, '0');
  const when = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : `${d.getDate()} ${MONTHS[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const ago = (iso) => {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (Number.isNaN(m)) return '';
    if (m < 60) return `${Math.max(1, m)} мин`;
    if (m < 1440) return `${Math.round(m / 60)} ч`;
    return `${Math.round(m / 1440)} дн.`;
  };
  const soon = (text = 'скоро') =>
    `<span class="soon" title="Интерфейс готов, серверная часть в работе">${esc(text)}</span>`;
  const ROLE = { patient: 'пациент', psychiatrist: 'психиатр', psychologist: 'психолог', admin: 'администратор' };
  const icon = (name, cls = '') =>
    `<svg class="i${cls ? ' ' + cls : ''}" aria-hidden="true" focusable="false"><use href="/icons.svg#i-${name}"/></svg>`;
  // Слой подписей: технический код остаётся в данных, на экране — слово из ru.json
  // (msg.admin.lbl.<вид>.<код>). Неизвестный код — «Другое …» и предупреждение в консоль, не сырой код.
  const lbl = (kind, code) => {
    const key = `msg.admin.lbl.${kind}.${code}`;
    if (TX[key]) return TX[key];
    console.warn('admin: нет подписи для кода', kind, code);
    return TX[`msg.admin.lbl.${kind}.unknown`] || '';
  };
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const decisionPill = (code) => {
    if (!code) return '—';
    const tone = code === 'allow' ? 'ok' : code === 'deny' || code === 'кризис' ? 'err' : 'warn';
    const ic = tone === 'ok' ? 'check-circle' : tone === 'err' ? 'warning-circle' : 'info';
    return `<span class="st-pill ${tone}">${icon(ic)}${esc(lbl('dec', code))}</span>`;
  };
  const objectText = (raw) => {
    const m = /^([a-z_]+)#(\d+)$/.exec(String(raw || ''));
    if (m) return `${lbl('obj', m[1])} № ${m[2]}`;
    return String(raw || '');
  };

  async function get(path) {
    try {
      const r = await fetch(path, { headers: { Accept: 'application/json' } });
      return r.ok ? await r.json() : null;
    } catch (_) {
      return null;
    }
  }
  async function send(path, method, body) {
    const token = (await (await fetch('/api/v1/csrf')).json()).token;
    const r = await fetch(path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': token,
        'idempotency-key': crypto.randomUUID(),
        Accept: 'application/json',
      },
      body: JSON.stringify(body || {}),
    });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
  }
  const post = (p, b) => send(p, 'POST', b);
  const put = (p, b) => send(p, 'PUT', b);
  // Набор для отдельных модулей экранов (public/js/admin_invites.js).
  window.adminKit = { get, post, dialog: (...a) => dialog(...a), esc, tx, icon, fmtDate, clinicians: () => clinicians() };

  // Роль и отметки сотрудника (F-92): психиатр, психолог или администратор; отметки «клинический
  // руководитель» (только психиатр), «исследования», «проверяет справочник» (психиатр или админ).
  const FLAG_LABELS = [
    ['clinical_lead', 'Клинический руководитель', 'Только для психиатра'],
    ['research', 'Исследования', 'Раздел исследований'],
    ['reference_reviewer', 'Проверяет справочник', 'Проверка препаратов в «Контенте»; психиатр или администратор'],
  ];
  async function drawAccess(box, person) {
    const card = await get(`/api/v1/admin/people/${person.id}`);
    if (!card || !card.flags) return;
    const roles = [
      ['psychiatrist', 'Психиатр'],
      ['psychologist', 'Психолог'],
      ['admin', 'Администратор'],
    ];
    box.innerHTML = `<h3>Роль и отметки</h3><div class="adm-action"><div><b>Роль</b><small>Чтобы сделать специалиста администратором, сначала открепите его пациентов</small></div><select data-person-role aria-label="Роль">${roles.map(([v, l]) => `<option value="${v}"${card.role === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>${FLAG_LABELS.map(([k, l, hint]) => `<label class="adm-action"><div><b>${l}</b><small>${hint}</small></div><input type="checkbox" data-flag="${k}"${card.flags[k] ? ' checked' : ''}></label>`).join('')}<p class="sub" data-access-out aria-live="polite"></p>`;
    const out = q('[data-access-out]', box);
    const reason = (r) =>
      r.status === 403
        ? 'Свою роль и отметки менять нельзя.'
        : r.status === 409
          ? r.data?.error?.code === 'E-LAST-ADMIN'
            ? 'Это последний администратор.'
            : 'Сначала открепите пациентов этого специалиста.'
          : r.status === 422
            ? 'Эта отметка не подходит к роли.'
            : 'Не получилось.';
    q('[data-person-role]', box).addEventListener('change', async (ev) => {
      const r = await put(`/api/v1/admin/people/${person.id}/role`, { role: ev.target.value });
      if (!r.ok) {
        ev.target.value = card.role;
        out.textContent = reason(r);
        return;
      }
      card.role = ev.target.value;
      person.role = ev.target.value;
      out.textContent = 'Роль изменена.';
    });
    for (const input of qa('[data-flag]', box))
      input.addEventListener('change', async () => {
        const r = await put(`/api/v1/admin/people/${person.id}/flags`, { [input.dataset.flag]: input.checked });
        if (!r.ok) {
          input.checked = !input.checked;
          out.textContent = reason(r);
          return;
        }
        out.textContent = 'Отметка сохранена.';
      });
  }

  function dialog(html, onMount) {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    // Крестик в правом верхнем углу у каждого окна, как в обычных программах.
    bg.innerHTML = `<div class="modal wide" role="dialog" aria-modal="true"><button type="button" class="round modal-x" data-x aria-label="${esc(tx('msg.shell.close', 'Закрыть'))}">${icon('x')}</button>${html}</div>`;
    document.body.appendChild(bg);
    const close = () => bg.remove();
    bg.addEventListener('click', (e) => {
      if (e.target === bg || e.target.closest('[data-x]')) close();
    });
    if (onMount) onMount(bg, close);
    return { bg, close };
  }

  // ---------- Запросы ----------
  const KIND = {
    crisis_no_clinician: ['msg.admin.requests.type.crisis_nobody', 'Кризис без специалиста', 'r'],
    crisis_manual_review: ['msg.admin.requests.type.crisis_manual', 'Кризис: нужен ручной разбор', 'r'],
    ae_no_psychiatrist: ['msg.admin.requests.type.ae_nobody', 'Побочный эффект без психиатра', 'y'],
    message_no_clinician: ['msg.admin.requests.type.message_nobody', 'Сообщение без специалиста', 'y'],
    patient_without_clinician: ['msg.admin.requests.type.patient_nobody', 'Пациент остался без специалиста', 'y'],
    erasure: ['msg.admin.requests.type.deletion', 'Удаление аккаунта', 'y'],
    subject_info: ['msg.admin.requests.type.info', 'Сведения о данных', 'n'],
    stop_processing: ['msg.admin.requests.type.stop', 'Прекращение обработки', 'n'],
    dispute_access: ['msg.admin.requests.type.strange', '«Это странно»', 'n'],
    change_clinician: ['msg.admin.requests.type.change', 'Смена специалиста', 'n'],
    substitution: ['msg.admin.requests.type.substitution', 'Замещение', 'n'],
    mail_failed: ['msg.admin.requests.type.mail', 'Письмо не отправлено', 'n'],
    job_failed: ['msg.admin.requests.type.job', 'Фоновая задача не работает', 'n'],
    ai_budget: ['msg.admin.requests.type.budget', 'Бюджет ИИ', 'n'],
    correction_overdue: ['msg.admin.requests.type.info', 'Исправление просрочено', 'y'],
    catalog_review: ['msg.admin.requests.type.info', 'Проверка препарата', 'n'],
  };
  const URGENT = ['crisis_no_clinician', 'crisis_manual_review', 'ae_no_psychiatrist'];

  async function clinicians() {
    const data = await get('/api/v1/admin/people');
    return ((data && data.items) || []).filter(
      (p) => ['psychiatrist', 'psychologist'].includes(p.role) && p.status === 'active',
    );
  }

  async function requests(root) {
    const me = Number(root.dataset.me);
    let mode = 'open';
    const render = async () => {
      const [openData, mineData, allData] = await Promise.all([
        get('/api/v1/admin/requests?filter=open'),
        get('/api/v1/admin/requests?filter=mine'),
        get('/api/v1/admin/requests?filter=all'),
      ]);
      const open = (openData && openData.items) || [];
      const mine = (mineData && mineData.items) || [];
      const all = (allData && allData.items) || [];
      const closed = all.filter((x) => ['done', 'rejected'].includes(x.status));
      const overdue = open.filter((x) => x.due_at && new Date(x.due_at) < new Date());
      const list = mode === 'open' ? open : mode === 'mine' ? mine : mode === 'overdue' ? overdue : closed;
      const pill = (m, key, fb, n) =>
        `<button type="button" class="pill${mode === m ? ' on' : ''}" data-mode="${m}">${esc(tx(key, fb, { n: n ?? '' }))}</button>`;
      const row = (x) => {
        const [key, fb] = KIND[x.kind] || ['', lbl('req', x.kind), 'n'];
        const urgent = URGENT.includes(x.kind);
        const left = x.due_at ? Math.ceil((new Date(x.due_at) - Date.now()) / 86400000) : null;
        const meta = [
          x.patient_no
            ? tx('msg.admin.requests.meta.patient', '', { patient_no: x.patient_no, ago: ago(x.created_at) })
            : ago(x.created_at),
          urgent
            ? `<span data-testid="msg.admin.requests.meta.no_text">${esc(tx('msg.admin.requests.meta.no_text', 'Текст не показывается'))}</span>`
            : '',
          left === null
            ? ''
            : left < 0
              ? tx('msg.admin.requests.meta.overdue', '', { n: -left })
              : tx('msg.admin.requests.meta.left_days', '', { n: left }),
        ].filter(Boolean);
        const taken = x.status === 'taken';
        const actions = ['done', 'rejected'].includes(x.status)
          ? ''
          : !taken
            ? `<button type="button" class="btn${urgent ? ' primary' : ''}" data-testid="msg.admin.requests.take" data-take="${x.id}">${esc(tx('msg.admin.requests.take', 'Взять'))}</button>`
            : x.kind === 'erasure'
              ? `<button type="button" class="btn primary" data-erase="${x.id}" data-no="${esc(x.patient_no || '')}">${esc(tx('msg.admin.requests.execute', 'Выполнить'))}</button>`
              : ['change_clinician'].includes(x.kind)
                ? `<button type="button" class="btn primary" data-change="${x.id}">${esc(tx('msg.admin.requests.choose', 'Выбрать специалиста'))}</button>`
                : ['subject_info', 'stop_processing', 'dispute_access'].includes(x.kind)
                  ? `<button type="button" class="btn primary" data-answer="${x.id}">${esc(tx('msg.admin.requests.prepare', 'Подготовить ответ'))}</button>`
                  : `<button type="button" class="btn primary" data-testid="msg.admin.requests.assign" data-assign="${x.id}">${esc(tx('msg.admin.requests.assign', 'Назначить специалиста'))}</button>`;
        const crisis = ['crisis_no_clinician', 'crisis_manual_review'].includes(x.kind);
        return `<div class="qrow${crisis ? ' qrow--crisis' : ''}" data-id="${x.id}"><span class="q-ic">${icon(urgent ? 'warning-circle' : 'chat-circle')}</span><div class="q-main"><b data-testid="msg.admin.requests.type.${esc({ crisis_no_clinician: 'crisis_nobody' }[x.kind] || x.kind)}">${esc(tx(key, fb))}</b><small>${meta.map((m) => (m.startsWith('<span') ? m : esc(m))).join(' · ')}${taken ? ' · ' + esc(tx('msg.admin.requests.in_work', 'В работе', { name: x.taken_by === me ? 'вами' : 'коллегой', time: when(x.taken_at || '') })) : ''}</small></div><div class="q-act">${actions}${actions && !crisis && taken ? `<button type="button" class="btn ghost" data-close="${x.id}">${esc(tx('msg.admin.requests.close', 'Закрыть'))}</button>` : ''}</div></div>`;
      };
      root.innerHTML = `<div class="adm-bar"><div class="filters req-filters">${pill('open', 'msg.admin.requests.filter.open', 'Открытые · {n}', open.length)}${pill('mine', 'msg.admin.requests.filter.mine', 'Мои · {n}', mine.length)}${pill('overdue', 'msg.admin.requests.filter.overdue', 'Просроченные · {n}', overdue.length)}${pill('closed', 'msg.admin.requests.filter.closed', 'Закрытые', null)}</div></div><div data-list>${
        list.length
          ? list.map(row).join('')
          : `<div class="empty">${icon('check-circle', 'i--32')}<h3>${esc(tx('msg.admin.requests.empty', 'Запросов нет'))}</h3><p>${esc(tx('msg.admin.requests.empty_hint', 'Новые обращения появятся здесь сами'))}</p></div>`
      }</div><p class="sub adm-out" data-out aria-live="polite"></p>`;
    };
    await render();
    root.addEventListener('click', async (e) => {
      const out = () => q('[data-out]', root);
      const mode2 = e.target.closest('[data-mode]');
      if (mode2) {
        mode = mode2.dataset.mode;
        return render();
      }
      const take = e.target.closest('[data-take]');
      if (take) {
        const r = await post(`/api/v1/admin/requests/${take.dataset.take}/take`, {});
        if (!r.ok) out().textContent = 'Запрос уже взят коллегой.';
        else mode = 'mine';
        return render();
      }
      const assign = e.target.closest('[data-assign]');
      if (assign) {
        const staff = await clinicians();
        dialog(
          `<h3>${esc(tx('msg.admin.requests.assign', 'Назначить специалиста'))}</h3><div class="choices"><button type="button" class="choice" data-testid="msg.admin.requests.assign.only_signal" data-mode="only_signal" aria-pressed="true">${esc(tx('msg.admin.requests.assign.only_signal', 'Только этот сигнал'))}</button><button type="button" class="choice" data-mode="attach" aria-pressed="false">${esc(tx('msg.admin.requests.assign.attach', 'Закрепить пациента'))}</button></div><div class="pop-list" role="listbox">${staff.map((p) => `<button type="button" role="option" class="it" data-who="${p.id}">${esc(p.name)} <small>${esc(ROLE[p.role])}</small></button>`).join('') || '<p class="muted">Нет активных специалистов</p>'}</div><p class="sub" data-d-out></p><div class="acts"><button type="button" class="btn ghost" data-x>Отмена</button><button type="button" class="btn primary" data-testid="msg.admin.requests.confirm" data-go>${esc(tx('msg.admin.requests.confirm', 'Подтвердить'))}</button></div>`,
          (bg, close) => {
            let who = null;
            let how = 'only_signal';
            bg.addEventListener('click', async (ev) => {
              const c = ev.target.closest('.choice');
              if (c) {
                qa('.choice', bg).forEach((x) => x.setAttribute('aria-pressed', String(x === c)));
                how = c.dataset.mode;
              }
              const w = ev.target.closest('[data-who]');
              if (w) {
                qa('[data-who]', bg).forEach((x) => x.classList.toggle('on', x === w));
                who = w.dataset.who;
              }
              if (ev.target.closest('[data-go]')) {
                if (!who) return (q('[data-d-out]', bg).textContent = 'Выберите специалиста.');
                const r = await post(`/api/v1/admin/requests/${assign.dataset.assign}/assign-clinician`, {
                  clinician_id: Number(who),
                  mode: how,
                });
                if (!r.ok) return (q('[data-d-out]', bg).textContent = 'Не получилось назначить.');
                close();
                await render();
                out().innerHTML =
                  '<span data-testid="msg.undo.admin.assigned">Специалист назначен · </span><button type="button" class="link" data-testid="msg.undo.action">Отменить</button>';
              }
            });
          },
        );
        return;
      }
      const change = e.target.closest('[data-change]');
      if (change) {
        const staff = await clinicians();
        dialog(
          `<h3>Выбрать специалиста</h3><div class="pop-list" role="listbox">${staff.map((p) => `<button type="button" role="option" class="it" data-who="${p.id}">${esc(p.name)} <small>${esc(ROLE[p.role])}</small></button>`).join('')}</div><div class="choices"><button type="button" class="choice" data-mode="replace" aria-pressed="true">${esc(tx('msg.admin.requests.replace', 'Заменить'))}</button><button type="button" class="choice" data-mode="add" aria-pressed="false">${esc(tx('msg.admin.requests.add', 'Добавить'))}</button></div><p class="sub" data-d-out></p><div class="acts"><button type="button" class="btn ghost" data-x>Отмена</button><button type="button" class="btn primary" data-go>${esc(tx('msg.admin.requests.confirm', 'Подтвердить'))}</button></div>`,
          (bg, close) => {
            let who = null;
            let how = 'replace';
            bg.addEventListener('click', async (ev) => {
              const c = ev.target.closest('.choice');
              if (c) {
                qa('.choice', bg).forEach((x) => x.setAttribute('aria-pressed', String(x === c)));
                how = c.dataset.mode;
              }
              const w = ev.target.closest('[data-who]');
              if (w) {
                qa('[data-who]', bg).forEach((x) => x.classList.toggle('on', x === w));
                who = w.dataset.who;
              }
              if (ev.target.closest('[data-go]')) {
                if (!who) return (q('[data-d-out]', bg).textContent = 'Выберите специалиста.');
                const r = await post(`/api/v1/admin/requests/${change.dataset.change}/clinician-change`, {
                  new_clinician_id: Number(who),
                  mode: how,
                });
                if (!r.ok) return (q('[data-d-out]', bg).textContent = 'Не получилось выполнить.');
                close();
                render();
              }
            });
          },
        );
        return;
      }
      const erase = e.target.closest('[data-erase]');
      if (erase) {
        dialog(
          `<h3>Удалить данные пациента?</h3><p>Действие необратимо. Для подтверждения введите номер пациента: <b>${esc(erase.dataset.no)}</b></p><label class="arch-sum">Номер пациента<input type="text" data-no></label><p class="sub" data-d-out></p><div class="acts"><button type="button" class="btn ghost" data-x>Отмена</button><button type="button" class="btn primary danger-fill" data-go>Удалить</button></div>`,
          (bg, close) =>
            bg.addEventListener('click', async (ev) => {
              if (!ev.target.closest('[data-go]')) return;
              const r = await post(`/api/v1/admin/requests/${erase.dataset.erase}/execute-erasure`, {
                confirm_service_no: q('[data-no]', bg).value.trim(),
              });
              if (!r.ok) return (q('[data-d-out]', bg).textContent = 'Номер не совпал или удаление недоступно.');
              close();
              render();
            }),
        );
        return;
      }
      const answer = e.target.closest('[data-answer]');
      if (answer) {
        dialog(
          `<h3>Ответ пациенту</h3><div class="choices"><button type="button" class="choice" data-decision="grant" aria-pressed="true">Выдать сведения</button><button type="button" class="choice" data-decision="deny" aria-pressed="false">Отказать с объяснением</button></div><p class="sub" data-d-out></p><div class="acts"><button type="button" class="btn ghost" data-x>Отмена</button><button type="button" class="btn primary" data-go>${esc(tx('msg.admin.requests.issue', 'Выдать пациенту'))}</button></div>`,
          (bg, close) => {
            let decision = 'grant';
            bg.addEventListener('click', async (ev) => {
              const c = ev.target.closest('.choice');
              if (c) {
                qa('.choice', bg).forEach((x) => x.setAttribute('aria-pressed', String(x === c)));
                decision = c.dataset.decision;
              }
              if (ev.target.closest('[data-go]')) {
                const r = await post(`/api/v1/admin/requests/${answer.dataset.answer}/answer`, {
                  decision,
                  template_key: 'default',
                });
                if (!r.ok) return (q('[data-d-out]', bg).textContent = 'Не получилось отправить ответ.');
                close();
                render();
              }
            });
          },
        );
        return;
      }
      const close = e.target.closest('[data-close]');
      if (close) {
        await post(`/api/v1/admin/requests/${close.dataset.close}/close`, { result_code: 'done' });
        render();
      }
    });
  }

  // ---------- Люди ----------
  async function people(root) {
    let filter = 'all';
    let needle = '';
    let revealed = {};
    let selectedId = null;
    let limit = 30;
    const data = await get('/api/v1/admin/people');
    const items = (data && data.items) || [];
    const draw = () => {
      const f = (p) => {
        if (filter === 'staff') return ['psychiatrist', 'psychologist'].includes(p.role);
        if (filter === 'admins') return p.role === 'admin';
        if (filter === 'patients') return p.role === 'patient';
        if (filter === 'blocked') return p.status === 'blocked';
        if (filter === 'archive') return p.status === 'archived';
        return true;
      };
      const rows = items
        .filter(f)
        .filter(
          (p) =>
            !needle || `${p.label} ${p.service_no} ${p.name || ''} ${p.email || ''}`.toLowerCase().includes(needle),
        );
      const pill = (k, key, fb) =>
        `<button type="button" class="pill${filter === k ? ' on' : ''}" data-filter="${k}" data-testid="msg.admin.people.filter.${k}">${esc(tx(key, fb))}</button>`;
      const STATUS_TXT = {
        active: '',
        blocked: 'заблокирован',
        archived: 'архив',
        deletion_requested: 'запрошено удаление',
      };
      q('[data-people-list]', root).innerHTML = rows.length
        ? rows
            .slice(0, limit)
            .map((p) => {
              const shown = revealed[p.id];
              const name = p.role === 'patient' ? (shown ? shown.name : p.label) : p.label;
              const initials =
                p.role === 'patient'
                  ? '#'
                  : String(p.label)
                      .split(/\s+/)
                      .slice(0, 2)
                      .map((w) => w[0])
                      .join('')
                      .toUpperCase();
              const sub = [
                ROLE[p.role],
                p.status !== 'active' ? STATUS_TXT[p.status] || lbl('pstatus', p.status) : '',
                p.must_change_password ? 'временный пароль' : '',
                p.chat_troll
                  ? `${tx('msg.admin.people.troll', 'ТРОЛЛЬ')} · ${tx('msg.admin.people.troll.until', 'Пауза чата до {t}', { t: when(p.chat_troll.until) })}`
                  : '',
                shown ? shown.email : '',
              ].filter(Boolean);
              return `<div class="prow${String(selectedId) === String(p.id) ? ' on' : ''}" data-id="${p.id}"><span class="avatar-sm">${esc(initials)}</span><div><b>${esc(name)}</b><small>${esc(sub.join(' · '))}</small></div><div class="p-act">${p.role === 'patient' && p.chat_troll ? `<button type="button" class="btn sm" data-troll-clear="${p.id}" title="${esc(tx('msg.admin.people.troll.note', ''))}" data-testid="msg.admin.people.troll.clear">${esc(tx('msg.admin.people.troll.clear', 'Снять статус'))}</button>` : ''}${p.role === 'patient' && !shown ? `<button type="button" class="btn ghost sm" data-reveal="${p.id}">Показать</button>` : ''}${p.status === 'blocked' ? `<button type="button" class="btn sm" data-unblock="${p.id}">Разблокировать</button>` : p.role !== 'patient' ? `<button type="button" class="btn ghost sm" data-open="${p.id}">Открыть</button>` : ''}</div></div>`;
            })
            .join('') +
          (rows.length > limit
            ? `<div class="adm-pager"><button type="button" class="btn" data-more>${esc(tx('msg.admin.people.more', 'Показать ещё'))}</button><span class="adm-note">${esc(tx('msg.admin.people.shown', 'Показано {a} из {b}', { a: limit, b: rows.length }))}</span></div>`
            : '')
        : `<div class="empty">${icon('users', 'i--32')}<h3>${esc(tx('msg.admin.people.empty', 'Пользователей пока нет — создайте первого сотрудника'))}</h3></div>`;
      qa('.people-filters .pill', root).forEach((b) => b.classList.toggle('on', b.dataset.filter === filter));
    };
    root.innerHTML = `<div class="people-head"><input type="search" class="search-in" placeholder="${esc(tx('msg.admin.people.search', 'Имя, почта сотрудника, #номер или точная почта пациента'))}" aria-label="${esc(tx('msg.admin.people.search_label', 'Поиск'))}" data-search><button type="button" class="btn primary" data-testid="msg.admin.people.new_staff" data-new>${icon('plus')}${esc(tx('msg.admin.people.new_staff', '+ Сотрудник').replace(/^\+\s*/, ''))}</button><button type="button" class="btn" data-testid="msg.admin.invites.open" data-invites>${esc(tx('msg.admin.invites.open', 'Приглашения'))}</button></div><div class="adm-bar"><div class="filters people-filters">${[
      'all|msg.admin.people.filter.all|Все',
      'staff|msg.admin.people.filter.staff|Специалисты',
      'admins|msg.admin.people.filter.admins|Админы',
      'patients|msg.admin.people.filter.patients|Пациенты',
      'blocked|msg.admin.people.filter.blocked|Заблокированы',
      'archive|msg.admin.people.filter.archive|Архив',
    ]
      .map((s) => {
        const [k, key, fb] = s.split('|');
        return `<button type="button" class="pill${k === 'all' ? ' on' : ''}" data-filter="${k}" data-testid="msg.admin.people.filter.${k}">${esc(tx(key, fb))}</button>`;
      })
      .join(
        '',
      )}</div></div><div class="adm-people" data-people-grid><div class="adm-people-list" data-people-list></div><div data-people-panel></div></div><p class="sub adm-out" data-out aria-live="polite"></p>`;
    draw();
    q('[data-search]', root).addEventListener('input', (e) => {
      needle = e.target.value.trim().toLowerCase();
      limit = 30;
      draw();
    });
    root.addEventListener('click', async (e) => {
      const f = e.target.closest('[data-filter]');
      if (f) {
        filter = f.dataset.filter;
        limit = 30;
        return draw();
      }
      if (e.target.closest('[data-more]')) {
        limit += 30;
        return draw();
      }
      const rev = e.target.closest('[data-reveal]');
      if (rev) {
        const r = await post(`/api/v1/admin/people/${rev.dataset.reveal}/reveal-contacts`, {});
        if (r.ok) {
          revealed[rev.dataset.reveal] = r.data;
          draw();
        }
        return;
      }
      const troll = e.target.closest('[data-troll-clear]');
      if (troll) {
        const r = await post(`/api/v1/admin/people/${troll.dataset.trollClear}/chat-troll/clear`, {});
        if (r.ok) {
          const p = items.find((x) => String(x.id) === troll.dataset.trollClear);
          if (p) p.chat_troll = null;
          q('[data-out]', root).textContent = tx('msg.admin.people.troll.cleared', 'Статус снят.');
          draw();
        }
        return;
      }
      const un = e.target.closest('[data-unblock]');
      if (un) {
        const r = await post(`/api/v1/admin/people/${un.dataset.unblock}/status`, { action: 'unblock' });
        if (r.ok) {
          const p = items.find((x) => String(x.id) === un.dataset.unblock);
          if (p) p.status = 'active';
          draw();
        }
        return;
      }
      const open = e.target.closest('[data-open]');
      if (open) {
        const p = items.find((x) => String(x.id) === open.dataset.open);
        selectedId = p.id;
        draw();
        const host = q('[data-people-panel]', root);
        host.innerHTML = `<aside class="panel panel--adm" aria-label="${esc(p.label)}"><div class="panel-head"><h2>${esc(p.label)}</h2><button type="button" class="round" data-pclose aria-label="${esc(tx('msg.admin.people.panel_close', 'Закрыть'))}">${icon('x')}</button></div><div class="panel-body"><dl class="adm-kv"><dt>${esc(tx('msg.admin.people.f_role', 'Роль'))}</dt><dd>${esc(ROLE[p.role])}</dd><dt>${esc(tx('msg.admin.people.f_email', 'Почта'))}</dt><dd>${esc(p.email || '—')}</dd></dl><div><div class="adm-action"><div><b>Сбросить пароль</b><small>Временный пароль показывается один раз</small></div><button type="button" class="btn sm" data-act="reset">Сбросить</button></div><div class="adm-action"><div><b>Заблокировать</b><small>Сеансы закроются сразу; блокировку можно снять</small></div><button type="button" class="btn danger sm" data-act="block">Заблокировать</button></div><div class="adm-action"><div><b>Второй фактор входа</b><small>${esc(tx('msg.admin.people.2fa_off', 'Второй фактор: выключен'))}</small></div>${soon()}</div></div><div data-access></div><p class="sub" data-d-out aria-live="polite"></p></div></aside>`;
        const panel = q('.panel', host);
        if (p.role !== 'patient') drawAccess(q('[data-access]', panel), p);
        panel.addEventListener('click', async (ev) => {
          if (ev.target.closest('[data-pclose]')) {
            selectedId = null;
            host.innerHTML = '';
            draw();
            return;
          }
          const a = ev.target.closest('[data-act]');
          if (!a) return;
          const out = q('[data-d-out]', panel);
          if (a.dataset.act === 'reset') {
            const r = await post(`/api/v1/admin/people/${p.id}/password-reset`, {});
            out.innerHTML = r.ok
              ? `Временный пароль: <code>${esc(r.data.temporary_password)}</code>`
              : 'Не получилось.';
          } else {
            const r = await post(`/api/v1/admin/people/${p.id}/status`, { action: 'block', reason_key: 'other' });
            out.textContent = r.ok
              ? 'Заблокирован.'
              : r.status === 409
                ? 'Последнего администратора блокировать нельзя.'
                : 'Не получилось.';
            if (r.ok) {
              p.status = 'blocked';
              draw();
            }
          }
        });
        return;
      }
      if (e.target.closest('[data-invites]')) {
        if (window.adminInvites) window.adminInvites.open();
        return;
      }
      if (e.target.closest('[data-new]')) {
        dialog(
          `<h3>Новый сотрудник</h3><form class="form" data-staff><label>Имя и фамилия<input name="full_name" type="text" required maxlength="120"></label><label>Почта<input name="email" type="email" required></label><label>Роль<select name="role"><option value="psychiatrist">Психиатр</option><option value="psychologist">Психолог</option></select></label><p class="sub" data-d-out aria-live="polite"></p><div class="acts"><button type="button" class="btn ghost" data-x>Отмена</button><button type="submit" class="btn primary" data-testid="msg.admin.settings.save">${esc(tx('msg.admin.settings.save', 'Сохранить'))}</button></div></form>`,
          (bg) =>
            q('[data-staff]', bg).addEventListener('submit', async (ev) => {
              ev.preventDefault();
              const form = ev.target;
              const r = await post('/api/v1/admin/staff', {
                full_name: form.full_name.value,
                email: form.email.value,
                role: form.role.value,
              });
              const out = q('[data-d-out]', bg);
              if (!r.ok) {
                out.textContent = r.status === 409 ? 'Эта почта уже занята.' : 'Проверьте поля.';
                return;
              }
              out.innerHTML = `<span data-testid="msg.undo.admin.created">Создан · </span>временный пароль (показывается один раз): <code>${esc(r.data.temporary_password)}</code>`;
              items.unshift({
                id: r.data.user.id,
                label: r.data.user.full_name,
                name: r.data.user.full_name,
                role: r.data.user.role,
                status: 'active',
                service_no: '—',
                email: r.data.user.email,
                must_change_password: true,
              });
              draw();
            }),
        );
      }
    });
  }

  // ---------- Настройки ----------
  const GROUPS = [
    ['work', 'msg.admin.settings.tab.work', 'Работа'],
    ['clinic', 'msg.admin.settings.tab.clinic', 'Клиника'],
    ['lists', 'msg.admin.settings.tab.lists', 'Списки'],
    ['retention', 'msg.admin.settings.tab.retention', 'Хранение'],
    ['ai', 'msg.admin.settings.tab.ai', 'ИИ'],
    ['prompt', 'msg.admin.settings.tab.prompt', 'Промпт'],
    ['pii', 'msg.admin.settings.tab.pii', 'Псевдонимизация'],
  ];
  const TITLES = {
    'crisis.sla': 'Срок реакции на кризисную фразу',
    'crisis.contacts': 'Кризисные контакты',
    'crisis.outcome_due_hours': 'Срок отметки исхода кризиса',
    'crisis.backup': 'Запасные получатели кризисных сигналов',
    'messages.channel': 'Срок ответа на сообщение',
    'ai.enabled': 'ИИ включён',
    'ai.limits': 'Лимиты ИИ',
    'ai.timeouts': 'Таймауты ИИ',
    'ai.eval.threshold': 'Порог проверки качества ИИ',
    'analytics.min_group': 'Минимальная группа в аналитике',
    'auth.admin_second_factor': 'Второй фактор у администраторов',
    'auth.session_timeouts': 'Время жизни сеанса',
    'course_support.rules': 'Советы по ходу курса',
    'pv.responsible': 'Ответственный по фармаконадзору',
    'ae.detect_dictionary': 'Словарь признаков побочных эффектов',
    'voice.max_seconds': 'Длина голосового сообщения',
    'files.limits': 'Файлы и фото пациента',
    'org.timezone_hours': 'Часовой пояс и рабочие часы клиники',
    'previsit.days_before': 'Анкета перед приёмом: за сколько дней',
    'previsit.questions': 'Анкета перед приёмом: вопросы',
    'queue.due': 'Сроки по запросам',
    'reference.search': 'Поиск по справочнику препаратов',
    'service.maintenance': 'Технические работы',
    'ui.undo_window_seconds': 'Время на «Отменить»',
    'hints.enabled_real': 'Показывать подсказки в рабочем режиме',
    'triage.thresholds': 'Пороги светофора',
    'lists.block_reasons': 'Причины блокировки',
    'demo.route': 'Маршрут показа',
    'reference.pharmacies': 'Аптеки',
  };
  const FEATURE = {
    ai_rating: 'оценка ответов ИИ',
    course_support: 'советы по ходу курса',
    patient_assistant: 'ИИ-помощник пациента',
    patient_files: 'файлы и фото пациента',
    self_test: 'самостоятельные тесты',
    strange: '«Это странно» в «Моих данных»',
    voice: 'голосовой ввод',
    where_to_buy: '«Где купить»',
  };
  const titleOf = (key) => {
    if (TITLES[key]) return TITLES[key];
    if (key.startsWith('features.')) return `Функция: ${FEATURE[key.slice(9)] || key.slice(9)}`;
    if (key.startsWith('retention.')) return TX[`msg.admin.lbl.set.${key}`] || TX['msg.admin.lbl.set.retention'] || '';
    console.warn('admin: нет названия настройки', key);
    return lbl('set', 'unknown');
  };
  // Значение настройки словами: JSON и коды на экран не выходят (подробности — в окне «Изменить»).
  const plural = (n, one, few, many) => {
    const m = Math.abs(n) % 100;
    const d = m % 10;
    return m > 10 && m < 20 ? many : d === 1 ? one : d > 1 && d < 5 ? few : many;
  };
  const minutes = (n) =>
    n % 60 === 0 && n >= 60
      ? `${n / 60} ${plural(n / 60, 'час', 'часа', 'часов')}`
      : `${n} ${plural(n, 'минута', 'минуты', 'минут')}`;
  const days = (n) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;
  const SET_FORMAT = {
    'auth.session_timeouts': (v) =>
      `Автоматический выход при бездействии — ${minutes(v.idle_minutes)}; сеанс сотрудника — не дольше ${minutes(v.staff_absolute_minutes)}; «запомнить меня» у пациента — ${minutes(v.patient_remember_minutes)}`,
    'auth.admin_second_factor': (v) => (v === 'on' ? 'Включён' : 'Выключено'),
    'analytics.min_group': (v) => `Не меньше ${v} ${plural(v, 'человека', 'человек', 'человек')}`,
    'ui.undo_window_seconds': (v) => `${v} ${plural(v, 'секунда', 'секунды', 'секунд')}`,
    'crisis.outcome_due_hours': (v) => `${v} ${plural(v, 'час', 'часа', 'часов')}`,
    'crisis.sla': (v) => `В рабочее время — ${minutes(v.work_minutes)}, в нерабочее — ${minutes(v.off_minutes)}`,
    'ai.enabled': (v) => (v && v.all === false ? 'ИИ выключен' : 'ИИ включён'),
    'ai.eval.threshold': (v) => `${Math.round(v * 100)} %`,
    'voice.max_seconds': (v) =>
      `Пациент — ${minutes(Math.round(v.patient / 60))}, специалист — ${minutes(Math.round(v.clinician / 60))}`,
    'files.limits': (v) =>
      `До ${v.max_mb} МБ, не больше ${v.max_count} ${plural(v.max_count, 'файла', 'файлов', 'файлов')} за раз`,
    'messages.channel': (v) => `Ответ в течение ${days(v.reply_days)}${v.line ? ` · «${v.line}»` : ''}`,
    'previsit.days_before': (v) =>
      `За ${days(v.days)}${v.reminders ? `, напоминаний: ${v.reminders}` : ', без напоминаний'}`,
    'org.timezone_hours': (v) =>
      `С ${v.work_from} до ${v.work_to}${v.timezone === 'Europe/Moscow' ? ', по Москве' : ''}`,
    'queue.due': (v) =>
      `Сведения — ${days(v.info_days)}, остановка обработки — ${days(v.stop_days)}, удаление — ${days(v.erasure_days)}`,
    'reference.search': (v) =>
      `${v.suggestions} ${plural(v.suggestions, 'подсказка', 'подсказки', 'подсказок')}, от ${v.min_chars} букв`,
    'service.maintenance': (v) => (v && v.on ? 'Включены' : 'Выключены'),
  };
  const summary = (value, key = '') => {
    if (value === null || value === undefined) return 'Не задано';
    if (typeof value === 'boolean') return value ? 'Включено' : 'Выключено';
    try {
      if (SET_FORMAT[key]) return SET_FORMAT[key](value);
    } catch (_) {
      /* ниже общий запасной вариант */
    }
    if (typeof value === 'number') {
      const unit = /_days$/.test(key)
        ? days(value)
        : /_minutes$/.test(key)
          ? minutes(value)
          : /_hours$/.test(key)
            ? `${value} ч`
            : String(value);
      return unit;
    }
    if (typeof value === 'string') return value;
    if (Array.isArray(value))
      return value.length ? `${value.length} ${plural(value.length, 'пункт', 'пункта', 'пунктов')}` : 'Пусто';
    const n = Object.keys(value).length;
    return n ? `Заданы значения (${n}); подробности — в окне «Изменить»` : 'Пусто';
  };

  // ---------- Каталог промптов ИИ (P-40): слои, версии, сравнение, включение и откат ----------
  const PROMPT_ROLES = [
    ['', 'msg.admin.prompt.role.none', 'Без роли (администратор)'],
    ['patient', 'msg.admin.prompt.role.patient', 'Пациент'],
    ['psychiatrist', 'msg.admin.prompt.role.psychiatrist', 'Психиатр'],
    ['psychologist', 'msg.admin.prompt.role.psychologist', 'Психолог'],
  ];
  const PROMPT_STATUS = {
    active: ['msg.admin.prompt.status.active', 'действует'],
    previous: ['msg.admin.prompt.status.previous', 'прежняя'],
    draft: ['msg.admin.prompt.status.draft', 'черновик'],
    pending_approval: ['msg.admin.prompt.status.pending', 'ждёт утверждения'],
    rejected: ['msg.admin.prompt.status.rejected', 'отклонена'],
  };

  // Сравнение: изменённые строки и по две строки контекста вокруг, остальное сворачивается в «…».
  function diffRows(lines) {
    const keep = lines.map(
      (l, i) => l.op !== 'same' || lines.slice(Math.max(0, i - 2), i + 3).some((x) => x.op !== 'same'),
    );
    const out = [];
    lines.forEach((l, i) => {
      if (keep[i]) out.push(l);
      else if (out.length && !out[out.length - 1].gap) out.push({ gap: true });
    });
    return out;
  }

  function promptPane(root) {
    const head = q('.set-head', root);
    while (head && head.nextSibling) head.nextSibling.remove();
    const pane = document.createElement('div');
    pane.setAttribute('data-prompt-pane', '');
    pane.className = 'card adm-card';
    root.appendChild(pane);
    let categories = [];
    let catId = 'task';
    let key = '';
    let list = [];
    let diffHtml = '';
    let composeHtml = '';
    let note = '';
    const url = (suffix = '') => `/api/v1/admin/ai/prompts/${encodeURIComponent(key)}${suffix}`;
    const cat = () => categories.find((c) => c.id === catId) || categories[0];
    const item = () => (cat() ? cat().items.find((e) => e.key === key) : null);
    const loadCatalog = async () => {
      const data = await get('/api/v1/admin/ai/prompts');
      categories = (data && data.categories) || [];
      if (!cat()) return;
      catId = cat().id;
      if (!item()) key = cat().items.length ? cat().items[0].key : '';
    };
    const loadVersions = async () => {
      const data = key ? await get(url('/versions')) : null;
      list = (data && data.items) || [];
    };
    const draw = () => {
      const c = cat();
      if (!c) {
        pane.innerHTML = `<p class="muted pad">${esc(tx('msg.admin.prompt.empty', 'Версий пока нет.'))}</p>`;
        return;
      }
      const it = item();
      const active = list.find((v) => v.active);
      const rows = list
        .map((v) => {
          const st = PROMPT_STATUS[v.status] || [v.status, v.status];
          const compare =
            active && !v.active
              ? `<button type="button" class="btn ghost" data-pdiff="${v.version}">${esc(tx('msg.admin.prompt.compare', 'Сравнить с действующей'))}</button>`
              : '';
          const act = v.active
            ? ''
            : `<button type="button" class="btn" data-pact="${v.version}">${esc(v.status === 'previous' ? tx('msg.admin.prompt.rollback', 'Вернуть эту версию') : tx('msg.admin.prompt.activate', 'Включить'))}</button>`;
          return `<div class="li" data-pver="${v.version}"><div class="grow">v${v.version} · ${esc(tx(st[0], st[1]))}<small>${esc(v.author)} · ${esc(when(v.created_at))}${v.comment ? ` · «${esc(v.comment)}»` : ''}</small></div><button type="button" class="btn ghost" data-pload="${v.version}">${esc(tx('msg.admin.prompt.open', 'В редактор'))}</button>${compare}${act}</div>`;
        })
        .join('');
      const tabs = categories
        .map(
          (x) =>
            `<a class="pill${x.id === c.id ? ' on' : ''}" href="#" data-pcat="${esc(x.id)}"${x.id === c.id ? ' aria-current="page"' : ''}>${esc(x.title)}</a>`,
        )
        .join('');
      const items = c.items
        .map(
          (e) =>
            `<button type="button" class="prompt-item${e.key === key ? ' on' : ''}" data-pitem="${esc(e.key)}"><b>${esc(e.title)}</b><span>${esc(e.description)}</span><small>${esc(tx('msg.admin.prompt.where', 'Где применяется'))}: ${esc(e.where)}</small><small class="prompt-item__meta"><code>${esc(e.key)}</code> · ${e.active_version ? `v${e.active_version}` : '—'} · ${esc(tx('msg.admin.prompt.versions', 'Версии'))}: ${e.versions}</small></button>`,
        )
        .join('');
      const compose =
        it && (c.id === 'task' || c.id === 'skill')
          ? `<div class="card soft prompt-compose"><b>${esc(tx('msg.admin.prompt.compose', 'Итоговый промпт'))}</b><p class="sub">${esc(c.id === 'skill' ? tx('msg.admin.prompt.compose_skill', 'Навык вызывается отдельным запросом: роль к нему не добавляется.') : tx('msg.admin.prompt.compose_lead', 'Так шлюз соберёт инструкцию для выбранной роли: роль, правила инструментов (если есть), задача.'))}</p>${
              c.id === 'task'
                ? `<label class="field"><span>${esc(tx('msg.admin.prompt.compose_role', 'Роль пользователя'))}</span><select data-prole>${PROMPT_ROLES.map(([v, k, fb]) => `<option value="${v}">${esc(tx(k, fb))}</option>`).join('')}</select></label><label class="check"><input type="checkbox" data-ptools> ${esc(tx('msg.admin.prompt.compose_tools', 'С инструментами'))}</label>`
                : ''
            }<div class="acts"><button type="button" class="btn" data-pcompose>${esc(tx('msg.admin.prompt.compose_show', 'Показать'))}</button></div><div data-pcompose-out>${composeHtml}</div></div>`
          : '';
      pane.innerHTML = `<p class="lead">${esc(tx('msg.admin.prompt.lead2', 'Инструкция для модели собирается из слоёв: роль пользователя → правила инструментов → список навыков → задача. Данные пользователя шлюз передаёт отдельным сообщением. Текст версии не меняется: правка создаёт новую версию, включённая версия действует сразу.'))}</p><div class="filters set-tabs prompt-cats">${tabs}</div><p class="sub prompt-cat-note">${esc(c.description)}</p><div class="prompt-items">${items}</div>${
        it
          ? `<div class="card soft prompt-head"><h3>${esc(it.title)}</h3><p>${esc(it.description)}</p><small>${esc(tx('msg.admin.prompt.where', 'Где применяется'))}: ${esc(it.where)}</small></div><div class="list" data-plist>${rows || `<p class="muted pad">${esc(tx('msg.admin.prompt.empty', 'Версий пока нет.'))}</p>`}</div><div data-pdiff-out>${diffHtml}</div><label class="field prompt-field"><span>${esc(tx('msg.admin.prompt.text', 'Текст новой версии'))}</span><textarea class="prompt-text" rows="14" maxlength="20000" data-ptext>${esc(active ? active.text : '')}</textarea></label><label class="field prompt-field"><span>${esc(tx('msg.admin.prompt.comment', 'Комментарий к версии'))}</span><input type="text" maxlength="300" data-pcomment></label><div class="acts prompt-acts"><button type="button" class="btn primary" data-psave>${esc(tx('msg.admin.prompt.save', 'Сохранить как новую версию'))}</button></div><p class="sub" data-pout aria-live="polite">${esc(note)}</p>${compose}`
          : ''
      }`;
    };
    const refresh = async (text) => {
      await loadCatalog();
      await loadVersions();
      note = text || '';
      draw();
    };
    pane.addEventListener('click', async (e) => {
      const tab = e.target.closest('[data-pcat]');
      if (tab) {
        e.preventDefault();
        catId = tab.dataset.pcat;
        key = '';
        diffHtml = '';
        composeHtml = '';
        await refresh('');
        return undefined;
      }
      const pick = e.target.closest('[data-pitem]');
      if (pick) {
        key = pick.dataset.pitem;
        diffHtml = '';
        composeHtml = '';
        await refresh('');
        return undefined;
      }
      const show = e.target.closest('[data-pcompose]');
      if (show) {
        const roleSel = q('[data-prole]', pane);
        const params = new URLSearchParams({ task: key });
        if (roleSel && roleSel.value) params.set('role', roleSel.value);
        const toolsBox = q('[data-ptools]', pane);
        if (toolsBox && toolsBox.checked) params.set('tools', '1');
        const d = await get(`/api/v1/admin/ai/prompts/compose?${params.toString()}`);
        composeHtml = d
          ? `<p class="sub">${esc((d.layers || []).map((l) => `${l.key} v${l.version}`).join(' → '))}</p><pre class="prompt-diff">${esc(d.system)}</pre>`
          : `<p class="muted">${esc(tx('msg.admin.prompt.error', 'Не получилось: обновите страницу и повторите.'))}</p>`;
        q('[data-pcompose-out]', pane).innerHTML = composeHtml;
        return undefined;
      }
      const open = e.target.closest('[data-pload]');
      if (open) {
        const v = list.find((x) => x.version === Number(open.dataset.pload));
        if (v) q('[data-ptext]', pane).value = v.text;
        return undefined;
      }
      const cmp = e.target.closest('[data-pdiff]');
      if (cmp) {
        const active = list.find((v) => v.active);
        const d = await get(url(`/diff?from=${active.version}&to=${cmp.dataset.pdiff}`));
        diffHtml = d
          ? `<div class="card soft" data-pdiff-view><b>v${d.from} → v${d.to}</b><pre class="prompt-diff">${diffRows(
              d.lines,
            )
              .map((l) =>
                l.gap
                  ? '<span class="prompt-diff__gap">…</span>'
                  : `<span class="prompt-diff__${l.op}">${l.op === 'add' ? '+ ' : l.op === 'del' ? '− ' : '  '}${esc(l.text)}</span>`,
              )
              .join('')}</pre></div>`
          : '';
        q('[data-pdiff-out]', pane).innerHTML = diffHtml;
        return undefined;
      }
      const act = e.target.closest('[data-pact]');
      if (act) {
        const r = await post(url(`/versions/${Number(act.dataset.pact)}/activate`), {});
        diffHtml = '';
        return refresh(
          r.ok
            ? tx('msg.admin.prompt.activated', 'Версия включена. Новые ответы ИИ используют её сразу.')
            : tx('msg.admin.prompt.error', 'Не получилось: обновите страницу и повторите.'),
        );
      }
      if (e.target.closest('[data-psave]')) {
        const text = q('[data-ptext]', pane).value;
        const comment = q('[data-pcomment]', pane).value;
        const r = await post(url('/versions'), { text, comment });
        if (r.ok)
          return refresh(
            tx('msg.admin.prompt.saved', 'Сохранено как черновик. Чтобы текст начал действовать, включите версию.'),
          );
        q('[data-pout]', pane).textContent =
          r.status === 409
            ? tx('msg.admin.prompt.same', 'Такой текст уже есть среди версий.')
            : tx('msg.admin.prompt.invalid', 'Текст пустой или длиннее 20 000 знаков.');
      }
      return undefined;
    });
    refresh('');
  }

  async function settings(root) {
    const sub = root.dataset.s || 'work';
    let group = GROUPS.some(([g]) => g === sub) ? sub : 'work';
    let all = [];
    const load = async () => {
      const data = await get('/api/v1/admin/settings');
      all = (data && data.items) || [];
    };
    await load();
    const saved = (html) => {
      const out = q('[data-out]', root);
      if (out) out.innerHTML = html;
    };
    const undoSaved = (key, prevVersion) => {
      saved(
        '<span data-testid="msg.undo.admin.saved">Сохранено · </span><button type="button" class="link" data-testid="msg.undo.action" data-rollback>Отменить</button>',
      );
      q('[data-rollback]', root).addEventListener('click', async () => {
        await post(`/api/v1/admin/settings/${encodeURIComponent(key)}/rollback`, { to_version: prevVersion });
        await load();
        draw();
        saved('<span data-testid="msg.undo.done">Отменено</span>');
      });
    };
    const editBtn = (attr) =>
      `<button type="button" class="btn sm" data-testid="msg.admin.settings.edit" ${attr}>${esc(tx('msg.admin.settings.edit', 'Изменить'))}</button>`;
    const contactsRow = () => {
      const cur = all.find((x) => x.key === 'crisis.contacts');
      const list = cur && Array.isArray(cur.value) ? cur.value : [];
      return list.length
        ? `<tr data-key="crisis.contacts"><td>${esc(titleOf('crisis.contacts'))}<small>${esc(tx('msg.admin.settings.contacts_note', 'Эти номера пациент видит в «Справке» и на экране помощи.'))}</small></td><td class="val">${esc(list.map((c) => `${c.title}: ${c.phone}`).join(' · '))}</td><td class="act">${editBtn('data-contacts')}</td></tr>`
        : '';
    };
    const draw = () => {
      const rows = all.filter(
        (s) =>
          s.key !== 'crisis.contacts' && (group === 'work' ? ['work', 'service'].includes(s.group) : s.group === group),
      );
      const head = `<thead><tr><th>${esc(tx('msg.admin.settings.col_what', 'Что настраивается'))}</th><th>${esc(tx('msg.admin.settings.col_now', 'Сейчас'))}</th><th><span class="sr">${esc(tx('msg.admin.settings.col_act', 'Действие'))}</span></th></tr></thead>`;
      const table = `<div class="tbl-wrap" data-set-list><table class="tbl tbl--dense">${head}<tbody>${
        (group === 'work' ? contactsRow() : '') +
        rows
          .map(
            (s) =>
              `<tr data-key="${esc(s.key)}"><td>${esc(titleOf(s.key))}${s.review_required ? `<small>${esc(tx('msg.admin.settings.review', 'Нужна проверка'))}</small>` : ''}</td><td class="val">${esc(summary(s.value, s.key))}</td><td class="act">${editBtn(`data-edit="${esc(s.key)}"`)}</td></tr>`,
          )
          .join('')
      }</tbody></table></div>`;
      const hasRows = rows.length || (group === 'work' && contactsRow());
      root.innerHTML = `<div class="adm-bar set-head"><div class="filters set-tabs">${GROUPS.map(([g, key, fb]) => `<a class="pill${g === group ? ' on' : ''}" href="/admin?tab=settings&s=${g}" data-g="${g}" data-testid="msg.admin.settings.tab.${g}"${g === group ? ' aria-current="page"' : ''}>${esc(tx(key, fb))}</a>`).join('')}</div><button type="button" class="btn" data-testid="msg.admin.settings.history" data-hist>${esc(tx('msg.admin.settings.history', 'История'))}</button></div><div class="adm-stack">${
        group === 'clinic'
          ? `<p class="callout soft" data-testid="msg.admin.settings.clinic_banner">${esc(tx('msg.admin.settings.clinic_banner', 'Клинические значения: нужна отметка клинического ответственного'))}</p>`
          : ''
      }${group === 'ai' ? `<section class="card ai-note"><div class="adm-card-h"><h2>Назначения моделей</h2>${soon()}</div><div class="tbl-wrap"><table class="tbl tbl--dense"><thead><tr><th>${esc(tx('msg.admin.settings.col_what', 'Что настраивается'))}</th><th>${esc(tx('msg.admin.settings.col_now', 'Сейчас'))}</th></tr></thead><tbody>${['Помощник пациента', 'Чат специалиста', 'Черновики документов', 'Гипотезы с источниками', 'Извлечение признаков НЯ', 'Разбор назначения', 'Ассистент администратора'].map((n) => `<tr data-purpose><td>${esc(n)}</td><td>${esc(tx('msg.admin.settings.models_hint', 'Основная и запасная модель настраиваются в разделе моделей'))}</td></tr>`).join('')}</tbody></table></div><p class="adm-note" data-testid="msg.ai.mark.external_demo">Внешняя модель — только синтетика</p></section>` : ''}${group === 'pii' ? `<section class="card"><div class="adm-card-h"><h2>Правила псевдонимизации</h2>${soon()}</div><p class="sub">Тест правил на синтетическом тексте и статистика — после подключения серверной части.</p></section>` : ''}${
        group === 'prompt'
          ? ''
          : hasRows
            ? `<section class="card adm-table-card">${table}</section>`
            : `<div class="empty">${icon('gear-six', 'i--32')}<h3>${esc(tx('msg.admin.settings.none', 'В этой группе пока нет настроек'))}</h3></div>`
      }<div class="acts set-acts"><a class="btn" href="/api/v1/admin/settings-export">${icon('download-simple')}${esc(tx('msg.admin.settings.download', 'Скачать настройки'))}</a><button type="button" class="btn" disabled>${esc(tx('msg.admin.settings.upload', 'Загрузить настройки'))}</button> ${soon()}</div></div><p class="sub adm-out" data-out aria-live="polite"></p>`;
      if (group === 'prompt') promptPane(root);
    };
    draw();
    root.addEventListener('click', async (e) => {
      const g = e.target.closest('[data-g]');
      if (g) {
        e.preventDefault();
        group = g.dataset.g;
        history.replaceState(null, '', `/admin?tab=settings&s=${group}`);
        return draw();
      }
      if (e.target.closest('[data-contacts]')) {
        const cur = all.find((x) => x.key === 'crisis.contacts');
        dialog(
          `<h3>Кризисные контакты</h3><p class="sub">Первым остаётся номер экстренных служб. Остальные — телефоны клиники и доверия.</p><form class="form" data-cform>${cur.value
            .map(
              (c, i) =>
                `<div class="row-fields contact-row"><label>Название<input name="title" type="text" required maxlength="80" value="${esc(c.title)}"></label><label>Телефон<input name="phone" type="text" required maxlength="40" value="${esc(c.phone)}"></label></div>`,
            )
            .join(
              '',
            )}<p class="sub" data-d-out aria-live="polite"></p><div class="acts"><button type="button" class="btn ghost" data-x>Отмена</button><button type="submit" class="btn primary" data-testid="msg.admin.settings.save">${esc(tx('msg.admin.settings.save', 'Сохранить'))}</button></div></form>`,
          (bg, close) =>
            q('[data-cform]', bg).addEventListener('submit', async (ev) => {
              ev.preventDefault();
              const titles = qa('[name="title"]', bg);
              const phones = qa('[name="phone"]', bg);
              const value = titles.map((t, k) => ({ title: t.value.trim(), phone: phones[k].value.trim() }));
              const r = await send('/api/v1/admin/settings/crisis.contacts', 'PUT', {
                value,
                base_version: cur.version,
                comment: 'правка контактов',
              });
              if (!r.ok)
                return (q('[data-d-out]', bg).textContent =
                  r.status === 409
                    ? 'Значение уже изменили — обновите страницу.'
                    : 'Не получилось сохранить: проверьте номера.');
              const prev = cur.version;
              close();
              await load();
              draw();
              undoSaved('crisis.contacts', prev);
            }),
        );
        return;
      }
      const edit = e.target.closest('[data-edit]');
      if (edit) {
        const key = edit.dataset.edit;
        const cur = all.find((x) => x.key === key);
        dialog(
          `<h3>${esc(titleOf(key))}</h3><p class="sub">Значение в формате JSON. Версия ${cur.version}.</p><label class="arch-sum">Значение<textarea data-val rows="8">${esc(JSON.stringify(cur.value, null, 2))}</textarea></label><label class="arch-sum">${esc(tx('msg.admin.settings.comment', 'Комментарий'))}<input type="text" data-comment></label><p class="sub" data-d-out aria-live="polite"></p><div class="acts"><button type="button" class="btn ghost" data-x>Отмена</button><button type="button" class="btn primary" data-go>${esc(tx('msg.admin.settings.save', 'Сохранить'))}</button></div>`,
          (bg, close) =>
            bg.addEventListener('click', async (ev) => {
              if (!ev.target.closest('[data-go]')) return;
              let value;
              try {
                value = JSON.parse(q('[data-val]', bg).value);
              } catch (_) {
                return (q('[data-d-out]', bg).textContent = 'Значение должно быть корректным JSON.');
              }
              const r = await send(`/api/v1/admin/settings/${encodeURIComponent(key)}`, 'PUT', {
                value,
                base_version: cur.version,
                comment: q('[data-comment]', bg).value,
              });
              if (!r.ok)
                return (q('[data-d-out]', bg).textContent =
                  r.status === 409 ? 'Значение уже изменили — обновите страницу.' : 'Не получилось сохранить.');
              const prev = cur.version;
              close();
              await load();
              draw();
              undoSaved(key, prev);
            }),
        );
        return;
      }
      if (e.target.closest('[data-hist]')) {
        const keys = all.map((x) => x.key);
        const details = await Promise.all(keys.map((k) => get(`/api/v1/admin/settings/${encodeURIComponent(k)}`)));
        const rows = [];
        details.forEach((d) => {
          if (!d || !d.history || d.history.length < 2) return;
          d.history.forEach((h) => rows.push({ key: d.key, ...h }));
        });
        rows.sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)) || y.version - x.version);
        dialog(
          `<h3>${esc(tx('msg.admin.settings.history', 'История'))} изменений</h3><div class="list">${
            rows.length
              ? rows
                  .map(
                    (h) =>
                      `<div class="li"><div class="grow"><b>${esc(titleOf(h.key))} · версия ${h.version}</b><small>${esc(tx(`msg.admin.settings.status.${h.status === 'previous' ? 'old' : h.status}`, h.status))} · ${esc(summary(h.value, h.key))} · ${esc(when(h.created_at))}${h.comment ? ' · ' + esc(h.comment) : ''}</small></div><button type="button" class="btn" data-testid="msg.admin.settings.revert" data-rkey="${esc(h.key)}" data-rev="${h.version}" ${h.status === 'active' ? 'disabled' : ''}>${esc(tx('msg.admin.settings.revert', 'Вернуть эту версию'))}</button></div>`,
                  )
                  .join('')
              : '<p class="muted pad">Изменений пока не было.</p>'
          }</div><p class="sub" data-d-out></p>`,
          (bg, close) =>
            bg.addEventListener('click', async (ev) => {
              const rv = ev.target.closest('[data-rev]');
              if (!rv || rv.disabled) return;
              const before = (all.find((x) => x.key === rv.dataset.rkey) || {}).version;
              const r = await post(`/api/v1/admin/settings/${encodeURIComponent(rv.dataset.rkey)}/rollback`, {
                to_version: Number(rv.dataset.rev),
              });
              if (!r.ok) return (q('[data-d-out]', bg).textContent = 'Не получилось вернуть.');
              close();
              await load();
              draw();
              undoSaved(rv.dataset.rkey, before);
            }),
        );
      }
    });
  }

  // ---------- Журнал ----------
  const LOG_TABS = [
    ['access', 'msg.admin.log.tab.access', 'Доступ к данным'],
    ['actions', 'msg.admin.log.tab.actions', 'Действия и безопасность'],
    ['ai', 'msg.admin.log.tab.ai', 'ИИ'],
    ['exports', 'msg.admin.log.tab.exports', 'Выгрузки'],
    ['consents', 'msg.admin.log.tab.consents', 'Согласия'],
    ['requests', 'msg.admin.log.tab.requests', 'Запросы'],
    ['crisis', 'msg.admin.log.tab.crisis', 'Кризисные события'],
    ['agent', 'msg.admin.log.tab.agent', 'Шаги ИИ-агента'],
  ];
  // дата для людей: дд.мм.гггг; в запрос уходит ISO
  const isoFromRu = (v) => {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(v).trim());
    if (!m) return '';
    const iso = `${m[3]}-${m[2]}-${m[1]}`;
    const d = new Date(`${iso}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : '';
  };
  const ruFromIso = (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
  };
  async function logs(root) {
    let journal = 'access';
    let page = 1;
    let dateErr = false;
    const filters = { action: '', patient_no: '', from: '', to: '' };
    let openRun = null;
    const tabsHtml = () =>
      `<div class="adm-bar"><div class="filters log-tabs">${LOG_TABS.map(([k, key, fb]) => `<button type="button" class="pill${k === journal ? ' on' : ''}" data-j="${k}" data-testid="msg.admin.log.tab.${k}"${k === journal ? ' aria-current="true"' : ''}>${esc(tx(key, fb))}</button>`).join('')}</div></div>`;
    // Шаги ИИ-агента (src/modules/admin/agent/routes.js): вызовы модели, инструментов и навыков одного ответа.
    const AGENT_KIND = { model: 'Модель', tool: 'Инструмент', skill: 'Навык', note: 'Заметка' };
    const runDetail = (r) => {
      const step = (s) =>
        `<tr><td class="nowrap">${s.n}</td><td class="nowrap">${esc(AGENT_KIND[s.kind] || s.kind)}</td><td>${esc(s.name || s.model_ident || '—')}${s.args ? `<small>${esc(JSON.stringify(s.args))}</small>` : ''}${s.reason_text ? `<small>${esc(s.reason_text)}</small>` : ''}${s.result_text ? `<pre class="ws-prev-pre">${esc(s.result_text)}</pre>` : s.result_chars !== null ? `<small>${esc(tx('msg.admin.agent.chars', 'символов: {n}', { n: s.result_chars }))}</small>` : ''}</td><td class="nowrap">${s.tokens_in ?? '—'} / ${s.tokens_out ?? '—'}${s.context_tokens ? `<small>${esc(tx('msg.admin.agent.context', 'контекст {n}', { n: s.context_tokens }))}</small>` : ''}</td><td class="nowrap">${s.duration_ms ?? '—'}</td><td class="nowrap">${esc(s.status)}</td></tr>`;
      const layers = (r.prompt_layers || []).map((l) => `${l.key || l.layer || ''}${l.version ? ` v${l.version}` : ''}`).join(', ');
      return `<section class="card adm-table-card" data-testid="msg.admin.agent.detail"><div class="adm-card-h"><h2>${esc(tx('msg.admin.agent.run', 'Ответ № {n}', { n: r.id }))}</h2><a class="btn" href="/admin/api/agent/runs/${r.id}/download" download data-testid="msg.admin.agent.download_one">${icon('download-simple')}${esc(tx('msg.admin.agent.download_one', 'Скачать JSON'))}</a><button type="button" class="btn ghost" data-run-close>${esc(tx('msg.admin.agent.close', 'Закрыть'))}</button></div>
        <p class="adm-note">${esc(r.prompt_key)} · ${esc(r.model_ident || '—')} · ${esc(r.stop_reason || '—')}${layers ? ` · ${esc(layers)}` : ''}</p>
        ${r.question_text ? `<h3>${esc(tx('msg.admin.agent.question', 'Вопрос'))}</h3><pre class="ws-prev-pre">${esc(r.question_text)}</pre>` : ''}
        <div class="tbl-wrap"><table class="tbl tbl--dense"><thead><tr><th>№</th><th>${esc(tx('msg.admin.agent.c_kind', 'Шаг'))}</th><th>${esc(tx('msg.admin.agent.c_what', 'Что и с чем'))}</th><th>${esc(tx('msg.admin.agent.c_tokens', 'Токены вход / выход'))}</th><th>${esc(tx('msg.admin.agent.c_ms', 'мс'))}</th><th>${esc(tx('msg.admin.log.c_result', 'Итог'))}</th></tr></thead><tbody>${(r.steps_list || []).map(step).join('')}</tbody></table></div>
        ${r.answer_text ? `<h3>${esc(tx('msg.admin.agent.answer', 'Ответ'))}</h3><pre class="ws-prev-pre">${esc(r.answer_text)}</pre>` : ''}
        ${r.texts_stored ? '' : `<p class="adm-note">${esc(tx('msg.admin.agent.no_texts', 'Тексты не хранятся: боевой режим. Видны только шаги, имена и числа.'))}</p>`}</section>`;
    };
    const drawAgent = async () => {
      const qs = new URLSearchParams({ page: String(page) });
      if (filters.from) qs.set('from', filters.from);
      if (filters.to) qs.set('to', filters.to);
      const data = await get(`/admin/api/agent/runs?${qs}`);
      const rows = (data && data.items) || [];
      const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
      const detail = openRun ? await get(`/admin/api/agent/runs/${openRun}`) : null;
      const hint = esc(tx('msg.admin.log.date_hint', 'дд.мм.гггг'));
      const row = (r) =>
        `<tr><td class="nowrap">${esc(fmtDate(r.created_at))}</td><td>${esc(r.user_name || '—')}<small>${esc(r.prompt_key)}</small></td><td class="nowrap">${esc(r.patient_no || '—')}</td><td class="nowrap">${r.steps} / ${r.tool_calls}</td><td class="nowrap">${r.tokens_in} / ${r.tokens_out}</td><td class="nowrap">${r.duration_ms ?? '—'}</td><td class="nowrap">${esc(r.status)}</td><td class="act"><button type="button" class="btn ghost sm" data-run="${r.id}">${esc(tx('msg.admin.agent.open', 'Шаги'))}</button></td></tr>`;
      root.innerHTML = `${tabsHtml()}
        <section class="card adm-table-card"><div class="adm-card-h"><h2>${esc(tx('msg.admin.agent.title', 'Ответы агента'))}</h2><a class="btn" data-testid="msg.admin.agent.download" href="/admin/api/agent/download?${qs}" download>${icon('download-simple')}${esc(tx('msg.admin.agent.download', 'Скачать JSON за период'))}</a></div>
        <form class="adm-filters" data-lf novalidate><div class="field${dateErr ? ' is-err' : ''}"><label for="lf-from">${esc(tx('msg.admin.log.f_from', 'С даты'))}</label><input id="lf-from" type="text" inputmode="numeric" name="from" placeholder="${hint}" autocomplete="off" value="${esc(ruFromIso(filters.from))}"></div><div class="field${dateErr ? ' is-err' : ''}"><label for="lf-to">${esc(tx('msg.admin.log.f_to', 'По дату'))}</label><input id="lf-to" type="text" inputmode="numeric" name="to" placeholder="${hint}" autocomplete="off" value="${esc(ruFromIso(filters.to))}"></div><button type="submit" class="btn">${esc(tx('msg.admin.log.find', 'Найти'))}</button></form>
        ${dateErr ? `<p class="form-error" role="alert">${icon('warning-circle')}${esc(tx('msg.admin.log.date_err', 'Дата — в формате дд.мм.гггг, например 22.10.2026'))}</p>` : ''}
        ${rows.length ? `<div class="tbl-wrap" tabindex="0" role="region" aria-label="${esc(tx('msg.admin.agent.title', 'Ответы агента'))}"><table class="tbl tbl--dense"><thead><tr><th>${esc(tx('msg.admin.log.c_when', 'Когда'))}</th><th>${esc(tx('msg.admin.log.c_who', 'Кто'))}</th><th>${esc(tx('msg.admin.log.c_whom', 'Над кем'))}</th><th>${esc(tx('msg.admin.agent.c_steps', 'Шагов / вызовов'))}</th><th>${esc(tx('msg.admin.agent.c_tokens', 'Токены вход / выход'))}</th><th>${esc(tx('msg.admin.agent.c_ms', 'мс'))}</th><th>${esc(tx('msg.admin.log.c_result', 'Итог'))}</th><th><span class="sr">${esc(tx('msg.admin.agent.open', 'Шаги'))}</span></th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>` : `<div class="empty">${icon('shield-check', 'i--32')}<h3>${esc(tx('msg.admin.log.none', 'Записей по этим условиям нет'))}</h3></div>`}
        <div class="adm-pager"><button type="button" class="btn ghost" data-pg="-1" aria-label="${esc(tx('msg.admin.log.prev', 'Назад'))}" ${page <= 1 ? 'disabled' : ''}>${icon('arrow-left')}</button><span class="adm-note">${esc(tx('msg.admin.log.page', 'Страница {p} из {n}', { p: page, n: pages }))}${data ? ` · ${esc(tx('msg.admin.log.total', 'записей: {n}', { n: data.total }))}` : ''}</span><button type="button" class="btn ghost" data-pg="1" aria-label="${esc(tx('msg.admin.log.next', 'Вперёд'))}" ${page >= pages ? 'disabled' : ''}>${icon('caret-right')}</button></div></section>
        ${detail ? runDetail(detail) : ''}
        <p class="adm-note">${esc(tx('msg.admin.agent.note', 'Тексты хранятся только в демо-режиме, с метками вместо персональных данных, 30 дней.'))}</p>`;
    };
    const draw = async () => {
      if (journal === 'agent') return drawAgent();
      const qs = new URLSearchParams({ page: String(page) });
      for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
      const data = await get(`/api/v1/admin/logs/${journal}?${qs}`);
      const rows = (data && data.items) || [];
      const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
      const rowHtml = (r) => {
        const obj = objectText(r.object);
        const what = lbl('act', r.action);
        return `<tr><td class="nowrap">${esc(fmtDate(r.at))}</td><td>${esc(r.actor || '—')}</td><td>${esc(what)}${obj ? `<small>${esc(obj)}</small>` : ''}</td><td class="nowrap">${esc(r.patient_no || '—')}</td><td class="nowrap">${decisionPill(r.decision)}</td></tr>`;
      };
      const hint = esc(tx('msg.admin.log.date_hint', 'дд.мм.гггг'));
      root.innerHTML = `${tabsHtml()}
        <section class="card adm-table-card"><div class="adm-card-h"><h2>${esc(tx('msg.admin.log.title', 'Записи'))}</h2><a class="btn" data-testid="msg.admin.log.csv" href="#" data-csv>${icon('download-simple')}${esc(tx('msg.admin.log.csv', 'Скачать CSV'))}</a></div>
        <form class="adm-filters" data-lf novalidate><div class="field"><label for="lf-action">${esc(tx('msg.admin.log.f_action', 'Действие'))}</label><input id="lf-action" type="search" name="action" value="${esc(filters.action)}"></div><div class="field"><label for="lf-patient">${esc(tx('msg.admin.log.f_patient', 'Пациент №'))}</label><input id="lf-patient" type="search" name="patient_no" data-testid="msg.admin.log.filter.patient" value="${esc(filters.patient_no)}"></div><div class="field${dateErr ? ' is-err' : ''}"><label for="lf-from">${esc(tx('msg.admin.log.f_from', 'С даты'))}</label><input id="lf-from" type="text" inputmode="numeric" name="from" placeholder="${hint}" autocomplete="off" value="${esc(ruFromIso(filters.from))}"></div><div class="field${dateErr ? ' is-err' : ''}"><label for="lf-to">${esc(tx('msg.admin.log.f_to', 'По дату'))}</label><input id="lf-to" type="text" inputmode="numeric" name="to" placeholder="${hint}" autocomplete="off" value="${esc(ruFromIso(filters.to))}"></div><button type="submit" class="btn">${esc(tx('msg.admin.log.find', 'Найти'))}</button></form>
        ${dateErr ? `<p class="form-error" role="alert">${icon('warning-circle')}${esc(tx('msg.admin.log.date_err', 'Дата — в формате дд.мм.гггг, например 22.10.2026'))}</p>` : ''}
        ${rows.length ? `<div class="tbl-wrap" tabindex="0" role="region" aria-label="${esc(tx('msg.admin.log.region', 'Записи аудита'))}"><table class="tbl tbl--dense"><thead><tr><th>${esc(tx('msg.admin.log.c_when', 'Когда'))}</th><th>${esc(tx('msg.admin.log.c_who', 'Кто'))}</th><th>${esc(tx('msg.admin.log.c_what', 'Действие'))}</th><th>${esc(tx('msg.admin.log.c_whom', 'Над кем'))}</th><th>${esc(tx('msg.admin.log.c_result', 'Итог'))}</th></tr></thead><tbody>${rows.map(rowHtml).join('')}</tbody></table></div>` : `<div class="empty">${icon('shield-check', 'i--32')}<h3>${esc(tx('msg.admin.log.none', 'Записей по этим условиям нет'))}</h3><p>${esc(tx('msg.admin.log.none_hint', 'Измените даты или уберите часть условий'))}</p></div>`}
        <div class="adm-pager"><button type="button" class="btn ghost" data-pg="-1" aria-label="${esc(tx('msg.admin.log.prev', 'Назад'))}" ${page <= 1 ? 'disabled' : ''}>${icon('arrow-left')}</button><span class="adm-note">${esc(tx('msg.admin.log.page', 'Страница {p} из {n}', { p: page, n: pages }))}${data ? ` · ${esc(tx('msg.admin.log.total', 'записей: {n}', { n: data.total }))}` : ''}</span><button type="button" class="btn ghost" data-pg="1" aria-label="${esc(tx('msg.admin.log.next', 'Вперёд'))}" ${page >= pages ? 'disabled' : ''}>${icon('caret-right')}</button></div></section>
        <p class="adm-note">${esc(tx('msg.admin.log.readonly', 'Записи только для чтения. Без клинических текстов; пациенты — номерами.'))}</p>`;
    };
    await draw();
    root.addEventListener('click', (e) => {
      const j = e.target.closest('[data-j]');
      if (j) {
        journal = j.dataset.j;
        page = 1;
        openRun = null;
        return draw();
      }
      const run = e.target.closest('[data-run]');
      if (run) {
        openRun = Number(run.dataset.run);
        return draw();
      }
      if (e.target.closest('[data-run-close]')) {
        openRun = null;
        return draw();
      }
      const pg = e.target.closest('[data-pg]');
      if (pg) {
        page = Math.max(1, page + Number(pg.dataset.pg));
        return draw();
      }
      if (e.target.closest('[data-csv]')) {
        e.preventDefault();
        const rows = qa('table.tbl tr', root).map((tr) =>
          qa('th,td', tr)
            .map((c) => `"${c.textContent.replace(/"/g, '""')}"`)
            .join(';'),
        );
        const blob = new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `journal_${journal}.csv`;
        a.click();
      }
    });
    root.addEventListener('submit', (e) => {
      if (!e.target.matches('[data-lf]')) return;
      e.preventDefault();
      const text = (k) => e.target[k].value.trim();
      if (e.target.elements.namedItem('action')) filters.action = text('action');
      if (e.target.elements.namedItem('patient_no')) filters.patient_no = text('patient_no');
      dateErr = false;
      for (const k of ['from', 'to']) {
        const raw = text(k);
        filters[k] = raw ? isoFromRu(raw) : '';
        if (raw && !filters[k]) dateErr = true;
      }
      page = 1;
      if (dateErr) {
        filters.from = '';
        filters.to = '';
      }
      draw();
    });
  }

  // ---------- Ещё: контент, программа, сервис ----------
  function moreHub(root) {
    const items = [
      [
        '/admin?tab=content',
        'msg.nav.admin.more.content',
        'Контент',
        'Библиотека, справочник препаратов, документы сервиса',
      ],
      [
        '/admin?tab=analytics',
        'msg.nav.admin.more.analytics',
        'Аналитика',
        'Рассказ по диагнозу: пациенты, специалисты, назначения, исходы',
      ],
      ['/admin?tab=program', 'msg.nav.admin.more.program', 'Аналитика сервиса', 'Общие цифры по всем и обезличенные агрегаты по согласившимся'],
      ['/admin?tab=service', 'msg.nav.admin.more.service', 'Сервис', 'Состояние: версия, база, почта, ИИ, задачи'],
    ];
    root.innerHTML = `<section class="more-grid">${items.map(([href, key, fb, hint]) => `<a class="more-item" href="${href}"><b>${esc(tx(key, fb))}</b><span class="muted">${esc(hint)}</span></a>`).join('')}</section>`;
  }

  async function content(root) {
    const [lib, review, journal] = await Promise.all([
      get('/api/v1/admin/library'),
      get('/api/v1/admin/drug-review'),
      get('/admin/api/journal'),
    ]);
    const items = ((lib && lib.items) || []).filter((i) => i.kind !== 'article'); // статьи — в разделе «Журнал»
    const posts = (journal && journal.items) || [];
    const pending = (review && (review.items || review.entries)) || [];
    const STATUS = { published: 'Опубликовано', draft: 'Черновик', withdrawn: 'Снято' };
    const AUD = { patient: 'для пациентов', specialist: 'для специалистов' };
    const stPill = (code) => {
      const tone = code === 'published' ? 'ok' : 'warn';
      return `<span class="st-pill ${tone}">${icon(tone === 'ok' ? 'check-circle' : 'clock')}${esc(STATUS[code] || lbl('cstatus', code))}</span>`;
    };
    const SM = (attrs, text, cls = 'ghost') =>
      `<button type="button" class="btn ${cls} sm" ${attrs}>${esc(text)}</button>`;
    const empty = (ic, text) => `<div class="empty">${icon(ic, 'i--32')}<h3>${esc(text)}</h3></div>`;
    const table = (cols, body) =>
      `<div class="tbl-wrap"><table class="tbl tbl--dense"><thead><tr>${cols.map((c) => `<th>${c ? esc(c) : `<span class="sr">${esc(tx('msg.admin.settings.col_act', 'Действие'))}</span>`}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
    const POST_SHOWN = 15;
    const postRow = (p, i) =>
      `<tr data-post="${p.id}"${i >= POST_SHOWN ? ' hidden data-post-extra' : ''}><td>${esc(p.title)}</td><td class="nowrap">${esc(AUD[p.audience] || lbl('aud', p.audience))}</td><td>${stPill(p.status)}</td><td class="nowrap">${esc(p.author || '—')}</td><td class="act">${SM(`data-post-edit="${p.id}"`, 'Править')}${p.status === 'published' ? SM(`data-post-off="${p.id}"`, 'Снять') : SM(`data-post-on="${p.id}"`, 'Опубликовать')}${SM(`data-post-del="${p.id}"`, 'Удалить', 'ghost adm-del')}</td></tr>`;
    const head2 = (h, extra = '') => `<div class="adm-card-h"><h2>${esc(h)}</h2>${extra}</div>`;
    root.innerHTML = `<div class="adm-stack"><section class="card adm-table-card">${head2('Журнал')}<div data-journal>${
      posts.length
        ? table(['Название', 'Для кого', 'Состояние', 'Автор', ''], posts.map(postRow).join('')) +
          (posts.length > POST_SHOWN
            ? `<div class="adm-pager"><button type="button" class="btn" data-posts-more>${esc(tx('msg.admin.people.more', 'Показать ещё'))}</button><span class="adm-note">${esc(tx('msg.admin.people.shown', 'Показано {a} из {b}', { a: POST_SHOWN, b: posts.length }))}</span></div>`
            : '')
        : empty('newspaper', 'Статей пока нет')
    }</div></section><section class="card adm-table-card">${head2('Аудио и видео', `<span class="adm-note">${soon()}</span>`)}${
      items.length
        ? table(
            ['Название', 'Состояние', 'Автор', ''],
            items
              .map(
                (i) =>
                  `<tr data-item="${i.id}"><td>${esc(i.title)}<small>версия ${i.current_version}</small></td><td>${stPill(i.status)}</td><td class="nowrap">${esc(i.author || '—')}</td><td class="act">${i.status === 'published' ? SM(`data-withdraw="${i.id}"`, 'Снять') : SM(`data-publish="${i.id}"`, 'Опубликовать', '')}</td></tr>`,
              )
              .join(''),
          )
        : empty('play', 'Материалов пока нет')
    }<div class="acts"><button type="button" class="btn" disabled>${icon('plus')}Материал</button></div></section><section class="card adm-table-card">${head2('Проверка препаратов')}<div data-drug>${
      pending.length
        ? table(
            ['Название', 'Источник', 'Состояние'],
            pending
              .map(
                (d) =>
                  `<tr><td>${esc(d.trade_name || d.name || 'Название')}</td><td>введено пациентом</td><td><span class="st-pill warn">${icon('clock')}Ждёт проверки</span></td></tr>`,
              )
              .join(''),
          )
        : review
          ? empty('check-circle', 'Названий на проверке нет')
          : `<div class="empty">${icon('lock', 'i--32')}<h3>Проверка названий недоступна</h3><p>Она открыта администратору с отметкой «ответственный за справочник». Отметку выдаёт первый администратор в разделе «Люди».</p></div>`
    }</div></section><section class="card adm-table-card">${head2('Справочники и тексты')}${table(
      ['Что', 'Что можно сделать', ''],
      [
        ['Справочник МНН и препаратов', 'Загрузить CSV, посмотреть различия, применить'],
        ['Аптеки', 'Список и порядок показа'],
        ['Тексты согласий и документов сервиса', 'Версии и публикация'],
        ['Опросники и пакеты', 'Версии шкал и проверка подсчёта'],
        ['Анкета перед приёмом', 'Вопросы по умолчанию'],
      ]
        .map(([t, d]) => `<tr><td>${esc(t)}</td><td>${esc(d)}</td><td class="act">${soon()}</td></tr>`)
        .join(''),
    )}</section></div><p class="sub adm-out" data-out aria-live="polite"></p>`;
    root.addEventListener('click', async (e) => {
      if (e.target.closest('[data-posts-more]')) {
        qa('[data-post-extra]', root).forEach((tr) => (tr.hidden = false));
        e.target.closest('.adm-pager').remove();
        return;
      }
      const edit = e.target.closest('[data-post-edit]');
      const on = e.target.closest('[data-post-on]');
      const off = e.target.closest('[data-post-off]');
      const del = e.target.closest('[data-post-del]');
      if (edit) {
        const id = edit.dataset.postEdit;
        const p = await get(`/admin/api/journal/${id}`);
        if (!p) return;
        dialog(
          `<h2>Статья журнала</h2><div class="form"><label>Заголовок<input data-f="title" maxlength="200" value="${esc(p.title)}"></label><label>Кратко<input data-f="summary" maxlength="400" value="${esc(p.summary)}"></label><label>Теги через запятую<input data-f="tags" value="${esc(p.tags.join(', '))}"></label><label>Журнал<select data-f="audience"><option value="patient"${p.audience === 'patient' ? ' selected' : ''}>для пациентов</option><option value="specialist"${p.audience === 'specialist' ? ' selected' : ''}>для специалистов</option></select></label><label>Текст<textarea data-f="body_md" rows="14" maxlength="100000">${esc(p.body_md)}</textarea></label><p class="form-error" data-err aria-live="polite"></p><div class="acts"><button type="button" class="btn primary" data-save>Сохранить</button><button type="button" class="btn" data-x>Отмена</button></div></div>`,
          (bg) => {
            q('[data-save]', bg).addEventListener('click', async () => {
              const v = (f) => q(`[data-f="${f}"]`, bg).value;
              const r = await send(`/admin/api/journal/${id}`, 'PUT', {
                title: v('title'),
                summary: v('summary'),
                tags: v('tags').split(','),
                audience: v('audience'),
                body_md: v('body_md'),
              });
              if (r.ok) location.reload();
              else q('[data-err]', bg).textContent = 'Не сохранилось: проверьте заголовок и текст.';
            });
          },
        );
        return;
      }
      if (on || off) {
        const id = (on || off).dataset[on ? 'postOn' : 'postOff'];
        const r = await post(`/admin/api/journal/${id}/${on ? 'publish' : 'unpublish'}`, {});
        if (r.ok) location.reload();
        else q('[data-out]', root).textContent = 'Не получилось выполнить.';
        return;
      }
      if (del) {
        // Удаление необратимо: первое нажатие просит подтвердить, второе удаляет.
        if (!del.dataset.sure) {
          del.dataset.sure = '1';
          del.textContent = 'Удалить насовсем?';
          return;
        }
        const r = await send(`/admin/api/journal/${del.dataset.postDel}`, 'DELETE');
        if (r.ok) location.reload();
        else q('[data-out]', root).textContent = 'Не получилось удалить.';
        return;
      }
      const pub = e.target.closest('[data-publish]');
      const wd = e.target.closest('[data-withdraw]');
      if (!pub && !wd) return;
      const id = (pub || wd).dataset[pub ? 'publish' : 'withdraw'];
      const r = await post(`/api/v1/admin/library/${id}/${pub ? 'publish' : 'withdraw'}`, {});
      if (r.ok) location.reload();
      else q('[data-out]', root).textContent = 'Не получилось выполнить.';
    });
  }

  async function program(root) {
    const report = await get('/api/v1/admin/metrics?by=diary');
    const svc = report.service;
    const svcLine = svc
      ? `<p class="sub">Всего пациентов: ${svc.patients === null ? 'скрыто (меньше порога)' : svc.patients}${svc.diary_writers === null ? '' : `; вели дневник за период: ${svc.diary_writers}`}. Эти служебные цифры считаются по всем, без согласия.</p>`
      : '';
    root.innerHTML = `<div class="adm-stack"><section class="card" data-testid="msg.admin.program.not_set"><h2>Отчёт для внешнего партнёра не настроен</h2><p class="sub">Отчёт по препаратам включится после настройки списка препаратов. Ниже — аналитика сервиса: служебные цифры по всем и обезличенные агрегаты по тем, кто согласился на обезличенную аналитику.</p>${svcLine}</section><section class="card"><h2>Дневник: согласившиеся на обезличенную аналитику</h2>${window.CCCohort ? window.CCCohort.html(report, { url: '/api/v1/analytics/export?section=diary', label: tx('msg.analytics.export.csv_diary', 'Скачать CSV'), testid: 'msg.analytics.export.csv_diary' }) : ''}</section></div>`;
  }

  // Аналитика рассказом для заказчика: общий отрисовщик public/js/insights.js, данные без идентификаторов.
  async function analytics(root) {
    if (!window.CCInsights) {
      root.innerHTML = '<p class="muted">Аналитика сейчас недоступна.</p>';
      return;
    }
    root.innerHTML = '<div id="ins-admin"></div>';
    await window.CCInsights.mount(q('#ins-admin', root), { url: '/api/v1/admin/insights', dx: 'F41.2' });
  }

  // Обзор рассказом: рисует public/js/admin_dashboard.js, данные — /api/v1/admin/dashboard.
  async function dashboard(root) {
    if (!window.CCDashboard) {
      root.innerHTML = '<p class="muted">Обзор сейчас недоступен.</p>';
      return;
    }
    await window.CCDashboard.mount(root);
  }

  async function service(root) {
    const s = await get('/api/v1/admin/service/status');
    if (!s) {
      root.innerHTML = `<div class="empty">${icon('warning-circle', 'i--32')}<h3>Состояние сейчас недоступно</h3><p>Обновите страницу чуть позже.</p></div>`;
      return;
    }
    const pill = (tone, text) =>
      `<span class="st-pill ${tone}">${icon(tone === 'ok' ? 'check-circle' : 'warning-circle')}${esc(text)}</span>`;
    const dbOk = /^ok/i.test(String(s.db));
    const size = /([\d.,]+)\s*МБ/.exec(String(s.db));
    const jobs = s.jobs || [];
    const fails = jobs.reduce((n, j) => n + (Number(j.failures) || 0), 0);
    const mlOff = /не настроен/.test(String(s.ml_worker));
    const mailOff = /не настроена/.test(String(s.mail));
    const aiDemo = !!(s.ai && s.ai.demo_replies);
    const aiOff = !!(s.ai && s.ai.enabled && s.ai.enabled.all === false);
    const tile = (num, cap, extra = '') =>
      `<div class="adm-tile"><span class="num">${esc(num)}</span><span class="cap">${esc(cap)}</span>${extra}</div>`;
    const tr = (what, state, detail) =>
      `<tr><td>${esc(what)}</td><td class="nowrap">${state}</td><td>${esc(detail)}</td></tr>`;
    root.innerHTML = `<div class="adm-stack"><div class="adm-tiles">${tile(s.version, 'Версия сервиса')}${tile(size ? size[1].replace('.', ',') + ' МБ' : '—', 'Размер базы данных')}${tile(String(jobs.length), 'Фоновых задач', `<span class="when">сбоев: ${fails}</span>`)}</div>
      <section class="card adm-table-card"><h2>Состояние</h2><div class="tbl-wrap"><table class="tbl tbl--dense"><thead><tr><th>Что проверяется</th><th>Состояние</th><th>Что это значит</th></tr></thead><tbody>${[
        tr(
          'Данные',
          pill(s.demo_mode ? 'warn' : 'ok', lbl('mode', s.data_mode)),
          s.demo_mode ? 'В сервисе только выдуманные записи' : 'Рабочие данные клиники',
        ),
        tr('База данных', pill(dbOk ? 'ok' : 'err', lbl('state', dbOk ? 'ok' : 'fail')), 'Хранилище записей'),
        tr(
          'Голос и фото',
          pill(mlOff ? 'warn' : 'ok', lbl('state', mlOff ? 'off' : 'ok')),
          mlOff ? 'Голосовой ввод и распознавание фото недоступны' : 'Голос и фото распознаются',
        ),
        tr(
          'Почта',
          pill(mailOff ? 'warn' : 'ok', lbl('state', mailOff ? 'off' : 'ok')),
          mailOff ? 'Письма не отправляются' : 'Письма отправляются',
        ),
        tr(
          'ИИ',
          pill(aiOff ? 'err' : aiDemo ? 'warn' : 'ok', lbl('state', aiOff ? 'off' : aiDemo ? 'demo' : 'ok')),
          aiDemo
            ? 'Ответы подготовлены заранее, внешняя модель не подключена'
            : aiOff
              ? 'ИИ выключен в настройках'
              : 'Ответы даёт модель',
        ),
      ].join('')}</tbody></table></div>
      <details class="adm-details"><summary>${esc(tx('msg.admin.service.dev', 'Для разработчика'))}</summary><dl class="adm-kv"><dt>Обновления базы</dt><dd>${esc(s.migrations || '—')}</dd><dt>Режим данных</dt><dd>${esc(s.data_mode)}</dd><dt>База</dt><dd>${esc(s.db)}</dd><dt>Почтовый сервер</dt><dd>${esc(s.mail)}</dd><dt>Голосовой сервис</dt><dd>${esc(s.ml_worker)}</dd></dl></details></section>
      <section class="card adm-table-card"><div class="adm-card-h"><h2>Фоновые задачи</h2><span class="adm-note">${soon()}</span></div>${
        jobs.length
          ? `<div class="tbl-wrap"><table class="tbl tbl--dense"><thead><tr><th>Задача</th><th>Состояние</th><th>Последний успех</th><th><span class="sr">Действие</span></th></tr></thead><tbody>${jobs.map((j) => `<tr><td>${esc(j.name)}</td><td class="nowrap">${j.failures ? pill('err', `Сбоев: ${j.failures}`) : pill('ok', lbl('state', 'ok'))}</td><td class="nowrap">${j.last_ok_at ? esc(fmtDate(j.last_ok_at)) : 'Ещё не запускалась'}</td><td class="act"><button type="button" class="btn ghost sm" disabled>Повторить</button></td></tr>`).join('')}</tbody></table></div>`
          : `<div class="empty">${icon('clock', 'i--32')}<h3>Фоновых задач пока нет</h3></div>`
      }<p class="adm-note">Журнал фоновых задач и очередь писем появятся позже.</p></section></div>`;
  }

  async function init() {
    try {
      const r = await fetch('/assets/ru.json');
      if (r.ok) TX = await r.json();
    } catch (_) {
      TX = {};
    }
    const root = q('#admin-app');
    if (!root) return;
    const tab = root.dataset.tab;
    const run = { dashboard, requests, people, settings, log: logs, more: moreHub, content, program, service, analytics }[tab];
    if (!run) return;
    root.textContent = '';
    try {
      await run(root);
    } catch (e) {
      console.warn('admin', tab, e);
      root.innerHTML = '<p class="muted">Не получилось загрузить раздел. Обновите страницу.</p>';
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
