/**
 * Keeply — bills (§7), public entrypoint.
 *
 * ```ts
 * import { listBills, payBill, billTotals } from '@/features/bills';
 * ```
 *
 * This is the ONLY module in the feature that imports `@/db` or
 * `@/lib/notifications`, and it is a thin one: it binds the statements built in
 * `./sql.ts` and orchestrated in `./queries.ts` to the real database and the
 * real scheduler, and nothing else. Everything with a decision in it lives
 * behind the `BillStore` seam and the `BillNotificationsPort`, where
 * `tests/bills-*.test.ts` runs it against the committed migrations with
 * `node:sqlite` — same SQL, same code path, no simulator (see `./store.ts`).
 *
 * `initDatabase()` must have completed before any of these are called;
 * `getDb()` throws `DatabaseInitError` until it has. The boot state machine in
 * `src/app/_layout.tsx` owns that.
 *
 * ---------------------------------------------------------------------------
 * WHY `createBillsApi` IS EXPORTED
 * ---------------------------------------------------------------------------
 * A caller that already holds a transaction — a catalogue import creating six
 * bills all-or-nothing — cannot call the module-level `createBill()` inside it:
 * that binding's store opens its own `withTransaction()`, and op-sqlite
 * serialises transactions through a lock queue, so the inner one would wait
 * forever for a slot the outer one holds. Build a second API over the
 * transaction's own handle instead — same factory, same statements, same §29
 * validation, one BEGIN. `src/features/onboarding/index.ts` does exactly this
 * for subscriptions and `billsApiFor()` below is the bills equivalent.
 */
import { getDb, newId, nowMs, withTransaction, type KeeplyDatabase } from '@/db';
import { bindStatement } from '@/features/subscriptions';
import { cancelRemindersFor, scheduleRemindersFor } from '@/lib/notifications';
import { useNotificationStore } from '@/stores/notification-store';
import { todayCalendarString } from '@/theme/format';

import { createBillsApi, type BillNotificationsPort } from './queries';
import type { BillStore, SqlStatement } from './store';

/**
 * A store over one drizzle handle.
 *
 * `db.all()` with a bare `SQL` returns the driver's own row objects, keyed by
 * column name — verified against drizzle-orm 0.45.2's
 * `OPSQLitePreparedQuery.all()` (node_modules/drizzle-orm/op-sqlite/session.js),
 * which returns `client.execute(...).rows._array` untouched when the query has
 * no field mapping. That is the same shape `node:sqlite` gives the tests.
 */
function storeFor(db: KeeplyDatabase, inTransaction: boolean): BillStore {
  return {
    async all<TRow>(statement: SqlStatement): Promise<TRow[]> {
      return db.all<TRow>(bindStatement(statement));
    },
    async execute(statement: SqlStatement): Promise<void> {
      await db.run(bindStatement(statement));
    },
    async atomically<T>(body: (store: BillStore) => Promise<T>): Promise<T> {
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
const liveStore: BillStore = {
  all: (statement) => storeFor(getDb(), false).all(statement),
  execute: (statement) => storeFor(getDb(), false).execute(statement),
  atomically: (body) => storeFor(getDb(), false).atomically(body),
};

/**
 * `@/lib/notifications`, plus the one thing the result is good for.
 *
 * Neither call throws — a denied permission, a missing native module or a full
 * OS queue all come back as a result object — so a bill write never has to
 * guard against a notification failure. `queries.ts` still wraps the calls,
 * because "never throws" is a property of the current implementation and a
 * saved bill must not depend on it.
 *
 * `noteScheduleResult` is why this is not a bare pass-through. Every
 * `scheduleRemindersFor()` comes back carrying the CURRENT permission state,
 * how many reminders are pending and where the 60-slot horizon now ends —
 * which is exactly what `/reminders` renders. `queries.ts` discards the result
 * (it has no business knowing about a store), so without this line the
 * reminders screen would keep showing counts from the last boot until
 * `syncAllReminders()` happened to run. Subscriptions does the same thing at
 * its own notification boundary, in `ui/mutations.ts`.
 */
const notifications: BillNotificationsPort = {
  scheduleRemindersFor: async (entity) => {
    const result = await scheduleRemindersFor(entity);
    useNotificationStore.getState().noteScheduleResult(result);
    return result;
  },
  cancelRemindersFor: (entityId) => cancelRemindersFor(entityId),
};

/** A bills API over an arbitrary store. See the header for when you need this. */
export function billsApiFor(store: BillStore, port = notifications) {
  return createBillsApi({
    store,
    newId,
    nowMs,
    todayISO: () => todayCalendarString(),
    notifications: port,
  });
}

const api = billsApiFor(liveStore);

export const {
  listBills,
  getBill,
  createBill,
  updateBill,
  setBillActive,
  softDeleteBill,
  payBill,
  unpayBill,
  listBillPayments,
  getBillPayment,
  updateBillPayment,
  softDeleteBillPayment,
  billTotals,
  billPaidTotals,
  upcomingBills,
  remindableBills,
} = api;

export { liveStore as liveBillStore };

export {
  billReminderEntity,
  createBillsApi,
  mapBillPaymentRow,
  mapBillRow,
  MAX_UPCOMING_WINDOW_DAYS,
  SILENT_BILL_NOTIFICATIONS,
} from './queries';
export type {
  BillNotificationsPort,
  BillsApi,
  BillsApiDeps,
  PaidTotalsOptions,
  UpcomingBillOptions,
} from './queries';
export type { BillStore, SqlStatement, SqlValue } from './store';
export {
  CUSTOM_CYCLE_DAYS_MAX,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  PAYMENT_METHOD_MAX_LENGTH,
  validateBillPatch,
  validateNewBill,
  validateNewPayment,
  validatePaymentPatch,
} from './validation';
export {
  BILL_CATEGORIES,
  BILL_STATES,
  BILL_STATUSES,
  DEFAULT_PAGE_SIZE,
  DEFAULT_UPCOMING_DAYS,
  isBillCategory,
  isBillState,
  isBillStatus,
  MAX_PAGE_SIZE,
  MAX_UPCOMING_ROWS,
} from './types';
export type {
  BillCategory,
  BillCurrencyTotal,
  BillError,
  BillErrorCode,
  BillField,
  BillFilter,
  BillingCycle,
  BillPage,
  BillPaidTotal,
  BillPatch,
  BillPaymentFilter,
  BillPaymentInput,
  BillPaymentOutcome,
  BillPaymentPage,
  BillPaymentPatch,
  BillPaymentRecord,
  BillRecord,
  BillReminderEntity,
  BillResult,
  BillSort,
  BillState,
  BillStatus,
  BillTotals,
  NewBillInput,
} from './types';
