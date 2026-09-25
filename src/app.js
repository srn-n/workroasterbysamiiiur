/**
 * app.js
 * -----------------------------------------------------------------------
 * Main controller. No framework: state lives in a plain object, the UI
 * is rebuilt from a template string on every meaningful change, and
 * event listeners are re-attached after each render. For an app this
 * size that's simpler to read and debug than introducing a reactive
 * framework — see README.md "Why vanilla JS" for the full reasoning.
 * -----------------------------------------------------------------------
 */
import * as calc from './calculations.js';
import * as store from './storage.js';
import * as opts from './settings.js';
// export.js pulls in jsPDF (which itself bundles html2canvas/DOMPurify)
// and ExcelJS — a few hundred KB the core tracker doesn't need just to
// add a record. Loaded lazily, on first export click, so page load stays
// light for the common case.

const root = document.getElementById('app');

const state = {
  records: store.loadRecords(),
  settings: store.loadSettings(),
  editingId: null,
  formError: '',
  modal: null, // null | 'settings' | 'data'
  settingsTab: 'options', // 'options' | 'general'
  optionField: 'dayTypes', // which list the Options tab is showing
  toast: null,
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (amount) => calc.formatMoney(amount, state.settings.currency);
const rate = (pay, minutes) => calc.formatRate(pay, minutes, state.settings.currency);

function persist() {
  store.saveRecords(state.records);
  store.saveSettings(state.settings);
}

let toastTimer = null;
function showToast(message, tone = 'success') {
  state.toast = { message, tone };
  render();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
    render();
  }, 3400);
}

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
}

// ---------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------

function renderHeader() {
  const nextTheme = state.settings.theme === 'dark' ? 'light' : 'dark';
  const icon = state.settings.theme === 'dark' ? '☀️' : '🌙';
  return `
    <header class="app-header">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">WT</div>
        <div>
          <h1>WorkTrack</h1>
          <p class="subtitle">Shifts, hours and pay — tracked by fortnight, at a glance.</p>
        </div>
      </div>
      <div class="header-actions">
        <button class="icon-btn" id="btn-theme" type="button" title="Toggle theme" aria-label="Switch to ${nextTheme} theme">${icon}</button>
        <button class="btn secondary" id="btn-data" type="button">Backup &amp; export</button>
        <button class="btn secondary" id="btn-settings" type="button">Settings</button>
      </div>
    </header>`;
}

function renderStats() {
  const cycles = calc.groupByCycle(state.records, state.settings.payCycleLengthDays);
  const latest = cycles[0];
  const overallMinutes = calc.totalMinutes(state.records);
  const overallPay = calc.totalPay(state.records);
  const overallRate = calc.weightedAverageRate(state.records);

  // Order matches the requested layout: row 1 is hours/hours/pay, row 2
  // is pay/count/rate. Colour is used only where it carries meaning —
  // money totals in --success, the one computed rate in --primary — a
  // plain fact (hours, record count) stays neutral text.
  const cards = [
    { label: 'Latest fortnight hours', value: latest ? calc.formatDuration(latest.totalMinutes) : '—', accent: 'neutral' },
    { label: 'Overall working hours', value: calc.formatDuration(overallMinutes), accent: 'neutral' },
    { label: 'Latest fortnight pay', value: latest ? money(latest.totalPay) : '—', accent: 'pay' },
    { label: 'Total pay', value: money(overallPay), accent: 'pay' },
    { label: 'Records', value: String(state.records.length), accent: 'neutral' },
    { label: 'Average earning per hour', value: overallRate > 0 ? `${money(overallRate)}/hr` : '—', accent: 'rate' },
  ];

  return `
    <section class="stats" aria-label="Summary statistics">
      ${cards
        .map(
          (c) => `
        <div class="stat-card accent-${c.accent}">
          <div class="stat-label">${c.label}</div>
          <div class="stat-value">${c.value}</div>
        </div>`
        )
        .join('')}
    </section>`;
}

// ---------------------------------------------------------------------
// Work calendar (visual, read-only — no new state, no interactions yet)
// ---------------------------------------------------------------------

const CALENDAR_WEEKDAY_LABELS = Array.from({ length: 7 }, (_, i) =>
  // Jan 1 2023 was a Sunday, so this reliably yields Sun..Sat regardless
  // of what "today" is, in the viewer's own locale.
  new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'short' })
);

/** Build a Sun-start 6/7-row grid for the given month, padded with the
 *  edges of the neighbouring months so the calendar is a clean rectangle. */
