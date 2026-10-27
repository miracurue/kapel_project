'use strict';
// Approved diary interface, rendered inside the existing patient app shell.
function render({ t } = {}) {
  const dictionary = require('../../../locales/ru.json');
  const text = (key) =>
    String(t ? t(key) : dictionary[key] || key).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const ICON = (name, size = '') =>
    `<svg class="i ${size}" aria-hidden="true" focusable="false"><use href="/icons.svg#i-${name}"/></svg>`;
  return `<section class="diary-workspace" aria-busy="true"><div data-diary-content inert><div class="diary-main chat-tab diary-tab" data-page="P-29">
      <aside class="side diary-side" aria-label="${text('msg.diary.workspace.static.135')}">
        <div class="side-head">
          <button type="button" class="new" id="add" data-testid="msg.diary.workspace.quick.add_habit">${ICON('plus', 'i--16')}${text('msg.diary.workspace.quick.add_habit')}</button>
        </div>
        <div class="side-list"><button type="button" class="side-th th on" id="side-today" aria-current="true"><span>${text('msg.diary.workspace.static.009')}</span></button></div>
        <h4>${text('msg.diary.workspace.static.023')}</h4>
        <div id="side-state" class="side-list"></div>
        <h4>${text('msg.diary.workspace.static.019')}</h4>
        <div id="side-habits" class="side-list"></div>
        <p class="small">${text('msg.diary.workspace.static.020')}</p>
      </aside>
      <div class="pane"><div class="scroll"><div class="col diary-col">
        <div class="p-head diary-head">
          <div class="p-head-text">
            <h1>${text('msg.diary.workspace.static.003')}</h1>
            <p class="p-sub">${text('msg.diary.workspace.static.004')}<span aria-hidden="true"> · </span><span data-diary-save-status role="status" aria-live="polite" data-state="loading">${text('msg.diary.workspace.static.001')}</span></p>
          </div>
          <div class="p-head-act">
            <div class="seg seg--sm segmented" id="audience" role="group" aria-label="${text('msg.diary.workspace.static.134')}">
              <button type="button" data-mode="patient" aria-pressed="true">${text('msg.diary.workspace.static.005')}</button
              ><button type="button" data-mode="doctor" aria-pressed="false">${text('msg.diary.workspace.static.006')}</button>
            </div>
            <button class="btn sm" type="button" id="reminders">${ICON('clock', 'i--16')}<span id="reminder-summary">${text('msg.diary.workspace.static.013')}</span>${ICON('caret-down', 'i--16')}</button>
          </div>
        </div>
        <p class="alert alert--warn" id="doctor-notice" hidden>${ICON('eye', 'i--18')}<span>${text('msg.diary.workspace.static.008')}</span></p>
        <div class="view-stack" id="view-today">

          <section class="callout callout--sum" id="interpretation" aria-labelledby="interpretation-title">
            <div>
              <h2 id="interpretation-title">${text('msg.diary.workspace.static.014')}</h2>
              <p id="interpretation-summary"></p>
            </div>
          </section>
          <section class="p-card today-section" id="today" aria-labelledby="today-title">
            <div class="card-h">
              <div class="title-with-date">
                <h2 id="today-title">${text('msg.diary.workspace.static.009')}</h2><span class="date-label"></span>
              </div>
              <span class="visibility-label" data-testid="msg.diary.workspace.static.017">${ICON('eye', 'i--16')}${text('msg.diary.workspace.static.017')}</span>
            </div>
            <div class="state-panel" aria-labelledby="state-title">
              <h3 id="state-title" class="field-label" data-testid="msg.diary.workspace.static.016">${text('msg.diary.workspace.static.016')}</h3>
              <div id="state-pickers"></div>
            </div>
            <div class="quick-rows" id="essential-cards"></div>
          </section>
          <form class="p-card note-compose" id="note-form">
            <h2><label for="day-note">${text('msg.diary.workspace.static.046')}</label></h2>
            <textarea id="day-note" data-testid="msg.diary.workspace.static.048" class="area" rows="2" maxlength="2000" placeholder="${text('msg.diary.workspace.static.144')}" required></textarea>
            <div class="note-actions">
              <label class="check-label"><input type="checkbox" id="note-share" />${text('msg.diary.workspace.static.049')}</label>
              <button class="btn primary" type="submit" data-testid="msg.diary.workspace.static.050">${text('msg.diary.workspace.static.050')}</button>
            </div>
          </form>
          <section class="p-card habits-section" aria-labelledby="habits-title">
            <div class="card-h">
              <h2 id="habits-title">${text('msg.diary.workspace.static.019')}</h2>
              <span class="p-hint">${text('msg.diary.workspace.static.020')}</span>
            </div>
            <div class="cards personal-cards" id="cards"></div>
            <button class="link unscheduled-toggle" type="button" id="show-unscheduled" hidden>${text('msg.diary.workspace.static.021')}</button>
          </section>

        <section class="p-card history-panel" aria-labelledby="history-title">
            <div class="card-h">
              <h2 id="history-title">${text('msg.diary.workspace.static.010')}</h2>
              <div class="history-controls">
                <select id="history-period" aria-label="${text('msg.diary.workspace.static.137')}">
                  <option value="14">${text('msg.diary.workspace.static.025')}</option>
                  <option value="7">${text('msg.diary.workspace.static.026')}</option>
                </select>
              </div>
            </div>
            <div id="state-history">
              <div class="history-block">
                <p class="p-hint">${text('msg.diary.workspace.static.036')}</p>
                <div class="tbl-wrap calendar-scroll"><table id="calendar" class="matrix" aria-label="${text('msg.diary.workspace.static.141')}"></table></div>
                <div class="legend">
                  <span><i class="swatch done"></i>${text('msg.diary.workspace.static.037')}</span><span><i class="swatch partial"></i>${text('msg.diary.workspace.static.038')}</span
                  ><span><i class="swatch missed"></i>${text('msg.diary.workspace.static.039')}</span><span><i class="swatch missing"></i>${text('msg.diary.workspace.static.040')}</span
                  ><span><i class="swatch off"></i>${text('msg.diary.workspace.static.041')}</span><span><i class="swatch recorded"></i>${text('msg.diary.workspace.static.042')}</span>
                </div>
              </div>
              <div class="history-block">
                <div class="month-heading">
                  <h3><strong id="history-month"></strong></h3>
                  <span class="p-hint">${text('msg.diary.workspace.static.027')}</span>
                  <div class="btn-row">
                    <button class="round round--sm round--sunk" id="previous-month" type="button" aria-label="${text('msg.diary.workspace.static.138')}">${ICON('caret-left')}</button>
                    <button class="round round--sm round--sunk" id="next-month" type="button" aria-label="${text('msg.diary.workspace.static.139')}">${ICON('caret-right')}</button>
                  </div>
                </div>
                <div id="month-calendar" class="cal" role="group" aria-label="${text('msg.diary.workspace.static.140')}"></div>
                <div class="legend mood-legend">
                  <span><i class="sw sw-1"></i>${text('msg.diary.workspace.static.153')}</span><span><i class="sw sw-3"></i>${text('msg.diary.workspace.static.154')}</span><span><i class="sw sw-5"></i>${text('msg.diary.workspace.static.155')}</span><span><i class="sw sw-0"></i>${text('msg.diary.workspace.static.040')}</span><span>${ICON('note-pencil', 'i--16')}${text('msg.diary.workspace.static.030')}</span>
                </div>
              </div>
            </div>
          </section>

        <section class="p-card notes-section" aria-labelledby="notes-title">
          <div class="card-h">
            <h2 id="notes-title">${text('msg.diary.workspace.static.012')}</h2>
            <button class="btn sm" type="button" id="all-notes">${text('msg.diary.workspace.static.047')}</button>
          </div>
          <div id="recent-notes" class="recent-notes"></div>
        </section>
        </div>

        <section class="p-card chart-panel" id="habit-detail" aria-labelledby="chart-title" hidden>
          <div class="card-h">
            <div class="title-with-date">
              <h2 id="chart-title">${text('msg.diary.workspace.static.011')}</h2><span class="date-label" id="chart-habit"></span>
            </div>
            <div class="chart-controls">
              <select id="metric" data-testid="msg.diary.workspace.static.142" aria-label="${text('msg.diary.workspace.static.142')}"></select
              ><select id="period" aria-label="${text('msg.diary.workspace.static.143')}">
                <option value="14">${text('msg.diary.workspace.static.025')}</option>
                <option value="7">${text('msg.diary.workspace.static.026')}</option>
              </select>
            </div>
          </div>
          <div class="chart-summary">
            <strong id="chart-value"></strong><span class="p-hint" id="chart-description"></span>
          </div>
          <div id="chart" class="tbl-wrap"></div>
          <p class="p-hint" id="chart-footnote"></p>
          <div id="insights" class="insights"></div>
          <div id="detail-records" class="detail-records"></div>
          <details>
            <summary>${text('msg.diary.workspace.static.044')}</summary>
            <div id="chart-table" class="tbl-wrap"></div>
          </details>
        </section>

        <p class="p-hint diary-foot">${text('msg.diary.workspace.static.052')}</p>
      </div></div></div>
    </div>
    <dialog id="editor">
      <form id="entry-form">
        <div class="dialog-top">
          <h2 id="entry-title">${text('msg.diary.workspace.static.053')}</h2>
          <button type="button" class="round" data-close="editor" aria-label="${text('msg.diary.workspace.static.145')}">${ICON('x')}</button>
        </div>
        <div id="entry-fields"></div>
        <div class="dialog-actions">
          <button type="button" class="btn ghost" id="entry-clear">${text('msg.diary.workspace.static.058')}</button
          ><button class="btn primary" type="submit">${text('msg.diary.workspace.static.050')}</button>
        </div>
      </form>
    </dialog>
    <dialog id="creator" class="day-drawer">
      <form id="habit-form">
        <div class="dialog-top">
          <h2>${text('msg.diary.workspace.static.059')}</h2>
          <button type="button" class="round" data-close="creator" aria-label="${text('msg.diary.workspace.static.145')}">${ICON('x')}</button>
        </div>
        <div class="example-buttons" aria-label="${text('msg.diary.workspace.static.146')}">
          <button type="button" data-preset="water">${text('msg.diary.workspace.static.061')}</button
          ><button type="button" data-preset="walk">${text('msg.diary.workspace.static.062')}</button
          ><button type="button" data-preset="energy">${text('msg.diary.workspace.static.063')}</button
          ><button type="button" data-preset="bed">${text('msg.diary.workspace.static.064')}</button
          ><button type="button" data-preset="note">${text('msg.diary.workspace.static.012')}</button>
        </div>
        <label>${text('msg.diary.workspace.static.065')}<input id="habit-name" type="text" maxlength="80" placeholder="${text('msg.diary.workspace.static.147')}" required /></label>
        <label
          >${text('msg.diary.workspace.quick.how')}<select id="habit-type">
            <option value="check">${text('msg.diary.workspace.static.067')}</option>
            <option value="count">${text('msg.diary.workspace.static.068')}</option>
            <option value="duration">${text('msg.diary.workspace.static.069')}</option>
            <option value="measure">${text('msg.diary.workspace.static.070')}</option>
            <option value="scale">${text('msg.diary.workspace.static.071')}</option>
            <option value="time">${text('msg.diary.workspace.static.072')}</option>
            <option value="choice">${text('msg.diary.workspace.static.073')}</option>
            <option value="note">${text('msg.diary.workspace.static.074')}</option>
          </select></label
        >
        <label id="choice-fields" hidden
          >${text('msg.diary.workspace.static.080')}<textarea
            id="habit-choices"
            rows="3"
            maxlength="800"
            placeholder="${text('msg.diary.workspace.static.149')}"
          ></textarea>
        </label>
        <label
          >${text('msg.diary.workspace.static.095')}<select id="habit-schedule">
            <option value="daily">${text('msg.diary.workspace.static.096')}</option>
            <option value="weekdays">${text('msg.diary.workspace.static.098')}</option>
            <option value="interval">${text('msg.diary.workspace.static.097')}</option>
            <option value="free">${text('msg.diary.workspace.static.099')}</option>
          </select></label
        >
        <label id="interval-label" hidden
          >${text('msg.diary.workspace.static.101')}<input id="habit-interval" type="number" min="1" max="365" value="2" step="1"
        /></label>
        <fieldset id="weekday-fields" hidden>
          <legend>${text('msg.diary.workspace.static.102')}</legend>
          <div class="weekdays">
            <label><input type="checkbox" name="weekday" value="1" />${text('msg.diary.workspace.static.103')}</label
            ><label><input type="checkbox" name="weekday" value="2" />${text('msg.diary.workspace.static.104')}</label
            ><label><input type="checkbox" name="weekday" value="3" />${text('msg.diary.workspace.static.105')}</label
            ><label><input type="checkbox" name="weekday" value="4" />${text('msg.diary.workspace.static.106')}</label
            ><label><input type="checkbox" name="weekday" value="5" />${text('msg.diary.workspace.static.107')}</label
            ><label><input type="checkbox" name="weekday" value="6" />${text('msg.diary.workspace.static.108')}</label
            ><label><input type="checkbox" name="weekday" value="0" />${text('msg.diary.workspace.static.109')}</label>
          </div>
        </fieldset>
        <label class="check-label"><input type="checkbox" id="habit-share" />${text('msg.diary.workspace.static.110')}</label>
        <details class="builder-more" id="builder-more">
          <summary>${text('msg.diary.workspace.quick.more_settings')}</summary>
          <label id="habit-unit-label">${text('msg.diary.workspace.static.075')}<select id="habit-unit"></select></label>
          <label id="custom-unit-label" hidden
            >${text('msg.diary.workspace.static.076')}<input id="habit-custom-unit" type="text" maxlength="16" placeholder="${text('msg.diary.workspace.static.148')}"
          /></label>
          <label id="signed-label" class="check-label" hidden
            ><input id="habit-signed" type="checkbox" />${text('msg.diary.workspace.static.077')}</label
          >
          <div id="scale-fields" class="form-grid builder-grid" hidden>
            <label>${text('msg.diary.workspace.static.078')}<input id="scale-min" type="number" value="1" step="1" required /></label
            ><label>${text('msg.diary.workspace.static.079')}<input id="scale-max" type="number" value="5" step="1" required /></label>
          </div>
          <div class="form-grid builder-grid">
            <label id="goal-label"
              >${text('msg.diary.workspace.static.081')}<select id="habit-goal">
                <option value="min">${text('msg.diary.workspace.static.082')}</option>
                <option value="max">${text('msg.diary.workspace.static.083')}</option>
                <option value="exact">${text('msg.diary.workspace.static.084')}</option>
                <option value="range">${text('msg.diary.workspace.static.085')}</option>
                <option value="none">${text('msg.diary.workspace.static.086')}</option>
              </select></label
            >
            <label id="target-label"
              ><span id="target-caption">${text('msg.diary.workspace.static.087')}</span
              ><input id="habit-target" type="number" value="1" step="any" required
            /></label>
          </div>
          <label id="upper-label" hidden>${text('msg.diary.workspace.static.088')}<input id="habit-upper" type="number" step="any" /></label>
          <label id="aggregation-label"
            >${text('msg.diary.workspace.static.089')}<select id="habit-aggregation">
              <option value="sum">${text('msg.diary.workspace.static.090')}</option>
              <option value="last">${text('msg.diary.workspace.static.091')}</option>
              <option value="mean">${text('msg.diary.workspace.static.092')}</option>
              <option value="max">${text('msg.diary.workspace.static.093')}</option>
              <option value="min">${text('msg.diary.workspace.static.094')}</option>
            </select></label
          >
          <p id="aggregation-hint" class="field-hint"></p>
          <label>${text('msg.diary.workspace.static.100')}<input id="habit-start" type="date" required /></label>
          <p id="habit-preview" class="p-hint"></p>
        </details>
        <p id="builder-error" class="form-error" role="alert" hidden></p>
        <button class="btn primary" type="submit">${text('msg.diary.workspace.quick.create')}</button>
      </form>
    </dialog>
    <dialog id="reminder-dialog">
      <form id="reminder-form">
        <div class="dialog-top">
          <h2>${text('msg.diary.workspace.static.114')}</h2>
          <button type="button" class="round" data-close="reminder-dialog" aria-label="${text('msg.diary.workspace.static.145')}">${ICON('x')}</button>
        </div>
        <label
          >${text('msg.diary.workspace.static.115')}<select id="reminder-frequency">
            <option value="daily">${text('msg.diary.workspace.static.116')}</option>
            <option value="alternate">${text('msg.diary.workspace.static.117')}</option>
            <option value="off">${text('msg.diary.workspace.static.118')}</option>
          </select></label
        ><label>${text('msg.diary.workspace.static.119')}<input type="time" id="reminder-time" value="19:00" required /></label>
        <p class="muted">${text('msg.diary.workspace.static.120')}</p>
        <button class="btn primary" type="submit">${text('msg.diary.workspace.static.050')}</button>
      </form>
    </dialog>

    <dialog id="day-drawer" class="day-drawer" aria-labelledby="drawer-title">
      <div class="drawer-heading">
        <div>
          <p class="eyebrow" id="drawer-kicker">${text('msg.diary.workspace.static.121')}</p>
          <h2 id="drawer-title">${text('msg.diary.workspace.static.009')}</h2>
        </div>
        <button type="button" class="round" data-close="day-drawer" aria-label="${text('msg.diary.workspace.static.150')}">${ICON('x')}</button>
      </div>
      <div id="drawer-nav" class="drawer-nav">
        <button type="button" class="btn sm" id="previous-day">${text('msg.diary.workspace.static.122')}</button
        ><button type="button" class="btn sm" id="next-day">${text('msg.diary.workspace.static.123')}</button>
      </div>
      <div id="drawer-content"></div>
    </dialog>
    <dialog id="notes-dialog" class="day-drawer" aria-labelledby="all-notes-title">
      <div class="dialog-top">
        <div>
          <p class="eyebrow">${text('msg.diary.workspace.static.124')}</p>
          <h2 id="all-notes-title">${text('msg.diary.workspace.static.125')}</h2>
        </div>
        <button type="button" class="round" data-close="notes-dialog" aria-label="${text('msg.diary.workspace.static.151')}">${ICON('x')}</button>
      </div>
      <div class="note-filters">
        <label>${text('msg.diary.workspace.static.126')}<input id="note-search" type="search" placeholder="${text('msg.diary.workspace.static.152')}" /></label
        ><label
          >${text('msg.diary.workspace.static.127')}<select id="note-source">
            <option value="all">${text('msg.diary.workspace.static.125')}</option>
            <option value="day">${text('msg.diary.workspace.static.128')}</option>
            <option value="habit">${text('msg.diary.workspace.static.129')}</option>
          </select></label
        ><label
          >${text('msg.diary.workspace.static.100')}<input id="note-from" type="date"
        /></label>
      </div>
      <p id="note-results-count" class="muted"></p>
      <div id="note-results"></div>
    </dialog>
    <dialog id="discussion-dialog" aria-labelledby="discussion-title">
      <div class="dialog-top">
        <h2 id="discussion-title">${text('msg.diary.workspace.static.130')}</h2>
        <button type="button" class="round" data-close="discussion-dialog" aria-label="${text('msg.diary.workspace.static.145')}">${ICON('x')}</button>
      </div>
      <p class="muted">${text('msg.diary.workspace.static.131')}</p>
      <label for="discussion-text">${text('msg.diary.workspace.static.132')}</label><textarea id="discussion-text" rows="7" maxlength="4000"></textarea
      ><button id="copy-discussion" class="btn primary" type="button">${text('msg.diary.workspace.static.133')}</button>
    </dialog>
    <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
</div></section>`;
}
module.exports = { render, styles: ['/diary.css'], scripts: ['/diary.js'] };
