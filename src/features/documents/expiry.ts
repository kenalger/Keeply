/**
 * Keeply — §15's expiry ladder, as one pure function.
 *
 * ```text
 * Expired · Expires today · in 7 days · in 30 · in 60 · in 90
 * ```
 *
 * ── WHY A BUCKET AND NOT SIX QUERIES ───────────────────────────────────────
 * §15's value is the LADDER, not any one rung: "two expired, one this week,
 * four this quarter" is the answer a person opens the tab for. Six filtered
 * queries would make them ask the question six times, and six `WHERE` clauses
 * would be six places for the boundary arithmetic to disagree.
 *
 * ── WHY IT IS PURE, AND WHY `now` IS INJECTED ──────────────────────────────
 * This is date arithmetic on a LOCAL calendar date, which is the single
 * richest source of off-by-one in this app. `new Date('2026-10-12')` is UTC
 * midnight and lands on 11 October in Manila — on a countdown that is a day the
 * user can see. So the maths goes through `daysUntil()` (which parses locally),
 * the clock is a parameter, and `node --test` sweeps it across ten timezones.
 *
 * No React, no `@/db`, no Expo.
 */
import { daysUntil } from '@/theme/format';

/**
 * Where a document sits on §15's ladder.
 *
 * `'none'` is a real, common state and not an error: a birth certificate does
 * not expire. It is listed LAST and never reminds — see the plan's §2.
 */
export type ExpiryBucket =
  | 'expired'
  | 'today'
  | 'within7'
  | 'within30'
  | 'within60'
  | 'within90'
  | 'later'
  | 'none';

/**
 * The ladder in display order.
 *
 * Exported so a screen can iterate it rather than writing the order out again —
 * a list whose sections disagree with the bucket function is a list where
 * "Expired" can appear below "Later".
 */
export const EXPIRY_BUCKETS: readonly ExpiryBucket[] = [
  'expired',
  'today',
  'within7',
  'within30',
  'within60',
  'within90',
  'later',
  'none',
];

/** The rungs, as day counts. `within7` means "1 to 7 days from now". */
const LADDER: readonly { readonly bucket: ExpiryBucket; readonly maxDays: number }[] = [
  { bucket: 'within7', maxDays: 7 },
  { bucket: 'within30', maxDays: 30 },
  { bucket: 'within60', maxDays: 60 },
  { bucket: 'within90', maxDays: 90 },
];

/**
 * Which rung a document is on.
 *
 * @param expiryDate `'YYYY-MM-DD'`, or `null` for a document that never expires.
 * @param now The clock. Injected — never read here — so a test can pin it.
 */
export function expiryBucket(
  expiryDate: string | null | undefined,
  now: Date = new Date(),
): ExpiryBucket {
  if (expiryDate === null || expiryDate === undefined || expiryDate === '') return 'none';

  const days = daysUntil(expiryDate, now);
  // An unparseable date is not "expired" and not "fine". Treating it as
  // undated is the only answer that neither raises a false alarm nor hides a
  // real one — and the CHECK constraint means it cannot arise from this app.
  if (days === null) return 'none';

  if (days < 0) return 'expired';
  if (days === 0) return 'today';
  for (const rung of LADDER) {
    if (days <= rung.maxDays) return rung.bucket;
  }
  return 'later';
}

/**
 * Whether a bucket is one the user should be looking at.
 *
 * The §15 ladder's first six rungs — everything inside 90 days, plus what has
 * already lapsed. `later` and `none` are real states and deliberately not
 * "attention": a passport good for four years is not a task.
 */
export function needsAttention(bucket: ExpiryBucket): boolean {
  return bucket !== 'later' && bucket !== 'none';
}

/**
 * Days remaining, or `null` when there is no date.
 *
 * A thin pass-through so a caller never reaches for a second date library, and
 * so "how many days" and "which bucket" can never be computed from different
 * parses of the same string.
 */
export function daysUntilExpiry(
  expiryDate: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (expiryDate === null || expiryDate === undefined || expiryDate === '') return null;
  return daysUntil(expiryDate, now);
}
