'use strict';

/**
 * Назначение лекарств врачом (карточка пациента → «Лечение»): текущий план с статусом приёма, черновик назначения
 * с подсказками по каталогу (МНН и торговые названия), правка и отмена пункта. Подключается до v2.js и views.js,
 * которые вызывают window.CCRx: mount (список назначений), openDraft (черновик из фразы), send (опубликовать).
 * План — это список по МНН: любое изменение отправляет в /api/v1/patients/{id}/plan/draft весь список, затем publish.
 */
(function () {
  const TXT = {
    plan: 'Назначено сейчас',
    empty: 'Назначений пока нет. Опишите первое ниже, например: «сертралин 50 мг утром, 4 недели».',
    draft: 'Черновик',
    drug: 'Препарат',
    drug_ph: 'Начните вводить название',
    dose: 'Доза',
    unit: 'Единица',
    when: 'Когда принимать',
    term: 'Срок',
    term_none: 'без срока',
    comment: 'Комментарий пациенту',
    comment_ph: 'Например: принимать после еды',
    inn_only: 'Назначается только действующее вещество (МНН). Торговое название пациент выберет сам.',
    send: 'Отправить пациенту',
    save: 'Отправить изменение',
    cancel: 'Отмена',
    edit: 'Изменить',
    stop: 'Отменить назначение',
    stop_yes: 'Да, отменить',
    stop_no: 'Нет',
    stop_ask: 'Отменить назначение «{name}»? Пациент увидит это в приложении.',
    pick_drug: 'Выберите препарат из подсказок или добавьте его в каталог.',
    need_dose: 'Укажите дозу.',
    need_when: 'Выберите, когда принимать.',
    in_catalog: '✓ В каталоге',
    not_found: 'Такого препарата в каталоге нет. Выберите из подсказок или добавьте его.',
    add: 'Добавить «{name}» в каталог',
    added_tag: 'добавлен врачом',
    added_ok: 'Добавлено в каталог — теперь его увидят и другие врачи.',
    replaces: 'Уже назначен ({dose}): новая запись заменит текущую.',
    via: 'торговое название',
    waiting: 'Ждёт подтверждения пациента',
    review: 'Назначение изменено — пациент должен проверить',
    accepted: 'Пациент принял',
    own_dose: 'Пациент указал дозу: {dose}',
    bought: 'Купил(а): {name}',
    until: 'до {date}',
    failed: 'Не удалось сохранить. Попробуйте ещё раз.',
    conflict: 'План изменился в другом окне. Обновите страницу.',
    editing: 'Изменение назначения',
    parsing: 'Разбираю фразу…',
    parse_denied: 'Назначать лекарства может только психиатр.',
    parse_failed: 'Не удалось разобрать фразу автоматически — заполните поля вручную.',
    parse_missing: 'Не распознано: {fields}. Проверьте и заполните.',
    missing_inn: 'препарат',
    missing_dose: 'доза',
    missing_times: 'когда принимать',
    own_title: 'Внесено пациентом',
    own_seen: 'Вы посмотрели',
    own_new: 'Новая запись пациента',
    own_changed: 'Пациент изменил запись',
    own_confirm: 'Подтвердить',
    own_comment: 'Комментарий',
    own_comment_ph: 'Что увидит пациент (до 300 знаков)',
    own_send: 'Отправить',
    own_conflict: 'Пациент только что изменил запись — данные обновлены, проверьте ещё раз.',
    own_comment_label: 'Ваш комментарий: {text}',
    history: 'История версий',
    history_row: 'Версия {n} · {date} · {status}',
    st_published: 'действует',
    st_superseded: 'заменена',
    st_cancelled: 'отменена',
  };
  const TIMES = ['утро', 'день', 'вечер', 'на ночь'];
  const UNITS = ['мг', 'мкг', 'мл', 'таблетка'];
  const DURATION = [
    ['дней', 1],
    ['недель', 7],
    ['месяцев', 30],
  ];

  const esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const cap = (v) => (v ? String(v).charAt(0).toUpperCase() + String(v).slice(1) : '');
  const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  const dmy = (iso) =>
    String(iso || '')
      .slice(0, 10)
      .split('-')
      .reverse()
      .join('.');
  const num = (v) => String(v ?? '').replace('.', ',');

  async function api(path, method = 'GET', body) {
    const headers = {};
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      headers['x-csrf-token'] = (await (await fetch('/api/v1/csrf')).json()).token;
      headers['idempotency-key'] = crypto.randomUUID();
    }
    const response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { ok: response.ok, status: response.status, data: await response.json().catch(() => ({})) };
  }

  // ---------- разбор фразы «сертралин 75 мг утром, 4 недели» ----------

  function parsePhrase(raw) {
    const text = String(raw || '').trim();
    const out = { name: '', dose: '', unit: 'мг', times: [], durN: '', durUnit: 'недель' };
    const dose = /(\d+(?:[.,]\d+)?)\s*(мкг|мг|мл|таблет\S*|таб\S*)?/i.exec(text);
    out.name = (dose ? text.slice(0, dose.index) : text)
      .replace(/^\s*(назнач\S*|выписа\S*|добавь\S*)\s+/i, '')
      .replace(/[,;]+\s*$/, '')
      .trim();
    let rest = text;
    if (dose) {
      out.dose = dose[1].replace(',', '.');
      const u = (dose[2] || '').toLowerCase();
      out.unit = u.startsWith('таб') ? 'таблетка' : u === 'мкг' || u === 'мл' ? u : 'мг';
      rest = text.slice(0, dose.index) + ' ' + text.slice(dose.index + dose[0].length);
    }
    const per = /(\d)\s*раз\S*\s+в\s+(день|сутки)/i.exec(rest);
    if (per) out.times = per[1] === '2' ? ['утро', 'вечер'] : per[1] === '3' ? ['утро', 'день', 'вечер'] : [];
    if (/утр/i.test(rest) && !out.times.includes('утро')) out.times.push('утро');
    if (/(днём|днем|обед)/i.test(rest) && !out.times.includes('день')) out.times.push('день');
    if (/вечер/i.test(rest) && !out.times.includes('вечер')) out.times.push('вечер');
    if (/(на\s+ночь|ночью|перед\s+сном)/i.test(rest) && !out.times.includes('на ночь')) out.times.push('на ночь');
    out.times = TIMES.filter((x) => out.times.includes(x));
    const dur = /(\d+)\s*(дн\S*|день|нед\S*|мес\S*)/i.exec(rest);
    if (dur) {
      out.durN = dur[1];
      out.durUnit = /^нед/i.test(dur[2]) ? 'недель' : /^мес/i.test(dur[2]) ? 'месяцев' : 'дней';
    }
    return out;
  }

  // ---------- подсказки по каталогу ----------

  async function searchDrugs(text) {
    const query = String(text || '').trim();
    if (query.length < 2) return [];
    const enc = encodeURIComponent(query);
    const [inns, products] = await Promise.all([
      api(`/api/v1/catalog/search?q=${enc}&scope=inn`),
      api(`/api/v1/catalog/search?q=${enc}&scope=products`),
    ]);
    const seen = new Set();
    const out = [];
    for (const x of (inns.data.items || []).filter((r) => r.score < 4)) {
      seen.add(x.id);
      out.push({ inn_id: x.id, inn_name: x.name, via: '', score: x.score, custom: Boolean(x.added_by_doctor) });
    }
    for (const x of (products.data.items || []).filter((r) => r.score < 4 && r.status === 'in_catalog')) {
      if (seen.has(x.inn_id)) continue;
      seen.add(x.inn_id);
      out.push({ inn_id: x.inn_id, inn_name: x.inn_name, via: x.name, score: x.score });
    }
    return out.slice(0, 6);
  }

  /** Всплывающий список под полем. getQuery() — что искать; onPick(item) — выбор мышью или Enter. */
  function attachSuggest(input, { getQuery, onPick, canAdd }) {
    const host = input.closest('.rx-field') || input.parentElement;
    host.classList.add('rx-field');
    const list = document.createElement('div');
    list.className = 'rx-suggest';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    host.appendChild(list);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('autocomplete', 'off');
    let items = [];
    let active = -1;
    let timer = null;
    let seq = 0;
    const hide = () => {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      active = -1;
    };
    const mark = () =>
      list.querySelectorAll('[role="option"]').forEach((el, i) => {
        el.classList.toggle('on', i === active);
        el.setAttribute('aria-selected', i === active ? 'true' : 'false');
      });
    const pick = (item) => {
      hide();
      onPick(item);
    };
    async function refresh() {
      const mine = ++seq;
      const found = await searchDrugs(getQuery());
      if (mine !== seq) return;
      items = found;
      const typed = String(getQuery() || '').trim();
      if (canAdd && typed.length >= 2 && !items.some((x) => x.score < 0)) items = [...items, { add: typed }];
      list.textContent = '';
      if (!items.length) return hide();
      items.forEach((item) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'option');
        if (item.add) {
          b.dataset.rxAddOption = '';
          b.className = 'rx-add-option';
          b.textContent = fill(TXT.add, { name: item.add });
        } else {
          b.dataset.innId = String(item.inn_id);
          b.innerHTML = `<b>${esc(cap(item.inn_name))}</b>${item.via ? ` <small>${esc(TXT.via)}: ${esc(item.via)}</small>` : ''}${item.custom ? ` <small class="rx-tag">${esc(TXT.added_tag)}</small>` : ''}`;
        }
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', () => pick(item));
        list.appendChild(b);
      });
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      active = -1;
    }
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 150);
    });
    input.addEventListener('keydown', (e) => {
      if (list.hidden || !items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        mark();
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        e.stopPropagation();
        pick(items[active]);
      } else if (e.key === 'Escape') hide();
    });
    input.addEventListener('blur', () => setTimeout(hide, 150));
    return { refresh, hide };
  }

  // ---------- план: загрузка и отправка ----------

  let current = null; // { patient, published, draftVersion }
  async function loadPlan(patient) {
    const res = await api(`/api/v1/patients/${patient}/plan`);
    const plan = res.data || {};
    current = {
      patient,
      items: (plan.published && plan.published.items) || [],
      draftVersion: plan.draft ? plan.draft.version : 1,
      versions: plan.versions || [],
    };
    return current;
  }

  const toPayload = (i) => ({
    inn_id: i.inn_id,
    dose: i.dose || undefined,
    unit: i.unit || undefined,
    times: i.times || [],
    until: i.until || undefined,
    comment: i.comment || undefined,
  });

  async function publish(patient, items) {
    const plan = await loadPlan(patient);
    const draft = await api(`/api/v1/patients/${patient}/plan/draft`, 'PUT', { version: plan.draftVersion, items });
    if (!draft.ok) return draft;
    return api(`/api/v1/patients/${patient}/plan/publish`, 'POST', { version: draft.data.version });
  }

  const failText = (res) => (res.status === 409 ? TXT.conflict : TXT.failed);

  // ---------- список назначений ----------

  function statusOf(item) {
    const parts = [];
    const a = item.acceptance;
    if (!a) parts.push(['y', TXT.waiting]);
    else if (a.review_needed) parts.push(['y', TXT.review]);
    else parts.push(['g', TXT.accepted]);
    if (item.patient_dose && String(item.patient_dose.value) !== String(item.dose))
      parts.push(['y', fill(TXT.own_dose, { dose: `${num(item.patient_dose.value)} ${item.patient_dose.unit}` })]);
    if (a && a.product) parts.push(['n', fill(TXT.bought, { name: a.product.name })]);
    return parts;
  }

  function planCard(item) {
    const meta = [
      (item.times || []).join(', '),
      item.until ? fill(TXT.until, { date: dmy(item.until) }) : TXT.term_none,
    ]
      .filter(Boolean)
      .join(' · ');
    const badges = statusOf(item)
      .map(([k, text]) => `<span class="rx-badge ${k}">${esc(text)}</span>`)
      .join('');
    return `<article class="card rx-item" data-rx-item="${item.inn_id}">
      <h3>${esc(cap(item.inn_name))} ${esc(num(item.dose))} ${esc(item.unit || '')}</h3>
      <div class="sub">${esc(meta)}</div>
      <div class="rx-badges">${badges}</div>
      ${item.comment ? `<p class="small rx-comment">${esc(item.comment)}</p>` : ''}
      <div class="acts rx-acts"><button type="button" data-rx-edit="${item.inn_id}">${esc(TXT.edit)}</button><button type="button" data-rx-stop="${item.inn_id}">${esc(TXT.stop)}</button></div>
    </article>`;
  }

  async function renderPlan(box, root, hooks) {
    const plan = await loadPlan(box.dataset.patient);
    box.innerHTML = plan.items.map(planCard).join('');
    renderHistory(root, plan.versions);
    box.querySelectorAll('[data-rx-edit]').forEach((b) =>
      b.addEventListener('click', () => {
        const item = plan.items.find((i) => String(i.inn_id) === b.dataset.rxEdit);
        const flow = root.querySelector('#card-flow');
        if (!item || !flow) return;
        flow.dataset.visit = '';
        renderDraft(flow, hooks, {
          inn_id: item.inn_id,
          inn_name: item.inn_name,
          dose: item.dose,
          unit: item.unit,
          times: item.times,
          comment: item.comment || '',
          until: item.until,
          editing: true,
        });
        flow.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }),
    );
    box.querySelectorAll('[data-rx-stop]').forEach((b) =>
      b.addEventListener('click', () => {
        const item = plan.items.find((i) => String(i.inn_id) === b.dataset.rxStop);
        const card = b.closest('.rx-item');
        if (!item || !card) return;
        const acts = card.querySelector('.rx-acts');
        acts.innerHTML = `<span class="small">${esc(fill(TXT.stop_ask, { name: cap(item.inn_name) }))}</span> <button type="button" data-rx-stop-yes>${esc(TXT.stop_yes)}</button> <button type="button" data-rx-stop-no>${esc(TXT.stop_no)}</button>`;
        acts.querySelector('[data-rx-stop-no]').addEventListener('click', () => renderPlan(box, root, hooks));
        acts.querySelector('[data-rx-stop-yes]').addEventListener('click', async () => {
          const items = plan.items.filter((i) => i.inn_id !== item.inn_id).map(toPayload);
          items.push({ inn_id: item.inn_id, ended: true });
          const res = await publish(box.dataset.patient, items);
          const flow = root.querySelector('#card-flow');
          if (!res.ok) return hooks.error(flow, failText(res));
          flow.innerHTML = '';
          hooks.undo(flow, res.data, 'msg.undo.plan_sent');
          renderPlan(box, root, hooks);
        });
      }),
    );
  }

  // ---------- история версий плана ----------

  function renderHistory(root, versions) {
    const host = root.querySelector('[data-rx-history]');
    if (!host) return;
    const rows = (versions || []).filter((v) => v.version > 0 && v.status !== 'draft');
    const status = { published: TXT.st_published, superseded: TXT.st_superseded, cancelled: TXT.st_cancelled };
    host.innerHTML = rows.length
      ? `<details class="rx-history" data-testid="msg.card.rx.history"><summary>${esc(TXT.history)}</summary><ul>${rows
          .map(
            (v) =>
              `<li>${esc(fill(TXT.history_row, { n: v.version, date: dmy(v.published_at || v.visible_from), status: status[v.status] || v.status }))}</li>`,
          )
          .join('')}</ul></details>`
      : '';
  }

  // ---------- внесено пациентом (F-61/F-120) ----------

  function ownCard(m) {
    const seen = m.reviewed_version >= m.current_version;
    const dose = `${num(m.dose)} ${m.unit || ''}`.trim();
    const badge = seen
      ? ['g', TXT.own_seen]
      : m.reviewed_version
        ? ['y', TXT.own_changed]
        : ['y', TXT.own_new];
    return `<article class="card rx-item" data-rx-own="${m.id}" data-version="${m.current_version}">
      <h3>${esc(m.trade_name)} ${esc(dose)}</h3>
      <div class="sub">${esc(cap(m.inn_name))}${(m.times || []).length ? ` · ${esc(m.times.join(', '))}` : ''}</div>
      <div class="rx-badges"><span class="rx-badge ${badge[0]}">${esc(badge[1])}</span></div>
      ${m.comment ? `<p class="small rx-comment">${esc(fill(TXT.own_comment_label, { text: m.comment }))}</p>` : ''}
      <div class="acts rx-acts">${seen ? '' : `<button type="button" data-testid="msg.card.rx.own.confirm" data-rx-own-confirm>${esc(TXT.own_confirm)}</button>`}<button type="button" class="ghost" data-testid="msg.card.rx.own.comment" data-rx-own-comment>${esc(TXT.own_comment)}</button></div>
      <div class="rx-own-form" data-rx-own-form hidden>
        <textarea rows="2" maxlength="300" data-rx-own-text placeholder="${esc(TXT.own_comment_ph)}">${esc(m.comment || '')}</textarea>
        <div class="acts"><button type="button" class="primary" data-rx-own-send>${esc(TXT.own_send)}</button><button type="button" class="ghost" data-rx-own-cancel>${esc(TXT.cancel)}</button></div>
      </div>
      <p class="small rx-error" data-rx-own-error role="alert" hidden></p>
    </article>`;
  }

  async function renderOwn(box) {
    const patient = box.dataset.patient;
    const res = await api(`/api/v1/patients/${patient}?tab=treatment`);
    const meds = (res.ok && res.data.patient_meds) || [];
    box.innerHTML = meds.length
      ? `<p class="sec-label">${esc(TXT.own_title)}</p>${meds.map(ownCard).join('')}`
      : '';
    box.querySelectorAll('[data-rx-own]').forEach((card) => {
      const id = card.dataset.rxOwn;
      const form = card.querySelector('[data-rx-own-form]');
      const fail = (text) => {
        const e = card.querySelector('[data-rx-own-error]');
        e.textContent = text;
        e.hidden = !text;
      };
      const settle = async (r) => {
        if (r.ok) return renderOwn(box);
        if (r.status === 409) {
          await renderOwn(box);
          const again = box.querySelector(`[data-rx-own="${id}"] [data-rx-own-error]`);
          if (again) {
            again.textContent = TXT.own_conflict;
            again.hidden = false;
          }
          return;
        }
        fail(TXT.failed);
      };
      const confirm = card.querySelector('[data-rx-own-confirm]');
      if (confirm)
        confirm.addEventListener('click', async () =>
          settle(await api(`/api/v1/patient-meds/${id}/confirm`, 'POST', { version: Number(card.dataset.version) })),
        );
      card.querySelector('[data-rx-own-comment]').addEventListener('click', () => {
        form.hidden = !form.hidden;
        if (!form.hidden) form.querySelector('textarea').focus();
      });
      card.querySelector('[data-rx-own-cancel]').addEventListener('click', () => {
        form.hidden = true;
      });
      card.querySelector('[data-rx-own-send]').addEventListener('click', async () =>
        settle(
          await api(`/api/v1/patient-meds/${id}/comments`, 'POST', {
            text: form.querySelector('textarea').value.trim(),
          }),
        ),
      );
    });
  }

  // ---------- черновик назначения ----------

  function untilFrom(n, unit) {
    const days = Number(n) * (DURATION.find((d) => d[0] === unit) || DURATION[1])[1];
    if (!(days > 0)) return null;
    const d = new Date();
    d.setDate(d.getDate() + days);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function renderDraft(flow, hooks, init) {
    const d = {
      inn_id: null,
      inn_name: '',
      dose: '',
      unit: 'мг',
      times: [],
      durN: '',
      durUnit: 'недель',
      comment: '',
      ...init,
    };
    const until = init.until ? init.until : '';
    flow.innerHTML = `<section class="card rx-draft" data-rx-draft>
      <p class="sec-label" data-testid="msg.card.draft.title">${esc(init.editing ? TXT.editing : TXT.draft)}</p>
      ${init.hint ? `<p class="small muted" data-rx-hint>${esc(init.hint)}</p>` : ''}
      <label class="rx-label">${esc(TXT.drug)}
        <span class="rx-field"><input type="text" data-testid="msg.card.draft.inn" data-rx-inn maxlength="80" placeholder="${esc(TXT.drug_ph)}" value="${esc(cap(d.inn_name))}"></span>
      </label>
      <p class="small rx-match" data-rx-match aria-live="polite"></p>
      <div class="rx-row">
        <label class="rx-label rx-dose">${esc(TXT.dose)}<input type="number" step="any" min="0" inputmode="decimal" data-testid="msg.card.draft.dose" data-rx-dose value="${esc(d.dose)}"></label>
        <label class="rx-label rx-unit">${esc(TXT.unit)}<select data-rx-unit>${UNITS.map((u) => `<option${u === d.unit ? ' selected' : ''}>${u}</option>`).join('')}</select></label>
      </div>
      <div class="rx-label">${esc(TXT.when)}
        <div class="rx-chips" role="group" aria-label="${esc(TXT.when)}">${TIMES.map((x) => `<button type="button" class="rx-chip${d.times.includes(x) ? ' on' : ''}" data-rx-time="${x}" aria-pressed="${d.times.includes(x)}">${x}</button>`).join('')}</div>
      </div>
      <div class="rx-label">${esc(TXT.term)}
        <div class="rx-row rx-term">
          <input type="number" min="1" step="1" inputmode="numeric" data-rx-dur placeholder="${esc(TXT.term_none)}" aria-label="${esc(TXT.term)}" value="${esc(d.durN)}">
          <select data-rx-dur-unit aria-label="${esc(TXT.term)}">${DURATION.map(([n]) => `<option${n === d.durUnit ? ' selected' : ''}>${n}</option>`).join('')}</select>
          ${until && !d.durN ? `<span class="small muted" data-rx-until-note>${esc(fill(TXT.until, { date: dmy(until) }))}</span>` : ''}
        </div>
      </div>
      <label class="rx-label">${esc(TXT.comment)}<textarea data-rx-comment rows="2" maxlength="1000" placeholder="${esc(TXT.comment_ph)}">${esc(d.comment)}</textarea></label>
      <p class="small muted" data-testid="msg.card.draft.inn_only">${esc(TXT.inn_only)}</p>
      <p class="small rx-error" data-rx-error role="alert" hidden></p>
      <div class="acts"><button type="button" class="primary" data-testid="msg.card.draft.send">${esc(init.editing ? TXT.save : TXT.send)}</button><button type="button" class="ghost" data-rx-cancel>${esc(TXT.cancel)}</button></div>
    </section>`;
    const el = (s) => flow.querySelector(s);
    const innInput = el('[data-rx-inn]');
    const match = el('[data-rx-match]');
    flow._rx = { inn_id: d.inn_id, keepUntil: until && !d.durN ? until : '' };

    const showMatch = () => {
      const plan = current && current.items.find((i) => i.inn_id === flow._rx.inn_id);
      if (!flow._rx.inn_id) {
        const typed = innInput.value.trim();
        match.textContent = typed.length >= 2 ? TXT.not_found : '';
        match.className = 'small rx-match warn';
        if (typed.length >= 2) {
          const add = document.createElement('button');
          add.type = 'button';
          add.className = 'ghost';
          add.dataset.rxAdd = '';
          add.textContent = fill(TXT.add, { name: typed });
          add.addEventListener('click', () => addToCatalog(typed));
          match.append(' ', add);
        }
      } else {
        match.className = 'small rx-match ok';
        match.textContent =
          TXT.in_catalog +
          (plan && !init.editing
            ? ` · ${fill(TXT.replaces, { dose: `${num(plan.dose)} ${plan.unit || ''}`.trim() })}`
            : '');
      }
    };
    const addToCatalog = async (typed) => {
      const res = await api('/work/api/drugs/custom', 'POST', { name: typed });
      if (!res.ok) return;
      choose({ inn_id: res.data.id, inn_name: res.data.name });
      if (res.data.created) match.textContent += ` ${TXT.added_ok}`;
    };
    const choose = (item) => {
      if (item.add) return addToCatalog(item.add);
      flow._rx.inn_id = item.inn_id;
      innInput.value = cap(item.inn_name);
      showMatch();
    };
    const sug = attachSuggest(innInput, { getQuery: () => innInput.value, onPick: choose, canAdd: true });
    innInput.addEventListener('input', () => {
      flow._rx.inn_id = null;
      showMatch();
    });
    flow.querySelectorAll('[data-rx-time]').forEach((b) =>
      b.addEventListener('click', () => {
        const on = !b.classList.contains('on');
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      }),
    );
    el('[data-rx-cancel]').addEventListener('click', () => {
      flow.innerHTML = '';
      flow._rx = null;
    });
    showMatch();
    // Название из фразы: точное совпадение подставляем сразу, иначе открываем подсказки.
    if (!d.inn_id && d.inn_name) {
      searchDrugs(d.inn_name).then((found) => {
        if (flow._rx && !flow._rx.inn_id && found.length && found[0].score < 0) choose(found[0]);
        else if (found.length) sug.refresh();
        else showMatch();
      });
    }
  }

  /** Черновик из фразы: разбор на сервере (правила + модель order_parse), клиент только рисует форму. */
  async function openDraft(flow, hooks, phrase) {
    const patient = flow.closest('#v2-card').dataset.patientId;
    const text = String(phrase || '').trim();
    const mine = (flow._rxSeq = (flow._rxSeq || 0) + 1);
    if (!current) loadPlan(patient);
    if (!text) return renderDraft(flow, hooks, {});
    flow.innerHTML = `<p class="small muted" aria-live="polite">${esc(TXT.parsing)}</p>`;
    const res = await api(`/api/v1/patients/${patient}/parse`, 'POST', { target: 'plan_item', phrase: text });
    if (mine !== flow._rxSeq) return;
    if (res.status === 403) {
      flow.innerHTML = `<p class="small rx-error" role="alert">${esc(TXT.parse_denied)}</p>`;
      return;
    }
    if (!res.ok) {
      // Разбор недоступен: форма открывается с введённым названием, остальное врач заполняет сам.
      return renderDraft(flow, hooks, { inn_name: parsePhrase(text).name, hint: TXT.parse_failed });
    }
    const d = res.data.draft || {};
    const missing = (res.data.missing || []).map((k) => TXT[`missing_${k}`]).filter(Boolean);
    renderDraft(flow, hooks, {
      inn_id: d.inn_id || null,
      inn_name: d.inn_name || (d.inn_id ? '' : parsePhrase(text).name),
      dose: d.dose ?? '',
      unit: d.unit || 'мг',
      times: d.times || [],
      until: d.until || '',
      hint: missing.length ? fill(TXT.parse_missing, { fields: missing.join(', ') }) : '',
    });
  }

  async function send(flow, hooks) {
    const root = flow.closest('#v2-card');
    const patient = root.dataset.patientId;
    const box = flow.querySelector('[data-rx-draft]');
    if (!box || !flow._rx) return;
    const field = (s) => box.querySelector(s);
    const error = (text) => {
      const e = field('[data-rx-error]');
      e.textContent = text;
      e.hidden = !text;
    };
    const dose = Number(field('[data-rx-dose]').value);
    const times = [...box.querySelectorAll('[data-rx-time].on')].map((b) => b.dataset.rxTime);
    if (!flow._rx.inn_id) {
      // Название напечатано, но подсказка не выбрана: берём точное совпадение, иначе просим выбрать.
      const typed = await searchDrugs(field('[data-rx-inn]').value);
      if (typed.length && typed[0].score < 0) flow._rx.inn_id = typed[0].inn_id;
    }
    if (!flow._rx.inn_id) return error(TXT.pick_drug);
    if (!(dose > 0)) return error(TXT.need_dose);
    if (!times.length) return error(TXT.need_when);
    error('');
    const durN = field('[data-rx-dur]').value;
    const item = {
      inn_id: flow._rx.inn_id,
      dose,
      unit: field('[data-rx-unit]').value,
      times,
      until: durN ? untilFrom(durN, field('[data-rx-dur-unit]').value) || undefined : flow._rx.keepUntil || undefined,
      comment: field('[data-rx-comment]').value.trim() || undefined,
    };
    const plan = await loadPlan(patient);
    const items = plan.items.filter((i) => i.inn_id !== item.inn_id).map(toPayload);
    items.push(item);
    const res = await publish(patient, items);
    if (!res.ok) return error(failText(res));
    flow.innerHTML = '';
    flow._rx = null;
    hooks.undo(flow, res.data, 'msg.undo.plan_sent');
    const list = root.querySelector('[data-rx-plan]');
    if (list) renderPlan(list, root, hooks);
  }

  /** Список назначений над полем ввода. hooks: { undo(flow, data, key), error(flow, text) } — из v2.js. */
  function mount(root, hooks) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `<section data-rx-plan data-patient="${esc(root.dataset.patientId)}"></section><section data-rx-own-list data-patient="${esc(root.dataset.patientId)}"></section><div data-rx-history></div>`;
    root.prepend(wrap);
    const box = wrap.querySelector('[data-rx-plan]');
    const own = wrap.querySelector('[data-rx-own-list]');
    const refresh = () => Promise.all([renderPlan(box, root, hooks), renderOwn(own)]);
    refresh();
    root.addEventListener('v3-refresh', refresh);
  }

  /** Подсказки в строке «сертралин 75 мг утром…»: ищем по тексту до первой цифры. */
  function attachPhrase(textarea) {
    const host = textarea.parentElement;
    host.classList.add('rx-field');
    attachSuggest(textarea, {
      getQuery: () => parsePhrase(textarea.value).name,
      onPick: (item) => {
        const m = /\d/.exec(textarea.value);
        const tail = m ? textarea.value.slice(m.index) : '';
        textarea.value = `${item.inn_name} ${tail}`.trimEnd() + (tail ? '' : ' ');
        textarea.focus();
      },
    });
  }

  window.CCRx = { mount, openDraft, send, attachPhrase, parsePhrase };
})();
