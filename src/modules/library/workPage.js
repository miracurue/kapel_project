'use strict';

/**
 * «Мои статьи»: список слева, чат и центральный предпросмотр, редактор справа.
 * Клиент — public/js/work_library.js; API — authoring.js; тексты — locales/ru.json.
 */

const { t } = require('../../i18n');

const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const STRING_KEYS = [
  'status.changes',
  'save.failed',
  'saved',
  'editor.close',
  'editor.resize',
  'publish.update',
  'ai.retry',
  'ai.placeholder.edit',
  'new.hint',
  'example.one',
  'example.two',
  'published',
  'unpublished',
  'publish.need',
  'upload.failed',
  'ai.done',
  'ai.undo',
  'ai.failed',
  'none',
  'none.published',
  'gaps.patients',
  'status.draft',
  'status.published',
  'status.withdrawn',
  'byline',
  'disclaimer',
  'preview.on',
  'preview.specialist',
  'cover.uploading',
  'cover.added',
  'preview.off',
  'cover.add',
  'cover.change',
  'audience.patient',
  'audience.specialist',
  'audience.locked',
  'published.specialist',
  'publish.patient',
  'publish.specialist',
  'chat.ai',
  'ai.wait',
  'ai.busy',
  'rw.wait',
  'rw.busy',
  'rw.done',
  'rw.failed',
  'rw.undo',
  'rw.simpler.task',
  'rw.shorter.task',
  'rw.softer.task',
  'doc.source',
  'doc.src_label',
  'doc.reader',
  'doc.reader.btn',
  'doc.empty',
  'tag.drug',
  'tag.theme',
];

