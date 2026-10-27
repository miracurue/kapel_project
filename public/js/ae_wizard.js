'use strict';

/**
 * Карточка-опрос о побочном действии лекарства (пакет C плана 2026-10-23-ae-intake).
 * Один общий компонент для чата пациента, врача и психолога: по одному вопросу за шаг, не больше трёх,
 * счётчик «1/3», «Подтвердить», «Назад» и «Закрыть» (закрывает без отправки).
 *
 *   const card = AeWizard.mount(container, {
 *     mode: 'patient' | 'psychiatrist' | 'psychologist',
 *     prefill: { text, symptoms, severity, related, started_on },
 *     meds: [{ item_key, name }],       // действующие препараты плана; психологу не передаются
 *     whoSees: 'Увидит ваш психиатр …',  // необязательная строка на последнем шаге
 *     doctorLink: '/app?tab=doctor',     // необязательно: ссылка «Написать врачу» после «ничего не принимаю»
 *     fullFormHref: '/app?tab=meds&flow=ae', // необязательно: ссылка на полную форму
 *     onSubmit(payload) → Promise<data>,  // отправка; ошибка (reject, необязательно с messageKey — ключом текста) оставляет карточку открытой
 *     onClose({ reason }),               // reason: 'closed' | 'submitted' | 'not_adverse'
 *   });
 *   card.ready → Promise (тексты загружены, карточка нарисована); card.destroy().
 *
 * payload (поля тела POST, без source и thread_id — их добавляет вызывающий):
 *   пациент    { text, started_on?, symptoms[], severity, related, med }
 *   психиатр   { text, started_on?, symptoms[], severity, med, decision, serious }
 *   психолог   { text, started_on?, symptoms[], severity, med: { kind: 'other', name } }
 * med: { kind: 'plan_item', item_key } | { kind: 'other', name } | { kind: 'none' } (только пациент).
 * «Ничего не принимаю» отправляется сразу на втором шаге; ответ { not_adverse: true } даёт мягкое завершение.
 * Тексты — ключи msg.ae.wizard.* из locales/ru.json (/assets/ru.json); data-testid = ключ текста.
 */