function buildMonthGrid(year, month, recordCountsByDate) {
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
  const todayStr = calc.todayString();
  const cells = [];

  for (let i = 0; i < totalCells; i += 1) {
    const dayOffset = i - firstWeekday + 1;
    const cellDate = new Date(year, month, dayOffset);
    const dateStr = `${cellDate.getFullYear()}-${String(cellDate.getMonth() + 1).padStart(2, '0')}-${String(cellDate.getDate()).padStart(2, '0')}`;
    cells.push({
      dayNum: cellDate.getDate(),
      dateStr,
      inMonth: dayOffset >= 1 && dayOffset <= daysInMonth,
      isToday: dateStr === todayStr,
      count: recordCountsByDate.get(dateStr) || 0,
    });
  }
  return cells;
}

function renderCalendar() {
  const today = new Date();
  const counts = new Map();
  for (const r of state.records) {
    if (!r.date) continue;
    counts.set(r.date, (counts.get(r.date) || 0) + 1);
  }
  const cells = buildMonthGrid(today.getFullYear(), today.getMonth(), counts);
  const monthLabel = today.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const workDaysThisMonth = cells.filter((c) => c.inMonth && c.count > 0).length;

  return `
    <section class="panel calendar-panel" aria-label="Work calendar for ${esc(monthLabel)}">
      <div class="panel-head">
        <div>
          <h2>Work calendar</h2>
          <p class="panel-hint">${esc(monthLabel)} — ${workDaysThisMonth ? `${workDaysThisMonth} work day${workDaysThisMonth === 1 ? '' : 's'} logged` : 'no work days logged yet'}.</p>
        </div>
        <span class="calendar-legend"><span class="calendar-dot" aria-hidden="true"></span> Work day</span>
      </div>
      <div class="calendar-weekday-row">
        ${CALENDAR_WEEKDAY_LABELS.map((d) => `<div class="calendar-weekday">${d}</div>`).join('')}
      </div>
      <div class="calendar-grid">
        ${cells
          .map(
            (c) => `
          <div class="calendar-day ${c.inMonth ? '' : 'is-outside'} ${c.isToday ? 'is-today' : ''} ${c.count > 0 ? 'has-work' : ''}">
            <span class="calendar-daynum">${c.dayNum}</span>
            ${c.count === 1 ? '<span class="calendar-dot" aria-hidden="true"></span>' : ''}
            ${c.count > 1 ? `<span class="calendar-pill" aria-hidden="true">${c.count}</span>` : ''}
          </div>`
          )
          .join('')}
      </div>
    </section>`;
}

function optionSelect(id, field, currentValue) {
  const list = opts.optionsForSelect(state.settings[field], currentValue);
  if (!list.length) {
    return `<select id="${id}" disabled><option>No options configured</option></select>`;
  }
  return `
    <select id="${id}">
      ${list
        .map((o) => `<option value="${esc(o.label)}" ${o.label === currentValue ? 'selected' : ''}>${esc(o.label)}${o.archived ? ' (archived)' : ''}</option>`)
        .join('')}
    </select>`;
}

