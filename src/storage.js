/**
 * storage.js
 * -----------------------------------------------------------------------
 * Everything that touches localStorage, plus JSON/CSV import & export.
 *
 * DATA-SAFETY CONTRACT (read this before changing anything in here):
 *   - RECORDS_KEY is the exact key the original single-file tracker
 *     used ('modern_work_hours_tracker_v1'). It is never renamed and
 *     the array shape stored under it is never restructured. Anyone
 *     upgrading from the old HTML file keeps every record.
 *   - Settings live under a SEPARATE key. A brand-new key can't
 *     collide with or overwrite anything that already exists.
 *   - migrateRecord() only ever ADDS a normalized `id`/shape when one
 *     is missing; it never deletes a field it doesn't understand, so
 *     unknown/future fields round-trip untouched.
 * -----------------------------------------------------------------------
 */
import { recordMinutes, getCycleForDate } from './calculations.js';

export const RECORDS_KEY = 'modern_work_hours_tracker_v1';
export const SETTINGS_KEY = 'modern_work_hours_tracker_v1_settings';
const SCHEMA_VERSION = 1;

const slugify = (label) =>
  String(label)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || `option-${Math.random().toString(36).slice(2, 8)}`;

function defaultSettings() {
  // These labels intentionally match the original hard-coded arrays
  // from the single-file version, so an upgrade changes nothing about
  // what a returning user sees in the dropdowns.
  const dayTypeLabels = ['Day', 'Afternoon', 'Night', 'Overnight'];
  const paymentTypeLabels = ['Normal', 'Overtime', 'Weekend', 'Public Holiday', 'Casual loading'];

  return {
    schemaVersion: SCHEMA_VERSION,
    currency: 'AUD',
    theme: 'system', // 'system' | 'light' | 'dark'
    // Pay-cycle length in days: 7 | 14 | 30. Drives calculations.js's
    // automatic cycle grouping — see getCycleForDate(). 14 (fortnight)
    // matches the app's original hard-coded assumption, so an upgrade
    // changes nothing about existing grouping until this is changed.
    payCycleLengthDays: 14,
    dayTypes: dayTypeLabels.map((label) => ({ id: slugify(label), label, archived: false })),
    paymentTypes: paymentTypeLabels.map((label) => ({ id: slugify(label), label, archived: false })),
    defaults: { dayType: dayTypeLabels[0], paymentType: paymentTypeLabels[0], startTime: '09:00' },
  };
}

function safeParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    console.warn('WorkTrack: could not parse stored data, ignoring it rather than overwriting it.');
    return fallback;
  }
}

/** Fill in an id/shape gap on an old record without discarding anything. */
function migrateRecord(record) {
  return {
    id: record.id || (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)),
    date: record.date || '',
    start: record.start || '',
    cycle: record.cycle || 'Unassigned',
    workingMinutes: recordMinutes(record),
    mapNumber: record.mapNumber || '',
    dayType: record.dayType || '',
    paymentType: record.paymentType || '',
    paymentAmount: Number(record.paymentAmount) || 0,
    notes: record.notes || '',
  };
}

export function loadRecords() {
  const raw = safeParse(localStorage.getItem(RECORDS_KEY), []);
  const list = Array.isArray(raw) ? raw : [];
  return list.map(migrateRecord);
}

export function saveRecords(records) {
  localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
}

export function loadSettings() {
  const stored = safeParse(localStorage.getItem(SETTINGS_KEY), null);
  const base = defaultSettings();
  if (!stored || typeof stored !== 'object') return base;

  // Merge rather than replace, so a settings file from an older
  // version of the app that's missing a newer field still works.
  return {
    ...base,
    ...stored,
    dayTypes: Array.isArray(stored.dayTypes) && stored.dayTypes.length ? stored.dayTypes : base.dayTypes,
    paymentTypes: Array.isArray(stored.paymentTypes) && stored.paymentTypes.length ? stored.paymentTypes : base.paymentTypes,
    payCycleLengthDays: [7, 14, 30].includes(Number(stored.payCycleLengthDays)) ? Number(stored.payCycleLengthDays) : base.payCycleLengthDays,
    defaults: { ...base.defaults, ...(stored.defaults || {}) },
  };
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, schemaVersion: SCHEMA_VERSION }));
}

export function makeOptionId(label) {
  return slugify(label);
}

// ---------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------

export function buildBackup(records, settings) {
  return {
    app: 'WorkTrack',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    records,
    settings,
  };
}

/**
 * Parse+validate a backup file's contents. Throws a descriptive error
 * rather than silently accepting something malformed — an import is a
 * destructive-adjacent action and deserves a clear failure.
 */
export function parseBackup(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.records)) {
    throw new Error('That file does not look like a WorkTrack backup (missing a "records" array).');
  }
  return {
    records: data.records.map(migrateRecord),
    settings: data.settings && typeof data.settings === 'object' ? data.settings : null,
  };
}

/** Merge imported records into the current set, skipping duplicate ids. */
export function mergeRecords(existing, incoming) {
  const existingIds = new Set(existing.map((r) => r.id));
  const merged = [...existing];
  let added = 0;
  for (const record of incoming) {
    if (!existingIds.has(record.id)) {
      merged.push(record);
      existingIds.add(record.id);
      added += 1;
    }
  }
  return { merged, added };
}

// ---------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------

function csvCell(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * @param {number} [cycleLengthDays] Current payCycleLengthDays setting,
 *   used to fill the "Cycle" column with the same automatically
 *   calculated cycle the rest of the app shows (see
 *   calculations.js#getCycleForDate). Defaults to 14 (fortnight) if
 *   omitted, matching the app's default setting.
 */
export function recordsToCSV(records, cycleLengthDays = 14) {
  const headers = [
    'Date', 'Start Time', 'Working Hours', 'Working Minutes', 'Duration (min)',
    'Cycle', 'Map Number', 'Day Type', 'Payment Type', 'Payment Amount',
    'Earned Per Hour', 'Notes',
  ];

  const rows = records.map((r) => {
    const mins = recordMinutes(r);
    const rate = mins > 0 ? (Number(r.paymentAmount) || 0) / (mins / 60) : 0;
    const cyc = getCycleForDate(r.date, cycleLengthDays);
    return [
      r.date,
      r.start,
      Math.floor(mins / 60),
      mins % 60,
      mins,
      cyc ? cyc.cycleLabel : 'Unassigned',
      r.mapNumber || '',
      r.dayType || '',
      r.paymentType || '',
      (Number(r.paymentAmount) || 0).toFixed(2),
      rate.toFixed(2),
      r.notes || '',
    ];
  });

  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
