'use strict';
// Форма извещения о нежелательной реакции (бланк Росздравнадзора): поля по бланку, группы-карточки.
// Один и тот же перечень полей рисует форму для правки и вид «только чтение» для готового документа.
// Контракт полей v1 — .agents/tasks/2026-10-26-templates-and-documents.md; сервер нормализует и проверяет сам.
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const REQUIRED = ['patient_code', 'suspect_drugs.0.trade_name', 'description', 'region', 'contact'];
  const MAX = {
    previous_report_number: 20,
    patient_code: 35,
    weight_kg: 8,
    age: 24,
    pregnancy_weeks: 8,
    allergy_to: 200,
    measures_drug_text: 200,
    outcome_sequelae_text: 200,
    rechallenge_result: 40,
    region: 150,
    contact: 150,
    reporter_name: 150,
    reporter_position: 200,
    description: 2000,
  };
  const DRUG_MAX = { trade_name: 80, manufacturer: 80, batch: 30, dose_route: 80, indication: 100 };
  const DRUG_FIELDS = [
    ['trade_name', 'text'],
    ['manufacturer', 'text'],
    ['batch', 'text'],
    ['dose_route', 'text'],
    ['started_on', 'date'],
    ['stopped_on', 'date'],
    ['indication', 'text'],
  ];
  const OPTIONS = {
    report_type: ['primary', 'additional'],
    sex: ['m', 'f'],
    allergy: ['none', 'yes'],
    treatment_setting: ['outpatient', 'inpatient', 'self'],
    seriousness: [
      'death',
      'life_threat',
      'hospitalization',
      'disability',
      'congenital',
      'clinically_significant',
      'not_applicable',
    ],
    measures: ['none', 'withdrawal', 'dose_reduction', 'non_drug', 'drug'],
    outcome: ['recovered', 'improved', 'unchanged', 'recovered_sequelae', 'death', 'unknown', 'not_applicable'],
    dechallenge: ['no', 'yes', 'not_withdrawn', 'not_applicable'],
    rechallenge: ['no', 'yes'],
    reporter_category: ['doctor', 'other_hcp', 'patient', 'other'],
  };
  // Варианты, которые исключают остальные («Не применимо», «Без лечения»).
  const EXCLUSIVE = { seriousness: 'not_applicable', measures: 'none' };
  const has = (list, value) => Array.isArray(list) && list.includes(value);
  // Группы в порядке бланка. kind: choice | multi | check | text | date | area | drugs.
  const GROUPS = [
    {
      id: 'report',
      fields: [
        { name: 'report_type', kind: 'choice', wide: true },
        { name: 'previous_report_number', kind: 'text', show: (f) => f.report_type === 'additional' },
        { name: 'previous_report_date', kind: 'date', show: (f) => f.report_type === 'additional' },
      ],
    },
    {
      id: 'patient',
      fields: [
        { name: 'patient_code', kind: 'text' },
        { name: 'age', kind: 'text' },
        { name: 'weight_kg', kind: 'text', mode: 'decimal' },
        { name: 'sex', kind: 'choice' },
        { name: 'pregnant', kind: 'check' },
        { name: 'pregnancy_weeks', kind: 'text', mode: 'numeric', show: (f) => f.pregnant === true },
        { name: 'allergy', kind: 'choice' },
        { name: 'allergy_to', kind: 'text', wide: true, show: (f) => f.allergy === 'yes' },
        { name: 'treatment_setting', kind: 'choice', wide: true },
      ],
    },
    { id: 'suspect', kind: 'drugs', key: 'suspect_drugs', max: 3, min: 1 },
    {
      id: 'reaction',
      fields: [
        { name: 'reaction_started_on', kind: 'date' },
        { name: 'reaction_resolved_on', kind: 'date' },
        { name: 'description', kind: 'area', wide: true },
      ],
    },
    {
      id: 'serious',
      fields: [
        { name: 'seriousness', kind: 'multi', wide: true },
        { name: 'measures', kind: 'multi', wide: true },
        { name: 'measures_drug_text', kind: 'text', wide: true, show: (f) => has(f.measures, 'drug') },
      ],
    },
    {
      id: 'outcome',
      fields: [
        { name: 'outcome', kind: 'choice', wide: true },
        { name: 'outcome_sequelae_text', kind: 'text', wide: true, show: (f) => f.outcome === 'recovered_sequelae' },
        { name: 'dechallenge', kind: 'choice', wide: true },
        { name: 'rechallenge', kind: 'choice' },
        { name: 'rechallenge_result', kind: 'text' },
        { name: 'rechallenge_not_applicable', kind: 'check' },
      ],
    },
    { id: 'other', kind: 'drugs', key: 'other_drugs', max: 5, min: 0 },
    {
      id: 'reporter',
      fields: [
        { name: 'reporter_category', kind: 'choice', wide: true },
        { name: 'region', kind: 'text', wide: true },
        { name: 'contact', kind: 'text', hint: 'field.contact_hint' },
        { name: 'reporter_name', kind: 'text' },
        { name: 'reporter_position', kind: 'text', wide: true },
        { name: 'report_date', kind: 'date' },
      ],
    },
  ];

  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === false || value == null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const kid of kids.flat()) if (kid != null) node.append(kid);
    return node;
  }
  function icon(name) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'i');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', '/icons.svg#i-' + name);
    svg.appendChild(use);
    return svg;
  }
  const dmy = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.split('-').reverse().join('.') : iso || '');
  const getPath = (obj, path) => path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), obj);
  const filled = (v) => (typeof v === 'string' ? v.trim() !== '' : v != null && v !== false);

  // Обязательные поля бланка, которых ещё нет (те же правила, что на сервере: notice_form.validate).
  function missing(fields) {
    return REQUIRED.filter((path) => !filled(getPath(fields || {}, path)));
  }
  function ensureShape(fields) {
    fields.suspect_drugs = Array.isArray(fields.suspect_drugs) ? fields.suspect_drugs : [];
    fields.other_drugs = Array.isArray(fields.other_drugs) ? fields.other_drugs : [];
    if (!fields.suspect_drugs.length) fields.suspect_drugs.push({});
    for (const key of ['seriousness', 'measures']) if (!Array.isArray(fields[key])) fields[key] = [];
    return fields;
  }

  function build(host, { fields, readOnly = false, text, onChange = () => {} }) {
    const tx = (key, vars) =>
      Object.entries(vars || {}).reduce((s, [k, v]) => s.replaceAll('{' + k + '}', v), text(key) || key);
    ensureShape(fields);
    host.textContent = '';
    host.classList.toggle('doc-form--ro', readOnly);
    let seq = 0;
    const uid = (name) => 'df-' + name.replaceAll('.', '-') + '-' + ++seq;
    const visibilityHooks = [];

    const label = (name, required, fallbackKey) => {
      const span = el('span', { class: 'doc-lbl', text: tx(fallbackKey || 'field.' + name) });
      if (required) span.append(' ', el('span', { class: 'doc-req', 'aria-hidden': 'true', text: '*' }));
      return span;
    };
    const optionLabel = (name, value) => tx('opt.' + name + '.' + value);
    const touch = () => {
      onChange();
      for (const refresh of visibilityHooks) refresh();
    };
    const clearInvalid = (input) => input.removeAttribute('aria-invalid');

    // ----- поля для правки -----
    function textField(holder, path, def, labelKey, required) {
      const id = uid(path);
      const area = def.kind === 'area';
      const input = el(area ? 'textarea' : 'input', {
        id,
        'data-field': path,
        type: area ? false : def.kind === 'date' ? 'date' : 'text',
        rows: area ? '7' : false,
        maxlength: def.kind === 'date' ? false : String(def.max || MAX[path.split('.').pop()] || 200),
        inputmode: def.mode || false,
        autocomplete: 'off',
        'aria-required': required ? 'true' : false,
        'aria-describedby': def.hint ? id + '-h' : area ? id + '-h' : false,
      });
      input.value = getPath(fields, path) ?? '';
      input.addEventListener('input', () => {
        const parts = path.split('.');
        let target = fields;
        for (const part of parts.slice(0, -1)) target = target[part];
        target[parts.at(-1)] = input.value;
        clearInvalid(input);
        if (counter) counter.textContent = input.value.length + ' / ' + input.maxLength;
        touch();
      });
      let counter = null;
      const wrap = el(
        'div',
        { class: 'field doc-field' + (def.wide || area ? ' doc-wide' : ''), 'data-field-wrap': path },
        el('label', { for: id }, label(path.split('.').pop(), required, labelKey)),
        input,
      );
      if (def.hint) wrap.append(el('span', { id: id + '-h', class: 'hint', text: tx(def.hint) }));
      if (area) {
        counter = el('span', {
          id: id + '-h',
          class: 'hint doc-count',
          text: input.value.length + ' / ' + input.maxLength,
        });
        wrap.append(counter);
      }
      holder.append(wrap);
      return wrap;
    }
    function choiceField(holder, def) {
      const name = def.name;
      const multi = def.kind === 'multi';
      const group = uid(name);
      const clear = el('button', { type: 'button', class: 'linkish doc-clear', text: tx('clear') });
      const inputs = [];
      const sync = () => {
        for (const input of inputs)
          input.checked = multi ? has(fields[name], input.value) : fields[name] === input.value;
        clear.hidden = multi ? true : !fields[name];
      };
      const options = el('div', { class: 'choices' });
      for (const value of OPTIONS[name]) {
        const input = el('input', { type: multi ? 'checkbox' : 'radio', name: group, value, 'data-field': name });
        input.addEventListener('change', () => {
          if (multi) {
            let list = fields[name].filter((x) => x !== value);
            if (input.checked) {
              list = EXCLUSIVE[name] === value ? [value] : list.filter((x) => x !== EXCLUSIVE[name]);
              list.push(value);
            }
            fields[name] = list;
          } else fields[name] = input.checked ? value : '';
          sync();
          touch();
        });
        inputs.push(input);
        options.append(el('label', { class: 'choice' }, input, el('span', { text: optionLabel(name, value) })));
      }
      clear.addEventListener('click', () => {
        fields[name] = '';
        sync();
        touch();
        inputs[0].focus();
      });
      sync();
      const wrap = el(
        'fieldset',
        { class: 'doc-choice' + (def.wide ? ' doc-wide' : ''), 'data-field-wrap': name },
        el('legend', null, label(name, false)),
        options,
        clear,
      );
      holder.append(wrap);
      return wrap;
    }
    function checkField(holder, def) {
      const name = def.name;
      const input = el('input', { type: 'checkbox', id: uid(name), 'data-field': name });
      input.checked = Boolean(fields[name]);
      input.addEventListener('change', () => {
        fields[name] = name === 'pregnant' ? (input.checked ? true : null) : input.checked;
        touch();
      });
      const wrap = el(
        'div',
        { class: 'doc-field doc-check', 'data-field-wrap': name },
        el('label', { class: 'choice' }, input, el('span', { text: tx('field.' + name) })),
      );
      holder.append(wrap);
      return wrap;
    }
    function drugCard(group, title) {
      const list = fields[group.key];
      const card = el('section', {
        class: 'card doc-card',
        'data-group': group.id,
        'aria-labelledby': 'dg-' + group.id,
      });
      const head = el(
        'div',
        { class: 'doc-card-head' },
        el('h3', { id: 'dg-' + group.id, text: title }),
        el('p', { class: 'hint', text: tx('g.' + group.id + '.hint') }),
      );
      const body = el('div', { class: 'doc-drugs' });
      const add = el(
        'button',
        { type: 'button', class: 'btn sm', 'data-add': group.key },
        icon('plus'),
        el('span', { text: tx('drug.add') }),
      );
      const limit = el('p', { class: 'hint', text: tx('drug.limit'), hidden: true });
      const paint = (focusIndex) => {
        body.textContent = '';
        if (!list.length) body.append(el('p', { class: 'doc-none', text: tx('g.other.empty') }));
        list.forEach((drug, index) => {
          const grid = el('div', { class: 'doc-grid' });
          const path = (key) => group.key + '.' + index + '.' + key;
          for (const [key, kind] of DRUG_FIELDS) {
            const required = group.key === 'suspect_drugs' && index === 0 && key === 'trade_name';
            textField(
              grid,
              path(key),
              { kind, max: DRUG_MAX[key], wide: key === 'trade_name' },
              'field.' + key,
              required,
            );
          }
          const remove = el(
            'button',
            { type: 'button', class: 'btn sm ghost', 'aria-label': tx('drug.remove', { n: index + 1 }) },
            icon('trash'),
            el('span', { text: tx('drug.remove_short') }),
          );
          remove.addEventListener('click', () => {
            list.splice(index, 1);
            if (group.min && !list.length) list.push({});
            paint(Math.max(0, index - 1));
            touch();
          });
          const headRow = el('div', { class: 'doc-drug-head' }, el('b', { text: tx('drug.n', { n: index + 1 }) }));
          if (list.length > group.min) headRow.append(remove);
          body.append(el('div', { class: 'doc-drug inset', 'data-drug': group.key + '.' + index }, headRow, grid));
        });
        add.disabled = list.length >= group.max;
        limit.hidden = list.length < group.max;
        if (focusIndex != null) body.querySelector('[data-drug="' + group.key + '.' + focusIndex + '"] input')?.focus();
      };
      add.addEventListener('click', () => {
        if (list.length >= group.max) return;
        list.push({});
        paint(list.length - 1);
        touch();
      });
      paint();
      card.append(head, body, el('div', { class: 'doc-add' }, add, limit));
      return card;
    }

    // ----- вид «только чтение» -----
    function valueOf(def) {
      const v = fields[def.name];
      if (def.kind === 'choice') return v ? optionLabel(def.name, v) : '';
      if (def.kind === 'multi') return (v || []).map((x) => optionLabel(def.name, x));
      if (def.kind === 'check') return v ? tx('yes') : '';
      if (def.kind === 'date') return dmy(v);
      return v == null ? '' : String(v);
    }
    function readRow(dl, name, value, labelKey) {
      const dt = el('dt', { text: tx(labelKey || 'field.' + name) });
      const dd = el('dd');
      if (Array.isArray(value)) {
        if (value.length)
          dd.append(
            el(
              'ul',
              null,
              value.map((x) => el('li', { text: x })),
            ),
          );
      } else if (value) dd.textContent = value;
      if (!dd.childNodes.length) {
        dd.className = 'doc-empty';
        dd.textContent = tx('empty_value');
      }
      dl.append(dt, dd);
    }
    function readCard(group) {
      const title = tx('g.' + group.id);
      const card = el('section', {
        class: 'card doc-card',
        'data-group': group.id,
        'aria-labelledby': 'dg-' + group.id,
      });
      card.append(el('div', { class: 'doc-card-head' }, el('h3', { id: 'dg-' + group.id, text: title })));
      if (group.kind === 'drugs') {
        const list = fields[group.key].filter((d) => Object.values(d || {}).some(filled));
        if (!list.length) card.append(el('p', { class: 'doc-none', text: tx('g.other.empty') }));
        list.forEach((drug, index) => {
          const dl = el('dl', { class: 'doc-dl' });
          for (const [key, kind] of DRUG_FIELDS) readRow(dl, key, kind === 'date' ? dmy(drug[key]) : drug[key]);
          card.append(el('div', { class: 'doc-drug inset' }, el('b', { text: tx('drug.n', { n: index + 1 }) }), dl));
        });
        return card;
      }
      const dl = el('dl', { class: 'doc-dl' });
      for (const def of group.fields) {
        if (def.show && !def.show(fields)) continue;
        readRow(dl, def.name, valueOf(def));
      }
      card.append(dl);
      return card;
    }

    // ----- сборка -----
    function editCard(group) {
      const title = tx('g.' + group.id);
      if (group.kind === 'drugs') return drugCard(group, title);
      const card = el('section', {
        class: 'card doc-card',
        'data-group': group.id,
        'aria-labelledby': 'dg-' + group.id,
      });
      card.append(
        el(
          'div',
          { class: 'doc-card-head' },
          el('h3', { id: 'dg-' + group.id, text: title }),
          group.id === 'serious' ? el('p', { class: 'hint', text: tx('g.serious.hint') }) : null,
        ),
      );
      const grid = el('div', { class: 'doc-grid' });
      for (const def of group.fields) {
        let wrap;
        if (def.kind === 'choice' || def.kind === 'multi') wrap = choiceField(grid, def);
        else if (def.kind === 'check') wrap = checkField(grid, def);
        else wrap = textField(grid, def.name, def, null, REQUIRED.includes(def.name));
        if (def.show) {
          const refresh = () => {
            wrap.hidden = !def.show(fields);
          };
          refresh();
          visibilityHooks.push(refresh);
        }
      }
      card.append(grid);
      return card;
    }
    for (const group of GROUPS) host.append(readOnly ? readCard(group) : editCard(group));

    return {
      missing: () => missing(fields),
      // Перейти к полю из списка «Не заполнено»: прокрутить и поставить фокус.
      focusField(path) {
        const input = host.querySelector('[data-field="' + path + '"]');
        if (!input) return false;
        input.scrollIntoView({ block: 'center' });
        input.focus({ preventScroll: true });
        return true;
      },
      markInvalid(paths) {
        for (const node of host.querySelectorAll('[aria-invalid]')) node.removeAttribute('aria-invalid');
        for (const path of paths)
          host.querySelector('[data-field="' + path + '"]')?.setAttribute('aria-invalid', 'true');
      },
    };
  }

  window.NoticeForm = { build, missing, REQUIRED };
})();
