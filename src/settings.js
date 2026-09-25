/**
 * settings.js
 * -----------------------------------------------------------------------
 * Logic for the configurable option lists (day types, payment types).
 *
 * The core safety rule implemented here: an option that any record
 * currently uses can never be silently deleted. It can only be
 * "archived" — hidden from the dropdowns offered for *new* records,
 * while every existing record keeps showing its original stored text
 * exactly as it was saved. Only an option with zero matching records
 * can be removed outright, and even then the caller has to say so
 * explicitly (see removeOption).
 * -----------------------------------------------------------------------
 */
import { makeOptionId } from './storage.js';

/** How many records currently use this option's *current* label. */
export function optionUsageCount(records, field, label) {
  if (!label) return 0;
  return records.filter((r) => (r[field] || '') === label).length;
}

export function activeOptions(list) {
  return (list || []).filter((o) => !o.archived);
}

/**
 * Options to offer in a <select>: active options, plus (if editing a
 * record) whatever value that record currently holds, even if it's
 * archived or no longer a recognised option at all. This guarantees a
 * record's historical value is always visible and never silently
 * swapped out from under the user.
 */
export function optionsForSelect(list, currentValue) {
  const active = activeOptions(list);
  if (currentValue && !active.some((o) => o.label === currentValue)) {
    const known = (list || []).find((o) => o.label === currentValue);
    return [...active, known || { id: makeOptionId(currentValue), label: currentValue, archived: true, legacy: !known }];
  }
  return active;
}

export function addOption(list, label) {
  const trimmed = String(label || '').trim();
  if (!trimmed) return { list, error: 'Enter a name for the new option.' };
  if ((list || []).some((o) => o.label.toLowerCase() === trimmed.toLowerCase())) {
    return { list, error: `"${trimmed}" already exists.` };
  }
  const next = [...(list || []), { id: makeOptionId(trimmed), label: trimmed, archived: false }];
  return { list: next, error: null };
}

/**
 * Rename an option in the settings list. By itself this does NOT touch
 * any saved record — old records keep their original string until the
 * caller explicitly opts in to a bulk update (see bulkRenameRecords).
 */
export function renameOption(list, id, newLabel) {
  const trimmed = String(newLabel || '').trim();
  if (!trimmed) return { list, error: 'Name cannot be empty.' };
  if ((list || []).some((o) => o.id !== id && o.label.toLowerCase() === trimmed.toLowerCase())) {
    return { list, error: `"${trimmed}" already exists.` };
  }
  const next = (list || []).map((o) => (o.id === id ? { ...o, label: trimmed } : o));
  return { list: next, error: null };
}

export function archiveOption(list, id) {
  return (list || []).map((o) => (o.id === id ? { ...o, archived: true } : o));
}

export function restoreOption(list, id) {
  return (list || []).map((o) => (o.id === id ? { ...o, archived: false } : o));
}

/** Only ever call this when optionUsageCount() is 0 for this option. */
export function removeOption(list, id) {
  return (list || []).filter((o) => o.id !== id);
}

export function reorderOption(list, id, direction) {
  const next = [...(list || [])];
  const i = next.findIndex((o) => o.id === id);
  const j = direction === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= next.length) return next;
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** Update every record using `oldLabel` to `newLabel` for this field — opt-in only. */
export function bulkRenameRecords(records, field, oldLabel, newLabel) {
  let count = 0;
  const updated = records.map((r) => {
    if ((r[field] || '') === oldLabel) {
      count += 1;
      return { ...r, [field]: newLabel };
    }
    return r;
  });
  return { records: updated, count };
}
