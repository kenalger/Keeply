/**
 * Keeply — the allowance data layer's vocabulary (Phase 9).
 *
 * Pure types. Nothing here imports `@/db` at runtime; `MinorUnits` comes from
 * `@/db/money`, which is a branded number and no more.
 *
 * `effectiveFrom` is a `'YYYY-MM-DD'` calendar string; `createdAt` /
 * `updatedAt` are epoch millis. The two are never derived from each other — an
 * allowance recorded at 23:50 on the 31st applies from the day the user chose,
 * not from whichever day the timestamp lands on in UTC.
 */
import type { MinorUnits } from '@/db/money';

import type { AllowancePeriod, PeriodRange } from './period';

/** One allowance, as every read in this feature returns it. */
export interface AllowanceRecord {
  id: string;
  period: AllowancePeriod;
  /** Always present and always `> 0`; the CHECK makes zero inexpressible. */
  amountMinor: MinorUnits;
  currency: string;
  /** First local calendar day this amount applies to, `'YYYY-MM-DD'`. */
  effectiveFrom: string;
  createdAt: number;
  updatedAt: number;
}

/** What a caller supplies to set an allowance. */
export interface NewAllowance {
  period: AllowancePeriod;
  amountMinor: MinorUnits;
  /** Defaults to the app's default currency when omitted. */
  currency?: string;
  /** Defaults to the first day of the current period when omitted. */
  effectiveFrom?: string;
}

/**
 * Everything a surface needs to say "₱10,409 left this month", computed once.
 *
 * ONE function produces this and Home, the Money tab and the allowance screen
 * all read it. They must never each do their own arithmetic: two answers to one
 * question is how a dashboard starts lying, which is the same argument
 * `src/db/schema/enums.ts` makes about `overdue` not being a stored status.
 */
export interface AllowanceStatus {
  /** The period this is about, with its boundaries and day counts. */
  period: PeriodRange;
  /**
   * The allowance in force for this period, or `null` when the user has not
   * set one — which is a legitimate state, not an error, and the reason
   * `remainingMinor` is meaningless unless this is non-null.
   */
  allowanceMinor: MinorUnits | null;
  /** Spent inside the period, in `currency`. */
  spentMinor: MinorUnits;
  /**
   * `allowanceMinor - spentMinor`, or `null` when there is no allowance.
   *
   * NEGATIVE when overspent. The UI renders that as "₱420 over" in a status
   * colour — never as a minus sign in front of a peso amount, which reads as a
   * refund.
   */
  remainingMinor: MinorUnits | null;
  currency: string;
  /**
   * True when spending inside the period was recorded in more than one
   * currency, or in a currency the allowance is not in.
   *
   * When it is true the subtraction is refused: `remainingMinor` is `null` and
   * the UI says so out loud. A number with no unit is worse than no number.
   */
  mixedCurrencies: boolean;
  /** Expenses counted inside the period, in every currency. */
  expenseCount: number;
  /**
   * Expenses the sum had to leave out because their `amount_minor` is not an
   * integer — the same policy `ReceiptTotals.damagedCount` states. One corrupt
   * row must not blank the card, and must not silently skew it either.
   */
  damagedCount: number;
}
