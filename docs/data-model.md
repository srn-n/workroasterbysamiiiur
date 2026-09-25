# Data model & migration notes

## Records — `localStorage["modern_work_hours_tracker_v1"]`

A JSON array. Each record:

```jsonc
{
  "id": "string",              // stable unique id
  "date": "YYYY-MM-DD",
  "start": "HH:MM",            // 24-hour
  "cycle": "string",           // LEGACY ONLY — see "Pay cycles" below
  "workingMinutes": 142,       // whole minutes — e.g. 2h22m is stored as 142, not 2.22
  "mapNumber": "string",
  "dayType": "string",         // one of settings.dayTypes[].label at time of entry
  "paymentType": "string",     // one of settings.paymentTypes[].label at time of entry
  "paymentAmount": 60,         // number
  "notes": "string"
}
```

**Backward compatibility:** an even older record shape stored duration as
a decimal `workingHours` field (e.g. `2.5` for 2h30m) instead of
`workingMinutes`. `calculations.js#recordMinutes()` and
`storage.js#loadRecords()` read either shape transparently — a record is
never rewritten just to "normalize" it, so nothing is lost or altered by
opening the app.

## Pay cycles (automatic)

Records no longer carry a manually-typed cycle. Instead, every record's
pay cycle is *calculated* from its `date` and the `payCycleLengthDays`
setting, every time it's needed — nothing cycle-related is written back
to the record. The form only asks for a date; the calculated cycle is
shown next to it as a live, read-only preview.

The calculation (`calculations.js#getCycleForDate`) is a pure function of
`(date, cycleLengthDays, anchor)`:

```
blockIndex = floor((date - anchor) / cycleLengthDays)
cycleStart = anchor + blockIndex * cycleLengthDays
cycleEnd   = cycleStart + cycleLengthDays - 1
```

`anchor` defaults to `DEFAULT_CYCLE_ANCHOR = "1970-01-12"` — a fixed
reference **Monday**. Because the anchor is a Monday and both 7 and 14
divide evenly into a week, this one formula produces:

- **7-day cycles:** the Monday–Sunday week containing the date.
- **14-day cycles:** two consecutive Monday–Sunday weeks, paired
  consistently because they're counted from the same fixed anchor.
- **30-day cycles:** plain 30-day blocks counted from the same anchor —
  not a weekly interpretation, just a deterministic day count.

All arithmetic runs in UTC internally, so daylight-saving clock changes
can never shift a date into the wrong cycle. The same date, cycle length
and anchor always resolve to the same cycle — changing
`payCycleLengthDays` in Settings re-buckets every record's *display*
grouping instantly, without touching a single stored record.

**Why 1970-01-12 and not some other Monday?** Any Monday gives identical
7-day weeks, but a 14-day (fortnightly) cycle has two possible Monday
"parities" — which one is correct depends on which week the employer's
pay schedule actually starts on, and the wrong choice silently splits
real fortnightly pay periods in half instead of grouping them together.
1970-01-12 was picked because it's the parity that matches this
tracker's real historical fortnights (verified against previously
recorded pay periods, e.g. Mon 29 Jun 2026 – Sun 12 Jul 2026). To switch
parity for a different pay schedule, shift the anchor by exactly ±7 days
— 7-day cycles are unaffected, and 30-day cycles simply shift their
(otherwise arbitrary) block boundaries.

**What happened to the old `cycle` field?** Records created before this
feature may still have a manually-typed `cycle` string (e.g. `"24 Aug –
6 Sep"`). That field is never deleted or rewritten — it's preserved
exactly as-is, but the app stops reading it for grouping, sorting or
totals. If a record's old text no longer matches its freshly computed
cycle, the record row shows a small "Was: *original text*" note so the
history stays visible rather than silently disappearing. New records
never set this field at all.

`dayType` and `paymentType` are stored as the option's **label text**,
not an id. This mirrors the original tracker's behaviour and is what
makes archiving (rather than deleting) safe: a record's stored string
never depends on a settings entry continuing to exist.

## Settings — `localStorage["modern_work_hours_tracker_v1_settings"]`

```jsonc
{
  "schemaVersion": 1,
  "currency": "AUD",            // any ISO 4217 code
  "theme": "system",            // "system" | "light" | "dark"
  "payCycleLengthDays": 14,     // 7 | 14 | 30 — see "Pay cycles (automatic)" above
  "dayTypes": [
    { "id": "day", "label": "Day", "archived": false }
  ],
  "paymentTypes": [
    { "id": "normal", "label": "Normal", "archived": false }
  ],
  "defaults": {
    "dayType": "Day",
    "paymentType": "Normal",
    "startTime": "09:00"
  }
}
```

This key is new. If it doesn't exist (first run, or an upgrade from the
original single-file tracker, which had no settings), it's created with
defaults that match that original tracker's hard-coded lists exactly —
`Day / Afternoon / Night / Overnight` and
`Normal / Overtime / Weekend / Public Holiday / Casual loading` — so an
upgrade changes nothing about what's in the dropdowns until you edit
them yourself.

`storage.js#loadSettings()` merges whatever is stored over the defaults
field-by-field, so a settings object saved by an older version of this
app (missing a field a newer version added) is filled in rather than
rejected.

## If you change the schema

1. Never rename `RECORDS_KEY` in `storage.js`, and never write a shape
   under it that a plain array-of-records reader can't parse.
2. Add new record fields as optional — read with a fallback (see
   `migrateRecord()` in `storage.js`), don't require them.
3. If a field's meaning changes (not just a rename), give `settings`
   (or a new key) a `schemaVersion` bump and write a small migration
   function, the same way `recordMinutes()` already bridges the old
   `workingHours` decimal format.
4. Add a case to the Playwright/manual test that seeds the *old* shape
   in `localStorage` before load, to prove the migration path still
   works — that's how the pay-cycle-ordering and decimal-hours
   compatibility were verified for this version.
