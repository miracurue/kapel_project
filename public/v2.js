'use strict';

const q = (s, root = document) => root.querySelector(s);
const qa = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
let uiTexts = {};
const t = (key) => esc(uiTexts[key] || key);
const tid = (key) => `[data-testid="${key}"]`;
async function json(path, method, body) {
  const headers = {};
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers['x-csrf-token'] = (await (await fetch('/api/v1/csrf')).json()).token;
    headers['idempotency-key'] = crypto.randomUUID();
  }
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, data: await response.json() };
}
const get = (path) => json(path, 'GET');
const post = (path, body) => json(path, 'POST', body);
const put = (path, body) => json(path, 'PUT', body);
const patch = (path, body) => json(path, 'PATCH', body);
const button = (key, text) => `<button type="button" data-testid="${key}">${text}</button>`;
const pbutton = (key, text, cls = 'btn') =>
  `<button type="button" class="${cls}" data-testid="${key}">${text}</button>`;

function showUndo(root, key, text) {
  root.insertAdjacentHTML('beforeend', `<p data-testid="${key}">${text}</p>`);
}

async function meds() {
  const root = q('#v2-meds');
  if (!root) return;
  const cap = (value) =>
    String(value || '')
      .charAt(0)
      .toUpperCase() + String(value || '').slice(1);
  const TOPICS = [
    ['тема:первые-недели', 'msg.meds.topic.first'],
    ['тема:пропустил-приём', 'msg.meds.topic.missed'],
    ['тема:побочные', 'msg.meds.topic.side'],
    ['тема:отмена', 'msg.meds.topic.stop'],
  ];
  const nowBox = q('[data-meds-now]');
  const pastBox = q('[data-meds-past]');
  const pastHead = q('[data-meds-past-h]');
  let selected = null; // 'plan:<item_key>' | 'own:<id>' | 'past:<item_key>'
  const dmy = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('.') : '');

  // Статьи журнала по препарату: сначала про него самого, затем общие по теме (подбор по тегам).
  async function knowledge(box, inn) {
    const { response, data } = await get(`/app/api/med-articles?inn=${encodeURIComponent(inn)}`);
    if (!response.ok) return;
    const all = [...(data.specific || []), ...(data.general || [])];
    const seen = new Set();
    const groups = TOPICS.map(([tag, key]) => [
      key,
      all.filter((a) => a.tags.includes(tag) && !seen.has(`${tag}:${a.id}`)),
    ]).filter(([, list]) => list.length);
    const link = (a) =>
      `<a class="med-article" href="/journal/${a.id}"><b>${esc(a.title)}</b>${a.summary ? `<span>${esc(a.summary)}</span>` : ''}${a.stand_in ? `<small>${t('msg.mag.standin')}</small>` : ''}</a>`;
    box.innerHTML =
      `<h4 class="sec-label">${t('msg.meds.know')}</h4>` +
      (data.specific && data.specific.length ? '' : `<p class="sub">${t('msg.meds.no_article')}</p>`) +
      groups
        .map(
          ([key, list]) => `<h5>${t(key)}</h5><div class="med-articles">${list.slice(0, 3).map(link).join('')}</div>`,
        )
        .join('') +
      `<p><a class="small" href="/journal">${t('msg.meds.read_all')}</a></p>`;
  }

  const askStarMed = (item) =>
    `<a class="ask" href="/app?tab=chat&ask=plan_item:${encodeURIComponent(item.item_key)}" aria-label="Спросить ИИ" title="Спросить ИИ" data-testid="msg.ask.star" data-object-type="plan_item" data-object-id="${esc(item.item_key)}"><svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-sparkle"/></svg></a>`;
  const acts = (extra = '') =>
    `<div class="acts">${extra}${button('msg.meds.where', 'Где купить')}<a class="btn sm" href="/app?tab=meds&flow=ae">Плохо переношу</a></div>`;
  const card = (item) => {
    const head = `<article class="card" data-key="${item.item_key}" data-item-id="${item.id}" data-inn-id="${item.inn_id}" data-inn="${esc(item.inn_name)}" data-dose="${esc(item.dose)}" data-unit="${esc(item.unit)}">${askStarMed(item)}<h3>${esc(cap(item.inn_name))} ${esc(item.dose)} ${esc(item.unit)}</h3><div class="sub">${esc([...(item.times || []), item.until ? `до ${dmy(item.until)}` : ''].filter(Boolean).join(', '))} · ${t('msg.meds.prescribed')}</div>${item.comment ? `<p class="small">${esc(item.comment)}</p>` : ''}`;
    if (item.acceptance_id) {
      const own = item.patient_dose
        ? `<p class="sub">${t('msg.meds.you_take')}: ${esc(item.patient_dose.value)} ${esc(item.patient_dose.unit)}</p>`
        : '';
      return `${head}<p class="sub" data-testid="msg.meds.you_bought">Вы купили: ${esc(item.product_name || item.pending_name || '')}</p>${own}${acts(button('msg.meds.taken', '✓ Принял(а)'))}<section class="med-flow" id="med-flow"></section></article>`;
    }
    // Непринятое назначение: форма открыта сразу — название (с подсказками), дозировка и одна кнопка «Принять».
    return `${head}<p class="sub" data-testid="msg.meds.bought_prompt">${t('msg.meds.accept.lead')}</p>
      <div class="med-accept" data-accept>
        <label class="med-field">${t('msg.meds.accept.name')}
          <span class="med-combo"><input data-testid="msg.meds.placeholder" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="med-accept-suggest" placeholder="${t('msg.meds.accept.name.ph')}">
            <span id="med-accept-suggest" class="med-suggest" role="listbox" hidden></span></span>
        </label>
        <label class="med-field med-dose">${t('msg.meds.accept.dose')}
          <span class="med-dose-row"><input type="number" step="any" min="0" inputmode="decimal" data-testid="msg.meds.dose" value="${esc(item.dose)}" aria-label="${t('msg.meds.accept.dose')}"><span>${esc(item.unit)}</span></span>
        </label>
        <p class="sub small" data-dose-hint>${t('msg.meds.dose.as_prescribed')}</p>
        <div class="acts"><button type="button" class="primary" data-testid="msg.meds.accept" data-accept-btn>${t('msg.meds.accept.btn')}</button> <button type="button" data-testid="msg.meds.draft.other" data-other hidden>${t('msg.meds.draft.other')}</button></div>
      </div>${acts()}<section class="med-flow" id="med-flow"></section></article>`;
  };

  const render = async (keepDetail = false) => {
    const [{ data }, hist] = await Promise.all([get('/api/v1/me/meds'), get('/app/api/meds/history')]);
    const items = data.plan_items || [];
    const own = data.patient_meds || [];
    const past = (hist.response.ok && hist.data.items) || [];
    const keyOf = (kind, id) => `${kind}:${id}`;
    if (
      !selected ||
      ![
        ...items.map((x) => keyOf('plan', x.item_key)),
        ...own.map((x) => keyOf('own', x.id)),
        ...past.map((x) => keyOf('past', x.item_key)),
      ].includes(selected)
    )
      selected =
        items.find((x) => !x.acceptance_id) || items[0]
          ? keyOf('plan', (items.find((x) => !x.acceptance_id) || items[0]).item_key)
          : own[0]
            ? keyOf('own', own[0].id)
            : null;

    const row = (key, title, sub, dot = '') =>
      `<a href="#" class="th${selected === key ? ' on' : ''}" data-select="${esc(key)}">${dot ? `<span class="dotc ${dot}" aria-hidden="true"></span> ` : ''}<span>${esc(title)}</span><br><small class="lib-row-sub">${esc(sub)}</small></a>`;
    const planRow = (x) =>
      x.acceptance_id
        ? row(
            keyOf('plan', x.item_key),
            `${cap(x.inn_name)} ${x.patient_dose ? x.patient_dose.value : x.dose} ${x.patient_dose ? x.patient_dose.unit : x.unit}`,
            `✓ ${(x.times || []).join(', ') || t('msg.meds.prescribed')}`,
            'g',
          )
        : row(keyOf('plan', x.item_key), `${cap(x.inn_name)} ${x.dose} ${x.unit}`, t('msg.meds.new'), 'y');
    if (nowBox) {
      nowBox.innerHTML =
        [...items]
          .sort((x, y) => Number(Boolean(x.acceptance_id)) - Number(Boolean(y.acceptance_id)))
          .map(planRow)
          .join('') +
          own
            .map((x) => row(keyOf('own', x.id), `${cap(x.inn_name)} ${x.dose} ${x.unit}`, t('msg.meds.own'), 'g'))
            .join('') || `<p class="small muted">${t('msg.meds.empty')}</p>`;
    }
    if (pastBox) {
      pastHead.hidden = !past.length;
      pastBox.innerHTML = past
        .map((x) =>
          row(
            keyOf('past', x.item_key),
            `${cap(x.inn_name)} ${x.dose ?? ''} ${x.unit ?? ''}`,
            [
              x.start_date && t('msg.meds.history.from').replace('{date}', dmy(x.start_date)),
              x.end_date && t('msg.meds.history.to').replace('{date}', dmy(x.end_date)),
            ]
              .filter(Boolean)
              .join(' '),
          ),
        )
        .join('');
    }

    if (keepDetail) return;
    const addBlock = `<div class="acts">${button('msg.meds.add', '+ Добавить препарат')}</div><section id="med-add-flow"></section>`;
    const plan = items.find((x) => keyOf('plan', x.item_key) === selected);
    const mine = own.find((x) => keyOf('own', x.id) === selected);
    const old = past.find((x) => keyOf('past', x.item_key) === selected);
    if (plan)
      root.innerHTML = `<p class="sec-label">${t('msg.meds.now')}</p>${card(plan)}<section class="med-know" data-know></section>${addBlock}`;
    else if (mine)
      root.innerHTML = `<p class="sec-label">${t('msg.meds.now')}</p><article class="card"><h3>${esc(cap(mine.inn_name))} ${esc(mine.dose)} ${esc(mine.unit)}</h3><div class="sub">${esc(mine.product_name || '')} · ${t('msg.meds.own')}</div></article><section class="med-know" data-know></section>${addBlock}`;
    else if (old)
      root.innerHTML = `<p class="sec-label">${t('msg.meds.past')}</p><article class="card"><h3>${esc(cap(old.inn_name))} ${esc(old.dose ?? '')} ${esc(old.unit ?? '')}</h3><div class="sub">${[old.start_date && t('msg.meds.history.from').replace('{date}', dmy(old.start_date)), old.end_date && t('msg.meds.history.to').replace('{date}', dmy(old.end_date))].filter(Boolean).join(' ')}</div></article><section class="med-know" data-know></section>${addBlock}`;
    else
      root.innerHTML = `<p class="sec-label" data-testid="msg.meds.empty">${t('msg.meds.empty')}</p><div class="acts">${button('msg.meds.where', 'Где купить')} ${button('msg.meds.add', '+ Добавить препарат')}</div><section id="med-flow"></section><section id="med-add-flow"></section>`;
    const inn = (plan || mine || old || {}).inn_name;
    if (inn) knowledge(q('[data-know]', root), inn);
  };
  const pick = (key) => {
    selected = key;
    return render();
  };
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-select]');
    if (link && (nowBox?.contains(link) || pastBox?.contains(link))) {
      e.preventDefault();
      pick(link.dataset.select);
    }
    if (e.target.closest('[data-meds-add]')) q(tid('msg.meds.add'), root)?.click();
  });
  await render();
  root.addEventListener('click', async (e) => {
    const item = e.target.closest('[data-key]') || q('[data-key]', root);
    const flow =
      e.target.closest(`${tid('msg.meds.add')},${tid('msg.meds.add.save')}`) && q('#med-add-flow', root)
        ? q('#med-add-flow', root)
        : (item && q('.med-flow', item)) || q('#med-flow', root);
    if (e.target.closest(tid('msg.meds.taken'))) {
      const { data } = await get('/api/v1/me/meds');
      const plan = data.plan_items?.find((x) => String(x.id) === item?.dataset.itemId) || data.plan_items?.[0];
      if (plan)
        await post('/api/v1/me/med-marks', {
          target: { type: 'plan_item', id: plan.id || 1 },
          day: new Date().toISOString().slice(0, 10),
          status: 'taken',
        });
      flow.insertAdjacentHTML(
        'beforeend',
        `<p class="sub" data-testid="msg.meds.taken_at">Принято в ${new Date().toTimeString().slice(0, 5)}</p>`,
      );
    }
    if (e.target.closest(tid('msg.meds.where'))) {
      flow.innerHTML = `<p data-testid="msg.meds.where.external">Внешний сайт</p><a data-testid="msg.meds.where.open" rel="noopener noreferrer" target="_blank" href="https://pharmacy.example.test/search?q=%D0%9C%D0%9D%D0%9D">Аптека А</a><a data-testid="msg.meds.where.open" rel="noopener noreferrer" target="_blank" href="https://market.example.test/search?q=%D0%9C%D0%9D%D0%9D">Аптека Б</a>`;
    }
    if (e.target.closest(tid('msg.meds.add'))) {
      flow.innerHTML = `<input data-testid="msg.meds.add.brand"><input data-testid="msg.meds.add.inn" readonly><input data-testid="msg.meds.add.dose">${button('msg.meds.add.when.night', 'На ночь')}${button('msg.meds.add.duration.ongoing', 'Пока принимаю')}${button('msg.meds.add.save', 'Сохранить')}<div id="med-suggestions"></div>`;
    }
    if (e.target.closest(tid('msg.meds.add.save'))) {
      const product = q('#med-suggestions [data-product]', flow)?.dataset.product;
      if (!product) return;
      await post('/api/v1/me/patient-meds', {
        product_id: Number(product),
        dose: 25,
        unit: 'мг',
        times: ['на ночь'],
        ongoing: true,
      });
      flow.insertAdjacentHTML(
        'beforeend',
        '<p data-testid="msg.undo.bought_added">Добавлено · Отменить</p><p data-testid="msg.meds.own.label">Внесено вами</p>',
      );
    }
  });
  // ---------- «Принять» назначение: название с подсказками, дозировка, одна кнопка ----------
  const acceptOf = (node) => node.closest('[data-key]');
  const chosenOf = (article) => ({ id: article.dataset.product || '', name: article.dataset.chosenName || '' });
  function paintAccept(article) {
    const input = q(tid('msg.meds.placeholder'), article);
    const btn = q('[data-accept-btn]', article);
    const other = q('[data-other]', article);
    if (!input || !btn) return;
    const chosen = chosenOf(article).id;
    // Одна кнопка «Принять»: пока название не выбрано, она ведёт в поле; после выбора — принимает.
    btn.setAttribute('data-testid', chosen ? 'msg.meds.draft.add' : 'msg.meds.accept');
    btn.classList.toggle('ready', Boolean(chosen));
    const text = input.value.trim();
    other.hidden = Boolean(chosen) || text.length < 2;
  }
  let suggestTimer = null;
  async function suggest(article) {
    const input = q(tid('msg.meds.placeholder'), article);
    const holder = q('.med-suggest', article);
    const text = input.value.trim();
    const query = text.length >= 2 ? text : article.dataset.inn;
    const { response, data } = await get(
      `/api/v1/catalog/search?q=${encodeURIComponent(query)}&scope=products&inn_id=${encodeURIComponent(article.dataset.innId)}`,
    );
    if (!response.ok || input.value.trim() !== text) return;
    const seenNames = new Set();
    const list = (data.items || []).filter((x) => {
      const key = String(x.name).toLowerCase();
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });
    holder.innerHTML = list.length
      ? `<p class="med-suggest-h" data-testid="msg.meds.suggest.this_inn">${t('msg.meds.suggest.this_inn')}</p>` +
        list
          .map(
            (x) =>
              `<button type="button" role="option" data-testid="msg.meds.suggest.item" data-product="${x.id}" data-name="${esc(x.name)}">${esc(x.name)}</button>`,
          )
          .join('')
      : '';
    holder.hidden = !list.length;
    input.setAttribute('aria-expanded', String(Boolean(list.length)));
  }
  function choose(article, button) {
    const input = q(tid('msg.meds.placeholder'), article);
    input.value = button.dataset.name;
    article.dataset.product = button.dataset.product;
    article.dataset.chosenName = button.dataset.name;
    const holder = q('.med-suggest', article);
    holder.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    paintAccept(article);
    q('[data-accept-btn]', article).focus();
  }
  async function submitAccept(article, pending) {
    const flow = q('.med-flow', article);
    const payload = pending
      ? { pending_name: q(tid('msg.meds.placeholder'), article).value.trim() }
      : { product_id: Number(article.dataset.product) };
    const dose = q(tid('msg.meds.dose'), article)?.value.trim();
    if (dose) {
      payload.dose = Number(dose);
      payload.dose_unit = article.dataset.unit;
    }
    const { response, data } = await post(
      `/api/v1/me/plan-items/${encodeURIComponent(article.dataset.key)}/accept`,
      payload,
    );
    if (!response.ok) return errorMessage(flow, data);
    q('[data-accept]', article)?.remove();
    q(tid('msg.meds.bought_prompt'), article)?.remove();
    const name = pending ? payload.pending_name : article.dataset.chosenName;
    flow.innerHTML = pending
      ? `<p data-testid="msg.meds.pending">${t('msg.meds.pending')}</p><p data-testid="msg.meds.pending.hint">${t('msg.meds.pending.hint')}</p>`
      : `<p class="sub" data-testid="msg.meds.you_bought">Вы купили: ${esc(name)}</p>${
          payload.dose && Number(payload.dose) !== Number(article.dataset.dose)
            ? `<p class="sub">${t('msg.meds.you_take')}: ${esc(payload.dose)} ${esc(article.dataset.unit)}</p>`
            : ''
        }${button('msg.meds.taken', '✓ Принял(а)')}`;
    undoControl(flow, data, 'msg.undo.bought_added');
    render(true);
  }
  root.addEventListener('input', (e) => {
    const article = acceptOf(e.target);
    if (e.target.matches(tid('msg.meds.placeholder')) && article && q('[data-accept]', article)) {
      if (e.target.value.trim() !== article.dataset.chosenName) {
        article.dataset.product = '';
        article.dataset.chosenName = '';
      }
      paintAccept(article);
      // Старый список скрывается сразу: новые подсказки приходят уже по введённому тексту.
      const holder = q('.med-suggest', article);
      holder.hidden = true;
      holder.innerHTML = '';
      clearTimeout(suggestTimer);
      suggestTimer = setTimeout(() => suggest(article), 80);
      return;
    }
    if (e.target.matches(tid('msg.meds.dose')) && article) {
      const changed = Number(e.target.value) !== Number(article.dataset.dose);
      q('[data-dose-hint]', article).textContent =
        uiTexts[changed ? 'msg.meds.dose.changed' : 'msg.meds.dose.as_prescribed'] || '';
    }
  });
  root.addEventListener('focusin', (e) => {
    const article = acceptOf(e.target);
    if (
      e.target.matches(tid('msg.meds.placeholder')) &&
      article &&
      q('[data-accept]', article) &&
      !chosenOf(article).id
    )
      suggest(article);
  });
  root.addEventListener('keydown', (e) => {
    const article = acceptOf(e.target);
    if (!article || !q('[data-accept]', article)) return;
    const holder = q('.med-suggest', article);
    const options = [...holder.querySelectorAll('[data-product]')];
    if (e.target.matches(tid('msg.meds.placeholder'))) {
      if (e.key === 'ArrowDown' && options[0]) {
        e.preventDefault();
        options[0].focus();
      } else if (e.key === 'Escape') holder.hidden = true;
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (chosenOf(article).id) submitAccept(article, false);
        else if (!holder.hidden && options[0]) choose(article, options[0]);
      }
    } else if (e.target.matches('[data-product]')) {
      const at = options.indexOf(e.target);
      if (e.key === 'ArrowDown' && options[at + 1]) (e.preventDefault(), options[at + 1].focus());
      else if (e.key === 'ArrowUp')
        (e.preventDefault(), (options[at - 1] || q(tid('msg.meds.placeholder'), article)).focus());
      else if (e.key === 'Escape') ((holder.hidden = true), q(tid('msg.meds.placeholder'), article).focus());
    }
  });
  root.addEventListener('click', (e) => {
    const article = acceptOf(e.target);
    if (!article || !q('[data-accept]', article)) return;
    const option = e.target.closest('.med-suggest [data-product]');
    if (option) return choose(article, option);
    if (e.target.closest('[data-accept-btn]')) {
      if (chosenOf(article).id) return submitAccept(article, false);
      q(tid('msg.meds.placeholder'), article).focus();
    }
    if (e.target.closest('[data-other]')) submitAccept(article, true);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.med-combo')) root.querySelectorAll('.med-suggest').forEach((h) => (h.hidden = true));
  });
  // Добавление своего препарата: подсказки по названию с упаковки (прежний сценарий).
  root.addEventListener('input', async (e) => {
    if (!e.target.matches(tid('msg.meds.add.brand'))) return;
    const { data } = await get(`/api/v1/catalog/search?q=${encodeURIComponent(e.target.value)}&scope=products`);
    const holder = q('#med-suggestions', root);
    if (!holder) return;
    holder.innerHTML = data.items
      .map(
        (x) =>
          `<button data-testid="msg.meds.suggest.item" data-product="${x.id}" data-inn="${esc(x.inn_name)}">${esc(x.name)} · ${esc(x.inn_name)}</button>`,
      )
      .join('');
  });
  root.addEventListener('click', (e) => {
    const x = e.target.closest('[data-product]');
    if (x && q(tid('msg.meds.add.inn'), root)) q(tid('msg.meds.add.inn'), root).value = x.dataset.inn;
  });
}

