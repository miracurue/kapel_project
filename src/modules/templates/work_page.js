'use strict';
const { t, texts } = require('../../i18n');
const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
function render(patients, options = {}) {
  const withDocs = Boolean(options.documents);
  const p = (k) => esc(t('msg.tpl.' + k));
  const keys = [
    'untitled',
    'builtin',
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
  const d = (k) => esc(t('msg.doc.' + k));
  const button = (key, attr, cls = 'btn') =>
    `<button type="button" class="${cls}" data-testid="msg.tpl.${key}" data-tpl-${attr}>${p(key)}</button>`;
  // Подписи формы документа едут на страницу данными: тип application/json не исполняется и не нарушает CSP.
  const docTexts = JSON.stringify(
    Object.fromEntries(Object.entries(texts).filter(([key]) => key.startsWith('msg.doc.'))),
  ).replaceAll('<', '\\u003c');
  const segment = (variant) =>
    withDocs
      ? `<div class="seg seg--sm doc-seg" role="group" aria-label="${d('seg.label')}" data-doc-seg="${variant}"><button type="button" aria-pressed="true" data-testid="msg.doc.seg.templates" data-doc-mode="templates">${d('seg.templates')}</button><button type="button" aria-pressed="false" data-testid="msg.doc.seg.documents" data-doc-mode="documents">${d('seg.documents')}</button></div>`
      : '';
  const fillBox = withDocs
    ? `<form class="inset doc-fillbox" data-doc-fillbox hidden aria-labelledby="doc-fill-title" novalidate>
        <h3 id="doc-fill-title">${d('fill.title')}</h3>
        <label class="field">${d('fill.patient')}<select data-doc-fill-patient required><option value="">${d('fill.choose')}</option>${patients.map((a) => `<option value="${a.id}">${esc(a.full_name)}</option>`).join('')}</select></label>
        <label class="field">${d('fill.ae')}<select data-doc-fill-ae disabled><option value="">${d('fill.ae_none')}</option></select></label>
        <p class="small muted">${d('fill.ae_hint')}</p>
        <p class="form-error" role="alert" data-doc-fill-msg></p>
        <div class="tpl-acts"><button type="submit" class="btn primary" data-testid="msg.doc.fill.create" data-doc-fill-create>${d('fill.create')}</button><button type="button" class="btn ghost" data-doc-fill-cancel>${d('fill.cancel')}</button></div>
      </form>`
    : '';
  const formView = withDocs
    ? `<div data-tpl-form hidden>
        <div class="lib-reading-head"><h2 class="doc-title" data-tpl-form-title></h2><span class="chip">${d('form_tag')}</span></div>
        <p class="doc-lead">${d('tpl.lead')}</p>
        <div class="tpl-acts"><button type="button" class="btn primary" data-testid="msg.doc.fill" data-doc-fill>${d('fill')}</button><a class="btn" data-testid="msg.doc.blank_print" data-doc-blank href="/work/api/documents/blank?format=docx" download>${d('blank_print')}</a></div>
        <p class="small muted">${d('blank_note')}</p>
        ${fillBox}
      </div>`
    : '';
  const docsView = withDocs
    ? `<div data-view-doc hidden>
        <div class="hello" data-doc-empty><h1>${d('empty.title')}</h1><p>${d('empty.lead')}</p></div>
        <div class="doc-view" data-doc-view hidden></div>
      </div>`
    : '';
  const docsSide = withDocs
    ? `<div data-pane-documents hidden><input type="search" class="tpl-find" data-doc-filter placeholder="${d('filter')}" aria-label="${d('filter')}"><div class="doc-list" data-doc-list aria-live="polite"></div></div>`
    : '';
  const docsMobile = withDocs
    ? `<div class="lib-mobile-row" data-doc-mobile hidden><select data-doc-mobile-select aria-label="${d('mobile_select')}"><option value="">${d('mobile_none')}</option></select></div>`
    : '';
  return `<link rel="stylesheet" href="/article-editor.css"><section class="chat-tab docs-tab lib-tab" data-work-docs data-mode="templates" ${strings}>
    <aside class="side" aria-label="${p('side')}">${withDocs ? `<div class="doc-seg-wrap">${segment('side')}</div>` : ''}
      <div data-pane-templates><div class="side-head">${button('new', 'new', 'new')}</div>
      <input type="search" class="tpl-find" data-tpl-filter placeholder="${p('filter')}" aria-label="${p('filter')}">
      <h4>${p('own')}</h4><div data-tpl-own></div><div data-tpl-builtin></div></div>${docsSide}</aside>
    <div class="pane"><div class="lib-mobile-nav">${withDocs ? segment('mobile') : ''}<div class="lib-mobile-row" data-tpl-mobile>${button('new', 'mobile-new')}<select data-tpl-mobile-select aria-label="${p('side')}"></select></div>${docsMobile}</div>
      <div class="scroll"><div class="col">
        <div data-view-tpl>
        <div class="hello" data-tpl-empty><h1>${p('empty.title')}</h1><p>${p('empty.lead')}</p><div class="ideas lib-examples">${button('example_one', 'example', 'idea')}${button('example_two', 'example', 'idea')}</div></div>
        <div data-tpl-reading hidden><div class="lib-reading-head"><b data-tpl-reading-title></b><span class="chip tpl-builtin-tag" data-testid="msg.tpl.builtin_tag" data-tpl-builtin-tag hidden>${p('builtin')}</span>${button('edit', 'edit', 'btn sm')}</div><article class="lib-preview tpl-preview" data-tpl-preview></article><div class="tpl-acts">${button('copy', 'copy')}${withDocs ? `<button type="button" class="btn primary" data-testid="msg.doc.save_as_doc" data-tpl-save-doc hidden>${d('save_as_doc')}</button>` : ''}</div></div>
        ${formView}
        <div class="lib-chat" data-tpl-chat aria-live="polite" hidden></div><p class="small muted" role="status" data-tpl-msg></p>
        </div>
        ${docsView}
      </div></div>
      <div class="dock" data-dock><div class="col"><div class="chat-input"><textarea data-tpl-ai-input rows="2" maxlength="1000" placeholder="${p('ai.placeholder')}" aria-label="${p('ai.placeholder')}"></textarea>${button('ai', 'ai', 'send-btn')}</div><p class="footnote">${p('ai.note')}</p></div></div>
    </div>
    <div class="lib-resizer" data-tpl-resizer role="separator" tabindex="0" aria-orientation="vertical" aria-label="${p('resize')}" aria-valuemin="30" aria-valuemax="70" aria-valuenow="45" hidden></div>
    <aside class="panel tpl-editor lib-editor" data-tpl-editor hidden aria-label="${p('edit')}">
      <div class="panel-head"><h2 tabindex="-1">${p('edit')}</h2><div class="panel-acts"><button type="button" class="round" data-testid="msg.tpl.close" data-tpl-close aria-label="${p('close')}"><svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-x"/></svg></button></div></div>
      <div class="panel-body">
        <p class="small muted" role="status" data-tpl-panel-msg></p>
        <input type="text" class="tpl-title" data-tpl-title maxlength="120" placeholder="${p('title.placeholder')}" aria-label="${p('title.placeholder')}">
        <textarea class="tpl-body" data-tpl-body maxlength="10000" rows="18" aria-label="${p('body.label')}"></textarea>
        <div class="inset tpl-fill"><div class="tpl-fill-row"><select data-tpl-patient aria-label="${p('patient')}"><option value="">${p('patient')}</option>${patients.map((a) => `<option value="${a.id}">${esc(a.full_name)}</option>`).join('')}</select>${button('fill', 'fill', 'btn sm')}</div><p class="small muted">${p('hint')}</p></div>
      </div>
      <div class="panel-foot tpl-acts">${button('save', 'save', 'btn primary')}${button('preview', 'preview-toggle')}${button('delete', 'delete', 'btn ghost')}</div>
    </aside></section>${withDocs ? `<script type="application/json" data-doc-i18n>${docTexts}</script>` : ''}<script src="/js/work_docs.js" defer></script>${withDocs ? '<script src="/js/work_doc_form.js" defer></script><script src="/js/work_documents.js" defer></script>' : ''}<script src="/js/mic.js" defer></script>`;
}
module.exports = { render };
