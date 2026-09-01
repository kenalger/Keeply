/**
 * Keeply — the one-method-wide seam between receipt SQL and a driver.
 *
 * Identical in shape to `src/features/bills/store.ts`, declared separately for
 * the reason that file's header gives: a feature owns its own seam, so changing
 * one feature's driver contract cannot silently change another's. Read that
 * header for the full argument; the short version is that everything in
 * `src/features/receipts` except `index.ts` has to load in plain Node, because
 * that is where the SQL is tested — `node:sqlite` runs the real `drizzle/*.sql`
 * against a real database with no native module and no simulator
 * (`tests/helpers/migrated-database.ts`). `@/db` cannot be imported from a
 * module a test loads: its barrel reaches `src/db/client.ts`, which imports
 * `react-native`, `expo-file-system` and op-sqlite.
 *
 * THE COST, STATED. Reads are raw SQL against `receipts_live` rather than
 * `getDb().select().from(live.receipts)`, so eslint's `BASE_TABLE_READ_SYNTAX`
 * rule — which watches for `.from(schema.*)` — cannot police them.
 * `tests/receipts-queries.test.ts` takes over that job: it asserts every read
 * statement this feature builds selects from `receipts_live` and never from the
 * base table. The view name appears in exactly one constant
 * (`RECEIPTS_LIVE_VIEW`), so there is one thing to check.
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

export interface ReceiptStore {
  /** Run a SELECT and return every row, keyed by column name. */
  all<TRow>(statement: SqlStatement): Promise<TRow[]>;
  /** Run an INSERT / UPDATE. */
  execute(statement: SqlStatement): Promise<void>;
  /**
   * Run `body` inside one transaction, committing on return and rolling back on
   * throw. The store handed to `body` is bound to that transaction; do not use
   * the outer one inside it, and do not nest.
   */
  atomically<T>(body: (store: ReceiptStore) => Promise<T>): Promise<T>;
}