function renderForm() {
  const editingRecord = state.editingId ? state.records.find((r) => r.id === state.editingId) : null;
  const parts = editingRecord ? calc.minutesToParts(calc.recordMinutes(editingRecord)) : { hours: '', minutes: '' };
  const d = state.settings.defaults;

  return `
    <section class="panel form-panel" aria-labelledby="form-heading">
      <div class="panel-head">
        <div>
          <h2 id="form-heading">${editingRecord ? 'Edit record' : 'Add a work record'}</h2>
          <p class="panel-hint">The hourly rate is calculated automatically — you never need to type it in.</p>
        </div>
        ${editingRecord ? `<span class="editing-badge">Editing ${esc(calc.shortDateLabel(editingRecord.date))}</span>` : ''}
      </div>

      <form id="record-form" novalidate>
        <fieldset class="field-group">
          <legend>When</legend>
          <div class="grid grid-3">
            <div class="field">
              <label for="f-date">Date</label>
              <input id="f-date" type="date" required value="${editingRecord ? editingRecord.date : calc.todayString()}">
            </div>
            <div class="field">
              <label for="f-start">Starting time</label>
              <input id="f-start" type="time" required value="${editingRecord ? editingRecord.start : d.startTime}">
            </div>
            <div class="field">
              <label for="f-cycle-preview">Pay cycle</label>
              <output id="f-cycle-preview" class="rate-output" for="f-date">—</output>
              <small class="field-help">Calculated automatically from the date and your configured cycle length.</small>
            </div>
          </div>
        </fieldset>

        <fieldset class="field-group">
          <legend>Duration</legend>
          <div class="grid grid-3">
            <div class="field">
              <label for="f-hours">Working time</label>
              <div class="duration-row">
                <input id="f-hours" type="number" min="0" step="1" inputmode="numeric" placeholder="2" value="${parts.hours}">
                <span class="duration-unit">hr</span>
                <input id="f-minutes" type="number" min="0" max="59" step="1" inputmode="numeric" placeholder="22" value="${parts.minutes}">
                <span class="duration-unit">min</span>
              </div>
              <small class="field-help">Example: 2 hr 22 min — never entered as a decimal.</small>
            </div>
            <div class="field">
              <label for="f-daytype">Day type</label>
              ${optionSelect('f-daytype', 'dayTypes', editingRecord ? editingRecord.dayType : d.dayType)}
            </div>
            <div class="field">
              <label for="f-map">Map / job number <span class="optional">optional</span></label>
              <input id="f-map" placeholder="e.g. Grid B4" value="${editingRecord ? esc(editingRecord.mapNumber) : ''}">
            </div>
          </div>
        </fieldset>

        <fieldset class="field-group">
          <legend>Pay</legend>
          <div class="grid grid-3">
            <div class="field">
              <label for="f-paytype">Payment type</label>
              ${optionSelect('f-paytype', 'paymentTypes', editingRecord ? editingRecord.paymentType : d.paymentType)}
            </div>
            <div class="field">
              <label for="f-pay">Payment amount</label>
              <div class="prefix-input">
                <span class="prefix">${money(0).replace(/[0-9.,]/g, '').trim() || '$'}</span>
                <input id="f-pay" type="number" min="0" step="0.01" placeholder="0.00" value="${editingRecord ? editingRecord.paymentAmount : ''}">
              </div>
            </div>
            <div class="field">
              <label for="f-rate">Earned per hour</label>
              <output id="f-rate" class="rate-output" for="f-pay f-hours f-minutes">—</output>
              <small class="field-help">Payment ÷ actual working time. Updates live.</small>
            </div>
          </div>
        </fieldset>

        <fieldset class="field-group">
          <legend>Notes</legend>
          <div class="field">
            <label for="f-notes">Role / notes <span class="optional">optional</span></label>
            <input id="f-notes" placeholder="e.g. Floor cover, Store 12" value="${editingRecord ? esc(editingRecord.notes) : ''}">
          </div>
        </fieldset>

        <div class="form-error" id="form-error" role="alert">${esc(state.formError)}</div>
        <div class="form-actions">
          <button class="btn primary" type="submit">${editingRecord ? 'Save changes' : 'Add record'}</button>
          ${editingRecord ? '<button class="btn secondary" type="button" id="btn-cancel-edit">Cancel</button>' : ''}
        </div>
      </form>
    </section>`;
}

function renderRecordRow(r) {
  const mins = calc.recordMinutes(r);
  // A record's pay cycle is now shown once, in its group's header — no
  // need to repeat it per row. Instead, if this record carries a legacy
  // manually-typed cycle value (from before automatic calculation) that
  // no longer matches what's computed for it, surface that history
  // rather than silently dropping it.
  const computedCycle = r.date ? calc.getCycleForDate(r.date, state.settings.payCycleLengthDays) : null;
  // Compare semantically, not as raw strings: legacy text like "Sep 7 to
  // Sep 20" and the computed label "Sep 7 – Sep 20, 2026" describe the same
  // period but are never byte-identical, so a strict !== check here would
  // flag nearly every legacy record as a mismatch. See
  // calculations.js#legacyCycleMatchesComputed.
  const legacyCycle =
    r.cycle && r.cycle !== 'Unassigned' && !(computedCycle && calc.legacyCycleMatchesComputed(r.cycle, computedCycle))
      ? r.cycle
      : null;

  return `
    <li class="record-row" data-id="${r.id}">
      <div class="record-main">
        <div class="record-date">
          <span class="record-day">${calc.dayName(r.date)}</span>
          <span class="record-date-label">${calc.shortDateLabel(r.date)}</span>
        </div>
        <div class="record-time">
          <span class="record-start">${calc.formatTime12h(r.start)}</span>
          <span class="record-duration">${calc.formatDuration(mins)}</span>
        </div>
        <div class="record-notes">${esc(r.notes) || '<span class="muted">No notes</span>'}</div>
        <div class="record-pay">
          <span class="record-amount">${money(r.paymentAmount)}</span>
          <span class="record-rate">${rate(r.paymentAmount, mins)}</span>
        </div>
        <div class="record-actions">
          <button class="icon-btn small" data-action="edit" data-id="${r.id}" aria-label="Edit record from ${esc(calc.shortDateLabel(r.date))}">Edit</button>
          <button class="icon-btn small danger" data-action="delete" data-id="${r.id}" aria-label="Delete record from ${esc(calc.shortDateLabel(r.date))}">Delete</button>
        </div>
      </div>
      <div class="record-meta">
        <span class="tag">${esc(r.dayType || 'Unspecified')}</span>
        <span class="tag muted-tag">${esc(r.paymentType || 'Unspecified')}</span>
        ${r.mapNumber ? `<span class="meta-item">Map <b>${esc(r.mapNumber)}</b></span>` : ''}
        ${legacyCycle ? `<span class="meta-item legacy-cycle" title="Manually entered before automatic cycles were added">Was <b>${esc(legacyCycle)}</b></span>` : ''}
      </div>
    </li>`;
}

