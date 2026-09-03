/**
 * Keeply — allowance periods (Phase 9).
 *
 * An allowance resets on a calendar boundary, and this module is the only place
 * that decides where those boundaries are. Everything else — the SQL that sums
 * spend, the card that says "₱4,200 left", the screen that says "12 days to
 * go" — asks here and does no date arithmetic of its own.
 *
 * ── WHY THIS FILE IS PURE ──────────────────────────────────────────────────
 * No `@/db`, no React Native, no Expo. `node --test` loads it directly, because
 * this is the highest-risk logic in the phase and it deserves the same
 * ten-timezone treatment `tests/format-dates.test.ts` gives calendar dates.
 *
 * ── THE RULES, AND THE BUG EACH ONE PREVENTS ───────────────────────────────
 * 1. EVERY BOUNDARY IS A LOCAL CALENDAR DAY. Dates are `'YYYY-MM-DD'` strings
 *    throughout and arithmetic goes through `@/theme/format`, which projects
 *    onto a DST-free UTC day index. `new Date('2026-09-01')` is UTC midnight
 *    and starts September on August 31st in Manila; a type-aware lint rule
 *    rejects it, and nothing here needs it.
 * 2. NEVER SQLite's `date('now')`. That is UTC too, and it rolls a Manila user
 *    into the next period at 08:00 the previous evening. `:today` is always
 *    passed in from `todayCalendarString()`.
 * 3. `endIso` IS INCLUSIVE. Every consumer must use `BETWEEN :start AND :end`.
 *    Mixing inclusive and half-open ranges in one codebase is how a day of
 *    spending goes missing at a month end.
 * 4. WEEKS START MONDAY, from one constant. A future "my week starts Sunday"
 *    setting is then a value change, not a search-and-replace.
 * 5. MONTH ENDS ARE DERIVED. 28 / 29 / 30 / 31 comes from the calendar, never
 *    from a table of assumptions, so February 2028 is 29 days without anyone
 *    remembering it is a leap year.
 */
import { addCalendarDays, daysBetween, parseCalendarDate, todayCalendarString } from '@/theme/format';

import type { schema } from '@/db';

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/** The cadence an allowance resets on, re-exported from the schema, type-only. */
export type AllowancePeriod = schema.AllowancePeriod;

/**
 * The cadences as a runtime list, for validating a value that arrives as a
 * plain string (a form, a future restore).
 *
 * Duplicated from `ALLOWANCE_PERIOD_VALUES` rather than imported, because
 * `@/db/schema/*` is off limits outside `src/db` (eslint `SCHEMA_IMPORT_MESSAGE`).
 * `satisfies` proves every member is a real period and {@link AllPeriodsListed}
 * proves none is missing — so the duplication cannot drift without a compile
 * error. Same trade as `RECEIPT_CATEGORIES`.
 */
export const ALLOWANCE_PERIODS = [
  'daily',
  'weekly',
  'monthly',
] as const satisfies readonly AllowancePeriod[];

type AllPeriodsListed =
  Exclude<AllowancePeriod, (typeof ALLOWANCE_PERIODS)[number]> extends never ? true : never;
/** Fails to compile if a period is added to the schema but not to the list. */
export const PERIOD_LIST_IS_COMPLETE: AllPeriodsListed = true;

/** True when `value` is one of the three cadences. */
export function isAllowancePeriod(value: unknown): value is AllowancePeriod {
  return typeof value === 'string' && (ALLOWANCE_PERIODS as readonly string[]).includes(value);
}

/**
 * Which weekday a weekly period starts on, `0` = Sunday … `6` = Saturday.
 *
 * Monday. It is the near-universal convention outside the US, it is what the
 * Philippines uses, and a "this week" that starts on Sunday puts a Saturday
 * night's spending in the period that is about to end rather than the one the
 * user is looking at.
 */
export const WEEK_STARTS_ON = 1;

/* -------------------------------------------------------------------------- */
/* Weekday, without touching local time                                        */
/* -------------------------------------------------------------------------- */

/** 1970-01-01 was a Thursday, and Thursday is 4 in a Sunday-first week. */
const EPOCH_ISO = '1970-01-01';
const EPOCH_WEEKDAY = 4;

/**
 * The weekday of a calendar date, `0` = Sunday … `6` = Saturday, computed from
 * the day index rather than from a `Date` — so it is the same answer in every
 * timezone and on both sides of a DST transition.
 *
 * `%` in JavaScript keeps the sign of the dividend, so a date before 1970 would
 * yield a negative remainder; the extra `+ 7` normalises it. Keeply has no
 * pre-1970 dates, but a formula that is only correct for its expected inputs is
 * a formula waiting for an unexpected one.
 */
