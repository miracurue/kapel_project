'use strict';

async function csrf() {
  const response = await fetch('/api/v1/csrf');
  return (await response.json()).token;
}

async function api(path, body, method = 'POST') {
  const token = await csrf();
  return fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-csrf-token': token, 'idempotency-key': crypto.randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const testId = (key) => `[data-testid="${key}"]`;
const show = (selector) => {
  const node = document.querySelector(selector);
  if (node) node.hidden = false;
  return node;
};
const hide = (selector) => {
  const node = document.querySelector(selector);
  if (node) node.hidden = true;
  return node;
};

const CONSENT_TEXT = {
  pd: [
    'Согласие на обработку данных, включая сведения о здоровье',
    'Обязательно для работы сервиса. Мы обрабатываем ваши ответы, дневник и назначения, чтобы врач видел динамику. Кто видит: ваш врач и закреплённый психолог. Срок: пока вы пользуетесь сервисом и 30 дней после удаления. Полный текст документа — заглушка, требует проверки юристом.',
  ],
  ai: [
    'Согласие на ИИ-помощника',
    'ИИ-помощник отвечает на вопросы о лекарствах, тестах и самочувствии. Он получает только то, что вы прикрепили, без имён и контактов. Можно включить позже в «Моих данных». Без него ИИ-помощник выключен, всё остальное работает.',
  ],
  research: [
    'Согласие на научные исследования',
    'Только баллы тестов, без имени и текста. Данные используются в обезличенном виде. Отозвать можно в любой момент.',
  ],
  program: [
    'Согласие на статистику программы поддержки',
    'Спонсор видит только общие цифры по группам от 10 человек. Отозвать можно в любой момент.',
  ],
};

function consentPage(number) {
  const main = document.querySelector('main');
  const mandatory = number === 1;
  const kind = mandatory ? 'pd' : ['ai', 'research', 'program'][number - 2];
  main.dataset.page = `P-0${number + 3}`;
  main.dataset.consentStep = String(number);
  const [title, text] = CONSENT_TEXT[kind];
  main.innerHTML = `<p class="kicker">Согласие ${number} из 4</p>
    <h1 data-testid="msg.consent.${kind}.title">${title}</h1>
    <section class="card soft consent-text"><p>${text}</p></section>
    ${mandatory ? '<label class="check-row"><input type="checkbox" data-testid="msg.consent.pd.checkbox"> Я прочитал(а) и согласен(на) с обработкой моих персональных данных, включая данные о здоровье, на условиях выше.</label>' : ''}
    <div class="acts consent-acts"><button class="btn primary" data-testid="msg.consent.agree">${mandatory ? 'Согласен(на)' : 'Принять'}</button>
    ${mandatory ? '' : '<button class="btn ghost" data-testid="msg.consent.not_now">Не сейчас</button>'}</div>
    <p class="small muted" data-testid="err.e-consent-required" hidden>Без этого согласия кабинет не создаётся. Номер 112 работает всегда.</p>
    <p class="small muted">Согласия можно отозвать в меню профиля → «Мои данные и согласия».</p>`;
}

async function submitConsent(number, accepted) {
  const kinds = ['base', 'ai', 'research', 'program'];
  const checkbox = document.querySelector(testId('msg.consent.pd.checkbox'));
  if (number === 1 && !checkbox?.checked) {
    show(testId('err.e-consent-required'));
    return;
  }
  const response = await api(`/api/v1/consents/${kinds[number - 1]}`, {
    action: accepted ? 'give' : 'revoke',
    checkbox: Boolean(checkbox?.checked),
  });
  if (!response.ok && number === 1) {
    show(testId('err.e-consent-required'));
    return;
  }
  if (number < 4) consentPage(number + 1);
  else location.assign('/app');
}

async function pollNotifications() {
  if (!document.querySelector(testId('msg.shell.bell'))) return;
  try {
    const response = await fetch('/api/v1/notifications/count');
    if (!response.ok) return;
    const { unread } = await response.json();
    let badge = document.querySelector(testId('msg.shell.bell.count'));
    if (unread > 0 && !badge) {
      badge = document.createElement('span');
      badge.dataset.testid = 'msg.shell.bell.count';
      document.querySelector(testId('msg.shell.bell'))?.after(badge);
    }
    if (badge) {
      badge.textContent = String(unread);
      if (unread < 1) badge.remove();
    }
    const avatar = document.querySelector(testId('msg.shell.avatar'));
    if (avatar) {
      if (unread > 0) avatar.dataset.unread = String(unread);
      else delete avatar.dataset.unread;
    }
  } catch (_) {
    /* сеть может быть отключена */
  }
}

const NOTE_LINK = {
  crisis: () =>
    document.body.dataset.role === 'R-03' || document.body.dataset.role === 'R-04'
      ? '/work?tab=signals'
      : '/notifications',
  crisis_outcome: () => '/work?tab=signals',
  message: () => (document.body.dataset.role === 'R-02' ? '/app?tab=doctor' : '/work?tab=patients'),
  assignment: () => '/app?tab=tests',
};
const noteEsc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const NOTE_MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function noteTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getDate()} ${NOTE_MONTHS[d.getMonth()]}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function closeMenus() {
  document.querySelectorAll('.menu, .notifications-menu').forEach((node) => {
    if (node.classList.contains('notifications-menu')) node.remove();
    else node.hidden = true;
  });
}

