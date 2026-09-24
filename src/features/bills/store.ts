/**
 * Keeply — the one-method-wide seam between bill SQL and a driver.
 *
 * The same seam `src/features/subscriptions/store.ts` declares, for the same
 * reason, and its header is the full argument. In short: everything in
 * `src/features/bills` except `index.ts` has to load in plain Node, because
 * that is where the SQL is tested — `node:sqlite` runs the real `drizzle/*.sql`
 * against a real database with no native module and no simulator
 * (`tests/helpers/migrated-database.ts`). `@/db` cannot be imported from a
 * module a test loads: its barrel reaches `src/db/client.ts`, which imports
 * `react-native`, `expo-file-system` and op-sqlite. So the SQL is written
 * against this interface, `index.ts` implements it over `readAll()` (reads,
 * off the JS thread), `getDb()` (writes) and `withTransaction()`, and the
 * tests implement it over `node:sqlite`.
 *
 * A separate `BillStore` rather than a reused `SubscriptionStore`: the two are
 * structurally identical today, and `src/features/settings/store.ts` already
 * set the precedent that a feature owns its own seam. Sharing it would put a
 * cross-feature import in the hot path of both, so that changing one feature's
 * driver contract silently changes the other's.
 *
 * THE COST, STATED. Reads are raw SQL against `bills_live` /
 * `bill_payments_live` rather than `getDb().select().from(live.bills)`, so
 * eslint's `BASE_TABLE_READ_SYNTAX` rule — which watches for `.from(schema.*)`
 * — cannot police them. `tests/bills-queries.test.ts` takes over that job: it
 * asserts every read statement this feature builds selects from a `*_live`
 * view and never from a base table. The view names appear in exactly two
 * constants (`BILLS_LIVE_VIEW`, `BILL_PAYMENTS_LIVE_VIEW`) so there are two
 * things to check.
 *
 * `atomically` is spelled that way because eslint bans the member name
 * `transaction` outside `src/db`: drizzle's `db.transaction()` dispatches
 * `begin`/`commit` without awaiting them, so it is neither atomic nor
 * recoverable. `index.ts` implements this over `withTransaction()`.
 */

/** What SQLite can carry in a bound parameter here. No blobs, no floats. */
export type SqlValue = string | number | null;

/** A parameterized statement. `?` placeholders, positional parameters. */
export interface SqlStatement {
  readonly text: string;
  readonly params: readonly SqlValue[];
}

export interface BillStore {
  /** Run a SELECT and return every row, keyed by column name. */
  all<TRow>(statement: SqlStatement): Promise<TRow[]>;
  /** Run an INSERT / UPDATE. */
  execute(statement: SqlStatement): Promise<void>;
  /**
   * Run `body` inside one transaction, committing on return and rolling back on
   * throw. The store handed to `body` is bound to that transaction; do not use
   * the outer one inside it, and do not nest.
   */
  atomically<T>(body: (store: BillStore) => Promise<T>): Promise<T>;
}