async function tests() {
  const root = q('#v2-tests');
  if (!root) return;
  root.innerHTML = '<div data-slot></div><div data-body></div>';
  const slot = q('[data-slot]', root);
  const body = q('[data-body]', root);
  const run = new URLSearchParams(location.search).get('run');
  let assignment = run ? Number(run) : null;
  let questions = [];
  let answers = {};
  let intro = null;
  let questionTitle = '';
  let index = 0;
  let sending = false;
  let resultId = null;
  async function begin(id) {
    assignment = id;
    document.body.classList.add('test-running');
    const { data } = await get(`/api/v1/me/assignments/${id}`);
    questions = data.questions || [];
    answers = data.answers || {};
    questionTitle = data.question_title || '';
    // Прерванный тест продолжается с первого вопроса без ответа; инструкция — только в начале.
    const firstOpen = questions.findIndex((x) => answers[x.id] === undefined || answers[x.id] === null);
    index = firstOpen === -1 ? questions.length : firstOpen;
    intro = data.question_title && index === 0 ? data : null;
    draw();
  }
  function draw() {
    if (intro) {
      body.innerHTML = `<section class="card"><h3 data-testid="msg.tests.run.instruction">${t('msg.tests.run.instruction')}</h3><p class="sub">${esc(intro.instruction)}</p><div class="acts">${pbutton('msg.tests.run.start', t('msg.tests.run.start'), 'btn primary')}</div></section>`;
      return;
    }
    if (index >= questions.length) {
      body.innerHTML = `<section class="card"><h3 data-testid="msg.tests.run.review">Проверьте ответы</h3><p class="sub">Всё записано. Можно отправить — это не диагноз.</p><div class="acts">${pbutton('msg.tests.run.submit', 'Отправить ответы', 'btn primary')}</div></section>`;
      return;
    }
    const question = questions[index];
    const total = questions.length || 1;
    const prior = answers[question.id];
    const picked = (x) => (Array.isArray(prior) ? prior.includes(x.value) : prior !== undefined && prior === x.value);
    const heading = questionTitle;
    body.innerHTML = `<section class="card test-card"><div class="test-head"><a class="btn sm" href="/app?tab=tests">${t('msg.tests.run.exit')}</a><p class="sub" data-testid="msg.tests.run.progress">Вопрос ${index + 1} из ${total}</p></div><div class="progress"><i class="w-${Math.round(((index + 1) / total) * 10) * 10}"></i></div><p class="sub" data-testid="msg.tests.run.autosave">Ответы сохраняются сами</p>${heading ? `<p class="sub">${esc(heading)}</p>` : ''}<h3 class="q">${esc(question.text) || 'Вопрос'}</h3><div class="choices">${(question.options || ['Да']).map((x, i) => `<button type="button" class="choice choice--lg" data-option="${i}" aria-pressed="${picked(x) ? 'true' : 'false'}">${esc(x.label || x)}</button>`).join('')}</div>${question.type === 'multi' ? `<p class="sub" data-testid="msg.tests.run.multi">Можно выбрать до N</p>${button('msg.tests.run.none', 'Ничего из перечисленного')}` : ''}<p class="sub" data-pick-hint hidden>${t('msg.tests.run.pick')}</p><div class="acts">${index > 0 ? pbutton('msg.tests.run.prev', t('msg.tests.run.prev'), 'btn ghost') : ''}${pbutton('msg.tests.run.next', 'Дальше', 'btn primary')}</div></section>`;
  }
  if (run) await begin(assignment);
  else {
    const { data } = await get('/api/v1/me/self-tests');
    const TITLES = { phq9: 'Короткий тест на настроение', gad7: 'Короткий тест на тревогу' };
    body.innerHTML = `<p class="sec-label" data-testid="msg.tests.self">Самостоятельные тесты</p>${data.items.map((x) => `<section class="card soft row2"><div class="grow"><h3>${esc(TITLES[x.code] || x.title)}</h3><div class="sub">Можно пройти без назначения</div></div><button type="button" class="btn sm" data-testid="msg.tests.self.take" data-code="${x.code}">Пройти</button></section>`).join('')}`;
  }
  root.addEventListener('click', async (e) => {
    const option = e.target.closest('[data-option]');
    if (option) {
      const question = questions[index];
      if (question && question.type !== 'multi')
        qa('[data-option]', root).forEach((x) => x.setAttribute('aria-pressed', x === option ? 'true' : 'false'));
      else option.setAttribute('aria-pressed', option.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    }
    if (e.target.closest(tid('msg.tests.run.none'))) q('[data-option]', root)?.setAttribute('aria-pressed', 'true');
    if (e.target.closest(tid('msg.tests.run.start'))) {
      intro = null;
      draw();
    }
    if (e.target.closest(tid('msg.tests.run.prev')) && index > 0) {
      index -= 1;
      draw();
    }
    if (e.target.closest(tid('msg.tests.run.next')) && !sending) {
      const question = questions[index];
      const chosen = qa('[data-option][aria-pressed="true"]', root).map(
        (x) => (question.options || [])[Number(x.dataset.option)],
      );
      if (question.type !== 'multi' && question.options && !chosen.length) {
        q('[data-pick-hint]', root).hidden = false;
        return;
      }
      const value = !question.options ? '1' : question.type === 'multi' ? chosen.map((x) => x.value) : chosen[0].value;
      sending = true;
      const { response, data } = await put(`/api/v1/me/assignments/${assignment}/answers/${question.id}`, { value });
      sending = false;
      if (!response.ok) return;
      answers[question.id] = value;
      crisisCard(slot, data);
      index += 1;
      draw();
    }
    if (e.target.closest(tid('msg.tests.run.submit')) && !sending) {
      sending = true;
      const { response, data } = await post(`/api/v1/me/assignments/${assignment}/submit`, {});
      sending = false;
      if (!response.ok) {
        let out = q('[data-submit-error]', body);
        if (!out) {
          out = document.createElement('p');
          out.dataset.submitError = '';
          out.setAttribute('role', 'alert');
          body.append(out);
        }
        out.textContent = t('msg.tests.result.error');
        return;
      }
      resultId = data.id;
      const self = data.source === 'self';
      const flowerGain = Number(response.headers.get('x-flower-gain')) || 0;
      body.innerHTML = `<section class="card"><h3 data-testid="msg.tests.result.done">${t('msg.tests.result.done')}</h3><p class="sub" data-testid="msg.tests.result.disclaimer">${t(data.completion_key || 'msg.tests.result.for_doctor')}</p>${flowerGain > 0 ? `<p class="sub flower-gain" data-testid="msg.flower.test_gain">${t('msg.flower.test_gain').replace('{text}', `+${flowerGain} ${flowerGain % 10 === 1 && flowerGain % 100 !== 11 ? 'капелька' : flowerGain % 10 >= 2 && flowerGain % 10 <= 4 && (flowerGain % 100 < 12 || flowerGain % 100 > 14) ? 'капельки' : 'капелек'}`)}</p>` : ''}<div class="acts">${self ? button('msg.tests.self.show', t('msg.tests.self.show')) : ''}<a class="btn ghost" href="/app?tab=tests">${t('msg.tests.run.back')}</a></div></section>`;
    }
    if (e.target.closest(tid('msg.tests.self.take'))) {
      const { data } = await post('/api/v1/me/self-tests', { instrument_code: e.target.dataset.code });
      await begin(data.id);
    }
    if (e.target.closest(tid('msg.tests.self.show')) && resultId) {
      const { response } = await post(`/api/v1/me/results/${resultId}/share`, {});
      if (response.ok) {
        e.target.closest('button').remove();
        q(tid('msg.tests.result.disclaimer'), body).textContent = t('msg.tests.result.shared');
      }
    }
  });
}

async function diary() {
  const root = q('#v2-diary');
  if (!root) return;
  root.innerHTML = `<textarea data-testid="msg.diary.note" placeholder="${t('msg.diary.note')}"></textarea>${button('msg.diary.save', 'Сохранить запись')}<p data-testid="msg.undo.diary_saved" hidden>Запись сохранена</p><p data-testid="msg.diary.empty">Отметьте, как вы сегодня, — это 10 секунд</p><p data-testid="msg.diary.chart" hidden>График</p><p data-testid="msg.diary.visibility" hidden>Видит специалист</p>`;
  try {
    const response = await fetch('/api/v1/me');
    const data = response.ok ? await response.json() : null;
    const email = data?.user?.email;
    const known = email && localStorage.getItem(`cc_diary_draft:${email}`);
    if (known) {
      const field = q(tid('msg.diary.note'), root);
      field.value = known;
      field.insertAdjacentHTML('beforebegin', '<p data-testid="msg.composer.draft_restored">Черновик восстановлен</p>');
    }
  } catch (_) {
    // Черновик доступен только при восстановленной сессии.
  }
}

// Хуки назначения лекарств (public/js/rx.js): «Отменить» из общего блока отмены и сообщение об ошибке.
const rxHooks = {
  undo(flow, data, key) {
    undoControl(flow, data, key);
    const note = q(tid(key), flow);
    if (note) note.textContent = `Отправлено пациенту · план версия ${data.published_version}`;
  },
  error(flow, text) {
    flow.insertAdjacentHTML('beforeend', `<p class="small rx-error" role="alert">${esc(text)}</p>`);
  },
};

async function card() {
  const root = q('#v2-card');
  if (!root) return;
  const patient = root.dataset.patientId,
    tab = root.dataset.tab;
  if (tab === 'overview') return;
  if (tab === 'messages') {
    root.innerHTML = `<section data-message-thread></section><label>${t('msg.v3.messages.reply')}<textarea data-testid="msg.v3.messages.reply" maxlength="10000"></textarea></label>${button('msg.composer.send', t('msg.composer.send'))}`;
    const holder = q('[data-message-thread]', root);
    const field = q('textarea', root);
    const attachments = attachmentComposer(root, root);
    const load = messageHistory(holder, `/api/v1/patients/${patient}/messages`, 'clinician');
    q(tid('msg.composer.send'), root).addEventListener('click', async () => {
      if (attachments.pending()) return;
      const result = await post(`/api/v1/patients/${patient}/messages`, {
        text: field.value,
        upload_ids: attachments.ids(),
      });
      if (!result.response.ok) return errorMessage(root, result.data);
      if (!result.data.message) return;
      field.value = '';
      attachments.clear();
      undoControl(root, result.data, 'msg.undo.message_sent');
      await load();
    });
    root.addEventListener('v3-refresh', load);
    return;
  }
  if (tab === 'treatment')
    root.innerHTML = `<p class="sec-label">Новое назначение или визит</p><div class="card"><span class="rx-field"><textarea data-testid="msg.card.placeholder.treatment" rows="2" placeholder="сертралин"></textarea></span><div class="acts">${button('msg.composer.send', 'Отправить')}</div></div><div id="card-flow"></div>`;
  if (tab === 'treatment' && window.CCRx) {
    window.CCRx.attachPhrase(q(tid('msg.card.placeholder.treatment'), root));
    window.CCRx.mount(root, rxHooks);
  }
  if (tab === 'tests')
    root.innerHTML = `<p class="sec-label">Назначить</p><div class="acts">${button('msg.card.tests.package_start', 'Пакет «Старт»')}${button('msg.card.tests.cancel', 'Отменить назначение')}</div><div id="card-flow"></div>`;
  if (['overview', 'treatment'].includes(tab)) {
    const result = await get(`/api/v1/patients/${patient}/visits`);
    const previsit = result.data.previsit;
    const summary = document.createElement('section');
    summary.dataset.testid = 'msg.v3.previsit.summary';
    summary.innerHTML = `<h2>${t('msg.v3.previsit.summary')}</h2>`;
    if (!result.response.ok) errorMessage(summary, result.data);
    else if (!previsit) summary.insertAdjacentHTML('beforeend', `<p>${t('msg.v3.previsit.empty')}</p>`);
    else
      summary.insertAdjacentHTML(
        'beforeend',
        `<p>${esc(previsit.submitted_at || '')}</p>${Object.entries(previsit.answers || {})
          .map(([id, value]) => {
            const question = (previsit.questions || []).find((item) => item.id === id);
            const label = (entry) => question?.options?.find((option) => option.value === entry)?.label || entry;
            return `<article><h3>${esc(question?.text || id)}</h3><p>${esc((Array.isArray(value) ? value.map(label) : [label(value)]).join(', '))}</p></article>`;
          })
          .join('')}`,
      );
    if (tab === 'treatment' && result.response.ok) {
      summary.insertAdjacentHTML(
        'beforeend',
        (result.data.items || [])
          .map(
            (visit) =>
              `<details data-edit-visit="${visit.id}" data-version="${visit.version}"><summary>${esc(visit.starts_at)} · ${t(`msg.v3.visit.status.${visit.status}`)}</summary><label>${t('msg.v3.visit.date')}<input type="datetime-local" data-edit-date value="${esc(visit.starts_at.slice(0, 16))}"></label><label>${t('msg.v3.visit.format')}<select data-edit-format><option value="in_person" ${visit.format === 'in_person' ? 'selected' : ''}>${t('msg.v3.visit.in_person')}</option><option value="remote" ${visit.format === 'remote' ? 'selected' : ''}>${t('msg.v3.visit.remote')}</option></select></label><label>${t('msg.v3.visit.place')}<input data-edit-place value="${esc(visit.place || '')}"></label><label>${t('msg.v3.visit.prepare')}<textarea data-edit-prepare maxlength="500">${esc(visit.prepare_enc || '')}</textarea></label><label><input type="checkbox" data-edit-previsit ${visit.previsit_enabled ? 'checked' : ''}>${t('msg.card.visit.previsit')}</label>${button('msg.v3.visit.save', t('msg.v3.visit.save'))}${button('msg.v3.visit.cancel', t('msg.v3.visit.cancel'))}${button('msg.v3.visit.done', t('msg.v3.visit.done'))}${button('msg.v3.visit.no_show', t('msg.v3.visit.no_show'))}</details>`,
          )
          .join(''),
      );
      summary.addEventListener('click', async (event) => {
        const editor = event.target.closest('[data-edit-visit]');
        if (!editor) return;
        const action = [
          ['msg.v3.visit.save', null],
          ['msg.v3.visit.cancel', 'cancelled'],
          ['msg.v3.visit.done', 'done'],
          ['msg.v3.visit.no_show', 'no_show'],
        ].find(([key]) => event.target.closest(tid(key)));
        if (!action) return;
        const body = {
          version: Number(editor.dataset.version),
          ...(action[1]
            ? { status: action[1] }
            : {
                starts_at: new Date(q('[data-edit-date]', editor).value).toISOString(),
                format: q('[data-edit-format]', editor).value,
                place: q('[data-edit-place]', editor).value,
                prepare: q('[data-edit-prepare]', editor).value,
                previsit_enabled: q('[data-edit-previsit]', editor).checked,
              }),
        };
        const changed = await patch(`/api/v1/visits/${editor.dataset.editVisit}`, body);
        if (!changed.response.ok) return errorMessage(editor, changed.data);
        editor.dataset.version = changed.data.version;
        errorMessage(editor, { error: { key: 'msg.v3.action.saved' } });
      });
    }
    root.append(summary);
  }
  root.addEventListener('click', async (e) => {
    const fill = e.target.closest('[data-fill]');
    if (fill) {
      const field = q(tid('msg.card.placeholder.treatment'), root);
      if (field) field.value = fill.dataset.fill;
      return;
    }
    const flow = q('#card-flow', root);
    if (e.target.closest(tid('msg.composer.send'))) {
      const phrase = q(tid('msg.card.placeholder.treatment'), root)?.value || '';
      flow.dataset.visit = /визит/i.test(phrase) ? '1' : '';
      flow.innerHTML = flow.dataset.visit
        ? `<p data-testid="msg.card.visit.title">${t('msg.card.visit.title')}</p><label>${t('msg.v3.visit.date')}<input type="datetime-local" data-visit-date value="${new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16)}"></label><label>${t('msg.v3.visit.format')}<select data-visit-format><option value="in_person">${t('msg.v3.visit.in_person')}</option><option value="remote">${t('msg.v3.visit.remote')}</option></select></label><label>${t('msg.v3.visit.place')}<input data-visit-place maxlength="1000"></label><label>${t('msg.v3.visit.prepare')}<textarea data-visit-prepare maxlength="500"></textarea></label><label data-testid="msg.card.visit.previsit"><input type="checkbox" data-visit-previsit checked>${t('msg.card.visit.previsit')}</label>${button('msg.card.draft.send', t('msg.card.draft.send'))}`
        : '';
      if (!flow.dataset.visit && tab === 'treatment' && window.CCRx) window.CCRx.openDraft(flow, rxHooks, phrase);
    }
    if (e.target.closest(tid('msg.card.tests.package_start'))) {
      const [packs, instruments] = await Promise.all([get('/api/v1/packages'), get('/api/v1/instruments')]);
      const start = (packs.data.items || []).find((x) => x.title === 'Старт');
      flow.dataset.packageId = start ? start.id : '';
      if (!start) {
        flow.innerHTML = '<p class="small rx-error" role="alert">Пакет «Старт» не найден в каталоге.</p>';
        return;
      }
      const names = new Map((instruments.data.items || []).map((i) => [i.code, i.title || i.code]));
      flow.innerHTML = `<section class="card"><h3>Пакет «Старт»</h3><div class="sub">${start.items.map((c) => esc(names.get(c) || c)).join(' · ')}</div><div class="acts">${button('msg.card.draft.send', 'Отправить пациенту')}</div></section>`;
    }
    if (e.target.closest(tid('msg.card.draft.send'))) {
      if (tab === 'treatment') {
        if (flow.dataset.visit === '1') {
          const result = await post(`/api/v1/patients/${patient}/visits`, {
            starts_at: q('[data-visit-date]', flow).value
              ? new Date(q('[data-visit-date]', flow).value).toISOString()
              : '',
            format: q('[data-visit-format]', flow).value,
            place: q('[data-visit-place]', flow).value,
            prepare: q('[data-visit-prepare]', flow).value,
            previsit_enabled: q('[data-visit-previsit]', flow).checked,
          });
          if (!result.response.ok) return errorMessage(flow, result.data);
          undoControl(flow, result.data, 'msg.undo.sent_to_patient');
          return;
        }
        if (window.CCRx) await window.CCRx.send(flow, rxHooks);
      } else {
        if (!flow.dataset.packageId) return;
        const result = await post(`/api/v1/patients/${patient}/assignments`, {
          package_id: Number(flow.dataset.packageId),
        });
        if (result.response.status === 409) {
          flow.insertAdjacentHTML(
            'beforeend',
            '<p class="small rx-error" role="alert">Часть методик пакета уже назначена пациенту и ещё не пройдена.</p>',
          );
          return;
        }
        if (!result.response.ok) return errorMessage(flow, result.data);
        undoControl(flow, result.data, 'msg.undo.sent_to_patient');
      }
    }
    if (e.target.closest(tid('msg.card.tests.cancel')))
      showUndo(flow, 'msg.undo.assignment_cancelled', 'Назначение отменено');
  });
}

function crisisCard(root, data) {
  if (!data?.crisis) return;
  let holder = q('[data-crisis]', root);
  if (!holder) {
    holder = document.createElement('section');
    holder.dataset.crisis = '1';
    root.prepend(holder);
  }
  holder.innerHTML = `<article class="crisis-card" data-testid="msg.crisis.card.title"><h2>${t('msg.crisis.card.title')}</h2><div class="acts"><a class="btn crisis" href="tel:112" data-testid="msg.crisis.card.call">${t('msg.crisis.card.call')}</a><a class="btn" href="/app?tab=doctor" data-testid="msg.crisis.card.write">${t('msg.crisis.card.write')}</a></div><p data-testid="msg.crisis.card.who_sees">${t('msg.crisis.card.who_sees')}</p></article>`;
}
function errorMessage(root, data) {
  let holder = q('[data-feedback]', root);
  if (!holder) {
    holder = document.createElement('p');
    holder.dataset.feedback = '1';
    holder.setAttribute('role', 'status');
    root.append(holder);
  }
  holder.textContent = data?.error ? t(data.error.key) : t('msg.v3.error');
}
function undoControl(root, data, key) {
  let holder = q('[data-undo-holder]', root);
  if (!holder) {
    holder = document.createElement('div');
    holder.dataset.undoHolder = '1';
    root.append(holder);
  }
  holder.innerHTML = `<p data-testid="${key}">${t(key)}</p>${data.undo?.id ? `<button type="button" data-testid="msg.undo.action" data-undo="${esc(data.undo.id)}">${t('msg.undo.action')}</button>` : ''}`;
  q('[data-undo]', holder)?.addEventListener('click', async (event) => {
    const result = await post(`/api/v1/undo/${encodeURIComponent(event.target.dataset.undo)}`, {});
    if (result.response.ok) {
      holder.innerHTML = `<p data-testid="msg.undo.done">${t('msg.undo.done')}</p>`;
      root.dispatchEvent(new Event('v3-refresh', { bubbles: true }));
    } else errorMessage(holder, result.data);
  });
}
function attachmentComposer(root, crisisRoot) {
  const attached = [];
  let pending = false;
  let box = q('#v3-attach') || document.createElement('section');
  box.classList.add('attach-box');
  if (!box.parentNode) root.append(box);
  const render = () => {
    box.hidden = false;
    box.innerHTML = `<p data-testid="msg.composer.photo.others">${t('msg.composer.photo.others')}</p><input id="v3-photo" type="file" accept="image/jpeg,image/png,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.txt,.docx,.pdf,.jpg,.jpeg,.png" hidden>${pbutton('msg.composer.attach.photo', t('msg.composer.attach.photo'), 'btn sm')}<div data-upload-list>${attached.map((file) => `<p data-testid="msg.composer.file.ocr_done">${esc(file.name)} <button type="button" class="round round--sm" data-testid="msg.composer.file.remove" data-remove="${file.id}" aria-label="${t('msg.composer.file.remove')}"><svg class="i i--16" aria-hidden="true" focusable="false"><use href="/icons.svg#i-x"/></svg></button></p>`).join('')}</div>`;
    q(tid('msg.composer.attach.photo'), box).addEventListener('click', () => q('input', box).click());
    q('input', box).addEventListener('change', async (event) => {
      const file = event.target.files[0];
      if (!file || pending) return;
      if (attached.length >= 5) return errorMessage(box, { error: { key: 'err.e-file-count' } });
      pending = true;
      const form = new FormData();
      form.append('file', file);
      try {
        const token = (await (await fetch('/api/v1/csrf')).json()).token;
        const response = await fetch('/api/v1/uploads', {
          method: 'POST',
          headers: { 'x-csrf-token': token, 'idempotency-key': crypto.randomUUID() },
          body: form,
        });
        const data = await response.json();
        crisisCard(crisisRoot, data);
        if (!response.ok) return errorMessage(box, data);
        if (data.ocr_text) {
          const field = q(tid('msg.chat.placeholder'));
          if (field) field.value = [field.value, data.ocr_text].filter(Boolean).join('\n');
        }
        attached.push({ id: data.id, name: file.name });
        render();
      } catch (_) {
        errorMessage(box);
      } finally {
        pending = false;
      }
    });
    box.addEventListener('click', remove, { once: true });
  };
  function remove(event) {
    const target = event.target.closest('[data-remove]');
    if (target) {
      attached.splice(
        attached.findIndex((file) => file.id === Number(target.dataset.remove)),
        1,
      );
      render();
    } else box.addEventListener('click', remove, { once: true });
  }
  if (!q(tid('msg.composer.attach')))
    root.insertAdjacentHTML('beforeend', button('msg.composer.attach', t('msg.composer.attach')));
  q(tid('msg.composer.attach'))?.addEventListener('click', render);
  return {
    ids: () => attached.map((file) => file.id),
    pending: () => pending,
    clear: () => {
      attached.length = 0;
      box.innerHTML = '';
      box.hidden = true;
    },
  };
}
async function chat() {
  const root = q('#v3-chat');
  const field = q(tid('msg.chat.placeholder'));
  if (!root || !field) return;
  const attachments = attachmentComposer(field.parentNode, root);
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      q(tid('msg.composer.send'))?.click();
    }
  });
  q(tid('msg.composer.send'))?.addEventListener('click', async () => {
    if (attachments.pending()) return;
    const chips = window.PatientChat?.chips ? window.PatientChat.chips() : [];
    const sentText = field.value;
    const chipLabels = [...document.querySelectorAll('[data-chips] > button')].map((chip) =>
      chip.textContent.replace(/×$/, '').trim(),
    );
    const { response, data } = await post('/api/v1/ai/patient/messages', {
      text: field.value,
      chips,
      upload_ids: attachments.ids(),
    });
    if (data.crisis) root.innerHTML = '';
    crisisCard(root, data);
    if (!response.ok) {
      window.PatientChat?.renderSendError(data?.error?.code || 'E-AI-UNAVAILABLE');
      return;
    }
    if (data.crisis || data.saved === false) return;
    if (data.reply) {
      field.value = '';
      attachments.clear();
      window.PatientChat?.renderUser?.(sentText, chipLabels);
      window.PatientChat?.renderReply(data);
      if (data.ae_suggestion) window.PatientChat?.renderAeCard(data.ae_suggestion.prefill || {});
    }
  });
}
async function adverseEvent() {
  const root = q('#v3-ae');
  if (!root) return;
  let prefill;
  try {
    prefill = JSON.parse(sessionStorage.getItem('cc.ae_prefill') || 'null');
    sessionStorage.removeItem('cc.ae_prefill');
  } catch (_) {
    /* optional draft */
  }
  root.innerHTML = `<section><p data-testid="msg.ae.card.prefilled" ${prefill ? '' : 'hidden'}>${t('msg.ae.card.prefilled')}</p><label>${t('msg.v3.ae.description')}<textarea data-ae-text maxlength="1000"></textarea></label>${pbutton('msg.ae.chip.nausea', t('msg.ae.chip.nausea'), 'chip')}<label>${t('msg.v3.ae.onset')}<input data-ae-date type="date"></label>${pbutton('msg.ae.when.days', t('msg.ae.when.days'), 'chip')}<fieldset class="choices"><legend>${t('msg.v3.ae.severity')}</legend>${['mild', 'noticeable', 'severe'].map((value, i) => `<label class="choice"><input name="ae-severity" type="radio" value="${value}" ${i === 1 ? 'checked' : ''} data-testid="msg.ae.severity.${i + 1}">${t(`msg.ae.severity.${i + 1}`)}</label>`).join('')}</fieldset><fieldset class="choices"><legend>${t('msg.v3.ae.related')}</legend>${['yes', 'no', 'unknown'].map((value) => `<label class="choice"><input name="ae-related" type="radio" value="${value}" data-testid="msg.ae.link.${value}" ${value === 'unknown' ? 'checked' : ''}>${t(`msg.ae.link.${value}`)}</label>`).join('')}</fieldset><article data-testid="msg.ae.card.title"><p data-testid="msg.ae.who_sees">${t('msg.ae.who_sees')}</p><p data-testid="msg.ae.urgent_note">${t('msg.ae.urgent_note')}</p>${pbutton('msg.ae.card.send', t('msg.ae.card.send'), 'btn primary')}</article></section><div id="v3-ae-flow"></div>`;
  const attachments = attachmentComposer(root, root);
  {
    const who = q('[data-testid="msg.ae.who_sees"]', root);
    const people = ((await get('/api/v1/me/messages')).data || {}).recipients || [];
    const person = people.find((x) => x.role === 'psychiatrist') || people[0];
    const raw = (key) => uiTexts[key] || key;
    if (who)
      who.textContent = person
        ? raw('msg.ae.who_sees')
            .replace('психиатр', { psychiatrist: 'психиатр', psychologist: 'психолог' }[person.role] || 'специалист')
            .replace('{clinician}', person.name)
        : raw('msg.ae.who_sees.generic');
  }
  const meds = (await get('/api/v1/me/meds')).data;
  const choices = [
    ...(meds.plan_items || [])
      .filter((item) => item.acceptance)
      .map((item) => ({
        value: `plan:${item.item_key}`,
        name: [item.inn_name, item.product_name].filter(Boolean).join(' · '),
      })),
    ...(meds.patient_meds || []).map((item) => ({
      value: `own:${item.id}`,
      name: [item.inn_name, item.product_name].filter(Boolean).join(' · '),
    })),
  ];
  q('section', root).insertAdjacentHTML(
    'afterbegin',
    `<label>${t('msg.v3.ae.medication')}<select data-ae-medication><option value="">${t('msg.ae.link.unknown')}</option>${choices.map((item) => `<option value="${esc(item.value)}">${esc(item.name)}</option>`).join('')}</select></label>`,
  );
  const field = q('[data-ae-text]', root);
  field.value = prefill?.text || prefill?.description || '';
  if (prefill?.severity && q(`[value="${esc(prefill.severity)}"]`, root))
    q(`[value="${esc(prefill.severity)}"]`, root).checked = true;
  // F-45: серверный черновик. draftId держится локально и восстанавливается после reload.
  let draftId = null;
  const draftBox = document.createElement('div');
  draftBox.className = 'ae-draft-controls';
  root.appendChild(draftBox);
  const renderDraftControls = () => {
    draftBox.innerHTML = `<button type="button" class="btn" data-testid="msg.ae.card.save_draft">${t('msg.ae.card.save_draft')}</button>${
      draftId
        ? `<button type="button" class="btn ghost" data-testid="msg.ae.card.delete">${t('msg.ae.card.delete')}</button>`
        : ''
    }`;
  };
  renderDraftControls();
  (async () => {
    const result = await get('/api/v1/me/adverse-events');
    if (result.response.ok && result.data.draft) {
      draftId = result.data.draft.id;
      if (result.data.draft.text) field.value = result.data.draft.text;
      field.insertAdjacentHTML(
        'beforebegin',
        `<p data-testid="msg.ae.card.draft_restored">${t('msg.ae.card.draft_restored')}</p>`,
      );
      renderDraftControls();
    }
  })();
  root.addEventListener('click', async (event) => {
    if (event.target.closest(tid('msg.ae.chip.nausea'))) {
      field.value = [field.value, t('msg.ae.chip.nausea')].filter(Boolean).join(', ');
      event.target.setAttribute('aria-pressed', 'true');
    }
    if (event.target.closest(tid('msg.ae.when.days'))) {
      const day = new Date(Date.now() - 3 * 86400000);
      q('[data-ae-date]', root).value = day.toISOString().slice(0, 10);
    }
    if (event.target.closest(tid('msg.ae.card.save_draft'))) {
      if (attachments.pending()) return;
      const selected = q('[data-ae-medication]', root).value;
      const result = await post('/api/v1/me/adverse-events', {
        submit: false,
        ...(draftId ? { draft_id: draftId } : {}),
        upload_ids: attachments.ids(),
        item_key: selected.startsWith('plan:') ? selected.slice(5) : null,
        patient_med_id: selected.startsWith('own:') ? Number(selected.slice(4)) : null,
        symptoms: q('[aria-pressed="true"]', root) ? ['nausea'] : [],
        text: field.value,
        started_on: q('[data-ae-date]', root).value || null,
        severity: q('[name="ae-severity"]:checked', root).value,
        related: q('[name="ae-related"]:checked', root).value,
      });
      crisisCard(root, result.data);
      if (!result.response.ok) return errorMessage(root, result.data);
      if (result.data.ae) {
        draftId = result.data.ae.id;
        renderDraftControls();
      }
    }
    if (event.target.closest(tid('msg.ae.card.delete'))) {
      if (!draftId) return;
      const result = await post('/api/v1/me/adverse-events', { discard: true, draft_id: draftId });
      if (!result.response.ok) return errorMessage(root, result.data);
      draftId = null;
      field.value = '';
      renderDraftControls();
    }
    if (event.target.closest(tid('msg.ae.card.send'))) {
      if (attachments.pending()) return;
      const selected = q('[data-ae-medication]', root).value;
      const result = await post('/api/v1/me/adverse-events', {
        ...(draftId ? { draft_id: draftId } : {}),
        upload_ids: attachments.ids(),
        item_key: selected.startsWith('plan:') ? selected.slice(5) : null,
        patient_med_id: selected.startsWith('own:') ? Number(selected.slice(4)) : null,
        symptoms: q('[aria-pressed="true"]', root) ? ['nausea'] : [],
        text: field.value,
        started_on: q('[data-ae-date]', root).value || null,
        severity: q('[name="ae-severity"]:checked', root).value,
        related: q('[name="ae-related"]:checked', root).value,
      });
      crisisCard(root, result.data);
      if (!result.response.ok) return errorMessage(root, result.data);
      if (result.data.saved !== false && result.data.ae) {
        attachments.clear();
        draftId = null;
        renderDraftControls();
        undoControl(q('#v3-ae-flow', root), result.data, 'msg.undo.ae_sent');
      }
    }
  });
}
const DAY_MS = 86400000;
function chatDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Math.round((new Date().setHours(12, 0, 0, 0) - new Date(d).setHours(12, 0, 0, 0)) / DAY_MS);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}
function chatTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 5);
}
function messageHistory(root, path, readerRole = 'patient') {
  const history = document.createElement('section');
  history.className = 'thread';
  root.prepend(history);
  let signature = '';
  const mineRole = readerRole === 'patient' ? 'patient' : 'clinician';
  const load = async () => {
    const result = await get(path);
    if (!result.response.ok) return errorMessage(history, result.data);
    const selected = Number(q('[data-recipient]')?.value);
    const items = selected
      ? (result.data.items || []).filter((item) => item.clinician_id === selected)
      : result.data.items || [];
    const incoming = items
      .filter(
        (item) =>
          !item.read_at &&
          (readerRole === 'patient' ? item.sender_role === 'clinician' : item.sender_role === 'patient'),
      )
      .map((item) => item.id);
    if (incoming.length) await post('/api/v1/messages/read', { ids: incoming });
    const next = JSON.stringify(items);
    if (next === signature) return;
    signature = next;
    let lastDay = '';
    history.innerHTML =
      items
        .map((item) => {
          const dayLabel = chatDay(item.created_at);
          const sep = dayLabel !== lastDay ? `<div class="day">${esc(dayLabel)}</div>` : '';
          lastDay = dayLabel;
          const mine = item.sender_role === mineRole;
          return `${sep}<article class="msg${mine ? ' me' : ''}"><div class="bubble">${esc(item.body)}</div>${(item.upload_ids || []).map((id) => `<p class="small"><a href="/api/v1/files/${Number(id)}">${t('msg.v3.file')} ${Number(id)}</a></p>`).join('')}<div class="meta"><time datetime="${esc(item.created_at)}">${esc(chatTime(item.created_at))}</time>${mine ? `<span>${item.read_at ? t('msg.v3.messages.read') : t('msg.doctor.status.sent')}</span>` : ''}</div></article>`;
        })
        .join('') || `<p class="muted">${t('msg.v3.messages.empty')}</p>`;
    const scroller = history.closest('.scroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  };
  root.addEventListener('v3-refresh', load);
  // Update only history, keeping the composer, attachments and feedback intact.
  const tick = async () => {
    if (!root.isConnected) return;
    try {
      await load();
    } catch (_) {
      /* retain last history */
    }
    setTimeout(tick, 5000);
  };
  void tick();
  return load;
}
async function doctor() {
  const root = q('#v3-doctor');
  const field = q(tid('msg.doctor.placeholder'));
  if (!root || !field) return;
  const recipients = (await get('/api/v1/me/messages')).data.recipients || [];
  const ROLE_WORD = { psychiatrist: 'психиатр', psychologist: 'психолог' };
  const head = q('.dhead');
  if (head && recipients.length) {
    const first = recipients[0];
    q('[data-doctor-avatar]', head).textContent = first.name
      .split(/\s+/)
      .map((w) => w[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
    q('h1', head).textContent = `${first.name} · ${ROLE_WORD[first.role] || ''}`;
    q('[data-doctor-role]', head).textContent = 'ваш врач';
    if (recipients.length > 1) {
      q('[data-doctor-pick]', head).innerHTML =
        `<select data-recipient aria-label="${t('msg.v3.messages.recipient')}">${recipients.map((person) => `<option value="${person.id}">${esc(person.name)} · ${t(`msg.v3.role.${person.role}`)}</option>`).join('')}</select>`;
    } else
      q('[data-doctor-pick]', head).innerHTML =
        `<select data-recipient hidden>${recipients.map((person) => `<option value="${person.id}">${esc(person.name)}</option>`).join('')}</select>`;
  } else
    field.insertAdjacentHTML(
      'beforebegin',
      `<label hidden>${t('msg.v3.messages.recipient')}<select data-recipient>${recipients.map((person) => `<option value="${person.id}">${esc(person.name)} · ${t(`msg.v3.role.${person.role}`)}</option>`).join('')}</select></label>`,
    );
  const attachments = attachmentComposer(field.parentNode, root);
  const load = messageHistory(root, '/api/v1/me/messages');
  q('[data-recipient]')?.addEventListener('change', async () => {
    const chosen = recipients.find((person) => String(person.id) === q('[data-recipient]').value);
    if (chosen && q('.dhead h1')) q('.dhead h1').textContent = `${chosen.name} · ${ROLE_WORD[chosen.role] || ''}`;
    await load();
  });
  q(tid('msg.composer.send'))?.addEventListener('click', async () => {
    if (attachments.pending()) return;
    const result = await post('/api/v1/me/messages', {
      text: field.value,
      to_clinician_id: Number(q('[data-recipient]')?.value) || null,
      upload_ids: attachments.ids(),
    });
    crisisCard(root, result.data);
    if (!result.response.ok) return errorMessage(root, result.data);
    if (result.data.saved === false || !result.data.message) return;
    field.value = '';
    attachments.clear();
    undoControl(root, result.data, 'msg.undo.message_sent');
    const status = document.createElement('p');
    status.dataset.testid = 'msg.doctor.status.sent';
    status.className = 'small muted';
    status.textContent = t('msg.doctor.status.sent');
    root.append(status);
    await load();
  });
}
async function visits() {
  const root = q('#v3-visits');
  if (!root) return;
  const [result, people] = await Promise.all([get('/api/v1/me/visits'), get('/api/v1/me/messages')]);
  if (!result.response.ok) return errorMessage(root, result.data);
  const items = result.data.items || [];
  const who = Object.fromEntries(((people.data && people.data.recipients) || []).map((person) => [person.id, person]));
  const ROLE_WORD = { psychiatrist: 'психиатр', psychologist: 'психолог' };
  const longDate = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return esc(iso);
    const weekday = d.toLocaleDateString('ru-RU', { weekday: 'long' });
    return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}, ${d.toTimeString().slice(0, 5)}`;
  };
  const shortDate = (iso) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const upcoming = items
    .filter((visit) => visit.status === 'scheduled')
    .sort((x, y) => x.starts_at.localeCompare(y.starts_at));
  const past = items.filter((visit) => visit.status !== 'scheduled');
  const doctorOf = (visit) => {
    const person = who[visit.clinician_id];
    return person ? `${esc(person.name)}, ${ROLE_WORD[person.role] || ''}` : 'Специалист';
  };
  const upcomingCard = (visit, i) =>
    `<article class="card" data-visit="${visit.id}"><a class="ask" href="/app?tab=chat&ask=visit:${visit.id}" aria-label="Спросить ИИ" title="Спросить ИИ" data-testid="msg.ask.star" data-object-type="visit" data-object-id="${visit.id}"><svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-sparkle"/></svg></a><div class="sub"${i === 0 ? ' data-testid="msg.visits.next"' : ''}>${i === 0 ? t('msg.visits.next') : 'Далее'}</div><h3>${longDate(visit.starts_at)}</h3><div class="sub">${doctorOf(visit)} · ${t(`msg.v3.visit.${visit.format}`)}${visit.place ? `, ${esc(visit.place)}` : ''}</div>${visit.prepare_enc ? `<p class="sub">${esc(visit.prepare_enc)}</p>` : ''}<div class="acts">${visit.previsit_enabled ? button('msg.visits.fill', t('msg.visits.fill')) : ''}<a class="btn ghost" href="/app?tab=doctor">Нужно перенести</a></div><div data-form></div></article>`;
  // Раскладка «список — детали»: визиты слева, выбранный справа (по умолчанию ближайший).
  const sideBox = q('[data-visits-side]');
  let selected = (upcoming[0] || past[0] || {}).id;
  const statusWord = (visit) =>
    visit.status === 'done'
      ? t('msg.visits.status.done')
      : visit.status === 'cancelled'
        ? t('msg.visits.status.cancelled')
        : 'не состоялся';
  const pastCard = (visit) =>
    `<article class="card" data-visit="${visit.id}"><div class="sub">${t('msg.visits.past')}</div><h3>${longDate(visit.starts_at)}</h3><div class="sub">${doctorOf(visit)} · ${statusWord(visit)}</div></article>`;
  const paintVisits = () => {
    if (sideBox) {
      const rowOf = (visit, sub) =>
        `<a href="#" class="th${visit.id === selected ? ' on' : ''}" data-vsel="${visit.id}"><span>${esc(shortDate(visit.starts_at))}</span><br><small class="lib-row-sub">${sub}</small></a>`;
      sideBox.innerHTML =
        (upcoming.length
          ? `<h4>${t('msg.visits.next')}</h4>${upcoming.map((visit) => rowOf(visit, `${new Date(visit.starts_at).toTimeString().slice(0, 5)} · ${doctorOf(visit)}`)).join('')}`
          : '') +
        (past.length
          ? `<h4>${t('msg.visits.past')}</h4>${past.map((visit) => rowOf(visit, `${doctorOf(visit)} · ${statusWord(visit)}`)).join('')}`
          : '');
    }
    const visit = items.find((x) => x.id === selected);
    root.innerHTML =
      (visit
        ? visit.status === 'scheduled'
          ? upcomingCard(visit, upcoming.indexOf(visit))
          : pastCard(visit)
        : `<p class="muted">${t('msg.v3.visits.empty')}</p>`) +
      '<a class="ask-line" href="/app?tab=chat">Спросить ИИ, что обсудить на визите…</a>';
  };
  paintVisits();
  sideBox?.addEventListener('click', (event) => {
    const link = event.target.closest('[data-vsel]');
    if (!link) return;
    event.preventDefault();
    selected = Number(link.dataset.vsel);
    paintVisits();
  });
  root.addEventListener('click', async (event) => {
    const article = event.target.closest('[data-visit]');
    if (!article) return;
    const flow = q('[data-form]', article),
      path = `/api/v1/me/visits/${article.dataset.visit}/previsit`;
    if (event.target.closest(tid('msg.visits.fill'))) {
      const result = await get(path);
      crisisCard(root, result.data);
      if (!result.response.ok) return errorMessage(flow, result.data);
      flow.innerHTML = `<h2 data-testid="msg.previsit.title">${t('msg.previsit.title')}</h2>${result.data.questions.map((question) => `<fieldset data-question="${esc(question.id)}" data-type="${esc(question.type)}"><legend>${esc(question.text)}${question.required ? ' *' : ''}</legend>${question.type.startsWith('text') ? `<textarea aria-label="${esc(question.text)}"></textarea>` : (question.options || []).map((option) => `<label><input type="${question.type === 'multi' ? 'checkbox' : 'radio'}" name="q-${esc(question.id)}" value="${esc(option.value)}">${esc(option.label)}</label>`).join('')}</fieldset>`).join('')}${button('msg.v3.previsit.save', t('msg.v3.previsit.save'))}${button('msg.previsit.send', t('msg.previsit.send'))}`;
      for (const holder of flow.querySelectorAll('[data-question]')) {
        const value = result.data.answers?.[holder.dataset.question];
        if (q('textarea', holder)) q('textarea', holder).value = value || '';
        else
          for (const input of holder.querySelectorAll('input'))
            input.checked = Array.isArray(value) ? value.includes(input.value) : value === input.value;
      }
      if (result.data.status === 'submitted') {
        for (const control of flow.querySelectorAll('input,textarea,button')) control.disabled = true;
        flow.insertAdjacentHTML('beforeend', `<p data-testid="msg.previsit.sent">${t('msg.previsit.sent')}</p>`);
      }
    }
    if (event.target.closest(`${tid('msg.previsit.send')},${tid('msg.v3.previsit.save')}`)) {
      const answers = {};
      flow.querySelectorAll('[data-question]').forEach((holder) => {
        const text = q('textarea', holder);
        const choices = [...holder.querySelectorAll('input:checked')].map((input) => input.value);
        if (text) answers[holder.dataset.question] = text.value;
        else if (holder.dataset.type === 'multi') answers[holder.dataset.question] = choices;
        else if (choices.length) answers[holder.dataset.question] = choices[0];
      });
      const submit = Boolean(event.target.closest(tid('msg.previsit.send')));
      const result = await put(path, { answers, submit });
      crisisCard(root, result.data);
      if (!result.response.ok) return errorMessage(flow, result.data);
      if (result.data.saved === false) return;
      if (submit) flow.innerHTML = `<p data-testid="msg.previsit.sent">${t('msg.previsit.sent')}</p>`;
      else errorMessage(flow, { error: { key: 'msg.v3.draft.saved' } });
    }
  });
}
async function signals() {
  const root = q('#v3-signals');
  if (!root) return;
  let kind = 'all',
    status = 'all';
  const signatures = new Map();
  const me = (await get('/api/v1/me')).data.user;
  root.innerHTML = `<div class="filters sig-filters"><button type="button" class="pill on" data-testid="msg.v3.signals.all">${t('msg.v3.signals.all')}</button>${root.dataset.canAe === '1' ? `<button type="button" class="pill" data-testid="msg.signals.filter.ae">${t('msg.signals.filter.ae')}</button>` : ''}<button type="button" class="pill" data-testid="msg.v3.signals.crisis">${t('msg.v3.signals.crisis')}</button><button type="button" class="pill" data-testid="msg.signals.filter.handled">${t('msg.signals.filter.handled')}</button></div><section data-signal-list></section>`;
  const mark = () => {
    const on =
      status === 'handled'
        ? 'msg.signals.filter.handled'
        : kind === 'ae'
          ? 'msg.signals.filter.ae'
          : kind === 'crisis'
            ? 'msg.v3.signals.crisis'
            : 'msg.v3.signals.all';
    root
      .querySelectorAll('.sig-filters .pill')
      .forEach((pill) => pill.classList.toggle('on', pill.dataset.testid === on));
  };
  const counts = async () => {
    const all = await get('/api/v1/signals?kind=all&status=all');
    if (!all.response.ok) return;
    const open = (all.data.items || []).filter((x) => x.status !== 'handled');
    const n = (fn) => open.filter(fn).length;
    const set = (key, label) => {
      const pill = q(tid(key), root);
      if (pill) pill.textContent = label;
    };
    set('msg.v3.signals.all', `Все · ${open.length}`);
    set('msg.signals.filter.ae', `Побочные эффекты · ${n((x) => x.kind === 'ae')}`);
    set('msg.v3.signals.crisis', `Кризисы · ${n((x) => x.kind === 'crisis')}`);
  };
  const list = q('[data-signal-list]', root);
  const when = (iso) => {
    const d = new Date(iso);
    const m = Math.round((Date.now() - d.getTime()) / 60000);
    if (Number.isNaN(m)) return '';
    if (m < 60) return `${Math.max(1, m)} мин назад`;
    if (m < 1440) return `${Math.round(m / 60)} ч назад`;
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  };
  // «{pv}» в подсказке сроков: ответственный по фармаконадзору из строки страницы, иначе «не назначен»
  const pvWho = () =>
    (q('[data-testid="msg.ae.pv_responsible"]')?.textContent || '').split(':').slice(1).join(':').trim() ||
    'не назначен';
  const ico = (name) => `<svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-${name}"/></svg>`;
  const btn = (key, text, cls = '') =>
    `<button type="button"${cls ? ` class="${cls}"` : ''} data-testid="${key}">${text}</button>`;
  // Даты и коды — словами: «12 августа», «из чата с ИИ», статус побочного эффекта из словаря
  const ruDay = (iso) => {
    const d = new Date(String(iso || '').length === 10 ? `${iso}T12:00:00` : iso);
    return Number.isNaN(d.getTime())
      ? esc(iso || t('msg.v3.missing'))
      : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  };
  const ruDue = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const same = d.toDateString() === new Date().toDateString();
    const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return same
      ? `сегодня до ${time}`
      : `до ${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}, ${time}`;
  };
  const known = (key, fallbackKey) => {
    if (uiTexts[key]) return t(key);
    console.warn('unknown code', key);
    return t(fallbackKey);
  };
  const draw = (item) => {
    const name = esc(item.patient?.name || `П-${item.patient?.id}`);
    if (item.kind === 'ae') {
      const open = ['submitted', 'awaiting_doctor', 'service_queue'].includes(item.status);
      const word = known(`msg.overview.ae.status.${item.status}`, 'msg.signals.status.unknown');
      return `<div class="q-state"><span class="st-pill ${open ? 'warn' : 'ok'}">${ico(open ? 'warning-circle' : 'check-circle')}${open ? t('msg.signals.pill.ae') : word}</span></div><div class="q-main"><b>${name} · ${t('msg.v3.ae.title')}</b><p class="q-quote">${esc(item.text || t('msg.v3.missing'))}</p><p class="q-meta">${t('msg.v3.ae.onset')} ${ruDay(item.started_on)} · ${t('msg.v3.ae.severity')} ${t(`msg.v3.severity.${item.severity || 'unknown'}`)} · ${t('msg.v3.ae.related')} ${t(`msg.ae.link.${item.related || 'unknown'}`)}${open ? '' : ` · ${word}`}</p>${(item.upload_ids || []).map((id) => `<a class="small link" href="/api/v1/files/${Number(id)}">${t('msg.v3.file')} ${Number(id)}</a>`).join(' ')}</div><div class="q-act acts">${open ? `${btn('msg.signals.ae.likely', t('msg.signals.ae.likely'))}${btn('msg.v3.ae.unrelated', t('msg.v3.ae.unrelated'))}${btn('msg.v3.ae.insufficient', t('msg.v3.ae.insufficient'))}` : ''}</div><div class="q-more">${open || item.comment ? `<label>${t('msg.v3.ae.comment')}<textarea data-ae-comment maxlength="1000" ${open ? '' : 'readonly'}>${esc(item.comment || '')}</textarea></label>` : ''}${open ? `<label><input type="checkbox" data-serious>${t('msg.v3.ae.serious')}</label>` : ''}<div class="ae-flow">${item.status === 'related_likely' ? btn('msg.signals.notice.open', t('msg.signals.notice.open')) : ''}</div></div>`;
    }
    const mine = !item.taken_by || item.taken_by.id === me?.id;
    const handled = item.status === 'handled';
    const src = known(`msg.signals.from.${item.source || 'unknown'}`, 'msg.signals.from.unknown');
    return `<div class="q-state"><span class="st-pill ${handled ? 'ok' : 'crisis'}">${ico(handled ? 'check-circle' : 'warning')}${handled ? t('msg.signals.pill.handled') : `${t('msg.signals.pill.crisis')} · ${esc(when(item.created_at).replace(' назад', ''))}`}</span></div><div class="q-main"><b>${name} · ${t('msg.signals.crisis.phrase')}</b><p class="quote q-quote" data-testid="msg.signals.quote">${esc(item.quote || t('msg.v3.signals.safety'))}</p><p class="q-meta">${src}${item.due_at ? ` · ${t('msg.signals.reply')} ${ruDue(item.due_at)}` : ''}</p><p class="q-meta" data-testid="msg.signals.shown_112">${t('msg.signals.shown_112')}</p><p class="q-meta" data-testid="msg.signals.status.${esc(item.status)}">${
      item.status === 'in_work'
        ? `${t('msg.v3.signals.taken')} ${esc(item.taken_by?.name || '')}`
        : t(`msg.signals.status.${item.status}`)
            .replace('{name}', esc(item.taken_by?.name || ''))
            .replace(item.taken_by?.at ? '{time}' : ', {time}', item.taken_by?.at ? esc(when(item.taken_by.at)) : '')
    }</p></div><div class="q-act acts">${item.status === 'new' ? btn('msg.signals.take', t('msg.signals.take'), 'primary') : ''}${item.status !== 'handled' && mine ? btn('msg.signals.contacted', t('msg.signals.contacted')) : ''}${item.can_open_chart ? `<a class="link" href="/work/patients/${Number(item.patient?.id)}">${t('msg.v3.signals.chart')}</a>` : ''}</div>${item.status === 'in_work' && item.taken_by?.id === me?.id ? `<div class="q-more sig-outcome"><label>${t('msg.v3.signals.note')}<textarea data-note maxlength="500"></textarea></label><label>${t('msg.v3.signals.outcome')}<select data-outcome>${['contacted_safe', 'referred', 'emergency', 'no_contact', 'other'].map((value) => `<option value="${value}">${t(`msg.v3.outcome.${value}`)}</option>`).join('')}</select></label><div class="acts">${btn('msg.v3.signals.outcome', t('msg.v3.signals.outcome'), 'primary')}${btn('msg.v3.signals.release', t('msg.v3.signals.release'))}</div></div>` : ''}`;
  };
  // Раскладка «список — детали»: очередь слева, выбранный сигнал справа (по умолчанию самый срочный — первый).
  const sideBox = q('[data-signals-side]');
  let selectedKey = null;
  const sideRow = (item) => {
    const key = `${item.kind}-${item.id}`;
    const name = esc(item.patient?.name || `П-${item.patient?.id}`);
    const isAe = item.kind === 'ae';
    const snippet = esc(String((isAe ? item.text : item.quote) || '').slice(0, 60));
    const meta = [
      isAe ? t('msg.v3.ae.title') : 'Кризис',
      snippet,
      esc(when(item.created_at || item.submitted_at || '')),
    ]
      .filter(Boolean)
      .join(' · ');
    return `<a href="#" class="th${key === selectedKey ? ' on' : ''}" data-ssel="${key}"><span class="dotc ${isAe ? 'y' : 'r'}" aria-hidden="true"></span> <span>${name}</span><br><small class="lib-row-sub">${meta}</small></a>`;
  };
  const syncSelection = (items) => {
    const keys = items.map((item) => `${item.kind}-${item.id}`);
    if (!selectedKey || !keys.includes(selectedKey)) selectedKey = keys[0] || null;
    const emptyBox = q('[data-sig-empty]', root);
    if (items.length) emptyBox?.remove();
    else if (!emptyBox)
      list.insertAdjacentHTML(
        'afterend',
        `<div class="empty" data-sig-empty>${ico('check-circle')}<h3>${t('msg.signals.empty')}</h3></div>`,
      );
    if (sideBox)
      sideBox.innerHTML = items.length
        ? items.map(sideRow).join('')
        : `<p class="small muted">${t('msg.signals.empty')}</p>`;
  };
  sideBox?.addEventListener('click', (event) => {
    const link = event.target.closest('[data-ssel]');
    if (!link) return;
    event.preventDefault();
    selectedKey = link.dataset.ssel;
    list.querySelectorAll('[data-signal]').forEach((article) => {
      article.hidden = article.dataset.signal !== selectedKey;
    });
    sideBox.querySelectorAll('[data-ssel]').forEach((row) => row.classList.toggle('on', row === link));
  });
  const load = async (force = null) => {
    const result = await get(`/api/v1/signals?kind=${kind}&status=${status}`);
    if (!result.response.ok) return errorMessage(root, result.data);
    const keys = new Set();
    for (const item of result.data.items || []) {
      const key = `${item.kind}-${item.id}`;
      keys.add(key);
      let article = q(`[data-signal="${key}"]`, list);
      const signature = JSON.stringify(item);
      if (article && signatures.get(key) === signature && force !== key) continue;
      if (article && article.contains(document.activeElement) && force !== key) continue;
      if (!article) {
        article = document.createElement('article');
        article.className = `card qrow qrow--${item.kind === 'ae' ? 'ae' : 'crisis'}`;
        article.dataset.signal = key;
        article.dataset.id = item.id;
        article.dataset.kind = item.kind;
        list.append(article);
      }
      const aeCommentDraft = q('[data-ae-comment]', article)?.value;
      const noteDraft = q('[data-note]', article)?.value;
      const outcomeDraft = q('[data-outcome]', article)?.value;
      const feedback = q('[data-undo-holder]', article);
      const editor = q('[data-notice]', article);
      article.innerHTML = draw(item);
      if (force !== key && aeCommentDraft !== undefined && q('[data-ae-comment]', article))
        q('[data-ae-comment]', article).value = aeCommentDraft;
      if (force !== key && noteDraft !== undefined && q('[data-note]', article))
        q('[data-note]', article).value = noteDraft;
      if (force !== key && outcomeDraft !== undefined && q('[data-outcome]', article))
        q('[data-outcome]', article).value = outcomeDraft;
      if (feedback) article.append(feedback);
      if (editor) q('.ae-flow', article)?.append(editor);
      signatures.set(key, signature);
    }
    list.querySelectorAll('[data-signal]').forEach((article) => {
      if (!keys.has(article.dataset.signal)) {
        article.remove();
        signatures.delete(article.dataset.signal);
      }
    });
    // очередь: сначала кризисы, затем побочные эффекты; необработанные выше обработанных
    const rank = (item) => (item.status === 'handled' ? 2 : 0) + (item.kind === 'crisis' ? 0 : 1);
    [...(result.data.items || [])]
      .sort((x, y) => rank(x) - rank(y))
      .forEach((item) => {
        const article = q(`[data-signal="${item.kind}-${item.id}"]`, list);
        if (article) list.append(article);
      });
    syncSelection(result.data.items || []);
  };
  root.addEventListener('v3-refresh', () => load());
  await load();
  await counts();
  mark();
  const tick = async () => {
    if (!root.isConnected) return;
    try {
      await load();
      await counts();
    } catch (_) {
      /* retain open cards */
    }
    setTimeout(tick, 5000);
  };
  setTimeout(tick, 5000);
  root.addEventListener('click', async (event) => {
    if (event.target.closest(tid('msg.v3.signals.all'))) {
      kind = 'all';
      status = 'all';
      mark();
      return load();
    }
    if (event.target.closest(tid('msg.signals.filter.ae'))) {
      kind = 'ae';
      status = 'all';
      mark();
      return load();
    }
    if (event.target.closest(tid('msg.v3.signals.crisis'))) {
      kind = 'crisis';
      status = 'all';
      mark();
      return load();
    }
    if (event.target.closest(tid('msg.signals.filter.handled'))) {
      kind = 'all';
      status = 'handled';
      mark();
      return load();
    }
    const article = event.target.closest('[data-signal]');
    if (!article) return;
    const id = article.dataset.id,
      key = article.dataset.signal;
    for (const [action, testid] of [
      ['take', 'msg.signals.take'],
      ['contacted', 'msg.signals.contacted'],
      ['outcome', 'msg.v3.signals.outcome'],
      ['release', 'msg.v3.signals.release'],
    ])
      if (event.target.closest(tid(testid))) {
        const result = await post(`/api/v1/signals/${id}/${action}`, {
          note: q('[data-note]', article)?.value,
          outcome: q('[data-outcome]', article)?.value,
        });
        if (!result.response.ok) return errorMessage(article, result.data);
        await load(key);
        const holder = q(`[data-signal="${key}"]`, list);
        if (holder)
          undoControl(
            holder,
            result.data,
            action === 'take'
              ? 'msg.undo.signal_taken'
              : action === 'contacted'
                ? 'msg.undo.signal_contacted'
                : 'msg.v3.action.saved',
          );
        return;
      }
    for (const [decision, testid] of [
      ['probable', 'msg.signals.ae.likely'],
      ['unrelated', 'msg.v3.ae.unrelated'],
      ['insufficient', 'msg.v3.ae.insufficient'],
    ])
      if (event.target.closest(tid(testid))) {
        const result = await post(`/api/v1/adverse-events/${id}/decision`, {
          decision,
          serious: Boolean(q('[data-serious]', article)?.checked),
          comment: q('[data-ae-comment]', article)?.value || '',
        });
        if (!result.response.ok) return errorMessage(article, result.data);
        await load(key);
        const updated = q(`[data-signal="${key}"]`, list);
        if (updated) {
          undoControl(updated, result.data, 'msg.v3.action.saved');
          if (decision === 'probable')
            q('.ae-flow', updated).insertAdjacentHTML(
              'afterbegin',
              `<p data-testid="msg.signals.ae.deadlines">${t('msg.signals.ae.deadlines').replace('{pv}', esc(pvWho()))}</p>`,
            );
        }
        return;
      }
    if (event.target.closest(tid('msg.signals.notice.open'))) {
      const result = await get(`/api/v1/adverse-events/${id}/notice`);
      if (!result.response.ok) return errorMessage(article, result.data);
      const flow = q('.ae-flow', article);
      q('[data-notice]', flow)?.remove();
      flow.insertAdjacentHTML(
        'beforeend',
        `<section data-notice data-version="${result.data.version}"><p data-testid="msg.signals.notice.manual">${t('msg.signals.notice.manual')}</p><p class="small" data-testid="msg.v3.notice.send_ways">${t('msg.v3.notice.send_ways')}</p><p class="small" data-testid="msg.v3.notice.deadline">${t('msg.v3.notice.deadline')}</p><p class="small warn" data-notice-missing ${(result.data.missing || []).length ? '' : 'hidden'}>${t('msg.v3.notice.missing').replace('{fields}', esc((result.data.missing || []).map((name) => noticeShortLabel(name)).join(', ')))}</p>${Object.entries(
          result.data.fields,
        )
          .map(
            ([name, value]) =>
              `<label>${t(`msg.v3.notice.${name}`)}<textarea data-notice-field="${esc(name)}" rows="${NOTICE_LONG_FIELDS.includes(name) ? 5 : 1}">${esc(typeof value === 'string' ? value : JSON.stringify(value))}</textarea></label>`,
          )
          .join(
            '',
          )}${button('msg.v3.notice.save', t('msg.v3.notice.save'))}${button('msg.v3.notice.copy', t('msg.v3.notice.copy'))}<a data-testid="msg.signals.notice.download" href="/api/v1/adverse-events/${id}/notice/file?format=pdf">${t('msg.signals.notice.download')} PDF</a> <a href="/api/v1/adverse-events/${id}/notice/file?format=docx">DOCX</a></section>`,
      );
    }
    if (event.target.closest(tid('msg.v3.notice.copy'))) {
      const editor = q('[data-notice]', article);
      const text = [...editor.querySelectorAll('[data-notice-field]')]
        .filter((field) => field.value.trim())
        .map((field) => `${noticeShortLabel(field.dataset.noticeField)}: ${field.value.trim()}`)
        .join('\n');
      try {
        await navigator.clipboard.writeText(text);
        errorMessage(editor, { error: { key: 'msg.v3.notice.copied' } });
      } catch (_) {
        errorMessage(editor, { error: { key: 'msg.tpl.copy_failed' } });
      }
    }
    if (event.target.closest(tid('msg.v3.notice.save'))) {
      const editor = q('[data-notice]', article);
      const fields = Object.fromEntries(
        [...editor.querySelectorAll('[data-notice-field]')].map((field) => [field.dataset.noticeField, field.value]),
      );
      const result = await put(`/api/v1/adverse-events/${id}/notice`, {
        version: Number(editor.dataset.version),
        fields,
      });
      if (!result.response.ok) return errorMessage(editor, result.data);
      editor.dataset.version = result.data.version;
      errorMessage(editor, { error: { key: 'msg.v3.draft.saved' } });
    }
  });
}

function offline() {
  const input = q(tid('msg.composer.attach.photo'));
  const root = q('#v2-offline');
  if (!input || !root) return;
  input.addEventListener(
    'change',
    () =>
      (root.innerHTML =
        '<p data-testid="msg.offline.source">Исходник</p><p data-testid="msg.offline.recognized">Распознано</p><p data-testid="msg.offline.draft">Черновик</p>' +
        button('msg.offline.save', 'Сохранить')),
  );
}
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const response = await fetch('/assets/ru.json');
    if (response.ok) uiTexts = await response.json();
  } catch (_) {
    /* Keep controls usable with their text keys when the dictionary is unavailable. */
  }
  meds();
  tests();
  diary();
  card();
  offline();
  chat();
  adverseEvent();
  doctor();
  visits();
  signals();
});

// Короткая подпись поля извещения для сообщений и копирования: без «*» и перечня вариантов в скобках.
function noticeShortLabel(name) {
  return t(`msg.v3.notice.${name}`).replace(/\s*\*/g, '').split(' (')[0];
}

// Длинные текстовые поля извещения; остальные — в одну строку.
const NOTICE_LONG_FIELDS = ['description', 'other_medications', 'measures', 'outcome', 'reporter_comment'];
