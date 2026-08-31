/**
 * Keeply — the data layer's clock.
 *
 * Two clocks, deliberately (see `schema/README.md`):
 *   `nowMs()`    -> unix epoch MILLISECONDS, for created_at/updated_at/deleted_at
 *   calendar     -> 'YYYY-MM-DD' TEXT in the DEVICE's local timezone, for due
 *                   dates, expiry dates and purchase dates
 *
 * ---------------------------------------------------------------------------
 * This file used to own a SECOND calendar-date implementation
 * ---------------------------------------------------------------------------
 * `toISODate` / `fromISODate` / `isISODate` lived here as well as in
 * `src/theme/format.ts`, both barrel-exported, and they disagreed (§B4):
 *
 *   fromISODate('bogus')        -> Date(NaN) -> toISODate -> "NaN-NaN-NaN",
 *                                  written straight at a CHECK-constrained column
 *   toLocalDate('bogus')        -> null
 *   fromISODate('0099-01-01')   -> year 1999 (Date's two-digit-year rule)
 *   toLocalDate('0099-01-01')   -> year 99
 *
 * Two implementations of the invariant this project calls its highest risk is
 * one too many, so the date functions were deleted and `@/db` now re-exports
 * `src/theme/format.ts`'s — under the same public names, so callers are
 * unaffected. `fromISODate` consequently returns `Date | null`: garbage in
 * yields `null` rather than a `Date` that silently formats as `NaN-NaN-NaN`.
 *
 * Only `nowMs()` remains here, because it is a timestamp, not a calendar date.
 */

/** Unix epoch milliseconds. Matches every `*_at` column's storage. */
export function nowMs(): number {
  return Date.now();
}
