/**
 * Pure formatting helpers shared by the whole app.
 *
 * Rules this module obeys:
 *  - Money is passed around as **integer minor units** (centavos). A value of
 *    `154900` with currency `PHP` renders as `₱1,549.00`. Formatted strings are
 *    produced here and nowhere else; they are never stored.
 *  - Calendar dates are `YYYY-MM-DD` strings and are parsed as *local calendar
 *    days*. `new Date('2026-10-12')` is UTC midnight and shifts the day for
 *    anyone west of Greenwich (and for PH, +08:00, it can shift the other way
 *    on some engines) — so we never use it.
 *  - Everything here is pure and side-effect free apart from a memo cache of
 *    `Intl.NumberFormat` instances, which is deterministic.
 */
import type { StatusKey } from './tokens';

/* ------------------------------------------------------------------ *
 * Calendar dates
 * ------------------------------------------------------------------ */

export interface CalendarDate {
  year: number;
  /** 1-12. */
  month: number;
  /** 1-31. */
  day: number;
}

const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const MS_PER_DAY = 86_400_000;

/**
 * Parse a `YYYY-MM-DD` string (a leading date inside a full ISO timestamp is
 * accepted too) into its calendar parts. Returns `null` for anything that is
 * not a real calendar date, so callers can render a fallback rather than crash
 * on corrupt data (goal.md §26).
 */
