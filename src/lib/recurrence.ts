/**
 * Keeply — the recurrence engine (§6, §7).
 *
 * Pure calendar arithmetic and pure money arithmetic. No database, no React,
 * no `Date` parsing of a string, and — deliberately — no I/O of any kind, so
 * `node --test` can run every boundary this module has.
 *
 * ---------------------------------------------------------------------------
 * THE MONTH-END RULE: ANCHORED, AND THE ANCHOR IS AN ARGUMENT
 * ---------------------------------------------------------------------------
 * "Monthly from January 31st" has no answer in February, and the two ways of
 * papering over that are not equally wrong:
 *
 *   drifting   Jan 31 -> Feb 28 -> Mar 28 -> Apr 28 -> ... forever the 28th.
 *              One short month permanently demotes the subscription, silently,
 *              and nothing the user does brings it back.
 *   anchored   Jan 31 -> Feb 28 -> Mar 31 -> Apr 30 -> May 31 -> ...
 *              February is clamped; March returns to the 31st.
 *
 * Anchored is what a person means by "the 31st of every month", so anchored is
 * what this module implements. The interesting part is HOW, because the naive
 * implementation of "anchored" is not implementable at all: once Feb 28 has
 * been written down, "the 28th" and "clamped from the 31st" are the same three
 * characters, and no rule applied to `2026-02-28` alone can tell them apart.
 * A "last day of the month is sticky" heuristic recovers the 31st — and breaks
 * every genuine 30th-of-the-month subscription, promoting it to the 31st the
 * first time April rolls past.
 *
 * So the anchor is never inferred. It is an argument:
 *
 *   **Every occurrence is computed as `anchor + k cycles`, from the ORIGINAL
 *   anchor, with the clamp applied to the anchor's day-of-month. A computed
 *   date is never fed back in as the next anchor.**
 *
 * `addMonthsClamped(anchor, k)` is the primitive, `advanceToFuture()` solves
 * for `k` in one shot rather than stepping, and `nextOccurrence()` is the k=1
 * case. This is what "impossible to get wrong by accident" buys: an anchored
 * series is not a property of a heuristic that might misfire, it is a property
 * of never having thrown the anchor away.
 *
 * The data layer holds up its half: `subscriptions.next_billing_date` IS the
 * anchor, it is written only by the user, and nothing in
 * `src/features/subscriptions` ever persists a derived occurrence over it.
 * Phase 2 has no "roll the subscription forward" mutation for exactly this
 * reason — the projected next renewal is derived at read time and thrown away.
 *
 * ---------------------------------------------------------------------------
 * Dates
 * ---------------------------------------------------------------------------
 * Calendar dates are `YYYY-MM-DD` strings and stay strings. `parseCalendarDate`
 * from `@/theme/format` is the ONE parser in this codebase (imported as
 * `@/theme/format` rather than the `@/theme` barrel, which pulls in React
 * Native and would make this module untestable in plain Node — it is the same
 * implementation, re-exported).
 *
 * Month arithmetic here touches `Date` not at all: month lengths come from a
 * table and a leap-year predicate. Day arithmetic goes through a UTC day index,
 * which is immune to DST — `t + 30 * 86_400_000` in local time is 720 hours,
 * not 30 days, and lands on the wrong calendar day either side of a transition.
 *
 * ---------------------------------------------------------------------------
 * Normalization (§6): "₱12,000/year" also reads as "₱1,000/month"
 * ---------------------------------------------------------------------------
 * Two families of cycle, normalized on their own terms:
 *
 *   calendar-anchored  monthly / quarterly / yearly bill an exact 12 / 4 / 1
 *                      times a calendar year, whatever the month lengths.
 *   day-anchored       weekly and custom bill every N days, so they bill
 *                      365/N times a 365-day year.
 *
 * That makes `weekly` and `custom` with `custom_cycle_days = 7` identical
 * rather than subtly different (52 vs 52.14 charges a year), which matters
 * because the user can express the same subscription either way.
 *
 *   monthly equivalent = amount x num / den    weekly 365/84   monthly 1/1
 *                                              quarterly 1/3   yearly 1/12
 *                                              custom(d) 365/(12d)
 *   yearly  equivalent = amount x num / den    weekly 365/7    monthly 12/1
 *                                              quarterly 4/1   yearly 1/1
 *                                              custom(d) 365/d
 *
 * ROUNDING: integer minor units throughout, half away from zero, applied ONCE
 * per subscription — never to a running total. A list and its total therefore
 * agree exactly, because `subscriptionTotals()` sums the same per-row rounded
 * value the row itself displays (the SQL in `src/features/subscriptions/sql.ts`
 * evaluates the identical integer expression; `tests/subscriptions-totals.test.ts`
 * pins the two against each other across a matrix).
 *
 * The yearly equivalent is computed from the amount, NOT as 12x the monthly
 * equivalent: rounding once from the source is more accurate than rounding
 * twice, so `yearly !== 12 * monthly` by up to a few centavos for day-anchored
 * cycles. That is a deliberate, stated consequence, not a bug.
 *
 * A 365-day year ignores leap days: 0.07%, four orders of magnitude below the
 * centavo the result is rounded to, in exchange for every factor being an exact
 * integer ratio that SQLite can evaluate with integer arithmetic.
 */
