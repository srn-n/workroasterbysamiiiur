/**
 * calculations.js
 * -----------------------------------------------------------------------
 * Pure, framework-free math helpers. Nothing in this file touches
 * localStorage or the DOM, so it can be unit-tested in isolation.
 *
 * The one rule every function here respects: working time is always
 * carried around as *minutes* (an integer), never as a hand-rolled
 * decimal like "2.22" for 2h22m. Decimal hours only exist at the very
 * last step, right before something is displayed or divided.
 * -----------------------------------------------------------------------
 */

/** Clamp+round a (hours, minutes) pair from the form into whole minutes. */
export function durationMinutes(h, m) {
  const hoursValue = Math.max(0, Number(h) || 0);
  const minutesValue = Math.max(0, Math.min(59, Number(m) || 0));
  return Math.round(hoursValue * 60 + minutesValue);
}

/**
 * Resolve a record's working time to minutes, whatever legacy shape it
 * was saved in. This is the single compatibility shim that lets old
 * records (some tracker versions stored decimal hours) keep working
 * without a destructive migration.
 */
export function recordMinutes(record) {
  if (Number.isFinite(Number(record.workingMinutes))) {
    return Number(record.workingMinutes);
  }
  if (Number.isFinite(Number(record.workingHours))) {
    return Math.round(Number(record.workingHours) * 60);
  }
  return 0;
}

/** Split whole minutes back into {hours, minutes} for form pre-fill. */
export function minutesToParts(totalMinutes) {
  const m = Math.max(0, Math.round(Number(totalMinutes) || 0));
  return { hours: Math.floor(m / 60), minutes: m % 60 };
}

export function decimalHoursFromMinutes(minutes) {
  return (Number(minutes) || 0) / 60;
}

/** Earnings per hour, guarding against divide-by-zero. */
export function hourlyRate(pay, minutes) {
  const h = decimalHoursFromMinutes(minutes);
  return h > 0 ? (Number(pay) || 0) / h : 0;
}

export function formatDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function formatMoney(amount, currency = 'AUD', locale = undefined) {
  const value = Number(amount) || 0;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    // Unknown/invalid currency code typed into settings — fall back
    // rather than throwing and blanking the whole dashboard.
    return `$${value.toFixed(2)}`;
  }
}

export function formatRate(pay, minutes, currency) {
  const rate = hourlyRate(pay, minutes);
  return rate > 0 ? `${formatMoney(rate, currency)}/hr` : '—';
}

