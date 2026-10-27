'use strict';

/**
 * Источники ответа ИИ в чате специалиста: карточки под ответом и просмотр источника в правой панели.
 *
 * Карточка — «квадратик» с номером [n], видом источника (клинрек, инструкция, статья, знания модели), названием, местом
 * в документе и короткой цитатой. «Знания модели» ([0]) — отдельная карточка другого цвета: не из базы.
 * Клик по карточке открывает в панели документ целиком (клинрек или инструкцию): все главы свёрнуты, кроме той,
 * где лежит источник; она раскрыта, прокручена к фрагменту, который нашёл поиск, и подсвечена. Остальные главы
 * раскрываются по клику. Текст документов никогда не попадает в innerHTML (разметка разбирается в DOM-узлы).
 * Тексты — словарь T (ключи msg.wchat.source.*), передаётся из work_chat.js.
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

  // Вид источника: у ответов, сохранённых до появления поля kind, он выводится из прежних признаков.
  function kindOf(s) {
    if (s.kind) return s.kind;
    if (s.model_knowledge) return 'model';
    if (s.clinrec) return 'clinrec';
    if (s.literature) return 'literature';
    return 'drug';
  }

  function create(opts) {
    const T = (opts && opts.text) || {};
    const renderDrugMd = opts && opts.renderMarkdown;
    const fmt = (s, vars) => String(s || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? '' : vars[k]));

    // Место в документе для подписи: «раздел / подраздел · стр. N».
    const placeOf = (s) => [s.path, s.page ? fmt(T.page, { n: s.page }) : ''].filter(Boolean).join(' · ');
    const titleOf = (s) => (kindOf(s) === 'model' ? T.model_title : s.label || '');

    // ---- карточки под ответом ----
    function renderCards(row, sources, onOpen) {
      if (!Array.isArray(sources) || !sources.length) return;
      const box = el('div', { class: 'src-cards', 'data-testid': 'msg.wchat.source.list' });
      box.appendChild(el('span', { class: 'src-cards__label' }, T.title));
      for (const s of sources) {
        const kind = kindOf(s);
        const n = s.n === undefined || s.n === null ? '' : `[${s.n}]`;
        const card = el('button', {
          type: 'button',
          class: `src-card src-card_${kind}`,
          'data-testid': 'msg.wchat.source.card',
          'data-n': s.n === undefined || s.n === null ? '' : String(s.n),
          'data-kind': kind,
          'aria-label': fmt(T.card_open, { n: s.n === undefined || s.n === null ? '' : s.n, title: titleOf(s) }),
        });
        const head = el('span', { class: 'src-card__head' });
        if (n) head.appendChild(el('span', { class: 'src-card__n' }, n));
        head.appendChild(el('span', { class: 'src-card__kind' }, T[`kind_${kind}`] || ''));
        card.appendChild(head);
        card.appendChild(el('span', { class: 'src-card__title' }, titleOf(s)));
        const place = kind === 'model' ? '' : placeOf(s);
        if (place) card.appendChild(el('span', { class: 'src-card__path' }, place));
        if (kind !== 'model' && s.snippet) card.appendChild(el('span', { class: 'src-card__snip' }, s.snippet));
        card.addEventListener('click', () => onOpen(s));
        box.appendChild(card);
      }
      row.appendChild(box);
    }

    // ---- просмотр источника в правой панели ----

    // Текст раздела кусками: обычные и подсвеченный (фрагмент, на который ссылается ответ).
    function pieceNode(text, render, marked) {
      const box = el(
        'div',
        marked ? { class: 'src-mark', 'data-testid': 'msg.wchat.source.mark' } : { class: 'cr-text' },
      );
      if (marked) {
        box.appendChild(el('p', { class: 'src-mark__label' }, T.mark_label));
        const inner = el('div', { class: 'cr-text' });
        inner.appendChild(render(text));
        box.appendChild(inner);
      } else box.appendChild(render(text));
      return box;
    }

    /**
     * Глава документа: <details>, текст подгружается при раскрытии постранично. focus — {chunk, section} для главы
     * с источником: первая страница запрашивается с адресом фрагмента и подсвечивает его.
     */
    function chapter(cfg, ch, focus) {
      const det = el('details', {
        class: `drug-article src-chapter${focus ? ' src-chapter_focus' : ''}`,
        'data-section': ch.id,
      });
      det.appendChild(el('summary', {}, ch.title));
      const body = el('div', { class: `article-text${cfg.bodyClass ? ` ${cfg.bodyClass}` : ''}` });
      det.appendChild(body);
      let started = false;
      let markNode = null;
      async function load(cursor) {
        body.querySelectorAll('[data-more],[data-loading]').forEach((n) => n.remove());
        body.appendChild(el('p', { class: 'small muted', 'data-loading': '' }, T.loading));
        const first = !cursor;
        const res = await getJson(cfg.sectionUrl(ch.id, cursor, first && focus ? focus : null));
        body.querySelectorAll('[data-loading]').forEach((n) => n.remove());
        if (!res.ok) {
          started = false;
          body.appendChild(el('p', { class: 'small muted' }, T.load_failed));
          return;
        }
        const d = res.data;
        let text = d.text || '';
        // Заголовок главы уже в <summary>: повтор первой строкой текста не показываем.
        if (first && cfg.dropTitle) {
          const m = /^\s*#{1,6}\s+(.+?)\s*\n/.exec(text);
          if (m && m[1].trim() === String(ch.title).trim()) text = text.slice(m[0].length);
        }
        // Подсветка: точный фрагмент из ответа, иначе (раздел без фрагмента) — части раздела-источника.
        let mark = first && d.mark ? d.mark : null;
        if (first && !mark && focus && focus.section && focus.section !== ch.id && Array.isArray(d.parts)) {
          const own = d.parts.filter((p) => p.section_id === focus.section);
          if (own.length) mark = { start: own[0].start, end: own[own.length - 1].end };
        }
        if (mark && mark.start < text.length) {
          const end = Math.min(mark.end, text.length);
          if (mark.start > 0) body.appendChild(pieceNode(text.slice(0, mark.start), cfg.render, false));
          markNode = pieceNode(text.slice(mark.start, end), cfg.render, true);
          body.appendChild(markNode);
          if (end < text.length) body.appendChild(pieceNode(text.slice(end), cfg.render, false));
        } else if (text) body.appendChild(pieceNode(text, cfg.render, false));
        if (d.hasMore && d.nextCursor) {
          const more = el('button', { type: 'button', class: 'btn', 'data-more': '' }, T.more);
          more.addEventListener('click', () => {
            more.disabled = true;
            load(d.nextCursor);
          });
          body.appendChild(more);
        }
        if (first && focus) {
          const target = markNode || det;
          target.scrollIntoView({ block: 'start' });
        }
      }
      det.addEventListener('toggle', () => {
        if (!det.open || started) return;
        started = true;
        load(0);
      });
      if (focus) {
        det.open = true; // событие toggle придёт позже, загрузка уже начата
        started = true;
        load(0);
      }
      return det;
    }

    function documentView(panelBody, cfg) {
      const root = el('div', {
        class: 'src-view',
        'data-testid': 'msg.wchat.source.view',
        'data-n': String(cfg.source.n === undefined ? '' : cfg.source.n),
        'data-kind': kindOf(cfg.source),
        'data-section': cfg.source.section_id || '',
      });
      root.appendChild(el('h2', {}, cfg.title));
      const sub = [T[`kind_${kindOf(cfg.source)}`], cfg.subtitle].filter(Boolean).join(' · ');
      if (sub) root.appendChild(el('p', { class: 'sub' }, sub));
      if (cfg.pdfHref)
        root.appendChild(el('p', {})).appendChild(
          el(
            'a',
            {
              class: 'btn',
              href: cfg.pdfHref,
              target: '_blank',
              rel: 'noopener',
              'data-testid': 'msg.wchat.clinrec.pdf',
            },
            T.pdf,
          ),
        );
      // Что именно открыто: номер и место в документе.
      const where = placeOf(cfg.source);
      const lead = el('section', { class: 'src-lead', 'data-testid': 'msg.wchat.source.lead' });
      lead.appendChild(
        el('p', { class: 'small muted' }, [T.lead, cfg.source.n ? `[${cfg.source.n}]` : ''].filter(Boolean).join(' ')),
      );
      if (where) lead.appendChild(el('p', {}, where));
      root.appendChild(lead);
      root.appendChild(el('h4', { class: 'sec-label' }, T.chapters));
      const focus = cfg.focusTop
        ? { chunk: cfg.source.chunk_id || null, section: cfg.source.section_id || null }
        : null;
      for (const ch of cfg.chapters) root.appendChild(chapter(cfg, ch, focus && ch.id === cfg.focusTop ? focus : null));
      panelBody.appendChild(root);
    }

    // Клинрек: оглавление и глава с источником приходят одним запросом (?section=).
    async function viewClinrec(panelBody, s, ui) {
      const q = s.section_id ? `?section=${encodeURIComponent(s.section_id)}` : '';
      const res = await getJson(`/work/api/clinrecs/${encodeURIComponent(s.document_id)}${q}`);
      panelBody.textContent = '';
      if (!res.ok) {
        panelBody.appendChild(el('p', { class: 'small muted' }, T.open_failed));
        return;
      }
      const doc = res.data;
      ui.setTitle(doc.title);
      const render = (text) =>
        window.CCClinrecMd ? window.CCClinrecMd.render(text, { imageNote: T.figure }) : document.createTextNode(text);
      documentView(panelBody, {
        source: s,
        title: doc.title,
        subtitle: doc.version ? `${T.version}: ${doc.version}` : '',
        pdfHref: doc.pdf ? `/work/api/clinrecs/${encodeURIComponent(doc.id)}/pdf` : '',
        chapters: (doc.sections || []).filter((x) => x.level === 2),
        focusTop: doc.focus ? doc.focus.top_id : null,
        render,
        sectionUrl: (id, cursor, f) => {
          const p = [];
          if (cursor) p.push(`cursor=${encodeURIComponent(cursor)}`);
          if (f) {
            if (f.chunk) p.push(`chunk=${encodeURIComponent(f.chunk)}`);
            p.push('parts=1');
          }
          return `/work/api/clinrecs/${encodeURIComponent(doc.id)}/sections/${encodeURIComponent(id)}${p.length ? `?${p.join('&')}` : ''}`;
        },
      });
    }

    // Инструкция к лекарству: документ по коду (МНН не нужен), главы — разделы второго уровня.
    async function viewDrug(panelBody, s, ui) {
      const res = await getJson(`/work/api/drugs/documents/${encodeURIComponent(s.document_id)}`);
      panelBody.textContent = '';
      const items = (res.data && res.data.items) || [];
      if (!res.ok || !items.length) {
        panelBody.appendChild(el('p', { class: 'small muted' }, T.open_failed));
        return;
      }
      const doc = res.data.document;
      ui.setTitle(doc.label);
      const byId = new Map(items.map((x) => [x.id, x]));
      let chapters = items.filter((x) => x.level === 2);
      if (!chapters.length) {
        const min = Math.min(...items.map((x) => x.level || 1));
        chapters = items.filter((x) => (x.level || 1) === min);
      }
      // Глава источника: предок раздела на втором уровне (или сам раздел, если он выше).
      let top = null;
      for (let cur = byId.get(s.section_id); cur; cur = byId.get(cur.parent_id)) {
        if (cur.level <= 2) {
          top = cur;
          break;
        }
      }
      if (top && !chapters.some((x) => x.id === top.id)) chapters = [top, ...chapters];
      documentView(panelBody, {
        source: s,
        title: doc.label,
        subtitle: doc.trade_name || '',
        chapters,
        focusTop: top ? top.id : null,
        render: (text) => (renderDrugMd ? renderDrugMd(text) : document.createTextNode(text)),
        sectionUrl: (id, cursor, f) => {
          const p = [];
          if (cursor) p.push(`cursor=${encodeURIComponent(cursor)}`);
          if (f && f.chunk) p.push(`chunk=${encodeURIComponent(f.chunk)}`);
          return `/work/api/drugs/documents/${encodeURIComponent(doc.id)}/sections/${encodeURIComponent(id)}${p.length ? `?${p.join('&')}` : ''}`;
        },
      });
    }

    function viewLiterature(panelBody, s, ui) {
      ui.setTitle(s.label || T.kind_literature);
      const root = el('div', {
        class: 'src-view',
        'data-testid': 'msg.wchat.source.view',
        'data-n': String(s.n),
        'data-kind': 'literature',
      });
      root.appendChild(el('h2', {}, s.label || ''));
      root.appendChild(el('p', { class: 'sub' }, [T.kind_literature, s.path].filter(Boolean).join(' · ')));
      if (s.snippet) root.appendChild(el('p', {}, s.snippet));
      root.appendChild(el('p', { class: 'small muted' }, T.literature_note));
      if (/^https:\/\//.test(s.url || ''))
        root.appendChild(el('p', {})).appendChild(
          el(
            'a',
            {
              class: 'btn',
              href: s.url,
              target: '_blank',
              rel: 'noopener noreferrer',
              'data-testid': 'msg.wchat.source.external',
            },
            T.literature_open,
          ),
        );
      panelBody.appendChild(root);
    }

    function viewModel(panelBody, s, ui) {
      ui.setTitle(T.model_title);
      const root = el('div', {
        class: 'src-view src-view_model',
        'data-testid': 'msg.wchat.source.view',
        'data-n': '0',
        'data-kind': 'model',
      });
      root.appendChild(el('h2', {}, T.model_title));
      root.appendChild(el('p', { class: 'sub' }, T.model_badge));
      root.appendChild(el('p', {}, T.model_note));
      panelBody.appendChild(root);
    }

    /**
     * Открыть источник в теле правой панели. ui.setTitle(text) — заголовок панели. Возвращает промис, который
     * завершается, когда документ отрисован (для тестов и скролла).
     */
    function openInPanel(panelBody, s, ui) {
      panelBody.textContent = '';
      panelBody.scrollTop = 0;
      const kind = kindOf(s);
      if (kind === 'model') return Promise.resolve(viewModel(panelBody, s, ui));
      if (kind === 'literature') return Promise.resolve(viewLiterature(panelBody, s, ui));
      ui.setTitle(s.label || '');
      panelBody.appendChild(el('p', { class: 'small muted', role: 'status' }, T.loading));
      return kind === 'clinrec' ? viewClinrec(panelBody, s, ui) : viewDrug(panelBody, s, ui);
    }

    // Главы документа без обрамления (карточка препарата): cfg — chapters, render, sectionUrl, bodyClass.
    function renderChapters(host, cfg) {
      for (const ch of cfg.chapters) host.appendChild(chapter(cfg, ch, null));
    }

    return { renderCards, openInPanel, renderChapters, kindOf };
  }

  window.CCSources = { create, kindOf };
})();