function renderRecords() {
  if (!state.records.length) {
    return `
      <section class="panel">
        <div class="empty-state">
          <div class="empty-icon" aria-hidden="true">🗓️</div>
          <h3>No work records yet</h3>
          <p>Add your first shift above and it'll show up here, grouped by pay cycle.</p>
          <button class="btn secondary" id="btn-sample-data" type="button">Load sample data</button>
        </div>
      </section>`;
  }

  const cycles = calc.groupByCycle(state.records, state.settings.payCycleLengthDays);

  return `
    <section aria-label="Work records by pay cycle">
      ${cycles
        .map(
          (c) => `
        <div class="cycle-group">
          <div class="cycle-head">
            <div>
              <span class="cycle-name">${esc(c.cycleLabel)}</span>
              <span class="cycle-count">${c.records.length} record${c.records.length === 1 ? '' : 's'}</span>
            </div>
            <div class="cycle-head-actions">
              <div class="cycle-totals">
                <span>${calc.formatDuration(c.totalMinutes)}</span>
                <span class="cycle-pay">${money(c.totalPay)}</span>
              </div>
              <div class="cycle-export-actions" role="group" aria-label="Export ${esc(c.cycleLabel)}">
                <button class="icon-btn small" data-cycle-export="pdf" data-cycle-key="${esc(c.key)}" title="Export this cycle as PDF">PDF</button>
                <button class="icon-btn small" data-cycle-export="jpg" data-cycle-key="${esc(c.key)}" title="Export this cycle as JPG">JPG</button>
                <button class="icon-btn small" data-cycle-export="xlsx" data-cycle-key="${esc(c.key)}" title="Export this cycle as Excel">Excel</button>
              </div>
            </div>
          </div>
          <ul class="record-list">
            ${c.records.map(renderRecordRow).join('')}
          </ul>
        </div>`
        )
        .join('')}
    </section>`;
}

function renderInsights() {
  const start = calc.averageStartTime(state.records);
  const overallRate = calc.weightedAverageRate(state.records);
  return `
    <section class="insights" aria-label="Insights">
      <div class="insight-card">
        <div class="insight-label">Usual starting time</div>
        <div class="insight-value">${start ? calc.formatTime12h(start) : '—'}</div>
        <p class="insight-note">Average clock-in time across every recorded shift.</p>
      </div>
      <div class="insight-card">
        <div class="insight-label">Average earning per hour</div>
        <div class="insight-value">${overallRate > 0 ? `${money(overallRate)}/hr` : '—'}</div>
        <p class="insight-note">Total earnings ÷ total working time — a weighted rate, not an average of daily rates.</p>
      </div>
    </section>`;
}

function renderOptionRow(field, option, usageCount) {
  const locked = usageCount > 0;
  return `
    <li class="option-row ${option.archived ? 'is-archived' : ''}" data-id="${option.id}">
      <div class="option-info">
        <span class="option-label" data-role="label">${esc(option.label)}</span>
        ${option.archived ? '<span class="tag muted-tag">Archived</span>' : ''}
        <span class="option-usage">${usageCount ? `used in ${usageCount} record${usageCount === 1 ? '' : 's'}` : 'not used yet'}</span>
      </div>
      <div class="option-actions">
        <button class="icon-btn small" data-opt-action="move-up" data-field="${field}" data-id="${option.id}" aria-label="Move ${esc(option.label)} up">↑</button>
        <button class="icon-btn small" data-opt-action="move-down" data-field="${field}" data-id="${option.id}" aria-label="Move ${esc(option.label)} down">↓</button>
        <button class="icon-btn small" data-opt-action="rename" data-field="${field}" data-id="${option.id}">Rename</button>
        ${
          option.archived
            ? `<button class="icon-btn small" data-opt-action="restore" data-field="${field}" data-id="${option.id}">Restore</button>`
            : `<button class="icon-btn small danger" data-opt-action="remove" data-field="${field}" data-id="${option.id}">${locked ? 'Archive' : 'Delete'}</button>`
        }
      </div>
    </li>`;
}