export function parseCalendarDate(iso: string | null | undefined): CalendarDate | null {
  if (typeof iso !== 'string') return null;
  const match = CALENDAR_DATE_RE.exec(iso.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject 2026-02-30 and friends by round-tripping through UTC.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/** True when `iso` is a well-formed, real `YYYY-MM-DD` calendar date. */
export function isValidCalendarDate(iso: string | null | undefined): boolean {
  return parseCalendarDate(iso) !== null;
}

/**
 * A `Date` pinned to **local** midnight of the given calendar day. Use this
 * only when you need a `Date` (e.g. a picker); day arithmetic should go through
 * `daysBetween` / `daysUntil`, which never touch local time at all.
 */
export function toLocalDate(iso: string): Date | null {
  const parts = parseCalendarDate(iso);
  if (parts === null) return null;
  return new Date(parts.year, parts.month - 1, parts.day);
}

/** Render a `Date` (interpreted in local time) as a `YYYY-MM-DD` string. */
export function toCalendarString(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Today, as a `YYYY-MM-DD` string in the device's local calendar. */
export function todayCalendarString(now: Date = new Date()): string {
  return toCalendarString(now);
}

/** Convert calendar parts to a DST-free day index. */
function toDayIndex(parts: CalendarDate): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day) / MS_PER_DAY;
}

/** The inverse of `toDayIndex`: a UTC day index back to calendar parts. */
function fromDayIndex(index: number): CalendarDate {
  const d = new Date(index * MS_PER_DAY);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Shift a calendar date by whole days: `'2026-02-28'` +1 -> `'2026-02-29'`.
 *
 * Arithmetic runs on the same DST-free UTC day index `daysBetween` uses, then
 * comes back out as calendar parts — local time is never involved, so a date
 * cannot slide across a DST boundary or a timezone. Returns `null` for input
 * that is not a real calendar date, matching every other parser here.
 *
 * This is deliberately *only* day arithmetic. Month and cycle arithmetic
 * (Jan 31 + 1 month) is a recurrence question with its own rounding rules and
 * lives in the recurrence engine, not here.
 */
export function addCalendarDays(iso: string, days: number): string | null {
  const parts = parseCalendarDate(iso);
  if (parts === null || !Number.isInteger(days)) return null;
  const shifted = fromDayIndex(toDayIndex(parts) + days);
  return `${String(shifted.year).padStart(4, '0')}-${String(shifted.month).padStart(2, '0')}-${String(shifted.day).padStart(2, '0')}`;
}

/**
 * Whole calendar days from `fromIso` to `toIso`. Positive means `toIso` is in
 * the future. DST-safe: both sides are projected onto a UTC day index, so an
 * hour never leaks into the difference.
 */
export function daysBetween(fromIso: string, toIso: string): number | null {
  const from = parseCalendarDate(fromIso);
  const to = parseCalendarDate(toIso);
  if (from === null || to === null) return null;
  return toDayIndex(to) - toDayIndex(from);
}

/**
 * Whole calendar days from today until `iso`. Negative when `iso` is in the
 * past. `now` is injectable so tests are deterministic.
 */
export function daysUntil(iso: string, now: Date = new Date()): number | null {
  return daysBetween(toCalendarString(now), iso);
}

/* ------------------------------------------------------------------ *
 * Money
 * ------------------------------------------------------------------ */

/** Minor-unit exponent per currency. PHP, like most, is 2. */
const MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  IDR: 2,
  PHP: 2,
  USD: 2,
};

export const DEFAULT_CURRENCY = 'PHP';
export const DEFAULT_LOCALE = 'en-PH';

export function minorUnitExponent(currency: string): number {
  return MINOR_UNIT_EXPONENT[currency.toUpperCase()] ?? 2;
}

/** Integer centavos -> major units. `154900` -> `1549`. */
export function minorToMajor(minor: number, currency: string = DEFAULT_CURRENCY): number {
  return minor / 10 ** minorUnitExponent(currency);
}

/** Major units -> integer centavos, rounded. `1549.005` -> `154901`. */
export function majorToMinor(major: number, currency: string = DEFAULT_CURRENCY): number {
  return Math.round(major * 10 ** minorUnitExponent(currency));
}

const numberFormatCache = new Map<string, Intl.NumberFormat>();

function getCurrencyFormatter(currency: string, showDecimals: boolean): Intl.NumberFormat {
  const digits = showDecimals ? minorUnitExponent(currency) : 0;
  const key = `${currency}:${digits}`;
  const cached = numberFormatCache.get(key);
  if (cached !== undefined) return cached;
  const formatter = new Intl.NumberFormat(DEFAULT_LOCALE, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  numberFormatCache.set(key, formatter);
  return formatter;
}

const currencySymbolCache = new Map<string, string>();

/**
 * The symbol a currency is written with: `'PHP'` -> `'₱'`.
 *
 * For an input affix, where the symbol sits *outside* the editable text and the
 * user types only digits. Derived from the same `Intl` data `formatMoney` uses,
 * so the affix and the formatted result can never disagree; degrades to the
 * ISO code on a runtime whose ICU lacks the currency.
 */
export function currencySymbol(currency: string = DEFAULT_CURRENCY): string {
  const code = currency.toUpperCase();
  const cached = currencySymbolCache.get(code);
  if (cached !== undefined) return cached;

  let symbol = code;
  try {
    // Format a zero and strip everything that is not the symbol.
    //
    // NOT `formatToParts`: Hermes returns the ISO code rather than the glyph
    // for its `currency` part on some locales — `formatMoney` renders `₱1,499`
    // through `format()` while `formatToParts()` reports `PHP`, so reading the
    // part gave an input affix that disagreed with every amount on screen.
    // `format()` is the one path both go through, so the affix cannot drift
    // from the output again.
    const rendered = new Intl.NumberFormat(DEFAULT_LOCALE, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(0);
    const stripped = rendered.replace(/[\d\s\u00a0\u202f.,-]/g, '');
    if (stripped.length > 0) symbol = stripped;
  } catch {
    // Unknown currency on this runtime — the ISO code is a truthful fallback.
  }
  currencySymbolCache.set(code, symbol);
  return symbol;
}

export interface FormatMoneyOptions {
  /** Drop the centavos when they are `.00`. Default `false`. */
  hideZeroDecimals?: boolean;
  /** Always show a leading `+` for positive values. Default `false`. */
  signDisplay?: 'auto' | 'always' | 'never';
}

/**
 * Format integer minor units as currency.
 *
 * ```ts
 * formatMoney(154900, 'PHP') // '₱1,549.00'
 * formatMoney(-54900, 'PHP') // '-₱549.00'
 * ```
 */
export function formatMoney(
  minor: number,
  currency: string = DEFAULT_CURRENCY,
  options: FormatMoneyOptions = {},
): string {
  const safeMinor = Number.isFinite(minor) ? minor : 0;
  const exponent = minorUnitExponent(currency);
  const showDecimals =
    options.hideZeroDecimals !== true || safeMinor % 10 ** exponent !== 0 || exponent === 0;
  const value = minorToMajor(safeMinor, currency);
  const magnitude = options.signDisplay === 'never' ? Math.abs(value) : value;

  let out: string;
  try {
    out = getCurrencyFormatter(currency, showDecimals).format(magnitude);
  } catch {
    // Hermes without the requested currency in ICU — degrade, never throw.
    const digits = showDecimals ? exponent : 0;
    out = `${currency} ${magnitude.toFixed(digits)}`;
  }
  if (options.signDisplay === 'always' && magnitude > 0) {
    out = `+${out}`;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Dates as text
 * ------------------------------------------------------------------ */

/** `'2026-10-12'` -> `'October 12, 2026'`. Never shifts the day. */
export function formatDate(iso: string): string {
  const parts = parseCalendarDate(iso);
  if (parts === null) return '—';
  return `${MONTHS_LONG[parts.month - 1]} ${parts.day}, ${parts.year}`;
}

/** `'2026-10-12'` -> `'Oct 12, 2026'`. */
export function formatDateShort(iso: string): string {
  const parts = parseCalendarDate(iso);
  if (parts === null) return '—';
  return `${MONTHS_SHORT[parts.month - 1]} ${parts.day}, ${parts.year}`;
}

/** `'2026-10-12'` -> `'Oct 12'`. For dense list rows in the current year. */
export function formatDateCompact(iso: string): string {
  const parts = parseCalendarDate(iso);
  if (parts === null) return '—';
  return `${MONTHS_SHORT[parts.month - 1]} ${parts.day}`;
}

/** `'2026-10-12'` -> `'October 2026'`. */
export function formatMonthYear(iso: string): string {
  const parts = parseCalendarDate(iso);
  if (parts === null) return '—';
  return `${MONTHS_LONG[parts.month - 1]} ${parts.year}`;
}

function pluralDays(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}

/**
 * Countdown copy for a payment due date.
 *
 * ```
 * 'Overdue by 2 days' | 'Due today' | 'Due tomorrow' | 'Due in 3 days'
 * ```
 */
export function formatRelativeDue(iso: string, now: Date = new Date()): string {
  const days = daysUntil(iso, now);
  if (days === null) return '—';
  if (days < 0) return `Overdue by ${pluralDays(-days)}`;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `Due in ${pluralDays(days)}`;
}

/**
 * Countdown copy for a document expiry date.
 *
 * ```
 * 'Expired' | 'Expires today' | 'Expires tomorrow' | 'Expires in 42 days'
 * ```
 */
export function formatExpiry(iso: string, now: Date = new Date()): string {
  const days = daysUntil(iso, now);
  if (days === null) return '—';
  if (days < 0) return 'Expired';
  if (days === 0) return 'Expires today';
  if (days === 1) return 'Expires tomorrow';
  return `Expires in ${pluralDays(days)}`;
}

/** `'Expired 12 days ago'` — for the detail screen, where the age matters. */
export function formatExpiryDetailed(iso: string, now: Date = new Date()): string {
  const days = daysUntil(iso, now);
  if (days === null) return '—';
  if (days < 0) return `Expired ${pluralDays(-days)} ago`;
  return formatExpiry(iso, now);
}

/* ------------------------------------------------------------------ *
 * Date -> status token
 * ------------------------------------------------------------------ */

/** How many days ahead still counts as "due soon". */
export const DUE_SOON_DAYS = 7;
/** How many days ahead still counts as "expiring soon" (goal.md §15). */
export const EXPIRING_SOON_DAYS = 30;

/**
 * Map a due date onto a status token key. Feature code calls this instead of
 * branching on colours.
 */
export function statusForDue(
  iso: string,
  options: { paid?: boolean; active?: boolean; now?: Date } = {},
): StatusKey {
  if (options.active === false) return 'inactive';
  if (options.paid === true) return 'paid';
  const days = daysUntil(iso, options.now ?? new Date());
  if (days === null) return 'upcoming';
  if (days < 0) return 'overdue';
  if (days === 0) return 'dueToday';
  if (days <= DUE_SOON_DAYS) return 'dueSoon';
  return 'upcoming';
}

/** Map an expiry date onto a status token key. */
export function statusForExpiry(
  iso: string,
  options: { now?: Date; soonDays?: number } = {},
): StatusKey {
  const days = daysUntil(iso, options.now ?? new Date());
  if (days === null) return 'valid';
  if (days < 0) return 'expired';
  if (days <= (options.soonDays ?? EXPIRING_SOON_DAYS)) return 'expiringSoon';
  return 'valid';
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

/**
 * Mask a sensitive identifier, keeping the last 4 characters
 * (goal.md §14): `'A01-23-456789'` -> `'**** **** 6789'`.
 */
export function maskIdentifier(value: string | null | undefined, visible = 4): string {
  if (typeof value !== 'string') return '';
  const compact = value.replace(/\s+/g, '');
  if (compact.length <= visible) return compact;
  return `**** **** ${compact.slice(-visible)}`;
}