(function () {
  const SEVERITY = ['mild', 'noticeable', 'severe'];
  const SEVERITY_KEY = { mild: 'msg.ae.severity.1', noticeable: 'msg.ae.severity.2', severe: 'msg.ae.severity.3' };
  const RELATED = ['yes', 'no', 'unknown'];
  const DECISIONS = ['probable', 'unrelated', 'insufficient'];
  const SYMPTOM_KEY = {
    nausea: 'msg.ae.chip.nausea',
    headache: 'msg.ae.chip.headache',
    dizziness: 'msg.ae.chip.dizzy',
    insomnia: 'msg.ae.chip.insomnia',
    sleepy: 'msg.ae.chip.sleepy',
  };

  let textsPromise = null;
  function loadTexts() {
    if (!textsPromise)
      textsPromise = fetch('/assets/ru.json')
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}));
    return textsPromise;
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v === true ? '' : v);
    });
    children.flat().forEach((c) => {
      if (c) node.append(c);
    });
    return node;
  }

  const today = () => new Date().toISOString().slice(0, 10);
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  // Из подсказки модели: severity 1..3 | mild.., related likely|possible|unlikely|yes|no.
  function normSeverity(v) {
    if (SEVERITY.includes(v)) return v;
    const n = Number(v);
    return n >= 1 && n <= 3 ? SEVERITY[n - 1] : '';
  }
  function normRelated(v) {
    if (RELATED.includes(v)) return v;
    return { likely: 'yes', unlikely: 'no', possible: 'unknown' }[v] || 'unknown';
  }

  function mount(container, opts) {
    const mode = ['patient', 'psychiatrist', 'psychologist'].includes(opts.mode) ? opts.mode : 'patient';
    const prefill = opts.prefill || {};
    const meds = (opts.meds || [])
      .map((m) => ({ item_key: m.item_key, name: m.name || m.inn_name || '' }))
      .filter((m) => m.item_key && m.name);
    const useList = mode !== 'psychologist' && meds.length > 0;
    let T = {};
    const tx = (key, vars) =>
      Object.entries(vars || {}).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), T[key] || key);

    const state = {
      step: 0,
      text: '',
      started_on: prefill.started_on || '',
      med: '', // 'plan:<key>' | 'other' | 'none' | ''
      medName: '',
      // Тяжесть и связь выбирает человек: prefill.severity/related из подсказки модели не используются.
      severity: normSeverity(null),
      related: normRelated(null),
      decision: '',
      serious: '',
    };
    const symptoms = Array.isArray(prefill.symptoms) ? prefill.symptoms.filter(Boolean).map(String).slice(0, 5) : [];
    let busy = false;
    let finished = false;
    let card = null;
    let focusNext = false;
    const total = 3;

    const symptomText = () =>
      symptoms
        .map((s) => (SYMPTOM_KEY[s] && T[SYMPTOM_KEY[s]] ? T[SYMPTOM_KEY[s]] : ''))
        .filter(Boolean)
        .join(', ');

    function medPayload() {
      if (mode === 'psychologist') return { kind: 'other', name: state.medName.trim() };
      if (state.med.startsWith('plan:')) return { kind: 'plan_item', item_key: state.med.slice(5) };
      if (state.med === 'none') return { kind: 'none' };
      return { kind: 'other', name: state.medName.trim() };
    }

    function payload() {
      const body = {
        text: state.text.trim(),
        symptoms,
        severity: state.severity,
        med: medPayload(),
      };
      if (state.started_on) body.started_on = state.started_on;
      if (mode === 'patient') body.related = state.related;
      if (mode === 'psychiatrist') {
        body.decision = state.decision;
        body.serious = state.serious === 'yes';
      }
      return body;
    }

    function close(reason) {
      if (finished) return;
      finished = true;
      if (reason !== 'not_adverse') card.remove();
      if (opts.onClose) opts.onClose({ reason });
    }

    // ---- разметка ----
    function choice(name, value, label, checked, onChange) {
      const input = el('input', { type: 'radio', name, value });
      input.checked = checked;
      input.addEventListener('change', () => onChange(value));
      return el('label', { class: 'choice' }, input, el('span', { text: label }));
    }

    function legend(text, id) {
      return el('legend', { class: 'ae-wiz__q', tabindex: '-1', id, 'data-ae-q': '', text });
    }

    function stepWhat() {
      const area = el('textarea', {
        rows: '3',
        maxlength: '1000',
        'aria-labelledby': 'ae-q-what',
        placeholder: tx('msg.ae.wizard.what.placeholder'),
        'data-ae-field': 'text',
      });
      area.value = state.text;
      area.addEventListener('input', () => (state.text = area.value));
      const date = el('input', {
        type: 'date',
        max: today(),
        'aria-labelledby': 'ae-q-when',
        'data-ae-field': 'started_on',
      });
      date.value = state.started_on;
      date.addEventListener('change', () => (state.started_on = date.value));
      const quick = el(
        'div',
        { class: 'ae-wiz__quick' },
        [
          ['msg.ae.when.today', 0],
          ['msg.ae.when.yesterday', 1],
          ['msg.ae.when.days', 3],
        ].map(([key, n]) => {
          const b = el('button', { type: 'button', class: 'choice', text: T[key] || key });
          b.addEventListener('click', () => {
            state.started_on = daysAgo(n);
            date.value = state.started_on;
            quick.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
          });
          return b;
        }),
      );
      return [
        el(
          'fieldset',
          { class: 'ae-wiz__step' },
          legend(tx(mode === 'patient' ? 'msg.ae.wizard.q.what' : 'msg.ae.wizard.q.what.psy'), 'ae-q-what'),
          area,
          el('p', { class: 'ae-wiz__sub', id: 'ae-q-when', text: tx('msg.ae.wizard.q.when') }),
          quick,
          date,
        ),
      ];
    }

    function stepDrug() {
      let q;
      if (!useList) q = tx(mode === 'patient' ? 'msg.ae.wizard.q.drug.text' : 'msg.ae.wizard.q.drug.text.psy');
      else if (mode === 'psychiatrist') q = tx('msg.ae.wizard.q.drug.plan.psy');
      else
        q =
          meds.length === 1 ? tx('msg.ae.wizard.q.drug.plan', { drug: meds[0].name }) : tx('msg.ae.wizard.q.drug.text');
      const field = el('fieldset', { class: 'ae-wiz__step' }, legend(q, 'ae-q-drug'));
      const nameInput = el('input', {
        type: 'text',
        maxlength: '200',
        placeholder: tx('msg.ae.wizard.drug.name'),
        'aria-label': tx('msg.ae.wizard.drug.name'),
        'data-ae-field': 'med_name',
      });
      nameInput.value = state.medName;
      nameInput.addEventListener('input', () => {
        state.medName = nameInput.value;
        if (!useList && state.med === 'none') {
          state.med = '';
          card.querySelectorAll('input[name="ae-med"]').forEach((r) => (r.checked = false));
        }
      });
      if (!useList) {
        field.append(nameInput);
        if (mode === 'patient')
          field.append(choiceList('ae-med', [['none', tx('msg.ae.wizard.drug.none')]], 'ae-med-none'));
        return [field];
      }
      const options = meds.map((m) => [`plan:${m.item_key}`, m.name]);
      options.push(['other', tx('msg.ae.wizard.drug.other')]);
      if (mode === 'patient') options.push(['none', tx('msg.ae.wizard.drug.none')]);
      const list = choiceList('ae-med', options, 'ae-med');
      field.append(list);
      nameInput.hidden = state.med !== 'other';
      list.addEventListener('change', () => {
        nameInput.hidden = state.med !== 'other';
        if (!nameInput.hidden) nameInput.focus();
      });
      field.append(nameInput);
      return [field];
    }

    function choiceList(name, options, id) {
      const box = el('div', {
        class: 'choices ae-wiz__choices',
        role: 'radiogroup',
        'aria-labelledby': 'ae-q-drug',
        'data-ae-group': id,
      });
      options.forEach(([value, label]) => {
        box.append(
          choice(name, value, label, state.med === value, (v) => {
            state.med = v;
          }),
        );
      });
      return box;
    }

    function group(title, name, options, current, onChange, id) {
      return el(
        'div',
        { class: 'ae-wiz__group' },
        title ? el('p', { class: 'ae-wiz__sub', id, text: title }) : null,
        el(
          'div',
          { class: 'choices ae-wiz__choices', role: 'radiogroup', 'aria-labelledby': title ? id : 'ae-q-assess' },
          options.map(([value, label]) => choice(name, value, label, current === value, onChange)),
        ),
      );
    }

    function stepAssess() {
      const sev = SEVERITY.map((v) => [v, T[SEVERITY_KEY[v]] || v]);
      const first = mode === 'patient' ? tx('msg.ae.wizard.q.severity') : tx('msg.ae.wizard.q.severity.psy');
      const box = el(
        'fieldset',
        { class: 'ae-wiz__step' },
        legend(mode === 'psychiatrist' ? tx('msg.ae.wizard.q.assess') : first, 'ae-q-assess'),
        group(
          mode === 'psychiatrist' ? first : null,
          'ae-sev',
          sev,
          state.severity,
          (v) => (state.severity = v),
          'ae-g-sev',
        ),
      );
      if (mode === 'patient') {
        box.append(
          group(
            tx('msg.ae.wizard.q.related'),
            'ae-rel',
            RELATED.map((v) => [v, T[`msg.ae.link.${v}`] || v]),
            state.related,
            (v) => (state.related = v),
            'ae-g-rel',
          ),
        );
      }
      if (mode === 'psychiatrist') {
        box.append(
          group(
            tx('msg.ae.wizard.decision.label'),
            'ae-dec',
            DECISIONS.map((v) => [v, tx(`msg.ae.wizard.decision.${v}`)]),
            state.decision,
            (v) => (state.decision = v),
            'ae-g-dec',
          ),
          group(
            tx('msg.ae.wizard.serious.label'),
            'ae-ser',
            [
              ['yes', tx('msg.ae.wizard.serious.yes')],
              ['no', tx('msg.ae.wizard.serious.no')],
            ],
            state.serious,
            (v) => (state.serious = v),
            'ae-g-ser',
          ),
        );
      }
      return [box];
    }

    // ---- проверка шага ----
    function check() {
      if (state.step === 0) return state.text.trim() ? '' : 'msg.ae.wizard.need.what';
      if (state.step === 1) {
        if (!useList || state.med === 'other')
          return state.medName.trim() ? '' : state.med === 'none' ? '' : 'msg.ae.wizard.need.drug';
        return state.med ? '' : 'msg.ae.wizard.need.drug';
      }
      if (!state.severity) return 'msg.ae.wizard.need.choice';
      if (mode === 'psychiatrist' && (!state.decision || !state.serious)) return 'msg.ae.wizard.need.choice';
      return '';
    }

    function showError(key) {
      const note = card.querySelector('[data-ae-error]');
      note.textContent = key ? tx(key) : '';
      if (key) note.dataset.testid = key;
      else delete note.dataset.testid;
      note.hidden = !key;
    }

    async function submit() {
      if (busy) return;
      busy = true;
      render({ keepFocus: true });
      try {
        const data = (await opts.onSubmit(payload())) || {};
        busy = false;
        if (data.not_adverse) return notAdverse();
        close('submitted');
      } catch (e) {
        busy = false;
        render({ keepFocus: true });
        // Вызывающий может назвать причину ключом текста (error.messageKey); по умолчанию общий текст.
        showError((e && e.messageKey) || 'msg.ae.wizard.error');
      }
    }

    function notAdverse() {
      finished = true;
      card.className = 'ae-wiz ae-wiz_done';
      card.replaceChildren(
        el('p', { 'data-testid': 'msg.ae.wizard.not_adverse', role: 'status', text: tx('msg.ae.wizard.not_adverse') }),
        opts.doctorLink
          ? el('a', {
              class: 'btn',
              href: opts.doctorLink,
              'data-testid': 'msg.ae.wizard.write_doctor',
              text: tx('msg.ae.wizard.write_doctor'),
            })
          : null,
      );
      if (opts.onClose) opts.onClose({ reason: 'not_adverse' });
    }

    function confirm() {
      if (busy) return;
      const problem = check();
      if (problem) return showError(problem);
      // «Ничего не принимаю»: записи НЯ не будет, сервер подтверждает ответом not_adverse.
      if (state.step === 1 && mode === 'patient' && state.med === 'none') return submit();
      if (state.step === total - 1) return submit();
      state.step += 1;
      focusNext = true;
      render();
    }

    function back() {
      if (busy || state.step === 0) return;
      state.step -= 1;
      focusNext = true;
      render();
    }

    function render(options = {}) {
      const stepNodes = [stepWhat, stepDrug, stepAssess][state.step]();
      const last = state.step === total - 1;
      const closeBtn = el('button', {
        type: 'button',
        class: 'ae-wiz__x',
        'data-testid': 'msg.ae.wizard.close',
        'aria-label': tx('msg.ae.wizard.close'),
        text: '×',
      });
      closeBtn.addEventListener('click', () => close('closed'));
      const counter = el('span', {
        class: 'ae-wiz__counter',
        'data-testid': 'msg.ae.wizard.counter',
        'data-step': String(state.step + 1),
        'aria-label': tx('msg.ae.wizard.counter.aria', { n: state.step + 1, total }),
        text: tx('msg.ae.wizard.counter', { n: state.step + 1, total }),
      });
      const next = el('button', {
        type: 'button',
        class: 'btn primary',
        'data-testid': last ? 'msg.ae.wizard.send' : 'msg.ae.wizard.confirm',
        text: tx(last ? 'msg.ae.wizard.send' : 'msg.ae.wizard.confirm'),
        disabled: busy,
      });
      next.addEventListener('click', confirm);
      const prev = el('button', {
        type: 'button',
        class: 'btn',
        'data-testid': 'msg.ae.wizard.back',
        text: tx('msg.ae.wizard.back'),
        hidden: state.step === 0,
        disabled: busy,
      });
      prev.addEventListener('click', back);
      const errorNote = el('p', { class: 'ae-wiz__error', role: 'alert', 'data-ae-error': '', hidden: true });
      const notes = [];
      if (last && opts.whoSees) notes.push(el('p', { class: 'ae-wiz__note', 'data-ae-who': '', text: opts.whoSees }));
      notes.push(
        el('p', { class: 'ae-wiz__note', 'data-testid': 'msg.ae.urgent_note', text: T['msg.ae.urgent_note'] || '' }),
      );
      if (opts.fullFormHref)
        notes.push(
          el('a', {
            class: 'ae-wiz__link',
            href: opts.fullFormHref,
            'data-testid': 'msg.ae.wizard.full_form',
            text: tx('msg.ae.wizard.full_form'),
          }),
        );
      const fresh = el(
        'div',
        {
          class: 'ae-wiz',
          role: 'group',
          'aria-labelledby': 'ae-wiz-title',
          'data-mode': mode,
          'data-ae-wizard': '',
          'aria-busy': busy ? 'true' : 'false',
        },
        el(
          'div',
          { class: 'ae-wiz__head' },
          el('p', {
            class: 'ae-wiz__title',
            id: 'ae-wiz-title',
            'data-testid': `msg.ae.wizard.title.${mode}`,
            text: tx(`msg.ae.wizard.title.${mode}`),
          }),
          closeBtn,
        ),
        counter,
        ...stepNodes,
        errorNote,
        el('div', { class: 'ae-wiz__foot' }, prev, next),
        ...notes,
      );
      fresh.addEventListener('change', () => showError(''));
      fresh.addEventListener('input', () => showError(''));
      fresh.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close('closed');
        else if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'radio') {
          e.preventDefault();
          confirm();
        }
      });
      if (card && card.parentNode) card.replaceWith(fresh);
      else container.appendChild(fresh);
      card = fresh;
      if (focusNext && !options.keepFocus) {
        focusNext = false;
        const q = card.querySelector('[data-ae-q]');
        if (q) q.focus();
      }
    }

    const handle = {
      ready: loadTexts().then((texts) => {
        T = texts;
        if (!state.text) state.text = String(prefill.text || prefill.description || '') || symptomText();
        render();
        return handle;
      }),
      destroy() {
        finished = true;
        if (card) card.remove();
      },
      get state() {
        return { ...state, step: state.step + 1 };
      },
    };
    return handle;
  }

  window.AeWizard = { mount, texts: loadTexts };
})();