import { minorUnits, type MinorUnits } from '@/db/money';
import { parseCalendarDate, todayCalendarString } from '@/theme/format';

import type { schema } from '@/db';

/**
 * `weekly | monthly | quarterly | yearly | custom`, re-exported from the schema
 * enum so this module and the database can never disagree about the set.
 *
 * Type-only, so nothing at runtime reaches `@/db` (which loads op-sqlite).
 */
export type BillingCycle = schema.BillingCycle;

const MS_PER_DAY = 86_400_000;

/** Days in each month of a non-leap year, January first. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * Days in the year used to normalize a day-anchored cycle. See the header:
 * exact integer ratios beat 365.2425 at a centavo's resolution.
 */
export const DAYS_PER_NORMALIZED_YEAR = 365;

/**
 * `advanceToFuture()` solves for the cycle count directly and then verifies it.
 * The verification loop can only ever run once or twice; if it somehow does not
 * converge, that is a bug in the arithmetic above it and the right response is
 * a loud throw, not another iteration. The one thing it must never do is spin.
 */
const MAX_CONVERGENCE_STEPS = 8;

/** Smallest and largest year `YYYY-MM-DD` can represent. */
const MIN_YEAR = 1;
const MAX_YEAR = 9999;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type RecurrenceErrorCode =
  /** The billing cycle is not one of the five the schema allows. */
  | 'invalid-cycle'
  /** `custom_cycle_days` is missing, zero, negative or not a whole number. */
  | 'invalid-custom-days'
  /** A `YYYY-MM-DD` argument was not a real calendar date. */
  | 'invalid-date'
  /** The result fell outside year 0001-9999, or the money overflowed. */
  | 'out-of-range'
  /** The convergence guard tripped. Unreachable; reported rather than looped. */
  | 'non-terminating';

/**
 * A bad argument to a pure function — a programmer error, or corrupt data that
 * reached this module without passing `src/features/subscriptions/validation.ts`.
 * Thrown rather than returned: the feature layer validates first and returns
 * typed results, so nothing that gets here is a recoverable user mistake.
 *
 * Messages name the FIELD, never the value: a due date and an amount are both
 * user data (§18).
 */
export class RecurrenceError extends Error {
  readonly code: RecurrenceErrorCode;

  constructor(code: RecurrenceErrorCode, message: string) {
    super(message);
    this.name = 'RecurrenceError';
    this.code = code;
    Object.setPrototypeOf(this, RecurrenceError.prototype);
  }
}

/* -------------------------------------------------------------------------- */
/* Calendar primitives                                                         */
/* -------------------------------------------------------------------------- */

/** Proleptic Gregorian leap year. */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Length of `month` (1-12) in `year`. */
export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RecurrenceError('out-of-range', 'Month must be 1-12');
  }
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1];
}

interface CalendarParts {
  year: number;
  month: number;
  day: number;
}

function requireCalendarDate(iso: string, field: string): CalendarParts {
  const parts = parseCalendarDate(iso);
  if (parts === null) {
    throw new RecurrenceError('invalid-date', `${field} is not a YYYY-MM-DD calendar date`);
  }
  return parts;
}