async function openNotifications() {
  const panel = document.createElement('div');
  panel.className = 'menu notifications-menu';
  panel.innerHTML = '<div class="who"><b>Уведомления</b></div><p class="note">Загружаем…</p>';
  document.querySelector('.top')?.append(panel);
  let items = [];
  try {
    const response = await fetch('/api/v1/notifications');
    if (response.ok) items = (await response.json()).items || [];
  } catch (_) {
    /* оставим пустой список */
  }
  const rows = items
    .slice(0, 6)
    .map(
      (n) =>
        `<a class="n-item${n.read_at ? '' : ' unread'}" href="${(NOTE_LINK[n.type] || (() => '/notifications'))()}">${noteEsc(n.title)}<small>${noteEsc(noteTime(n.created_at))}</small></a>`,
    )
    .join('');
  panel.innerHTML = `<div class="who"><b>Уведомления</b></div>${rows || '<p class="note">Новых уведомлений нет</p>'}<hr><button data-testid="msg.notifications.all">Все уведомления</button>`;
}

function markCurrentTab() {
  const tabs = [...document.querySelectorAll('.tabs a.tab[data-tab]')];
  if (!tabs.length) return;
  const params = new URLSearchParams(location.search);
  let current = params.get('tab');
  if (location.pathname.startsWith('/work/patients/')) current = 'patients';
  else if (['/account', '/notifications'].some((path) => location.pathname.startsWith(path))) current = '__none__';
  else if (!current) current = tabs[0].dataset.tab;
  if (current === 'analytics') current = '__none__';
  if (current === 'visits') current = 'doctor';
  tabs.forEach((tab) => {
    if (tab.dataset.tab === current) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
}

// Вкладки не сжимаются: если шапка не помещается (или это телефон), последние уходят в «Ещё ▾» (спецификация 8.1).
const PHONE_TABS = 4;
function fitTabs() {
  const top = document.querySelector('header.top');
  const more = top?.querySelector('.tabs a.tab[data-tab="more"]');
  const menu = top?.querySelector('.more-menu');
  if (!top || !more || !menu) return;
  const phone = window.matchMedia('(max-width: 960px)').matches;
  const tabs = [...top.querySelectorAll('.tabs a.tab[data-tab]')].filter((tab) => tab !== more);
  menu.querySelectorAll('[data-overflow]').forEach((node) => node.remove());
  tabs.forEach((tab) => {
    tab.hidden = false;
  });
  let hidden = 0;
  const overflow = () => (phone ? tabs.length - hidden > PHONE_TABS : top.scrollWidth > top.clientWidth + 1);
  while (hidden < tabs.length && overflow()) {
    tabs[tabs.length - 1 - hidden].hidden = true;
    hidden += 1;
  }
  const moved = tabs.filter((tab) => tab.hidden);
  moved.reverse().forEach((tab) => {
    const link = document.createElement('a');
    link.href = tab.getAttribute('href');
    link.dataset.overflow = '1';
    link.textContent = tab.querySelector('.lbl')?.textContent || '';
    menu.prepend(link);
  });
}

function setBadge(tab, count, grey) {
  const link = document.querySelector(`.tabs a.tab[data-tab="${tab}"]`);
  if (!link) return;
  link.querySelector('.badge')?.remove();
  if (count > 0)
    link.insertAdjacentHTML(
      'beforeend',
      `<span class="badge${grey ? ' grey' : ''}" aria-label="${count}">${count}</span>`,
    );
}

async function loadBadges() {
  const role = document.body.dataset.role;
  const get = async (path) => {
    try {
      const response = await fetch(path);
      return response.ok ? await response.json() : null;
    } catch (_) {
      return null;
    }
  };
  if (role === 'R-02') {
    const data = await get('/api/v1/me/assignments');
    const open = ((data && data.items) || []).filter((a) => ['pending', 'in_progress'].includes(a.status)).length;
    setBadge('tests', open, true);
  }
  if (role === 'R-03' || role === 'R-04') {
    const data = await get('/api/v1/signals?status=new');
    setBadge('signals', ((data && data.items) || []).length, false);
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenus();
});

document.addEventListener('submit', async (event) => {
  if (event.target.id === 'login-form') {
    const email = event.target.email.value.trim().toLowerCase();
    const pending = localStorage.getItem('cc_diary_pending');
    if (pending) {
      localStorage.setItem(`cc_diary_draft:${email}`, pending);
      localStorage.removeItem('cc_diary_pending');
      event.target.restore_diary.value = '1';
    }
    return;
  }
  event.preventDefault();
  if (event.target.id === 'register-form') {
    const form = event.target;
    const response = await api('/api/v1/auth/register', {
      invite_code: form.invite_code.value,
      email: form.email.value,
      password: form.password.value,
    });
    if (response.ok) consentPage(1);
    else form.querySelector('.form-error').textContent = 'Проверьте код и данные';
  }
  if (event.target.id === 'reset-request-form') {
    await api('/api/v1/auth/password-reset', { email: event.target.email.value });
    show(testId('msg.reset.sent'));
  }
  if (event.target.id === 'reset-confirm-form') {
    const form = event.target;
    const response = await api('/api/v1/auth/password-reset/confirm', {
      token: form.dataset.token,
      password: form.password.value,
      password_repeat: form.password_repeat.value,
    });
    if (response.ok) show(testId('msg.reset.new.done'));
    else show(testId('err.e-reset-token'));
  }
});

document.addEventListener('click', async (event) => {
  const target = event.target;
  const moreTab = target.closest('.tabs a.tab[data-tab="more"]');
  const moreMenu = document.querySelector('.more-menu');
  if (moreTab && moreMenu) {
    event.preventDefault();
    const wasOpen = !moreMenu.hidden;
    closeMenus();
    if (!wasOpen) {
      const box = moreTab.getBoundingClientRect();
      moreMenu.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - 268))}px`;
      moreMenu.hidden = false;
    }
    return;
  }
  if (target.closest(testId('msg.shell.avatar'))) {
    const menu = document.querySelector('.avatar-menu');
    const wasOpen = menu && !menu.hidden;
    closeMenus();
    if (menu) menu.hidden = wasOpen;
  } else if (!target.closest('.menu, .notifications-menu') && !target.closest(testId('msg.shell.bell'))) closeMenus();
  if (target.closest(testId('msg.onboarding.skip'))) localStorage.setItem('cc_onboarding_done', '1');
  if (target.closest(testId('msg.nav.avatar.logout'))) {
    await api('/api/v1/auth/logout', {});
    location.replace('/login');
  }
  const demoRole = target.closest('[data-demo-role]')?.dataset.demoRole;
  if (demoRole) {
    event.preventDefault();
    const response = await api('/api/v1/demo/login-as', { role: demoRole });
    if (response.ok) {
      const result = await response.json();
      location.assign(`/${result.next}`);
    }
  }
  if (target.closest(testId('msg.consent.agree')))
    await submitConsent(Number(document.querySelector('main').dataset.consentStep), true);
  if (target.closest(testId('msg.consent.not_now')))
    await submitConsent(Number(document.querySelector('main').dataset.consentStep), false);
  if (target.closest(testId('msg.diary.save'))) {
    const text = document.querySelector(testId('msg.diary.note')).value;
    const pick = window.__diaryPick || {};
    const entry = { note: text };
    if (pick.mood) entry.mood = Number(pick.mood);
    if (pick.sleep) entry.sleep = pick.sleep;
    if (pick.anxiety) entry.anxiety = pick.anxiety;
    const response = await api('/api/v1/me/diary', entry);
    if (response.status === 401) {
      localStorage.setItem('cc_diary_pending', text);
      location.assign('/login?expired=1');
      return;
    }
    if (response.ok) {
      show(testId('msg.undo.diary_saved'));
      show(testId('msg.diary.chart'));
      show(testId('msg.diary.visibility'));
      hide(testId('msg.diary.empty'));
    }
  }
  if (target.closest(testId('msg.composer.send'))) {
    const doctorField = document.querySelector(testId('msg.doctor.placeholder'));
    if (!doctorField) return;
    if (!navigator.onLine) show(testId('msg.shell.offline'));
    else await api('/api/v1/me/messages', { text: doctorField.value });
  }
  if (target.closest(testId('msg.shell.bell'))) {
    const existing = document.querySelector('.notifications-menu');
    closeMenus();
    if (!existing) await openNotifications();
  }
  if (target.closest(testId('msg.notifications.all'))) location.assign('/notifications');
  if (target.closest(testId('msg.notifications.read_all'))) {
    document.querySelector(testId('msg.shell.bell.count'))?.remove();
    await api('/api/v1/notifications/read', { all: true });
  }
  if (target.closest(testId('msg.host.data.reset'))) document.querySelector('#demo-reset')?.showModal();
  if (target.closest(testId('msg.host.reset.confirm'))) {
    const response = await api('/api/v1/demo/reset', { confirm: true });
    if (response.ok) {
      document.querySelector('#demo-reset')?.close();
      show(testId('msg.host.reset.done'));
    }
  }
  if (target.closest(testId('msg.profile.change_doctor'))) show('.change-doctor');
  if (target.closest(testId('msg.profile.change_doctor.send'))) show(testId('msg.profile.change_doctor.sent'));
  if (target.closest(testId('msg.profile.save_password'))) {
    const current_password = document.querySelector(testId('msg.profile.current_password')).value;
    const new_password = document.querySelector(testId('msg.profile.new_password')).value;
    const new_password_repeat = document.querySelector(testId('msg.profile.repeat_password')).value;
    const response = await api('/api/v1/me/password', { current_password, new_password, new_password_repeat });
    if (response.ok) show(testId('msg.profile.password_changed'));
  }
});

window.addEventListener('offline', () => show(testId('msg.shell.offline')));

(async () => {
  if (localStorage.getItem('cc_onboarding_done')) document.querySelector(testId('msg.onboarding.patient.1'))?.remove();
  if (location.pathname === '/login' && new URLSearchParams(location.search).has('expired'))
    show(testId('msg.login.session_expired'));
  const diary = document.querySelector(testId('msg.diary.note'));
  if (diary) {
    try {
      const response = await fetch('/api/v1/me');
      if (response.ok) {
        const data = await response.json();
        const email = data.user && data.user.email;
        const known = email && localStorage.getItem(`cc_diary_draft:${email}`);
        if (known) {
          diary.value = known;
          const restored = document.createElement('p');
          restored.dataset.testid = 'msg.composer.draft_restored';
          restored.textContent = 'Черновик восстановлен';
          diary.before(restored);
        }
      }
    } catch (_) {
      /* остаёмся на странице */
    }
  }
  markCurrentTab();
  fitTabs();
  window.addEventListener('resize', fitTabs);
  document.fonts?.ready.then(fitTabs);
  loadBadges();
  await pollNotifications();
  setInterval(pollNotifications, 1000);
})();
