'use strict';
const { t } = require('../../i18n');
const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
function render(patients) {
  const p = (k) => esc(t('msg.tpl.' + k));
  const keys = [
    'untitled',
    'saved',
    'saved_as_own',
    'copied',
    'copy_failed',
    'deleted',
    'ai_failed',
    'ai_done',
    'ai_undo',
    'from_chat',
    'filled',
    'no_own',
    'no_match',
    'wait',
    'retry',
    'save_failed',
    'edit_placeholder',
    'chat_result',
  ];
  const strings = keys.map((k) => `data-t-${k.replaceAll('_', '-')}="${p(k)}"`).join(' ');
  const button = (key, attr, cls = 'btn') =>
    `<button type="button" class="${cls}" data-testid="msg.tpl.${key}" data-tpl-${attr}>${p(key)}</button>`;
  return `<link rel="stylesheet" href="/article-editor.css"><section class="chat-tab docs-tab lib-tab" data-work-docs ${strings}>
    <aside class="side" aria-label="${p('side')}"><div class="side-head">${button('new', 'new', 'new')}</div>
    <input type="search" class="tpl-find" data-tpl-filter placeholder="${p('filter')}" aria-label="${p('filter')}">
    <h4>${p('own')}</h4><div data-tpl-own></div><h4>${p('builtin')}</h4><div data-tpl-builtin></div></aside>
    <div class="pane"><div class="lib-mobile-nav">${button('new', 'mobile-new')}<select data-tpl-mobile-select aria-label="${p('side')}"></select></div>
      <div class="scroll"><div class="col">
        <div class="hello" data-tpl-empty><h1>${p('empty.title')}</h1><p>${p('empty.lead')}</p><div class="ideas lib-examples">${button('example_one', 'example', 'idea')}${button('example_two', 'example', 'idea')}</div></div>
        <div data-tpl-reading hidden><div class="lib-reading-head"><b data-tpl-reading-title></b>${button('edit', 'edit', 'btn sm')}</div><article class="lib-preview tpl-preview" data-tpl-preview></article><div class="tpl-acts">${button('copy', 'copy')}</div></div>
        <div class="lib-chat" data-tpl-chat aria-live="polite" hidden></div><p class="small muted" role="status" data-tpl-msg></p>
      </div></div>
      <div class="dock"><div class="col"><div class="chat-input"><textarea data-tpl-ai-input rows="2" maxlength="1000" placeholder="${p('ai.placeholder')}" aria-label="${p('ai.placeholder')}"></textarea>${button('ai', 'ai', 'send-btn')}</div><p class="footnote">${p('ai.note')}</p></div></div>
    </div>
    <div class="lib-resizer" data-tpl-resizer role="separator" tabindex="0" aria-orientation="vertical" aria-label="${p('resize')}" aria-valuemin="30" aria-valuemax="70" aria-valuenow="45" hidden></div>
    <aside class="panel tpl-editor lib-editor" data-tpl-editor hidden aria-label="${p('edit')}">
      <div class="panel-head"><h2 tabindex="-1">${p('edit')}</h2><div class="panel-acts"><button type="button" class="btn ghost sm lib-back" data-tpl-back>${p('back')}</button><button type="button" class="round" data-testid="msg.tpl.close" data-tpl-close aria-label="${p('close')}"><svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-x"/></svg></button></div></div>
      <div class="panel-body">
        <p class="small muted" role="status" data-tpl-panel-msg></p>
        <input type="text" class="tpl-title" data-tpl-title maxlength="120" placeholder="${p('title.placeholder')}" aria-label="${p('title.placeholder')}">
        <textarea class="tpl-body" data-tpl-body maxlength="10000" rows="18" aria-label="${p('body.label')}"></textarea>
        <div class="inset tpl-fill"><div class="tpl-fill-row"><select data-tpl-patient aria-label="${p('patient')}"><option value="">${p('patient')}</option>${patients.map((a) => `<option value="${a.id}">${esc(a.full_name)}</option>`).join('')}</select>${button('fill', 'fill', 'btn sm')}</div><p class="small muted">${p('hint')}</p></div>
      </div>
      <div class="panel-foot tpl-acts">${button('save', 'save', 'btn primary')}${button('preview', 'preview-toggle')}${button('delete', 'delete', 'btn ghost')}</div>
    </aside></section><script src="/js/work_docs.js" defer></script><script src="/js/mic.js" defer></script>`;
}
module.exports = { render };