/** Render calendar parts, refusing anything a `YYYY-MM-DD` column cannot hold. */
function formatCalendar(year: number, month: number, day: number): string {
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw new RecurrenceError(
      'out-of-range',
      `Recurrence stepped outside year ${MIN_YEAR}-${MAX_YEAR}`,
    );
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(
    day,
  ).padStart(2, '0')}`;
}

/**
 * A DST-free day number. Both `parseCalendarDate` and this reject years below
 * 100, so `Date.UTC`'s two-digit-year remapping (year 99 -> 1999) is out of
 * reach.
 */
function toDayIndex(parts: CalendarParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day) / MS_PER_DAY;
}

/**
 * Whole calendar days between two `YYYY-MM-DD` dates, positive when `toISO` is
 * later. DST cannot leak in: both sides become a UTC day index first.
 */
export function daysBetweenDates(fromISO: string, toISO: string): number {
  return (
    toDayIndex(requireCalendarDate(toISO, 'to')) -
    toDayIndex(requireCalendarDate(fromISO, 'from'))
  );
}

/**
 * `iso` plus `days` calendar days. `days` may be negative.
 *
 * Counted on the UTC day index, so this is 30 *days* and not 720 *hours*: the
 * millisecond form lands on the previous calendar day across a fall-back
 * transition, which is how a "30 days before" reminder fires on the 29th.
 */
export function addCalendarDays(iso: string, days: number): string {
  const parts = requireCalendarDate(iso, 'date');
  if (!Number.isSafeInteger(days)) {
    throw new RecurrenceError('out-of-range', 'Day offset must be a whole number');
  }
  const shifted = new Date((toDayIndex(parts) + days) * MS_PER_DAY);
  return formatCalendar(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

/**
 * `iso` plus `months` months, keeping the day of month and clamping to the last
 * day when the target month is shorter. Jan 31 + 1 = Feb 28 (Feb 29 in a leap
 * year), never Mar 3 — JavaScript's `new Date(2026, 1, 31)` rolls over, which
 * is how a monthly bill skips February and never comes back.
 *
 * THIS IS THE ANCHORED PRIMITIVE: call it with the original anchor and a step
 * COUNT. Calling it repeatedly with its own output is the drift the module
 * header exists to prevent — `2026-01-31` + 1 + 1 is March 28th, while
 * `2026-01-31` + 2 is March 31st, and the second one is what the user meant.
 */
export function addMonthsClamped(iso: string, months: number): string {
  const parts = requireCalendarDate(iso, 'date');
  if (!Number.isSafeInteger(months)) {
    throw new RecurrenceError('out-of-range', 'Month offset must be a whole number');
  }
  const absoluteMonth = parts.year * 12 + (parts.month - 1) + months;
  const targetYear = Math.floor(absoluteMonth / 12);
  const targetMonth = absoluteMonth - targetYear * 12 + 1;
  if (targetYear < MIN_YEAR || targetYear > MAX_YEAR) {
    throw new RecurrenceError(
      'out-of-range',
      `Recurrence stepped outside year ${MIN_YEAR}-${MAX_YEAR}`,
    );
  }
  const day = Math.min(parts.day, daysInMonth(targetYear, targetMonth));
  return formatCalendar(targetYear, targetMonth, day);
}

/* -------------------------------------------------------------------------- */
/* Cycles                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How one cycle steps. Day-anchored cycles move a fixed number of days;
 * calendar-anchored cycles move whole months and clamp.
 */
export type CycleStep =
  | { readonly unit: 'day'; readonly days: number }
  | { readonly unit: 'month'; readonly months: number };

/**
 * `custom_cycle_days` is only consulted for the `custom` cycle. A row that
 * still carries one after being switched to `monthly` is ignored rather than
 * rejected — stale is not corrupt, and a read must not throw over it.
 */
function requireCustomDays(customDays: number | null | undefined): number {
  if (customDays === null || customDays === undefined) {
    throw new RecurrenceError(
      'invalid-custom-days',
      'A custom billing cycle needs customCycleDays',
    );
  }
  if (!Number.isSafeInteger(customDays) || customDays <= 0) {
    throw new RecurrenceError(
      'invalid-custom-days',
      'customCycleDays must be a whole number of days greater than zero',
    );
  }
  return customDays;
}

/**
 * The step for one billing cycle.
 *
 * The `default` arm is an exhaustiveness check: adding a value to
 * `BILLING_CYCLE_VALUES` makes this fail to compile rather than silently
 * inheriting monthly's behaviour, and at runtime a cycle the schema's CHECK
 * constraint should have rejected throws instead of looping.
 */
export function cycleStep(cycle: BillingCycle, customDays?: number | null): CycleStep {
  switch (cycle) {
    case 'weekly':
      return { unit: 'day', days: 7 };
    case 'monthly':
      return { unit: 'month', months: 1 };
    case 'quarterly':
      return { unit: 'month', months: 3 };
    case 'yearly':
      return { unit: 'month', months: 12 };
    case 'custom':
      return { unit: 'day', days: requireCustomDays(customDays) };
    default: {
      const unhandled: never = cycle;
      throw new RecurrenceError(
        'invalid-cycle',
        `Unknown billing cycle: ${JSON.stringify(unhandled)}`,
      );
    }
  }
}

/**
 * The five cycles as a runtime list, for building SQL and validating strings.
 *
 * `satisfies` proves every member is a real cycle and `AllCyclesListed` proves
 * none is missing, so adding one to `BILLING_CYCLE_VALUES` breaks the build
 * here rather than silently skipping a CASE arm in
 * `src/features/subscriptions/sql.ts`. The literal is repeated rather than
 * imported because `@/db/schema/*` is off limits outside `src/db`.
 */