function renderSettingsModal() {
  if (state.modal !== 'settings') return '';
  const field = state.optionField;
  const list = state.settings[field] || [];
  const fieldLabel = field === 'dayTypes' ? 'Day types' : 'Payment types';

  const generalTab = `
    <div class="field">
      <label for="s-currency">Currency code</label>
      <input id="s-currency" list="currency-list" value="${esc(state.settings.currency)}" maxlength="3" style="text-transform:uppercase">
      <datalist id="currency-list">
        ${['USD', 'AUD', 'NZD', 'GBP', 'EUR', 'CAD', 'SGD', 'INR'].map((c) => `<option value="${c}">`).join('')}
      </datalist>
      <small class="field-help">Any valid 3-letter ISO currency code, e.g. AUD, USD, GBP.</small>
    </div>
    <div class="field">
      <label for="s-theme">Theme</label>
      <select id="s-theme">
        <option value="system" ${state.settings.theme === 'system' ? 'selected' : ''}>Match system</option>
        <option value="light" ${state.settings.theme === 'light' ? 'selected' : ''}>Light</option>
        <option value="dark" ${state.settings.theme === 'dark' ? 'selected' : ''}>Dark</option>
      </select>
    </div>
    <div class="field">
      <label for="s-default-start">Default starting time for new records</label>
      <input id="s-default-start" type="time" value="${state.settings.defaults.startTime}">
    </div>
    <div class="field">
      <label for="s-cycle-length">Pay cycle length</label>
      <select id="s-cycle-length">
        <option value="7" ${state.settings.payCycleLengthDays === 7 ? 'selected' : ''}>7 days (weekly)</option>
        <option value="14" ${state.settings.payCycleLengthDays === 14 ? 'selected' : ''}>14 days (fortnightly)</option>
        <option value="30" ${state.settings.payCycleLengthDays === 30 ? 'selected' : ''}>30 days</option>
      </select>
      <small class="field-help">Every record's pay cycle is calculated automatically from its date and this length — changing it regroups your existing records without changing any stored data.</small>
    </div>`;

  const optionsTab = `
    <div class="option-tabs" role="tablist" aria-label="Option list">
      <button class="chip-tab ${field === 'dayTypes' ? 'active' : ''}" data-option-field="dayTypes" type="button">Day types</button>
      <button class="chip-tab ${field === 'paymentTypes' ? 'active' : ''}" data-option-field="paymentTypes" type="button">Payment types</button>
    </div>
    <p class="panel-hint">Deleting an option used by existing records archives it instead — those records keep showing their original value, and the option just won't appear in future dropdowns.</p>
    <ul class="option-list">
      ${list.map((o) => renderOptionRow(field, o, opts.optionUsageCount(state.records, field === 'dayTypes' ? 'dayType' : 'paymentType', o.label))).join('') || '<li class="muted">No options yet.</li>'}
    </ul>
    <form class="add-option-row" id="add-option-form">
      <input id="new-option-label" placeholder="Add a new ${fieldLabel.toLowerCase().replace(/s$/, '')}…" aria-label="New ${fieldLabel} name">
      <button class="btn secondary" type="submit">Add</button>
    </form>`;

  return `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div class="modal-head">
          <h2 id="settings-title">Settings</h2>
          <button class="icon-btn" id="btn-close-modal" aria-label="Close settings">✕</button>
        </div>
        <div class="modal-tabs" role="tablist">
          <button class="tab ${state.settingsTab === 'options' ? 'active' : ''}" data-tab="options" type="button">Options</button>
          <button class="tab ${state.settingsTab === 'general' ? 'active' : ''}" data-tab="general" type="button">General</button>
        </div>
        <div class="modal-body">
          ${state.settingsTab === 'options' ? optionsTab : generalTab}
        </div>
      </div>
    </div>`;
}

function renderDataModal() {
  if (state.modal !== 'data') return '';
  return `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="data-title">
        <div class="modal-head">
          <h2 id="data-title">Backup &amp; export</h2>
          <button class="icon-btn" id="btn-close-modal" aria-label="Close">✕</button>
        </div>
        <div class="modal-body">
          <div class="data-section">
            <h3>Export</h3>
            <p class="panel-hint">Save a full backup (records + settings), or a spreadsheet-friendly CSV of your records.</p>
            <div class="form-actions">
              <button class="btn secondary" id="btn-export-json" type="button">Download JSON backup</button>
              <button class="btn secondary" id="btn-export-csv" type="button" ${state.records.length ? '' : 'disabled'}>Download CSV</button>
            </div>
          </div>
          <div class="data-section">
            <h3>Restore</h3>
            <p class="panel-hint">Import a JSON backup. Choose whether to merge it with your current records or replace them entirely.</p>
            <input type="file" id="import-file" accept="application/json" class="visually-hidden">
            <div class="form-actions">
              <button class="btn secondary" id="btn-import-merge" type="button">Import &amp; merge</button>
              <button class="btn secondary" id="btn-import-replace" type="button">Import &amp; replace all</button>
            </div>
          </div>
          <div class="data-section danger-zone">
            <h3>Reset</h3>
            <p class="panel-hint">Permanently erase every record on this device. This cannot be undone — export a backup first.</p>
            <button class="btn danger-outline" id="btn-clear-all" type="button">Clear all records</button>
          </div>
        </div>
      </div>
    </div>`;
}

