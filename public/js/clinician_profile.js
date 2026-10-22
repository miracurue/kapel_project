'use strict';

/**
 * Профессиональный профиль специалиста (/account/professional): специальность, место работы, журналы, конференции.
 * Всё необязательно. Пока специалист не разрешил, профиль не попадает в аналитику заказчика; без разрешения
 * учитывается только специальность (по роли).
 */
(function () {
  const root = document.getElementById('clin-profile');
  if (!root) return;
  const esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const REGIONS = [
    'Москва',
    'Санкт-Петербург',
    'Московская область',
    'Ленинградская область',
    'Свердловская область',
    'Новосибирская область',
    'Республика Татарстан',
    'Краснодарский край',
    'Нижегородская область',
    'Самарская область',
    'Ростовская область',
    'Красноярский край',
  ];

  async function token() {
    return (await (await fetch('/api/v1/csrf')).json()).token;
  }
  const opt = (list, value, empty) =>
    `${empty ? `<option value="">${esc(empty)}</option>` : ''}${list
      .map((o) => `<option value="${esc(o.code)}"${o.code === value ? ' selected' : ''}>${esc(o.label)}</option>`)
      .join('')}`;

  function render(p) {
    const org = p.organization || { name: '', kind: '', region: '', city: '' };
    root.innerHTML = `<form class="card acc-block" data-prof-form>
      <h3>Специальность и место работы</h3>
      <div class="prof-grid">
        <label>Специальность<select name="specialty">${opt(p.options.specialties, p.specialty, 'Не указывать')}</select></label>
        <label>Организация<input name="org_name" maxlength="120" value="${esc(org.name)}" placeholder="Например, городская поликлиника № 5"></label>
        <label>Тип организации<select name="org_kind">${opt(p.options.org_kinds, org.kind, 'Не указывать')}</select></label>
        <label>Регион<input name="org_region" list="prof-regions" maxlength="80" value="${esc(org.region)}"></label>
        <label>Город<input name="org_city" maxlength="80" value="${esc(org.city)}"></label>
      </div>
      <datalist id="prof-regions">${REGIONS.map((r) => `<option value="${esc(r)}">`).join('')}</datalist>
      <h3>Журналы и конференции</h3>
      <div class="prof-grid">
        <label>Журналы, которые вы читаете (по одному в строке)<textarea name="journals" rows="4" maxlength="2000">${esc(p.journals.join('\n'))}</textarea></label>
        <label>Конференции, на которых бываете (по одной в строке, можно с годом: «Название, 2025»)<textarea name="conferences" rows="4" maxlength="2000">${esc(p.conferences.map((c) => (c.year ? `${c.title}, ${c.year}` : c.title)).join('\n'))}</textarea></label>
      </div>
      <label class="check"><input type="checkbox" name="consent"${p.analytics_consent ? ' checked' : ''}> Разрешаю использовать место работы, журналы и конференции в обезличенной статистике сервиса</label>
      <p class="muted small">Статистика показывается только группами не меньше трёх специалистов, без имён. Согласие можно отозвать в любой момент: профиль сразу перестанет учитываться. Если не разрешать, учитывается только специальность.</p>
      <div class="acts"><button class="btn primary" type="submit">Сохранить</button> <span class="muted small" data-prof-out aria-live="polite"></span></div>
    </form>`;
    root.querySelector('[data-prof-form]').addEventListener('submit', save);
  }

  const lines = (text) =>
    String(text || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

  async function save(e) {
    e.preventDefault();
    const f = e.target;
    const out = root.querySelector('[data-prof-out]');
    const name = f.org_name.value.trim();
    const body = {
      specialty: f.specialty.value || null,
      organization: name
        ? { name, kind: f.org_kind.value, region: f.org_region.value.trim(), city: f.org_city.value.trim() }
        : null,
      analytics_consent: f.consent.checked,
      journals: lines(f.journals.value),
      conferences: lines(f.conferences.value).map((l) => {
        const m = l.match(/^(.*?)[,\s]+((?:19|20)\d{2})$/);
        return m ? { title: m[1], year: Number(m[2]) } : { title: l };
      }),
    };
    out.textContent = 'Сохраняю…';
    const r = await fetch('/api/v1/me/clinician-profile', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': await token(),
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      render(await r.json());
      root.querySelector('[data-prof-out]').textContent = 'Сохранено.';
    } else
      out.textContent =
        r.status === 422 ? 'Проверьте поля: у организации нужны название, тип и регион.' : 'Не получилось сохранить.';
  }

  fetch('/api/v1/me/clinician-profile', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then(render)
    .catch(() => {
      root.innerHTML = '<p class="muted">Не получилось загрузить профиль. Обновите страницу.</p>';
    });
})();