function render(user) {
  const strings = STRING_KEYS.map((k) => `data-t-${k.replace(/\./g, '-')}="${esc(t(`msg.lib.${k}`))}"`).join(' ');
  const role = { psychiatrist: 'психиатр', psychologist: 'психолог' }[user.role] || '';
  const p = (k) => esc(t(`msg.lib.${k}`));
  return `<link rel="stylesheet" href="/article-editor.css"><section class="chat-tab docs-tab lib-tab" data-work-library data-author="${esc(user.full_name || '')}" data-role="${esc(role)}" ${strings}>
  <aside class="side" aria-label="${p('side')}">
    <div class="side-head"><button type="button" class="new" data-testid="msg.lib.new" data-lib-new>${p('new')}</button></div>
    <input type="search" class="tpl-find" data-testid="msg.lib.filter" data-lib-filter placeholder="${p('filter')}" aria-label="${p('filter')}">
    <h4>${p('mine.drafts')}</h4>
    <div data-lib-mine></div>
    <h4>${p('mine.published')}</h4>
    <div data-lib-pub></div>
    <div data-lib-gaps-box hidden><h4>${p('gaps')}</h4><p class="small muted lib-gap-hint">${p('gaps.hint')}</p><div class="lib-gaps" data-lib-gaps></div></div>
  </aside>
  <div class="pane"><div class="lib-mobile-nav"><button type="button" class="btn" data-lib-mobile-new>${p('new')}</button><select data-lib-mobile-select aria-label="${p('side')}"><option value="">${p('side')}</option></select></div>
    <div class="scroll"><div class="col">
      <div class="hello" data-lib-empty>
        <h1 data-testid="msg.lib.empty.title">${p('empty.title')}</h1>
        <p>${p('new.hint')}</p><div class="ideas lib-examples"><button class="idea" type="button" data-lib-example>${p('example.one')}</button><button class="idea" type="button" data-lib-example>${p('example.two')}</button></div>
      </div>
      <div class="lib-reading" data-lib-reading hidden><div class="lib-reading-head"><span data-lib-preview-label></span><button type="button" class="btn sm" data-testid="msg.lib.edit" data-lib-edit>${p('edit')}</button></div><article class="lib-preview" data-lib-preview></article></div>
      <div class="lib-chat" data-lib-chat aria-live="polite" hidden></div>
      <p class="muted small" data-lib-msg role="status" aria-live="polite"></p>
    </div></div>
    <div class="dock"><div class="col">
      <div class="lib-aud" role="group" aria-label="${p('audience')}" data-lib-aud>
        <span class="lib-aud-label">${p('audience')}:</span>
        <button type="button" class="chip" data-testid="msg.lib.audience.patient" data-lib-aud-btn="patient" aria-pressed="true">${p('audience.patient')}</button>
        <button type="button" class="chip" data-testid="msg.lib.audience.specialist" data-lib-aud-btn="specialist" aria-pressed="false">${p('audience.specialist')}</button>
      </div>
      <div class="chat-input"><textarea data-testid="msg.lib.ai.placeholder" data-lib-ai-input rows="2" maxlength="3000" placeholder="${p('ai.placeholder')}" aria-label="${p('ai.placeholder')}"></textarea><button type="button" class="send-btn" data-testid="msg.lib.ai" data-lib-ai>${p('ai.button')}</button></div>
      <p class="footnote">${p('ai.note')}</p>
    </div></div>
  </div>
  <div class="lib-resizer" data-lib-resizer role="separator" tabindex="0" aria-orientation="vertical" aria-label="${p('editor.resize')}" aria-valuemin="30" aria-valuemax="70" aria-valuenow="45" hidden></div>
  <aside class="panel tpl-editor lib-editor" data-lib-editor hidden aria-label="${p('edit')}">
    <div class="panel-head"><h2 tabindex="-1">${p('edit')}</h2><div class="panel-acts"><button type="button" class="btn ghost sm lib-back" data-lib-back>${p('editor.close')}</button><button type="button" class="round" data-lib-close aria-label="${p('editor.x')}"><svg class="i" aria-hidden="true" focusable="false"><use href="/icons.svg#i-x"/></svg></button></div></div>
    <div class="panel-body">
      <div class="lib-cover" data-lib-cover hidden><img alt="" data-lib-cover-img></div>
      <div class="lib-status-row"><span class="st-pill lib-status" data-lib-status></span><span class="muted small" data-lib-byline></span></div>
      <p data-lib-panel-msg class="small muted" role="status" aria-live="polite"></p>
      <div class="lib-fields" data-lib-fields>
        <input type="text" class="tpl-title" data-testid="msg.lib.title" data-lib-title maxlength="200" placeholder="${p('title.placeholder')}" aria-label="${p('title.placeholder')}">
        <input type="text" class="lib-summary" data-lib-summary maxlength="400" placeholder="${p('summary.placeholder')}" aria-label="${p('summary.placeholder')}">
      </div>
      <div class="lib-doc-bar">
        <span class="small muted" data-lib-doc-label>${p('doc.reader')}</span>
        <span class="lib-doc-tools">
          <label class="btn sm file-btn">${p('image.add')}<input type="file" accept="image/jpeg,image/png" data-lib-image-file hidden></label>
          <button type="button" class="btn sm" data-lib-preview-toggle>${p('preview.on')}</button>
          <button type="button" class="btn sm" data-lib-text-toggle aria-pressed="false">${p('doc.source')}</button>
        </span>
      </div>
      <article class="lib-doc lib-preview" data-lib-doc aria-label="${p('doc.reader')}"></article>
      <p class="muted small lib-rw-hint" data-lib-hint hidden>${p('rw.hint')}</p>
      <textarea class="tpl-body" data-testid="msg.lib.body" data-lib-body maxlength="100000" rows="16" placeholder="${p('body.placeholder')}" aria-label="${p('body.placeholder')}" hidden></textarea>
      <div class="lib-rw inset" data-lib-rw hidden>
        <div class="lib-rw-head"><h3>${p('rw.title')}</h3></div>
        <blockquote class="lib-rw-quote" data-lib-rw-quote aria-label="${p('rw.quote')}"></blockquote>
        <div class="lib-rw-row">
          <input type="text" data-testid="msg.lib.rw.task" data-lib-rw-task maxlength="500" placeholder="${p('rw.task')}" aria-label="${p('rw.task')}">
          <button type="button" class="btn sm primary" data-testid="msg.lib.rw.go" data-lib-rw-go>${p('rw.go')}</button>
        </div>
        <div class="lib-rw-quick">
          <button type="button" class="chip" data-lib-rw-quick="">${p('rw.rephrase')}</button>
          <button type="button" class="chip" data-lib-rw-quick="simpler">${p('rw.simpler')}</button>
          <button type="button" class="chip" data-lib-rw-quick="shorter">${p('rw.shorter')}</button>
          <button type="button" class="chip" data-lib-rw-quick="softer">${p('rw.softer')}</button>
        </div>
        <div class="lib-rw-result" data-lib-rw-result hidden>
          <small class="muted">${p('rw.result')}</small>
          <p data-lib-rw-text></p>
          <div class="tpl-acts">
            <button type="button" class="btn sm primary" data-testid="msg.lib.rw.replace" data-lib-rw-replace>${p('rw.replace')}</button>
            <button type="button" class="btn sm" data-lib-rw-discard>${p('rw.discard')}</button>
          </div>
        </div>
      </div>
      <div class="lib-tagbox inset" data-lib-tagbox>
        <div class="lib-tagchips chips" data-lib-tagchips aria-label="${p('tags.label')}"></div>
        <input type="text" class="lib-tags" data-lib-tags placeholder="${p('tags.placeholder')}" aria-label="${p('tags.placeholder')}">
        <p class="muted small">${p('tags.hint')}</p>
      </div>
      <div class="lib-cover-row"><label class="btn sm file-btn"><span data-lib-cover-label>${p('cover.add')}</span><input type="file" accept="image/jpeg,image/png" data-lib-cover-file hidden></label></div>
    </div>
    <div class="panel-foot tpl-acts">
      <button type="button" class="btn primary" data-testid="msg.lib.publish" data-lib-publish>${p('publish')}</button>
      <button type="button" class="btn" data-testid="msg.lib.save" data-lib-save>${p('save')}</button>
      <button type="button" class="btn ghost" data-testid="msg.lib.unpublish" data-lib-unpublish hidden>${p('unpublish')}</button>
    </div>
  </aside>
  </section><script src="/js/md.js" defer></script><script src="/js/work_library.js" defer></script><script src="/js/mic.js" defer></script>`;
}

module.exports = { render };