function renderToast() {
  if (!state.toast) return '';
  return `<div class="toast toast-${state.toast.tone}" role="status">${esc(state.toast.message)}</div>`;
}

function render() {
  applyTheme();
  root.innerHTML = `
    <div class="app-shell">
      ${renderHeader()}
      ${renderStats()}
      ${renderForm()}
      ${renderCalendar()}
      ${renderRecords()}
      ${renderInsights()}
    </div>
    ${renderSettingsModal()}
    ${renderDataModal()}
    ${renderToast()}
  `;
  wireEvents();
}

// ---------------------------------------------------------------------
// Live rate calculation (patches one field, no full re-render)
// ---------------------------------------------------------------------

function updateLiveRate() {
  const pay = Number(document.getElementById('f-pay')?.value || 0);
  const h = document.getElementById('f-hours')?.value || 0;
  const m = document.getElementById('f-minutes')?.value || 0;
  const mins = calc.durationMinutes(h, m);
  const out = document.getElementById('f-rate');
  if (out) out.textContent = pay > 0 && mins > 0 ? rate(pay, mins) : '—';
}

/** Live-updates the read-only "Pay cycle" preview in the form as the
 *  date field changes, using the same pure calculation the rest of the
 *  app uses — nothing is written to the record until it's submitted. */
function updateCyclePreview() {
  const dateVal = document.getElementById('f-date')?.value;
  const out = document.getElementById('f-cycle-preview');
  if (!out) return;
  const cyc = dateVal ? calc.getCycleForDate(dateVal, state.settings.payCycleLengthDays) : null;
  out.textContent = cyc ? cyc.cycleLabel : '—';
}

// ---------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------

function submitForm(event) {
  event.preventDefault();
  const hoursInput = document.getElementById('f-hours').value;
  const minutesInput = document.getElementById('f-minutes').value;

  const data = {
    date: document.getElementById('f-date').value,
    start: document.getElementById('f-start').value,
    // No manual cycle field: the pay cycle is derived automatically from
    // `date` + settings.payCycleLengthDays (see calculations.js#getCycleForDate)
    // every time it's displayed, rather than stored per record.
    workingMinutes: calc.durationMinutes(hoursInput, minutesInput),
    mapNumber: document.getElementById('f-map').value.trim(),
    dayType: document.getElementById('f-daytype').value,
    paymentType: document.getElementById('f-paytype').value,
    paymentAmount: Number(document.getElementById('f-pay').value) || 0,
    notes: document.getElementById('f-notes').value.trim(),
  };

  if (!data.date || !data.start || hoursInput === '' || minutesInput === '' || data.workingMinutes < 0) {
    state.formError = 'Date, starting time, hours and minutes are required.';
    render();
    return;
  }
  state.formError = '';

  if (state.editingId) {
    const r = state.records.find((x) => x.id === state.editingId);
    Object.assign(r, data);
    state.editingId = null;
    showToast('Record updated.');
  } else {
    state.records.push({ id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36), ...data });
    showToast('Record added.');
  }
  persist();
  render();
}