export const BILLING_CYCLES = [
  'weekly',
  'monthly',
  'quarterly',
  'yearly',
  'custom',
] as const satisfies readonly BillingCycle[];

type AllCyclesListed =
  Exclude<BillingCycle, (typeof BILLING_CYCLES)[number]> extends never ? true : never;
/** Fails to compile if a billing cycle is added to the schema but not here. */
export const CYCLE_LIST_IS_COMPLETE: AllCyclesListed = true;

/** Whether `value` is one of the five cycles the schema allows. */
export function isBillingCycle(value: unknown): value is BillingCycle {
  return (
    value === 'weekly' ||
    value === 'monthly' ||
    value === 'quarterly' ||
    value === 'yearly' ||
    value === 'custom'
  );
}

/* -------------------------------------------------------------------------- */
/* The public stepping API                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The occurrence exactly one cycle after `fromISO`.
 *
 * `fromISO` is the ANCHOR. Chaining this call on its own output drifts for
 * month-anchored cycles (see the header) — use `occurrenceAfter(anchor, k)` or
 * `advanceToFuture()` when you need occurrence number k.
 *
 * @throws {RecurrenceError} `invalid-date`, `invalid-cycle`,
 *         `invalid-custom-days`, `out-of-range`.
 */
export function nextOccurrence(
  fromISO: string,
  cycle: BillingCycle,
  customDays?: number | null,
): string {
  return occurrenceAfter(fromISO, cycle, 1, customDays);
}

/**
 * Occurrence number `count` after the anchor, computed in ONE step from the
 * anchor. `count` may be 0 (the anchor itself, normalized).
 *
 * @throws {RecurrenceError} as `nextOccurrence`.
 */
export function occurrenceAfter(
  anchorISO: string,
  cycle: BillingCycle,
  count: number,
  customDays?: number | null,
): string {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RecurrenceError('out-of-range', 'Occurrence count must be a whole number >= 0');
  }
  const step = cycleStep(cycle, customDays);
  return step.unit === 'day'
    ? addCalendarDays(anchorISO, step.days * count)
    : addMonthsClamped(anchorISO, step.months * count);
}

/**
 * The first occurrence on or after `todayISO`, computed from the anchor.
 *
 * Returns the anchor unchanged when it is already today or later, so a
 * subscription that has not renewed yet keeps the exact date the user typed.
 *
 * TERMINATION. The cycle count is solved for arithmetically — `ceil(gap/days)`
 * for a day-anchored cycle, a month difference for a calendar-anchored one —
 * and then verified. There is no "step until we pass today" loop to hang: a
 * `customCycleDays` of 0 throws at `cycleStep()` before any arithmetic runs, an
 * unknown cycle throws there too, and the verification pass is bounded by
 * `MAX_CONVERGENCE_STEPS` and throws `non-terminating` rather than spinning.
 *
 * @throws {RecurrenceError} as `nextOccurrence`, plus `non-terminating`.
 */
