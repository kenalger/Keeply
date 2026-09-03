/**
 * Keeply — spending allowance (Phase 9).
 *
 * One row per allowance the user has ever set. Not one row that gets updated —
 * a HISTORY, resolved by `effective_from`.
 *
 * ── WHY HISTORY, AND NOT AN `app_settings` KEY ─────────────────────────────
 * Because the past must not be rewritten. Store the allowance as a single
 * mutable value and this happens: in September the user budgets ₱10,000 and
 * finishes ₱800 under. In October they raise it to ₱12,000. September now
 * reports ₱2,800 under — a month already lived through, restated by a number
 * changed afterwards. Every figure the app ever showed for September becomes
 * retroactively false, and nothing in the database records that it changed.
 *
 * A row per change fixes that with no sweep, no background job and no
 * migration. The allowance in force for a period is the newest row whose
 * `effective_from` is on or before that period's FIRST DAY:
 *
 *   SELECT * FROM allowances_live
 *    WHERE period = :period AND effective_from <= :periodStartISO
 *    ORDER BY effective_from DESC
 *    LIMIT 1;
 *
 * Note the ordering column. `ORDER BY created_at` looks equivalent and is not:
 * a correction entered today for a period that began last week must win over
 * the row that was created first. That is the T2 lesson from
 * `plan/phase2-3-remediation.md` — a `LIMIT 1` ordered by a column that does
 * not move returns the wrong row.
 *
 * ── ONE CADENCE AT A TIME ──────────────────────────────────────────────────
 * The schema permits rows of all three periods because switching cadence must
 * not erase the history of the old one. The UI keeps exactly one cadence
 * current; "₱500 a day" from a monthly allowance is DERIVED pace, never a
 * second stored budget. Two live budgets have no answer to "which one is
 * remaining?".
 *
 * Amounts are integer minor units like every other amount in this app, and the
 * `> 0` CHECK means an allowance of zero is not expressible — "I have no
 * budget" is the absence of a row, not a row that says nothing.
 */
import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  createdAtColumn,
  currencyCheck,
  currencyColumn,
  dateColumn,
  deletedAtColumn,
  enumCheck,
  idColumn,
  isoDateCheck,
  liveRows,
  moneyMinorColumn,
  positiveAmountCheck,
  updatedAtColumn,
} from './columns';
import { ALLOWANCE_PERIOD_VALUES, type AllowancePeriod } from './enums';

export const allowances = sqliteTable(
  'allowances',
  {
    id: idColumn(),

    /** How often it resets. Boundaries live in `features/allowance/period.ts`. */
    period: text('period').notNull().$type<AllowancePeriod>(),

    amountMinor: moneyMinorColumn('amount_minor').notNull(),
    currency: currencyColumn(),

    /**
     * The first local calendar day this amount applies to, inclusive.
     *
     * A calendar date and not a timestamp: an allowance starts on a *day*, and
     * comparing it against a period's first day has to be a comparison of two
     * calendar days or the answer changes with the device's timezone.
     */
    effectiveFrom: dateColumn('effective_from').notNull(),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    deletedAt: deletedAtColumn(),
  },
  (t) => [
    enumCheck('allowances_period_check', t.period, ALLOWANCE_PERIOD_VALUES),
    currencyCheck('allowances_currency_check', t.currency),
    positiveAmountCheck('allowances_amount_minor_check', t.amountMinor),
    isoDateCheck('allowances_effective_from_check', t.effectiveFrom),

    // PARTIAL unique index (§A2). One amount per cadence per start date — but
    // a soft-deleted row must not keep owning the slot, or setting an
    // allowance, deleting it and setting it again on the same day fails with
    // `UNIQUE constraint failed` against a row the user cannot see.
    // It doubles as the resolution query's index: `period` narrows and
    // `effective_from` orders, which is exactly `WHERE period = ? AND
    // effective_from <= ? ORDER BY effective_from DESC LIMIT 1`. A separate
    // non-unique index on the same two columns would be dead weight.
    uniqueIndex('allowances_period_effective_from_unq')
      .on(t.period, t.effectiveFrom)
      .where(liveRows()),
  ],
);

export type Allowance = typeof allowances.$inferSelect;
export type NewAllowance = typeof allowances.$inferInsert;