function startEdit(id) {
  state.editingId = id;
  state.formError = '';
  render();
  document.getElementById('form-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function deleteRecord(id) {
  const record = state.records.find((r) => r.id === id);
  if (!record) return;
  const label = `${calc.shortDateLabel(record.date)} (${calc.formatDuration(calc.recordMinutes(record))})`;
  if (!confirm(`Delete the record for ${label}? This cannot be undone.`)) return;
  state.records = state.records.filter((r) => r.id !== id);
  if (state.editingId === id) state.editingId = null;
  persist();
  showToast('Record deleted.');
  render();
}

function loadSampleData() {
  const samples = [
    { date: '2026-08-25', start: '16:00', cycle: '24 Aug – 6 Sep', workingMinutes: 142, mapNumber: 'B4', dayType: 'Afternoon', paymentType: 'Normal', paymentAmount: 60, notes: 'Sample record' },
    { date: '2026-08-27', start: '17:00', cycle: '24 Aug – 6 Sep', workingMinutes: 210, mapNumber: 'C1', dayType: 'Night', paymentType: 'Overtime', paymentAmount: 95, notes: 'Sample record' },
    { date: '2026-08-15', start: '09:00', cycle: '10 Aug – 23 Aug', workingMinutes: 300, mapNumber: 'A2', dayType: 'Day', paymentType: 'Normal', paymentAmount: 110, notes: 'Sample record' },
    { date: '2026-08-11', start: '10:00', cycle: '10 Aug – 23 Aug', workingMinutes: 180, mapNumber: 'A2', dayType: 'Day', paymentType: 'Weekend', paymentAmount: 80, notes: 'Sample record' },
  ];
  state.records = [...state.records, ...samples.map((s) => ({ id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random(), ...s }))];
  persist();
  showToast('Sample data loaded — delete any record to remove it.');
  render();
}

// -- Settings options ---------------------------------------------------

function updateOptionField(field, list) {
  state.settings = { ...state.settings, [field]: list };
  persist();
  render();
}

function handleOptionAction(action, field, id) {
  const list = state.settings[field];
  const recordField = field === 'dayTypes' ? 'dayType' : 'paymentType';
  const option = list.find((o) => o.id === id);
  if (!option) return;

  if (action === 'move-up') return updateOptionField(field, opts.reorderOption(list, id, 'up'));
  if (action === 'move-down') return updateOptionField(field, opts.reorderOption(list, id, 'down'));
  if (action === 'restore') return updateOptionField(field, opts.restoreOption(list, id));

  if (action === 'rename') {
    const next = prompt('Rename option to:', option.label);
    if (next === null) return;
    const result = opts.renameOption(list, id, next);
    if (result.error) {
      showToast(result.error, 'error');
      return;
    }
    const usage = opts.optionUsageCount(state.records, recordField, option.label);
    let records = state.records;
    if (usage > 0 && confirm(`${usage} existing record${usage === 1 ? '' : 's'} currently show "${option.label}". Update ${usage === 1 ? 'it' : 'them'} to "${next.trim()}" as well?\n\nChoose Cancel to keep those records showing "${option.label}".`)) {
      const bulk = opts.bulkRenameRecords(records, recordField, option.label, next.trim());
      records = bulk.records;
    }
    state.records = records;
    state.settings = { ...state.settings, [field]: result.list };
    persist();
    render();
    return;
  }

  if (action === 'remove') {
    const usage = opts.optionUsageCount(state.records, recordField, option.label);
    if (usage > 0) {
      if (confirm(`"${option.label}" is used by ${usage} record${usage === 1 ? '' : 's'}. It can't be deleted without losing that history, so it will be archived instead: it stays visible on existing records but won't be offered for new ones. Continue?`)) {
        updateOptionField(field, opts.archiveOption(list, id));
      }
      return;
    }
    if (confirm(`Delete "${option.label}"? It isn't used by any records.`)) {
      updateOptionField(field, opts.removeOption(list, id));
    }
  }
}

// -- Data: export / import / reset --------------------------------------

function exportJSON() {
  const backup = store.buildBackup(state.records, state.settings);
  store.downloadFile(`worktrack-backup-${calc.todayString()}.json`, JSON.stringify(backup, null, 2), 'application/json');
  showToast('Backup downloaded.');
}

function exportCSV() {
  const csv = store.recordsToCSV(state.records, state.settings.payCycleLengthDays);
  store.downloadFile(`worktrack-records-${calc.todayString()}.csv`, csv, 'text/csv');
  showToast('CSV downloaded.');
}

// -- Per-cycle export (PDF / JPG / Excel) --------------------------------

async function handleCycleExport(format, cycleKey) {
  const cycles = calc.groupByCycle(state.records, state.settings.payCycleLengthDays);
  const cycle = cycles.find((c) => c.key === cycleKey);
  if (!cycle) return;
  try {
    const options = { currency: state.settings.currency };
    const exportModule = await import('./export.js');
    if (format === 'pdf') exportModule.exportCyclePDF(cycle, options);
    else if (format === 'jpg') exportModule.exportCycleJPG(cycle, options);
    else if (format === 'xlsx') await exportModule.exportCycleExcel(cycle, options);
    showToast(`${format.toUpperCase()} downloaded for ${cycle.cycleLabel}.`);
  } catch (err) {
    showToast(err.message || 'Export failed.', 'error');
  }
}

function handleImport(mode) {
  const input = document.getElementById('import-file');
  input.value = '';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const { records: incoming, settings: incomingSettings } = store.parseBackup(String(reader.result));
        if (mode === 'replace') {
          if (!confirm(`Replace all ${state.records.length} current record(s) with the ${incoming.length} record(s) in this file? This cannot be undone — export a backup first if unsure.`)) return;
          state.records = incoming;
          if (incomingSettings) state.settings = { ...state.settings, ...incomingSettings };
          showToast(`Replaced with ${incoming.length} imported record(s).`);
        } else {
          const { merged, added } = store.mergeRecords(state.records, incoming);
          state.records = merged;
          showToast(`Imported ${added} new record(s); ${incoming.length - added} duplicate(s) skipped.`);
        }
        persist();
        state.modal = null;
        render();
      } catch (err) {
        showToast(err.message || 'Could not import that file.', 'error');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function clearAllRecords() {
  if (!state.records.length) {
    showToast('There are no records to clear.');
    return;
  }
  if (!confirm(`Delete all ${state.records.length} record(s) from this device? Export a backup first if you might want them later. This cannot be undone.`)) return;
  state.records = [];
  persist();
  state.modal = null;
  showToast('All records cleared.');
  render();
}

// ---------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------

function closeModal() {
  state.modal = null;
  render();
}

function wireEvents() {
  document.getElementById('btn-theme')?.addEventListener('click', () => {
    const order = ['system', 'light', 'dark'];
    const current = state.settings.theme === 'dark' ? 'light' : 'dark';
    state.settings = { ...state.settings, theme: current };
    persist();
    render();
  });

  document.getElementById('btn-settings')?.addEventListener('click', () => {
    state.modal = 'settings';
    render();
  });
  document.getElementById('btn-data')?.addEventListener('click', () => {
    state.modal = 'data';
    render();
  });
  document.getElementById('btn-close-modal')?.addEventListener('click', closeModal);
  document.getElementById('modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });

  document.getElementById('record-form')?.addEventListener('submit', submitForm);
  document.getElementById('btn-cancel-edit')?.addEventListener('click', () => {
    state.editingId = null;
    state.formError = '';
    render();
  });
  ['f-pay', 'f-hours', 'f-minutes'].forEach((id) => document.getElementById(id)?.addEventListener('input', updateLiveRate));
  updateLiveRate();
  document.getElementById('f-date')?.addEventListener('input', updateCyclePreview);
  updateCyclePreview();

  root.querySelectorAll('[data-action="edit"]').forEach((b) => b.addEventListener('click', () => startEdit(b.dataset.id)));
  root.querySelectorAll('[data-action="delete"]').forEach((b) => b.addEventListener('click', () => deleteRecord(b.dataset.id)));
  root.querySelectorAll('[data-cycle-export]').forEach((b) =>
    b.addEventListener('click', () => handleCycleExport(b.dataset.cycleExport, b.dataset.cycleKey))
  );

  document.getElementById('btn-sample-data')?.addEventListener('click', loadSampleData);

  // Settings modal
  document.querySelectorAll('.modal-tabs .tab').forEach((b) =>
    b.addEventListener('click', () => {
      state.settingsTab = b.dataset.tab;
      render();
    })
  );
  document.querySelectorAll('[data-option-field]').forEach((b) =>
    b.addEventListener('click', () => {
      state.optionField = b.dataset.optionField;
      render();
    })
  );
  document.querySelectorAll('[data-opt-action]').forEach((b) =>
    b.addEventListener('click', () => handleOptionAction(b.dataset.optAction, b.dataset.field, b.dataset.id))
  );
  document.getElementById('add-option-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('new-option-label');
    const result = opts.addOption(state.settings[state.optionField], input.value);
    if (result.error) {
      showToast(result.error, 'error');
      return;
    }
    updateOptionField(state.optionField, result.list);
  });
  document.getElementById('s-currency')?.addEventListener('change', (e) => {
    state.settings = { ...state.settings, currency: e.target.value.trim().toUpperCase() || 'USD' };
    persist();
    render();
  });
  document.getElementById('s-theme')?.addEventListener('change', (e) => {
    state.settings = { ...state.settings, theme: e.target.value };
    persist();
    render();
  });
  document.getElementById('s-default-start')?.addEventListener('change', (e) => {
    state.settings = { ...state.settings, defaults: { ...state.settings.defaults, startTime: e.target.value } };
    persist();
  });
  document.getElementById('s-cycle-length')?.addEventListener('change', (e) => {
    const days = [7, 14, 30].includes(Number(e.target.value)) ? Number(e.target.value) : 14;
    state.settings = { ...state.settings, payCycleLengthDays: days };
    persist();
    render();
  });

  // Data modal
  document.getElementById('btn-export-json')?.addEventListener('click', exportJSON);
  document.getElementById('btn-export-csv')?.addEventListener('click', exportCSV);
  document.getElementById('btn-import-merge')?.addEventListener('click', () => handleImport('merge'));
  document.getElementById('btn-import-replace')?.addEventListener('click', () => handleImport('replace'));
  document.getElementById('btn-clear-all')?.addEventListener('click', clearAllRecords);

  document.addEventListener('keydown', escToClose, { once: true });
}

function escToClose(e) {
  if (e.key === 'Escape' && state.modal) closeModal();
}

render();
