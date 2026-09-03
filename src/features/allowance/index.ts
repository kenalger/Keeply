/**
 * Keeply — the allowance feature's barrel (Phase 9).
 *
 * The only module here that touches `@/db`. Everything else in this directory
 * loads in plain Node, which is what lets `node --test` run the period
 * arithmetic, the status arithmetic and the real SQL without a simulator.
 *
 * ── WHERE "SPENT" COMES FROM ───────────────────────────────────────────────
 * From the expense ledger — `receiptTotals()` with the period's dates. There is
 * no second spending table and no second sum: the allowance is measured against
 * the same rows the Expenses list shows, filtered by `purchase_date`, in
 * SQLite. Bills, subscriptions and vehicle costs are deliberately NOT counted;
 * they are committed money, shown beside the allowance and never subtracted
 * from it, or one ₱3,500 electricity bill makes "left this week" useless.
 *
 * The date range is INCLUSIVE at both ends, matching `PeriodRange.endIso`.
 */
import { getDb, newId, nowMs, type KeeplyDatabase } from '@/db';
import { bindStatement } from '@/features/subscriptions';
import { receiptTotals } from '@/features/receipts';
import { DEFAULT_CURRENCY } from '@/theme/format';

import { currentPeriod, type AllowancePeriod } from './period';
import { createAllowanceApi } from './queries';
import { allowanceStatus } from './status';
import type { AllowanceStore, SqlStatement } from './store';
import type { AllowanceStatus } from './types';

/** A store over one drizzle handle. Same shape as the receipts store. */
function storeFor(db: KeeplyDatabase): AllowanceStore {
  return {
    async all<TRow>(statement: SqlStatement): Promise<TRow[]> {
      return db.all<TRow>(bindStatement(statement));
    },
    async execute(statement: SqlStatement): Promise<void> {
      await db.run(bindStatement(statement));
    },
  };
}

/** The live store, resolved lazily so importing this module never opens the db. */
const liveStore: AllowanceStore = {
  all: (statement) => storeFor(getDb()).all(statement),
  execute: (statement) => storeFor(getDb()).execute(statement),
};

/** An allowance API over an arbitrary store. */
export function allowanceApiFor(store: AllowanceStore) {
  return createAllowanceApi({
    store,
    newId,
    nowMs,
    currentPeriodStartISO: (period) => currentPeriod(period).startIso,
  });
}

const api = allowanceApiFor(liveStore);

export const { allowanceInForce, allowanceHistory, setAllowance, removeAllowance } = api;

export { liveStore as liveAllowanceStore };

/**
 * The whole answer for one cadence, as of now: period, allowance, spend, what
 * is left.
 *
 * The single read every surface calls. Two queries — one for the allowance in
 * force, one for the period's spending — then pure arithmetic. They run
 * concurrently because neither depends on the other, and both are indexed
 * lookups over a partial index.
 */
export async function currentAllowanceStatus(
  period: AllowancePeriod,
): Promise<AllowanceStatus> {
  const range = currentPeriod(period);
  const [allowance, totals] = await Promise.all([
    api.allowanceInForce(period, range.startIso),
    receiptTotals({ fromISO: range.startIso, toISO: range.endIso }),
  ]);

  return allowanceStatus(
    range,
    allowance,
    {
      byCurrency: totals.byCurrency.map((bucket) => ({
        currency: bucket.currency,
        totalMinor: bucket.totalMinor,
      })),
      expenseCount: totals.receiptCount,
      damagedCount: totals.damagedCount,
    },
    DEFAULT_CURRENCY,
  );
}

export { createAllowanceApi, mapAllowanceRow, DEFAULT_HISTORY_LIMIT } from './queries';
export type { AllowanceApi, AllowanceApiDeps } from './queries';
export type { AllowanceStore, SqlStatement, SqlValue } from './store';
export {
  ALLOWANCE_PERIODS,
  WEEK_STARTS_ON,
  currentPeriod,
  isAllowancePeriod,
  periodContaining,
} from './period';
export type { AllowancePeriod, PeriodRange } from './period';
export {
  NO_SPEND,
  allowanceStatus,
  dailyPace,
  remainingPerDay,
  spentFraction,
} from './status';
export type { PeriodSpend } from './status';
export type { AllowanceRecord, AllowanceStatus, NewAllowance } from './types';
