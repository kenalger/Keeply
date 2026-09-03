/**
 * Keeply — the one-method-wide seam between allowance SQL and a driver.
 *
 * Same shape and same reason as `src/features/receipts/store.ts`: everything in
 * this feature except `index.ts` must load in plain Node, because that is where
 * the SQL is tested against the real `drizzle/*.sql` with `node:sqlite` and no
 * native module. `@/db` cannot be imported from a module a test loads — its
 * barrel reaches `src/db/client.ts`, which imports op-sqlite.
 *
 * Declared separately rather than reusing `ReceiptStore` because a feature owns
 * its own seam: changing one feature's driver contract must not silently change
 * another's. The cost is twenty duplicated lines; the benefit is that the
 * duplication is the boundary.
 *
 * THE COST, STATED. Reads are raw SQL against `allowances_live` rather than
 * `getDb().select().from(live.allowances)`, so eslint's `BASE_TABLE_READ_SYNTAX`
 * rule cannot police them. `tests/allowance-resolution.test.ts` takes over that
 * job: it asserts every read this feature builds selects from the view and
 * never from the base table. The view name appears in exactly one constant
 * (`ALLOWANCES_LIVE_VIEW`), so there is one thing to check.
 *
 * There is no `atomically` here. Setting an allowance is a single INSERT and
 * deleting one is a single UPDATE; nothing in this feature writes two rows that
 * have to land together. A transaction seam that no caller needs is a seam that
 * will be used wrongly the first time someone does need one.
 */

/** What SQLite can carry in a bound parameter here. No blobs, no floats. */
export type SqlValue = string | number | null;

/** A parameterized statement. `?` placeholders, positional parameters. */
export interface SqlStatement {
  readonly text: string;
  readonly params: readonly SqlValue[];
}

export interface AllowanceStore {
  /** Run a SELECT and return every row, keyed by column name. */
  all<TRow>(statement: SqlStatement): Promise<TRow[]>;
  /** Run an INSERT / UPDATE. */
  execute(statement: SqlStatement): Promise<void>;
}