export function advanceToFuture(
  fromISO: string,
  cycle: BillingCycle,
  customDays?: number | null,
  todayISO?: string,
): string {
  const anchor = requireCalendarDate(fromISO, 'from');
  const todayString = todayISO ?? todayCalendarString();
  const today = requireCalendarDate(todayString, 'today');

  // Resolve the step FIRST: a malformed cycle must fail before anything else,
  // whether or not the anchor happens to already be in the future.
  const step = cycleStep(cycle, customDays);

  const anchorIndex = toDayIndex(anchor);
  const todayIndex = toDayIndex(today);
  if (anchorIndex >= todayIndex) {
    return formatCalendar(anchor.year, anchor.month, anchor.day);
  }

  if (step.unit === 'day') {
    const gap = todayIndex - anchorIndex;
    const count = Math.ceil(gap / step.days);
    return addCalendarDays(fromISO, step.days * count);
  }

  // Lower bound: whole cycles between the two months. It can never overshoot —
  // occurrence `count - 1` sits at least `step.months` months before today's
  // month, so it is strictly earlier — which makes the first candidate at or
  // after today the smallest one.
  const monthGap = (today.year - anchor.year) * 12 + (today.month - anchor.month);
  let count = Math.max(0, Math.floor(monthGap / step.months));

  for (let attempt = 0; attempt <= MAX_CONVERGENCE_STEPS; attempt += 1) {
    const candidate = addMonthsClamped(fromISO, step.months * count);
    if (toDayIndex(requireCalendarDate(candidate, 'candidate')) >= todayIndex) {
      return candidate;
    }
    count += 1;
  }

  throw new RecurrenceError(
    'non-terminating',
    'Could not advance the recurrence to the present; refusing to loop',
  );
}

/**
 * Every occurrence from the anchor up to and including `throughISO`, capped.
 *
 * Used by the reminder scheduler and by nothing that renders a list, so the cap
 * is a hard stop rather than a page: a request that would exceed it is a bug in
 * the caller's window, and truncating quietly would under-schedule reminders.
 *
 * @throws {RecurrenceError} `out-of-range` if the window needs more than `limit`
 *         occurrences.
 */
