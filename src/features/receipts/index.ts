/**
 * Keeply — receipts (§9, §10), public entrypoint.
 *
 * ```ts
 * import { listReceipts, createReceipt, receiptTotals } from '@/features/receipts';
 * ```
 *
 * This is the ONLY module in the feature that imports `@/db`, and it is a thin
 * one: it binds the statements built in `./sql.ts` and orchestrated in
 * `./queries.ts` to the real database, and nothing else. Everything with a
 * decision in it lives behind the `ReceiptStore` seam, where
 * `tests/receipts-*.test.ts` runs it against the committed migrations with
 * `node:sqlite` — same SQL, same code path, no simulator (see `./store.ts`).
 *
 * There is no notifications port here, unlike bills: a receipt is a record of
 * something that already happened, so there is nothing to remind anyone about
 * (§8 schedules for bills, subscriptions and document expiry only).
 *
 * There is no file-system port either, and that is deliberate. The screens own
 * capture, thumbnailing and unlinking; this module owns the row and tells the
 * caller which files a write stranded. The ordering contract between the two —
 * ROW FIRST, FILE SECOND, on the way out — is argued at length in
 * `./queries.ts`'s header. Read it before wiring a delete button.
 *
 * `initDatabase()` must have completed before any of these are called;
 * `getDb()` throws `DatabaseInitError` until it has. The boot state machine in
 * `src/app/_layout.tsx` owns that.
 *
 * ---------------------------------------------------------------------------
 * WHY `createReceiptsApi` IS EXPORTED
 * ---------------------------------------------------------------------------
 * A caller that already holds a transaction — a §20 restore writing a hundred
 * receipts all-or-nothing — cannot call the module-level `createReceipt()`
 * inside it: that binding's store opens its own `withTransaction()`, and
 * op-sqlite serialises transactions through a lock queue, so the inner one
 * would wait forever for a slot the outer one holds. Build a second API over
 * the transaction's own handle instead — same factory, same statements, same
 * §29 validation, one BEGIN. `receiptsApiFor()` below is how.
 */
import { getDb, newId, nowMs, withTransaction, type KeeplyDatabase } from '@/db';
import { bindStatement } from '@/features/subscriptions';
import { todayCalendarString } from '@/theme/format';

import { createReceiptsApi } from './queries';
import type { ReceiptStore, SqlStatement } from './store';

/**
 * A store over one drizzle handle.
 *
 * `db.all()` with a bare `SQL` returns the driver's own row objects, keyed by
 * column name — the same shape `node:sqlite` gives the tests. See
 * `src/features/bills/index.ts` for the verification of that against
 * drizzle-orm's op-sqlite session.
 */
function storeFor(db: KeeplyDatabase, inTransaction: boolean): ReceiptStore {
  return {
    async all<TRow>(statement: SqlStatement): Promise<TRow[]> {
      return db.all<TRow>(bindStatement(statement));
    },
    async execute(statement: SqlStatement): Promise<void> {
      await db.run(bindStatement(statement));
    },
    async atomically<T>(body: (store: ReceiptStore) => Promise<T>): Promise<T> {
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
const liveStore: ReceiptStore = {
  all: (statement) => storeFor(getDb(), false).all(statement),
  execute: (statement) => storeFor(getDb(), false).execute(statement),
  atomically: (body) => storeFor(getDb(), false).atomically(body),
};

/** A receipts API over an arbitrary store. See the header for when you need this. */
export function receiptsApiFor(store: ReceiptStore) {
  return createReceiptsApi({
    store,
    newId,
    nowMs,
    todayISO: () => todayCalendarString(),
  });
}

const api = receiptsApiFor(liveStore);

export const {
  listReceipts,
  getReceipt,
  createReceipt,
  updateReceipt,
  softDeleteReceipt,
  receiptTotals,
  recentReceipts,
} = api;

export { liveStore as liveReceiptStore };

export { createReceiptsApi, mapReceiptRow } from './queries';
export type { ReceiptsApi, ReceiptsApiDeps } from './queries';
export type { ReceiptStore, SqlStatement, SqlValue } from './store';
export {
  IMAGE_URI_MAX_LENGTH,
  MERCHANT_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  PAYMENT_METHOD_MAX_LENGTH,
  validateNewReceipt,
  validateReceiptFilter,
  validateReceiptPatch,
} from './validation';
export type { ValidatedReceipt, ValidatedReceiptPatch } from './validation';
export {
  DEFAULT_PAGE_SIZE,
  DEFAULT_RECENT_LIMIT,
  isReceiptCategory,
  MAX_PAGE_SIZE,
  MAX_RECENT_ROWS,
  RECEIPT_CATEGORIES,
} from './types';
export type {
  DeletedReceipt,
  NewReceiptInput,
  ReceiptCategory,
  ReceiptCategoryTotal,
  ReceiptCurrencyTotal,
  ReceiptError,
  ReceiptErrorCode,
  ReceiptField,
  ReceiptFilter,
  ReceiptPage,
  ReceiptPatch,
  ReceiptRecord,
  ReceiptResult,
  ReceiptSort,
  ReceiptTotals,
  ReceiptTotalsOptions,
  ReceiptWrite,
} from './types';
