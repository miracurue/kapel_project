'use strict';

/**
 * Мини-разметка материалов библиотеки: ## заголовки, - списки, **жирный**, *курсив*, ![](/library/img/N).
 * Весь текст экранируется до разбора; ссылки и произвольный HTML не поддерживаются. Результат — DOM-узлы, не строка HTML.
 */
(function () {
  const IMG = /^!\[([^\]]*)\]\((\/library\/img\/\d+)\)$/;

  function inline(parent, text) {
    const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const strong = m[0].startsWith('**');
      const el = document.createElement(strong ? 'strong' : 'em');
      el.textContent = m[0].slice(strong ? 2 : 1, strong ? -2 : -1);
      parent.appendChild(el);
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function render(markdown) {
    const root = document.createDocumentFragment();
    let list = null;
    let para = [];
    const flush = () => {
      if (!para.length) return;
      const p = document.createElement('p');
      inline(p, para.join(' '));
      root.appendChild(p);
      para = [];
    };
    for (const raw of String(markdown || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')) {
      const line = raw.trim();
      const img = IMG.exec(line);
      const head = /^(#{1,3})\s+(.+)$/.exec(line);
      const item = /^[-•]\s+(.+)$/.exec(line);
      if (!line || img || head || !item) list = null;
      if (!line) {
        flush();
      } else if (img) {
        flush();
        const fig = document.createElement('img');
        fig.src = img[2];
        fig.alt = img[1];
        fig.loading = 'lazy';
        root.appendChild(fig);
      } else if (head) {
        flush();
        const h = document.createElement(head[1].length === 1 ? 'h2' : head[1].length === 2 ? 'h2' : 'h3');
        inline(h, head[2]);
        root.appendChild(h);
      } else if (item) {
        flush();
        if (!list) {
          list = document.createElement('ul');
          root.appendChild(list);
        }
        const li = document.createElement('li');
        inline(li, item[1]);
        list.appendChild(li);
      } else {
        para.push(line);
      }
    }
    flush();
    return root;
  }

  window.CCMarkdown = { render };
})();
