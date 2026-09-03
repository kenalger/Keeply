/**
 * Keeply — "how much is left", computed in exactly one place (Phase 9).
 *
 * Pure. It takes a period, the allowance in force for it, and what was spent
 * inside it, and returns the one object every surface renders. No SQL, no
 * clock, no React — so `node --test` covers the arithmetic that decides whether
 * the user is told they have money left.
 *
 * ── WHY THIS IS NOT THREE SMALL FUNCTIONS ON THREE SCREENS ─────────────────
 * Home's band, the Money tab's card and the allowance screen all answer the
 * same question. If each subtracts its own numbers they will eventually
 * disagree — one filters damaged rows, one does not; one rounds, one does not —
 * and a dashboard that disagrees with itself is worse than one that is simply
 * wrong, because there is no way for the user to tell which half to believe.
 *
 * ── OVERSPEND IS A NEGATIVE, NOT AN ERROR ──────────────────────────────────
 * `remainingMinor` goes below zero and stays a number. Clamping it at zero
 * would hide exactly the fact the user most needs. Formatting it as
 * "₱420 over" rather than "-₱420" is the UI's job, at the edge, because a
 * minus sign in front of money reads as a refund.
 */
import { ZERO_MINOR, minorUnits, type MinorUnits } from '@/db/money';

import type { PeriodRange } from './period';
import type { AllowanceRecord, AllowanceStatus } from './types';

/** Money spent inside a period, as SQLite grouped it. */
export interface PeriodSpend {
  /** One entry per currency that has at least one expense in the period. */
  readonly byCurrency: readonly {
    readonly currency: string;
    readonly totalMinor: number;
  }[];
  /** Expenses matched inside the period, in every currency. */
  readonly expenseCount: number;
  /** Of those, how many the sums left out because their amount is not an integer. */
  readonly damagedCount: number;
}

/** No spending at all — the shape a period with no expenses produces. */
export const NO_SPEND: PeriodSpend = {
  byCurrency: [],
  expenseCount: 0,
  damagedCount: 0,
};

/**
 * Combine a period, its allowance and its spending into the one status object.
 *
 * `fallbackCurrency` is used only when there is no allowance to take a currency
 * from — it decides which spend bucket "spent this period" reports, and the
 * caller passes the app's default.
 */
export function allowanceStatus(
  period: PeriodRange,
  allowance: AllowanceRecord | null,
  spend: PeriodSpend,
  fallbackCurrency: string,
): AllowanceStatus {
  const currency = allowance?.currency ?? fallbackCurrency;

  // Only the bucket that matches the allowance's currency can be subtracted
  // from it. Summing across currencies would produce a number with no unit.
  const matching = spend.byCurrency.find((bucket) => bucket.currency === currency);
  const spentMinor = matching === undefined ? ZERO_MINOR : minorUnits(matching.totalMinor);

  // Spending in any OTHER currency makes the subtraction unsound, whether or
  // not the matching bucket exists. A zero-value bucket does not count: a
  // currency with nothing in it is not a currency the user spent in.
  const mixedCurrencies = spend.byCurrency.some(
    (bucket) => bucket.currency !== currency && bucket.totalMinor !== 0,
  );

  const allowanceMinor = allowance === null ? null : allowance.amountMinor;
  const remainingMinor =
    allowanceMinor === null || mixedCurrencies
      ? null
      : minorUnits(allowanceMinor - spentMinor);

  return {
    period,
    allowanceMinor,
    spentMinor,
    remainingMinor,
    currency,
    mixedCurrencies,
    expenseCount: spend.expenseCount,
    damagedCount: spend.damagedCount,
  };
}

/**
 * What one day of the allowance is worth — the "about ₱500 a day" pace line.
 *
 * Integer division, rounding DOWN, so a daily pace can never add back up to
 * more than the allowance. `null` when there is no allowance to divide.
 */
export function dailyPace(status: AllowanceStatus): MinorUnits | null {
  if (status.allowanceMinor === null) return null;
  return minorUnits(Math.floor(status.allowanceMinor / status.period.totalDays));
}

/**
 * What is left, spread over the days that are left — "₱347 a day from here".
 *
 * This is the number that actually changes behaviour: it goes down when you
 * overspend and up when you underspend, while `dailyPace` never moves.
 *
 * `null` when there is no allowance, when currencies are mixed, or when the
 * user is already over — "₱-40 a day" is not advice. Rounds DOWN so following
 * it cannot put the user over.
 */
export function remainingPerDay(status: AllowanceStatus): MinorUnits | null {
  const { remainingMinor } = status;
  if (remainingMinor === null || remainingMinor < 0) return null;
  return minorUnits(Math.floor(remainingMinor / status.period.remainingDays));
}

/**
 * How much of the allowance is spent, `0` to `1`, for a progress meter.
 *
 * Clamped at 1 — a meter cannot render past full, and the overspend is said in
 * words next to it rather than by a bar that overflows its track. `null` when
 * there is nothing to be a fraction of; note that an allowance is always `> 0`
 * (the CHECK forbids zero), so this never divides by zero.
 */
export function spentFraction(status: AllowanceStatus): number | null {
  const { allowanceMinor } = status;
  if (allowanceMinor === null || status.mixedCurrencies) return null;
  return Math.min(1, status.spentMinor / allowanceMinor);
}