/** Epoch ms for a plain "YYYY-MM-DD" string, timezone-safe (local midnight). */
export function dateValue(dateString) {
  if (!dateString) return 0;
  const t = new Date(`${dateString}T00:00:00`).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function todayString() {
  return new Date().toISOString().slice(0, 10);
}

export function dayName(dateString) {
  return new Date(`${dateString}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' });
}

export function dateLabel(dateString) {
  return new Date(`${dateString}T00:00:00`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function shortDateLabel(dateString) {
  return new Date(`${dateString}T00:00:00`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
}

/**
 * Automatic pay-cycle calculation.
 * -----------------------------------------------------------------------
 * A cycle is a deterministic function of (date, cycleLengthDays, anchor):
 * the same inputs always resolve to the same cycle, so changing the
 * configured cycle length re-buckets every record consistently without
 * anything being stored per record.
 *
 * DEFAULT_CYCLE_ANCHOR ('1970-01-12') is a fixed reference Monday. All
 * cycle math counts whole cycleLengthDays-sized blocks forward/backward
 * from this date:
 *
 *   blockIndex = floor((date - anchor) / cycleLengthDays)
 *   cycleStart = anchor + blockIndex * cycleLengthDays
 *   cycleEnd   = cycleStart + cycleLengthDays - 1
 *
 * Because the anchor is a Monday and 7 and 14 both divide evenly into a
 * week, this single formula naturally produces Monday-anchored weekly
 * (7-day) and fortnightly (14-day, two consecutive Mon–Sun weeks) cycles
 * with no special-casing. For 30-day cycles the same formula is used
 * as-is — a plain deterministic 30-day block count from the same anchor,
 * not a weekly interpretation. All arithmetic runs in UTC internally so
 * daylight-saving transitions can never shift a date across a cycle
 * boundary.
 *
 * Why this specific Monday, and not any other: for a 7-day cycle every
 * Monday gives the same weeks, but for a 14-day (fortnightly) cycle there
 * are two possible Monday "parities" — real fortnightly pay cycles fall
 * on one or the other depending on which week the employer started
 * paying on, and picking the wrong one silently splits every real pay
 * period in half. 1970-01-12 was chosen (over the equally-valid
 * 1970-01-05, exactly one week earlier) because it's the parity that
 * matches this tracker's actual historical pay records — confirmed by
 * lining up computed cycles against previously recorded fortnights
 * (e.g. Mon 29 Jun 2026 – Sun 12 Jul 2026). If this ever needs to change
 * for a different pay schedule, shift the anchor by ±7 days to flip
 * fortnightly parity (7-day cycles are unaffected either way; 30-day
 * cycles will shift their block boundaries, which is harmless since they
 * have no real-world weekly reference to preserve).
 */
export const DEFAULT_CYCLE_ANCHOR = '1970-01-12';
const DAY_MS = 24 * 60 * 60 * 1000;
const VALID_CYCLE_LENGTHS = [7, 14, 30];

function parseDateUTC(dateString) {
  const [y, m, d] = String(dateString).split('-').map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
}

function formatDateUTC(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Human label for a cycle span, e.g. "21 Sep – 27 Sep 2026" or, when it
 *  crosses a year boundary, "28 Dec 2026 – 3 Jan 2027". */
function cycleRangeLabel(cycleStart, cycleEnd) {
  const sameYear = cycleStart.slice(0, 4) === cycleEnd.slice(0, 4);
  const start = sameYear ? shortDateLabel(cycleStart) : dateLabel(cycleStart);
  return `${start} – ${dateLabel(cycleEnd)}`;
}

/**
 * Resolve which pay cycle a date belongs to. Pure function — no DOM, no
 * storage. Returns null for a missing/unparseable date so callers can
 * fall back to an "Unassigned" bucket instead of throwing.
 */
export function getCycleForDate(dateString, cycleLengthDays, anchorDateString = DEFAULT_CYCLE_ANCHOR) {
  if (!dateString) return null;
  const length = VALID_CYCLE_LENGTHS.includes(Number(cycleLengthDays)) ? Number(cycleLengthDays) : 14;
  const anchorMs = parseDateUTC(anchorDateString || DEFAULT_CYCLE_ANCHOR);
  const dateMs = parseDateUTC(dateString);
  if (!Number.isFinite(dateMs)) return null;

  const diffDays = Math.floor((dateMs - anchorMs) / DAY_MS);
  const blockIndex = Math.floor(diffDays / length);
  const cycleStartMs = anchorMs + blockIndex * length * DAY_MS;
  const cycleEndMs = cycleStartMs + (length - 1) * DAY_MS;

  const cycleStart = formatDateUTC(cycleStartMs);
  const cycleEnd = formatDateUTC(cycleEndMs);
  return { cycleStart, cycleEnd, key: cycleStart, cycleLabel: cycleRangeLabel(cycleStart, cycleEnd) };
}

const MONTH_PREFIXES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Best-effort parse of a legacy free-text cycle label like "Sep 7 to Sep 20"
 * or "Aug 24 to Sep 06" into { startMonth, startDay, endMonth, endDay }
 * (1-indexed months). Returns null if the text doesn't match this shape —
 * callers should treat that as "can't confirm", not "definitely differs".
 */
function parseLegacyCycleRange(text) {
  const m = /^([A-Za-z]{3,9})\s+(\d{1,2})\s+to\s+([A-Za-z]{3,9})\s+(\d{1,2})$/i.exec(String(text || '').trim());
  if (!m) return null;
  const startMonth = MONTH_PREFIXES.indexOf(m[1].slice(0, 3).toLowerCase());
  const endMonth = MONTH_PREFIXES.indexOf(m[3].slice(0, 3).toLowerCase());
  if (startMonth === -1 || endMonth === -1) return null;
  return { startMonth: startMonth + 1, startDay: Number(m[2]), endMonth: endMonth + 1, endDay: Number(m[4]) };
}

/**
 * Does a legacy free-text cycle label (e.g. "Sep 7 to Sep 20", typed before
 * automatic cycles existed) describe the SAME period as a computed cycle
 * (e.g. { cycleStart: "2026-09-07", cycleEnd: "2026-09-20" })? This is a
 * semantic comparison, not string equality — the two will almost never be
 * byte-identical (legacy text never carries a year and uses "to" instead of
 * "–"), so comparing raw strings would flag nearly every legacy record as a
 * mismatch even when it describes the exact same fortnight. The legacy
 * text's year is assumed from the computed cycle's own start/end years
 * (free text never states one), so this only confirms month+day agreement.
 * Returns false — "does not match", so the caller still surfaces it as a
 * legacy note — whenever the text doesn't parse or a real caller should
 * treat as unconfirmed rather than silently trusting a coincidental parse.
 */
export function legacyCycleMatchesComputed(legacyText, computedCycle) {
  if (!legacyText || !computedCycle) return false;
  const parsed = parseLegacyCycleRange(legacyText);
  if (!parsed) return false;
  const startYear = computedCycle.cycleStart.slice(0, 4);
  const endYear = computedCycle.cycleEnd.slice(0, 4);
  const parsedStart = `${startYear}-${String(parsed.startMonth).padStart(2, '0')}-${String(parsed.startDay).padStart(2, '0')}`;
  const parsedEnd = `${endYear}-${String(parsed.endMonth).padStart(2, '0')}-${String(parsed.endDay).padStart(2, '0')}`;
  return parsedStart === computedCycle.cycleStart && parsedEnd === computedCycle.cycleEnd;
}

/**
 * Group records by their AUTOMATICALLY CALCULATED pay cycle (from each
 * record's date + the configured cycle length — see getCycleForDate),
 * and order the groups by cycle start date, most recent first. A record
 * without a usable date falls into a single "Unassigned" bucket, sorted
 * last. Any legacy free-text `record.cycle` value is intentionally never
 * consulted here — it's historical display-only data now (see
 * docs/data-model.md), not a grouping key.
 */
export function groupByCycle(records, cycleLengthDays = 14, anchorDateString = DEFAULT_CYCLE_ANCHOR) {
  const groups = new Map();
  const UNASSIGNED_KEY = '\u0000unassigned';

  for (const record of records) {
    const cyc = getCycleForDate(record.date, cycleLengthDays, anchorDateString);
    const key = cyc ? cyc.key : UNASSIGNED_KEY;
    if (!groups.has(key)) {
      groups.set(
        key,
        cyc
          ? { key: cyc.key, cycleStart: cyc.cycleStart, cycleEnd: cyc.cycleEnd, cycleLabel: cyc.cycleLabel, records: [] }
          : { key: UNASSIGNED_KEY, cycleStart: null, cycleEnd: null, cycleLabel: 'Unassigned', records: [] }
      );
    }
    groups.get(key).records.push(record);
  }

  for (const group of groups.values()) {
    group.records.sort((a, b) => dateValue(b.date) - dateValue(a.date) || String(b.start || '').localeCompare(String(a.start || '')));
  }

  const ordered = [...groups.values()].sort((a, b) => {
    if (!a.cycleStart) return 1;
    if (!b.cycleStart) return -1;
    return dateValue(b.cycleStart) - dateValue(a.cycleStart);
  });

  return ordered.map((group) => ({
    key: group.key,
    cycleStart: group.cycleStart,
    cycleEnd: group.cycleEnd,
    cycleLabel: group.cycleLabel,
    records: group.records,
    totalMinutes: group.records.reduce((sum, r) => sum + recordMinutes(r), 0),
    totalPay: group.records.reduce((sum, r) => sum + (Number(r.paymentAmount) || 0), 0),
    startDate: group.cycleStart ? dateValue(group.cycleStart) : 0,
  }));
}

export function totalMinutes(records) {
  return records.reduce((sum, r) => sum + recordMinutes(r), 0);
}

export function totalPay(records) {
  return records.reduce((sum, r) => sum + (Number(r.paymentAmount) || 0), 0);
}

/**
 * Weighted overall hourly rate: total earnings / total working hours.
 * NOT an average of each day's individual rate — a handful of very
 * short high-rate shifts must not skew the headline number.
 */
export function weightedAverageRate(records) {
  return hourlyRate(totalPay(records), totalMinutes(records));
}

/** Average clock-in time across all records with a valid "HH:MM" start. */
export function averageStartTime(records) {
  const valid = records.filter((r) => /^\d{2}:\d{2}$/.test(r.start || ''));
  if (!valid.length) return null;

  const totalMins = valid.reduce((sum, r) => {
    const [h, m] = r.start.split(':').map(Number);
    return sum + h * 60 + m;
  }, 0);

  const mins = Math.round(totalMins / valid.length);
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Format a 24h "HH:MM" as a friendly 12h label, e.g. "4:32 PM". */
export function formatTime12h(hhmm) {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return '—';
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}
