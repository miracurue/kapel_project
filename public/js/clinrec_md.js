'use strict';

/**
 * Разметка текстов клинических рекомендаций (Markdown из хранилища знаний) в DOM-узлы для правой панели чата.
 * Поддержано то, что есть в корпусе: заголовки ##/###, абзацы, жирный/курсив, списки (-, •, –, 1.) с вложенностью,
 * цитаты, таблицы (GFM, с горизонтальной прокруткой), разделитель, ссылки http(s) и <http://…>, экранирование \* \_ \.
 * Весь текст попадает в DOM через textContent; произвольный HTML и скрипты не поддерживаются.
 * Рисунки хранятся во внешнем источнике и не загружаются: на их месте короткая пометка «см. PDF».
 */
(function () {
  const INLINE = /\\([\\`*_{}[\]()#+\-.!|>~<])|\*\*(.+?)\*\*|\*([^*\s][^*]*?)\*|\[([^\]]+)\]\((https?:[^)\s]+)\)|<(https?:[^>\s]+)>/g;
  const SAFE_URL = /^https?:\/\//i;

  function link(parent, text, href) {
    if (!SAFE_URL.test(href)) {
      parent.appendChild(document.createTextNode(text));
      return;
    }
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = text;
    parent.appendChild(a);
  }

  function inline(parent, text) {
    const re = new RegExp(INLINE.source, 'g');
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1] !== undefined) {
        parent.appendChild(document.createTextNode(m[1]));
      } else if (m[2] !== undefined) {
        const strong = document.createElement('strong');
        inline(strong, m[2]);
        parent.appendChild(strong);
      } else if (m[3] !== undefined) {
        const em = document.createElement('em');
        inline(em, m[3]);
        parent.appendChild(em);
      } else if (m[4] !== undefined) {
        link(parent, m[4], m[5]);
      } else {
        link(parent, m[6], m[6]);
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  // Ячейки таблицы: делим по неэкранированному «|», крайние пустые отбрасываем.
  function cells(line) {
    const parts = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/);
    return parts.map((c) => c.trim());
  }
  const isSep = (line) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line.trim());
  const isRow = (line) => /^\s*\|.*\|\s*$/.test(line);

  function table(lines) {
    const wrap = document.createElement('div');
    wrap.className = 'cr-table';
    const tbl = document.createElement('table');
    const rows = lines.filter((l) => !isSep(l)).map(cells);
    const width = Math.max(...rows.map((r) => r.length));
    // Хвостовые столбцы, пустые во всех строках, убираем (в источнике таблицы дополнены пустыми ячейками).
    let used = width;
    while (used > 1 && rows.every((r) => !r[used - 1])) used -= 1;
    const hasHead = lines.length > 1 && isSep(lines[1]);
    rows.forEach((r, i) => {
      const tr = document.createElement('tr');
      for (let c = 0; c < used; c++) {
        const cell = document.createElement(i === 0 && hasHead ? 'th' : 'td');
        inline(cell, r[c] || '');
        tr.appendChild(cell);
      }
      if (rows[i].every((x) => !x)) return;
      (i === 0 && hasHead ? (tbl.tHead || tbl.createTHead()) : (tbl.tBodies[0] || tbl.createTBody())).appendChild(tr);
    });
    wrap.appendChild(tbl);
    return wrap;
  }

  const LIST = /^(\s*)(?:([-•–*])|(\d+)[.)])\s+(.*)$/;

  function render(markdown, opts) {
    const imageNote = (opts && opts.imageNote) || '';
    const root = document.createDocumentFragment();
    const lines = String(markdown || '')
      .replace(/\r\n?/g, '\n')
      .split('\n');
    let para = [];
    let stack = []; // вложенные списки: { indent, ordered, el }
    const flush = () => {
      if (!para.length) return;
      const p = document.createElement('p');
      inline(p, para.join(' '));
      root.appendChild(p);
      para = [];
    };
    const endList = () => {
      stack = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();
      if (!line) {
        flush();
        // Пустая строка между пунктами не обрывает список, если следующая непустая строка — снова пункт.
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j += 1;
        if (!(stack.length && j < lines.length && LIST.test(lines[j]))) endList();
        continue;
      }
      if (isRow(raw) && i + 1 < lines.length && (isSep(lines[i + 1]) || isRow(lines[i + 1]) || isSep(raw))) {
        flush();
        endList();
        const block = [];
        while (i < lines.length && (isRow(lines[i]) || isSep(lines[i]))) block.push(lines[i++]);
        i -= 1;
        root.appendChild(table(block));
        continue;
      }
      const img = /^!\[[^\]]*\]\([^)]*\)$/.test(line);
      if (img) {
        flush();
        endList();
        if (imageNote) {
          const p = document.createElement('p');
          p.className = 'cr-figure';
          p.textContent = imageNote;
          root.appendChild(p);
        }
        continue;
      }
      const head = /^(#{1,6})\s+(.+)$/.exec(line);
      if (head) {
        flush();
        endList();
        const h = document.createElement(head[1].length <= 2 ? 'h4' : 'h5');
        inline(h, head[2]);
        root.appendChild(h);
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
        flush();
        endList();
        root.appendChild(document.createElement('hr'));
        continue;
      }
      if (line.startsWith('>')) {
        flush();
        endList();
        const quote = [];
        while (i < lines.length && lines[i].trim().startsWith('>')) quote.push(lines[i++].trim().replace(/^>\s?/, ''));
        i -= 1;
        const bq = document.createElement('blockquote');
        for (const q of quote.filter(Boolean)) {
          const p = document.createElement('p');
          inline(p, q.trim());
          bq.appendChild(p);
        }
        root.appendChild(bq);
        continue;
      }
      const item = LIST.exec(raw);
      // «**Жирная строка**» с «*» в начале не список: маркер «*» только перед пробелом (регулярка это требует).
      if (item) {
        flush();
        const indent = item[1].length;
        const ordered = item[3] !== undefined;
        while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();
        let top = stack[stack.length - 1];
        if (!top || indent > top.indent || top.ordered !== ordered) {
          if (top && top.ordered !== ordered && indent === top.indent) stack.pop();
          const list = document.createElement(ordered ? 'ol' : 'ul');
          if (ordered) list.start = Number(item[3]);
          const parentLi = stack.length ? stack[stack.length - 1].el.lastElementChild : null;
          (parentLi || root).appendChild(list);
          top = { indent, ordered, el: list };
          stack.push(top);
        }
        const li = document.createElement('li');
        inline(li, item[4]);
        top.el.appendChild(li);
        continue;
      }
      // Продолжение пункта списка: строка с отступом сразу после пункта.
      if (stack.length && /^\s+/.test(raw) && !para.length) {
        const li = stack[stack.length - 1].el.lastElementChild;
        if (li) {
          li.appendChild(document.createTextNode(` ${line}`));
          continue;
        }
      }
      endList();
      para.push(line);
    }
    flush();
    return root;
  }

  window.CCClinrecMd = { render };
})();