export function occurrencesThrough(
  anchorISO: string,
  cycle: BillingCycle,
  throughISO: string,
  customDays?: number | null,
  limit = 366,
): string[] {
  const through = toDayIndex(requireCalendarDate(throughISO, 'through'));
  const out: string[] = [];
  for (let count = 0; count <= limit; count += 1) {
    const candidate = occurrenceAfter(anchorISO, cycle, count, customDays);
    if (toDayIndex(requireCalendarDate(candidate, 'candidate')) > through) return out;
    if (out.length === limit) {
      throw new RecurrenceError(
        'out-of-range',
        `More than ${limit} occurrences fall in that window`,
      );
    }
    out.push(candidate);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Normalization (§6)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * An exact integer ratio: `amount x num / den`, rounded once. Kept as a ratio
 * rather than a float so SQLite can evaluate the identical expression with
 * integer arithmetic — see `src/features/subscriptions/sql.ts`.
 */
export interface EquivalenceRatio {
  readonly num: number;
  /**
   * For `custom`, this is the denominator PER DAY of the custom cycle: the real
   * denominator is `den * custom_cycle_days`. That is what lets the SQL CASE
   * arm multiply by the column instead of hard-coding a number.
   */
  readonly den: number;
}

/** Monthly-equivalent ratio. For `custom`, `den` is per custom day. */
export function monthlyEquivalentRatio(cycle: BillingCycle): EquivalenceRatio {
  switch (cycle) {
    case 'weekly':
      // 365/7 charges a year, spread over 12 months.
      return { num: DAYS_PER_NORMALIZED_YEAR, den: 7 * 12 };
    case 'monthly':
      return { num: 1, den: 1 };
    case 'quarterly':
      return { num: 1, den: 3 };
    case 'yearly':
      return { num: 1, den: 12 };
    case 'custom':
      // den x custom_cycle_days.
      return { num: DAYS_PER_NORMALIZED_YEAR, den: 12 };
    default: {
      const unhandled: never = cycle;
      throw new RecurrenceError(
        'invalid-cycle',
        `Unknown billing cycle: ${JSON.stringify(unhandled)}`,
      );
    }
  }
}

/** Yearly-equivalent ratio. For `custom`, `den` is per custom day. */
export function yearlyEquivalentRatio(cycle: BillingCycle): EquivalenceRatio {
  switch (cycle) {
    case 'weekly':
      return { num: DAYS_PER_NORMALIZED_YEAR, den: 7 };
    case 'monthly':
      return { num: 12, den: 1 };
    case 'quarterly':
      return { num: 4, den: 1 };
    case 'yearly':
      return { num: 1, den: 1 };
    case 'custom':
      // den x custom_cycle_days.
      return { num: DAYS_PER_NORMALIZED_YEAR, den: 1 };
    default: {
      const unhandled: never = cycle;
      throw new RecurrenceError(
        'invalid-cycle',
        `Unknown billing cycle: ${JSON.stringify(unhandled)}`,
      );
    }
  }
}

/**
 * `numerator / denominator`, rounded half AWAY FROM ZERO, in integers.
 *
 * `(2n + d) / 2d` under truncating division is the same expression SQLite
 * evaluates, which is the point: one rounding rule, two engines, no drift
 * between a row and the total it belongs to. Stored amounts are always
 * positive (`subscriptions_amount_minor_check`), so the negative branch exists
 * only for callers doing arithmetic on deltas.
 */
export function divideRoundHalfAwayFromZero(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new RecurrenceError('out-of-range', 'Rounding operands must be whole numbers');
  }
  if (denominator <= 0) {
    throw new RecurrenceError('out-of-range', 'Denominator must be greater than zero');
  }
  const magnitude = Math.abs(numerator);
  const doubled = 2 * magnitude + denominator;
  if (!Number.isSafeInteger(doubled)) {
    throw new RecurrenceError('out-of-range', 'Amount is too large to normalize exactly');
  }
  const rounded = Math.floor(doubled / (2 * denominator));
  return numerator < 0 ? -rounded : rounded;
}

function applyRatio(
  amountMinor: MinorUnits,
  ratio: EquivalenceRatio,
  cycle: BillingCycle,
  customDays?: number | null,
): MinorUnits {
  const amount = minorUnits(amountMinor);
  const denominator =
    cycle === 'custom' ? ratio.den * requireCustomDays(customDays) : ratio.den;
  const numerator = amount * ratio.num;
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new RecurrenceError('out-of-range', 'Amount is too large to normalize exactly');
  }
  return minorUnits(divideRoundHalfAwayFromZero(numerator, denominator));
}

/**
 * What this subscription costs per month, in integer minor units (§6).
 *
 * `₱12,000/year` -> `₱1,000/month`. Rounded half away from zero, once.
 *
 * @throws {RecurrenceError} `invalid-cycle`, `invalid-custom-days`,
 *         `out-of-range` (an amount so large the exact product would lose
 *         precision — refused rather than silently rounded by the float unit).
 * @throws {RangeError} from `minorUnits()` if the amount is not a safe integer.
 */
export function monthlyEquivalentMinor(
  amountMinor: MinorUnits,
  cycle: BillingCycle,
  customDays?: number | null,
): MinorUnits {
  return applyRatio(amountMinor, monthlyEquivalentRatio(cycle), cycle, customDays);
}

/**
 * What this subscription costs per year, in integer minor units (§6).
 *
 * Computed from the amount, not as 12x the monthly equivalent — see the header.
 *
 * @throws as `monthlyEquivalentMinor`.
 */
export function yearlyEquivalentMinor(
  amountMinor: MinorUnits,
  cycle: BillingCycle,
  customDays?: number | null,
): MinorUnits {
  return applyRatio(amountMinor, yearlyEquivalentRatio(cycle), cycle, customDays);
}
