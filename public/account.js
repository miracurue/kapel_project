'use strict';

/**
 * Раздел аккаунта (прототип v5): «Профиль и безопасность», «Мои данные и согласия»
 * и «Уведомления». Данные — только из API текущего пользователя; тексты уведомлений
 * приходят от сервера. data-testid совпадают с ключами locales/ru.json.
 */
(function () {
  const q = (s, r = document) => r.querySelector(s);
  const qa = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const pad = (n) => String(n).padStart(2, '0');
  const when = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : `${d.getDate()} ${MONTHS[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const ROLE = { psychiatrist: 'психиатр', psychologist: 'психолог', admin: 'администратор', patient: 'пациент' };
  const SECTION = {
    signals: 'сигналы', v3: 'сообщения и визиты', diary: 'дневник', tests: 'тесты', overview: 'обзор',
    treatment: 'лечение', messages: 'сообщения', docs: 'документы', account: 'аккаунт',
  };
  let TX = {};
  const tx = (key, fallback) => TX[key] || fallback || key;

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

  function modal({ key, title, text, ok, cancelKey, okKey, danger }) {
    return new Promise((resolve) => {
      const bg = document.createElement('div');
      bg.className = 'modal-bg';
      bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h3 data-testid="${key}">${esc(title)}</h3><p>${esc(text)}</p><div class="acts"><button type="button" class="btn ghost" data-testid="${cancelKey}" data-x>Отмена</button><button type="button" class="btn primary${danger ? ' danger-fill' : ''}" data-testid="${okKey}" data-ok>${esc(ok)}</button></div></div>`;
      document.body.appendChild(bg);
      const close = (v) => {
        bg.remove();
        resolve(v);
      };
      q('[data-x]', bg).addEventListener('click', () => close(false));
      q('[data-ok]', bg).addEventListener('click', () => close(true));
      bg.addEventListener('click', (e) => {
        if (e.target === bg) close(false);
      });
      q('[data-x]', bg).focus();
    });
  }

  // ---------- профиль ----------
  async function profile() {
    const root = q('#acc-profile');
    if (!root) return;
    const role = root.dataset.role;

    const sessions = async () => {
      const data = await get('/api/v1/me/sessions');
      const box = q('[data-sessions]', root);
      const items = (data && data.items) || [];
      box.innerHTML = items.length
        ? items
            .map(
              (s) =>
                `<div class="li"><div class="grow"><b>${esc(s.device || 'Браузер')}${s.current ? ' · это устройство' : ''}</b><small>последняя активность ${esc(when(s.last_seen_at))}</small></div></div>`,
            )
            .join('')
        : '<p class="muted small">Нет данных</p>';
    };
    await sessions();
    q('[data-testid="msg.profile.logout_all"]', root).addEventListener('click', async (e) => {
      const r = await post('/api/v1/auth/logout-all', {});
      const btn = e.target;
      btn.insertAdjacentHTML('afterend', `<span class="sub">${r.ok ? 'Готово: другие сеансы закрыты' : 'Не получилось'}</span>`);
      sessions();
    });

    // смена пароля: показываем результат и очищаем поля
    q('[data-testid="msg.profile.save_password"]', root).addEventListener('click', () => {
      setTimeout(() => qa('input[type=password]', root).forEach((i) => (i.value = '')), 1200);
    });

    if (role === 'patient') {
      const people = await get('/api/v1/me/messages');
      const first = ((people && people.recipients) || [])[0];
      if (first) {
        q('[data-doctor-name]', root).textContent = first.name;
        q('[data-doctor-role]', root).textContent = ROLE[first.role] || '';
      }
      q('[data-testid="msg.profile.change_doctor.send"]', root).addEventListener('click', async () => {
        const reason = q('[data-testid="msg.profile.change_doctor.reason"]', root).value;
        await post('/api/v1/me/clinician-change', { clinician_id: first ? first.id : undefined, reason });
      });
    }

    const hints = q('[data-testid="msg.profile.hints"]', root);
    if (hints) {
      const prefs = await get('/api/v1/me/prefs');
      hints.setAttribute('aria-checked', String(Boolean(prefs && prefs.hints_enabled)));
      hints.addEventListener('click', async () => {
        const next = hints.getAttribute('aria-checked') !== 'true';
        const r = await send('/api/v1/me/prefs', 'PATCH', { hints_enabled: next });
        if (r.ok) hints.setAttribute('aria-checked', String(next));
      });
    }

    const vac = q('[data-vacation]', root);
    if (vac) {
      const form = q('.vac-form', root);
      const out = q('[data-vac-out]', root);
      const mine = await get('/api/v1/me/substitutions');
      const active = ((mine && mine.items) || []).filter((x) => !['cancelled', 'rejected'].includes(x.status))[0];
      const waiting = q('[data-vac-waiting]', root);
      if (active) {
        waiting.hidden = false;
        waiting.textContent =
          active.status === 'confirmed' || active.status === 'active'
            ? `Замещение подтверждено: ${active.date_from || ''} — ${active.date_to || ''}`
            : 'Ждёт подтверждения администратора';
        form.hidden = false;
      }
      if (location.hash === '#vacation') form.hidden = false;
      q('[data-vac-open]', root).addEventListener('click', () => {
        form.hidden = !form.hidden;
      });
      q('[data-vac-send]', root).addEventListener('click', async () => {
        const body = {
          substitute_id: Number(q('[data-vac-who]', root).value) || undefined,
          from: q('[data-vac-from]', root).value,
          to: q('[data-vac-to]', root).value,
          all_patients: true,
        };
        const r = await post('/api/v1/me/substitutions', body);
        if (r.ok) q('[data-vac-waiting]', root).hidden = false;
        else out.textContent = 'Не получилось отправить: выберите коллегу и даты.';
      });
      const who = q('[data-vac-who]', root);
      const colleagues = await get('/api/v1/me/substitutions/candidates');
      const list = (colleagues && colleagues.items) || [];
      who.innerHTML = list.length
        ? list.map((c) => `<option value="${c.id}">${esc(c.name || c.full_name)}</option>`).join('')
        : '<option value="">Список коллег подключится вместе с подтверждением администратора</option>';
    }
  }

  // ---------- мои данные и согласия ----------
  async function myData() {
    const root = q('#my-data');
    if (!root) return;
    const [data, me, prefs] = await Promise.all([get('/api/v1/me/data'), get('/api/v1/me'), get('/api/v1/me/prefs')]);
    const cats = {
      diary: ['Дневник', 'записи — видит ваш врач'],
      assignments: ['Тесты и результаты', 'видит ваш врач и психолог'],
      ai_threads: ['Чаты с ИИ', 'видите только вы · хранятся 30 дней'],
      messages: ['Сообщения врачу', 'видите вы и ваш врач'],
      visits: ['Визиты', 'видите вы и ваш врач'],
      adverse_events: ['Сообщения о побочных эффектах', 'видит ваш врач'],
      clinicians: ['Ваши специалисты', ''],
      notifications: ['Уведомления', 'хранятся 90 дней'],
      consents: ['Согласия', 'история отметок'],
      episodes: ['Периоды наблюдения', ''],
    };
    const consents = (me && me.consents) || [];
    const state = (kind) => (consents.find((c) => c.kind === kind) || {}).state === 'given';
    const CN = [
      ['base', 'msg.mydata.consent.pd', 'Обработка данных (обязательное)'],
      ['ai', 'msg.mydata.consent.ai', 'ИИ-помощник'],
      ['research', 'msg.mydata.consent.research', 'Научные исследования'],
      ['program', 'msg.mydata.consent.program', 'Программа поддержки'],
    ];
    const rows = ((data && data.categories) || [])
      .filter((c) => cats[c.key])
      .map(
        (c) =>
          `<div class="li"><div class="grow"><b>${esc(cats[c.key][0])}</b><small>${c.count} · ${esc(cats[c.key][1])}</small></div></div>`,
      )
      .join('');
    const log = ((data && data.access_log) || []).slice(0, 12);
    const sw = (testid, on, label) =>
      `<button type="button" class="switch" role="switch" aria-checked="${on}" data-testid="${testid}" aria-label="${esc(label)}"></button>`;
    root.innerHTML = `
      <section class="acc-block"><h2 class="sec-h" data-testid="msg.mydata.who.title">Что хранится и кто видит</h2><div class="list">${rows}</div>
        <p class="footnote left">${esc(tx('msg.mydata.who.ai'))} ${esc(tx('msg.mydata.who.admin'))}.</p></section>
      <section class="acc-block"><h2 class="sec-h" data-testid="msg.mydata.viewed.title">Кто смотрел ваши данные</h2><div class="list" data-viewed>${
        log.length
          ? log
              .map(
                (l) =>
                  `<div class="li"><div class="grow"><b>${esc(l.who)}, ${esc(ROLE[l.role] || l.role)}</b><small>открыл(а) раздел «${esc(SECTION[l.section] || l.section)}» · ${esc(when(l.at))}</small></div><button type="button" class="link" data-strange="${l.id}">Это странно</button></div>`,
              )
              .join('')
          : `<p class="muted small">${esc(tx('msg.mydata.viewed.empty', 'Пока никто не смотрел'))}</p>`
      }</div><p class="sub" data-strange-out aria-live="polite"></p></section>
      <section class="acc-block"><h2 class="sec-h">Заметки дневника</h2><div class="li"><div class="grow"><b>Открыть заметки дневника врачу</b><small>Оценки врач видит всегда, заметки — только если вы откроете</small></div>${sw('msg.mydata.notes_toggle', Boolean(prefs && prefs.diary_notes_visible), 'Открыть заметки дневника врачу')}</div></section>
      <section class="acc-block"><h2 class="sec-h">Согласия</h2><div class="list" data-consents>${CN.map(([kind, key, label]) => `<div class="li"><div class="grow"><b>${esc(label)}</b></div>${sw(key, state(kind), label)}</div>`).join('')}</div><div data-consent-out></div></section>
      <section class="acc-block"><h2 class="sec-h">${esc(tx('msg.mydata.export.title', 'Скачать мои данные'))}</h2><p class="sub">${esc(tx('msg.mydata.export.lead'))}</p><div class="row-fields"><input type="password" data-testid="msg.mydata.export.password" placeholder="${esc(tx('msg.mydata.export.password', 'Пароль'))}" autocomplete="current-password"><button type="button" class="btn" data-testid="msg.mydata.export.build">${esc(tx('msg.mydata.export.build', 'Собрать архив'))}</button></div><p class="sub" data-export-out aria-live="polite"></p></section>
      <section class="acc-block"><h2 class="sec-h">Удаление аккаунта</h2><p class="sub">${esc(tx('msg.mydata.delete.text'))}</p><div class="acts"><button type="button" class="btn danger" data-testid="msg.mydata.delete.button">${esc(tx('msg.mydata.delete.button', 'Удалить аккаунт'))}</button></div><p class="sub" data-delete-out aria-live="polite"></p></section>
      <p class="footnote" data-standin>Тексты — заглушки, требуют проверки специалистом.</p>`;

    // «Это странно»
    root.addEventListener('click', async (e) => {
      const strange = e.target.closest('[data-strange]');
      if (strange) {
        const r = await post(`/api/v1/me/data/access-log/${strange.dataset.strange}/strange`, {});
        q('[data-strange-out]', root).textContent = r.ok
          ? 'Запрос отправлен в клинику. Ответим в течение 30 дней.'
          : 'Не получилось отправить запрос.';
      }
    });

    // заметки дневника
    const notes = q('[data-testid="msg.mydata.notes_toggle"]', root);
    notes.addEventListener('click', async () => {
      const next = notes.getAttribute('aria-checked') !== 'true';
      const r = await send('/api/v1/me/prefs', 'PATCH', { diary_notes_visible: next });
      if (r.ok) notes.setAttribute('aria-checked', String(next));
    });

    // согласия-переключатели
    const out = q('[data-consent-out]', root);
    for (const [kind, key, label] of CN) {
      const toggle = q(`[data-testid="${key}"]`, root);
      toggle.addEventListener('click', async () => {
        const on = toggle.getAttribute('aria-checked') === 'true';
        if (kind === 'base') {
          if (!on) return;
          const ok = await modal({
            key: 'msg.mydata.revoke.title',
            title: tx('msg.mydata.revoke.title', 'Отозвать обязательное согласие?'),
            text: tx('msg.mydata.revoke.text'),
            ok: tx('msg.mydata.revoke.confirm', 'Отозвать согласие'),
            cancelKey: 'msg.mydata.revoke.cancel',
            okKey: 'msg.mydata.revoke.confirm',
            danger: true,
          });
          if (!ok) return;
          const r = await post('/api/v1/consents/base', { action: 'revoke', confirm: true });
          if (r.ok) location.assign('/login');
          return;
        }
        const r = await post(`/api/v1/consents/${kind}`, { action: on ? 'revoke' : 'give' });
        if (!r.ok) return;
        toggle.setAttribute('aria-checked', String(!on));
        if (on) {
          out.innerHTML = `<p class="sub undo-line"><span data-testid="msg.undo.consent_off">Выключено · </span><button type="button" class="link" data-testid="msg.undo.action">Отменить</button></p>${kind === 'ai' ? `<p class="sub">${esc(tx('msg.mydata.consent.ai_off_effect'))}</p>` : ''}`;
          q('[data-testid="msg.undo.action"]', out).addEventListener('click', async () => {
            const back = await post(`/api/v1/consents/${kind}`, { action: 'give' });
            if (back.ok) {
              toggle.setAttribute('aria-checked', 'true');
              out.innerHTML = '';
            }
          });
        } else out.innerHTML = '';
      });
    }

    // выгрузка
    q('[data-testid="msg.mydata.export.build"]', root).addEventListener('click', async () => {
      const o = q('[data-export-out]', root);
      o.textContent = tx('msg.mydata.export.building', 'Готовим архив…');
      const r = await post('/api/v1/me/exports', { password: q('[data-testid="msg.mydata.export.password"]', root).value });
      if (!r.ok) {
        o.textContent = r.status === 401 || r.status === 403 ? 'Неверный пароль.' : 'Не удалось собрать архив.';
        return;
      }
      const link = r.data.url || r.data.link || (r.data.export && r.data.export.url);
      o.innerHTML = link
        ? `<a data-testid="msg.mydata.export.ready" href="${esc(link)}">${esc(tx('msg.mydata.export.ready', 'Архив готов · Скачать'))}</a>`
        : `<span data-testid="msg.mydata.export.ready">${esc(tx('msg.mydata.export.later', 'Архив большой — пришлём уведомление, когда будет готов'))}</span>`;
    });

    // удаление аккаунта
    q('[data-testid="msg.mydata.delete.button"]', root).addEventListener('click', async () => {
      const ok = await modal({
        key: 'msg.mydata.delete.title',
        title: tx('msg.mydata.delete.title', 'Удалить аккаунт?'),
        text: tx('msg.mydata.delete.text'),
        ok: tx('msg.mydata.delete.confirm', 'Удалить аккаунт'),
        cancelKey: 'msg.mydata.delete.cancel',
        okKey: 'msg.mydata.delete.confirm',
        danger: true,
      });
      if (!ok) return;
      const r = await post('/api/v1/me/deletion-request', { confirm: true });
      q('[data-delete-out]', root).textContent = r.ok
        ? 'Запрос принят. Обработка остановлена, данные удалятся в течение 30 дней.'
        : 'Не удалось отправить запрос.';
    });
  }

  // ---------- уведомления ----------
  async function notifications() {
    const box = q('#acc-notes');
    if (!box) return;
    const data = await get('/api/v1/notifications');
    const items = (data && data.items) || [];
    const LINK = {
      crisis: '/work?tab=signals',
      crisis_outcome: '/work?tab=signals',
      message: document.body.dataset.role === 'R-02' ? '/app?tab=doctor' : '/work?tab=patients',
      assignment: '/app?tab=tests',
      med_remind: '/app?tab=meds',
    };
    box.innerHTML = items.length
      ? items
          .map(
            (n) =>
              `<a class="li" href="${LINK[n.type] || '#'}"><span class="dotc ${n.read_at ? 'n' : 'r'}"></span><div class="grow"><b>${esc(n.title)}</b><small>${esc(when(n.created_at))}</small></div></a>`,
          )
          .join('')
      : `<p class="muted">${esc(tx('msg.notifications.empty', 'Новых уведомлений нет'))}</p>`;
    q('[data-testid="msg.notifications.read_all"]')?.addEventListener('click', () =>
      qa('.dotc.r', box).forEach((d) => (d.className = 'dotc n')),
    );

    const rem = q('#acc-reminders');
    if (rem) {
      const [prefs, reminders] = await Promise.all([get('/api/v1/me/prefs'), get('/api/v1/me/reminders')]);
      const list = (reminders && reminders.items) || [];
      const sw = (id, on) =>
        `<button type="button" class="switch" role="switch" aria-checked="${on}" aria-label="Напоминание" data-rem="${id}"></button>`;
      rem.innerHTML =
        (list.length
          ? list
              .map(
                (r) =>
                  `<div class="li"><div class="grow"><b>Напоминание</b><small>${esc(r.time_hhmm)}</small></div>${sw(r.id, Boolean(r.active))}</div>`,
              )
              .join('')
          : '<div class="li"><div class="grow"><b>Приём лекарства</b><small>время выберем, когда подключим</small></div><span class="soon" title="Интерфейс готов, серверная часть в работе">скоро</span></div><div class="li"><div class="grow"><b>Дневник</b><small>вечером, в удобное время</small></div><span class="soon" title="Интерфейс готов, серверная часть в работе">скоро</span></div>') +
        `<div class="li"><div class="grow"><b>Советы по ходу курса</b><small>короткие подсказки по неделям приёма</small></div>${`<button type="button" class="switch" role="switch" aria-checked="${Boolean(prefs && prefs.course_support_enabled)}" aria-label="Советы по ходу курса" data-course></button>`}</div><div class="li"><div class="grow"><b>Письмо на почту</b><small>только «у вас новое событие», без подробностей</small></div><span class="soon" title="Интерфейс готов, серверная часть в работе">скоро</span></div>`;
      rem.addEventListener('click', async (e) => {
        const t = e.target.closest('.switch');
        if (!t) return;
        const on = t.getAttribute('aria-checked') !== 'true';
        if (t.dataset.rem) {
          const row = list.find((x) => String(x.id) === t.dataset.rem);
          const r = await send(`/api/v1/me/reminders/${t.dataset.rem}`, 'PUT', { time: row.time_hhmm, enabled: on });
          if (r.ok) t.setAttribute('aria-checked', String(on));
        } else if ('course' in t.dataset) {
          const r = await send('/api/v1/me/prefs', 'PATCH', { course_support_enabled: on });
          if (r.ok) t.setAttribute('aria-checked', String(on));
        }
      });
    }
  }

  async function init() {
    try {
      const r = await fetch('/assets/ru.json');
      if (r.ok) TX = await r.json();
    } catch (_) {
      TX = {};
    }
    for (const job of [profile, myData, notifications]) {
      try {
        await job();
      } catch (e) {
        console.warn('account', job.name, e);
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
