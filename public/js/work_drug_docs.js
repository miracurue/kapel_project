'use strict';

/**
 * Инструкции препарата в карточке чата специалиста (волна 3, F2): список документов, оглавление,
 * полный текст раздела с «Показать дальше», поиск по тексту инструкций, источники под ответом ИИ.
 * Текст инструкции никогда не попадает в innerHTML: Markdown разбирается в DOM-узлы через textContent.
 * Тексты — словарь instr (ключи msg.drugs.instr.*), передаётся из work_chat.js.
 */
(function () {
  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function getJson(path) {
    try {
      const res = await fetch(path, { headers: { Accept: 'application/json' } });
      return { ok: res.ok, data: await res.json().catch(() => ({})) };
    } catch (_) {
      return { ok: false, data: {} };
    }
  }

  // ---- безопасный Markdown: заголовки, списки, абзацы, **жирный**, *курсив*, таблицы |a|b| ----

  // cite(n) -> узел для ссылки на источник [n] или null; без cite «[n]» остаётся обычным текстом.
  function inline(parent, text, cite) {
    // «<br>» внутри ячеек таблиц источника — перенос строки (остальной HTML остаётся текстом).
    if (/<br\s*\/?>/i.test(text)) {
      text.split(/<br\s*\/?>/i).forEach((part, i) => {
        if (i) parent.appendChild(el('br'));
        inline(parent, part, cite);
      });
      return;
    }
    const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[\d+(?:\s*[,;]\s*\d+)*\])/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const tok = m[0];
      if (tok.startsWith('[')) {
        const nums = tok
          .slice(1, -1)
          .split(/[,;]/)
          .map((x) => Number(x.trim()));
        const nodes = cite ? nums.map((n) => cite(n)) : [];
        if (nodes.length && nodes.every(Boolean)) nodes.forEach((n) => parent.appendChild(n));
        else parent.appendChild(document.createTextNode(tok));
      } else if (tok.startsWith('`')) parent.appendChild(el('code', {}, tok.slice(1, -1)));
      else if (tok.startsWith('**')) parent.appendChild(el('strong', {}, tok.slice(2, -2)));
      else parent.appendChild(el('em', {}, tok.slice(1, -1)));
      last = m.index + tok.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
  const isSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
  const isRow = (line) => line.trim().startsWith('|') || (line.includes('|') && line.trim().endsWith('|'));

  // opts.breaks — одиночный перенос строки остаётся переносом (чат пациента), opts.plainLinks — [текст](адрес) показывается
  // как текст без ссылки (в чате пациента ИИ не ведёт на сторонние адреса).
  function renderMarkdown(markdown, opts) {
    const cite = opts && opts.cite;
    const breaks = Boolean(opts && opts.breaks);
    const out = document.createDocumentFragment();
    // Служебные пометки импорта («<!-- Страница 3 -->») читателю не нужны.
    let source = String(markdown || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\r\n?/g, '\n');
    if (opts && opts.plainLinks) source = source.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1');
    const lines = source.split('\n');
    let para = [];
    let list = null;
    const flush = () => {
      if (!para.length) return;
      const p = el('p');
      if (breaks)
        para.forEach((line, i) => {
          if (i) p.appendChild(el('br'));
          inline(p, line, cite);
        });
      else inline(p, para.join(' '), cite);
      out.appendChild(p);
      para = [];
    };
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      const head = /^(#{1,6})\s+(.+)$/.exec(line);
      const item = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
      const ordered = /^\d+[.)]\s/.test(line);
      if (!item) list = null;
      else if (list && list.tagName !== (ordered ? 'OL' : 'UL')) list = null;
      if (line.startsWith('```')) {
        flush();
        const code = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
        out.appendChild(el('pre', { class: 'md-code' })).appendChild(el('code', {}, code.join('\n')));
        continue;
      }
      if (/^(-{3,}|\*{3,})$/.test(line)) {
        flush();
        out.appendChild(el('hr'));
        continue;
      }
      if (!line) {
        flush();
      } else if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
        flush();
        const wrap = el('div', { class: 'tbl-wrap', tabindex: '0', role: 'region' });
        const table = el('table', { class: 'tbl drug-doc-table' });
        const thead = el('thead');
        const tr = el('tr');
        for (const c of cells(line)) {
          const th = el('th', { scope: 'col' });
          inline(th, c, cite);
          tr.appendChild(th);
        }
        thead.appendChild(tr);
        table.appendChild(thead);
        const tbody = el('tbody');
        i += 2;
        while (i < lines.length && lines[i].trim() && isRow(lines[i])) {
          const row = el('tr');
          for (const c of cells(lines[i])) {
            const td = el('td');
            inline(td, c, cite);
            row.appendChild(td);
          }
          tbody.appendChild(row);
          i += 1;
        }
        i -= 1;
        table.appendChild(tbody);
        wrap.appendChild(table);
        out.appendChild(wrap);
      } else if (head) {
        flush();
        const h = el(head[1].length <= 2 ? 'h4' : 'h5', { class: 'drug-doc-h' });
        inline(h, head[2], cite);
        out.appendChild(h);
      } else if (item) {
        flush();
        if (!list) {
          list = el(ordered ? 'ol' : 'ul');
          out.appendChild(list);
        }
        const li = el('li');
        inline(li, item[1], cite);
        list.appendChild(li);
      } else {
        para.push(line);
      }
    }
    flush();
    return out;
  }

  function create(opts) {
    const T = (opts && opts.text) || {};
    const base = '/work/api/drugs';
    const fmt = (s, vars) => String(s || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? '' : vars[k]));

    function pathLabel(item) {
      return [item.label, item.path, item.page ? fmt(T.page, { n: item.page }) : ''].filter(Boolean).join(' · ');
    }

    // ---- документ инструкции: главы (разделы 1–9) сворачиваются, текст главы подгружается при раскрытии ----
    function renderDocument(box, innId, doc) {
      box.textContent = '';
      box.appendChild(el('p', { class: 'small muted', role: 'status' }, T.loading));
      getJson(`${base}/${encodeURIComponent(innId)}/instructions/${encodeURIComponent(doc.id)}/toc`).then((res) => {
        box.textContent = '';
        const items = (res.data && res.data.items) || [];
        if (!res.ok || !items.length || !window.CCSources) {
          box.appendChild(
            el(
              'p',
              { class: 'small muted' },
              res.ok && items.length ? T.load_failed : res.ok ? T.toc_empty : T.load_failed,
            ),
          );
          return;
        }
        // Главы — разделы второго уровня («1. Наименование» … «9. Дата регистрации»); без них — самый верхний уровень,
        // кроме преамбулы (нулевой уровень).
        let chapters = items.filter((x) => x.level === 2);
        if (!chapters.length) {
          const min = Math.min(...items.filter((x) => (x.level || 1) >= 1).map((x) => x.level || 1));
          chapters = items.filter((x) => (x.level || 1) === min);
        }
        const ui = window.CCSources.create({ text: T, renderMarkdown });
        ui.renderChapters(box, {
          chapters,
          bodyClass: 'drug-doc',
          dropTitle: true,
          render: (text) => renderMarkdown(text),
          sectionUrl: (id, cursor) =>
            `${base}/${encodeURIComponent(innId)}/instructions/${encodeURIComponent(doc.id)}/sections/${encodeURIComponent(id)}${
              cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
            }`,
        });
      });
    }

    // ---- раздел «Инструкции» в карточке препарата ----
    function mountCard(host, innId) {
      host.textContent = '';
      host.appendChild(el('h4', { class: 'sec-label' }, T.title));
      const body = el('div');
      host.appendChild(body);
      body.appendChild(el('p', { class: 'small muted', role: 'status' }, T.loading));
      host.dataset.innId = String(innId);

      return getJson(`${base}/${encodeURIComponent(innId)}/instructions`).then((res) => {
        body.textContent = '';
        const docs = (res.data && res.data.documents) || [];
        if (!res.ok) {
          body.appendChild(el('p', { class: 'small muted' }, T.load_failed));
          return;
        }
        if (!docs.length) {
          body.appendChild(el('p', { class: 'small muted', 'data-testid': 'msg.drugs.instr.none' }, T.none));
          return;
        }
        const ul = el('ul', { class: 'drug-docs' });
        for (const doc of docs) {
          const li = el('li', { class: 'drug-doc-item' });
          const det = el('details');
          const sum = el('summary', { 'data-testid': 'msg.drugs.instr.doc' });
          sum.appendChild(el('span', {}, doc.label));
          const meta = [doc.trade_name, doc.manufacturer_hint].filter(Boolean).join(' · ');
          if (meta) sum.appendChild(el('small', { class: 'muted' }, meta));
          det.appendChild(sum);
          const tocBox = el('div', { class: 'drug-doc-body' });
          det.appendChild(tocBox);
          let loaded = false;
          det.addEventListener('toggle', () => {
            if (det.open && !loaded) {
              loaded = true;
              renderDocument(tocBox, innId, doc);
            }
          });
          li.appendChild(det);
          ul.appendChild(li);
        }
        body.appendChild(ul);
        // Единственная инструкция сразу раскрыта.
        if (docs.length === 1) ul.querySelector('details').open = true;
      });
    }

    /** Источник под ответом ИИ: лёгкие ссылки «Название · раздел · стр.». */
    function renderSources(row, sources, onOpen, canOpenFn) {
      if (!Array.isArray(sources) || !sources.length) return;
      const box = el('div', { class: 'msg-sources', 'data-testid': 'msg.drugs.instr.sources' });
      box.appendChild(el('span', { class: 'small muted' }, T.sources));
      for (const s of sources.slice(0, 8)) {
        const label = pathLabel(s) || s.label || '';
        const canOpen = onOpen && canOpenFn(s);
        if (!canOpen) {
          box.appendChild(el('span', { class: 'msg-source msg-source_plain' }, label));
          continue;
        }
        const b = el('button', { type: 'button', class: 'msg-source', 'data-testid': 'msg.drugs.instr.source' }, label);
        b.addEventListener('click', () => onOpen(s));
        box.appendChild(b);
      }
      row.appendChild(box);
    }

    return { mountCard, renderSources, pathLabel };
  }

  window.CCDrugDocs = { create, renderMarkdown };
})();
