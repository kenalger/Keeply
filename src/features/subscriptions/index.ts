/**
 * Keeply — subscriptions (§6), public entrypoint.
 *
 * ```ts
 * import { listSubscriptions, subscriptionTotals } from '@/features/subscriptions';
 * ```
 *
 * This is the ONLY module in the feature that imports `@/db`, and it is a thin
 * one: it binds the statements built in `./sql.ts` and orchestrated in
 * `./queries.ts` to the real database, and nothing else. Everything with a
 * decision in it lives behind the `SubscriptionStore` seam, where
 * `tests/subscriptions-*.test.ts` runs it against the committed migrations with
 * `node:sqlite` — same SQL, same code path, no simulator (see `./store.ts`).
 *
 * `initDatabase()` must have completed before any of these are called; `getDb()`
 * throws `DatabaseInitError` until it has. The boot state machine in
 * `src/app/_layout.tsx` owns that.
 */
import { getDb, newId, nowMs, readAll, withTransaction, type KeeplyDatabase } from '@/db';
import { todayCalendarString } from '@/theme/format';

import { bindStatement } from './bind';
import { createSubscriptionsApi } from './queries';
import type { SqlStatement, SubscriptionStore } from './store';

/**
 * A store over one drizzle handle.
 *
 * `db.all()` with a bare `SQL` returns the driver's own row objects, keyed by
 * column name — verified against drizzle-orm 0.45.2's
 * `OPSQLitePreparedQuery.all()` (node_modules/drizzle-orm/op-sqlite/session.js),
 * which returns `client.execute(...).rows._array` untouched when the query has
 * no field mapping. That is the same shape `node:sqlite` gives the tests.
 */
function storeFor(db: KeeplyDatabase, inTransaction: boolean): SubscriptionStore {
  return {
    async all<TRow>(statement: SqlStatement): Promise<TRow[]> {
      return db.all<TRow>(bindStatement(statement));
    },
    async execute(statement: SqlStatement): Promise<void> {
      await db.run(bindStatement(statement));
    },
    async atomically<T>(body: (store: SubscriptionStore) => Promise<T>): Promise<T> {
      // Already inside one: `withTransaction()` refuses to nest (op-sqlite
      // serialises transactions through a lock queue, so an inner one would
      // wait forever for a slot the outer one holds). Compose by passing the
      // transaction-bound store down, which is what this does.
      if (inTransaction) return body(storeFor(db, true));
      return withTransaction((tx) => body(storeFor(tx, true)));
    },
  };
}

/** The live store, resolved lazily so importing this module never opens the db. */
const liveStore: SubscriptionStore = {
  // Off the JS thread, on the read-only connection (`readAll` in `@/db`).
  // Writes, and every read INSIDE a transaction — `storeFor(tx, true)` above —
  // stay on the write connection, because a transaction must read its own
  // uncommitted rows and the read connection only ever sees committed ones.
  all: (statement) => readAll(statement.text, statement.params),
  execute: (statement) => storeFor(getDb(), false).execute(statement),
  atomically: (body) => storeFor(getDb(), false).atomically(body),
};

const api = createSubscriptionsApi({
  store: liveStore,
  newId,
  nowMs,
  todayISO: () => todayCalendarString(),
});

export const {
  listSubscriptions,
  getSubscription,
  createSubscription,
  updateSubscription,
  setActive,
  softDeleteSubscription,
  subscriptionTotals,
  upcomingRenewals,
} = api;

export { bindStatement } from './bind';
export { createSubscriptionsApi, MAX_RENEWAL_WINDOW_DAYS } from './queries';
export type {
  SubscriptionsApi,
  SubscriptionsApiDeps,
  UpcomingRenewalOptions,
} from './queries';
export type { SqlStatement, SqlValue, SubscriptionStore } from './store';
export {
  CUSTOM_CYCLE_DAYS_MAX,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  PAYMENT_METHOD_MAX_LENGTH,
  validateNewSubscription,
  validatePatch,
} from './validation';
export {
  DEFAULT_PAGE_SIZE,
  isSubscriptionCategory,
  MAX_PAGE_SIZE,
  MAX_RENEWAL_ROWS,
  SUBSCRIPTION_CATEGORIES,
} from './types';
export type {
  BillingCycle,
  CurrencyTotal,
  NewSubscriptionInput,
  SubscriptionCategory,
  SubscriptionError,
  SubscriptionErrorCode,
  SubscriptionField,
  SubscriptionFilter,
  SubscriptionPage,
  SubscriptionPatch,
  SubscriptionRecord,
  SubscriptionResult,
  SubscriptionSort,
  SubscriptionTotals,
  UpcomingRenewal,
} from './types';