function weekdayOf(iso: string): number | null {
  const index = daysBetween(EPOCH_ISO, iso);
  if (index === null) return null;
  return (((index + EPOCH_WEEKDAY) % 7) + 7) % 7;
}

/* -------------------------------------------------------------------------- */
/* Periods                                                                     */
/* -------------------------------------------------------------------------- */

export interface PeriodRange {
  readonly period: AllowancePeriod;
  /** First day of the period, `'YYYY-MM-DD'`, inclusive. */
  readonly startIso: string;
  /** Last day of the period, `'YYYY-MM-DD'`, **inclusive**. */
  readonly endIso: string;
  /** Days in the whole period: 1, 7, or 28-31. */
  readonly totalDays: number;
  /**
   * Which day of the period the reference date is, 1-based and inclusive — so
   * on the first day of a month `elapsedDays` is 1, never 0. A "spent per day
   * so far" figure divides by this, and dividing by zero on the 1st is exactly
   * the kind of thing that ships.
   */
  readonly elapsedDays: number;
  /** Days from the reference date to `endIso`, inclusive of the last day. */
  readonly remainingDays: number;
}

/**
 * The period of the given cadence that contains `iso`.
 *
 * Returns `null` when `iso` is not a real calendar date, matching every other
 * parser in the project: corrupt data renders a fallback, it does not crash
 * (§26).
 */
export function periodContaining(period: AllowancePeriod, iso: string): PeriodRange | null {
  const parts = parseCalendarDate(iso);
  if (parts === null) return null;

  const bounds = boundsFor(period, iso, parts.year, parts.month);
  if (bounds === null) return null;

  const [startIso, endIso] = bounds;
  const totalDays = spanDays(startIso, endIso);
  const elapsedDays = spanDays(startIso, iso);
  const remainingDays = spanDays(iso, endIso);
  if (totalDays === null || elapsedDays === null || remainingDays === null) return null;

  return { period, startIso, endIso, totalDays, elapsedDays, remainingDays };
}

/**
 * The period of the given cadence that contains today, in the device's local
 * calendar.
 *
 * `now` is injectable so tests can pin the clock to local 00:00 and 23:59 — the
 * two instants where a UTC-based implementation gives the wrong day.
 */
export function currentPeriod(period: AllowancePeriod, now: Date = new Date()): PeriodRange {
  const today = todayCalendarString(now);
  const range = periodContaining(period, today);
  // `todayCalendarString` builds the string from a real `Date`, so it is always
  // a valid calendar day and this branch is unreachable. It is here so the
  // return type has no `null` in it and no caller has to handle an impossible
  // case.
  if (range === null) {
    throw new Error(`unreachable: today (${period}) is not a calendar date`);
  }
  return range;
}

/** Inclusive day count between two calendar dates: same day is 1, not 0. */
function spanDays(fromIso: string, toIso: string): number | null {
  const between = daysBetween(fromIso, toIso);
  return between === null ? null : between + 1;
}

/** `[startIso, endIso]` for the period of `period` containing `iso`. */
function boundsFor(
  period: AllowancePeriod,
  iso: string,
  year: number,
  month: number,
): readonly [string, string] | null {
  switch (period) {
    case 'daily':
      return [iso, iso];

    case 'weekly': {
      const weekday = weekdayOf(iso);
      if (weekday === null) return null;
      // Days since the start of the week. `+ 7` keeps it non-negative for any
      // WEEK_STARTS_ON, so changing that constant cannot produce a week that
      // starts in the future.
      const sinceStart = (weekday - WEEK_STARTS_ON + 7) % 7;
      const startIso = addCalendarDays(iso, -sinceStart);
      if (startIso === null) return null;
      const endIso = addCalendarDays(startIso, 6);
      return endIso === null ? null : [startIso, endIso];
    }

    case 'monthly': {
      const startIso = `${pad4(year)}-${pad2(month)}-01`;
      // The last day of this month is the day before the first of the next —
      // derived, so 28 / 29 / 30 / 31 is never a decision anyone has to make.
      const nextMonthYear = month === 12 ? year + 1 : year;
      const nextMonth = month === 12 ? 1 : month + 1;
      const endIso = addCalendarDays(`${pad4(nextMonthYear)}-${pad2(nextMonth)}-01`, -1);
      return endIso === null ? null : [startIso, endIso];
    }
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function pad4(value: number): string {
  return String(value).padStart(4, '0');
}
